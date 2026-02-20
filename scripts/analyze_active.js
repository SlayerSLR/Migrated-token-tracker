require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');
const Token = require('../models/Token');
const Candle = require('../models/Candle');

const JUP_API_URL = 'https://api.jup.ag/price/v3';
const PUMP_FUN_SUPPLY = 1_000_000_000;

const run = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Connected to DB');

        const tokens = await Token.find({ isActive: true }).lean();
        console.log(`Analyzing ${tokens.length} active tokens...`);

        // 1. Resolve Initial Data (Alert vs Candle fallback)
        const enrichedTokens = await Promise.all(tokens.map(async (t) => {
            let initialMC = t.firstAlertMarketCap;
            let startTime = t.firstAlertSentAt;
            let source = 'alert';

            if (!initialMC) {
                const firstCandle = await Candle.findOne({ tokenAddress: t.address }).sort({ timestamp: 1 });
                if (firstCandle) {
                    initialMC = firstCandle.open * PUMP_FUN_SUPPLY;
                    startTime = firstCandle.timestamp;
                    source = 'candle';
                }
            }

            return {
                ...t,
                initialMC,
                startTime,
                initialSource: source
            };
        }));

        const validTokens = enrichedTokens.filter(t => t.initialMC);
        console.log(`Found base data for ${validTokens.length} tokens.`);

        // 2. Fetch Current Prices (Jupiter)
        const mints = validTokens.map(t => t.address);
        const currentPrices = new Map();

        for (let i = 0; i < mints.length; i += 100) {
            const batch = mints.slice(i, i + 100);
            try {
                const config = {};
                if (process.env.JUPITER_API_KEY) {
                    config.headers = { 'x-api-key': process.env.JUPITER_API_KEY };
                }
                const ids = batch.join(',');
                const resp = await axios.get(`${JUP_API_URL}?ids=${ids}`, config);
                if (resp.data) {
                    batch.forEach(mint => {
                        if (resp.data[mint]?.usdPrice) {
                            currentPrices.set(mint, parseFloat(resp.data[mint].usdPrice));
                        }
                    });
                }
            } catch (err) {
                console.error(`Batch error: ${err.message}`);
            }
        }

        // 3. Analyze Peak & Current Performance
        const results = [];
        let stats = {
            total: 0,
            winners: 0,
            mooners: 0, // >100% cur
            peakMooners: 0, // >100% peak
            rugged: 0, // <-90%
            totalCurrentGain: 0,
            totalPeakGain: 0
        };

        for (const t of validTokens) {
            // A. Current Performance
            const currentPrice = currentPrices.get(t.address);
            let currentMC = 0;
            let currentGain = 0;

            if (currentPrice) {
                currentMC = currentPrice * PUMP_FUN_SUPPLY;
                currentGain = ((currentMC - t.initialMC) / t.initialMC) * 100;
            } else {
                // If no price, assume dead/inactive if old
                // But let's verify if we have candles
                const lastCandle = await Candle.findOne({ tokenAddress: t.address }).sort({ timestamp: -1 });
                if (lastCandle) {
                    currentMC = lastCandle.close * PUMP_FUN_SUPPLY;
                    currentGain = ((currentMC - t.initialMC) / t.initialMC) * 100;
                }
            }

            // B. Peak Performance
            let peakMC = t.initialMC;
            if (t.startTime) {
                const peakCandle = await Candle.findOne({
                    tokenAddress: t.address,
                    timestamp: { $gte: t.startTime }
                }).sort({ high: -1 });

                if (peakCandle) {
                    const candleHighMc = peakCandle.high * PUMP_FUN_SUPPLY;
                    if (candleHighMc > peakMC) peakMC = candleHighMc;
                }
            }
            // Also check latest alert if it was higher
            if (t.lastAlertMarketCap && t.lastAlertMarketCap > peakMC) {
                peakMC = t.lastAlertMarketCap;
            }

            const peakGain = ((peakMC - t.initialMC) / t.initialMC) * 100;

            // Stats
            stats.total++;
            if (currentGain > 0) stats.winners++;
            if (currentGain > 100) stats.mooners++;
            if (peakGain > 100) stats.peakMooners++;
            if (currentGain < -90) stats.rugged++;
            stats.totalCurrentGain += isNaN(currentGain) ? 0 : currentGain;
            stats.totalPeakGain += isNaN(peakGain) ? 0 : peakGain;

            results.push({
                symbol: t.symbol || t.address.slice(0, 8),
                initialMC: t.initialMC,
                currentMC,
                peakMC,
                currentGain,
                peakGain,
                source: t.initialSource
            });
        }

        // Sort by CURRENT gain
        results.sort((a, b) => b.currentGain - a.currentGain);

        console.log('\n---------------------------------------------------');
        console.log('🏆 TOP PERFORMERS (Current Gain)');
        console.log('---------------------------------------------------');
        results.slice(0, 10).forEach(r => {
            console.log(`${r.symbol.padEnd(8)} | Init: $${(r.initialMC / 1000).toFixed(1)}k (${r.source}) | Curr: $${(r.currentMC / 1000).toFixed(1)}k (${r.currentGain.toFixed(0)}%) | Peak: $${(r.peakMC / 1000).toFixed(1)}k (${r.peakGain.toFixed(0)}%)`);
        });

        console.log('\n---------------------------------------------------');
        console.log('📉 WORST PERFORMERS');
        console.log('---------------------------------------------------');
        results.slice(-5).reverse().forEach(r => {
            console.log(`${r.symbol.padEnd(8)} | Init: $${(r.initialMC / 1000).toFixed(1)}k | Curr: $${(r.currentMC / 1000).toFixed(1)}k (${r.currentGain.toFixed(0)}%)`);
        });

        console.log('\n---------------------------------------------------');
        console.log('📊 COMPREHENSIVE SUMMARY');
        console.log(`Total Scanned:    ${stats.total}`);
        console.log(`Profitable Now:   ${stats.winners} (${(stats.winners / stats.total * 100).toFixed(1)}%)`);
        console.log(`> 100% Now:       ${stats.mooners} (${(stats.mooners / stats.total * 100).toFixed(1)}%)`);
        console.log(`> 100% at Peak:   ${stats.peakMooners} (${(stats.peakMooners / stats.total * 100).toFixed(1)}%)`);
        console.log(`Rugged (<-90%):   ${stats.rugged} (${(stats.rugged / stats.total * 100).toFixed(1)}%)`);
        console.log(`Avg Current Rtn:  ${(stats.totalCurrentGain / (stats.total || 1)).toFixed(2)}%`);
        console.log(`Avg Peak Rtn:     ${(stats.totalPeakGain / (stats.total || 1)).toFixed(2)}%`);

        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
};

run();
