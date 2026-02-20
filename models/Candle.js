const mongoose = require('mongoose');

// 15-second OHLCV candle
const candleSchema = new mongoose.Schema({
    tokenAddress: { type: String, required: true, index: true },
    poolAddress: { type: String },
    timestamp: { type: Date, required: true },
    open: { type: Number, required: true },
    high: { type: Number, required: true },
    low: { type: Number, required: true },
    close: { type: Number, required: true },
    volume: { type: Number, default: 0 }
}, { timeseries: false });

// Compound index for fast querying by token + time
candleSchema.index({ tokenAddress: 1, timestamp: 1 }, { unique: true });

module.exports = mongoose.model('Candle', candleSchema);
