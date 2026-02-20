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

        const tokens = await Token.find().lean();
        console.log(`Analyzing ${tokens.length} tokens...`);

        // 1. Get initial price/MC for each token
        // Strategy: 
        // - If alert history exists, use firstAlertMarketCap.
        // - If not, find the earliest candle in DB.
        // - If no candles (rare/dead), skip or mark as no data.

        const tasks = tokens.map(async (t) => {
            let initialMC = t.firstAlertMarketCap;

            if (!initialMC) {
                const firstCandle = await Candle.findOne({ tokenAddress: t.address }).sort({ timestamp: 1 });
                if (firstCandle) {
                    initialMC = firstCandle.open * PUMP_FUN_SUPPLY;
                }
            }
            return { ...t, initialMC };
        });

        const tokensWithInitial = await Promise.all(tasks);
        const validTokens = tokensWithInitial.filter(t => t.initialMC);

        if (validTokens.length === 0) {
            console.log('No tokens with pricing data found.');
            process.exit(0);
        }

        console.log(`Found initial data for ${validTokens.length} tokens.`);

        // 2. Fetch current prices from Jupiter v3 for ALL valid tokens
        // Batch in 100s
        const mints = validTokens.map(t => t.address);
        const currentPrices = new Map();

        for (let i = 0; i < mints.length; i += 100) {
            const batch = mints.slice(i, i + 100);
            const ids = batch.join(',');
            try {
                const config = {};
                if (process.env.JUPITER_API_KEY) {
                    config.headers = { 'x-api-key': process.env.JUPITER_API_KEY };
                }
                const resp = await axios.get(`${JUP_API_URL}?ids=${ids}`, config);
                const data = resp.data;
                if (data) {
                    for (const mint of batch) {
                        if (data[mint] && data[mint].usdPrice) {
                            currentPrices.set(mint, parseFloat(data[mint].usdPrice));
                        }
                    }
                }
            } catch (err) {
                console.error(`Error fetching prices for batch ${i}:`, err.message);
            }
        }

        // 3. Calculate Performance
        let stats = {
            total: 0,
            winners: 0,
            losers: 0,
            dead: 0, // >-90%
            mooners: 0, // >100%
            totalGainPct: 0
        };

        console.log('\n---------------------------------------------------');
        console.log('TOKEN PERFORMANCE (Current Price vs Initial)');
        console.log('---------------------------------------------------');

        const results = [];

        for (const t of validTokens) {
            const currentPrice = currentPrices.get(t.address);
            if (!currentPrice) {
                // console.log(`No current price for ${t.symbol || t.address}`);
                continue;
            }

            const currentMC = currentPrice * PUMP_FUN_SUPPLY;
            const gain = ((currentMC - t.initialMC) / t.initialMC) * 100;

            stats.total++;
            stats.totalGainPct += gain;

            if (gain > 0) stats.winners++;
            else stats.losers++;

            if (gain <= -90) stats.dead++;
            if (gain >= 100) stats.mooners++;

            results.push({
                symbol: t.symbol || t.address.slice(0, 8),
                initial: t.initialMC,
                current: currentMC,
                gain: gain,
                isActive: t.isActive
            });
        }

        // Sort by gain descending
        results.sort((a, b) => b.gain - a.gain);

        // Print Top 5 and Bottom 5
        console.log('TOP 5 PERFORMERS:');
        results.slice(0, 5).forEach(r => {
            console.log(`${r.symbol.padEnd(8)} | Initial: $${(r.initial / 1000).toFixed(1)}k | Current: $${(r.current / 1000).toFixed(1)}k | Gain: ${r.gain > 0 ? '+' : ''}${r.gain.toFixed(1)}% ${r.isActive ? '' : '(Inactive)'}`);
        });

        console.log('\nBOTTOM 5 PERFORMERS:');
        results.slice(-5).reverse().forEach(r => {
            console.log(`${r.symbol.padEnd(8)} | Initial: $${(r.initial / 1000).toFixed(1)}k | Current: $${(r.current / 1000).toFixed(1)}k | Gain: ${r.gain.toFixed(1)}% ${r.isActive ? '' : '(Inactive)'}`);
        });

        console.log('\n---------------------------------------------------');
        console.log('📊 AGGREGATE STATS (Current Snapshot)');
        console.log(`Total Tokens Analyzed: ${stats.total}`);
        console.log(`✅ Winners (>0%):      ${stats.winners} (${(stats.winners / stats.total * 100).toFixed(1)}%)`);
        console.log(`❌ Losers (<0%):       ${stats.losers} (${(stats.losers / stats.total * 100).toFixed(1)}%)`);
        console.log(`💀 Rugged/Dead (<-90%):${stats.dead} (${(stats.dead / stats.total * 100).toFixed(1)}%)`);
        console.log(`🚀 Mooners (>100%):    ${stats.mooners} (${(stats.mooners / stats.total * 100).toFixed(1)}%)`);
        console.log(`📈 Average ROI:        ${(stats.totalGainPct / stats.total).toFixed(1)}%`);


        process.exit(0);

    } catch (e) {
        console.error(e);
        process.exit(1);
    }
};

run();
