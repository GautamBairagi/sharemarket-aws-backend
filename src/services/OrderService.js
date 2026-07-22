const orderRepo = require('../repositories/OrderRepository');
const marketDataService = require('./MarketDataService');

/**
 * Service to handle Order Management logic for Paper Trading.
 */
class OrderService {
    
    async placeOrder(userId, orderData) {
        const { symbol, type, order_type, quantity, price } = orderData;
        
        if (!symbol || !type || !quantity) {
            throw new Error('Missing required order fields');
        }

        // Validate Quantity
        if (quantity <= 0) {
            throw new Error('Quantity must be greater than zero');
        }

        // Validate Balance (simplified check)
        const [userRows] = await require('../config/db').execute(
            'SELECT balance FROM users WHERE id = ?', [userId]
        );
        const userBalance = userRows[0]?.balance || 0;
        
        const currentPrice = marketDataService.getPrice(symbol)?.ltp || price || 0;
        const totalCost = currentPrice * quantity;

        if (type === 'BUY' && userBalance < totalCost) {
            throw new Error(`Insufficient funds. Required: ₹${totalCost.toLocaleString()}, Available: ₹${userBalance.toLocaleString()}`);
        }

        // If MARKET, we can use the current LTP as the set price for records, 
        // though the engine will use live price at execution.
        const orderPrice = order_type === 'MARKET' ? currentPrice : price;

        return await orderRepo.createOrder(userId, {
            symbol,
            type,
            order_type,
            quantity,
            price: orderPrice
        });
    }

    async getOrders(userId) {
        return await orderRepo.getOrdersByUserId(userId);
    }

    async cancelOrder(orderId, userId) {
        return await orderRepo.cancelOrder(orderId, userId);
    }
}

module.exports = new OrderService();
