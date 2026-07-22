const db = require('../config/db');
const marketDataService = require('./MarketDataService');
const tradeService = require('./TradeService');
const socketManager = require('../websocket/SocketManager');

/**
 * Risk Management System (RMS) Service
 * Periodically monitors all active traders for M2M losses.
 * Triggers Auto-Close or Notifications when thresholds are breached.
 */
class RMSService {
    constructor() {
        this.interval = null;
        this.lastNotificationTime = new Map(); // userId -> lastNotificationTimestamp
        this.isProcessing = false;
    }

    start(intervalMs = 10000) {
        if (this.interval) return;
        console.log(`🛡️  RMS Service Started (Interval: ${intervalMs}ms)`);
        this.interval = setInterval(() => this.checkRiskThresholds(), intervalMs);
    }

    async checkRiskThresholds() {
        if (this.isProcessing) return;
        this.isProcessing = true;

        try {
            // 1. Fetch all users with OPEN trades and their settings
            const [users] = await db.execute(`
                SELECT DISTINCT u.id, u.balance, cs.auto_close_at_m2m_pct, cs.notify_at_m2m_pct, cs.config_json
                FROM users u
                JOIN trades t ON t.user_id = u.id
                JOIN client_settings cs ON cs.user_id = u.id
                WHERE t.status = 'OPEN' AND u.role = 'TRADER'
            `);

            for (const user of users) {
                await this.processUserRisk(user);
            }
        } catch (err) {
            console.error('[RMSService] Global check error:', err.message);
        } finally {
            this.isProcessing = false;
        }
    }

    async processUserRisk(user) {
        try {
            // 1. Get all open trades for this user
            const [trades] = await db.execute(
                "SELECT id, symbol, type, qty, entry_price, market_type FROM trades WHERE user_id = ? AND status = 'OPEN' AND is_pending = 0",
                [user.id]
            );

            if (trades.length === 0) return;

            // 2. Parse Config and Thresholds
            let config = {};
            try { config = JSON.parse(user.config_json || '{}'); } catch (e) { }

            // Respect the "Auto Close Trades if condition met" checkbox (isAutoCloseEnabled)
            const isAutoCloseActive = config.autoCloseEnabled !== false;

            // 3. Calculate Total Floating PnL
            let totalPnL = 0;
            const commodityLotService = require('./CommodityLotService');
            for (const trade of trades) {
                const liveData = marketDataService.getPrice(trade.symbol);
                if (!liveData) continue;

                const currentPrice = trade.type === 'BUY' ? (liveData.bid || liveData.ltp) : (liveData.ask || liveData.ltp);
                
                let pnl = 0;
                if (commodityLotService.isCommodityScrip(trade.symbol, trade.market_type)) {
                    const calc = commodityLotService.calculatePnL(trade.symbol, trade.type, trade.entry_price, currentPrice, trade.qty);
                    pnl = calc.pnlInr;
                } else {
                    pnl = trade.type === 'BUY'
                        ? (currentPrice - trade.entry_price) * trade.qty
                        : (trade.entry_price - currentPrice) * trade.qty;
                }

                totalPnL += pnl;
            }

            const userBalance = parseFloat(user.balance || 0);
            if (userBalance <= 0) return;

            const lossPercentage = totalPnL < 0 ? (Math.abs(totalPnL) / userBalance) * 100 : 0;
            const autoCloseThreshold = parseFloat(user.auto_close_at_m2m_pct ?? 90);
            const notifyThreshold = parseFloat(user.notify_at_m2m_pct ?? 70);

            // 4. Check Thresholds

            // ACTION A: AUTO-CLOSE (Critical)
            if (totalPnL < 0 && lossPercentage >= autoCloseThreshold && isAutoCloseActive) {
                console.log(`[RMSService] 🚨 DYNAMIC AUTO-CLOSE for User #${user.id}: Loss=${lossPercentage.toFixed(2)}% (Threshold: ${autoCloseThreshold}%)`);

                const remark = `${Math.round(autoCloseThreshold)}% Loss Limit Breached`;
                await tradeService.closeAllUserTrades(user.id, 0, 'RMS_AUTO_CLOSE', remark);

                // Notify user via socket immediately
                this.sendSocketAlert(user.id, `🚨 AUTO-SQUARE OFF: Account losses reached ${lossPercentage.toFixed(2)}% of balance. All trades closed automatically.`);
                return;
            }

            // ACTION B: NOTIFY (Warning)
            if (totalPnL < 0 && lossPercentage >= notifyThreshold) {
                const now = Date.now();
                const lastNotify = this.lastNotificationTime.get(user.id) || 0;

                // Notify every 5 minutes (300,000 ms) as per requirement
                if (now - lastNotify > 300000) {
                    console.log(`[RMSService] 🔔 NOTIFY TRIGGERED for User #${user.id}: Loss=${lossPercentage.toFixed(2)}%`);

                    await db.execute(
                        'INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)',
                        [user.id, `⚠️ Account Margin Warning: Your losses have reached ${lossPercentage.toFixed(2)}% of ledger balance. Please add funds to avoid auto-square off.`, 'LOSS_WARNING']
                    );

                    this.sendSocketAlert(user.id, `⚠️ Margin Warning: Loss reached ${lossPercentage.toFixed(2)}%`);
                    this.lastNotificationTime.set(user.id, now);
                }
            }
        } catch (err) {
            console.error(`[RMSService] Error processing user ${user.id}:`, err.message);
        }
    }

    sendSocketAlert(userId, message) {
        const io = socketManager.getIo();
        if (io) {
            io.to(`user:${userId}`).emit('notification', {
                message,
                type: 'RMS_ALERT',
                timestamp: new Date().toISOString()
            });
        }
    }

    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }
}

module.exports = new RMSService();
