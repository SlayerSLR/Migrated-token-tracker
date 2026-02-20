require('dotenv').config();
const mongoose = require('mongoose');
const Token = require('../models/Token');
const Candle = require('../models/Candle');

const PUMP_FUN_SUPPLY = 1_000_000_000;

const run = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Connected to DB');

        // Find tokens that have triggered at least one alert
        const tokens = await Token.find({
            firstAlertMarketCap: { $exists: true },
            firstAlertSentAt: { $exists: true }
        }).lean();

        console.log(`Analyzing peak performance for ${tokens.length} alerted tokens...`);
        console.log('---------------------------------------------------');

        let stats = {
            total: 0,
            gain50: 0,
            gain100: 0,
            gain200: 0,
            gain500: 0,
            maxGain: -Infinity,
            bestToken: null
        };

        for (const t of tokens) {
            stats.total++;
            const firstMC = t.firstAlertMarketCap;
            const launchTime = t.firstAlertSentAt;

            // Find the highest "high" in candles after the first alert
            const peakCandle = await Candle.findOne({
                tokenAddress: t.address,
                timestamp: { $gte: launchTime }
            }).sort({ high: -1 });

            let peakMC = firstMC;
            if (peakCandle) {
                peakMC = peakCandle.high * PUMP_FUN_SUPPLY;
            } else {
                // Fallback: if no candles after alert (rare, maybe immediate crash or gap), use lastAlertMC
                peakMC = Math.max(firstMC, t.lastAlertMarketCap || 0);
            }

            const gain = ((peakMC - firstMC) / firstMC) * 100;

            if (gain > 0) {
                if (gain >= 50) stats.gain50++;
                if (gain >= 100) stats.gain100++;
                if (gain >= 200) stats.gain200++;
                if (gain >= 500) stats.gain500++;

                if (gain > stats.maxGain) {
                    stats.maxGain = gain;
                    stats.bestToken = { ...t, peakMC };
                }
            }

            console.log(`Token: ${t.symbol || t.address.slice(0, 8)} | Initial: $${(firstMC / 1000).toFixed(1)}k | Peak: $${(peakMC / 1000).toFixed(1)}k | Gain: ${gain.toFixed(1)}%`);
        }

        console.log('---------------------------------------------------');
        console.log('📊 Peak Performance Summary (Max gain after alert):');
        console.log(`Total Tokens: ${stats.total}`);
        console.log(`> 50% Gain:   ${stats.gain50} (${(stats.gain50 / stats.total * 100).toFixed(1)}%)`);
        console.log(`> 100% Gain:  ${stats.gain100} (${(stats.gain100 / stats.total * 100).toFixed(1)}%)`);
        if (stats.gain200 > 0) console.log(`> 200% Gain:  ${stats.gain200} (${(stats.gain200 / stats.total * 100).toFixed(1)}%)`);
        if (stats.gain500 > 0) console.log(`> 500% Gain:  ${stats.gain500} (${(stats.gain500 / stats.total * 100).toFixed(1)}%)`);

        if (stats.bestToken) {
            console.log(`\n🚀 Best Performer: ${stats.bestToken.symbol} did +${stats.maxGain.toFixed(0)}%`);
        }

        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
};

run();
