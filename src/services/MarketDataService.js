const { KiteTicker } = require('kiteconnect');
const socketManager = require('../websocket/SocketManager');
const EventEmitter = require('events');
const alertMonitor = require('./alertMonitorService'); // ✅ Import alert monitor

// ── AllTick Integration ──
const allTicksService = require('./allticks.service');

// Global state for symbols loaded from DB
let CRYPTO_SYMBOLS_LIST = [];
let FOREX_SYMBOLS_LIST = [];
let COMMODITY_SYMBOLS_LIST = [];
let SYMBOL_META = {};

/**
 * Optimized MarketDataService
 * - Production-level accuracy for Binance (miniTicker + bookTicker)
 * - Efficient batched broadcasting (150ms)
 * - Memory-efficient state management with prefixed symbols
 * - Intelligent reconnect and error handling
 */
class MarketDataService extends EventEmitter {
    constructor() {
        super();
        this.ticker = null;
        this.isConnecting = false;

        // Unified State Management
        // Key format: "CRYPTO:BTC/USD", "FOREX:XAU/USD", "NSE:RELIANCE"
        this.prices = {};
        this.dirtySymbols = new Set();

        // Subscription Sets
        this.subscribedTokens = new Set();
        this.subscribedSymbols = new Set();
        this.instrumentMap = {}; // token -> Set of symbols

        // AllTick Connection State
        this.allTickInterval = null;

        // Broadcasting Optimization
        this.broadcastInterval = 150; // ms
        this.broadcastTimer = null;

        this._startBroadcastLoop();
    }

    async _loadSymbolsFromDb() {
        try {
            const db = require('../config/db');

            // Load Crypto
            const [cryptoRows] = await db.execute(`
                SELECT symbol FROM market_group_items mgi
                JOIN market_groups mg ON mgi.group_id = mg.id
                WHERE mg.name = 'CRYPTO'
            `);
            CRYPTO_SYMBOLS_LIST = cryptoRows.map(r => r.symbol);
            console.log(`[MarketDataService] Loaded ${CRYPTO_SYMBOLS_LIST.length} crypto symbols from DB`);

            // Load Forex
            const [forexRows] = await db.execute(`
                SELECT symbol FROM market_group_items mgi
                JOIN market_groups mg ON mgi.group_id = mg.id
                WHERE mg.name = 'FOREX'
            `);
            FOREX_SYMBOLS_LIST = forexRows.map(r => r.symbol);
            console.log(`[MarketDataService] Loaded ${FOREX_SYMBOLS_LIST.length} forex symbols from DB`);

            // Load all Commodity symbols (including Mini and Custom variants)
            const [commodityRows] = await db.execute(`
                SELECT symbol FROM market_group_items mgi
                JOIN market_groups mg ON mgi.group_id = mg.id
                WHERE mg.name = 'COMMODITY'
            `);
            COMMODITY_SYMBOLS_LIST = commodityRows.map(r => r.symbol);
            console.log(`[MarketDataService] Loaded ${COMMODITY_SYMBOLS_LIST.length} commodity symbols from DB`);

            // Load All Metadata
            const [metaRows] = await db.execute(`
                SELECT symbol, name, category FROM market_group_items
                WHERE category IS NOT NULL
            `);
            const newMeta = {};
            metaRows.forEach(r => {
                newMeta[r.symbol] = { name: r.name, category: r.category };
            });
            SYMBOL_META = newMeta;
            console.log(`[MarketDataService] Loaded ${Object.keys(SYMBOL_META).length} symbol metadata entries from DB`);
        } catch (err) {
            console.error('❌ Failed to load market data symbols from DB:', err.message);
        }
    }

