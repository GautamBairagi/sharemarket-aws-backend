const express = require('express');
const router = express.Router();
const controller = require('../controllers/paperTradingController');
const { authMiddleware } = require('../middleware/auth');

/**
 * Routes for the Paper Trading Platform.
 */

// Orders
router.post('/orders', authMiddleware, controller.placeOrder);
router.get('/orders', authMiddleware, controller.getOrders);
router.delete('/orders/:id', authMiddleware, controller.cancelOrder);

// Portfolio
router.get('/positions', authMiddleware, controller.getPositions);
router.get('/holdings', authMiddleware, controller.getHoldings);

// GTT
router.post('/gtt', authMiddleware, controller.placeGTT);
router.get('/gtt', authMiddleware, controller.getGTTs);

// Historical Data
router.get('/historical/:instrumentToken/:interval', authMiddleware, controller.getHistorical);

module.exports = router;
