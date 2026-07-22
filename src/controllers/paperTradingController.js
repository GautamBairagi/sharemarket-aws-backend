const orderService = require('../services/OrderService');
const portfolioService = require('../services/PortfolioService');
const gttService = require('../services/GTTService');
const historicalDataService = require('../services/HistoricalDataService');

/**
 * Main Controller for Paper Trading Platform features.
 */
class PaperTradingController {
    
    // ── Orders ──
    
    placeOrder = async (req, res) => {
        try {
            const userId = req.user.id;
            const orderId = await orderService.placeOrder(userId, req.body);
            res.json({ success: true, orderId, message: 'Order placed successfully' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    getOrders = async (req, res) => {
        try {
            const userId = req.user.id;
            const orders = await orderService.getOrders(userId);
            res.json(orders);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    cancelOrder = async (req, res) => {
        try {
            const userId = req.user.id;
            const { id } = req.params;
            await orderService.cancelOrder(id, userId);
            res.json({ success: true, message: 'Order cancelled' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    // ── Portfolio ──

    getPositions = async (req, res) => {
        try {
            const userId = req.user.id;
            const positions = await portfolioService.getPositions(userId);
            res.json(positions);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    getHoldings = async (req, res) => {
        try {
            const userId = req.user.id;
            const holdings = await portfolioService.getHoldings(userId);
            res.json(holdings);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    // ── GTT ──

    placeGTT = async (req, res) => {
        try {
            const userId = req.user.id;
            const gttId = await gttService.placeGTT(userId, req.body);
            res.json({ success: true, gttId, message: 'GTT Trigger created' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    getGTTs = async (req, res) => {
        try {
            const userId = req.user.id;
            const gtts = await gttService.getGTTs(userId);
            res.json(gtts);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    // ── Historical ──

    getHistorical = async (req, res) => {
        try {
            const userId = req.user.id;
            const { instrumentToken, interval } = req.params;
            const { from, to } = req.query;
            const data = await historicalDataService.getHistoricalData(userId, instrumentToken, interval, from, to);
            res.json(data);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }
}

module.exports = new PaperTradingController();
