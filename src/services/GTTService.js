const db = require('../config/db');

/**
 * Service to manage GTT (Good Till Triggered) orders for Paper Trading.
 */
class GTTService {

    async placeGTT(userId, gttData) {
        const { symbol, trigger_price, order_type, quantity, type } = gttData;

        const [result] = await db.execute(
            `INSERT INTO paper_gtt_triggers (user_id, symbol, trigger_price, order_type, quantity, type, status)
             VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')`,
            [userId, symbol, trigger_price, order_type, quantity, type]
        );
        return result.insertId;
    }

    async getGTTs(userId) {
        const [rows] = await db.execute(
            'SELECT * FROM paper_gtt_triggers WHERE user_id = ?', [userId]
        );
        return rows;
    }

    async cancelGTT(gttId, userId) {
        await db.execute(
            "UPDATE paper_gtt_triggers SET status = 'CANCELLED' WHERE id = ? AND user_id = ?",
            [gttId, userId]
        );
    }

    /**
     * Engine should call this to check for triggers.
     */
    async processGTTs(connection) {
        const marketDataService = require('./MarketDataService');
        const orderService = require('./OrderService');

        const [gtts] = await connection.execute(
            "SELECT * FROM paper_gtt_triggers WHERE status = 'ACTIVE'"
        );

        for (const gtt of gtts) {
            const liveData = marketDataService.getPrice(gtt.symbol);
            if (!liveData) continue;

            const currentPrice = liveData.ltp;
            let triggered = false;

            if (gtt.type === 'BUY' && currentPrice <= gtt.trigger_price) triggered = true;
            if (gtt.type === 'SELL' && currentPrice >= gtt.trigger_price) triggered = true;

            if (triggered) {
                console.log(`🚀 GTT Triggered for ${gtt.symbol} @ ${gtt.trigger_price}`);
                
                // Convert GTT to Order
                await orderService.placeOrder(gtt.user_id, {
                    symbol: gtt.symbol,
                    type: gtt.type,
                    order_type: gtt.order_type,
                    quantity: gtt.quantity,
                    price: gtt.trigger_price
                });

                // Update GTT status
                await connection.execute(
                    "UPDATE paper_gtt_triggers SET status = 'TRIGGERED' WHERE id = ?",
                    [gtt.id]
                );
            }
        }
    }
}

module.exports = new GTTService();
