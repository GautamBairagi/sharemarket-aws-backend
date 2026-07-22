const express = require('express');
const router = express.Router();
const portfolioController = require('../controllers/portfolioController');
const { authMiddleware } = require('../middleware/auth');

router.get('/balance', authMiddleware, portfolioController.getBalance);
router.get('/ledger', authMiddleware, portfolioController.getLedger);
router.post('/transfer', authMiddleware, portfolioController.internalTransfer);

module.exports = router;
