const mongoose = require('mongoose');

/**
 * BackfillQueue — tracks tokens that need OHLCV backfill from GeckoTerminal.
 *
 * A token lands here when:
 *   - Pool resolution returned 429 or no result during discovery
 *   - OHLCV fetch returned 429 or empty result
 *   - Token was added to Token registry but has 0 backfilled candles
 *
 * Status flow:
 *   pending → resolving (lock during attempt) → done / failed
 *
 * Tokens with the fewest attempts are processed first (priority queue).
 */
const backfillQueueSchema = new mongoose.Schema({
    address: { type: String, required: true, unique: true },
    symbol: { type: String, default: '' },
    name: { type: String, default: '' },

    // null until we successfully resolve the pool
    poolAddress: { type: String, default: null },

    // pending → being processed → done or failed
    status: { type: String, enum: ['pending', 'done', 'failed'], default: 'pending', index: true },

    attempts: { type: Number, default: 0 },
    lastAttempt: { type: Date, default: null },
    error: { type: String, default: null },

    enqueuedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
});

// Index for the drainer query — fetch pending items ordered by attempts asc
backfillQueueSchema.index({ status: 1, attempts: 1 });

module.exports = mongoose.model('BackfillQueue', backfillQueueSchema);
