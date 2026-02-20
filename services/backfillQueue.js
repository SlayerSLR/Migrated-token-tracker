/**
 * backfillQueue.js
 *
 * Priority backfill queue — ensures every tracked token gets OHLCV history
 * from GeckoTerminal even if the initial discovery run was rate-limited.
 *
 * Design:
 *   - On token discovery failure (429 or no pool), token is enqueued with status=pending
 *   - The drainer runs after every discovery cycle and after startup
 *   - It processes pending items one at a time (single-threaded), respecting
 *     gecko.js's built-in throttle (2.5s/req, 24 req/min max)
 *   - Items with the fewest attempts are processed first (priority)
 *   - After MAX_ATTEMPTS failures, status is set to 'failed' (no more retries)
 *   - On success: Token document updated with poolAddress, candles persisted, CandleManager + Jupiter registered
 */

'use strict';

const BackfillQueue = require('../models/BackfillQueue');
const Token = require('../models/Token');
const { resolvePoolAddress, getBackfillData } = require('./gecko');
const { backfillCandles, getRecentCandles, getLatestCandleTime } = require('./storage');

const MAX_ATTEMPTS = 5;   // give up after this many failures per token
const RETRY_AFTER_MS = 2 * 60 * 1000; // wait at least 2 min between retries

// Injected by index.js after startup so queue can register tokens for live tracking
let _candleManager = null;
let _trackToken = null;

const init = (candleManager, trackTokenFn) => {
    _candleManager = candleManager;
    _trackToken = trackTokenFn;
};

// ── Enqueue ───────────────────────────────────────────────────────────────────

/**
 * Add a token to the backfill queue (upsert — safe to call multiple times).
 * If already in queue (any status), does not reset it.
 */
const enqueue = async (token) => {
    try {
        await BackfillQueue.updateOne(
            { address: token.address },
            {
                $setOnInsert: {
                    address: token.address,
                    symbol: token.symbol || '',
                    name: token.name || '',
                    poolAddress: token.poolAddress || null,
                    status: 'pending',
                    attempts: 0,
                    enqueuedAt: new Date(),
                }
            },
            { upsert: true }
        );
        console.log(`[BackfillQ] Queued ${token.symbol || token.address} for backfill`);
    } catch (err) {
        if (err.code !== 11000) {
            console.error('[BackfillQ] Enqueue error:', err.message);
        }
    }
};

// ── Remove ────────────────────────────────────────────────────────────────────

/**
 * Remove a token from the backfill queue entirely.
 * Safe to call even if the token is not in the queue.
 */
const remove = async (address) => {
    try {
        await BackfillQueue.deleteOne({ address });
    } catch (err) {
        console.error('[BackfillQ] Remove error:', err.message);
    }
};

// ── Check ─────────────────────────────────────────────────────────────────────

/**
 * Returns a summary: { total, pending, done, failed, unbackfilled }
 * where unbackfilled = tracked tokens with 0 candles in the DB.
 */
const queueStatus = async () => {
    const [total, pending, done, failed] = await Promise.all([
        BackfillQueue.countDocuments(),
        BackfillQueue.countDocuments({ status: 'pending' }),
        BackfillQueue.countDocuments({ status: 'done' }),
        BackfillQueue.countDocuments({ status: 'failed' }),
    ]);
    return { total, pending, done, failed };
};

// ── Drainer ───────────────────────────────────────────────────────────────────

let _draining = false;

/**
 * Process up to `batchSize` pending backfill items.
 * Runs sequentially — gecko.js throttle handles rate limiting.
 * Called after each discovery cycle and on startup.
 */
const drain = async (batchSize = 5) => {
    if (_draining) {
        console.log('[BackfillQ] Drain already in progress, skipping.');
        return;
    }
    _draining = true;

    try {
        const retryBefore = new Date(Date.now() - RETRY_AFTER_MS);
        const items = await BackfillQueue.find({
            status: 'pending',
            $or: [
                { lastAttempt: null },
                { lastAttempt: { $lt: retryBefore } },
            ]
        })
            .sort({ attempts: 1, enqueuedAt: 1 }) // lowest attempts first = priority
            .limit(batchSize)
            .lean();

        if (items.length === 0) {
            console.log('[BackfillQ] No pending items to drain.');
            _draining = false;
            return;
        }

        console.log(`[BackfillQ] Draining ${items.length} item(s)...`);

        for (const item of items) {
            await processItem(item);
        }

        const status = await queueStatus();
        console.log(`[BackfillQ] Drain complete. Pending: ${status.pending} | Done: ${status.done} | Failed: ${status.failed}`);

    } catch (err) {
        console.error('[BackfillQ] Drain error:', err.message);
    } finally {
        _draining = false;
    }
};

/**
 * Process a single queue item end-to-end:
 * 1. Resolve pool (if not already resolved)
 * 2. Fetch OHLCV candles
 * 3. Persist candles
 * 4. Update Token.poolAddress if needed
 * 5. Register with CandleManager + Jupiter (if not already tracked)
 * 6. Mark done / failed
 */
