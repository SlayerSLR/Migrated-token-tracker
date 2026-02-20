require('dotenv').config();
const mongoose = require('mongoose');
const Token = require('../models/Token');
const Candle = require('../models/Candle');

const PUMP_FUN_SUPPLY = 1_000_000_000;

const run = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Connected to DB');

        // 1. Fetch tokens WITH first alert data
        const tokens = await Token.find({
            firstAlertMarketCap: { $exists: true, $ne: null },
            firstAlertSentAt: { $exists: true, $ne: null }
        }).lean();

        console.log(`Scanning ${tokens.length} tokens with valid alert history...`);

        const mooners = [];
        let totalFirstMC = 0;
        let totalTimeFromLaunchToAlert = 0;
        let countWithLaunchData = 0;

        for (const t of tokens) {
            const firstMC = t.firstAlertMarketCap;
            const alertTime = t.firstAlertSentAt;

            // Determine Peak Gain
            let peakMC = firstMC;

            // Check candles after alert
            const peakCandle = await Candle.findOne({
                tokenAddress: t.address,
                timestamp: { $gte: alertTime }
            }).sort({ high: -1 });

            if (peakCandle) {
                const candleHigh = peakCandle.high * PUMP_FUN_SUPPLY;
                if (candleHigh > peakMC) peakMC = candleHigh;
            }

            // Also check lastAlert if higher (in case candle gap)
            if (t.lastAlertMarketCap && t.lastAlertMarketCap > peakMC) {
                peakMC = t.lastAlertMarketCap;
            }

            const gain = ((peakMC - firstMC) / firstMC) * 100;

            if (gain > 100) {
                // Calculate time from launch to first alert (if launch data exists)
                let timeToAlertMins = null;
                if (t.launchedAt) {
                    const diffMs = new Date(alertTime).getTime() - new Date(t.launchedAt).getTime();
                    timeToAlertMins = diffMs / 60000;
                }

                mooners.push({
                    symbol: t.symbol || t.address.slice(0, 8),
                    firstMC,
                    peakMC,
                    gain,
                    timeToAlertMins
                });
            }
        }

        console.log(`\nFound ${mooners.length} tokens with >100% gain (from first alert).`);

        if (mooners.length === 0) {
            console.log('No mooners found with current criteria.');
            process.exit(0);
        }

        // Stats Calculation
        let sumMC = 0;
        let sumTime = 0;
        let timeCount = 0;

        mooners.forEach(m => {
            sumMC += m.firstMC;
            if (m.timeToAlertMins !== null) {
                sumTime += m.timeToAlertMins;
                timeCount++;
            }
        });

        const avgMC = sumMC / mooners.length;
        const avgTime = timeCount > 0 ? sumTime / timeCount : 0;

        console.log('\n---------------------------------------------------');
        console.log('🌕 MOONER STATISTICS (>100% Peak Gain)');
        console.log('---------------------------------------------------');
        console.log(`Count:                  ${mooners.length}`);
        console.log(`Avg First Alert MC:     $${(avgMC / 1000).toFixed(1)}k`);
        if (timeCount > 0) {
            console.log(`Avg Time Launch→Alert:  ${avgTime.toFixed(1)} mins`);
        }
        console.log('---------------------------------------------------');

        // Sort by gain
        mooners.sort((a, b) => b.gain - a.gain);

        console.log('\nTop 5 Mooners:');
        mooners.slice(0, 5).forEach(m => {
            console.log(`${m.symbol.padEnd(8)} | Alert MC: $${(m.firstMC / 1000).toFixed(1)}k | Peak: $${(m.peakMC / 1000).toFixed(1)}k | Gain: +${m.gain.toFixed(0)}% | Alerted ${m.timeToAlertMins ? m.timeToAlertMins.toFixed(0) + 'm' : '?'} after launch`);
        });

        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
};

run();
