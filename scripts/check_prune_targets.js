require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const connectDB = require('../config/db');
const Token = require('../models/Token');
const { getVolume5m, getMarketCaps } = require('../services/dexscreener');

async function checkTargets() {
    await connectDB();

    // Get all active tokens from DB
    const activeTokens = await Token.find({ isActive: true }).lean();
    console.log(`Found ${activeTokens.length} active tokens in DB.`);

    if (activeTokens.length === 0) {
        process.exit(0);
    }

    const addresses = activeTokens.map(t => t.address);
    console.log(`Fetching DexScreener data for ${addresses.length} tokens...`);

    const [volMap, mcMap] = await Promise.all([
        getVolume5m(addresses),
        getMarketCaps(addresses)
    ]);

    const now = Date.now();
    let targetsCount = 0;

    for (const token of activeTokens) {
        const address = token.address;
        const vol5m = volMap.get(address);
        const mc = mcMap.get(address);
        const launchedAt = token.launchedAt ? new Date(token.launchedAt).getTime() : 0;
        const ageHours = (now - launchedAt) / 3600000;

        let reason = null;

        if (vol5m !== undefined && vol5m < 100) {
            reason = `Low Volume ($${vol5m.toFixed(2)})`;
        }

        if (!reason && mc !== undefined && mc < 5000 && ageHours > 2) {
            reason = `Old & Low MC ($${mc.toFixed(0)}, ${ageHours.toFixed(1)}h)`;
        }

        if (reason) {
            console.log(`[Target] ${token.symbol || address.slice(0, 8)} needs pruning: ${reason}`);
            targetsCount++;
        }
    }

    console.log(`\nFound ${targetsCount} active tokens that currently meet the pruning criteria.`);
    if (targetsCount > 0) {
        console.log(`NOTE: The maintenance loop runs every 1 hour. It is normal for tokens to sit in this state for up to an hour before being pruned.`);
    }

    process.exit(0);
}

checkTargets().catch(err => {
    console.error(err);
    process.exit(1);
});
