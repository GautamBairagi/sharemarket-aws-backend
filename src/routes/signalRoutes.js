const express = require('express');
const router = express.Router();
const { createSignal, getActiveSignals, closeSignal } = require('../controllers/signalController');
const { authMiddleware, roleMiddleware } = require('../middleware/auth');

router.get('/', authMiddleware, getActiveSignals);
router.post('/create', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), createSignal);
router.put('/:id/close', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), closeSignal);

module.exports = router;
