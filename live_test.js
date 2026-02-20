/**
 * live_test.js — 5-minute live credit consumption monitor
 *
 * Runs the real bot components (Moralis polling, GeckoTerminal backfill,
 * Helius WebSocket) and measures actual API usage over 5 minutes.
 *
 * Auto-terminates after 300 seconds. If a clean shutdown takes >40s,
 * it dumps active handles so you can diagnose what's blocking exit.
 *
 * Usage: node live_test.js
 */

'use strict';
require('dotenv').config();

const WebSocket = require('ws');
const axios = require('axios');
const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────────────────────
// Counters — everything we track
// ─────────────────────────────────────────────────────────────────────────────
const stats = {
    startTime: Date.now(),

    moralis: {
        calls: 0,    // HTTP requests made
        tokensFound: 0,    // total tokens returned across all calls
        newTokens: 0,    // tokens not previously seen
        errors: 0,
        lastCallMs: null, // response time of last call
    },

    gecko: {
        poolResolves: 0,    // /search calls
        ohlcvFetches: 0,    // /ohlcv calls
        candlesTotal: 0,    // candles received
        errors: 0,
    },

    helius: {
        connected: false,
        connectTime: null, // ms until first open
        reconnects: 0,
        messagesIn: 0,   // all WS frames received
        notifications: 0,   // subscription result frames (transactions)
        txParsed: 0,   // frames we tried to parse as a tx
        subscriptionId: null,
        creditEstimate: 0,   // notifications × 1 credit (Helius pricing)
    },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const fmtMs = (ms) => ms != null ? `${ms.toFixed(0)} ms` : 'N/A';
const elapsed = () => ((Date.now() - stats.startTime) / 1000).toFixed(1);
const log = (tag, msg) => console.log(`[${elapsed()}s] [${tag}] ${msg}`);

function printReport() {
    const runSec = (Date.now() - stats.startTime) / 1000;
    const runMin = (runSec / 60).toFixed(2);

    console.log('\n');
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║           LIVE TEST — CREDIT CONSUMPTION REPORT     ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log(`  Runtime: ${runSec.toFixed(1)}s (~${runMin} min)\n`);

    console.log('── MORALIS ─────────────────────────────────────────────');
    console.log(`  HTTP calls made:        ${stats.moralis.calls}`);
    console.log(`  Tokens returned total:  ${stats.moralis.tokensFound}`);
    console.log(`  New tokens (unique):    ${stats.moralis.newTokens}`);
    console.log(`  Errors:                 ${stats.moralis.errors}`);
    console.log(`  Last response time:     ${fmtMs(stats.moralis.lastCallMs)}`);
    // Moralis CU: pumpfun/graduated = 5 CU/call (documented)
    const moralisCU = stats.moralis.calls * 5;
    const moralisDailyCU = runSec > 0 ? (moralisCU / runSec * 86400).toFixed(0) : 0;
    console.log(`  Est. CU used:           ${moralisCU}  (5 CU × ${stats.moralis.calls} calls)`);
    console.log(`  Projected CU/day:       ~${moralisDailyCU}  (free tier: 40,000/day)`);

    console.log('\n── GECKOTERMINAL ────────────────────────────────────────');
    console.log(`  Pool resolve calls:     ${stats.gecko.poolResolves}`);
    console.log(`  OHLCV fetch calls:      ${stats.gecko.ohlcvFetches}`);
    console.log(`  Total candles received: ${stats.gecko.candlesTotal}`);
    console.log(`  Errors:                 ${stats.gecko.errors}`);
    // GeckoTerminal is fully free, no credits — just rate-limit (30 req/min)
    const geckoTotal = stats.gecko.poolResolves + stats.gecko.ohlcvFetches;
    const geckoRPM = runSec > 0 ? (geckoTotal / runSec * 60).toFixed(2) : 0;
    console.log(`  Total HTTP calls:       ${geckoTotal}`);
    console.log(`  Rate:                   ~${geckoRPM} req/min  (limit: 30/min)`);

    console.log('\n── HELIUS WEBSOCKET ─────────────────────────────────────');
    console.log(`  Connected:              ${stats.helius.connected}`);
    console.log(`  Time to first connect:  ${fmtMs(stats.helius.connectTime)}`);
    console.log(`  Reconnections:          ${stats.helius.reconnects}`);
    console.log(`  WS frames received:     ${stats.helius.messagesIn}`);
    console.log(`  Transaction notifs:     ${stats.helius.notifications}`);
    console.log(`  Frames rate:            ${runSec > 0 ? (stats.helius.messagesIn / runSec).toFixed(2) : 0} /s`);
    console.log(`  Notif rate:             ${runSec > 0 ? (stats.helius.notifications / runSec).toFixed(2) : 0} /s`);
    // Helius pricing: 1 credit per transaction notification delivered
    const heliusCredits = stats.helius.notifications;
    const heliusDailyCredits = runSec > 0 ? (heliusCredits / runSec * 86400).toFixed(0) : 0;
    console.log(`  Est. credits used:      ${heliusCredits}  (1 credit × ${stats.helius.notifications} notifications)`);
    console.log(`  Projected credits/day:  ~${heliusDailyCredits}  (free tier: 1,000,000/month = 33,333/day)`);

    console.log('\n── SUMMARY ──────────────────────────────────────────────');
    const moralisOk = parseInt(moralisDailyCU) < 40000;
    const geckoOk = parseFloat(geckoRPM) < 30;
    const heliusOk = parseInt(heliusDailyCredits) < 33333;
    console.log(`  Moralis within free tier?    ${moralisOk ? '✅ YES' : '❌ NO  ← OVER LIMIT'}`);
    console.log(`  GeckoTerminal within limit?  ${geckoOk ? '✅ YES' : '❌ NO  ← OVER LIMIT'}`);
    console.log(`  Helius within free tier?     ${heliusOk ? '✅ YES' : '❌ NO  ← OVER LIMIT'}`);
    console.log('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Moralis polling (mirrors index.js interval: every 40s)
// ─────────────────────────────────────────────────────────────────────────────
const MORALIS_BASE = 'https://solana-gateway.moralis.io';
const seenAddresses = new Set();

async function pollMoralis() {
    const t0 = Date.now();
    try {
        const resp = await axios.get(`${MORALIS_BASE}/token/mainnet/exchange/pumpfun/graduated`, {
            headers: { 'accept': 'application/json', 'X-API-Key': process.env.MORALIS_API_KEY },
            params: { limit: 10 },
            timeout: 15000,
        });
        stats.moralis.lastCallMs = Date.now() - t0;
        stats.moralis.calls++;
        const tokens = resp.data?.result ?? resp.data ?? [];
        stats.moralis.tokensFound += tokens.length;

        for (const t of tokens) {
            const addr = t.tokenAddress || t.address || t.contractAddress;
            if (addr && !seenAddresses.has(addr)) {
                seenAddresses.add(addr);
                stats.moralis.newTokens++;
                log('MORALIS', `New token: ${t.symbol || addr.slice(0, 8)} (${addr.slice(0, 12)}...)`);

                // Trigger a GeckoTerminal backfill for each new token
                backfillGecko(addr);
            }
        }
        log('MORALIS', `call #${stats.moralis.calls} — ${tokens.length} tokens returned, ${stats.moralis.newTokens} unique total (${fmtMs(stats.moralis.lastCallMs)})`);
    } catch (err) {
        stats.moralis.errors++;
        log('MORALIS', `ERROR: ${err.response?.data?.message || err.message}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// GeckoTerminal backfill (mirrors gecko.js)
// ─────────────────────────────────────────────────────────────────────────────
const GECKO_BASE = 'https://api.geckoterminal.com/api/v2';
const GECKO_HEADERS = { 'Accept': 'application/json;version=20230302' };
const GECKO_THROTTLE_MS = 2500; // max 24 req/min, well under 30 limit
let geckoLastReq = 0;

async function geckoGet(url, params) {
    const wait = GECKO_THROTTLE_MS - (Date.now() - geckoLastReq);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    geckoLastReq = Date.now();
    return axios.get(url, { params, headers: GECKO_HEADERS, timeout: 12000 });
}

async function resolvePool(tokenAddress) {
    try {
        // Use the /tokens/{addr}/pools endpoint (same as gecko.js)
        const resp = await geckoGet(
            `${GECKO_BASE}/networks/solana/tokens/${tokenAddress}/pools`,
            { page: 1, sort: 'h24_volume_usd_liquidity_desc' }
        );
        stats.gecko.poolResolves++;
        const pools = resp.data?.data;
        if (!pools || pools.length === 0) return null;
        return pools[0].attributes?.address || pools[0].id?.split('_').pop() || null;
    } catch (err) {
        stats.gecko.errors++;
        log('GECKO', `Pool resolve ${err.response?.status ?? 'ERR'}: ${err.message}`);
        return null;
    }
}

async function backfillGecko(tokenAddress) {
    const pool = await resolvePool(tokenAddress);
    if (!pool) { log('GECKO', `No pool for ${tokenAddress.slice(0, 12)}`); return; }
    log('GECKO', `Pool resolved: ${pool.slice(0, 12)}...`);

    try {
        const resp = await geckoGet(
            `${GECKO_BASE}/networks/solana/pools/${pool}/ohlcv/minute`,
            { aggregate: 1, limit: 60, currency: 'usd' }
        );
        stats.gecko.ohlcvFetches++;
        const candles = resp.data?.data?.attributes?.ohlcv_list ?? [];
        stats.gecko.candlesTotal += candles.length;
        log('GECKO', `OHLCV: ${candles.length} candles for pool ${pool.slice(0, 12)}...`);
    } catch (err) {
        stats.gecko.errors++;
        log('GECKO', `OHLCV ${err.response?.status ?? 'ERR'}: ${err.message}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helius WebSocket
// ─────────────────────────────────────────────────────────────────────────────
const HELIUS_WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`; // standard WS, free tier
let ws = null;
const wsConnectStart = Date.now();

function connectHelius() {
    ws = new WebSocket(HELIUS_WS_URL);

    ws.on('open', () => {
        if (!stats.helius.connected) {
            stats.helius.connectTime = Date.now() - wsConnectStart;
        }
        stats.helius.connected = true;
        log('HELIUS', `WS connected (${fmtMs(stats.helius.connectTime)})`);

        // Use logsSubscribe (standard WS, free tier) with mentions filter.
        // Unlike transactionSubscribe (Business plan only), logsSubscribe is free.
        // We subscribe to logs mentioning USDC and WSOL as test accounts.
        const req = {
            jsonrpc: '2.0', id: 1,
            method: 'logsSubscribe',
            params: [
                {
                    // mentions filter: only deliver logs for txs that touch these accounts.
                    mentions: [
                        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
                        'So11111111111111111111111111111111111111112',      // WSOL
                    ]
                },
                { commitment: 'confirmed' }
            ]
        };
        ws.send(JSON.stringify(req));
        log('HELIUS', 'logsSubscribe sent (USDC + WSOL sentinel accounts)');
    });

    ws.on('message', (raw) => {
        stats.helius.messagesIn++;
        try {
            const msg = JSON.parse(raw.toString());
            if (msg.id === 1 && msg.result !== undefined) {
                stats.helius.subscriptionId = msg.result;
                log('HELIUS', `logsSubscribe confirmed, id=${msg.result}`);
            } else if (msg.method === 'logsNotification') {
                stats.helius.notifications++;
                stats.helius.creditEstimate++; // standard WS streaming is free; 1 credit to open
                if (stats.helius.notifications % 25 === 0) {
                    log('HELIUS', `${stats.helius.notifications} log notifications so far`);
                }
            }
        } catch { /* non-JSON frame */ }
    });

    ws.on('close', (code) => {
        stats.helius.connected = false;
        log('HELIUS', `WS closed (code=${code})`);
        // Don't reconnect — we're just measuring
    });

    ws.on('error', (err) => {
        log('HELIUS', `WS ERROR: ${err.message}`);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Shutdown logic — force exit after 40s if stuck
// ─────────────────────────────────────────────────────────────────────────────
function shutdown(reason) {
    log('CTRL', `Shutting down (${reason})...`);
    printReport();

    const shutdownStart = Date.now();

    // Gracefully close WS
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'test complete');
        log('HELIUS', 'WebSocket close requested');
    }

    // Close MongoDB if connected
    if (mongoose.connection.readyState !== 0) {
        mongoose.connection.close();
        log('DB', 'MongoDB connection closed');
    }

    // Clear all intervals
    clearInterval(moralisTimer);
    clearInterval(statusTimer);

    // Watchdog: if we're still running after 40s, dump handles and force exit
    const watchdog = setTimeout(() => {
        const waited = Date.now() - shutdownStart;
        console.error(`\n⚠️  SLOW SHUTDOWN — still running after ${(waited / 1000).toFixed(1)}s`);
        console.error('Active handles preventing exit:');

        // Use process._getActiveHandles() to list what keeps the loop alive
        const handles = process._getActiveHandles ? process._getActiveHandles() : [];
        for (const h of handles) {
            const type = h.constructor?.name ?? '<unknown>';
            const extra =
                type === 'Socket' ? ` fd=${h.fd} destroyed=${h.destroyed}` :
                    type === 'Timer' ? ` repeat=${h._repeat}` :
                        type === 'Timeout' ? '' :
                            type === 'TCPSocket' ? ` remoteAddress=${h.remoteAddress}` : '';
            console.error(`  → [${type}]${extra}`);
        }
        console.error('\nForcing process.exit(0)...\n');
        process.exit(0);
    }, 40_000);
    watchdog.unref(); // don't let the watchdog itself prevent exit
}

// ─────────────────────────────────────────────────────────────────────────────
// Main — start everything
// ─────────────────────────────────────────────────────────────────────────────
const TEST_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const MORALIS_POLL_MS = 40 * 1000;      // 40s (matches index.js)
const STATUS_PRINT_MS = 60 * 1000;      // print live stats every 60s

log('CTRL', `Starting 5-minute live test. Will auto-terminate at T+${TEST_DURATION_MS / 1000}s`);
log('CTRL', 'APIs: Moralis (40s poll) | GeckoTerminal (per new token) | Helius WS (continuous)');

// Start Helius immediately
connectHelius();

// First Moralis poll immediately, then every 40s
pollMoralis();
const moralisTimer = setInterval(pollMoralis, MORALIS_POLL_MS);

// Periodic live status
const statusTimer = setInterval(() => {
    const sec = ((Date.now() - stats.startTime) / 1000).toFixed(0);
    const timeLeft = ((TEST_DURATION_MS - (Date.now() - stats.startTime)) / 1000).toFixed(0);
    log('STATUS', `T+${sec}s | ${timeLeft}s remaining | Moralis: ${stats.moralis.calls} calls | Gecko: ${stats.gecko.poolResolves + stats.gecko.ohlcvFetches} calls | Helius WS msgs: ${stats.helius.messagesIn} (${stats.helius.notifications} notifs)`);
}, STATUS_PRINT_MS);

// Auto-terminate after 5 minutes
setTimeout(() => shutdown('5-minute timer fired'), TEST_DURATION_MS);

// Also handle manual Ctrl+C
process.on('SIGINT', () => shutdown('SIGINT (Ctrl+C)'));
