const db = require('../config/db');

/**
 * Repository for managing Paper Orders in MySQL.
 */
class OrderRepository {
    async createOrder(userId, orderData) {
        const { symbol, type, order_type, price, quantity } = orderData;
        const [result] = await db.execute(
            `INSERT INTO paper_orders (user_id, symbol, type, order_type, price, quantity, status)
             VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
            [userId, symbol, type, order_type, price, quantity]
        );
        return result.insertId;
    }

    async getOrdersByUserId(userId) {
        const [rows] = await db.execute(
            'SELECT * FROM paper_orders WHERE user_id = ? ORDER BY created_at DESC',
            [userId]
        );
        return rows;
    }

    async cancelOrder(orderId, userId) {
        await db.execute(
            "UPDATE paper_orders SET status = 'CANCELLED' WHERE id = ? AND user_id = ? AND status = 'PENDING'",
            [orderId, userId]
        );
    }

    async getOrderById(orderId) {
        const [rows] = await db.execute('SELECT * FROM paper_orders WHERE id = ?', [orderId]);
        return rows[0] || null;
    }
}

module.exports = new OrderRepository();
