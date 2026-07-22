const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');
const { authMiddleware } = require('../middleware/auth');

router.get('/live-m2m', authMiddleware, dashboardController.getClientLiveM2M);
router.get('/live-market', authMiddleware, dashboardController.getLiveMarket);
router.get('/broker-m2m', authMiddleware, dashboardController.getBrokerM2M);
router.get('/market-watch', authMiddleware, dashboardController.getMarketWatch);
router.get('/indices', authMiddleware, dashboardController.getIndices);
router.get('/watchlist', authMiddleware, dashboardController.getWatchlist);

// ── Get all scrips with lot sizes (for app to use instead of hardcoded INSTRUMENT_META) ──
router.get('/scrips', async (req, res) => {
    try {
        const db = require('../utils/db');
        const [scrips] = await db.execute('SELECT symbol, lot_size FROM scrip_data ORDER BY symbol');

        // Convert to map for easy lookup: { GOLD: 100, SILVER: 30, ... }
        const scripMap = {};
        scrips.forEach(s => {
            scripMap[s.symbol.toUpperCase()] = parseFloat(s.lot_size || 1);
        });

        res.json(scripMap);
    } catch (err) {
        console.error('Error fetching scrips:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

module.exports = router;