    async refreshSymbolLists() {
        console.log('[MarketDataService] ♻️ Refreshing symbol lists from database...');
        await this._loadSymbolsFromDb();
        // Also reload AllTicks symbols
        await allTicksService._loadSymbolsFromDb();

        // Clean up prices for symbols no longer in the list
        const validSymbols = new Set();
        CRYPTO_SYMBOLS_LIST.forEach(sym => validSymbols.add(`CRYPTO:${sym}`));
        FOREX_SYMBOLS_LIST.forEach(sym => validSymbols.add(`FOREX:${sym}`));
        COMMODITY_SYMBOLS_LIST.forEach(sym => validSymbols.add(`COMMODITY:${sym}`));

        let removedCount = 0;
        Object.keys(this.prices).forEach(key => {
            if ((key.startsWith('CRYPTO:') || key.startsWith('FOREX:') || key.startsWith('COMMODITY:')) && !validSymbols.has(key)) {
                console.log(`[MarketDataService] Removing orphaned price: ${key}`);
                delete this.prices[key];
                removedCount++;
            }
        });

        console.log(`[MarketDataService] ✅ Symbol lists refreshed (removed ${removedCount} orphaned entries)`);
    }

    /**
     * Start the broadcasting loop to batch updates
     */
    _startBroadcastLoop() {
        if (this.broadcastTimer) return;
        this.broadcastTimer = setInterval(() => {
            if (this.dirtySymbols.size === 0) return;



            const updates = {};
            this.dirtySymbols.forEach(sym => {
                if (this.prices[sym]) {
                    updates[sym] = { ...this.prices[sym] };

                    // ✅ CHECK PRICE ALERTS FOR THIS SYMBOL
                    const ltp = this.prices[sym].ltp || this.prices[sym].price || 0;
                    if (ltp > 0) {
                        const cleanSymbol = sym.includes(':') ? sym.split(':')[1] : sym;
                        alertMonitor.checkAlerts(cleanSymbol, ltp);
                    }
                }
            });

            // ✅ REMOVED MOCK FLUCTUATOR - Only broadcast real API updates
            // This ensures data integrity and prevents price jumps from real-to-mock.

            this.dirtySymbols.clear();

            const io = socketManager.getIo();
            if (io) {
                io.emit('price_update', updates);
                // ✅ Initialize alert monitor with io instance (first time)
                if (!alertMonitor.io) {
                    alertMonitor.init(io);
                }
            }
            this.emit('update', updates);
        }, this.broadcastInterval);
    }

    // ══════════════════════════════════════════════════════
    //   ZERODHA (KITE) INTEGRATION
    // ══════════════════════════════════════════════════════

