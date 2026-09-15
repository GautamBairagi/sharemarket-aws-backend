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

// ── Get all scrips with lot sizes from DB (commodity_forex_crypto_lot_sizes + scrip_data) ──
router.get('/scrips', async (req, res) => {
    try {
        const db = require('../config/db');
        const [cflRows] = await db.execute('SELECT symbol, lot_size FROM commodity_forex_crypto_lot_sizes');
        const [scrips] = await db.execute('SELECT symbol, lot_size FROM scrip_data ORDER BY symbol');

        const scripMap = {};

        // 1. Commodity / Forex / Crypto lot sizes from commodity_forex_crypto_lot_sizes
        cflRows.forEach(s => {
            const sym = s.symbol.toUpperCase();
            const lotVal = parseFloat(s.lot_size || 1);
            scripMap[sym] = lotVal;

            const clean = sym.includes(':') ? sym.split(':')[1] : sym;
            scripMap[clean] = lotVal;

            const norm = clean.replace(/[\s\/\_\-]+/g, '');
            scripMap[norm] = lotVal;
        });

        // 2. Fallback / supplementary lot sizes from scrip_data
        scrips.forEach(s => {
            const sym = s.symbol.toUpperCase();
            const clean = sym.includes(':') ? sym.split(':')[1] : sym;
            const norm = clean.replace(/[\s\/\_\-]+/g, '');
            const lotVal = parseFloat(s.lot_size || 1);

            if (!scripMap[sym]) scripMap[sym] = lotVal;
            if (!scripMap[clean]) scripMap[clean] = lotVal;
            if (!scripMap[norm]) scripMap[norm] = lotVal;
        });

        res.json(scripMap);
    } catch (err) {
        console.error('Error fetching scrips:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

module.exports = router;
