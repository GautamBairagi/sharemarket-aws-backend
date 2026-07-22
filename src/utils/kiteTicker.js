const { KiteTicker } = require('kiteconnect');
const kiteService = require('./kiteService');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const API_KEY = process.env.KITE_API_KEY;
const INSTRUMENTS_CACHE = path.join(__dirname, '../data/instruments_cache.json');
const SUBSCRIPTIONS_FILE = path.join(__dirname, '../data/subscribed_instruments.json');

// Symbols we want to subscribe for live prices
const MCX_SYMBOLS = ['GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'CRUDEOIL', 'COPPER', 'NICKEL', 'ZINC', 'LEAD', 'ALUMINIUM', 'ALUMINI', 'NATURALGAS', 'MENTHAOIL', 'COTTON'];
const NSE_INDEX_SYMBOLS = ['NIFTY 50', 'NIFTY BANK', 'NIFTY FIN SERVICE', 'NIFTY MIDCAP 50'];
const NSE_STOCK_SYMBOLS = ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'SBIN', 'BHARTIARTL', 'KOTAKBANK', 'ITC', 'LT', 'TATAMOTORS', 'TATASTEEL', 'AXISBANK', 'WIPRO', 'BAJFINANCE'];

class KiteTickerService extends EventEmitter {
    constructor() {
        super();
        this.ticker = null;
        this.connected = false;
        this.prices = {};
        this.subscribedTokens = [];
        this.instrumentMap = {}; // token -> { symbol, exchange, name, lot_size, expiry }
        this.symbolToToken = {}; // symbol -> token (reverse map)
        this.reconnectTimer = null;
        this.fallbackToMock = false;
    }

    async start() {
        try {
            const accessToken = kiteService.accessToken;
            if (!accessToken || !API_KEY) {
                console.log('⚠️  Kite credentials not available, falling back to mock engine');
                this.fallbackToMock = true;
                return false;
            }

            // Fetch real instrument tokens from Zerodha
            await this.fetchAndMapInstruments();

            this.ticker = new KiteTicker({
                api_key: API_KEY,
                access_token: accessToken,
            });

            this.ticker.autoReconnect(true, 50, 5);

            this.ticker.on('ticks', (ticks) => {
                this.processTicks(ticks);
            });

            this.ticker.on('connect', () => {
                console.log('✅ Kite Ticker WebSocket Connected');
                this.connected = true;

                if (this.subscribedTokens.length > 0) {
                    this.ticker.subscribe(this.subscribedTokens);
                    this.ticker.setMode(this.ticker.modeFull, this.subscribedTokens);
                    console.log(`📊 Subscribed to ${this.subscribedTokens.length} instruments`);
                }
            });

            this.ticker.on('disconnect', () => {
                console.log('❌ Kite Ticker Disconnected');
                this.connected = false;
            });

            this.ticker.on('error', (err) => {
                const errMsg = err?.message || String(err);
                if (errMsg.includes('403') || errMsg.includes('Forbidden') || errMsg.includes('expired') || errMsg.includes('Token')) {
                    console.log('⛔ Kite Ticker 403 / token expired — stopping reconnect');
                    try { this.ticker.autoReconnect(false); } catch(e) {}
                    this.connected = false;
                    this.fallbackToMock = true;
                    try { this.ticker.disconnect(); } catch(e) {}
                    return;
                }
                console.error('Kite Ticker Error:', errMsg);
            });

            this.ticker.on('reconnect', (retries) => {
                console.log(`🔄 Kite Ticker reconnecting... attempt ${retries}`);
            });

            this.ticker.on('noreconnect', () => {
                console.log('⛔ Kite Ticker max reconnect attempts reached');
                this.connected = false;
                this.fallbackToMock = true;
            });

            this.ticker.connect();
            return true;
        } catch (err) {
            console.error('Failed to start Kite Ticker:', err.message);
            this.fallbackToMock = true;
            return false;
        }
    }

