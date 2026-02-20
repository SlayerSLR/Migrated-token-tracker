require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const connectDB = require('./config/db');
const settings = require('./config/settings');
const Token = require('./models/Token');
const { getMigratedTokens, getLastUpdate: getMoralisUpdate } = require('./services/moralis');
const { resolvePoolAddress, getBackfillData } = require('./services/gecko');
const { start: startJupiter, trackToken, untrackToken, getLastUpdate: getJupiterUpdate } = require('./services/jupiter');
const candleManager = require('./services/candleManager');
const { saveCandle, backfillCandles, getRecentCandles } = require('./services/storage');
const { checkStrategy } = require('./services/strategy');
const backfillQ = require('./services/backfillQueue');
const { gapFillOnStartup, remove: removeFromQueue } = require('./services/backfillQueue');
const { getVolume5m, getMarketCaps } = require('./services/dexscreener');

// ── Config ────────────────────────────────────────────────────────────────────
const DISCOVERY_INTERVAL_MS = 60 * 1000;
const seenAddresses = new Set();
const MAX_SEEN = 5000; // cap to avoid unbounded memory growth

// ── Telegram ──────────────────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ── Telegram commands ─────────────────────────────────────────────────────────

// /volume command removed per user request

bot.onText(/\/api/, async (msg) => {
    if (String(msg.chat.id) !== String(CHAT_ID)) return;

    const now = Date.now();
    const jupUpdate = getJupiterUpdate();
    const morUpdate = getMoralisUpdate();

    const jupDiff = jupUpdate > 0 ? ((now - jupUpdate) / 1000).toFixed(1) + 's' : 'Never';
    const morDiff = morUpdate > 0 ? ((now - morUpdate) / 1000).toFixed(1) + 's' : 'Never';

    // Check if received data recently (Jup 50s, Moralis 70s)
    const jupOk = jupUpdate > 0 && (now - jupUpdate) < 50000;
    const morOk = morUpdate > 0 && (now - morUpdate) < 70000; // Moralis polls every 60s

    await bot.sendMessage(CHAT_ID,
        `📡 *API Status*\n\n` +
        `${jupOk ? '🟢' : '🔴'} *Jupiter*: ${jupDiff} ago\n` +
        `${morOk ? '🟢' : '🔴'} *Moralis*: ${morDiff} ago`,
        { parse_mode: 'Markdown' });
});

bot.onText(/\/status/, async (msg) => {
    if (String(msg.chat.id) !== String(CHAT_ID)) return;

    const qs = await backfillQ.queueStatus();
    const tracked = candleManager.tracked.size;
    const volState = settings.requireVolumeSpike ? '🟢 ON' : '🔴 OFF';

    await bot.sendMessage(CHAT_ID,
        `🤖 *Token Tracker V0.2*\n\n` +
        `📌 Tokens tracked:     ${tracked}\n` +
        `📊 Volume filter:      ${volState}\n` +
        `\n📥 *Backfill Queue*\n` +
        `  Pending:  ${qs.pending}\n` +
        `  Done:     ${qs.done}\n` +
        `  Failed:   ${qs.failed}\n` +
        `  Total:    ${qs.total}`,
        { parse_mode: 'Markdown' });
});

bot.onText(/\/backfill/, async (msg) => {
    if (String(msg.chat.id) !== String(CHAT_ID)) return;
    await bot.sendMessage(CHAT_ID, '🔄 Running backfill drain now...');
    await backfillQ.drain(10);
    const qs = await backfillQ.queueStatus();
    await bot.sendMessage(CHAT_ID,
        `✅ Drain complete.\nPending: ${qs.pending}  Done: ${qs.done}  Failed: ${qs.failed}`);
});

bot.onText(/\/tokenlist/, async (msg) => {
    if (String(msg.chat.id) !== String(CHAT_ID)) return;

    const tracked = [...candleManager.tracked.entries()];

    if (tracked.length === 0) {
        await bot.sendMessage(CHAT_ID, '📋 No tokens are currently being tracked.');
        return;
    }

    const CHUNK_SIZE = 50;
    const totalChunks = Math.ceil(tracked.length / CHUNK_SIZE);

    for (let i = 0; i < tracked.length; i += CHUNK_SIZE) {
        const chunk = tracked.slice(i, i + CHUNK_SIZE);
        const lines = chunk.map(([address, meta], idx) =>
            `${i + idx + 1}. *${meta.symbol || '?'}*\n\`${address}\``
        ).join('\n\n');

        let message = '';
        if (i === 0) {
            message += `📋 *Tracked Tokens (${tracked.length})*\n\n`;
        }
        message += lines;

        if (totalChunks > 1) {
            message += `\n\n(Page ${Math.floor(i / CHUNK_SIZE) + 1}/${totalChunks})`;
        }

        await bot.sendMessage(CHAT_ID, message, { parse_mode: 'Markdown' });
    }
});

