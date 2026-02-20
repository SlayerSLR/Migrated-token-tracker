require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const connectDB = require('../config/db');
const Token = require('../models/Token');
const Candle = require('../models/Candle');

const PUMP_FUN_SUPPLY = 1_000_000_000;

async function run() {
    await connectDB();

    // Get active tokens
    const activeTokens = await Token.find({ isActive: true }).lean();
    console.log(`Found ${activeTokens.length} active tokens.\n`);

    if (activeTokens.length === 0) process.exit(0);

    console.log('Fetching price data from internal database...\n');

    // Object to hold our calculated data
    const tokenData = [];

    for (const token of activeTokens) {
        const addr = token.address;
        const sym = token.symbol || addr.slice(0, 10);

        // Find the latest candle for current price
        const latestCandle = await Candle.findOne({ tokenAddress: addr })
            .sort({ timestamp: -1 })
            .lean();

        let currentMc = 0;
        let currentMcStr = 'N/A';
        if (latestCandle && latestCandle.close) {
            currentMc = latestCandle.close * PUMP_FUN_SUPPLY;
            currentMcStr = `$${currentMc.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
        }

        // Find the peak MT since it was added to tracking
        // We find the candle with maximum high price where timestamp >= token.addedAt
        const peakCandle = await Candle.findOne({
            tokenAddress: addr,
            timestamp: { $gte: token.addedAt }
        }).sort({ high: -1 }).lean();

        let peakMc = 0;
        let peakMcStr = 'N/A';
        if (peakCandle && peakCandle.high) {
            peakMc = peakCandle.high * PUMP_FUN_SUPPLY;
            peakMcStr = `$${peakMc.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
        }

        // Alert sent status
        const alertSentBool = !!token.firstAlertSentAt;
        const alertSentStr = alertSentBool ? 'Yes' : 'No';

        tokenData.push({
            sym,
            addr,
            currentMc,
            currentMcStr,
            peakMc,
            peakMcStr,
            alertSentBool,
            alertSentStr
        });
    }

    // Output header
    console.log(
        "SYMBOL".padEnd(15),
        "CURRENT MC".padEnd(15),
        "PEAK MC (POST-ADD)".padEnd(20),
        "ALERT SENT?".padEnd(12),
        "ADDRESS"
    );
    console.log("-".repeat(110));

    // Sort active tokens by alert status (Yes first) then by current MC (descending)
    tokenData.sort((a, b) => {
        if (a.alertSentBool !== b.alertSentBool) {
            return b.alertSentBool ? 1 : -1;
        }
        return b.currentMc - a.currentMc;
    });

    for (const data of tokenData) {
        console.log(
            data.sym.padEnd(15),
            data.currentMcStr.padEnd(15),
            data.peakMcStr.padEnd(20),
            data.alertSentStr.padEnd(12),
            data.addr
        );
    }

    process.exit(0);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