    async init(userId) {
        if (this.isConnecting) return;
        this.isConnecting = true;
        try {
            // Load crypto/forex/commodity symbols from DB first (required for AllTicks data)
            await this._loadSymbolsFromDb();
            console.log(`[MarketDataService] init() - Crypto: ${CRYPTO_SYMBOLS_LIST.length}, Forex: ${FOREX_SYMBOLS_LIST.length}, Commodity: ${COMMODITY_SYMBOLS_LIST.length}`);

            const repo = require('../repositories/KiteRepository');
            const kiteService = require('../utils/kiteService');
            const userSession = await repo.getSessionByUserId(userId);
            const activeToken = kiteService.accessToken || (userSession ? userSession.access_token : null);

            // 1. Check if Zerodha is configured
            if (!process.env.KITE_API_KEY) {
                console.warn('⚠️ KITE_API_KEY not configured - Zerodha disabled');
                this.isConnecting = false;
                return;
            }

            // 2. Avoid re-initializing if already connected with the same token
            if (this.ticker && this.ticker.connected && this.currentToken === activeToken) {
                this.isConnecting = false;
                return;
            }

            if (!activeToken) {
                console.warn('⚠️ No valid Zerodha session found for user - using mock engine');
                this.isConnecting = false;
                return;
            }

            // 3. Clean up previous ticker if any
            if (this.ticker) {
                try {
                    this.ticker.removeAllListeners();
                    this.ticker.disconnect();
                } catch (e) { }
                this.ticker = null;
            }

            this.currentToken = activeToken;

            const currentTicker = new KiteTicker({
                api_key: process.env.KITE_API_KEY,
                access_token: activeToken
            });

            this.ticker = currentTicker;
            currentTicker.autoReconnect(true, 20, 5);

            let errorOccurred = false;

            currentTicker.on('connect', () => {
                const INDEX_TOKENS = [
                    { token: 256265, symbol: 'NSE:NIFTY 50' },
                    { token: 260105, symbol: 'NSE:NIFTY BANK' },
                    { token: 257801, symbol: 'NSE:NIFTY FIN SERVICE' },
                ];
                INDEX_TOKENS.forEach(i => {
                    const sToken = String(i.token);
                    if (!this.instrumentMap[sToken]) this.instrumentMap[sToken] = new Set();
                    this.instrumentMap[sToken].add(i.symbol);
                    this.subscribedTokens.add(sToken);
                });

                const tokenNums = Array.from(this.subscribedTokens).map(t => parseInt(t, 10)).filter(t => !isNaN(t));
                if (tokenNums.length > 0) {
                    try {
                        currentTicker.subscribe(tokenNums);
                        currentTicker.setMode(currentTicker.modeFull, tokenNums);
                    } catch (subErr) {
                        console.error('⚠️ Subscribe error on connect:', subErr.message);
                    }
                }
            });

            currentTicker.on('ticks', (ticks) => {
                if (Array.isArray(ticks)) {
                    this.handleTicks(ticks);
                }
            });

            currentTicker.on('error', (err) => {
                const errMsg = err?.message || String(err);
                console.error('⚠️ Zerodha Ticker Error:', errMsg);

                if (errMsg.includes('403') || errMsg.includes('Forbidden') || errMsg.includes('expired') || errMsg.includes('Token')) {
                    console.error('❌ Zerodha 403 Forbidden - Access token expired. Disabling auto-reconnect and stopping ticker.');
                    errorOccurred = true;
                    try { currentTicker.autoReconnect(false); } catch (e) { }
                    try { currentTicker.disconnect(); } catch (e) { }
                    if (this.ticker === currentTicker) {
                        this.ticker = null;
                        this.currentToken = null;
                    }
                }
            });

            currentTicker.on('disconnect', () => {
                if (this.ticker === currentTicker && !errorOccurred) {
                    // Only null it if it's the current active ticker and it wasn't a fatal error
                    // Actually, if autoReconnect is on, we might not want to null it here.
                }
            });

            currentTicker.on('noreconnect', () => {
                if (this.ticker === currentTicker) {
                    this.ticker = null;
                    this.currentToken = null;
                }
            });

            try {
                currentTicker.connect();
                await new Promise((resolve) => {
                    setTimeout(() => {
                        if (!currentTicker.connected) {
                            console.error('⏱️ Zerodha Ticker connection timeout');
                        }
                        resolve();
                    }, 10000);
                });
            } catch (connectErr) {
                console.error('❌ Failed to connect Zerodha Ticker:', connectErr.message);
                if (this.ticker === currentTicker) this.ticker = null;
            }
        } catch (err) {
            console.error('⚠️ Zerodha Ticker init failed:', err.message);
        } finally {
            this.isConnecting = false;
        }
    }