bot.onText(/\/topcoins/, async (msg) => {
    if (String(msg.chat.id) !== String(CHAT_ID)) return;

    await bot.sendMessage(CHAT_ID, '⌛ Fetching top active coins...');
    const topCoinsMsg = await getTopCoins(15);
    await bot.sendMessage(CHAT_ID, topCoinsMsg, { parse_mode: 'Markdown', disable_web_page_preview: true });
});

bot.onText(/\/help/, async (msg) => {
    if (String(msg.chat.id) !== String(CHAT_ID)) return;
    await bot.sendMessage(CHAT_ID,
        `🤖 *Token Tracker V0.2 — Commands*\n\n` +
        `/api          — check data feed health (Jupiter/Moralis)\n` +
        `/tokenlist    — list all tracked tokens + addresses\n` +
        `/topcoins     — show top performing active tokens\n` +
        `/status       — tracked count + backfill queue\n` +
        `/backfill     — manually trigger a backfill drain\n` +
        `/help         — this message`,
        { parse_mode: 'Markdown' });
});

// ── Alert ─────────────────────────────────────────────────────────────────────
const PUMP_FUN_SUPPLY = 1_000_000_000; // Fixed supply for all pump.fun tokens

// Map: tokenAddress → { marketCap, sentAt, firstMarketCap, firstSentAt }
const lastAlertData = new Map();

const sendAlert = async (signal) => {
    const marketCap = signal.price * PUMP_FUN_SUPPLY;
    const mcFormatted = marketCap >= 1000
        ? `$${(marketCap / 1000).toFixed(1)}K`
        : `$${marketCap.toFixed(2)}`;

    // ── Token age ────────────────────────────────────────────────────
    let ageLine = '';
    if (signal.launchedAt) {
        const ageMs = Date.now() - new Date(signal.launchedAt).getTime();
        const ageMins = Math.floor(ageMs / 60000);
        const ageParts = [];
        if (ageMins >= 1440) ageParts.push(`${Math.floor(ageMins / 1440)}d`);
        if (ageMins >= 60) ageParts.push(`${Math.floor((ageMins % 1440) / 60)}h`);
        ageParts.push(`${ageMins % 60}m`);
        ageLine = `\n⏱ *Age:* ${ageParts.join(' ')}`;
    }
    let mcChangeLine = '';
    const prev = lastAlertData.get(signal.tokenAddress);
    if (prev) {
        // Delta since last alert
        const pctLast = ((marketCap - prev.marketCap) / prev.marketCap) * 100;
        const signLast = pctLast >= 0 ? '+' : '';
        const minsAgo = Math.round((Date.now() - prev.sentAt) / 60000);
        const arrowLast = pctLast >= 0 ? '📈' : '📉';
        mcChangeLine = `\n${arrowLast} *MC Δ last:* ${signLast}${pctLast.toFixed(1)}% (${minsAgo}m ago)`;

        // Delta since first alert (only if we have first data and it differs from last)
        if (prev.firstMarketCap && prev.firstMarketCap !== prev.marketCap) {
            const pctFirst = ((marketCap - prev.firstMarketCap) / prev.firstMarketCap) * 100;
            const signFirst = pctFirst >= 0 ? '+' : '';
            const hrsFirst = (Date.now() - prev.firstSentAt) / 3600000;
            const timeFirst = hrsFirst >= 1
                ? `${hrsFirst.toFixed(1)}h ago`
                : `${Math.round(hrsFirst * 60)}m ago`;
            const arrowFirst = pctFirst >= 0 ? '📈' : '📉';
            mcChangeLine += `\n${arrowFirst} *MC Δ first:* ${signFirst}${pctFirst.toFixed(1)}% (${timeFirst})`;
        }
    }

    const mint = signal.tokenAddress;
    const pool = signal.poolAddress;

    const linkParts = [
        `[Jupiter](https://jup.ag/tokens/${mint})`,
        pool ? `[Axiom](https://axiom.trade/meme/${pool})` : null,
        `[DexScreener](https://dexscreener.com/solana/${mint})`
    ].filter(Boolean);
    const links = linkParts.join(' · ');

    const msg =
        `🚨 *EMA RSI Alert*
──────────────────
📌 *Ticker:* ${signal.symbol}${ageLine}
💰 *Mkt Cap:* ${mcFormatted}${mcChangeLine}
📈 *RSI:* ${signal.rsi.toFixed(2)}
📐 *EMA 9:*  ${signal.ema9.toExponential(4)}
📐 *EMA 20:* ${signal.ema20.toExponential(4)}
🔗 ${links}
\`${mint}\``;

    try {
        await bot.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
        console.log(`[Alert] Sent signal for ${signal.symbol}`);
        // Update in-memory cache
        const existing = lastAlertData.get(signal.tokenAddress);
        const firstMC = existing?.firstMarketCap || marketCap;
        const firstAt = existing?.firstSentAt || Date.now();
        lastAlertData.set(signal.tokenAddress, {
            marketCap, sentAt: Date.now(),
            firstMarketCap: firstMC, firstSentAt: firstAt
        });
        // Persist last alert to DB always
        const dbUpdate = { lastAlertMarketCap: marketCap, lastAlertSentAt: new Date() };
        // Persist first alert only once
        if (!existing?.firstMarketCap) {
            dbUpdate.firstAlertMarketCap = marketCap;
            dbUpdate.firstAlertSentAt = new Date();
        }
        Token.updateOne({ address: signal.tokenAddress }, dbUpdate)
            .catch(e => console.error('[Alert] DB persist error:', e.message));
    } catch (err) {
        console.error('[Alert] Telegram error:', err.message);
    }
};

