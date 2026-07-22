const cron = require('node-cron');
const db = require('../config/db');
const tradeService = require('./TradeService');
const MarginUtils = require('../utils/MarginUtils');

/**
 * Service to handle automatic square-off at market close
 * specifically checking if user has enough balance to carry forward to 'HOLDING'
 */
const startMarketCloseSquareOffJob = () => {
    // 1. NSE/NFO Square-off: 3:20 PM IST (Mon-Fri)
    cron.schedule('20 15 * * 1-5', async () => {
        console.log('[MarketClose] 🕒 NSE/NFO square-off time reached (15:20 IST)');
        await processSegmentSquareOff(['EQUITY', 'NFO', 'OPTIONS', 'NSE', 'INDEX', 'INDICES', 'NSE_INDEX']);
    }, {
        scheduled: true,
        timezone: "Asia/Kolkata"
    });

    // 2. MCX Square-off: 11:30 PM IST (Mon-Fri)
    // Note: On some days MCX closes at 11:55, but 11:30 is a safe auto-square off time
    cron.schedule('30 23 * * 1-5', async () => {
        console.log('[MarketClose] 🕒 MCX square-off time reached (23:30 IST)');
        await processSegmentSquareOff(['MCX']);
    }, {
        scheduled: true,
        timezone: "Asia/Kolkata"
    });

    console.log('🚀 Market Close Auto-SquareOff service started (NSE: 15:20, MCX: 23:30 IST)');
};

async function processSegmentSquareOff(segments) {
    try {
        // Fetch all users with open trades in these segments
        const [users] = await db.execute(`
            SELECT DISTINCT u.id, u.balance, cs.config_json
            FROM users u
            JOIN trades t ON t.user_id = u.id
            JOIN client_settings cs ON u.id = cs.user_id
            WHERE t.status = 'OPEN' AND t.is_pending = 0
            AND t.market_type IN (${segments.map(s => `'${s}'`).join(',')})
        `);

        for (const user of users) {
            try {
                // 1. Get all open trades for this segment for this user
                const [trades] = await db.execute(`
                    SELECT t.*, sd.lot_size as multiplier
                    FROM trades t
                    LEFT JOIN scrip_data sd ON t.symbol = sd.symbol
                    WHERE t.user_id = ? AND t.status = 'OPEN' AND t.is_pending = 0
                    AND t.market_type IN (${segments.map(s => `'${s}'`).join(',')})
                `, [user.id]);

                if (trades.length === 0) continue;

                const clientConfig = JSON.parse(user.config_json || '{}');
                
                // 2. Calculate Total Required Holding Margin
                const totalRequired = MarginUtils.calculateTotalRequiredHoldingMargin(trades, clientConfig);
                const availableBalance = parseFloat(user.balance || 0);

                console.log(`[MarketClose] User #${user.id} | Segment: ${segments[0]} | Required: ${totalRequired.toFixed(2)} | Available: ${availableBalance.toFixed(2)}`);

                // 3. Check for shortfall
                if (availableBalance < totalRequired) {
                    console.log(`[MarketClose] 🚨 Shortfall detected for User #${user.id}. Squaring off all ${segments[0]} positions.`);
                    
                    for (const trade of trades) {
                        try {
                            await tradeService.closeTrade(trade.id, null, 0, null, '🏁 Market Close Square-off (Insufficient Margin)');
                        } catch (closeErr) {
                            console.error(`[MarketClose] Failed to close trade #${trade.id}:`, closeErr.message);
                        }
                    }
                }
            } catch (userErr) {
                console.error(`[MarketClose] Error processing user #${user.id}:`, userErr.message);
            }
        }
    } catch (err) {
        console.error('[MarketClose] Global process error:', err.message);
    }
}

module.exports = { startMarketCloseSquareOffJob };
