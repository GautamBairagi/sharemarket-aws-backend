/**
 * AllTick Integration Service
 * ───────────────────────────
 * Realtime Forex & Crypto quotes via AllTick API with real bid/ask spreads.
 *
 * Primary:  WebSocket  wss://quote.alltick.io/quote-b-ws-api?token=TOKEN
 * Fallback: HTTP Poll  https://quote.alltick.io/quote-b-api/depth-tick?token=TOKEN&query=...
 *
 * API Protocol:
 *   depth-tick endpoint provides:
 *     - bids: array of {price, volume} (best bid first)
 *     - asks: array of {price, volume} (best ask first)
 *     - Real market depth data, not calculated spreads
 *
 * WebSocket (optional):
 *   Subscribe   → cmd_id 22004, symbol field: "code"
 *   Push ticks  ← cmd_id 22998
 *   Heartbeat   → cmd_id 22000 | Pong ← cmd_id 22001
 */

const WebSocket = require('ws');
const axios = require('axios');
const { formatForexData } = require('../utils/forexFormatter');
const { formatCryptoData } = require('../utils/cryptoFormatter');
const { formatCommodityData } = require('../utils/commodityFormatter');

const WS_URL = 'wss://quote.alltick.io/quote-b-ws-api';
const HTTP_DEPTH_URL = 'https://quote.alltick.io/quote-b-api/depth-tick';
const HTTP_TRADE_URL = 'https://quote.alltick.io/quote-b-api/trade-tick'; // Real LTP endpoint

class AllTickService {
    constructor() {
        this.ws = null;
        this.pollingInterval = null;
        this.heartbeatInterval = null;
        this.isRunning = false;
        this.isWsConnected = false;
        this.wsDisabled = false; // set true on 401 — stop retrying WS
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;

        this.token = null;

        // Default fallback symbols (will be overridden by DB symbols)
        this.forexSymbols = [
            'AUDCAD', 'EURINR', 'EURUSD', 'GBPINR', 'GBPUSD',
            'USDCHF', 'USDINR', 'USDJPY', 'Silver', 'XAUUSD'
        ];
        // AllTick crypto symbols use USDT suffix (not USD)
        this.cryptoSymbols = [
            'ADAUSDT', 'AVAXUSDT', 'BNBUSDT', 'BTCUSDT', 'DOGEUSDT',
            'DOTUSDT', 'ETHUSDT', 'MATICUSDT', 'SOLUSDT', 'XRPUSDT'
        ];
        // Default fallback commodity symbols (will be overridden by DB symbols)
        this.commoditySymbols = [
            'GOLD', 'Silver', 'USOIL', 'NGAS'
        ];

        this.cache = {};
        this.prevCloseCache = {};
        this.ltpCache = {}; // Real LTP from trade-tick endpoint
        // Maps AllTick codes to DB symbols sharing that code (original + mini only)
        this.commodityMiniMapping = {
            'GOLD':   ['XAU/USD', 'XAUUSDM'],
            'Silver': ['XAG/USD', 'XAGUSDM'],
            'USOIL':  ['USOIL',   'USOILM'],
            'NGAS':   ['NGAS',    'NGASM'],
            'COPPER': ['COPPER',  'COPPERM']
        };
    }

