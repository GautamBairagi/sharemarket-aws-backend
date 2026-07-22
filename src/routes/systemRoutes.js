const express = require('express');
const router = express.Router();
const { getActionLedger, globalBatchUpdate, getSegmentValues, resetSegmentValues } = require('../controllers/systemController');
const { getAllScrips, syncKiteInstruments, updateScrip, getTickers, createTicker, updateTicker, deleteTicker } = require('../controllers/scripController');
const { getBannedOrders, createBannedOrder, deleteBannedOrder, deleteMultipleBannedOrders, getBannedScrips, toggleBannedScrip, bulkToggleBannedScrips } = require('../controllers/bannedController');
const { getExpiryRules, updateExpiryRules } = require('../controllers/expiryController');
const { authMiddleware, roleMiddleware } = require('../middleware/auth');

router.get('/ping', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now(), platform: 'Railway / Node.js' });
});

// Debug: Refresh market data cache (clears duplicates) - NO AUTH for quick fixes
router.get('/debug/refresh-market-data', async (req, res) => {
    try {
        const marketDataService = require('../services/MarketDataService');
        console.log('[DEBUG] Manual refresh triggered');
        await marketDataService.refreshSymbolLists();
        res.json({
            status: 'success',
            message: '✅ Market data refreshed - duplicates cleared',
            timestamp: Date.now()
        });
    } catch (err) {
        console.error('[DEBUG] Refresh error:', err.message);
        res.status(500).json({
            status: 'error',
            message: err.message
        });
    }
});

// Refresh market data cache (clears duplicates) - with auth
router.post('/refresh-market-data', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), async (req, res) => {
    try {
        const marketDataService = require('../services/MarketDataService');
        await marketDataService.refreshSymbolLists();
        res.json({
            status: 'success',
            message: 'Market data refreshed, duplicates cleared',
            timestamp: Date.now()
        });
    } catch (err) {
        res.status(500).json({
            status: 'error',
            message: err.message
        });
    }
});

router.get('/audit-log', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), getActionLedger);
router.post('/global-update', authMiddleware, roleMiddleware(['SUPERADMIN']), globalBatchUpdate);
router.get('/segment-values', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), getSegmentValues);
router.post('/reset-segment', authMiddleware, roleMiddleware(['SUPERADMIN']), resetSegmentValues);

// Scrip & Ticker Management
router.get('/scrips', authMiddleware, getAllScrips);
router.post('/scrips/sync', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), syncKiteInstruments);
router.put('/scrips', authMiddleware, roleMiddleware(['SUPERADMIN']), updateScrip);
router.get('/tickers', authMiddleware, getTickers);
router.post('/tickers', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), createTicker);
router.put('/tickers/:id', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), updateTicker);
router.delete('/tickers/:id', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), deleteTicker);

// Expiry Rules
router.get('/expiry-rules', authMiddleware, getExpiryRules);
router.put('/expiry-rules', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), updateExpiryRules);

// Banned Limit Orders
router.get('/banned-orders', authMiddleware, getBannedOrders);
router.post('/banned-orders', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), createBannedOrder);
router.delete('/banned-orders/:id', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), deleteBannedOrder);
router.post('/banned-orders/delete-multiple', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), deleteMultipleBannedOrders);

// Permanent Banned Scrips
router.get('/banned-scrips', authMiddleware, getBannedScrips);
router.post('/banned-scrips/toggle', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), toggleBannedScrip);
router.post('/banned-scrips/bulk-toggle', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), bulkToggleBannedScrips);

module.exports = router;
