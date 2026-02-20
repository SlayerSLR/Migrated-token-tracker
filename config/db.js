const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('[DB] MongoDB connected');
    } catch (err) {
        console.error('[DB] Connection error:', err.message);
        process.exit(1);
    }
};

module.exports = connectDB;
