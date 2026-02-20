/**
 * test.js — Diagnostic test script for Token Tracker V0.2
 *
 * Tests:
 *  1. .env / API key validation
 *  2. GeckoTerminal OHLCV backfill (live HTTP, no key needed)
 *  3. Strategy engine correctness (mock candles with known outcome)
 *  4. Telegram alert delivery (sends a real test message)
 *
 * Run: node test.js
 */

require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const { resolvePoolAddress, getBackfillData } = require('./services/gecko');
const { checkStrategy } = require('./services/strategy');

// ── Utility ───────────────────────────────────────────────────────────────────
const pass = (msg) => { console.log(`  ✅  ${msg}`); totalPass++; };
const fail = (msg) => { console.log(`  ❌  ${msg}`); totalFail++; };
const info = (msg) => console.log(`  ℹ️   ${msg}`);
const hdr = (msg) => console.log(`\n${'─'.repeat(52)}\n  ${msg}\n${'─'.repeat(52)}`);

let totalPass = 0;
let totalFail = 0;

// ── 1. .env Validation ────────────────────────────────────────────────────────
const testEnv = () => {
    hdr('TEST 1 — .env / API Keys');
    const required = [
        ['MORALIS_API_KEY', 'Moralis dashboard → API Keys'],
        ['HELIUS_API_KEY', 'https://dashboard.helius.dev/'],
        ['TELEGRAM_BOT_TOKEN', '@BotFather → /newbot'],
        ['TELEGRAM_CHAT_ID', '@userinfobot to get your chat ID'],
        ['MONGODB_URI', 'mongodb://localhost:27017/token_tracker_v2'],
    ];
    for (const [key, hint] of required) {
        const val = process.env[key];
        const isSet = val && !val.startsWith('your_');
        if (isSet) pass(`${key} is set`);
        else fail(`${key} missing  →  ${hint}`);
    }
};

// ── 2. GeckoTerminal OHLCV Backfill ──────────────────────────────────────────
const testGecko = async () => {
    hdr('TEST 2 — GeckoTerminal OHLCV Backfill');
    const TEST_TOKEN = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC
    info('Resolving pool for USDC...');

    const pool = await resolvePoolAddress(TEST_TOKEN);
    if (!pool) { fail('Pool address not resolved'); return; }
    pass('Pool address resolved'); info(`Pool: ${pool}`);

    info('Fetching 30 × 1-min candles...');
    const candles = await getBackfillData(pool, 30);
    if (candles.length === 0) { fail('No candles returned'); return; }
    pass(`Received ${candles.length} candles`);

    const fields = ['open', 'high', 'low', 'close', 'volume'];
    if (fields.every(f => candles[0][f] !== undefined)) pass('All OHLCV fields present');
    else fail('Missing fields in candle object');

    const c = candles[candles.length - 1];
    info(`Latest → O:${c.open.toFixed(4)} H:${c.high.toFixed(4)} L:${c.low.toFixed(4)} C:${c.close.toFixed(4)} V:${c.volume.toFixed(2)}`);
};

// ── 3. Strategy Engine ────────────────────────────────────────────────────────
const testStrategy = () => {
    hdr('TEST 3 — Strategy Engine (indicators)');

    const mk = (close, vol, idx) => ({
        tokenAddress: 'TEST_MINT', symbol: 'TEST',
        timestamp: new Date(Date.now() - (50 - idx) * 15000),
        open: close, high: close * 1.001, low: close * 0.999, close, volume: vol
    });

    /**
     * Pattern (confirmed working via debug_strategy.js):
     *   40 flat candles at price 1.0 → EMA8 = EMA21 = 1.0 (equal, no crossover yet)
     *   1 final spike candle at 2.0 with vol=8 → EMA8 jumps above EMA21 (crossover + RSI 100 + vol spike)
     *
     *   This is a mathematically guaranteed trigger because:
     *   - Before spike: EMA8_prev == EMA21_prev (both 1.0 after warmup)
     *   - After spike:  EMA8 jumps more than EMA21 due to shorter period (more responsive)
     *   - prev_EMA8 <= prev_EMA21 AND curr_EMA8 > curr_EMA21 → isCrossover = true
     */
    const flat = Array.from({ length: 40 }, (_, i) => mk(1.0, 1.0, i));
    const spike = mk(2.0, 8.0, 41);
    const triggerHistory = [...flat, spike];

    const signal = checkStrategy(triggerHistory);

    if (signal) {
        pass('checkStrategy() fires signal on EMA crossover');
        info(`EMA8: ${signal.ema8.toFixed(5)}  EMA21: ${signal.ema21.toFixed(5)}  RSI: ${signal.rsi.toFixed(2)}  Vol: ${signal.volume.toFixed(2)} avg: ${signal.avgVolume.toFixed(2)}`);
        if (signal.ema8 > signal.ema21) pass('EMA8 > EMA21 ✓');
        else fail(`EMA8 NOT > EMA21`);
        if (signal.rsi > 50) pass(`RSI ${signal.rsi.toFixed(2)} > 50 ✓`);
        else fail(`RSI ${signal.rsi.toFixed(2)} not > 50`);
        if (signal.volume > signal.avgVolume * 1.5) pass(`Vol spike: ${signal.volume} > 1.5 × ${signal.avgVolume.toFixed(2)} ✓`);
        else fail('Volume spike not detected');
    } else {
        fail('checkStrategy() returned null — unexpected');
    }

    // Scenario B: flat — must NOT fire
    const flat50 = Array.from({ length: 50 }, (_, i) => mk(1.0, 1.0, i));
    if (checkStrategy(flat50) === null) pass('No false signal on flat price ✓');
    else fail('False signal triggered on flat price!');
};

// ── 4. Telegram Alert ─────────────────────────────────────────────────────────
const testTelegram = async () => {
    hdr('TEST 4 — Telegram Alert');
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || token.startsWith('your_') || !chatId || chatId.startsWith('your_')) {
        fail('Skipping — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set in .env');
        return;
    }

    const bot = new TelegramBot(token, { polling: false });
    const msg =
        `🧪 Token Tracker V0.2 — Test Alert
──────────────────────────────
✅ Telegram connectivity confirmed
📌 Ticker: TEST
📊 Volume: 8.00 SOL (avg 1.00)
📈 RSI: 100.0
📐 EMA8 > EMA21 ✓
⏱ ${new Date().toISOString()}`;

    try {
        await bot.sendMessage(chatId, msg);
        pass('Telegram message sent successfully');
    } catch (err) {
        fail(`Telegram send failed: ${err.message}`);
    }
};

// ── Runner ────────────────────────────────────────────────────────────────────
const run = async () => {
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║     Token Tracker V0.2 — Diagnostic Test Suite      ║');
    console.log('╚══════════════════════════════════════════════════════╝');

    testEnv();
    await testGecko();
    testStrategy();
    await testTelegram();

    hdr('RESULTS');
    console.log(`  Passed: ${totalPass}`);
    console.log(`  Failed: ${totalFail}`);
    console.log(totalFail === 0
        ? '\n  🎉 All tests passed. Bot is ready to run.\n'
        : '\n  ⚠️  Fix the above failures before starting the bot.\n');
};

run().catch(err => {
    console.error('\n[FATAL] Test runner crashed:', err.message);
    process.exit(1);
});
