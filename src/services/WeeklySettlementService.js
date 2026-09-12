const cron = require('node-cron');
const db = require('../config/db');
const MarginService = require('./MarginService');

/**
 * Server runs in IST (TZ=Asia/Kolkata), so helper formats clean dates
 */
function getISTDate(date = new Date()) {
    const d = new Date(date);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Calculate weekly boundaries (Monday 00:00:00 to Sunday 23:59:59)
 */
function getWeekBoundaries(targetDate = new Date()) {
    const d = new Date(targetDate);
    const day = d.getDay(); // 0 is Sunday, 1 is Monday, ..., 6 is Saturday
    
    // Calculate distance to previous or current Monday
    const diffToMonday = (day === 0 ? -6 : 1 - day);
    
    const monday = new Date(d);
    monday.setDate(d.getDate() + diffToMonday);
    
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    
    const formatDate = (dateObj) => {
        const year = dateObj.getFullYear();
        const month = String(dateObj.getMonth() + 1).padStart(2, '0');
        const date = String(dateObj.getDate()).padStart(2, '0');
        return `${year}-${month}-${date}`;
    };
    
    return {
        week_start: formatDate(monday),
        week_end: formatDate(sunday)
    };
}

/**
 * Process settlement for a single trader within a dedicated transaction
 */
async function processTraderSettlement({ userId, username, weekStart, weekEnd, settledByUserId = null, force = false }) {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Idempotency Check: Don't re-run if already COMPLETED for this week unless force=true
        const [existing] = await connection.execute(
            `SELECT id, settlement_status, unrealized_mtm_pnl FROM weekly_settlements 
             WHERE user_id = ? AND week_start_date = ? AND week_end_date = ?`,
            [userId, weekStart, weekEnd]
        );

        if (!force && existing.length > 0 && existing[0].settlement_status === 'COMPLETED') {
            console.log(`[WeeklySettlement] User #${userId} (${username}) already settled for ${weekStart} to ${weekEnd}. Skipping.`);
            await connection.rollback();
            return {
                userId,
                username,
                status: 'SKIPPED_ALREADY_COMPLETED',
                settlementId: existing[0].id
            };
        }

        // 2. Fetch User & Settings with Row Lock
        const [userRows] = await connection.execute(
            `SELECT id, username, balance FROM users WHERE id = ? FOR UPDATE`,
            [userId]
        );
        if (userRows.length === 0) {
            await connection.rollback();
            return { userId, username, status: 'FAILED_USER_NOT_FOUND' };
        }

        const user = userRows[0];
        let currentBalance = parseFloat(user.balance || 0);

        // ✅ FORCE RE-RUN FIX: If forcing a re-run on an already-completed settlement,
        // reverse the old MTM that was applied to balance, then recalculate fresh.
        if (force && existing.length > 0 && existing[0].settlement_status === 'COMPLETED') {
            const oldMtm = parseFloat(existing[0].unrealized_mtm_pnl || 0);
            if (oldMtm !== 0) {
                currentBalance = currentBalance - oldMtm; // Reverse old MTM adjustment
                console.log(`🔄 [WeeklySettlement] Force re-run for #${userId}: reversing old MTM ₹${oldMtm} from balance. Adjusted base = ₹${currentBalance}`);
            }
            // Reset last_settlement_price for HOLD trades from this week's settlement
            // so MTM recalculates from entry_price (clean baseline)
            await connection.execute(
                `UPDATE trades SET last_settlement_price = NULL, accumulated_settled_pnl = 0
                 WHERE user_id = ? AND status = 'HOLD' AND settlement_id = ?`,
                [userId, existing[0].id]
            );
        }

        // Fetch client settings for margin config
        const [settingRows] = await connection.execute(
            `SELECT config_json FROM client_settings WHERE user_id = ?`,
            [userId]
        );
        let clientConfig = {};
        if (settingRows.length > 0 && settingRows[0].config_json) {
            try { clientConfig = JSON.parse(settingRows[0].config_json); } catch (_) { }
        }

        // 3. Find Opening Balance (from previous week's closing settlement or balance history)
        let openingBalance = currentBalance;
        const [prevSettlement] = await connection.execute(
            `SELECT closing_balance FROM weekly_settlements 
             WHERE user_id = ? AND week_end_date < ? AND settlement_status = 'COMPLETED'
             ORDER BY week_end_date DESC LIMIT 1`,
            [userId, weekStart]
        );

        if (prevSettlement.length > 0) {
            openingBalance = parseFloat(prevSettlement[0].closing_balance);
        } else {
            const [prevWeekly] = await connection.execute(
                `SELECT closing_balance FROM weekly_balances 
                 WHERE user_id = ? AND week_end < ? 
                 ORDER BY week_end DESC LIMIT 1`,
                [userId, weekStart]
            );
            if (prevWeekly.length > 0) {
                openingBalance = parseFloat(prevWeekly[0].closing_balance);
            }
        }

        // 4. Calculate Realized P&L, Brokerage, and Swap for Closed Trades within the week
        const [tradeTotals] = await connection.execute(
            `SELECT 
                IFNULL(SUM(pnl), 0) as realized_pnl,
                IFNULL(SUM(brokerage), 0) as total_brokerage,
                IFNULL(SUM(swap), 0) as total_swap
             FROM trades 
             WHERE user_id = ? 
               AND status = 'CLOSED'
               AND DATE(COALESCE(exit_time, entry_time)) >= ?
               AND DATE(COALESCE(exit_time, entry_time)) <= ?`,
            [userId, weekStart, weekEnd]
        );

        const realizedPnl = parseFloat(tradeTotals[0]?.realized_pnl || 0);
        const brokerage = parseFloat(tradeTotals[0]?.total_brokerage || 0);
        const charges = parseFloat(tradeTotals[0]?.total_swap || 0);
        console.log(`📊 [WeeklySettlement DEBUG] User #${userId} Week ${weekStart}→${weekEnd}: closedTrades realizedPnl=₹${realizedPnl}, brokerage=₹${brokerage}, charges=₹${charges}`);

        // 5. Calculate Deposits & Withdrawals for the week
        const [fundTotals] = await connection.execute(
            `SELECT 
                IFNULL(SUM(CASE WHEN type = 'DEPOSIT' THEN amount ELSE 0 END), 0) as deposits,
                IFNULL(SUM(CASE WHEN type = 'WITHDRAW' THEN amount ELSE 0 END), 0) as withdrawals
             FROM ledger 
             WHERE user_id = ? 
               AND type IN ('DEPOSIT', 'WITHDRAW')
               AND DATE(created_at) >= ?
               AND DATE(created_at) <= ?`,
            [userId, weekStart, weekEnd]
        );

        const totalDeposit = parseFloat(fundTotals[0]?.deposits || 0);
        const totalWithdrawal = parseFloat(fundTotals[0]?.withdrawals || 0);

        // Preliminary closing balance before open trade MTM settlement
        const prelimClosingBalance = openingBalance + (realizedPnl - brokerage - charges) + totalDeposit - totalWithdrawal;

        // 6. Process Open / Holding Trades — Evaluate Holding Margin & Weekly MTM Settlement
        const [openTrades] = await connection.execute(
            `SELECT * FROM trades 
             WHERE user_id = ? AND status IN ('OPEN', 'HOLD') 
             ORDER BY id ASC`,
            [userId]
        );

        let availableHoldingMargin = Math.max(0, prelimClosingBalance);
        let carriedForwardCount = 0;
        let settledTradesCount = 0;
        let totalUnrealizedMtmPnl = 0;
        const carriedForwardItems = [];

        console.log(`🔍 [WeeklySettlement DEBUG] User #${userId}: Found ${openTrades.length} open/hold trade(s). currentBalance=₹${currentBalance}`);

        for (const trade of openTrades) {
            const marketDataService = require('./MarketDataService');
            const cleanSymbol = trade.symbol.includes(':') ? trade.symbol.split(':')[1] : trade.symbol;
            const marketType = (trade.market_type || 'MCX').toUpperCase();
            const prefix = marketType === 'EQUITY' ? 'NSE' : (marketType === 'OPTIONS' ? 'NFO' : marketType);

            let liveData = null;
            try {
                liveData = marketDataService.getPrice(trade.symbol) ||
                    marketDataService.getPrice(`${prefix}:${cleanSymbol}`) ||
                    marketDataService.getPrice(cleanSymbol);
            } catch (_) { }

            let priceSource = 'fallback_entry';
            let settlementPrice = (liveData && liveData.ltp)
                ? (priceSource = 'live_ltp', parseFloat(liveData.ltp))
                : parseFloat(trade.current_price || trade.exit_price || trade.entry_price || 0);

            if (!liveData || !liveData.ltp) {
                try {
                    const [scripRows] = await connection.execute(
                        `SELECT last_price FROM scrip_data WHERE symbol = ? OR symbol = ? LIMIT 1`,
                        [trade.symbol, cleanSymbol]
                    );
                    if (scripRows.length > 0 && parseFloat(scripRows[0].last_price) > 0) {
                        settlementPrice = parseFloat(scripRows[0].last_price);
                        priceSource = 'scrip_data';
                    }
                } catch (_) { }
            }

            const baselinePrice = (trade.last_settlement_price !== null && trade.last_settlement_price !== undefined)
                ? parseFloat(trade.last_settlement_price)
                : parseFloat(trade.entry_price);
            const baselineSource = (trade.last_settlement_price !== null && trade.last_settlement_price !== undefined)
                ? 'last_settlement_price' : 'entry_price';

            let weeklyMtmPnl = 0;
            const commodityLotService = require('./CommodityLotService');
            const { getMcxBaseScrip, MCX_LOT_SIZES } = require('../utils/symbolHelper');
            const isCommodity = commodityLotService.isCommodityScrip(trade.symbol, trade.market_type);

            if (isCommodity) {
                const calc = commodityLotService.calculatePnL(trade.symbol, trade.type, baselinePrice, settlementPrice, trade.qty);
                weeklyMtmPnl = calc.pnlInr;
                console.log(`  📦 [Trade #${trade.id}] COMMODITY ${trade.symbol} | type=${trade.type} qty=${trade.qty} | baseline=${baselinePrice}(${baselineSource}) settlementPrice=${settlementPrice}(${priceSource}) | lotSize=${calc.lotSize} pnlUsd=${calc.pnlUsd.toFixed(4)} usdInr=${calc.usdInr} => MTM_INR=₹${weeklyMtmPnl.toFixed(2)}`);
            } else {
                // ✅ For MCX: use same MCX_LOT_SIZES as TradeService (not lot_size_at_entry)
                let lotSize;
                if (marketType === 'MCX') {
                    const base = getMcxBaseScrip(trade.symbol);
                    lotSize = (base && MCX_LOT_SIZES[base]) ? MCX_LOT_SIZES[base] : parseFloat(trade.lot_size_at_entry || trade.lot_size || 1);
                } else {
                    lotSize = parseFloat(trade.lot_size_at_entry || trade.lot_size || 1);
                }
                const effectiveLotSize = (trade.trade_mode === 'UNITS' || trade.equity_units_mode === 1) ? 1 : lotSize;
                const qtyForPnl = trade.qty * effectiveLotSize;

                if ((trade.type || 'BUY').toUpperCase() === 'BUY') {
                    weeklyMtmPnl = (settlementPrice - baselinePrice) * qtyForPnl;
                } else {
                    weeklyMtmPnl = (baselinePrice - settlementPrice) * qtyForPnl;
                }
                console.log(`  📈 [Trade #${trade.id}] NON-COMMODITY ${trade.symbol} | type=${trade.type} qty=${trade.qty} | baseline=${baselinePrice}(${baselineSource}) settlementPrice=${settlementPrice}(${priceSource}) | lotSize=${lotSize} effectiveLotSize=${effectiveLotSize} qtyForPnl=${qtyForPnl} trade_mode=${trade.trade_mode} eq_units_mode=${trade.equity_units_mode} => MTM=₹${weeklyMtmPnl.toFixed(2)}`);
            }

            totalUnrealizedMtmPnl += weeklyMtmPnl;

            await connection.execute(
                `UPDATE trades 
                 SET status = 'HOLD',
                     is_carried_forward = 1,
                     carry_forward_from_week = ?,
                     carry_forward_to_week = ?,
                     settlement_price = ?,
                     last_settlement_price = ?,
                     accumulated_settled_pnl = accumulated_settled_pnl + ?
                 WHERE id = ?`,
                [weekEnd, weekStart, settlementPrice, settlementPrice, weeklyMtmPnl, trade.id]
            );

            carriedForwardItems.push({
                tradeId: trade.id,
                symbol: trade.symbol,
                type: trade.type,
                qty: trade.qty,
                lotSize: trade.lot_size || 1,
                originalEntryPrice: parseFloat(trade.entry_price),
                settlementPrice,
                settledPnl: weeklyMtmPnl,
                brokerage: 0
            });

            carriedForwardCount++;
        }

        // Net Week Result & Final Closing Balance
        const netWeekResult = (realizedPnl - brokerage - charges) + totalDeposit - totalWithdrawal + totalUnrealizedMtmPnl;

        // Closing Balance: Since realized PnL, brokerage, charges, deposits, and withdrawals were ALREADY 
        // credited/debited to user.balance in real-time when those events occurred,
        // Weekly Settlement ONLY adjusts user.balance for the open trade MTM PnL (totalUnrealizedMtmPnl).
        const closingBalance = currentBalance + totalUnrealizedMtmPnl;
        console.log(`✅ [WeeklySettlement DEBUG] User #${userId} FINAL: openingBal=₹${openingBalance} currentBal=₹${currentBalance} totalMTM=₹${totalUnrealizedMtmPnl} closingBal=₹${closingBalance}`);

        // 7. Insert / Update weekly_settlements Record
        const [settlementResult] = await connection.execute(
            `INSERT INTO weekly_settlements (
                user_id, week_start_date, week_end_date,
                opening_balance, realized_pnl, unrealized_mtm_pnl, brokerage, charges,
                total_deposit, total_withdrawal, net_week_result, closing_balance,
                carried_forward_trades_count, settled_trades_count,
                settlement_status, settled_at, settled_by_user_id, notes
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'COMPLETED', NOW(), ?, ?)
             ON DUPLICATE KEY UPDATE
                opening_balance = VALUES(opening_balance),
                realized_pnl = VALUES(realized_pnl),
                unrealized_mtm_pnl = VALUES(unrealized_mtm_pnl),
                brokerage = VALUES(brokerage),
                charges = VALUES(charges),
                total_deposit = VALUES(total_deposit),
                total_withdrawal = VALUES(total_withdrawal),
                net_week_result = VALUES(net_week_result),
                closing_balance = VALUES(closing_balance),
                carried_forward_trades_count = VALUES(carried_forward_trades_count),
                settled_trades_count = 0,
                settlement_status = 'COMPLETED',
                settled_at = NOW(),
                settled_by_user_id = VALUES(settled_by_user_id),
                notes = VALUES(notes)`,
            [
                userId, weekStart, weekEnd,
                openingBalance, realizedPnl, totalUnrealizedMtmPnl, brokerage, charges,
                totalDeposit, totalWithdrawal, netWeekResult, closingBalance,
                carriedForwardCount,
                settledByUserId,
                `Weekly Settlement (${weekStart} to ${weekEnd})`
            ]
        );

        const settlementId = settlementResult.insertId || existing[0]?.id;

        // Tag trades & insert itemized records into weekly_settlement_items
        if (settlementId) {
            await connection.execute(
                `UPDATE trades 
                 SET settlement_id = ? 
                 WHERE user_id = ? 
                   AND (
                       (DATE(COALESCE(exit_time, entry_time)) >= ? AND DATE(COALESCE(exit_time, entry_time)) <= ?)
                       OR status = 'HOLD'
                   )`,
                [settlementId, userId, weekStart, weekEnd]
            );

            // Clean existing items for this settlement (idempotency safety)
            await connection.execute(
                `DELETE FROM weekly_settlement_items WHERE settlement_id = ?`,
                [settlementId]
            );

            for (const item of carriedForwardItems) {
                await connection.execute(
                    `INSERT INTO weekly_settlement_items 
                     (settlement_id, user_id, trade_id, symbol, type, qty, lot_size, original_entry_price, settlement_price, settled_pnl, brokerage, is_carried_forward)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
                    [
                        settlementId, userId, item.tradeId, item.symbol, item.type,
                        item.qty, item.lotSize, item.originalEntryPrice, item.settlementPrice,
                        item.settledPnl, item.brokerage
                    ]
                );
            }
        }

        // 8. Update User's Balance and create Ledger Transaction Audit Trail for MTM PnL
        await connection.execute(
            `UPDATE users SET balance = ? WHERE id = ?`,
            [closingBalance, userId]
        );

        const remarksText = `Weekly Settlement ${weekStart} to ${weekEnd} | MTM PnL: ₹${totalUnrealizedMtmPnl.toFixed(2)}`;

        // ✅ Delete all stale WEEKLY_SETTLEMENT ledger entries for this user+week before inserting fresh
        // Match by week dates in remarks (covers all old runs regardless of reference_id)
        await connection.execute(
            `DELETE FROM ledger 
             WHERE user_id = ? AND reference_type = 'WEEKLY_SETTLEMENT' 
               AND remarks LIKE ?`,
            [userId, `%${weekStart}%${weekEnd}%`]
        );
        // Also clean up any reference_id='0' orphan entries
        await connection.execute(
            `DELETE FROM ledger WHERE user_id = ? AND reference_type = 'WEEKLY_SETTLEMENT' AND (reference_id = '0' OR reference_id = '')`,
            [userId]
        );

        // Insert fresh clean ledger entry — skip if MTM PnL is zero (avoids +0.00 noise entries)
        if (totalUnrealizedMtmPnl !== 0) {
            await connection.execute(
                `INSERT INTO ledger (user_id, amount, type, balance_before, balance_after, reference_id, reference_type, remarks, created_at)
                 VALUES (?, ?, 'WEEKLY_SETTLEMENT', ?, ?, ?, 'WEEKLY_SETTLEMENT', ?, NOW())`,
                [
                    userId,
                    totalUnrealizedMtmPnl,
                    currentBalance,
                    closingBalance,
                    String(settlementId),
                    remarksText
                ]
            );
        }

        // 9. Sync weekly_balances for backward compatibility
        await connection.execute(
            `INSERT INTO weekly_balances (user_id, week_start, week_end, opening_balance, closing_balance)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                 opening_balance = VALUES(opening_balance),
                 closing_balance = VALUES(closing_balance)`,
            [userId, weekStart, weekEnd, openingBalance, closingBalance]
        );

        await connection.commit();

        console.log(`✅ [WeeklySettlement] Settle completed for ${username} (#${userId}): Open=₹${openingBalance.toFixed(2)}, P&L=₹${realizedPnl.toFixed(2)}, Brok=₹${brokerage.toFixed(2)}, Close=₹${closingBalance.toFixed(2)}, Held=${carriedForwardCount}, Settled=${settledTradesCount}`);

        return {
            userId,
            username,
            status: 'COMPLETED',
            settlementId,
            openingBalance,
            realizedPnl,
            brokerage,
            closingBalance,
            carriedForwardCount,
            settledTradesCount
        };
    } catch (err) {
        await connection.rollback();
        console.error(`❌ [WeeklySettlement] Failed for user #${userId} (${username}):`, err);

        // Record failed attempt in weekly_settlements for audit
        try {
            await db.execute(
                `INSERT INTO weekly_settlements (user_id, week_start_date, week_end_date, settlement_status, notes)
                 VALUES (?, ?, ?, 'FAILED', ?)
                 ON DUPLICATE KEY UPDATE settlement_status = 'FAILED', notes = VALUES(notes)`,
                [userId, weekStart, weekEnd, err.message]
            );
        } catch (_) { }

        return {
            userId,
            username,
            status: 'FAILED',
            error: err.message
        };
    } finally {
        connection.release();
    }
}

let isSettlementRunning = false;

/**
 * Main function: Run weekly settlement across all active traders
 */
async function runWeeklySettlement({ targetDate = new Date(), settledByUserId = null, force = false } = {}) {
    if (isSettlementRunning) {
        console.log('[WeeklySettlement] Settlement already in progress. Rejecting concurrent call.');
        return {
            success: false,
            message: 'Weekly Settlement is already in progress. Please wait.'
        };
    }

    isSettlementRunning = true;
    const { week_start, week_end } = getWeekBoundaries(getISTDate(targetDate));
    console.log(`\n═════════════════════════════════════════════════════════════════`);
    console.log(`🚀 [WeeklySettlement] Starting Weekly Settlement for Week: ${week_start} to ${week_end}`);
    console.log(`═════════════════════════════════════════════════════════════════`);

    try {
        const [traders] = await db.execute(
            "SELECT id, username FROM users WHERE role = 'TRADER'"
        );

        console.log(`[WeeklySettlement] Found ${traders.length} traders to process.`);

        const results = [];
        for (const trader of traders) {
            const res = await processTraderSettlement({
                userId: trader.id,
                username: trader.username,
                weekStart: week_start,
                weekEnd: week_end,
                settledByUserId,
                force
            });
            results.push(res);
        }

        const completedCount = results.filter(r => r.status === 'COMPLETED').length;
        const skippedCount = results.filter(r => r.status === 'SKIPPED_ALREADY_COMPLETED').length;
        const failedCount = results.filter(r => r.status === 'FAILED').length;

        console.log(`\n🏁 [WeeklySettlement] Finished: Completed=${completedCount}, Skipped=${skippedCount}, Failed=${failedCount}`);
        return {
            success: true,
            week_start,
            week_end,
            total_traders: traders.length,
            completed_count: completedCount,
            skipped_count: skippedCount,
            failed_count: failedCount,
            results
        };
    } catch (err) {
        console.error('[WeeklySettlement] Fatal error in batch runner:', err);
        throw err;
    } finally {
        isSettlementRunning = false;
    }
}

/**
 * Native IST Schedular: Reads SuperAdmin config from expiry_rules and triggers at exact time
 */
const startWeeklySettlementJob = () => {
    let lastSettledWeek = '';

    // Check every 30 seconds to catch configured IST Settlement Day & Time
    setInterval(async () => {
        try {
            const [rules] = await db.execute(
                `SELECT weekly_settlement_day, weekly_settlement_time, weekly_settlement_enabled 
                 FROM expiry_rules WHERE weekly_settlement_enabled = 'Yes' LIMIT 1`
            );

            const rule = rules[0] || {};
            const configDay = (rule.weekly_settlement_day || 'Sunday').toLowerCase();
            const configTime = rule.weekly_settlement_time || '12:00';

            const now = new Date();
            const parts = new Intl.DateTimeFormat('en-US', {
                timeZone: 'Asia/Kolkata',
                weekday: 'long',
                hour: 'numeric',
                minute: 'numeric',
                hour12: false
            }).formatToParts(now);

            let currentWeekday = '', currentH = -1, currentM = -1;
            parts.forEach(p => {
                if (p.type === 'weekday') currentWeekday = p.value.toLowerCase();
                if (p.type === 'hour') currentH = parseInt(p.value, 10) % 24;
                if (p.type === 'minute') currentM = parseInt(p.value, 10);
            });

            const [targetH, targetM] = configTime.split(':').map(Number);
            const { week_end } = getWeekBoundaries(now);

            // Trigger when matching configured Day and Hour/Minute in IST
            if (currentWeekday === configDay && currentH === targetH && currentM === targetM && lastSettledWeek !== week_end) {
                lastSettledWeek = week_end;
                console.log(`⏰ [WeeklySettlement Scheduler] Configured settlement time reached (${configDay} ${configTime} IST). Starting auto-settlement...`);
                await runWeeklySettlement({ targetDate: now });
            }
        } catch (err) {
            console.error('[WeeklySettlement Scheduler Error]:', err.message);
        }
    }, 30000);

    console.log('📅 Native IST Weekly Settlement Scheduler initialized (Default: Sunday 12:00 PM IST).');
};

module.exports = {
    startWeeklySettlementJob,
    runWeeklySettlement,
    processTraderSettlement,
    getWeekBoundaries,
    getISTDate
};