    handleTicks(ticks) {
        // Index symbols that don't have order book depth
        const INDEX_SYMBOLS = new Set(['NSE:NIFTY 50', 'NSE:NIFTY BANK', 'NSE:NIFTY FIN SERVICE']);

        ticks.forEach(tick => {
            const token = String(tick.instrument_token);
            const symbols = this.instrumentMap[token] || new Set([token]);

            symbols.forEach(symbol => {
                const prev = this.prices[symbol] || {};

                const buy0 = tick.depth?.buy?.[0]?.price;
                const sell0 = tick.depth?.sell?.[0]?.price;
                const hasBid = buy0 != null && Number.isFinite(Number(buy0));
                const hasAsk = sell0 != null && Number.isFinite(Number(sell0));

                const ltp = tick.last_price != null ? tick.last_price : prev.ltp;
                const isIndex = INDEX_SYMBOLS.has(symbol);

                const data = {
                    ...prev,
                    symbol,
                    ltp,
                    // For indices: no order book, so bid = ask = ltp
                    bid: hasBid ? Number(buy0) : (isIndex ? ltp : (prev.bid || 0)),
                    ask: hasAsk ? Number(sell0) : (isIndex ? ltp : (prev.ask || 0)),
                    change: tick.net_change != null ? tick.net_change : prev.change,
                    volume: tick.volume_traded != null ? tick.volume_traded : prev.volume,
                    ohlc: tick.ohlc && Object.keys(tick.ohlc).length ? tick.ohlc : (prev.ohlc || {}),
                    depth: tick.depth && (tick.depth.buy?.length || tick.depth.sell?.length) ? tick.depth : (prev.depth || {}),
                    type: (symbol.startsWith('NSE') || symbol.startsWith('NFO') || symbol.startsWith('MCX')) ? symbol.split(':')[0] : (prev.type || 'NSE')
                };

                this.prices[symbol] = data;
                this.dirtySymbols.add(symbol);
            });
        });
    }

    subscribe(symbol, token) {
        if (!token) {
            this.subscribedSymbols.add(symbol);
            return;
        }

        const sToken = String(token);
        if (!this.instrumentMap[sToken]) this.instrumentMap[sToken] = new Set();
        this.instrumentMap[sToken].add(symbol);
        this.subscribedTokens.add(sToken);

        if (this.ticker && this.ticker.connected) {
            this.ticker.subscribe([parseInt(sToken)]);
            this.ticker.setMode(this.ticker.modeFull, [parseInt(sToken)]);
        }
    }

    bulkSubscribe(items = []) {
        if (!Array.isArray(items) || items.length === 0) return;

        const tokenNums = [];
        for (const item of items) {
            if (!item?.symbol) continue;
            if (!item.token) {
                this.subscribe(item.symbol);
                continue;
            }

            const sToken = String(item.token);
            if (!this.instrumentMap[sToken]) this.instrumentMap[sToken] = new Set();
            this.instrumentMap[sToken].add(item.symbol);
            this.subscribedTokens.add(sToken);
            tokenNums.push(parseInt(sToken, 10));
        }

        if (this.ticker && this.ticker.connected && tokenNums.length > 0) {
            this.ticker.subscribe(tokenNums);
            this.ticker.setMode(this.ticker.modeFull, tokenNums);
        }
    }

    startMockEngine() {
        // Mock engine disabled - using real feeds only
    }

    stopMockEngine() {
        // Placeholder
    }

    //   ALLTICK INTEGRATION (Crypto & Forex)
    // ══════════════════════════════════════════════════════

    async startCryptoForex() {
        // Refresh symbol lists from cleaned database before starting
        await this.refreshSymbolLists();
        allTicksService.start();
        this._startCryptoForexPush();
    }

