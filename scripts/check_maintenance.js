require('dotenv').config();
const connectDB = require('../config/db');
const Token = require('../models/Token');

async function check() {
    await connectDB();

    // Get count of inactive vs active tokens
    const activeCount = await Token.countDocuments({ isActive: true });
    const inactiveCount = await Token.countDocuments({ isActive: false });

    console.log(`Active tokens: ${activeCount}`);
    console.log(`Inactive tokens: ${inactiveCount}`);

    // Get the most recent 10 inactive tokens to see when they were added and deactivated
    const recentInactive = await Token.find({ isActive: false })
        .sort({ addedAt: -1 })
        .limit(10)
        .lean();

    console.log('\nRecently deactivated/inactive tokens:');
    recentInactive.forEach(t => {
        console.log(`- ${t.symbol || t.address}: Added ${t.addedAt}, Launched: ${t.launchedAt}`);
    });

    process.exit(0);
}

check().catch(console.error);
