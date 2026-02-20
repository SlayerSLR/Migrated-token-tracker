/**
 * dexscreener.js
 *
 * Fetches 5-minute trading volume for a batch of Solana tokens from DexScreener.
 *
 * Endpoint: GET https://api.dexscreener.com/tokens/v1/solana/{addresses}
 *   - Up to 30 token addresses per request (comma-separated)
 *   - Rate limit: 300 req/min (no key required)
 *   - Returns pairs[]; each pair has volume.m5 in USD
 *
 * We take the MAX volume.m5 across all pairs returned for a given token
 * (a token may have multiple pools).
 */

const axios = require('axios');

const BASE_URL = 'https://api.dexscreener.com/tokens/v1/solana';
const BATCH_SIZE = 30;        // DexScreener max per request
const BATCH_DELAY_MS = 250;   // ~4 batches/sec — well under 300/min limit

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Get 5-minute USD volume for a list of token addresses.
 * Returns a Map<address, volume5m>.
 * Tokens not found on DexScreener will not appear in the map.
 *
 * @param {string[]} addresses
 * @returns {Promise<Map<string, number>>}
 */
const getVolume5m = async (addresses) => {
    const result = new Map();
    if (!addresses || addresses.length === 0) return result;

    for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
        const batch = addresses.slice(i, i + BATCH_SIZE);
        const url = `${BASE_URL}/${batch.join(',')}`;

        try {
            const { data } = await axios.get(url, { timeout: 10000 });
            const pairs = data?.pairs || [];

            for (const pair of pairs) {
                const addr = pair?.baseToken?.address;
                if (!addr) continue;

                const vol = pair?.volume?.m5 ?? 0;
                if (!result.has(addr) || vol > result.get(addr)) {
                    result.set(addr, vol);
                }
            }
        } catch (err) {
            console.error(`[DexScreener] Batch ${i / BATCH_SIZE + 1} error:`, err.message);
        }

        if (i + BATCH_SIZE < addresses.length) await sleep(BATCH_DELAY_MS);
    }

    return result;
};

/**
 * Get current market cap for a list of token addresses.
 * Returns a Map<address, marketCap>.
 * Tokens not found on DexScreener will not appear in the map.
 *
 * @param {string[]} addresses
 * @returns {Promise<Map<string, number>>}
 */
const getMarketCaps = async (addresses) => {
    const result = new Map();
    if (!addresses || addresses.length === 0) return result;

    for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
        const batch = addresses.slice(i, i + BATCH_SIZE);
        const url = `${BASE_URL}/${batch.join(',')}`;

        try {
            const { data } = await axios.get(url, { timeout: 10000 });
            const pairs = data?.pairs || [];

            for (const pair of pairs) {
                const addr = pair?.baseToken?.address;
                if (!addr) continue;

                const mc = pair?.marketCap ?? pair?.fdv ?? 0;
                // Keep the highest MC across multiple pools for the same token
                if (!result.has(addr) || mc > result.get(addr)) {
                    result.set(addr, mc);
                }
            }
        } catch (err) {
            console.error(`[DexScreener] MC batch ${i / BATCH_SIZE + 1} error:`, err.message);
        }

        if (i + BATCH_SIZE < addresses.length) await sleep(BATCH_DELAY_MS);
    }

    return result;
};

module.exports = { getVolume5m, getMarketCaps };
