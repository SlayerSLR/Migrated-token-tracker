const mongoose = require('mongoose');

// Stores migrated tokens we are actively tracking
const tokenSchema = new mongoose.Schema({
    address: { type: String, required: true, unique: true },
    symbol: { type: String },
    name: { type: String },
    poolAddress: { type: String },
    network: { type: String, default: 'solana' },
    launchedAt: { type: Date },
    addedAt: { type: Date, default: Date.now },
    isActive: { type: Boolean, default: true },
    // Last alert — persisted for cross-session MC delta
    lastAlertMarketCap: { type: Number },
    lastAlertSentAt: { type: Date },
    // First alert ever — never overwritten, used for cumulative MC change
    firstAlertMarketCap: { type: Number },
    firstAlertSentAt: { type: Date }
});

module.exports = mongoose.model('Token', tokenSchema);
