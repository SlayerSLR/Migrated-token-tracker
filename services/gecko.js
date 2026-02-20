/**
 * gecko.js
 * Backfills 1-minute OHLCV data from GeckoTerminal Public API (FREE, no key required).
 *
 * GeckoTerminal rate limit: 30 requests/minute on the public API.
 * To stay safe we use a sequential queue with a 2.5s delay between requests
 * (= max 24 req/min), so multiple tokens discovered at once won't instantly
 * fire 10+ parallel requests and trigger 429s.
 *
 * GeckoTerminal Docs: https://www.geckoterminal.com/dex-api
 */

const axios = require('axios');

const GECKO_BASE = 'https://api.geckoterminal.com/api/v2';
const HEADERS = { 'Accept': 'application/json;version=20230302' };
const THROTTLE_MS = 2500;   // min ms between requests (24 req/min < 30 limit)

// ── Simple sequential rate-limiter ───────────────────────────────────────────
let lastRequestAt = 0;

const throttledGet = async (url, params) => {
    const now = Date.now();
    const wait = THROTTLE_MS - (now - lastRequestAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return axios.get(url, { headers: HEADERS, params, timeout: 15000 });
};

/**
 * Resolves a Solana token address to its top-liquidity pool address on GeckoTerminal.
 * Returns null if not found.
 */
const resolvePoolAddress = async (tokenAddress) => {
    try {
        const url = `${GECKO_BASE}/networks/solana/tokens/${tokenAddress}/pools`;
        const res = await throttledGet(url, { page: 1, sort: 'h24_volume_usd_liquidity_desc' });

        const pools = res.data?.data;
        if (!pools || pools.length === 0) {
            console.log(`[Gecko] No pools found for ${tokenAddress}`);
            return null;
        }

        const poolAddress = pools[0].attributes?.address || pools[0].id?.split('_').pop();
        return poolAddress || null;
    } catch (err) {
        if (err.response?.status === 429) {
            console.warn(`[Gecko] Rate limited on pool resolve for ${tokenAddress}. Will retry next discovery cycle.`);
        } else {
            console.error(`[Gecko] Pool resolve error for ${tokenAddress}:`, err.response?.status, err.message);
        }
        return null;
    }
};

/**
 * Fetches 1-minute OHLCV candles for a given pool address.
 * Returns normalized array of candle objects, sorted oldest-first.
 */
const getBackfillData = async (poolAddress, limit = 300) => {
    if (!poolAddress) return [];
    try {
        const url = `${GECKO_BASE}/networks/solana/pools/${poolAddress}/ohlcv/minute`;
        const res = await throttledGet(url, {
            aggregate: 1,   // 1 minute candles
            limit,          // max 1000
            currency: 'usd',
            token: 'base'   // price in USD based on base token
        });

        const raw = res.data?.data?.attributes?.ohlcv_list;
        if (!raw || raw.length === 0) return [];

        // Raw format: [timestamp_sec, open, high, low, close, volume]
        // GeckoTerminal returns newest-first — sort to oldest-first
        return raw
            .map(c => ({
                timestamp: new Date(c[0] * 1000),
                open: parseFloat(c[1]),
                high: parseFloat(c[2]),
                low: parseFloat(c[3]),
                close: parseFloat(c[4]),
                volume: parseFloat(c[5])
            }))
            .sort((a, b) => a.timestamp - b.timestamp);

    } catch (err) {
        if (err.response?.status === 429) {
            console.warn(`[Gecko] Rate limited on OHLCV fetch for ${poolAddress}.`);
        } else {
            console.error(`[Gecko] OHLCV fetch error for pool ${poolAddress}:`, err.response?.status, err.message);
        }
        return [];
    }
};

module.exports = { resolvePoolAddress, getBackfillData };