// ── Candle handler ────────────────────────────────────────────────────────────
candleManager.on('candle', async (candle) => {
    await saveCandle(candle);

    const history = await getRecentCandles(candle.tokenAddress, 60);
    if (history.length === 0) return;

    const meta = candleManager.tracked.get(candle.tokenAddress) || {};
    const symbol = meta.symbol || candle.tokenAddress.slice(0, 8);

    // ── Low MC prune (< $2k) ────────────────────────────────────────────────────
    const currentMcap = candle.close * PUMP_FUN_SUPPLY;
    if (currentMcap < 2000) {
        console.log(`[Prune] ${symbol} — MC $${currentMcap.toFixed(0)} < $2000. Stopping tracking.`);
        candleManager.removeToken(candle.tokenAddress);
        untrackToken(candle.tokenAddress);
        lastAlertData.delete(candle.tokenAddress);   // clean up in-memory map
        await removeFromQueue(candle.tokenAddress);  // remove from backfill queue
        await Token.updateOne({ address: candle.tokenAddress }, { $set: { isActive: false } });
        return;
    }

    // ── Strategy ─────────────────────────────────────────────────────────────
    const historyWithMeta = history.map(c => ({ ...c, symbol }));
    const signal = checkStrategy(historyWithMeta, {
        requireVolumeSpike: settings.requireVolumeSpike
    });
    if (signal) {
        const mcap = signal.price * PUMP_FUN_SUPPLY;
        if (mcap < 5000) return; // skip low-mcap tokens
        await sendAlert({ ...signal, poolAddress: meta.poolAddress || null, launchedAt: meta.launchedAt || null });
    }
});