    // Load symbols from database (dynamic, not hardcoded)
    async _loadSymbolsFromDb() {
        try {
            const db = require('../config/db');

            // Load Forex symbols from DB and convert to AllTick format
            const [forexRows] = await db.execute(`
                SELECT symbol FROM market_group_items mgi
                JOIN market_groups mg ON mgi.group_id = mg.id
                WHERE mg.name = 'FOREX'
            `);
            if (forexRows.length > 0) {
                this.forexSymbols = forexRows.map(r => {
                    const sym = r.symbol || '';
                    // Special cases for commodity codes that don't follow standard format
                    if (sym === 'XAU/USD') {
                        return 'GOLD';   // XAU/USD → GOLD (AllTicks code)
                    }
                    if (sym === 'XAG/USD') {
                        return 'Silver';  // XAG/USD → Silver (AllTicks code)
                    }
                    // Convert EUR/USD → EURUSD format for AllTick
                    return sym.replace(/\//g, '');
                }).filter(Boolean);
            }

            // Load Crypto symbols from DB and convert to AllTick format
            const [cryptoRows] = await db.execute(`
                SELECT symbol FROM market_group_items mgi
                JOIN market_groups mg ON mgi.group_id = mg.id
                WHERE mg.name = 'CRYPTO'
            `);
            if (cryptoRows.length > 0) {
                this.cryptoSymbols = cryptoRows.map(r => {
                    // Convert BTC/USD → BTCUSDT format for AllTick
                    const sym = (r.symbol || '').replace(/\/USD$/i, 'USDT').replace(/\//g, '');
                    return sym;
                }).filter(Boolean);
            }

            // Load Commodity symbols from DB and convert to AllTick format
            // Mini/Custom symbols map to the same AllTick code as their parent
            const [commodityRows] = await db.execute(`
                SELECT symbol FROM market_group_items mgi
                JOIN market_groups mg ON mgi.group_id = mg.id
                WHERE mg.name = 'COMMODITY'
            `);
            if (commodityRows.length > 0) {
                const allTickCodes = new Set();
                const miniMapping = {}; // AllTick code → array of DB symbols that share it

                for (const r of commodityRows) {
                    const sym = r.symbol || '';
                    let code = null;

                    // Direct parents
                    if (sym === 'XAU/USD') code = 'GOLD';
                    else if (sym === 'XAG/USD') code = 'Silver';
                    else if (sym === 'USOIL') code = 'USOIL';
                    else if (sym === 'NGAS') code = 'NGAS';
                    else if (sym === 'COPPER') code = 'COPPER';
                    // Mini versions — map to same AllTick code
                    else if (sym === 'XAUUSDM') code = 'GOLD';
                    else if (sym === 'XAGUSDM') code = 'Silver';
                    else if (sym === 'USOILM') code = 'USOIL';
                    else if (sym === 'NGASM') code = 'NGAS';
                    else if (sym === 'COPPERM') code = 'COPPER';

                    if (code) {
                        allTickCodes.add(code);
                        if (!miniMapping[code]) miniMapping[code] = [];
                        miniMapping[code].push(sym);
                    }
                }

                this.commoditySymbols = Array.from(allTickCodes);
                this.commodityMiniMapping = miniMapping; // Store for use in _processTick
            }
        } catch (err) {
            console.error('[ALLTICKS] Failed to load symbols from DB:', err.message);
            // Will use hardcoded fallbacks
        }
    }

    // ─────────────────────────────────────────────────────────
    //  Public API
    // ─────────────────────────────────────────────────────────

    async start() {
        this.token = process.env.ALLTICKS_API_KEY;
        if (!this.token) {
            console.log('[ALLTICKS] ALLTICKS_API_KEY not set — service idle.');
            return;
        }
        if (this.isRunning) return;
        this.isRunning = true;

        // Load symbols from database first (replaces hardcoded list)
        await this._loadSymbolsFromDb();

        console.log(`[ALLTICKS] Starting AllTick Integration Service - Crypto: ${this.cryptoSymbols.length}, Forex: ${this.forexSymbols.length}, Commodity: ${this.commoditySymbols.length}`);
        // Always run HTTP polling (5s) as primary source.
        // WS is attempted in parallel — if it delivers ticks they override HTTP data.
        // This handles plans where WS connects but sends no ticks.
        this._startPolling();
        this._connectWs();
    }

    stop() {
        console.log('[ALLTICKS] Stopping AllTick Integration Service...');
        this.isRunning = false;
        this._closeWs();
        this._stopPolling();
    }

    // ─────────────────────────────────────────────────────────
    //  WebSocket
    // ─────────────────────────────────────────────────────────

    _connectWs() {
        if (!this.isRunning || this.wsDisabled) {
            if (this.wsDisabled) this._startPolling();
            return;
        }

        const url = `${WS_URL}?token=${this.token}`;

        try {
            this.ws = new WebSocket(url);

            // Register error handler FIRST to prevent unhandled errors
            this.ws.on('error', (err) => {
                if (!this.wsDisabled) {
                    console.error('[ALLTICKS] WS Error:', err.message);
                    this.isWsConnected = false;
                    this._startPolling();
                }
            });

            // Handle non-101 upgrade responses (e.g. 401, 429)
            this.ws.on('unexpected-response', (req, res) => {
                const code = res.statusCode;
                if (code === 401) {
                    console.error('[ALLTICKS] WebSocket 401 Unauthorized — token invalid or plan does not include WS. Falling back to HTTP polling permanently.');
                    this.wsDisabled = true;
                } else if (code === 429) {
                    console.warn(`[ALLTICKS] WebSocket 429 Rate Limited. Using HTTP polling instead.`);
                } else {
                    console.error(`[ALLTICKS] WebSocket upgrade failed with HTTP ${code}. Falling back to HTTP polling.`);
                }
                if (this.ws) {
                    this.ws.removeAllListeners();
                    this.ws.on('error', () => { }); // Prevents unhandled error event on close
                    try {
                        if (this.ws.readyState === 0 || this.ws.readyState === 1) {
                            this.ws.close();
                        }
                    } catch (closeErr) {
                        // WebSocket already closed or in invalid state
                    }
                    this.ws = null;
                }
                this._startPolling();
            });

            this.ws.on('open', () => {
                console.log('[ALLTICKS] WebSocket Connected');
                this.isWsConnected = true;
                this.reconnectAttempts = 0;
                this._subscribe();
                this._startHeartbeat();
            });

            this.ws.on('message', (raw) => {
                try {
                    const msg = JSON.parse(raw.toString());
                    this._handleWsMessage(msg);
                } catch (_) { }
            });

            this.ws.on('close', () => {
                if (this.isWsConnected) {
                    console.log('[ALLTICKS] WebSocket Closed');
                }
                this.isWsConnected = false;
                this._stopHeartbeat();
                if (this.isRunning && !this.wsDisabled) {
                    this._retryConnection();
                }
            });
        } catch (err) {
            console.error('[ALLTICKS] WS Connection Exception:', err.message);
            this._startPolling();
        }
    }

    _retryConnection() {
        if (this.wsDisabled) {
            this._startPolling();
            return;
        }
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
            console.log(`[ALLTICKS] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
            setTimeout(() => this._connectWs(), delay);
        } else {
            console.warn('[ALLTICKS] Max WS reconnects reached — switching to HTTP polling permanently.');
            this._startPolling();
        }
    }

    _closeWs() {
        if (this.ws) {
            try {
                this.ws.removeAllListeners();
                this.ws.on('error', () => { }); // Prevents unhandled error event on close
                if (this.ws.readyState !== 3) { // 3 = CLOSED
                    this.ws.close();
                }
            } catch (_) { }
            this.ws = null;
        }
        this.isWsConnected = false;
        this._stopHeartbeat();
    }

    // ─────────────────────────────────────────────────────────
    //  Heartbeat  (request: 22000 | pong from server: 22001)
    // ─────────────────────────────────────────────────────────

    _startHeartbeat() {
        this._stopHeartbeat();
        this.heartbeatInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({
                    cmd_id: 22000,
                    seq_id: Math.floor(Date.now() / 1000) % 1000000,
                    trace: 'hb-' + Date.now(),
                    data: {}
                }));
            }
        }, 10000);
    }

    _stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    // ─────────────────────────────────────────────────────────
    //  Subscription  (cmd_id: 22002, field: "code")
    // ─────────────────────────────────────────────────────────

    _subscribe() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const symbolList = [...this.forexSymbols, ...this.cryptoSymbols, ...this.commoditySymbols]
            .map(sym => ({ code: sym, depth_level: 5 })); // AllTick uses depth_level for depth subscriptions

        const subMsg = {
            cmd_id: 22002,           // 22002 for Order Book (Depth) subscription per AllTick docs
            seq_id: Math.floor(Date.now() / 1000) % 1000000,
            trace: 'sub-' + Date.now(),
            data: { symbol_list: symbolList }
        };

        this.ws.send(JSON.stringify(subMsg));
        console.log(`[ALLTICKS] Subscribed to ${symbolList.length} symbols via WS (Depth Mode)`);
    }

    // ─────────────────────────────────────────────────────────
    //  Message Handling
    //  Server push ticks use cmd_id 22998 (trade tick) or 22999 (depth tick)
    // ─────────────────────────────────────────────────────────

    _handleWsMessage(msg) {
        if (!msg) return;

        if (msg.cmd_id === 22998 || msg.cmd_id === 22999) {
            // Server tick push — data is a single tick object
            if (msg.data) {
                this._processTick(msg.data);
            }
        }
        // cmd_id 22001 = heartbeat pong — ignore silently
        // cmd_id 22003 / 22005 = subscription ack — ignore silently
    }

    // ─────────────────────────────────────────────────────────
    //  Tick Processing
    //  AllTick tick fields: code, price, volume, turnover, tick_time
    // ─────────────────────────────────────────────────────────

    _processTick(tick) {
        if (!tick || !tick.code) return;

        const symbol = tick.code; // AllTick uses "code" not "symbol"
        const isForex = this.forexSymbols.includes(symbol);
        const isCrypto = this.cryptoSymbols.includes(symbol);
        const isCommodity = this.commoditySymbols.includes(symbol);
        if (!isForex && !isCrypto && !isCommodity) return;

        const cached = this.cache[symbol];

        // Extract bid/ask from tick or fallback to cache / calculated spread
        let bid = 0;
        if (Array.isArray(tick.bids) && tick.bids.length > 0) {
            bid = parseFloat(tick.bids[0].price || 0);
        }

        let ask = 0;
        if (Array.isArray(tick.asks) && tick.asks.length > 0) {
            ask = parseFloat(tick.asks[0].price || 0);
        }

        // Get trade price (LTP) from this tick (WebSocket/trade-tick) or cached trade-tick poll or computed fallback
        const tickPrice = parseFloat(tick.price || 0);
        const realLtp = this.ltpCache[symbol];
        let ltp = tickPrice || realLtp || (bid && ask ? (bid + ask) / 2 : (bid || ask || 0));
        if (!ltp || isNaN(ltp)) return;

        // If bid or ask are missing from this tick (common in WebSocket trade push), recover them
        if (bid > 0 && ask > 0) {
            // Got valid order book spread directly from tick
        } else if (cached && cached.bid > 0 && cached.ask > 0 && cached.ltp > 0) {
            // Proportional adjustment based on the cached spread and new LTP
            const ratio = ltp / cached.ltp;
            bid = cached.bid * ratio;
            ask = cached.ask * ratio;
        } else {
            // Fallback spread: 0.01% (0.0001) spread around LTP
            const spreadPercent = 0.0001;
            bid = ltp * (1 - spreadPercent / 2);
            ask = ltp * (1 + spreadPercent / 2);
        }

        if (!this.prevCloseCache[symbol]) {
            this.prevCloseCache[symbol] = ltp;
        }
        if (tick.pre_close_price && parseFloat(tick.pre_close_price) > 0) {
            this.prevCloseCache[symbol] = parseFloat(tick.pre_close_price);
        }

        // Determine volume: tick volume, or sum of depth bids/asks, or cached volume
        let volumeVal = 0;
        if (tick.volume && !isNaN(parseFloat(tick.volume))) {
            volumeVal = parseFloat(tick.volume);
        } else {
            if (Array.isArray(tick.bids)) {
                tick.bids.forEach(b => {
                    volumeVal += parseFloat(b.volume || 0);
                });
            }
            if (Array.isArray(tick.asks)) {
                tick.asks.forEach(a => {
                    volumeVal += parseFloat(a.volume || 0);
                });
            }
        }
        if (volumeVal === 0 && cached && cached.volume && cached.volume !== '-') {
            volumeVal = cached.volume;
        }

        const dataToFormat = {
            bid,
            ask,
            ltp,
            previousClose: this.prevCloseCache[symbol],
            volume: volumeVal > 0 ? volumeVal : '-',
            change: 0
        };

        if (isForex) {
            const formatted = formatForexData(symbol, dataToFormat);
            this.cache[symbol] = formatted;
            this._broadcast(formatted);
        }
        if (isCrypto) {
            const formatted = formatCryptoData(symbol, dataToFormat);
            this.cache[symbol] = formatted;
            this._broadcast(formatted);
        }
        if (isCommodity) {
            const formatted = formatCommodityData(symbol, dataToFormat);
            this.cache[symbol] = formatted;
            this._broadcast(formatted);

            // Also broadcast to all Mini/Custom aliases that share this AllTick code
            const mapping = this.commodityMiniMapping || {};
            const aliases = mapping[symbol] || [];
            for (const dbSymbol of aliases) {
                // Skip the canonical symbol itself (already broadcasted above)
                const canonicalDbSymbol = (() => {
                    if (symbol === 'GOLD') return 'XAU/USD';
                    if (symbol === 'Silver') return 'XAG/USD';
                    return symbol; // USOIL, NGAS, COPPER are same as AllTick code
                })();
                if (dbSymbol === canonicalDbSymbol) continue;

                // Create a copy with the mini/custom symbol name
                const aliasFormatted = formatCommodityData(dbSymbol, dataToFormat);
                this.cache[`MINI_${dbSymbol}`] = aliasFormatted;
                this._broadcast(aliasFormatted);
            }
        }
    }

    // ─────────────────────────────────────────────────────────
    //  Broadcast to MarketDataService
    // ─────────────────────────────────────────────────────────

    _broadcast(item) {
        try {
            const mds = require('./MarketDataService');
            if (!mds || !mds.prices) return;

            const prefix = item.type;
            const instrument = item.instrument;
            const slashedSymbol = `${prefix}:${instrument}`;
            const unslashedInstrument = instrument.replace('/', '');
            const unslashedSymbol = `${prefix}:${unslashedInstrument}`;

            // Lookup dynamic lot size from CommodityLotService
            const commodityLotService = require('./CommodityLotService');
            const lotInfo = commodityLotService.getLotInfo(instrument);
            const lotSize = lotInfo ? lotInfo.lot_size : 1;

            const base = { 
                ...item, 
                category: prefix.toLowerCase(),
                lotSize: lotSize,
                lot_size: lotSize
            };

            mds.prices[slashedSymbol] = {
                ...mds.prices[slashedSymbol],
                ...base,
                symbol: slashedSymbol,
                name: instrument
            };
            mds.dirtySymbols.add(slashedSymbol);

            mds.prices[unslashedSymbol] = {
                ...mds.prices[unslashedSymbol],
                ...base,
                instrument: unslashedInstrument,
                symbol: unslashedSymbol,
                name: unslashedInstrument
            };
            mds.dirtySymbols.add(unslashedSymbol);

            // console.log(`[ALLTICKS] 📡 Broadcast: ${slashedSymbol} | Bid: ${item.bid} Ask: ${item.ask}`);
        } catch (err) {
            console.error('[ALLTICKS] Broadcast error:', err.message);
        }
    }

    // ─────────────────────────────────────────────────────────
    //  HTTP Polling Fallback
    //  Uses depth-tick endpoint: GET /quote-b-api/depth-tick
    //  Returns real bid/ask from order book (bids + asks arrays)
    //  query param = URL-encoded JSON
    // ─────────────────────────────────────────────────────────

    _startPolling() {
        if (this.pollingInterval) return;
        console.log('[ALLTICKS] Starting HTTP polling (depth-tick + trade-tick, 1s interval)...');
        this._poll();
        this._pollTradeTick(); // Fetch real LTP on start
        this.pollingInterval = setInterval(() => this._poll(), 1000);
        this.tradeTickInterval = setInterval(() => this._pollTradeTick(), 2000); // LTP every 2s
    }

    _stopPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
        if (this.tradeTickInterval) {
            clearInterval(this.tradeTickInterval);
            this.tradeTickInterval = null;
        }
    }

    async _poll() {
        if (!this.token || !this.isRunning) return;

        const allSymbols = [...this.forexSymbols, ...this.cryptoSymbols, ...this.commoditySymbols];
        const query = JSON.stringify({
            trace: 'poll-' + Date.now(),
            data: { symbol_list: allSymbols.map(sym => ({ code: sym })) }
        });

        try {
            const response = await axios.get(HTTP_DEPTH_URL, {
                params: { token: this.token, query },
                timeout: 5000
            });

            const respData = response.data;
            if (!respData || respData.ret !== 200) {
                if (respData?.ret === 401) {
                    console.error('[ALLTICKS] HTTP 401 — token invalid. Stopping polling.');
                    this._stopPolling();
                }
                return;
            }

            const tickList = respData.data?.tick_list;
            if (!Array.isArray(tickList)) return;

            tickList.forEach(tick => this._processTick(tick));

        } catch (err) {
            if (err.code !== 'ECONNABORTED') {
                console.error('[ALLTICKS] HTTP Poll Error:', err.message);
            }
        }
    }
    /**
     * Poll /trade-tick endpoint to get real LTP ("price" field).
     * This is a separate AllTick endpoint that returns the last transaction price.
     * We cache it per symbol and inject it in _processTick.
     */
    async _pollTradeTick() {
        if (!this.token || !this.isRunning) return;

        const allSymbols = [...this.forexSymbols, ...this.cryptoSymbols, ...this.commoditySymbols];
        const query = JSON.stringify({
            trace: 'trade-' + Date.now(),
            data: { symbol_list: allSymbols.map(sym => ({ code: sym })) }
        });

        try {
            const response = await axios.get(HTTP_TRADE_URL, {
                params: { token: this.token, query },
                timeout: 5000
            });

            const respData = response.data;
            if (!respData || respData.ret !== 200) return;

            const tickList = respData.data?.tick_list;
            if (!Array.isArray(tickList)) return;

            // Cache the real LTP per symbol
            tickList.forEach(tick => {
                if (tick.code && tick.price) {
                    const realLtp = parseFloat(tick.price);
                    if (!isNaN(realLtp) && realLtp > 0) {
                        this.ltpCache[tick.code] = realLtp;
                    }
                }
            });
        } catch (err) {
            if (err.code !== 'ECONNABORTED') {
                // Silently fail — depth-tick mid-price fallback will be used
            }
        }
    }
}

module.exports = new AllTickService();
