require('dotenv').config();
const mongoose = require('mongoose');
const Token = require('../models/Token');
const Candle = require('../models/Candle');

const PUMP_FUN_SUPPLY = 1_000_000_000;
const TOP_SYMBOLS = ['TOTO', 'GROKIUS', 'ANDREW'];

const run = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Connected to DB');

        const tokens = await Token.find({ symbol: { $in: TOP_SYMBOLS } }).lean();

        for (const t of tokens) {
            console.log(`\n---------------------------------------------------`);
            console.log(`Checking ${t.symbol} (${t.address})`);
            console.log(`Token Data:`);
            console.log(`  - firstAlertMarketCap: $${t.firstAlertMarketCap ? (t.firstAlertMarketCap).toFixed(2) : 'N/A'}`);
            console.log(`  - firstAlertSentAt:    ${t.firstAlertSentAt ? new Date(t.firstAlertSentAt).toISOString() : 'N/A'}`);
            console.log(`  - launchedAt:          ${t.launchedAt ? new Date(t.launchedAt).toISOString() : 'N/A'}`);

            // Find the VERY FIRST candle ever recorded for this token
            const firstCandle = await Candle.findOne({ tokenAddress: t.address }).sort({ timestamp: 1 });

            if (firstCandle) {
                const candleMC = firstCandle.open * PUMP_FUN_SUPPLY;
                console.log(`Earliest Candle Data:`);
                console.log(`  - Timestamp: ${new Date(firstCandle.timestamp).toISOString()}`);
                console.log(`  - Open Price: ${firstCandle.open}`);
                console.log(`  - Calculated Initial MC: $${candleMC.toFixed(2)}`);

                if (t.firstAlertMarketCap) {
                    const diff = Math.abs(t.firstAlertMarketCap - candleMC);
                    const pctDiff = (diff / candleMC) * 100;
                    console.log(`  -> Difference: ${pctDiff.toFixed(2)}%`);
                }
            } else {
                console.log(`  -> No candles found in DB.`);
            }
        }

        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
};

run();
