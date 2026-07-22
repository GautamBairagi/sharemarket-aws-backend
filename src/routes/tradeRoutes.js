const express = require('express');
const router = express.Router();
const { placeOrder, getTrades, getTradeById, getGroupTrades, getActivePositions, closeTrade, deleteTrade, updateTrade, restoreTrade, modifyPendingOrder, setTargetSL, completePendingOrder } = require('../controllers/tradeController');
const { authMiddleware, roleMiddleware, brokerPermission } = require('../middleware/auth');

router.get('/health', (req, res) => res.json({ status: 'OK', message: 'Trade routes active' }));
router.get('/group', authMiddleware, getGroupTrades);
router.get('/active', authMiddleware, getActivePositions);
router.get('/closed', authMiddleware, getTrades);

router.get('/', authMiddleware, getTrades);
router.get('/:id', authMiddleware, getTradeById);

router.post('/', authMiddleware, brokerPermission('tradeActivityAllowed'), placeOrder);
router.post('/place', authMiddleware, brokerPermission('tradeActivityAllowed'), placeOrder);

router.put('/:id/close', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN', 'BROKER', 'TRADER']), closeTrade);
router.put('/:id/target-sl', authMiddleware, setTargetSL);
router.put('/:id/modify', authMiddleware, modifyPendingOrder);
router.put('/:id/complete', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN', 'BROKER']), completePendingOrder);
router.put('/:id', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), updateTrade);
router.put('/:id/restore', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), restoreTrade);
router.delete('/:id', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), deleteTrade);

module.exports = router;
