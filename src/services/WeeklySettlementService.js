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
async function processTraderSettlement({ userId, username, weekStart, weekEnd, settledByUserId = null }) {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Idempotency Check: Don't re-run if already COMPLETED for this week
        const [existing] = await connection.execute(
            `SELECT id, settlement_status FROM weekly_settlements 
             WHERE user_id = ? AND week_start_date = ? AND week_end_date = ?`,
            [userId, weekStart, weekEnd]
        );

        if (existing.length > 0 && existing[0].settlement_status === 'COMPLETED') {
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
        const currentBalance = parseFloat(user.balance || 0);

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

        // Net Week Result & New Closing Balance
        const netWeekResult = realizedPnl - brokerage - charges + totalDeposit - totalWithdrawal;
        const closingBalance = openingBalance + (realizedPnl - brokerage - charges) + totalDeposit - totalWithdrawal;

        // 6. Process Open / Holding Trades — Evaluate Holding Margin
        const [openTrades] = await connection.execute(
            `SELECT * FROM trades 
             WHERE user_id = ? AND status IN ('OPEN', 'HOLD') 
             ORDER BY id ASC`,
            [userId]
        );

        let availableHoldingMargin = Math.max(0, closingBalance);
        let carriedForwardCount = 0;
        let settledTradesCount = 0;

        for (const trade of openTrades) {
            let requiredMargin = parseFloat(trade.margin_used || 0);

            // If margin_used is 0, calculate required holding margin using MarginService
            if (requiredMargin <= 0) {
                try {
                    const marginConfig = MarginService.getMarginConfig(
                        trade.symbol,
                        trade.market_type || 'MCX',
                        clientConfig,
                        trade.margin_type
                    );
                    requiredMargin = MarginService.calculateRequiredMargin({
                        qty: trade.qty,
                        price: trade.entry_price,
                        marginConfig,
                        tradeType: 'HOLDING',
                        lotSize: trade.lot_size || 1
                    });
                } catch (e) {
                    requiredMargin = parseFloat(trade.entry_price || 0) * parseFloat(trade.qty || 1);
                }
            }

            // Check if user has sufficient margin to hold
            if (availableHoldingMargin >= requiredMargin) {
                // CASE A: Sufficient Holding Margin -> Carry Forward (HOLD) with ₹0 new week brokerage
                availableHoldingMargin -= requiredMargin;
                await connection.execute(
                    `UPDATE trades 
                     SET status = 'HOLD',
                         is_carried_forward = 1,
                         carry_forward_from_week = ?,
                         carry_forward_to_week = ?
                     WHERE id = ?`,
                    [weekEnd, weekStart, trade.id]
                );
                carriedForwardCount++;
            } else {
                // CASE B: Insufficient Holding Margin -> Auto Square-off / Settle
                const exitPrice = parseFloat(trade.current_price || trade.entry_price || 0);
                const isBuy = (trade.type || 'BUY').toUpperCase() === 'BUY';
                const lotMult = trade.lot_size || 1;
                const pnl = isBuy 
                    ? (exitPrice - parseFloat(trade.entry_price)) * parseFloat(trade.qty) * lotMult
                    : (parseFloat(trade.entry_price) - exitPrice) * parseFloat(trade.qty) * lotMult;

                await connection.execute(
                    `UPDATE trades 
                     SET status = 'SETTLED',
                         exit_price = ?,
                         exit_time = NOW(),
                         settlement_price = ?,
                         settlement_time = NOW(),
                         pnl = ?
                     WHERE id = ?`,
                    [exitPrice, exitPrice, pnl, trade.id]
                );
                settledTradesCount++;
            }
        }

        // 7. Insert / Update weekly_settlements Record
        const [settlementResult] = await connection.execute(
            `INSERT INTO weekly_settlements (
                user_id, week_start_date, week_end_date,
                opening_balance, realized_pnl, brokerage, charges,
                total_deposit, total_withdrawal, net_week_result, closing_balance,
                carried_forward_trades_count, settled_trades_count,
                settlement_status, settled_at, settled_by_user_id, notes
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', NOW(), ?, ?)
             ON DUPLICATE KEY UPDATE
                opening_balance = VALUES(opening_balance),
                realized_pnl = VALUES(realized_pnl),
                brokerage = VALUES(brokerage),
                charges = VALUES(charges),
                total_deposit = VALUES(total_deposit),
                total_withdrawal = VALUES(total_withdrawal),
                net_week_result = VALUES(net_week_result),
                closing_balance = VALUES(closing_balance),
                carried_forward_trades_count = VALUES(carried_forward_trades_count),
                settled_trades_count = VALUES(settled_trades_count),
                settlement_status = 'COMPLETED',
                settled_at = NOW(),
                settled_by_user_id = VALUES(settled_by_user_id),
                notes = VALUES(notes)`,
            [
                userId, weekStart, weekEnd,
                openingBalance, realizedPnl, brokerage, charges,
                totalDeposit, totalWithdrawal, netWeekResult, closingBalance,
                carriedForwardCount, settledTradesCount,
                settledByUserId,
                `Weekly Settlement (${weekStart} to ${weekEnd})`
            ]
        );

        const settlementId = settlementResult.insertId || existing[0]?.id;

        // Tag trades with settlement_id
        if (settlementId) {
            await connection.execute(
                `UPDATE trades 
                 SET settlement_id = ? 
                 WHERE user_id = ? 
                   AND DATE(COALESCE(exit_time, entry_time)) >= ? 
                   AND DATE(COALESCE(exit_time, entry_time)) <= ?`,
                [settlementId, userId, weekStart, weekEnd]
            );
        }

        // 8. Update User's Balance and create Ledger Transaction Audit Trail
        await connection.execute(
            `UPDATE users SET balance = ? WHERE id = ?`,
            [closingBalance, userId]
        );

        await connection.execute(
            `INSERT INTO ledger (user_id, amount, type, balance_before, balance_after, reference_id, reference_type, remarks, created_at)
             VALUES (?, ?, 'WEEKLY_SETTLEMENT', ?, ?, ?, 'WEEKLY_SETTLEMENT', ?, NOW())`,
            [
                userId,
                netWeekResult,
                openingBalance,
                closingBalance,
                String(settlementId),
                `Weekly Settlement for period ${weekStart} to ${weekEnd}`
            ]
        );

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

/**
 * Main function: Run weekly settlement across all active traders
 */
async function runWeeklySettlement({ targetDate = new Date(), settledByUserId = null } = {}) {
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
                settledByUserId
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