const processItem = async (item) => {
    const tick = `${item.symbol || item.address.slice(0, 8)}`;
    console.log(`[BackfillQ] Processing ${tick} (attempt ${item.attempts + 1}/${MAX_ATTEMPTS})`);

    await BackfillQueue.updateOne({ address: item.address }, {
        $set: { lastAttempt: new Date() },
        $inc: { attempts: 1 },
    });

    try {
        // ── Step 1: Resolve pool ─────────────────────────────────────────────
        let pool = item.poolAddress;

        if (!pool) {
            pool = await resolvePoolAddress(item.address);
            if (!pool) {
                console.log(`[BackfillQ] ${tick} — pool not found yet (will retry)`);
                await maybeMarkFailed(item);
                return;
            }
            // Cache pool in the queue record
            await BackfillQueue.updateOne({ address: item.address }, { $set: { poolAddress: pool } });
            // Also update the Token record if it exists
            await Token.updateOne({ address: item.address }, { $set: { poolAddress: pool } });
        }

        console.log(`[BackfillQ] ${tick} pool: ${pool.slice(0, 12)}...`);

        // ── Step 2: Fetch OHLCV ──────────────────────────────────────────────
        const candles = await getBackfillData(pool, 300);
        if (candles.length === 0) {
            console.log(`[BackfillQ] ${tick} — no candles returned (will retry)`);
            await maybeMarkFailed(item);
            return;
        }

        // ── Step 3: Persist candles ──────────────────────────────────────────
        await backfillCandles(item.address, pool, candles);

        // ── Step 4: Register for live tracking (if not already) ───────────────
        if (_candleManager && !_candleManager.tracked.has(item.address)) {
            // Fetch launchedAt from Token so Age line appears in alerts
            const tokenDoc = await Token.findOne(
                { address: item.address },
                { launchedAt: 1 }
            ).lean();
            _candleManager.addToken(item.address, {
                symbol: item.symbol,
                name: item.name,
                poolAddress: pool,
                launchedAt: tokenDoc?.launchedAt || null
            });
            if (_trackToken) _trackToken(item.address);
        }

        // ── Step 5: Mark done ────────────────────────────────────────────────
        await BackfillQueue.updateOne({ address: item.address }, {
            $set: { status: 'done', completedAt: new Date(), error: null }
        });
        console.log(`[BackfillQ] ✅ ${tick} — backfilled ${candles.length} candles`);

    } catch (err) {
        console.error(`[BackfillQ] Error processing ${tick}:`, err.message);
        await maybeMarkFailed(item);
    }
};

/**
 * If this item has hit MAX_ATTEMPTS, mark it failed.
 * Otherwise leave it as pending so the next drain cycle retries it.
 */
const maybeMarkFailed = async (item) => {
    const currentAttempts = item.attempts + 1; // +1 because we just incremented
    if (currentAttempts >= MAX_ATTEMPTS) {
        await BackfillQueue.updateOne({ address: item.address }, {
            $set: { status: 'failed', error: `Exhausted ${MAX_ATTEMPTS} attempts` }
        });
        console.warn(`[BackfillQ] ❌ ${item.symbol || item.address} failed after ${MAX_ATTEMPTS} attempts`);
    }
    // else: stays 'pending' for the next drain cycle
};

// ── Audit: find tracked tokens with 0 candles ─────────────────────────────────

/**
 * Scans the Token collection for any token with 0 backfilled candles
 * and re-enqueues them with priority (attempts=0).
 * Called on startup after DB connect.
 */
const auditAndEnqueueMissing = async () => {
    const Candle = require('../models/Candle');
    const allTokens = await Token.find().lean();
    let missing = 0;

    for (const token of allTokens) {
        const count = await Candle.countDocuments({ tokenAddress: token.address });
        if (count === 0) {
            missing++;
            await enqueue({
                address: token.address,
                symbol: token.symbol,
                name: token.name,
                poolAddress: token.poolAddress  // may already be resolved
            });
        }
    }

    if (missing > 0) {
        console.log(`[BackfillQ] Audit: found ${missing} token(s) with 0 candles — queued for backfill`);
    } else {
        console.log(`[BackfillQ] Audit: all ${allTokens.length} token(s) have candle data ✅`);
    }
};

// ── Gap Fill on Startup ───────────────────────────────────────────────────────

const GAP_THRESHOLD_MS = 60 * 1000; // 1 minute — gap smaller than this is fine

/**
 * On restart, check if any tracked token has a candle gap since the last run.
 * If the latest candle is older than GAP_THRESHOLD_MS, re-backfill from Gecko.
 * insertMany uses ordered:false so existing candles are silently skipped.
 */
const gapFillOnStartup = async () => {
    const tokens = await Token.find({ isActive: true, poolAddress: { $ne: null } }).lean();
    if (tokens.length === 0) return;

    const now = Date.now();
    let filled = 0;

    console.log(`[BackfillQ] Gap-fill scan: checking ${tokens.length} token(s)...`);

    for (const token of tokens) {
        const latest = await getLatestCandleTime(token.address);
        // If no candles exist at all, auditAndEnqueueMissing already handles this
        if (!latest) continue;

        const gapMs = now - new Date(latest).getTime();
        if (gapMs < GAP_THRESHOLD_MS) continue;

        const gapMin = Math.round(gapMs / 60000);
        console.log(`[BackfillQ] Gap detected for ${token.symbol || token.address.slice(0, 8)}: ${gapMin}m gap. Re-backfilling...`);

        try {
            const candles = await getBackfillData(token.poolAddress, 300);
            if (candles.length > 0) {
                await backfillCandles(token.address, token.poolAddress, candles);
                filled++;
            }
        } catch (err) {
            console.error(`[BackfillQ] Gap-fill error for ${token.symbol}:`, err.message);
        }
    }

    if (filled > 0) {
        console.log(`[BackfillQ] Gap-fill complete: ${filled} token(s) re-backfilled.`);
    } else {
        console.log('[BackfillQ] Gap-fill: no gaps detected.');
    }
};

module.exports = { init, enqueue, remove, drain, queueStatus, auditAndEnqueueMissing, gapFillOnStartup };
