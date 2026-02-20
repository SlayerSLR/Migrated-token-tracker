/**
 * storage.js
 * Persists locally-generated 15s candles to MongoDB.
 * Also provides helpers to fetch candle history for indicator calculations.
 */

const Candle = require('../models/Candle');

/**
 * Save a single 15s candle to the database.
 * @param {object} candle - The candle object from CandleManager
 */
const saveCandle = async (candle) => {
    try {
        await Candle.create({
            tokenAddress: candle.tokenAddress,
            poolAddress: candle.poolAddress,
            timestamp: candle.timestamp,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume
        });
    } catch (err) {
        // Duplicate key is ok — idempotent saves
        if (err.code !== 11000) {
            console.error('[Storage] Save candle error:', err.message);
        }
    }
};

/**
 * Saves multiple candles at once (for GeckoTerminal backfill).
 * Skips duplicates silently.
 * @param {string} tokenAddress
 * @param {string|null} poolAddress
 * @param {Array} candles - Array of { timestamp, open, high, low, close, volume }
 */
const backfillCandles = async (tokenAddress, poolAddress, candles) => {
    if (!candles || candles.length === 0) return;

    const docs = candles.map(c => ({
        tokenAddress,
        poolAddress: poolAddress || null,
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume
    }));

    try {
        await Candle.insertMany(docs, { ordered: false });
        console.log(`[Storage] Backfilled ${docs.length} candles for ${tokenAddress}`);
    } catch (err) {
        // ordered: false allows partial success; duplicate key errors are safe to ignore
        if (err.code !== 11000 && err.writeErrors) {
            const realErrors = err.writeErrors.filter(e => e.code !== 11000);
            if (realErrors.length > 0) {
                console.error('[Storage] Backfill errors:', realErrors.length);
            }
        }
    }
};

/**
 * Fetch the N most recent candles for a token (for indicator calculation).
 * Returns sorted oldest-first.
 */
const getRecentCandles = async (tokenAddress, limit = 50) => {
    const docs = await Candle.find({ tokenAddress })
        .sort({ timestamp: -1 })
        .limit(limit)
        .lean();

    return docs.reverse(); // oldest-first for technicalindicators library
};

/**
 * Returns the timestamp of the most recent candle for a token.
 * Returns null if no candles exist.
 */
const getLatestCandleTime = async (tokenAddress) => {
    const doc = await Candle.findOne({ tokenAddress })
        .sort({ timestamp: -1 })
        .select('timestamp')
        .lean();
    return doc ? doc.timestamp : null;
};

module.exports = { saveCandle, backfillCandles, getRecentCandles, getLatestCandleTime };