    // ── Fetch real instruments from Zerodha and map tokens ──
    async fetchAndMapInstruments() {
        try {
            let instruments = null;

            // Check cache (valid for today only — instruments change daily for futures)
            if (fs.existsSync(INSTRUMENTS_CACHE)) {
                const cached = JSON.parse(fs.readFileSync(INSTRUMENTS_CACHE, 'utf8'));
                const cachedDate = new Date(cached.date || 0).toDateString();
                if (cachedDate === new Date().toDateString() && cached.data?.length > 0) {
                    instruments = cached.data;
                    console.log(`📂 Using cached instruments (${instruments.length} items)`);
                }
            }

            // Fetch fresh from Zerodha if no cache
            if (!instruments) {
                console.log('📡 Fetching instruments from Zerodha...');
                const allInstruments = await kiteService.getInstruments();

                if (Array.isArray(allInstruments) && allInstruments.length > 0) {
                    instruments = allInstruments;

                    // Cache to file
                    const dataDir = path.join(__dirname, '../data');
                    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
                    fs.writeFileSync(INSTRUMENTS_CACHE, JSON.stringify({
                        date: new Date().toISOString(),
                        count: instruments.length,
                        data: instruments
                    }));
                    console.log(`💾 Cached ${instruments.length} instruments`);
                } else {
                    console.log('⚠️  No instruments received, using saved subscriptions');
                    this.loadSavedSubscriptions();
                    return;
                }
            }

            // Build maps
            this.instrumentMap = {};
            this.symbolToToken = {};
            this.subscribedTokens = [];

            // ── MCX Futures (nearest expiry) ──
            const mcxInstruments = instruments.filter(i => i.exchange === 'MCX' && i.instrument_type === 'FUT');
            for (const sym of MCX_SYMBOLS) {
                const matches = mcxInstruments
                    .filter(i => i.name === sym || i.tradingsymbol?.startsWith(sym))
                    .sort((a, b) => new Date(a.expiry) - new Date(b.expiry));

                // Pick nearest expiry that hasn't expired yet
                const now = new Date();
                const nearest = matches.find(m => new Date(m.expiry) >= now) || matches[0];

                if (nearest) {
                    const token = nearest.instrument_token;
                    this.instrumentMap[token] = {
                        symbol: sym,
                        tradingsymbol: nearest.tradingsymbol,
                        exchange: 'MCX',
                        lot_size: nearest.lot_size,
                        expiry: nearest.expiry,
                    };
                    this.symbolToToken[sym] = token;
                    this.subscribedTokens.push(token);
                }
            }

            // ── NSE Indices ──
            const nseIndices = instruments.filter(i => i.exchange === 'NSE' && i.segment === 'INDICES');
            for (const sym of NSE_INDEX_SYMBOLS) {
                const match = nseIndices.find(i => i.name === sym || i.tradingsymbol === sym);
                if (match) {
                    const token = match.instrument_token;
                    this.instrumentMap[token] = {
                        symbol: sym,
                        tradingsymbol: match.tradingsymbol,
                        exchange: 'NSE',
                    };
                    this.symbolToToken[sym] = token;
                    this.subscribedTokens.push(token);
                }
            }

            // ── NSE Stocks ──
            const nseStocks = instruments.filter(i => i.exchange === 'NSE' && i.instrument_type === 'EQ');
            for (const sym of NSE_STOCK_SYMBOLS) {
                const match = nseStocks.find(i => i.tradingsymbol === sym);
                if (match) {
                    const token = match.instrument_token;
                    this.instrumentMap[token] = {
                        symbol: sym,
                        tradingsymbol: match.tradingsymbol,
                        exchange: 'NSE',
                    };
                    this.symbolToToken[sym] = token;
                    this.subscribedTokens.push(token);
                }
            }

            // Save subscriptions
            this.saveSubscriptions();

            console.log(`✅ Mapped ${this.subscribedTokens.length} instruments for live prices:`);
            console.log(`   MCX: ${MCX_SYMBOLS.filter(s => this.symbolToToken[s]).join(', ')}`);
            console.log(`   NSE Indices: ${NSE_INDEX_SYMBOLS.filter(s => this.symbolToToken[s]).join(', ')}`);
            console.log(`   NSE Stocks: ${NSE_STOCK_SYMBOLS.filter(s => this.symbolToToken[s]).join(', ')}`);

        } catch (err) {
            console.error('Error fetching instruments:', err.message);
            this.loadSavedSubscriptions();
        }
    }

