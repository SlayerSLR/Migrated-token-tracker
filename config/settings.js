/**
 * settings.js
 *
 * Runtime bot settings — toggled via Telegram commands.
 * Persists in-memory for the duration of the process.
 */

const settings = {
    /**
     * When true, a volume spike (> 1.5× avg of last 10 candles) is required
     * before a signal is emitted. When false, only EMA crossover + RSI > 50
     * are needed.
     *
     * Default: false (volume filter OFF)
     * (Volume command removed — toggle by editing this value directly)
     */
    requireVolumeSpike: false,
};

module.exports = settings;
