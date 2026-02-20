/**
 * jupiter.js
 *
 * Polls Jupiter Price API v3 for live price data.
 * Replaces Helius WebSocket to avoid rate limits and free tier restrictions.
 *
 * Endpoint: https://api.jup.ag/price/v3?ids=...
 * Limit: 100 tokens per batch. Rate limit ~20 calls/min (Free).
 * We poll every 15s (4 calls/min).
 */

const axios = require('axios');
const candleManager = require('./candleManager');

const POLLING_INTERVAL = 15000; // 15 seconds
const JUP_API_URL = 'https://api.jup.ag/price/v3';

let trackedMints = new Set();
let timer = null;
let lastUpdate = 0;

/**
 * Get the timestamp of the last successful data fetch.
 */
const getLastUpdate = () => lastUpdate;

/**
 * Add a token to the polling list.
 * @param {string} mintAddress 
 */
const trackToken = (mintAddress) => {
    trackedMints.add(mintAddress);
    console.log(`[Jupiter] Tracking ${mintAddress} (Total: ${trackedMints.size})`);
};

/**
 * Remove a token from the polling list.
 * @param {string} mintAddress 
 */
const untrackToken = (mintAddress) => {
    trackedMints.delete(mintAddress);
};

/**
 * Fetch prices for all tracked mints.
 * Handles batching (though we likely won't exceed 100 soon).
 */
const fetchPrices = async () => {
    if (trackedMints.size === 0) return;

    const mints = Array.from(trackedMints);
    // Batching logic (API limit is 100 IDs per call)
    const BATCH_SIZE = 100;

    for (let i = 0; i < mints.length; i += BATCH_SIZE) {
        const batch = mints.slice(i, i + BATCH_SIZE);
        const ids = batch.join(',');

        try {
            const config = {};
            // Attach API Key if present
            if (process.env.JUPITER_API_KEY) {
                config.headers = { 'x-api-key': process.env.JUPITER_API_KEY.trim() };
            }
            const resp = await axios.get(`${JUP_API_URL}?ids=${ids}`, config);
            // v3 response is likely direct map
            const data = resp.data;


            if (!data) continue;

            lastUpdate = Date.now(); // Update timestamp on success

            // Process results
            for (const mint of batch) {
                const item = data[mint];
                // v3 uses 'usdPrice'
                if (item && item.usdPrice) {
                    const price = parseFloat(item.usdPrice);
                    // Jupiter does not provide volume in this endpoint. 
                    // We pass 0 for volume. Strategy should handle this.
                    if (!isNaN(price)) {
                        console.log(`[Jupiter] ${mint.slice(0, 8)}: ${price} USDC`);
                        candleManager.addTrade(mint, price, 0);
                    }
                }
            }
        } catch (err) {
            console.error(`[Jupiter] Polling error: ${err.message}`);
        }
    }
};

/**
 * Start the polling loop.
 */
const start = () => {
    if (timer) return;
    console.log('[Jupiter] Starting price polling (15s interval)...');

    // Initial fetch
    fetchPrices();

    timer = setInterval(fetchPrices, POLLING_INTERVAL);
};

module.exports = {
    trackToken,
    untrackToken,
    start,
    getLastUpdate
};
