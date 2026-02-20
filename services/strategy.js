/**
 * strategy.js
 *
 * Evaluates a closed 15s candle against the strategy conditions.
 *
 * Strategy:
 *   Condition 1: EMA 9 > EMA 20 (crossover — was <= on previous candle)
 *   Condition 2: RSI 14 > 50
 *   Condition 3: Volume > 1.5× Average Volume (last 10 candles) [OPTIONAL — see opts]
 *   Timeframe:  15 seconds
 */

const { EMA, RSI } = require('technicalindicators');

// Minimum candles required before evaluating
const MIN_CANDLES = 21; // enough for EMA 20 warm-up

/**
 * Check the strategy against candle history.
 *
 * @param {object[]} history - Array of candles sorted oldest→newest (min ~50 recommended)
 * @param {object}   [opts]
 * @param {boolean}  [opts.requireVolumeSpike=false] - When true, volume must be > 1.5× avg
 * @returns {object|null} Signal object if conditions met, null otherwise
 */
const checkStrategy = (history, opts = {}) => {
    const { requireVolumeSpike = false } = opts;

    if (!history || history.length < MIN_CANDLES) return null;

    const closes = history.map(c => c.close);
    const volumes = history.map(c => c.volume);

    // ── EMA 9 & 20 ───────────────────────────────────────────────────────────
    const ema9Result = EMA.calculate({ period: 9, values: closes });
    const ema20Result = EMA.calculate({ period: 20, values: closes });

    if (ema9Result.length < 2 || ema20Result.length < 2) return null;

    const ema9Curr = ema9Result[ema9Result.length - 1];
    const ema9Prev = ema9Result[ema9Result.length - 2];
    const ema20Curr = ema20Result[ema20Result.length - 1];
    const ema20Prev = ema20Result[ema20Result.length - 2];

    // Crossover: EMA9 was below EMA20, now above
    const isCrossover = (ema9Prev <= ema20Prev) && (ema9Curr > ema20Curr);
    if (!isCrossover) return null;

    // ── RSI 14 ───────────────────────────────────────────────────────────────
    const rsiResult = RSI.calculate({ period: 14, values: closes });
    if (rsiResult.length === 0) return null;

    const rsi = rsiResult[rsiResult.length - 1];
    const isRsiGood = rsi > 50;
    if (!isRsiGood) return null;

    // ── Volume Spike (optional) ──────────────────────────────────────────────
    const recentVolumes = volumes.slice(-11, -1); // last 10 completed candles
    const currentVolume = volumes[volumes.length - 1];
    const avgVolume = recentVolumes.length >= 5
        ? recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length
        : 0;
    const isVolumeSpike = avgVolume > 0 && currentVolume > avgVolume * 1.5;

    if (requireVolumeSpike && !isVolumeSpike) return null;

    // ── Signal ───────────────────────────────────────────────────────────────
    const latest = history[history.length - 1];
    return {
        tokenAddress: latest.tokenAddress,
        symbol: latest.symbol || latest.tokenAddress,
        ema9: ema9Curr,
        ema20: ema20Curr,
        rsi,
        volume: currentVolume,
        avgVolume,
        volumeSpikeActive: requireVolumeSpike,
        isVolumeSpike,
        isSignal: true, // Marker
        price: latest.close,
    };
};

module.exports = { checkStrategy };
