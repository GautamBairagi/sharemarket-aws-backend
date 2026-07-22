const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const marketDataService = require('../services/MarketDataService');

const router = express.Router();

// ── GET /api/market-data/crypto ──
router.get('/crypto', authMiddleware, async (req, res) => {
    try {
        // Serve from MarketDataService in-memory cache (populated by Binance REST + WebSocket)
        const cached = marketDataService.getCryptoPrices();
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
        const cached = marketDataService.getForexPrices();
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
        const cached = marketDataService.getCommodityPrices();
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
        const crypto = marketDataService.getCryptoPrices();
        const forex = marketDataService.getForexPrices();
        const commodity = marketDataService.getCommodityPrices();
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
