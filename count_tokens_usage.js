const mongoose = require('mongoose');
require('dotenv').config();

const tokenSchema = new mongoose.Schema({
    address: { type: String, required: true, unique: true },
    symbol: String,
    name: String,
    poolAddress: String,
    createdAt: { type: Date, default: Date.now },
    isActive: { type: Boolean, default: true }
});

const Token = mongoose.model('Token', tokenSchema);

const count = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        const activeCount = await Token.countDocuments({ isActive: true });
        const totalCount = await Token.countDocuments({});
        console.log(`Active Tokens: ${activeCount}`);
        console.log(`Total Tokens: ${totalCount}`);
    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
};

count();
