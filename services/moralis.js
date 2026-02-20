/**
 * moralis.js
 * Fetches recently migrated / graduated tokens from Moralis Solana API.
 *
 * Moralis endpoint used:
 *   GET /token/mainnet/exchange/{exchange}/graduated
 * Docs: https://docs.moralis.com/web3-data-api/solana/reference/get-graduated-tokens-by-exchange
 *
 * Supported exchanges (confirmed by Moralis):
 *   pumpfun   — pump.fun / pumpswap
 *   launchlab — Raydium LaunchLab (LetsBonk.fun / Bonk launchpad)
 */

const axios = require('axios');

const MORALIS_BASE = 'https://solana-gateway.moralis.io';

// All launchpads to poll. Add slugs here as Moralis adds support.
// Confirmed working (Feb 2026): pumpfun
// Not yet supported:           launchlab (Bonk/LetsBonk), boop, bags, believe
const EXCHANGES = [
    'pumpfun',
    // 'launchlab',  // Raydium LaunchLab / LetsBonk — add when Moralis enables
    // 'boop',       // Boop.fun — add when Moralis enables
];

let lastUpdate = 0;
const getLastUpdate = () => lastUpdate;

/**
 * Fetch graduated tokens from a single exchange.
 * Returns [] on any error (safe to call in parallel).
 */
const fetchFromExchange = async (exchange, limit) => {
    try {
        const response = await axios.get(
            `${MORALIS_BASE}/token/mainnet/exchange/${exchange}/graduated`,
            {
                headers: {
                    'accept': 'application/json',
                    'X-API-Key': process.env.MORALIS_API_KEY
                },
                params: { limit }
            }
        );

        const tokens = response.data?.result || response.data || [];
        return tokens.map(t => ({
            address: t.tokenAddress || t.address,
            symbol: t.symbol || '',
            name: t.name || '',
            createdAt: t.createdAt || t.blockTimestamp || new Date().toISOString(),
            source: exchange     // tag which launchpad it came from
        }));

    } catch (error) {
        const status = error.response?.status;
        if (status === 404) {
            // Exchange slug not (yet) supported by Moralis — suppress noise
            console.warn(`[Moralis] Exchange "${exchange}" not supported (404). Skipping.`);
        } else {
            console.error(`[Moralis] Error fetching from ${exchange}:`,
                error.response?.data?.message || error.message);
        }
        return [];
    }
};

/**
 * Returns recently graduated tokens from all configured launchpads.
 * Deduplicates by address in case the same token appears in multiple feeds.
 */
const getMigratedTokens = async (limit = 10) => {
    const results = await Promise.all(
        EXCHANGES.map(ex => fetchFromExchange(ex, limit))
    );

    // Flatten + deduplicate by address
    const seen = new Set();
    const tokens = [];
    for (const batch of results) {
        for (const t of batch) {
            if (t.address && !seen.has(t.address)) {
                seen.add(t.address);
                tokens.push(t);
            }
        }
    }

    if (tokens.length > 0) {
        lastUpdate = Date.now();
        // Log per-source count for visibility
        for (const ex of EXCHANGES) {
            const count = results[EXCHANGES.indexOf(ex)].length;
            if (count > 0) console.log(`[Moralis] ${ex}: ${count} token(s)`);
        }
    }

    return tokens;
};

module.exports = { getMigratedTokens, getLastUpdate };