// ── Discovery Loop ────────────────────────────────────────────────────────────
const discoveryLoop = async () => {
    // Cap seenAddresses to avoid unbounded memory growth over long uptime
    if (seenAddresses.size > MAX_SEEN) {
        seenAddresses.clear();
        console.log('[Discovery] seenAddresses cleared (size cap reached).');
    }

    console.log('\n[Discovery] Fetching migrated tokens from Moralis...');

    const tokens = await getMigratedTokens(20);
    if (tokens.length === 0) { console.log('[Discovery] No tokens returned.'); return; }
    console.log(`[Discovery] Got ${tokens.length} tokens from Moralis.`);

    const addresses = tokens.map(t => t.address).filter(Boolean);
    const notSeenYet = addresses.filter(a => !seenAddresses.has(a));

    if (notSeenYet.length === 0) {
        console.log('[Discovery] All tokens already in seen cache. Skipping.');
        return;
    }

    // Find tokens in DB to filter out ACTIVE ones
    // But allow INACTIVE ones to be reactivated if they appear again
    const existing = await Token.find({ address: { $in: notSeenYet } }).lean();

    // Create a Set of ACTIVE tokens we should definitely skip
    const activeSet = new Set(existing.filter(t => t.isActive).map(t => t.address));

    // Our subset to process: Tokens that are NOT in activeSet
    const processTokens = tokens.filter(t =>
        t.address && !seenAddresses.has(t.address) && !activeSet.has(t.address)
    );

    if (processTokens.length === 0) {
        console.log('[Discovery] No activeable tokens to add or reactivate.');
        return;
    }
    console.log(`[Discovery] ${processTokens.length} token(s) to add or reactivate.`);

    // ── MC check — skip dead tokens before starting expensive backfill ──────
    const processAddresses = processTokens.map(t => t.address);
    const mcMap = await getMarketCaps(processAddresses);
    const liveTokens = processTokens.filter(t => {
        const mc = mcMap.get(t.address);
        if (mc !== undefined && mc < 2000) {
            console.log(`[Discovery] Skipping ${t.symbol || t.address.slice(0, 8)} — MC $${mc.toFixed(0)} < $2000`);
            seenAddresses.add(t.address); // mark as seen so we don't re-check
            return false;
        }
        return true;
    });
    if (liveTokens.length === 0) { console.log('[Discovery] All processable tokens below $2k MC. Skipping.'); return; }

    for (const token of liveTokens) {
        seenAddresses.add(token.address);
        console.log(`\n[Discovery] Processing ${token.symbol || token.address}...`);

        // 1. Resolve pool
        const poolAddress = await resolvePoolAddress(token.address);

        if (!poolAddress) {
            // Pool resolve failed (429 or not listed yet) — enqueue for retry
            console.log(`[Discovery]  -> No pool found, queuing for backfill retry`);
            await Token.updateOne(
                { address: token.address },
                {
                    $set: {
                        symbol: token.symbol,
                        name: token.name,
                        poolAddress: null,
                        isActive: true // Reactivate if it was pruned
                    }, // Use $setOnInsert for launchedAt so we don't overwrite history
                    $setOnInsert: { launchedAt: token.createdAt ? new Date(token.createdAt) : new Date() }
                },
                { upsert: true }
            );
            await backfillQ.enqueue(token);
            continue;
        }

        console.log(`[Discovery]  -> Pool: ${poolAddress}`);

        // 2. Backfill OHLCV
        const backfillData = await getBackfillData(poolAddress, 300);

        if (backfillData.length === 0) {
            // OHLCV fetch failed (429 or no data) — save token with pool, enqueue for candle retry
            console.log(`[Discovery]  -> OHLCV empty, queuing for backfill retry`);
            await Token.updateOne(
                { address: token.address },
                {
                    $set: {
                        symbol: token.symbol,
                        name: token.name,
                        poolAddress,
                        isActive: true
                    },
                    $setOnInsert: { launchedAt: token.createdAt ? new Date(token.createdAt) : new Date() }
                },
                { upsert: true }
            );
            await backfillQ.enqueue({ ...token, poolAddress });

        } else {
            // Full success path
            await backfillCandles(token.address, poolAddress, backfillData);
            await Token.updateOne(
                { address: token.address },
                {
                    $set: {
                        symbol: token.symbol,
                        name: token.name,
                        poolAddress,
                        isActive: true
                    },
                    $setOnInsert: { launchedAt: token.createdAt ? new Date(token.createdAt) : new Date() }
                },
                { upsert: true }
            );
        }

        // 3. Register for live tracking regardless of backfill result
        candleManager.addToken(token.address, {
            symbol: token.symbol, name: token.name, poolAddress,
            launchedAt: token.createdAt ? new Date(token.createdAt) : new Date()
        });
        trackToken(token.address);

        console.log(`[Discovery]  -> ✅ Now tracking ${token.symbol || token.address}` +
            (backfillData.length === 0 ? ' (backfill queued)' : ''));

        await sleep(500);
    }
};

