const db = require('../config/db');
const marketDataService = require('./MarketDataService');

/**
 * Service to handle Portfolio logic for Paper Trading.
 */
class PortfolioService {
    
    async getPositions(userId) {
        const [rows] = await db.execute(
            'SELECT * FROM paper_positions WHERE user_id = ?', [userId]
        );

        // Enhance with live P&L
        return rows.map(pos => {
            const livePrice = marketDataService.getPrice(pos.symbol)?.ltp || pos.avg_price;
            const pnl = (livePrice - pos.avg_price) * pos.quantity;
            return {
                ...pos,
                last_price: livePrice,
                pnl: parseFloat(pnl.toFixed(2))
            };
        });
    }

    async getHoldings(userId) {
        const [rows] = await db.execute(
            'SELECT * FROM paper_holdings WHERE user_id = ?', [userId]
        );
        
        return rows.map(hold => {
            const livePrice = marketDataService.getPrice(hold.symbol)?.ltp || hold.avg_price;
            const pnl = (livePrice - hold.avg_price) * hold.quantity;
            return {
                ...hold,
                last_price: livePrice,
                pnl: parseFloat(pnl.toFixed(2))
            };
        });
    }

    async getBalanceData(userId) {
        const [rows] = await db.execute(
            'SELECT balance, credit_limit FROM users WHERE id = ?', [userId]
        );
        return rows[0] || { balance: 0, credit_limit: 0 };
    }
}

module.exports = new PortfolioService();