    // Push full crypto + forex lists to all socket clients every 1s.
    // Real-time updates for market watch.
    _startCryptoForexPush() {
        if (this._cfPushTimer) return;
        this._cfPushTimer = setInterval(() => {
            try {
                const io = require('../websocket/SocketManager').getIo();
                if (!io) {
                    console.warn('WARN [CryptoForexPush] io instance is null/undefined');
                    return;
                }
                const crypto = this.getCryptoPrices();
                const forex = this.getForexPrices();
                const commodity = this.getCommodityPrices();

                if (crypto.length === 0 && forex.length === 0 && commodity.length === 0) {
                    console.warn('WARN [CryptoForexPush] No crypto, forex or commodity data available');
                    return;
                }

                // DEBUG: Log what we're sending
                if (crypto.length > 0) {
                    // console.log(`[socket] Sending crypto (${crypto.length}): ${crypto[0].symbol} | Bid: ${crypto[0].bid} Ask: ${crypto[0].ask} LTP: ${crypto[0].ltp}`);
                    try {
                        io.emit('market_data_update', { type: 'crypto', data: crypto });
                        // console.log(`[socket] Crypto broadcast emitted successfully`);
                    } catch (emitErr) {
                        console.error(`[socket] Failed to emit crypto data:`, emitErr.message);
                    }
                }
                if (forex.length > 0) {
                    // console.log(`[socket] Sending forex (${forex.length}): ${forex[0].symbol} | Bid: ${forex[0].bid} Ask: ${forex[0].ask} LTP: ${forex[0].ltp}`);
                    try {
                        io.emit('market_data_update', { type: 'forex', data: forex });
                        // console.log(`[socket] Forex broadcast emitted successfully`);
                    } catch (emitErr) {
                        console.error(`[socket] Failed to emit forex data:`, emitErr.message);
                    }
                }
                if (commodity.length > 0) {
                    // console.log(`[socket] Sending commodity (${commodity.length}): ${commodity[0].symbol} | Bid: ${commodity[0].bid} Ask: ${commodity[0].ask} LTP: ${commodity[0].ltp}`);
                    try {
                        io.emit('market_data_update', { type: 'commodity', data: commodity });
                        // console.log(`[socket] Commodity broadcast emitted successfully`);
                    } catch (emitErr) {
                        console.error(`[socket] Failed to emit commodity data:`, emitErr.message);
                    }
                }
            } catch (e) {
                console.error('[CryptoForexPush] Error:', e.message);
            }
        }, 1000);
    }

    stopCryptoForex() {
        allTicksService.stop();
    }

    getPrice(symbol) {
        return this.prices[symbol] || null;
    }

    getPricesBatch(symbols) {
        const result = {};
        if (!Array.isArray(symbols)) return result;
        symbols.forEach(sym => {
            if (this.prices[sym]) result[sym] = this.prices[sym];
        });
        return result;
    }

    getCryptoPrices() {
        if (CRYPTO_SYMBOLS_LIST && CRYPTO_SYMBOLS_LIST.length > 0) {
            return CRYPTO_SYMBOLS_LIST.map(sym => this.prices[`CRYPTO:${sym}`]).filter(Boolean);
        }
        // Fallback: scan prices — keep only slashed symbols to avoid unslashed duplicates
        return Object.values(this.prices).filter(p =>
            p?.symbol?.startsWith('CRYPTO:') && p.symbol.includes('/')
        );
    }

    getForexPrices() {
        if (FOREX_SYMBOLS_LIST && FOREX_SYMBOLS_LIST.length > 0) {
            return FOREX_SYMBOLS_LIST.map(sym => this.prices[`FOREX:${sym}`]).filter(Boolean);
        }
        // Fallback: scan prices — keep only slashed symbols to avoid unslashed duplicates
        return Object.values(this.prices).filter(p =>
            p?.symbol?.startsWith('FOREX:') && p.symbol.includes('/')
        );
    }

    getCommodityPrices() {
        if (COMMODITY_SYMBOLS_LIST && COMMODITY_SYMBOLS_LIST.length > 0) {
            return COMMODITY_SYMBOLS_LIST.map(sym => this.prices[`COMMODITY:${sym}`]).filter(Boolean);
        }
        // Fallback: scan all COMMODITY: prefixed prices
        return Object.values(this.prices).filter(p =>
            p?.symbol?.startsWith('COMMODITY:')
        );
    }

    getBinanceError() {
        // AllTick replaces Binance — no Binance error to report
        return null;
    }

    shutdown() {
        if (this.ticker) {
            this.ticker.disconnect();
            this.ticker = null;
        }
        if (this.broadcastTimer) {
            clearInterval(this.broadcastTimer);
            this.broadcastTimer = null;
        }
        this.stopCryptoForex();
    }
}

module.exports = new MarketDataService();