// ── Restore tokens on startup ─────────────────────────────────────────────────
const restoreTrackedTokens = async () => {
    const tokens = await Token.find({ isActive: true }).lean();
    console.log(`[Startup] Restoring ${tokens.length} previously tracked token(s)...`);
    for (const t of tokens) {
        seenAddresses.add(t.address); // prevent re-discovery on first poll cycle
        candleManager.addToken(t.address, { symbol: t.symbol, name: t.name, poolAddress: t.poolAddress, launchedAt: t.launchedAt || t.addedAt });
        trackToken(t.address);
        // Pre-load persisted alert history into in-memory map
        if (t.lastAlertMarketCap && t.lastAlertSentAt) {
            lastAlertData.set(t.address, {
                marketCap: t.lastAlertMarketCap,
                sentAt: new Date(t.lastAlertSentAt).getTime(),
                firstMarketCap: t.firstAlertMarketCap || t.lastAlertMarketCap,
                firstSentAt: t.firstAlertSentAt
                    ? new Date(t.firstAlertSentAt).getTime()
                    : new Date(t.lastAlertSentAt).getTime()
            });
        }
    }
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Maintenance Loop (Pruning) ────────────────────────────────────────────────
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // every hour

const maintenanceLoop = async () => {
    const addresses = [...candleManager.tracked.keys()];
    if (addresses.length === 0) return;

    console.log(`[Maintenance] Checking status for ${addresses.length} token(s)...`);

    // Fetch DexScreener volume
    const volMap = await getVolume5m(addresses);

    // We now use the Candle DB to calculate Current Market Cap
    const Candle = require('./models/Candle');

    let pruned = 0;
    const now = Date.now();

    for (const address of addresses) {
        const meta = candleManager.tracked.get(address) || {};
        const vol5m = volMap.get(address); // undefined if not found

        let mc = undefined;
        // Fetch latest candle from DB for current price
        const latestCandle = await Candle.findOne({ tokenAddress: address })
            .sort({ timestamp: -1 })
            .lean();

        if (latestCandle && latestCandle.close) {
            mc = latestCandle.close * PUMP_FUN_SUPPLY;
        }

        const launchedAt = meta.launchedAt ? new Date(meta.launchedAt).getTime() : 0;
        const ageHours = (now - launchedAt) / 3600000;

        let reason = null;

        // Condition 1: Low Volume (<$100 in 5m)
        // Only prune if we actually got a volume result (not null/undefined)
        if (vol5m !== undefined && vol5m < 100) {
            reason = `Low Volume ($${vol5m.toFixed(2)})`;
        }

        // Condition 2: Low MC (<$5k) AND Age > 2h
        if (!reason && mc !== undefined && mc < 5000 && ageHours > 2) {
            reason = `Old & Low MC ($${mc.toFixed(0)}, ${ageHours.toFixed(1)}h)`;
        }

        if (reason) {
            const sym = meta.symbol || address.slice(0, 8);
            console.log(`[Maintenance] Pruning ${sym} — ${reason}`);

            candleManager.removeToken(address);
            untrackToken(address);
            lastAlertData.delete(address);
            await removeFromQueue(address);
            await Token.updateOne({ address }, { $set: { isActive: false } });
            pruned++;
        }
    }

    if (pruned > 0) console.log(`[Maintenance] Pruned ${pruned} token(s).`);
    else console.log('[Maintenance] No tokens pruned.');
};
// ── Main Execution ────────────────────────────────────────────────────────────
const { generateHourlyReport, getTopCoins } = require('./services/reports');

const main = async () => {
    // Connect to DB
    await connectDB();

    // Wire backfill queue with runtime references
    backfillQ.init(candleManager, trackToken);

    // Startup audit — find any tracked token with 0 candles and re-enqueue
    await backfillQ.auditAndEnqueueMissing();

    const volLabel = settings.requireVolumeSpike ? '🟢 ON' : '🔴 OFF';
    try {
        await bot.sendMessage(CHAT_ID,
            `🤖 *Token Tracker V0.2 started*\n\nVolume filter: ${volLabel}\nType /help for commands.`,
            { parse_mode: 'Markdown' });
    } catch (e) {
        console.warn('[Startup] Telegram startup message failed:', e.message);
    }

    // Restore state
    await restoreTrackedTokens();

    // Gap-fill runs in the background — don't block Jupiter startup
    gapFillOnStartup().catch(err => console.error('[GapFill] Error:', err.message));

    // Start Jupiter polling
    startJupiter();

    // Initial discovery
    await discoveryLoop();

    // Drain the backfill queue immediately after first discovery
    await backfillQ.drain(10);

    // Recurring: discovery every 60s, then drain after each
    setInterval(async () => {
        await discoveryLoop();
        await backfillQ.drain(5); // drain up to 5 per cycle
    }, DISCOVERY_INTERVAL_MS);

    // Maintenance: run at startup, then every hour
    maintenanceLoop().catch(err => console.error('[Maintenance] Error:', err.message));
    setInterval(() =>
        maintenanceLoop().catch(err => console.error('[Maintenance] Error:', err.message)),
        PRUNE_INTERVAL_MS
    );

    // Hourly Report Loop (60 min)
    setInterval(async () => {
        console.log('[Reports] Generating hourly report...');
        const report = await generateHourlyReport();
        if (report) {
            bot.sendMessage(CHAT_ID, report, { parse_mode: 'Markdown' });
        }
    }, 60 * 60 * 1000);

    console.log(`\n[Startup] Bot running. Volume filter ${volLabel}.\n`);
};

main().catch(err => {
    console.error('[FATAL]', err);
    process.exit(1);
});
