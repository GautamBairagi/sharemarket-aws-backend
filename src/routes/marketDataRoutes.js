const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const marketDataService = require('../services/MarketDataService');
const { getClientAllowedSegments } = require('../utils/segmentPermissionHelper');
const { getUserBannedScripsStatus, checkSymbolHidden, checkSymbolMarked } = require('../utils/bannedHelper');

const router = express.Router();

// Helper to filter and mark items according to role-based banned sets
function processBannedScrips(items, hideSet, markSet) {
    if (!items || !items.length) return [];
    return items
        .filter(item => {
            const sym = item.symbol || '';
            const name = item.name || '';
            return !checkSymbolHidden(sym, hideSet) && !checkSymbolHidden(name, hideSet);
        })
        .map(item => {
            const sym = item.symbol || '';
            const name = item.name || '';
            if (checkSymbolMarked(sym, markSet) || checkSymbolMarked(name, markSet)) {
                return { ...item, isBanned: true };
            }
            return item;
        });
}

// ── GET /api/market-data/crypto ──
router.get('/crypto', authMiddleware, async (req, res) => {
    try {
        const allowed = await getClientAllowedSegments(req.user?.id, req.user?.role);
        let cached = allowed.CRYPTO ? marketDataService.getCryptoPrices() : [];

        const { hideSet, markSet } = await getUserBannedScripsStatus(req.user?.id, req.user?.role);
        cached = processBannedScrips(cached, hideSet, markSet);

        res.json({ 
            status: 'success', 
            type: 'crypto', 
            count: cached.length, 
            timestamp: new Date().toISOString(), 
            data: cached 
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ── GET /api/market-data/forex ──
router.get('/forex', authMiddleware, async (req, res) => {
    try {
        const allowed = await getClientAllowedSegments(req.user?.id, req.user?.role);
        let cached = allowed.FOREX ? marketDataService.getForexPrices() : [];

        const { hideSet, markSet } = await getUserBannedScripsStatus(req.user?.id, req.user?.role);
        cached = processBannedScrips(cached, hideSet, markSet);

        res.json({ 
            status: 'success', 
            type: 'forex', 
            count: cached.length, 
            timestamp: new Date().toISOString(), 
            data: cached 
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ── GET /api/market-data/commodity ──
router.get('/commodity', authMiddleware, async (req, res) => {
    try {
        const allowed = await getClientAllowedSegments(req.user?.id, req.user?.role);
        let cached = allowed.COMMODITY ? marketDataService.getCommodityPrices() : [];

        const { hideSet, markSet } = await getUserBannedScripsStatus(req.user?.id, req.user?.role);
        cached = processBannedScrips(cached, hideSet, markSet);

        res.json({ 
            status: 'success', 
            type: 'commodity', 
            count: cached.length, 
            timestamp: new Date().toISOString(), 
            data: cached 
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ── GET /api/market-data/all — Both in one call ──
router.get('/all', authMiddleware, async (req, res) => {
    try {
        const allowed = await getClientAllowedSegments(req.user?.id, req.user?.role);
        let crypto = allowed.CRYPTO ? marketDataService.getCryptoPrices() : [];
        let forex = allowed.FOREX ? marketDataService.getForexPrices() : [];
        let commodity = allowed.COMMODITY ? marketDataService.getCommodityPrices() : [];

        const { hideSet, markSet } = await getUserBannedScripsStatus(req.user?.id, req.user?.role);
        crypto = processBannedScrips(crypto, hideSet, markSet);
        forex = processBannedScrips(forex, hideSet, markSet);
        commodity = processBannedScrips(commodity, hideSet, markSet);

        res.json({ 
            status: 'success', 
            timestamp: new Date().toISOString(), 
            crypto, 
            forex,
            commodity
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
