const db = require('../config/db');

class CommodityLotService {
    constructor() {
        this.cache = new Map(); // cleanSymbol -> { lot_size, usdinr_value, category }
        this.isLoaded = false;
    }

    async load() {
        try {
            const [rows] = await db.query('SELECT symbol, category, lot_size, usdinr_value FROM commodity_forex_crypto_lot_sizes');
            this.cache.clear();
            for (const row of rows) {
                const clean = this.cleanSymbol(row.symbol);
                this.cache.set(clean, {
                    symbol: row.symbol,
                    category: (row.category || '').toUpperCase(),
                    lot_size: parseFloat(row.lot_size || 1),
                    usdinr_value: parseFloat(row.usdinr_value || 95.1)
                });
            }
            this.isLoaded = true;
            console.log(`💼 Commodity/Forex Lot Sizes loaded: ${this.cache.size} symbols cached.`);
        } catch (err) {
            console.error('❌ Error loading commodity/forex lot sizes:', err.message);
        }
    }

    cleanSymbol(symbol) {
        if (!symbol) return '';
        let clean = symbol.toUpperCase();
        const prefixes = ['COMMODITY:', 'FOREX:', 'CRYPTO:', 'MCX:', 'NSE:', 'NFO:', 'COMEX:'];
        let changed = true;
        while (changed) {
            changed = false;
            for (const p of prefixes) {
                if (clean.startsWith(p)) {
                    clean = clean.substring(p.length);
                    changed = true;
                }
            }
        }
        return clean;
    }

    getLotInfo(symbol) {
        if (!symbol) return null;
        const clean = this.cleanSymbol(symbol);
        return this.cache.get(clean) || null;
    }

    /**
     * Checks if a symbol or market type belongs to COMMODITY category from the DB config
     */
    isCommodityScrip(symbol, marketType) {
        const info = this.getLotInfo(symbol);
        if (info) {
            const cat = (info.category || '').toUpperCase();
            if (cat === 'COMMODITY' || cat === 'FOREX' || cat === 'CRYPTO') {
                return true;
            }
        }
        const mType = (marketType || '').toUpperCase();
        return mType === 'COMMODITY' || mType === 'FOREX' || mType === 'CRYPTO';
    }

    /**
     * Calculate PnL for COMMODITY using live USD/INR bid/ask from MarketDataService.
     * - Loss  → use bid  (which FastForex sets as ltp × 1.10)
     * - Profit → use ask (which FastForex sets as ltp × 0.90)
     * Falls back to DB usdinr_value if live data is unavailable.
     */
    calculatePnL(symbol, type, entryPrice, cmp, qty) {
        const info = this.getLotInfo(symbol);
        const lotSize = info ? info.lot_size : 1;
        const fallbackUsdInr = info ? info.usdinr_value : 95.1;

        // Get live USD/INR bid & ask from MarketDataService
        let liveBid = null;
        let liveAsk = null;
        try {
            const marketDataService = require('./MarketDataService');
            if (marketDataService && marketDataService.prices) {
                const liveUsdInr = marketDataService.prices['FOREX:USD/INR'] || marketDataService.prices['FOREX:USDINR'];
                if (liveUsdInr) {
                    liveBid = parseFloat(liveUsdInr.bid) || null; // ltp × 1.10 (set by FastForex)
                    liveAsk = parseFloat(liveUsdInr.ask) || null; // ltp × 0.90 (set by FastForex)
                }
            }
        } catch (e) {
            // Silently fall back
        }

        const cmpNum = parseFloat(cmp || 0);
        const entryNum = parseFloat(entryPrice || 0);
        const qtyNum = parseFloat(qty || 0);

        let pnlUsd = 0;
        if (type.toUpperCase() === 'BUY') {
            pnlUsd = (cmpNum - entryNum) * lotSize * qtyNum;
        } else {
            pnlUsd = (entryNum - cmpNum) * lotSize * qtyNum;
        }

        // Loss  → bid  (ltp × 1.10) — higher rate, user pays more on loss
        // Profit → ask (ltp × 0.90) — lower rate, user gets less on profit
        let usdInrVal;
        if (pnlUsd > 0) {
            usdInrVal = liveAsk || (fallbackUsdInr * 0.90);
        } else {
            usdInrVal = liveBid || (fallbackUsdInr * 1.10);
        }

        const pnlInr = pnlUsd * usdInrVal;
        return {
            pnlUsd,
            pnlInr,
            lotSize,
            usdInr: usdInrVal
        };
    }
}

module.exports = new CommodityLotService();