    processTicks(ticks) {
        const priceUpdate = {};

        ticks.forEach(tick => {
            const info = this.instrumentMap[tick.instrument_token];
            const symbol = info?.symbol || info?.tradingsymbol || `TOKEN_${tick.instrument_token}`;

            this.prices[symbol] = {
                ltp: tick.last_price,
                open: tick.ohlc?.open || 0,
                high: tick.ohlc?.high || 0,
                low: tick.ohlc?.low || 0,
                close: tick.ohlc?.close || 0,
                volume: tick.volume_traded || tick.volume || 0,
                change: tick.change || 0,
                buyQty: tick.total_buy_quantity || 0,
                sellQty: tick.total_sell_quantity || 0,
                oi: tick.oi || 0,
                timestamp: tick.exchange_timestamp || new Date(),
                exchange: info?.exchange || '',
                tradingsymbol: info?.tradingsymbol || symbol,
                lot_size: info?.lot_size || 1,
            };

            // Backward compatible format: { GOLD: 72540, SILVER: 89000 }
            priceUpdate[symbol] = tick.last_price;
        });

        this.emit('update', priceUpdate);
        this.emit('full_update', this.prices);
    }

    // Subscribe to additional instruments by token
    subscribe(tokens) {
        if (!Array.isArray(tokens)) tokens = [tokens];
        tokens.forEach(t => {
            if (!this.subscribedTokens.includes(t)) this.subscribedTokens.push(t);
        });
        if (this.connected && this.ticker) {
            this.ticker.subscribe(tokens);
            this.ticker.setMode(this.ticker.modeFull, tokens);
        }
        this.saveSubscriptions();
    }

    unsubscribe(tokens) {
        if (!Array.isArray(tokens)) tokens = [tokens];
        this.subscribedTokens = this.subscribedTokens.filter(t => !tokens.includes(t));
        if (this.connected && this.ticker) {
            this.ticker.unsubscribe(tokens);
        }
        this.saveSubscriptions();
    }

    setInstrumentMap(map) {
        this.instrumentMap = { ...this.instrumentMap, ...map };
    }

    loadSavedSubscriptions() {
        try {
            if (fs.existsSync(SUBSCRIPTIONS_FILE)) {
                const saved = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8'));
                if (saved.tokens) this.subscribedTokens = saved.tokens;
                if (saved.map) this.instrumentMap = saved.map;
                if (saved.symbolToToken) this.symbolToToken = saved.symbolToToken;
                console.log(`📂 Loaded ${this.subscribedTokens.length} saved subscriptions`);
            }
        } catch (err) {
            console.error('Error loading saved subscriptions:', err.message);
        }
    }

    saveSubscriptions() {
        try {
            const dataDir = path.join(__dirname, '../data');
            if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
            fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify({
                tokens: this.subscribedTokens,
                map: this.instrumentMap,
                symbolToToken: this.symbolToToken,
                updatedAt: new Date().toISOString()
            }, null, 2));
        } catch (err) {
            console.error('Error saving subscriptions:', err.message);
        }
    }

    getPrices() { return this.prices; }
    getPrice(symbol) { return this.prices[symbol]?.ltp || null; }
    getFullPrice(symbol) { return this.prices[symbol] || null; }
    isConnected() { return this.connected; }
    getSymbolToToken() { return this.symbolToToken; }

    disconnect() {
        if (this.ticker) {
            this.ticker.disconnect();
            this.connected = false;
            this.ticker = null;
        }
    }
}

module.exports = new KiteTickerService();
