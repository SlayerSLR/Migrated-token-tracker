const candleManager = require('./candleManager');
const Candle = require('../models/Candle');
const Token = require('../models/Token');

const PUMP_FUN_SUPPLY = 1_000_000_000;

const generateHourlyReport = async () => {
    try {
        const tokens = await Token.find({ isActive: true }).lean();
        if (tokens.length === 0) return null;

        // 6 hours ago
        const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);

        let candidates = [];

        // Analysis Loop (Local only)
        for (const t of tokens) {
            // 1. Current Price (Cached from Jupiter polling)
            const currentPrice = candleManager.getLastPrice(t.address);
            if (!currentPrice) continue;

            // 2. Past Price (DB)
            // Get earliest candle >= 6h ago
            const pastCandle = await Candle.findOne({
                tokenAddress: t.address,
                timestamp: { $gte: sixHoursAgo }
            }).sort({ timestamp: 1 });

            if (!pastCandle) continue;

            const pastPrice = pastCandle.open;
            const gain = ((currentPrice - pastPrice) / pastPrice) * 100;
            const currentMC = currentPrice * PUMP_FUN_SUPPLY;

            if (gain > 0) {
                candidates.push({
                    symbol: t.symbol || '?',
                    address: t.address,
                    poolAddress: t.poolAddress,
                    gain,
                    currentMC,
                    firstAlertMC: t.firstAlertMarketCap
                });
            }
        }

        if (candidates.length === 0) return null;

        // Top 5 Gainers
        candidates.sort((a, b) => b.gain - a.gain);
        const top5 = candidates.slice(0, 5);

        let msg = `📊 *Hourly Top Gainers (Last 6h)*\n──────────────────\n`;

        top5.forEach((item, index) => {
            const rank = index + 1;
            const gainStr = `+${item.gain.toFixed(1)}%`;
            const mcStr = `$${(item.currentMC / 1000).toFixed(0)}K`;

            let extra = ``;
            if (item.firstAlertMC) {
                // If entry MC exists, show it
                extra = `\n   Entry: $${(item.firstAlertMC / 1000).toFixed(0)}K`;
            }

            // Links
            // Axiom link format: https://axiom.trade/meme/<mint>
            // DexScreener: https://dexscreener.com/solana/<mint>

            const links = `[Axiom](https://axiom.trade/meme/${item.address}) · [DexS](https://dexscreener.com/solana/${item.address})`;

            msg += `${rank}. *${item.symbol}* (${gainStr}) — ${mcStr}${extra}\n   🔗 ${links}\n\n`;
        });

        return msg;

    } catch (err) {
        console.error('[Reports] Error:', err.message);
        return null;
    }
};

const getTopCoins = async (limit = 10) => {
    try {
        const tokens = await Token.find({ isActive: true, firstAlertMarketCap: { $exists: true, $ne: null } }).lean();
        if (tokens.length === 0) return 'No active tokens with alerts found.';

        let candidates = [];

        for (const t of tokens) {
            const currentPrice = candleManager.getLastPrice(t.address);
            if (!currentPrice) continue;

            const currentMC = currentPrice * PUMP_FUN_SUPPLY;
            const entryMC = t.firstAlertMarketCap;
            const gain = ((currentMC - entryMC) / entryMC) * 100;

            candidates.push({
                symbol: t.symbol || '?',
                address: t.address,
                poolAddress: t.poolAddress,
                gain,
                currentMC,
                entryMC
            });
        }

        if (candidates.length === 0) return 'Not enough price data to compute top coins.';

        // Sort by gain descending
        candidates.sort((a, b) => b.gain - a.gain);
        const topCoins = candidates.slice(0, limit);

        let msg = `🏆 *Top Active Performers*\n──────────────────\n`;

        topCoins.forEach((item, index) => {
            const rank = index + 1;
            const gainStr = item.gain >= 0 ? `+${item.gain.toFixed(1)}%` : `${item.gain.toFixed(1)}%`;
            const emcStr = `$${(item.entryMC / 1000).toFixed(0)}K`;
            const cmcStr = `$${(item.currentMC / 1000).toFixed(0)}K`;

            const links = `[Jupiter](https://jup.ag/tokens/${item.address}) · [DexS](https://dexscreener.com/solana/${item.address})`;

            msg += `${rank}. *${item.symbol}* (${gainStr})\n   Entry: ${emcStr} ➡️ Curr: ${cmcStr}\n   🔗 ${links}\n\n`;
        });

        return msg.trim();

    } catch (err) {
        console.error('[Reports] Error generating top coins:', err.message);
        return 'Error generating top coins report.';
    }
};

module.exports = { generateHourlyReport, getTopCoins };
