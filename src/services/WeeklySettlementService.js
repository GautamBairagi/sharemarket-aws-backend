const cron = require('node-cron');
const db = require('../config/db');

// Helper to get date representation in Asia/Kolkata timezone
function getISTDate(date = new Date()) {
    const options = { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'numeric', day: 'numeric' };
    const formatter = new Intl.DateTimeFormat('en-US', options);
    const parts = formatter.formatToParts(date);
    const year = parts.find(p => p.type === 'year').value;
    const month = parts.find(p => p.type === 'month').value;
    const day = parts.find(p => p.type === 'day').value;
    return new Date(year, month - 1, day);
}

// Helper to calculate weekly boundaries
function getWeekBoundaries(targetDate = new Date()) {
    const d = new Date(targetDate);
    const day = d.getDay();
    const daysToAdd = (5 - day + 7) % 7;
    
    const friday = new Date(d);
    friday.setDate(d.getDate() + daysToAdd);
    
    const saturday = new Date(friday);
    saturday.setDate(friday.getDate() - 6);
    
    const formatDate = (dateObj) => {
        const year = dateObj.getFullYear();
        const month = String(dateObj.getMonth() + 1).padStart(2, '0');
        const date = String(dateObj.getDate()).padStart(2, '0');
        return `${year}-${month}-${date}`;
    };
    
    return {
        week_start: formatDate(saturday),
        week_end: formatDate(friday)
    };
}

async function runWeeklyClosing(targetDate = new Date()) {
    const boundaries = getWeekBoundaries(getISTDate(targetDate));
    const { week_start, week_end } = boundaries;
    
    console.log(`[WeeklySettlement] Starting weekly closing process for ${week_start} to ${week_end}`);
    
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        
        // 1. Fetch all traders
        const [traders] = await connection.execute(
            "SELECT id, username, balance FROM users WHERE role = 'TRADER'"
        );
        
        console.log(`[WeeklySettlement] Found ${traders.length} traders to process.`);
        
        const results = [];
        
        for (const trader of traders) {
            const userId = trader.id;
            const currentBalance = parseFloat(trader.balance || 0);
            
            // 2. Find previous week's closing balance
            const [prevRows] = await connection.execute(
                'SELECT closing_balance FROM weekly_balances WHERE user_id = ? AND week_end < ? ORDER BY week_end DESC LIMIT 1',
                [userId, week_end]
            );
            
            let openingBalance = currentBalance;
            if (prevRows.length > 0) {
                openingBalance = parseFloat(prevRows[0].closing_balance);
            } else {
                // If no previous weekly balance exists, calculate based on ledger transactions since week_start
                const [movements] = await connection.execute(
                    `SELECT 
                        SUM(CASE WHEN type = 'DEPOSIT' THEN amount ELSE 0 END) as deposits,
                        SUM(CASE WHEN type = 'WITHDRAW' THEN amount ELSE 0 END) as withdrawals,
                        SUM(CASE WHEN type = 'TRADE_PNL' THEN amount ELSE 0 END) as pnl,
                        SUM(CASE WHEN type = 'BROKERAGE' THEN amount ELSE 0 END) as brokerage,
                        SUM(CASE WHEN type = 'SWAP' THEN amount ELSE 0 END) as swap
                     FROM ledger 
                     WHERE user_id = ? AND created_at >= ?`,
                    [userId, week_start + ' 00:00:00']
                );
                
                if (movements.length > 0) {
                    const m = movements[0];
                    const dep = parseFloat(m.deposits || 0);
                    const wit = parseFloat(m.withdrawals || 0);
                    const pl = parseFloat(m.pnl || 0);
                    const brok = parseFloat(m.brokerage || 0);
                    const sw = parseFloat(m.swap || 0);
                    
                    openingBalance = currentBalance - dep + wit - pl + brok + sw;
                }
            }
            
            // 3. Upsert weekly_balances entry
            await connection.execute(
                `INSERT INTO weekly_balances (user_id, week_start, week_end, opening_balance, closing_balance)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                     opening_balance = VALUES(opening_balance),
                     closing_balance = VALUES(closing_balance)`,
                [userId, week_start, week_end, openingBalance, currentBalance]
            );
            
            results.push({
                username: trader.username,
                opening: openingBalance,
                closing: currentBalance
            });
        }
        
        await connection.commit();
        console.log(`[WeeklySettlement] Weekly closing completed successfully for week: ${week_start} to ${week_end}`);
        return { success: true, processedCount: traders.length, week_start, week_end, results };
    } catch (error) {
        await connection.rollback();
        console.error(`[WeeklySettlement] Failed to run weekly closing:`, error);
        throw error;
    } finally {
        connection.release();
    }
}

const startWeeklySettlementJob = () => {
    // Run every Friday at 23:59:59 PM Asia/Kolkata
    cron.schedule('59 23 * * 5', async () => {
        console.log('[WeeklySettlement] 🕒 Weekly closing time reached (Friday 23:59 IST)');
        try {
            await runWeeklyClosing();
        } catch (err) {
            console.error('[WeeklySettlement] ❌ Failed to run auto weekly closing:', err.message);
        }
    }, {
        scheduled: true,
        timezone: "Asia/Kolkata"
    });

    console.log('🚀 Weekly Closing/Settlement Job Scheduled (Fridays 23:59 IST)');
};

module.exports = {
    startWeeklySettlementJob,
    runWeeklyClosing,
    getWeekBoundaries,
    getISTDate
};
