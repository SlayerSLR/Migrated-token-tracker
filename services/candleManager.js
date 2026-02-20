/**
 * candleManager.js
 * 
 * Manages per-token 15-second candle aggregation from raw live trade data.
 * Trade data is fed in by the Jupiter Price API polling service.
 * 
 * Design:
 *   - A "CandleBuffer" holds the in-progress candle for each token.
 *   - Every 15s, a timer fires, closes the candle, emits it, and resets the buffer.
 *   - External code calls `addTrade(tokenAddress, price, volume)` to feed data.
 *   - External code registers callbacks for `candle` events.
 */

const EventEmitter = require('events');

const CANDLE_INTERVAL_MS = 15 * 1000; // 15 seconds

class CandleManager extends EventEmitter {
    constructor() {
        super();
        // Map: tokenAddress -> { open, high, low, close, volume, tradeCount }
        this.buffers = new Map();
        // Map: tokenAddress -> token metadata
        this.tracked = new Map();
        // Map: tokenAddress -> last known price (persists across candles)
        this.lastPrices = new Map();
    }

    /**
     * Register a token for tracking.
     * @param {string} tokenAddress - Solana token mint address
     * @param {object} meta         - { symbol, name, poolAddress }
     */
    addToken(tokenAddress, meta = {}) {
        if (this.tracked.has(tokenAddress)) return;

        this.tracked.set(tokenAddress, meta);
        this.buffers.set(tokenAddress, null); // null = waiting for first trade
        console.log(`[CandleManager] +Tracking ${meta.symbol || tokenAddress}`);
    }

    /**
     * Remove a token from tracking.
     */
    /**
     * Remove a token from tracking.
     */
    removeToken(tokenAddress) {
        this.tracked.delete(tokenAddress);
        this.buffers.delete(tokenAddress);
        this.lastPrices.delete(tokenAddress);
    }

    /**
     * Get the last known price for a tracked token.
     * @param {string} tokenAddress 
     * @returns {number|null}
     */
    getLastPrice(tokenAddress) {
        return this.lastPrices.get(tokenAddress) || null;
    }

    /**
     * Called by Jupiter price polling to feed live price data.
     * @param {string} tokenAddress
     * @param {number} price  - price in USD of the base token
     * @param {number} volume - USD volume of the trade (0 for Jupiter)
     */
    addTrade(tokenAddress, price, volume) {
        if (!this.tracked.has(tokenAddress)) return;
        if (isNaN(price) || price <= 0) return;

        const buf = this.buffers.get(tokenAddress);

        // Update persistent price cache
        this.lastPrices.set(tokenAddress, price);

        if (buf === null) {
            // First trade in this candle period
            this.buffers.set(tokenAddress, {
                open: price,
                high: price,
                low: price,
                close: price,
                volume: volume || 0,
                tradeCount: 1
            });
        } else {
            buf.high = Math.max(buf.high, price);
            buf.low = Math.min(buf.low, price);
            buf.close = price;
            buf.volume += (volume || 0);
            buf.tradeCount++;
        }
    }

    /**
     * Called by the global 15s ticker to close and emit all active candles.
     * @param {Date} candleTimestamp - The start of the closed candle period
     */
    closeCandlesFor(candleTimestamp) {
        for (const [tokenAddress, buf] of this.buffers.entries()) {
            if (buf === null) continue; // No trades this candle

            const meta = this.tracked.get(tokenAddress) || {};
            const candle = {
                tokenAddress,
                poolAddress: meta.poolAddress || null,
                symbol: meta.symbol || '',
                timestamp: candleTimestamp,
                open: buf.open,
                high: buf.high,
                low: buf.low,
                close: buf.close,
                volume: buf.volume,
                tradeCount: buf.tradeCount
            };

            // Emit for strategy to process
            this.emit('candle', candle);

            // Reset buffer for next period
            this.buffers.set(tokenAddress, null);
        }
    }
}

// Singleton + global timer
const instance = new CandleManager();

// Snap to next 15s boundary for alignment
const startCandleClock = () => {
    const now = Date.now();
    const remainder = CANDLE_INTERVAL_MS - (now % CANDLE_INTERVAL_MS);

    setTimeout(() => {
        // Fire at the boundary, then every 15s
        const fireCandleClose = () => {
            const ts = new Date(Math.floor(Date.now() / CANDLE_INTERVAL_MS) * CANDLE_INTERVAL_MS);
            instance.closeCandlesFor(ts);
        };

        fireCandleClose();
        setInterval(fireCandleClose, CANDLE_INTERVAL_MS);
    }, remainder);

    console.log(`[CandleManager] Clock started. First candle in ${(remainder / 1000).toFixed(1)}s`);
};

startCandleClock();

module.exports = instance;
