require('dotenv').config(); // Assumes running from project root
const mongoose = require('mongoose');
const Token = require('../models/Token'); // Resolves relative to this file

const run = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Connected to DB');

        // Find tokens with at least two alerts (first and last differ) or check logical growth
        // Actually, schema has firstAlertMarketCap and lastAlertMarketCap.
        // We want tokens where last > first (positive gain).
        const tokens = await Token.find({
            firstAlertMarketCap: { $exists: true },
            lastAlertMarketCap: { $exists: true }
        }).lean();

        let gainers = 0;
        let losers = 0;
        let neutral = 0;
        let totalGainPct = 0;
        let totalInitialMc = 0;
        let maxGain = -Infinity;
        let bestToken = null;

        console.log(`Analyzing ${tokens.length} tokens with alert history...`);

        for (const t of tokens) {
            const first = t.firstAlertMarketCap;
            const last = t.lastAlertMarketCap;

            if (last > first) {
                gainers++;
                const gain = ((last - first) / first) * 100;
                totalGainPct += gain;
                totalInitialMc += first;

                if (gain > maxGain) {
                    maxGain = gain;
                    bestToken = t;
                }
            } else if (last < first) {
                losers++;
            } else {
                neutral++;
            }
        }

        const total = tokens.length;
        const successRate = total > 0 ? (gainers / total) * 100 : 0;

        console.log('\n📊 Alert Performance Statistics:');
        console.log(`Total Tokens Alerted: ${total}`);
        console.log(`✅ Gainers: ${gainers} (${successRate.toFixed(1)}%)`);
        console.log(`❌ Losers:  ${losers} (${(total > 0 ? (losers / total) * 100 : 0).toFixed(1)}%)`);
        console.log(`➖ Neutral: ${neutral} (${(total > 0 ? (neutral / total) * 100 : 0).toFixed(1)}%)`);

        if (gainers > 0) {
            console.log(`\n📈 Positive Gainer Stats:`);
            console.log(`Avg Gain: ${(totalGainPct / gainers).toFixed(2)}%`);
            console.log(`Avg Initial Market Cap: $${(totalInitialMc / gainers).toFixed(2)}`);
            if (bestToken) {
                console.log(`🚀 Top Gainer: ${bestToken.symbol || bestToken.address} (+${maxGain.toFixed(2)}%)`);
            }
        }

        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
};

run();
