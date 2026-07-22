const db = require('../config/db');
const marketDataService = require('../services/MarketDataService');
const socketManager = require('../websocket/SocketManager');

/**
 * Core Paper Trading Engine
 * Matches pending orders against live prices and updates portfolio states.
 */
class PaperTradingEngine {
    constructor() {
        this.isProcessing = false;
        this.interval = null;
    }

    start() {
        if (this.interval) return;
        console.log('🚀 Paper Trading Engine Started');
        this.interval = setInterval(() => this.processOrders(), 1000);
    }

    async processOrders() {
        if (this.isProcessing) return;
        this.isProcessing = true;

        const connection = await db.getConnection();
        try {
            // 1. Fetch all pending orders
            const [orders] = await connection.execute(
                "SELECT * FROM paper_orders WHERE status = 'PENDING'"
            );

            for (const order of orders) {
                const liveData = marketDataService.getPrice(order.symbol);
                if (!liveData) continue;

                const currentPrice = liveData.ltp;
                let shouldExecute = false;
                let executionPrice = currentPrice;

                // 2. Matching Logic
                if (order.order_type === 'MARKET') {
                    shouldExecute = true;
                    executionPrice = currentPrice;
                } else if (order.order_type === 'LIMIT') {
                    if (order.type === 'BUY' && currentPrice <= order.price) {
                        shouldExecute = true;
                        executionPrice = order.price; // Execute at limit price or better
                    } else if (order.type === 'SELL' && currentPrice >= order.price) {
                        shouldExecute = true;
                        executionPrice = order.price;
                    }
                }

                if (shouldExecute) {
                    await this.executeOrder(connection, order, executionPrice);
                }
            }
        } catch (err) {
            console.error('Order processing error:', err.message);
        } finally {
            connection.release();
            this.isProcessing = false;
        }
    }

    async executeOrder(connection, order, executionPrice) {
        console.log(`🎯 Executing Order ${order.id}: ${order.symbol} @ ${executionPrice}`);

        try {
            await connection.beginTransaction();

            // 1. Update Order Status
            await connection.execute(
                "UPDATE paper_orders SET status = 'EXECUTED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                [order.id]
            );

            // 2. Insert into Paper Trades
            await connection.execute(
                `INSERT INTO paper_trades (order_id, user_id, symbol, type, execution_price, quantity)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [order.id, order.user_id, order.symbol, order.type, executionPrice, order.quantity]
            );

            // 3. Update Position
            const [posRows] = await connection.execute(
                'SELECT * FROM paper_positions WHERE user_id = ? AND symbol = ?',
                [order.user_id, order.symbol]
            );

            if (posRows.length > 0) {
                const pos = posRows[0];
                let newQty, newAvgPrice;

                if (order.type === 'BUY') {
                    newQty = pos.quantity + order.quantity;
                    newAvgPrice = ((pos.quantity * pos.avg_price) + (order.quantity * executionPrice)) / newQty;
                } else {
                    newQty = pos.quantity - order.quantity;
                    newAvgPrice = pos.avg_price; // Avg price usually doesn't change on SELL
                }

                await connection.execute(
                    'UPDATE paper_positions SET quantity = ?, avg_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                    [newQty, newAvgPrice, pos.id]
                );
            } else {
                // New position
                await connection.execute(
                    'INSERT INTO paper_positions (user_id, symbol, quantity, avg_price) VALUES (?, ?, ?, ?)',
                    [order.user_id, order.symbol, order.quantity * (order.type === 'BUY' ? 1 : -1), executionPrice]
                );
            }

            // 4. Update User Balance (Assume simple deduction for now)
            const totalCost = executionPrice * order.quantity;
            if (order.type === 'BUY') {
                await connection.execute(
                    'UPDATE users SET balance = balance - ? WHERE id = ?',
                    [totalCost, order.user_id]
                );
            } else {
                await connection.execute(
                    'UPDATE users SET balance = balance + ? WHERE id = ?',
                    [totalCost, order.user_id]
                );
            }

            await connection.commit();

            // 5. Notify user via Socket
            const io = socketManager.getIo();
            if (io) {
                io.to(`user:${order.user_id}`).emit('order_update', {
                    orderId: order.id,
                    status: 'EXECUTED',
                    symbol: order.symbol,
                    type: order.type,
                    price: executionPrice
                });
            }
        } catch (err) {
            await connection.rollback();
            console.error(`❌ Execution failed for order ${order.id}:`, err.message);
        }
    }

    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }
}

module.exports = new PaperTradingEngine();
