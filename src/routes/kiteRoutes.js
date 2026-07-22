const fs = require('fs');
const path = require('path');
const express = require('express');
const kiteController = require('../controllers/kiteController');
const kiteService = require('../utils/kiteService');
const kiteTicker = require('../utils/kiteTicker');
const kiteAuthService = require('../services/KiteAuthService');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

// ── AUTH FLOW ─────────────────────────────────────────

// Step 1: Get login URL (frontend calls this, then redirects user)
router.get('/login', authMiddleware, kiteController.login);

// Step 2: Zerodha redirects here after login (NO auth needed — this is a redirect from Zerodha)
router.get('/callback', kiteController.callback);

// Step 3: Manually set access token (user pastes token directly)
router.post('/set-token', authMiddleware, kiteController.setToken);

// Check connection status
router.get('/status', authMiddleware, kiteController.status);

// Disconnect / logout
router.post('/disconnect', authMiddleware, kiteController.disconnect);

// User Profile & Margins
router.get('/profile', authMiddleware, kiteController.getProfile);
router.get('/margins', authMiddleware, kiteController.getMargins);

// ══════════════════════════════════════════════════════════════
//   CURATED MARKET DATA — 3 Tabs: NSE, MCX, NFO
// ══════════════════════════════════════════════════════════════

let instrumentsCache = null;
let instrumentsCacheTime = 0;
const CACHE_TTL = 6 * 60 * 60 * 1000;
let symbolTokenMap = new Map();

// Optimized lookup: exchange -> type -> [instruments]
let indexedInstruments = {
    NSE: { STOCKS: [], FUT: [], OPT: [] },
    NFO: { FUT: [], OPT: [] },
    MCX: { FUT: [], OPT: [] }
};

let fetchingPromise = null;

async function getInstrumentsFromCache() {
    const now = Date.now();
    
    // 1. If we have a valid cache, return it
    if (instrumentsCache && (now - instrumentsCacheTime) < CACHE_TTL) {
        return instrumentsCache;
    }

    // 2. If already fetching/indexing, wait for that promise
    if (fetchingPromise) {
        return fetchingPromise;
    }

    // 3. Start a new fetch/index process and cache the promise
    fetchingPromise = (async () => {
        try {
            console.log('⚡ Fetching and INDEXING ALL instruments from Kite API...');
            const instruments = await kiteService.getInstruments();


    // 1. Rebuild basic mapping
    const newMap = new Map();
    // 2. Rebuild optimized index
    const newIndex = {
        NSE: { STOCKS: [], FUT: [], OPT: [] },
        NFO: { FUT: [], OPT: [] },
        MCX: { FUT: [], OPT: [] }
    };

    instruments.forEach(inst => {
        const fullKey = `${inst.exchange}:${inst.tradingsymbol}`;
        newMap.set(fullKey, inst.instrument_token);

        const ex = inst.exchange;
        const type = inst.instrument_type;
        if (newIndex[ex]) {
            if (type === 'EQ' || type === 'STK') {
                if (ex === 'NSE') newIndex.NSE.STOCKS.push(inst);
            } else if (type === 'FUT') {
                newIndex[ex].FUT.push(inst);
            } else if (type === 'CE' || type === 'PE') {
                newIndex[ex].OPT.push(inst);
            }
        }
    });

            symbolTokenMap = newMap;
            indexedInstruments = newIndex;
            instrumentsCache = instruments;
            instrumentsCacheTime = now;

            console.log(`✅ Indexed ${instruments.length} instruments`);
            return instruments;
        } catch (err) {
            console.error('❌ Failed to fetch/index instruments:', err.message);
            throw err;
        } finally {
            fetchingPromise = null;
        }
    })();

    return fetchingPromise;
}

function getTokenSync(symbol) {
    return symbolTokenMap.get(symbol);
}

// ── NIFTY 50 (50 stocks — Apr 2026 official list, Zerodha exact symbols) ──
/** Bump when default unified watchlist shape changes (invalidates HTTP cache + precompute). */
const WATCHLIST_CACHE_BUST = 'watchlist_v7_custom_mcx_continuous';

/** NFO index options included in unified watchlist (instruments + quotes from Kite only). */
const NFO_INDEX_OPTION_UNDERLYINGS = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY']);

let NIFTY50 = [];
let BANKNIFTY = [];
let MIDCAP = [];
let FINNIFTY = [];
let ALL_NSE_STOCKS = [];
let MCX_BASES = [];
let NFO_INDICES = [];
let NSE_INDICES = [];

const db = require('../config/db');

async function loadGroupsFromDb() {
    try {
        const [rows] = await db.execute(`
            SELECT mg.name as group_name, mgi.symbol 
            FROM market_group_items mgi
            JOIN market_groups mg ON mgi.group_id = mg.id
            WHERE mg.is_active = 1
        `);

        const groups = {};
        rows.forEach(r => {
            if (!groups[r.group_name]) groups[r.group_name] = [];
            groups[r.group_name].push(r.symbol);
        });

        NIFTY50 = groups['NIFTY 50'] || [];
        BANKNIFTY = groups['BANK NIFTY'] || [];
        MIDCAP = groups['MIDCAP SELECT'] || [];
        FINNIFTY = groups['FIN NIFTY'] || [];
        MCX_BASES = Array.from(new Set([...(groups['MCX FUTURES'] || []), 'MGOLD', 'MCRUDEOIL', 'MSILVER', 'MNATURALGAS', 'MCOPPER', 'MLEAD', 'MZINC', 'MALUMINIUM']));
        NFO_INDICES = groups['NFO INDICES'] || [];
        NSE_INDICES = (groups['NSE INDICES'] || []).map(s => `NSE:${s}`);
        
        ALL_NSE_STOCKS = [...new Set([...NIFTY50, ...BANKNIFTY, ...MIDCAP, ...FINNIFTY])];

        console.log(`✅ Loaded Market Groups from DB: N50(${NIFTY50.length}), BN(${BANKNIFTY.length}), MCX(${MCX_BASES.length}), INDICES(${NSE_INDICES.length})`);
    } catch (err) {
        console.error('❌ Failed to load market groups from DB:', err.message);
    }
}

// Initial load
loadGroupsFromDb();
// Refresh every 5 minutes
setInterval(loadGroupsFromDb, 5 * 60 * 1000);

let _userNseEquityWatchlist = null;
function loadUserNseEquityWatchlist() {
    if (_userNseEquityWatchlist) return _userNseEquityWatchlist;
    try {
        const p = path.join(__dirname, '../data/user_nse_equity_watchlist.json');
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!Array.isArray(raw)) throw new Error('expected array');
        _userNseEquityWatchlist = raw.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean);
    } catch (e) {
        console.warn('user_nse_equity_watchlist.json not loaded, falling back to NIFTY50:', e.message);
        _userNseEquityWatchlist = NIFTY50.slice();
    }
    return _userNseEquityWatchlist;
}



// Dashboard symbols cache (avoids rebuilding symbol lists every request)
let dashboardSymbolsCache = null;
let dashboardSymbolsCacheTime = 0;
const DASHBOARD_SYMBOLS_TTL = 15000; // 15s

// ── Quotes cache ──
let quotesCache = {};
let quotesCacheTime = 0;
const QUOTES_TTL = 1500;
const inFlightQuoteRequests = new Map();

async function fetchQuotesBatch(symbols) {
    const quotes = {};
    const batchSize = 500;
    for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);
        try {
            const result = await kiteService.getQuote(batch);
            if (result && typeof result === 'object') Object.assign(quotes, result);
        } catch (err) {
            console.warn(`Quote batch error:`, err.message);
        }
        if (i + batchSize < symbols.length) await sleep(80);
    }
    return quotes;
}

function getInFlightKey(symbols) {
    return Array.from(new Set((symbols || []).filter(Boolean))).sort().join('|');
}

async function fetchQuotesBatchDedup(symbols, { fresh = false } = {}) {
    const uniqueSymbols = Array.from(new Set((symbols || []).filter(Boolean)));
    if (uniqueSymbols.length === 0) return {};
    const key = `${fresh ? 'F' : 'C'}:${getInFlightKey(uniqueSymbols)}`;
    if (inFlightQuoteRequests.has(key)) return inFlightQuoteRequests.get(key);
    const p = (fresh ? fetchQuotesBatchFresh(uniqueSymbols) : fetchQuotesBatch(uniqueSymbols))
        .finally(() => inFlightQuoteRequests.delete(key));
    inFlightQuoteRequests.set(key, p);
    return p;
}

// Fetch fresh quotes always (NO cache)
async function fetchQuotesBatchFresh(symbols) {
    const quotes = {};
    const batchSize = 500;
    for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);
        try {
            const result = await kiteService.getQuote(batch);
            if (result && typeof result === 'object') Object.assign(quotes, result);
        } catch (err) {
            console.warn(`Quote batch error:`, err.message);
        }
        if (i + batchSize < symbols.length) await sleep(80);
    }
    return quotes;
}

function getQuoteFromStream(symbol) {
    try {
        const marketDataService = require('../services/MarketDataService');
        const s = marketDataService.getPrice(symbol) || marketDataService.getPrice(String(symbol).split(':').pop());
        if (!s?.ltp) return null;
        return {
            last_price: Number(s.ltp || 0),
            net_change: Number(s.change || 0),
            volume: Number(s.volume || 0),
            oi: Number(s.oi || 0),
            ohlc: s.ohlc || {},
            depth: s.depth || {},
            timestamp: new Date().toISOString(),
        };
    } catch (_) {
        return null;
    }
}

// Generate realistic mock data for missing symbols
function generateMockQuote(symbol) {
    const basePrice = Math.random() * 5000 + 100;
    const change = (Math.random() - 0.5) * 200;
    const closePrice = basePrice - change;
    const chgPct = ((change / closePrice) * 100).toFixed(2);

    return {
        symbol,
        last_price: basePrice,
        net_change: change,
        ohlc: {
            open: closePrice + (Math.random() - 0.5) * 100,
            high: basePrice + Math.random() * 100,
            low: basePrice - Math.random() * 100,
            close: closePrice
        },
        volume: Math.floor(Math.random() * 10000000),
        oi: Math.floor(Math.random() * 5000000),
        depth: {
            buy: [{ price: basePrice - 0.05, quantity: Math.floor(Math.random() * 1000) }],
            sell: [{ price: basePrice + 0.05, quantity: Math.floor(Math.random() * 1000) }]
        },
        timestamp: new Date().toISOString()
    };
}

function formatQuotes(rawQuotes) {
    const formatted = {};
    for (const [symbol, quote] of Object.entries(rawQuotes)) {
        try {
            formatted[symbol] = {
                symbol: symbol,
                ltp: quote.last_price,
                vol: quote.volume || 0,
                oi: quote.oi || 0,
                chg: quote.net_change || 0,
                open: quote.ohlc?.open || 0,
                high: quote.ohlc?.high || 0,
                low: quote.ohlc?.low || 0,
                close: quote.ohlc?.close || 0,
                bid: quote.depth?.buy?.[0]?.price || 0,
                ask: quote.depth?.sell?.[0]?.price || 0,
                time: quote.timestamp || "1970-01-01 05:30:00"
            };
        } catch (e) { }
    }
    return formatted;
}

function pickNearestExpiry(instruments, { exchange, name, instrumentTypes }) {
    const now = new Date();
    const filtered = instruments
        .filter(i => i.exchange === exchange)
        .filter(i => (name ? (String(i.name || '').toUpperCase() === String(name).toUpperCase()) : true))
        .filter(i => (instrumentTypes ? instrumentTypes.includes(String(i.instrument_type || '').toUpperCase()) : true))
        .filter(i => {
            const exp = new Date(i.expiry || 0);
            return !isNaN(exp.getTime()) && exp >= now;
        })
        .sort((a, b) => new Date(a.expiry || 0) - new Date(b.expiry || 0));

    return filtered[0] || null;
}

function toYmd(dateLike) {
    const d = new Date(dateLike || 0);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().substring(0, 10);
}

function buildUnifiedRow({ type, symbol, strike, optionType, expiry, quote, lotSize }) {
    const ltp = quote?.last_price || 0;
    const close = quote?.ohlc?.close || 0;
    const chgPct = close ? Number((((ltp - close) / close) * 100).toFixed(2)) : 0;

    return {
        type,
        symbol,
        ...(strike != null ? { strike: Number(strike) } : {}),
        ...(optionType ? { optionType } : {}),
        ...(expiry ? { expiry } : {}),
        ltp,
        bid: quote?.depth?.buy?.[0]?.price || 0,
        ask: quote?.depth?.sell?.[0]?.price || 0,
        oi: quote?.oi || 0,
        volume: quote?.volume || 0,
        change: chgPct,
        open: quote?.ohlc?.open || 0,
        high: quote?.ohlc?.high || 0,
        low: quote?.ohlc?.low || 0,
        close: close,
        lotSize: lotSize || 1
    };
}

function getOptionStrikeStepNfo(underlying) {
    return STRIKE_STEPS[String(underlying || '').toUpperCase()];
}

const MCX_ALLOWED_WATCHLIST = [
    // Mega contracts
    'GOLD', 'SILVER', 'CRUDEOIL', 'COPPER', 'ZINC', 'ALUMINIUM', 'LEAD', 'NATURALGAS',
    'NICKEL', 'GOLDPETAL', 'GOLDGUINEA', 'COTTON', 'COTTONCNDY', 'MENTHAOIL',
    // Mini contracts
    'GOLDM', 'SILVERM', 'CRUDEOILM', 'ZINCMINI', 'LEADMINI', 'COPPERM', 'NATURALGASMINI',
    'ALUMINI', 'NICKELMINI',
    // Micro (M-series) contracts
    'MGOLD', 'MCRUDEOIL', 'MSILVER', 'MNATURALGAS', 'MCOPPER', 'MLEAD', 'MZINC', 'MALUMINIUM',
];

/** Unified watchlist: MCX options for Crude, NatGas, Gold, Silver (incl. minis) */
const MCX_OPTION_UNDERLYINGS_DEFAULT = ['CRUDEOIL', 'CRUDEOILM', 'NATURALGAS', 'NATURALGASMINI', 'GOLD', 'GOLDM', 'SILVER', 'SILVERM'];

const MCX_CANONICAL_MAP = {
    // Project-internal (instrument name) vs requirement names
    NATURALGASMINI: 'NATGASMINI',
    COPPERMINI: 'COPPERM',
};

function canonicalMcxName(name) {
    const up = String(name || '').toUpperCase();
    return MCX_CANONICAL_MAP[up] || up;
}

// ── Optimized symbol builder: uses INDEXED data for O(1) exchange search ──
async function buildFutSymbols(exchange, baseNames, maxExpiries = 2) {
    try {
        await getInstrumentsFromCache(); // Ensure cached/indexed
        const now = new Date();
        const symbols = [];

        // ONLY search in the filtered subset for this exchange/type
        const relevantContracts = (indexedInstruments[exchange] && indexedInstruments[exchange].FUT) || [];
        if (relevantContracts.length === 0) return [];

        for (const base of baseNames) {
            const baseUpper = base.toUpperCase();

            // This is now scanning ~500-1000 items instead of 100,000 items
            const matches = relevantContracts
                .filter(i => {
                    const sym = (i.tradingsymbol || '').toUpperCase();
                    return sym === baseUpper || (sym.startsWith(baseUpper) && sym.endsWith('FUT'));
                })
                .sort((a, b) => new Date(a.expiry || 0) - new Date(b.expiry || 0));

            const added = new Set();
            for (const c of matches) {
                if (added.size >= maxExpiries) break;
                const expDate = new Date(c.expiry || 0);
                if (expDate >= now) {
                    symbols.push(`${exchange}:${c.tradingsymbol}`);
                    added.add(c.expiry);
                }
            }
        }
        return symbols;
    } catch (err) {
        console.warn(`buildFutSymbols error for ${exchange}:`, err.message);
        return [];
    }
}

// ── Background Rebuilding of Dashboard Symbols ──
let dashboardSymbolsRefreshing = false;
async function refreshDashboardSymbols() {
    if (dashboardSymbolsRefreshing) return;
    if (!kiteService.isAuthenticated()) {
        console.warn('⚠️ Kite not connected. Please login first via /api/kite/login');
        return;
    }
    dashboardSymbolsRefreshing = true;
    try {
        console.log('🔄 Rebuilding Dashboard Symbols Cache in Background...');
        const [mcxSymbols, nfoIndexFut, nfoStockFut] = await Promise.all([
            buildFutSymbols('MCX', MCX_BASES, 6),
            buildFutSymbols('NFO', NFO_INDICES, 4),
            buildFutSymbols('NFO', NIFTY50, 1),
        ]);

        dashboardSymbolsCache = {
            mcxSymbols,
            nfoSymbols: [...nfoIndexFut, ...nfoStockFut],
        };
        dashboardSymbolsCacheTime = Date.now();
        console.log('✅ Dashboard Symbols Cache Ready');
    } catch (err) {
        console.error('Failed to rebuild dashboard symbols:', err.message);
    } finally {
        dashboardSymbolsRefreshing = false;
    }
}

// Start background loop
setInterval(refreshDashboardSymbols, 10 * 60 * 1000); // Rebuild every 10 mins
// Immediate first run
setTimeout(refreshDashboardSymbols, 5000);

// Rate limiter
async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Spot for NFO index-option strike band: index cash can be delayed/missing while NFO fut still ticks.
 * Without a positive spot, Step 2 skips the whole chain → NFO tab count swings (e.g. ~53 vs ~800+).
 */
function resolveNfoIndexSpotLtp(ltpQuotes, cfg) {
    if (!global.LAST_KNOWN_LTPS) {
        global.LAST_KNOWN_LTPS = {};
    }
    const fromQuote = (key) => {
        if (!key || !ltpQuotes || !ltpQuotes[key]) return 0;
        const q = ltpQuotes[key];
        const lp = Number(q.last_price);
        if (Number.isFinite(lp) && lp > 0) return lp;
        const oc = Number(q.ohlc?.close);
        if (Number.isFinite(oc) && oc > 0) return oc;
        const av = Number(q.average_price);
        if (Number.isFinite(av) && av > 0) return av;
        return 0;
    };
    let ltp = fromQuote(cfg.idxKey);
    if (!ltp && cfg.futKey) {
        ltp = fromQuote(cfg.futKey);
    }
    const cacheKey = cfg.underlying || cfg.idxKey;
    if (ltp > 0) {
        global.LAST_KNOWN_LTPS[cacheKey] = ltp;
        if (cfg.idxKey) global.LAST_KNOWN_LTPS[cfg.idxKey] = ltp;
        if (cfg.futKey) global.LAST_KNOWN_LTPS[cfg.futKey] = ltp;
        return ltp;
    }
    if (global.LAST_KNOWN_LTPS[cacheKey] && global.LAST_KNOWN_LTPS[cacheKey] > 0) {
        return global.LAST_KNOWN_LTPS[cacheKey];
    }
    if (cfg.idxKey && global.LAST_KNOWN_LTPS[cfg.idxKey] && global.LAST_KNOWN_LTPS[cfg.idxKey] > 0) {
        return global.LAST_KNOWN_LTPS[cfg.idxKey];
    }
    const defaults = {
        NIFTY: 24000,
        BANKNIFTY: 52000,
        FINNIFTY: 23000,
        MIDCPNIFTY: 12000
    };
    const under = String(cfg.underlying || '').toUpperCase();
    return defaults[under] || 24000;
}

// ══════════════════════════════════════════════════════════════
//   3-TAB DASHBOARD: NSE | MCX | NFO
// ══════════════════════════════════════════════════════════════

/**
 * Shared dashboard payload (NSE + MCX + NFO tabs) — used by HTTP and Socket.IO.
 * @returns {Promise<{ status: string, timestamp: string, counts: object, nseGroups: object, data: object, groups: object }>}
 */
async function buildKiteDashboardPayload(userId) {
    if (!kiteService.isAuthenticated() && userId) {
        try {
            const status = await kiteAuthService.getStatus(userId);
            if (status.connected) {
                const session = await require('../repositories/KiteRepository').getSessionByUserId(userId);
                if (session?.access_token) {
                    kiteService.accessToken = session.access_token;
                    kiteService.sessionData = { access_token: session.access_token, user_name: session.user_name };
                }
            }
        } catch (_) { }
    }

    if (!kiteService.isAuthenticated()) {
        const err = new Error('KITE_NOT_CONNECTED');
        err.kite_disconnected = true;
        throw err;
    }

    const marketDataService = require('../services/MarketDataService');
    marketDataService.init(userId).catch(() => {});

    const instruments = await getInstrumentsFromCache();

    // 1. Basic Symbols (Stocks + Indices)
    const nseStocks = ALL_NSE_STOCKS.map(s => `NSE:${s}`);
    const nseIndices = NSE_INDICES.length > 0 ? NSE_INDICES : ['NSE:NIFTY 50', 'NSE:NIFTY BANK', 'NSE:NIFTY FIN SERVICE', 'NSE:NIFTY MID SELECT'];
    
    // 2. Futures (from background cache)
    if (!dashboardSymbolsCache) await refreshDashboardSymbols().catch(() => {});
    const mcxFutSymbols = dashboardSymbolsCache?.mcxSymbols || [];
    const nfoFutSymbols = dashboardSymbolsCache?.nfoSymbols || [];

    // 3. Dynamic Options (matching Market Watch logic but for all tab visitors)
    // We fetch current LTP of indices to define ATM range
    const spotKeys = [...nseIndices, ...mcxFutSymbols];
    const spotQuotes = await kiteService.getQuote(spotKeys).catch(() => ({}));

    const dynamicOptions = [];
    
    // NFO ATM Options (±5 strikes)
    for (const underlying of NFO_INDEX_OPTION_UNDERLYINGS) {
        const step = getOptionStrikeStepNfo(underlying);
        const idxKey = 
            underlying === 'NIFTY' ? 'NSE:NIFTY 50' : 
            underlying === 'BANKNIFTY' ? 'NSE:NIFTY BANK' : 
            underlying === 'FINNIFTY' ? 'NSE:NIFTY FIN SERVICE' : 
            underlying === 'MIDCPNIFTY' ? 'NSE:NIFTY MID SELECT' : 
            `NSE:${underlying}`;
        const ltp = spotQuotes[idxKey]?.last_price || 0;
        if (!ltp || !step) continue;

        const atm = Math.round(ltp / step) * step;
        const strikes = [atm - 2 * step, atm - step, atm, atm + step, atm + 2 * step];
        
        const nearestOpt = pickNearestExpiry(instruments, { exchange: 'NFO', name: underlying, instrumentTypes: ['CE', 'PE'] });
        if (!nearestOpt) continue;
        const expStr = new Date(nearestOpt.expiry).toDateString();
        
        const matches = (indexedInstruments['NFO']?.OPT || []).filter(i => 
            i.name === underlying && 
            new Date(i.expiry).toDateString() === expStr &&
            strikes.includes(Number(i.strike))
        );
        matches.forEach(m => dynamicOptions.push(`NFO:${m.tradingsymbol}`));
    }

    // MCX ATM Options (Crude/Natgas)
    for (const base of ['CRUDEOIL', 'NATURALGAS']) {
        const futKey = mcxFutSymbols.find(s => s.startsWith(`MCX:${base}`)) || `MCX:${base}FUT`;
        const ltp = spotQuotes[futKey]?.last_price || 0;
        if (!ltp) continue;
        const step = MCX_ALLOWED[base]?.step || 100;
        const atm = Math.round(ltp / step) * step;
        const strikes = [atm - step, atm, atm + step];
        
        const nearestOpt = pickNearestExpiry(instruments, { exchange: 'MCX', name: base, instrumentTypes: ['CE', 'PE'] });
        if (!nearestOpt) continue;
        const expStr = new Date(nearestOpt.expiry).toDateString();
        
        const matches = (indexedInstruments['MCX']?.OPT || []).filter(i => 
            i.name === base && 
            new Date(i.expiry).toDateString() === expStr &&
            strikes.includes(Number(i.strike))
        );
        matches.forEach(m => dynamicOptions.push(`MCX:${m.tradingsymbol}`));
    }

    const allSymbols = Array.from(new Set([...nseStocks, ...nseIndices, ...mcxFutSymbols, ...nfoFutSymbols, ...dynamicOptions]));

    // Subscribe to everything
    const subList = allSymbols.map(sym => ({ symbol: sym, token: getTokenSync(sym) })).filter(i => i.token);
    marketDataService.bulkSubscribe(subList);

    const streamData = marketDataService.getPricesBatch(allSymbols);
    const formatted = {};

    for (const symbol of allSymbols) {
        const quote = streamData[symbol];
        formatted[symbol] = {
            symbol,
            ltp: quote?.ltp || 0,
            vol: quote?.volume || 0,
            oi: quote?.oi || 0,
            chg: quote?.change || 0,
            chg_pct: quote?.ohlc?.close ? (((quote.ltp - quote.ohlc.close) / quote.ohlc.close) * 100).toFixed(2) : "0.00",
            open: quote?.ohlc?.open || 0,
            high: quote?.ohlc?.high || 0,
            low: quote?.ohlc?.low || 0,
            close: quote?.ohlc?.close || 0,
            bid: quote?.depth?.buy?.[0]?.price || 0,
            ask: quote?.depth?.sell?.[0]?.price || 0,
            time: new Date().toISOString()
        };
    }

    const nseGroups = { 'NIFTY 50': {}, 'BANK NIFTY': {}, 'MIDCAP': {}, 'FIN NIFTY': {}, 'INDICES': {} };
    const nifty50Set = new Set(NIFTY50.map(s => `NSE:${s}`));
    const bankNiftySet = new Set(BANKNIFTY.map(s => `NSE:${s}`));
    const midcapSet = new Set(MIDCAP.map(s => `NSE:${s}`));
    const finniftySet = new Set(FINNIFTY.map(s => `NSE:${s}`));

    const sections = { nse: {}, mcx: {}, nfo: {} };
    for (const [sym, data] of Object.entries(formatted)) {
        if (sym.startsWith('NSE:')) {
            sections.nse[sym] = data;
            if (nseIndices.includes(sym)) nseGroups['INDICES'][sym] = data;
            if (nifty50Set.has(sym)) nseGroups['NIFTY 50'][sym] = data;
            if (bankNiftySet.has(sym)) nseGroups['BANK NIFTY'][sym] = data;
            if (midcapSet.has(sym)) nseGroups['MIDCAP'][sym] = data;
            if (finniftySet.has(sym)) nseGroups['FIN NIFTY'][sym] = data;
        }
        else if (sym.startsWith('MCX:')) sections.mcx[sym] = data;
        else if (sym.startsWith('NFO:')) sections.nfo[sym] = data;
    }

    return {
        status: 'success',
        timestamp: new Date().toISOString(),
        counts: { nse: Object.keys(sections.nse).length, mcx: Object.keys(sections.mcx).length, nfo: Object.keys(sections.nfo).length, total: allSymbols.length },
        nseGroups: {
            'NIFTY 50': Object.keys(nseGroups['NIFTY 50']).length,
            'BANK NIFTY': Object.keys(nseGroups['BANK NIFTY']).length,
            'MIDCAP': Object.keys(nseGroups['MIDCAP']).length,
            'FIN NIFTY': Object.keys(nseGroups['FIN NIFTY']).length,
        },
        data: sections,
        groups: nseGroups
    };
}

// ── /market/dashboard — Single call, returns 3 tabs with sub-groups ──
router.get('/market/dashboard', authMiddleware, asyncHandler(async (req, res) => {
    try {
        const body = await buildKiteDashboardPayload(req.user?.id);
        res.json(body);
    } catch (err) {
        console.error('Dashboard error:', err.message);
        if (err.message === 'KITE_NOT_CONNECTED') {
            return res.status(503).json({ error: 'Kite not connected.', kite_disconnected: true });
        }
        if (err.message?.includes('403') || err.message?.includes('expired')) {
            kiteService.clearSession();
            try {
                if (req.user?.id) await kiteAuthService.disconnect(req.user.id);
            } catch (_) { }
            return res.status(503).json({ error: 'Kite session expired. Please reconnect.', kite_disconnected: true });
        }
        res.status(500).json({ status: 'error', message: err.message, data: {} });
    }
}));

// ══════════════════════════════════════════════════════════════
//   UNIFIED WATCHLIST — ONE API, ONE TABLE (NSE + NFO OPT + MCX FUT + MCX OPT)
// ══════════════════════════════════════════════════════════════

// Watchlist cache — ALWAYS serve from cache, refresh in background
let watchlistCache = { data: null, time: 0, key: '' };
let watchlistRefreshing = false;
let watchlistLastQuery = null;
let watchlistLastUserId = null;

// ─── Called by contractController after saving contract selection ───
function bustWatchlistCache() {
    watchlistCache = { data: null, time: 0, key: '' };
    console.log('🔄 Watchlist cache busted (contract selection changed)');
}

// ── One-time CE/PE 2nd expiry auto-exclusion ──────────────────────────────
// Runs on first watchlist build. Adds 2nd+ expiry MCX/NFO option contracts
// to excluded list so live quotes shows only nearest 1 expiry by default.
// Skips if excluded list already has CE/PE entries (previous session done,
// admin changes preserved across restarts).
let _cepeExclInitialized = false;
const _EXCLUDED_FILE_PATH = path.join(__dirname, '../data/excluded_contracts.json');

function _initCepeExclOnce(pc, today) {
    if (_cepeExclInitialized) return;
    _cepeExclInitialized = true;

    const excl = (global.EXCLUDED_CONTRACTS || []).slice();

    // If excluded list already has CE/PE option entries → previous session
    // already initialized, admin's enabled choices preserved — skip.
    const alreadyDone = excl.some(s =>
        (s.startsWith('MCX:') || s.startsWith('NFO:')) &&
        (s.slice(-2) === 'CE' || s.slice(-2) === 'PE')
    );
    if (alreadyDone) return;

    let changed = false;
    for (const [exchange, optIndex] of [['MCX', pc.mcxOptIndex], ['NFO', pc.nfoOptIndex]]) {
        for (const optList of Object.values(optIndex)) {
            const expiries = [...new Set(
                optList.filter(i => new Date(i.expiry || 0) >= today).map(i => i.expiry)
            )].sort((a, b) => new Date(a) - new Date(b));

            expiries.forEach((expiry, idx) => {
                if (idx < 1) return; // keep nearest 1 expiry enabled
                for (const inst of optList) {
                    if (inst.expiry !== expiry) continue;
                    const fullKey = `${exchange}:${inst.tradingsymbol}`;
                    if (!excl.includes(fullKey)) {
                        excl.push(fullKey);
                        changed = true;
                    }
                }
            });
        }
    }

    if (changed) {
        global.EXCLUDED_CONTRACTS = excl;
        try { fs.writeFileSync(_EXCLUDED_FILE_PATH, JSON.stringify(excl, null, 2)); } catch (_) {}
        console.log(`✅ CE/PE 2nd expiry auto-excluded: ${excl.length} total excluded`);
    }
}

// Auto-refresh loop: keeps cache warm every 2s after first request
let watchlistAutoRefreshStarted = false;
function startWatchlistAutoRefresh() {
    if (watchlistAutoRefreshStarted) return;
    watchlistAutoRefreshStarted = true;
    setInterval(async () => {
        if (!watchlistLastQuery || !kiteService.isAuthenticated()) return;
        await refreshWatchlistInBackground(watchlistLastQuery, watchlistLastUserId);
    }, 2000);
    console.log('🔄 Watchlist auto-refresh started (every 2s)');
}

// Background refresh: fetches new data without blocking the response
async function refreshWatchlistInBackground(queryParams, userId) {
    if (watchlistRefreshing) return; // already refreshing, skip
    watchlistRefreshing = true;
    try {
        const rows = await _buildWatchlistData(queryParams, userId);
        const cacheKey = `${queryParams.nse || ''}_${queryParams.nfoUnderlyings || ''}_${queryParams.mcxOptSymbols || ''}_${queryParams.nfoIndexOptRange || ''}_${WATCHLIST_CACHE_BUST}`;
        watchlistCache = { data: rows, time: Date.now(), key: cacheKey };
    } catch (err) {
        console.warn('Watchlist background refresh error:', err.message);
    } finally {
        watchlistRefreshing = false;
    }
}

// GET /api/kite/market/watchlist
// INSTANT response from cache, background refresh every 2s
router.get('/market/watchlist', authMiddleware, asyncHandler(async (req, res) => {
    try {
        if (!kiteService.isAuthenticated()) {
            return res.status(503).json({ error: 'Kite not connected.', kite_disconnected: true });
        }

        const configVer = global.WATCHLIST_CONFIG_VERSION || 0;
        const cacheKey = `${req.query.nse || ''}_${req.query.nfoUnderlyings || ''}_${req.query.mcxOptSymbols || ''}_${req.query.nfoIndexOptRange || ''}_${WATCHLIST_CACHE_BUST}_v${configVer}`;

        // If cache has data → return INSTANTLY, trigger background refresh if stale
        if (watchlistCache.data && watchlistCache.key === cacheKey) {
            watchlistLastQuery = req.query;
            watchlistLastUserId = req.user?.id;
            startWatchlistAutoRefresh();
            return res.json(watchlistCache.data);
        }

        // First ever call → must wait for data (no cache yet)
        const rows = await _buildWatchlistData(req.query, req.user?.id);
        watchlistCache = { data: rows, time: Date.now(), key: cacheKey };
        watchlistLastQuery = req.query;
        watchlistLastUserId = req.user?.id;
        startWatchlistAutoRefresh(); // start auto-refresh loop after first successful build
        res.json(rows);
    } catch (err) {
        console.error('Unified watchlist error:', err.message);
        if (err.message?.includes('403') || err.message?.includes('expired')) {
            kiteService.clearSession();
            try { if (req.user?.id) await kiteAuthService.disconnect(req.user.id); } catch (_) { }
            return res.status(503).json({ error: 'Kite session expired. Please reconnect.', kite_disconnected: true });
        }
        res.status(500).json({ status: 'error', message: err.message });
    }
}));

// ══════════════════════════════════════════════════════════════
//   OPTIMIZED WATCHLIST BUILD — precomputed symbols, single batch, parallel
// ══════════════════════════════════════════════════════════════

// Precomputed symbol map — rebuilt when instruments cache or default NSE list signature changes
let _precomputed = null;
let _precomputedInstrTime = 0;
let _precomputedQuerySig = '';

function _getPrecomputed(instruments, query) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // ── NSE (default = curated list from user paste, validated against live NSE EQ/BE) ──
    const nseList = String(query.nse || '').trim();
    const rawNse = nseList
        ? nseList.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
        : loadUserNseEquityWatchlist();
    const nseEqSyms = new Set(
        instruments
            .filter((i) => i.exchange === 'NSE' && ['EQ', 'BE'].includes(String(i.instrument_type || '').toUpperCase()))
            .map((i) => i.tradingsymbol)
    );
    let nseSymbols = [...new Set(rawNse.filter((s) => nseEqSyms.has(s)))].sort((a, b) => a.localeCompare(b));
    if (nseSymbols.length === 0) {
        nseSymbols = [...new Set(NIFTY50.filter((s) => nseEqSyms.has(s)))].sort((a, b) => a.localeCompare(b));
        if (nseSymbols.length === 0) nseSymbols = NIFTY50.slice();
    }
    const mcxOptSymQuery = String(query.mcxOptSymbols || '').trim();
    const mcxOptRequested = (mcxOptSymQuery
        ? mcxOptSymQuery.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
        : MCX_OPTION_UNDERLYINGS_DEFAULT.slice()
    ).filter((s) => MCX_ALLOWED_WATCHLIST.includes(s));
    const mcxOptSigForPrecompute = mcxOptSymQuery || MCX_OPTION_UNDERLYINGS_DEFAULT.join(',');
    const mcxOptRange = parseInt(query.mcxOptRange) || 5000;
    const querySig = `${nseList || '__DEFAULT__'}_${WATCHLIST_CACHE_BUST}_nse${nseSymbols.length}_mcxopt_${mcxOptSigForPrecompute}`;

    if (_precomputed && _precomputedInstrTime === instrumentsCacheTime && _precomputedQuerySig === querySig) {
        return _precomputed;
    }

    console.log('⚡ Precomputing watchlist symbol map...');

    const nseKeys = nseSymbols.map((s) => `NSE:${s}`);

    // ── NFO underlyings ──
    const nfoUnderlyings = String(query.nfoUnderlyings || 'NIFTY,BANKNIFTY,FINNIFTY,MIDCPNIFTY')
        .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    const nfoRange = parseInt(query.nfoRange) || 50000;

    const indexSymbolMap = {
        NIFTY: 'NSE:NIFTY 50', BANKNIFTY: 'NSE:NIFTY BANK',
        FINNIFTY: 'NSE:NIFTY FIN SERVICE', MIDCPNIFTY: 'NSE:NIFTY MID SELECT', SENSEX: 'BSE:SENSEX',
    };

    // Collect LTP keys needed for ATM calculation
    const ltpKeys = [];
    const nfoConfig = [];
    const nfoFutKeys = [];
    const nfoFutMeta = {};
    for (const u of nfoUnderlyings) {
        const step = getOptionStrikeStepNfo(u);
        const idxKey = indexSymbolMap[u] || `NSE:${u}`;
        ltpKeys.push(idxKey);
        const fut = pickNearestExpiry(instruments, { exchange: 'NFO', name: u, instrumentTypes: ['FUT'] });
        let futKey = null;
        if (fut?.tradingsymbol) {
            futKey = `NFO:${fut.tradingsymbol}`;
            ltpKeys.push(futKey);
            nfoFutKeys.push(futKey);
            nfoFutMeta[futKey] = { expiry: toYmd(fut.expiry) };
        }
        const nearestOpt = pickNearestExpiry(instruments, { exchange: 'NFO', name: u, instrumentTypes: ['CE', 'PE'] });
        nfoConfig.push({ underlying: u, step, idxKey, futKey, expiry: nearestOpt ? toYmd(nearestOpt.expiry) : null, range: nfoRange });
    }

    // ── MCX precompute: find up to 3 expiries per base (previous + current + next) ──
    const mcxFutBases = MCX_ALLOWED_WATCHLIST.map(canonicalMcxName);

    // Include contracts expired up to 10 days ago (for "previous" expiry visibility)
    const mcxPrevWindow = new Date(today.getTime() - 10 * 24 * 60 * 60 * 1000);
    const mcxFutByBase = {}; // base → [{ tradingsymbol, expiry, fullKey }] up to 3

    // ── DIAGNOSTIC: count MCX instruments ──
    const _mcxAll = instruments.filter(i => i.exchange === 'MCX');
    const _mcxFut = _mcxAll.filter(i => String(i.instrument_type || '').toUpperCase() === 'FUT');
    const _mcxFutRecent = _mcxFut.filter(i => new Date(i.expiry || 0) >= mcxPrevWindow);
    console.log(`🔍 MCX total=${_mcxAll.length} | FUT=${_mcxFut.length} | recent=${_mcxFutRecent.length} | sample=${_mcxFutRecent.slice(0,3).map(i=>i.tradingsymbol+'/'+i.expiry).join(', ')}`);
    const _nfoAll = instruments.filter(i => i.exchange === 'NFO' && String(i.instrument_type||'').toUpperCase()==='FUT');
    console.log(`🔍 NFO FUT=${_nfoAll.length} | sample=${_nfoAll.slice(0,3).map(i=>i.tradingsymbol).join(', ')}`);

    for (const inst of instruments) {
        if (inst.exchange !== 'MCX') continue;
        if (String(inst.instrument_type || '').toUpperCase() !== 'FUT') continue;
        if (new Date(inst.expiry || 0) < mcxPrevWindow) continue;
        for (const base of mcxFutBases) {
            if (isExactMcxFutureForBase(inst.tradingsymbol, base)) {
                if (!mcxFutByBase[base]) mcxFutByBase[base] = [];
                mcxFutByBase[base].push({ tradingsymbol: inst.tradingsymbol, expiry: inst.expiry, fullKey: `MCX:${inst.tradingsymbol}` });
            }
        }
    }
    // Sort ascending by expiry, keep up to 6 in pool (Contract Management controls which are active)
    for (const base of mcxFutBases) {
        if (mcxFutByBase[base]) {
            mcxFutByBase[base] = mcxFutByBase[base]
                .sort((a, b) => new Date(a.expiry) - new Date(b.expiry))
                .slice(0, 6);
        }
    }

    // ── DIAGNOSTIC: check mcxFutByBase result ──
    const _matchedBases = Object.keys(mcxFutByBase);
    console.log(`🔍 mcxFutByBase matched ${_matchedBases.length} bases: ${_matchedBases.join(', ')}`);
    if (_matchedBases.length === 0) {
        // Test regex against first sample manually
        const _sample = _mcxFutRecent[0];
        if (_sample) {
            console.log(`🔍 Regex test for "${_sample.tradingsymbol}" vs bases: ${mcxFutBases.slice(0,5).map(b => `${b}=${isExactMcxFutureForBase(_sample.tradingsymbol,b)}`).join(', ')}`);
        }
    }

    // Add MCX FUT keys to LTP fetch (all up to 3 per base)
    for (const base of mcxFutBases) {
        const contracts = mcxFutByBase[base] || [];
        for (const f of contracts) ltpKeys.push(f.fullKey);
    }

    // ── NFO stock futures: build pool (up to 3 expiries per base, sorted asc).
    // Excluded filter is applied in _buildWatchlistData (same pattern as MCX mcxFutByBase).
    const nfoFutIdx = indexedInstruments['NFO']?.FUT || [];
    const nfoFutByBase = {}; // UPPERCASE name → [{tradingsymbol, expiry, fullKey}]
    for (const inst of nfoFutIdx) {
        const name = String(inst.name || '').toUpperCase();
        const exp = new Date(inst.expiry || 0);
        if (exp < today) continue;
        if (!nfoFutByBase[name]) nfoFutByBase[name] = [];
        nfoFutByBase[name].push({ tradingsymbol: inst.tradingsymbol, expiry: inst.expiry, fullKey: `NFO:${inst.tradingsymbol}` });
    }
    for (const name of Object.keys(nfoFutByBase)) {
        nfoFutByBase[name] = nfoFutByBase[name]
            .sort((a, b) => new Date(a.expiry) - new Date(b.expiry))
            .slice(0, 3);
    }
    // nfoFutKeys for STOCKS is intentionally left empty here — _buildWatchlistData populates it
    // after applying the excluded filter from Contract Management.
    const nfoStockUniverse = ALL_NSE_STOCKS.length > 0 ? ALL_NSE_STOCKS : NIFTY50;

    // Build NFO/MCX option instrument index ONCE (avoid scanning 100K per underlying)
    const nfoOptIndex = {}; // underlying → [{ inst, strike, type, expiry }]
    const mcxOptIndex = {}; // base → [{ inst, strike, type, expiry }]
    for (const inst of instruments) {
        const it = String(inst.instrument_type || '').toUpperCase();
        if (it !== 'CE' && it !== 'PE') continue;
        if (inst.exchange === 'NFO') {
            const name = String(inst.name || '').toUpperCase();
            if (!nfoOptIndex[name]) nfoOptIndex[name] = [];
            nfoOptIndex[name].push(inst);
        } else if (inst.exchange === 'MCX') {
            const name = String(inst.name || '').toUpperCase();
            if (!mcxOptIndex[name]) mcxOptIndex[name] = [];
            mcxOptIndex[name].push(inst);
        }
    }

    _precomputed = { nseKeys, nfoConfig, nfoFutKeys, nfoFutMeta, nfoFutByBase, nfoStockUniverse, mcxFutBases, mcxFutByBase, mcxOptRequested, mcxOptRange, ltpKeys, nfoOptIndex, mcxOptIndex, indexSymbolMap };
    _precomputedInstrTime = instrumentsCacheTime;
    _precomputedQuerySig = querySig;
    console.log(`⚡ Precomputed: NSE=${nseKeys.length} | NFO underlyings=${nfoConfig.length} | MCX bases=${mcxFutBases.length} | LTP keys=${ltpKeys.length}`);
    return _precomputed;
}

async function _buildWatchlistData(query, userId) {
    // Token sync
    if (!kiteService.isAuthenticated() && userId) {
        try {
            const status = await kiteAuthService.getStatus(userId);
            if (status.connected) {
                const session = await require('../repositories/KiteRepository').getSessionByUserId(userId);
                if (session?.access_token) {
                    kiteService.accessToken = session.access_token;
                    kiteService.sessionData = { access_token: session.access_token, user_name: session.user_name };
                }
            }
        } catch (_) { }
    }

    if (!kiteService.isAuthenticated()) {
        throw new Error('Kite not connected');
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const instruments = await getInstrumentsFromCache();
    const pc = _getPrecomputed(instruments, query);

    // ── Step 1: ONE batch call for all LTP keys (index + futures) ──
    let ltpQuotes = {};
    if (pc.ltpKeys.length > 0) {
        try { ltpQuotes = await kiteService.getQuote(pc.ltpKeys); } catch (_) { }
    }

    // One-time: auto-exclude 2nd expiry CE/PE options so default count stays at 1 expiry
    _initCepeExclOnce(pc, today);

    // Excluded contracts — used by options (step 2), MCX FUT (step 3), NFO stock FUT (step 3b), MCX OPT (step 4)
    const _excl = global.EXCLUDED_CONTRACTS || [];

    // ── Step 2: NFO index options ──
    const nfoIndexOptRange = parseInt(query.nfoIndexOptRange, 10);
    const nfoOptKeys = [];
    const nfoOptMeta = {};
    for (const cfg of pc.nfoConfig) {
        if (!NFO_INDEX_OPTION_UNDERLYINGS.has(String(cfg.underlying || '').toUpperCase())) continue;
        const step = getOptionStrikeStepNfo(cfg.underlying);
        if (!step) continue;
        const ltp = resolveNfoIndexSpotLtp(ltpQuotes, cfg);
        if (!ltp) continue;
        const optList = pc.nfoOptIndex[cfg.underlying] || [];
        // Nearest 2 non-expired option expiries — matches Contract Management display
        const nfoOptExpiries = [...new Set(
            optList.filter(i => new Date(i.expiry || 0) >= today).map(i => i.expiry)
        )].sort((a, b) => new Date(a) - new Date(b)).slice(0, 2);
        if (nfoOptExpiries.length === 0) continue;
        
        // ATM ±10 strikes range to match Contract Management
        const atm = Math.round(ltp / step) * step;
        const maxRange = Number.isFinite(nfoIndexOptRange) && nfoIndexOptRange > 0 ? nfoIndexOptRange : (step * 10);
        const lowerBound = atm - maxRange;
        const upperBound = atm + maxRange;
        const strikeSet = new Set();
        for (let s = lowerBound; s <= upperBound; s += step) strikeSet.add(s);
        for (const expiry of nfoOptExpiries) {
            const expiryYmd = toYmd(expiry);
            const requestedExpiry = new Date(expiry).toDateString();
            for (const inst of optList) {
                if (new Date(inst.expiry || 0).toDateString() !== requestedExpiry) continue;
                const strike = Number(inst.strike);
                if (!strikeSet.has(strike)) continue;
                const fullKey = `NFO:${inst.tradingsymbol}`;
                if (_excl.includes(fullKey)) continue;
                const it = String(inst.instrument_type || '').toUpperCase();
                nfoOptKeys.push(fullKey);
                nfoOptMeta[fullKey] = { strike, optionType: it, expiry: expiryYmd };
            }
        }
    }

    // ── Step 3: MCX Futures — skip excluded contracts (Contract Management controls visibility) ──
    const mcxFutKeys = [];
    const mcxFutMeta = {};
    for (const base of pc.mcxFutBases) {
        const contracts = pc.mcxFutByBase[base] || [];
        for (const f of contracts) {
            if (_excl.includes(f.fullKey)) continue;
            mcxFutKeys.push(f.fullKey);
            mcxFutMeta[f.fullKey] = { expiry: toYmd(f.expiry) };
        }
    }

    // ── Step 3b: NFO Stock Futures — same excluded-filter pattern as MCX ──
    // pc.nfoFutKeys has only INDEX futures (NIFTY/BANKNIFTY/etc.) from precompute.
    // Stock futures are built here from the pool so Contract Management enable/disable works.
    const nfoStockFutKeys = [];
    const nfoStockFutMeta = {};
    for (const stockSym of (pc.nfoStockUniverse || [])) {
        const pool = pc.nfoFutByBase[stockSym.toUpperCase()] || [];
        for (const f of pool) {
            if (_excl.includes(f.fullKey)) continue;
            if (!nfoStockFutKeys.includes(f.fullKey)) {
                nfoStockFutKeys.push(f.fullKey);
                nfoStockFutMeta[f.fullKey] = { expiry: toYmd(f.expiry) };
            }
        }
    }
    // Index futures from precompute also respect excluded
    const activeIndexFutKeys = pc.nfoFutKeys.filter(k => !_excl.includes(k));
    // Combined NFO FUT keys used in steps 5 and 6
    const allNfoFutKeys = [...activeIndexFutKeys, ...nfoStockFutKeys];

    // ── Step 4: MCX Options (ATM ±range filter, same as NFO options) ──
    const mcxOptRangePts = pc.mcxOptRange || 5000;
    const mcxOptKeys = [];
    const mcxOptMeta = {};
    for (const reqName of pc.mcxOptRequested) {
        const base = canonicalMcxName(reqName);
        const step = MCX_ALLOWED[base]?.step || 10;
        const contracts = pc.mcxFutByBase[base] || [];
        const fut = contracts.find(f => new Date(f.expiry) >= today) || contracts[0];
        if (!fut) continue;
        if (!global.LAST_KNOWN_LTPS) {
            global.LAST_KNOWN_LTPS = {};
        }
        let ltp = ltpQuotes?.[fut.fullKey]?.last_price || 0;
        const cacheKey = base;
        if (ltp > 0) {
            global.LAST_KNOWN_LTPS[cacheKey] = ltp;
            global.LAST_KNOWN_LTPS[fut.fullKey] = ltp;
        } else {
            ltp = global.LAST_KNOWN_LTPS[cacheKey] || global.LAST_KNOWN_LTPS[fut.fullKey] || 0;
            if (!ltp) {
                const mcxDefaults = {
                    CRUDEOIL: 6500,
                    CRUDEOILM: 6500,
                    MCRUDEOIL: 6500,
                    NATURALGAS: 200,
                    NATURALGASMINI: 200,
                    MNATURALGAS: 200,
                    GOLD: 93000,
                    GOLDM: 93000,
                    MGOLD: 93000,
                    SILVER: 95000,
                    SILVERM: 95000,
                    MSILVER: 95000
                };
                ltp = mcxDefaults[base] || 1000;
            }
        }
        const optList = pc.mcxOptIndex[base] || [];
        // Nearest 2 non-expired option expiries — matches Contract Management display
        const mcxOptExpiries = [...new Set(
            optList.filter(i => new Date(i.expiry || 0) >= today).map(i => i.expiry)
        )].sort((a, b) => new Date(a) - new Date(b)).slice(0, 2);
        if (mcxOptExpiries.length === 0) continue;

        // Build ATM strike range (same for all expiries of this base) - ATM ±10 strikes
        const atm = Math.round(ltp / step) * step;
        const maxRange = Number.isFinite(pc.mcxOptRange) && pc.mcxOptRange > 0 ? pc.mcxOptRange : (step * 10);
        const lowerBound = atm - maxRange;
        const upperBound = atm + maxRange;
        const strikeSet = new Set();
        for (let s = lowerBound; s <= upperBound; s += step) strikeSet.add(s);

        for (const expiry of mcxOptExpiries) {
            const expiryYmd = toYmd(expiry);
            const requestedExpiry = new Date(expiry).toDateString();
            for (const inst of optList) {
                if (new Date(inst.expiry || 0).toDateString() !== requestedExpiry) continue;
                const strike = Number(inst.strike);
                if (!strikeSet.has(strike)) continue; // outside ATM ±range
                const fullKey = `MCX:${inst.tradingsymbol}`;
                if (_excl.includes(fullKey)) continue;
                const it = String(inst.instrument_type || '').toUpperCase();
                mcxOptKeys.push(fullKey);
                mcxOptMeta[fullKey] = { strike, optionType: it, expiry: expiryYmd, base };
            }
        }
    }

    // Sort MCX options sequentially: base -> expiry -> strike -> type
    mcxOptKeys.sort((a, b) => {
        const mA = mcxOptMeta[a];
        const mB = mcxOptMeta[b];
        if (!mA || !mB) return 0;

        const baseOrder = { GOLD: 0, GOLDM: 0, SILVER: 1, SILVERM: 1, CRUDEOIL: 2, CRUDEOILM: 2, NATURALGAS: 3, NATURALGASMINI: 3 };
        const baseA = baseOrder[mA.base] !== undefined ? baseOrder[mA.base] : 999;
        const baseB = baseOrder[mB.base] !== undefined ? baseOrder[mB.base] : 999;

        if (baseA !== baseB) return baseA - baseB;
        if (mA.expiry !== mB.expiry) return mA.expiry.localeCompare(mB.expiry);
        if (mA.strike !== mB.strike) return mA.strike - mB.strike;
        if (mA.optionType !== mB.optionType) return mA.optionType.localeCompare(mB.optionType);
        return 0;
    });

    // ── Step 5: ONE batch quote fetch for ALL symbols ──
    const allKeys = [...pc.nseKeys, ...allNfoFutKeys, ...nfoOptKeys, ...mcxFutKeys, ...mcxOptKeys];
    const uniqueKeys = Array.from(new Set(allKeys));
    const rawQuotes = {};
    const chunks = [];
    for (let i = 0; i < uniqueKeys.length; i += 500) chunks.push(uniqueKeys.slice(i, i + 500));
    const results = await Promise.all(chunks.map(chunk => kiteService.getQuote(chunk).catch(() => ({}))));
    for (const r of results) if (r && typeof r === 'object') Object.assign(rawQuotes, r);

    // Fetch lot sizes from database
    const [lotRows] = await db.execute('SELECT symbol, lot_size FROM scrip_data');
    const lotMap = {};
    lotRows.forEach(r => {
        lotMap[r.symbol.toUpperCase()] = parseFloat(r.lot_size || 1);
    });
    
    console.log(`📊 Loaded ${Object.keys(lotMap).length} lot sizes from scrip_data`);

    const getLotSize = (key) => {
        const sym = key.includes(':') ? key.split(':')[1] : key;
        return lotMap[sym.toUpperCase()] || 1;
    };

    // ── Step 6: Build all rows ──
    let rows = [];
    for (const key of pc.nseKeys) rows.push(buildUnifiedRow({ type: 'NSE', symbol: key, quote: rawQuotes[key], lotSize: getLotSize(key) }));
    for (const key of allNfoFutKeys) {
        const m = pc.nfoFutMeta[key] || nfoStockFutMeta[key] || {};
        rows.push(buildUnifiedRow({ type: 'FUT', symbol: key, expiry: m.expiry, quote: rawQuotes[key], lotSize: getLotSize(key) }));
    }
    for (const key of nfoOptKeys) {
        const m = nfoOptMeta[key] || {};
        rows.push(buildUnifiedRow({ type: 'NFO_OPT', symbol: key, strike: m.strike, optionType: m.optionType, expiry: m.expiry, quote: rawQuotes[key], lotSize: getLotSize(key) }));
    }
    for (const key of mcxFutKeys) {
        const m = mcxFutMeta[key] || {};
        rows.push(buildUnifiedRow({ type: 'MCX_FUT', symbol: key, expiry: m.expiry, quote: rawQuotes[key], lotSize: getLotSize(key) }));
    }
    for (const key of mcxOptKeys) {
        const m = mcxOptMeta[key] || {};
        rows.push(buildUnifiedRow({ type: 'MCX_OPT', symbol: key, strike: m.strike, optionType: m.optionType, expiry: m.expiry, quote: rawQuotes[key], lotSize: getLotSize(key) }));
    }

    // ── Step 7: Gather Contract Management Exclusions (Visibility decided by frontend) ──
    const excluded = global.EXCLUDED_CONTRACTS || [];

    // ── DIAGNOSTIC: log row counts ──
    const _nseCnt = rows.filter(r => r.type === 'NSE').length;
    const _nfoFutCnt = rows.filter(r => r.type === 'FUT').length;
    const _nfoOptCnt = rows.filter(r => r.type === 'NFO_OPT').length;
    const _mcxFutCnt = rows.filter(r => r.type === 'MCX_FUT').length;
    const _mcxOptCnt = rows.filter(r => r.type === 'MCX_OPT').length;
    console.log(`🔍 _buildWatchlistData rows: NSE=${_nseCnt} NFO_FUT=${_nfoFutCnt} NFO_OPT=${_nfoOptCnt} MCX_FUT=${_mcxFutCnt} MCX_OPT=${_mcxOptCnt} mcxFutKeys=${mcxFutKeys.length} nfoFutKeys=${allNfoFutKeys.length}(idx=${activeIndexFutKeys.length}+stk=${nfoStockFutKeys.length}) total=${rows.length}`);
    if (mcxFutKeys.length === 0) console.log(`🔍 mcxFutByBase keys: ${Object.keys(pc.mcxFutByBase).join(', ')}`);

    // ── Step 8: Push via WebSocket ──
    const io = require('../websocket/SocketManager').getIo();
    if (io) {
        const wsPayload = {};
        for (const row of rows) wsPayload[row.symbol] = row;
        io.emit('price_update', wsPayload);
    }

    return rows;
}

// ══════════════════════════════════════════════════════════════
//   OPTIONS CHAIN — Range-based strike chain (CE + PE)
// ══════════════════════════════════════════════════════════════

// Strike step sizes per index (how far apart each strike is)
const STRIKE_STEPS = {
    NIFTY: 50,
    BANKNIFTY: 100,
    FINNIFTY: 50,
    MIDCPNIFTY: 25,
    SENSEX: 100,
};

// Options chain cache — per-key TTL, separate from dashboard cache
const optionsChainCache = {};  // { key: { data, time } }
const OPTIONS_CACHE_TTL = 1500; // 1.5 seconds (same as dashboard quotes)

// ── /market/options-chain — Returns CE + PE for strikes within ±range of LTP ──
router.get('/market/options-chain', authMiddleware, asyncHandler(async (req, res) => {
    try {
        if (!kiteService.isAuthenticated()) {
            return res.status(503).json({ error: 'Kite not connected.', kite_disconnected: true });
        }

        // ── 1. Parse & validate query params ──
        const symbol = (req.query.symbol || '').toUpperCase();
        const range = parseInt(req.query.range) || 1000;
        const expiry = req.query.expiry || '';  // e.g. "2026-04-24"

        if (!symbol) {
            return res.status(400).json({ error: 'symbol is required (e.g. NIFTY, BANKNIFTY)' });
        }
        if (!expiry) {
            return res.status(400).json({ error: 'expiry is required (e.g. 2026-04-24)' });
        }

        const step = STRIKE_STEPS[symbol];
        if (!step) {
            return res.status(400).json({
                error: `Unknown symbol: ${symbol}. Supported: ${Object.keys(STRIKE_STEPS).join(', ')}`,
            });
        }

        // ── 2. Cache check — avoid hammering Kite API ──
        const cacheKey = `${symbol}_${expiry}_${range}`;
        const now = Date.now();
        const cached = optionsChainCache[cacheKey];
        if (cached && (now - cached.time) < OPTIONS_CACHE_TTL) {
            return res.json(cached.data);
        }

        // ── 3. Get current LTP of the underlying index ──
        //    NIFTY → NSE:NIFTY 50, BANKNIFTY → NSE:NIFTY BANK
        const indexSymbolMap = {
            NIFTY: 'NSE:NIFTY 50',
            BANKNIFTY: 'NSE:NIFTY BANK',
            FINNIFTY: 'NSE:NIFTY FIN SERVICE',
            MIDCPNIFTY: 'NSE:NIFTY MID SELECT',
            SENSEX: 'BSE:SENSEX',
        };

        const indexKey = indexSymbolMap[symbol] || `NSE:${symbol}`;
        let ltp = 0;

        try {
            const ltpResult = await kiteService.getQuote([indexKey]);
            ltp = ltpResult?.[indexKey]?.last_price || 0;
        } catch (ltpErr) {
            console.warn('Options chain: LTP fetch failed for', indexKey, ltpErr.message);
        }

        // Fallback: if LTP fetch fails, try the futures price
        if (!ltp) {
            try {
                const instruments = await getInstrumentsFromCache();
                const futContract = instruments
                    .filter(i => i.exchange === 'NFO' && i.name === symbol && i.instrument_type === 'FUT')
                    .sort((a, b) => new Date(a.expiry || 0) - new Date(b.expiry || 0))
                    .find(i => new Date(i.expiry) >= new Date());

                if (futContract) {
                    const futKey = `NFO:${futContract.tradingsymbol}`;
                    const futResult = await kiteService.getQuote([futKey]);
                    ltp = futResult?.[futKey]?.last_price || 0;
                }
            } catch (_) { }
        }

        if (!ltp) {
            return res.status(400).json({ error: `Could not fetch LTP for ${symbol}. Market may be closed.` });
        }

        // ── 4. Calculate strike range ──
        const atmStrike = Math.round(ltp / step) * step;
        const lowerBound = Math.floor((ltp - range) / step) * step;
        const upperBound = Math.ceil((ltp + range) / step) * step;

        // Generate all strikes in range
        const strikes = [];
        for (let s = lowerBound; s <= upperBound; s += step) {
            strikes.push(s);
        }

        // ── 5. Find matching CE + PE instruments from cached instrument list ──
        const instruments = await getInstrumentsFromCache();

        // Filter to only this symbol's options for the requested expiry
        // Normalize expiry formats: CSV may have "2026-04-24", "2026-04-24T00:00:00", "24-04-2026" etc.
        const requestedExpiry = new Date(expiry).toDateString(); // "Thu Apr 24 2026"

        const optionInstruments = instruments.filter(i => {
            if (i.exchange !== 'NFO') return false;
            if (i.name !== symbol) return false;
            if (i.instrument_type !== 'CE' && i.instrument_type !== 'PE') return false;
            // Robust expiry match — compare as Date objects
            const instrExpiry = new Date(i.expiry || 0).toDateString();
            return instrExpiry === requestedExpiry;
        });

        // Build a lookup: { "5400_CE": instrument, "5400_PE": instrument }
        const strikeSet = new Set(strikes);
        const instrumentMap = {};
        const symbolsToFetch = [];

        for (const inst of optionInstruments) {
            const strike = parseFloat(inst.strike);
            if (!strikeSet.has(strike)) continue;

            const key = `${strike}_${inst.instrument_type}`;
            instrumentMap[key] = inst;
            symbolsToFetch.push(`NFO:${inst.tradingsymbol}`);
        }

        console.log(`📊 Options Chain: ${symbol} LTP=${ltp} ATM=${atmStrike} | Range=${lowerBound}-${upperBound} | ${strikes.length} strikes | ${symbolsToFetch.length} contracts to fetch`);

        // DEBUG: Log sample instruments to verify matching
        if (symbolsToFetch.length === 0) {
            console.warn(`⚠️  Options Chain: 0 contracts found! Checking instrument data...`);
            const sampleOpts = instruments.filter(i => i.exchange === 'NFO' && i.name === symbol && (i.instrument_type === 'CE' || i.instrument_type === 'PE')).slice(0, 3);
            console.warn(`   Sample instruments:`, sampleOpts.map(i => ({ ts: i.tradingsymbol, expiry: i.expiry, strike: i.strike, type: i.instrument_type })));
            console.warn(`   Requested expiry: "${expiry}"`);
            console.warn(`   Strike range: ${lowerBound}-${upperBound}, step: ${step}`);
        } else {
            console.log(`   First 3 symbols: ${symbolsToFetch.slice(0, 3).join(', ')}`);
        }

        // ── 6. Fetch FRESH quotes directly (bypass any shared cache) ──
        const rawQuotes = {};
        const batchSize = 500;
        for (let i = 0; i < symbolsToFetch.length; i += batchSize) {
            const batch = symbolsToFetch.slice(i, i + batchSize);
            try {
                const result = await kiteService.getQuote(batch);
                if (result && typeof result === 'object') Object.assign(rawQuotes, result);
            } catch (err) {
                console.warn(`Options quote batch error:`, err.message);
            }
            if (i + batchSize < symbolsToFetch.length) await sleep(80);
        }

        // DEBUG: Log a sample quote to verify data is fresh
        const sampleKey = symbolsToFetch[0];
        if (sampleKey && rawQuotes[sampleKey]) {
            console.log(`   Sample quote [${sampleKey}]: LTP=${rawQuotes[sampleKey].last_price}, Vol=${rawQuotes[sampleKey].volume}, Timestamp=${rawQuotes[sampleKey].timestamp}`);
        } else if (sampleKey) {
            console.warn(`   ⚠️ No quote data for ${sampleKey}! Keys in response:`, Object.keys(rawQuotes).slice(0, 5));
        }

        // ── 7. Build the chain: one row per strike with CE + PE ──
        const chain = [];

        for (const strike of strikes) {
            const ceInst = instrumentMap[`${strike}_CE`];
            const peInst = instrumentMap[`${strike}_PE`];

            const ceKey = ceInst ? `NFO:${ceInst.tradingsymbol}` : null;
            const peKey = peInst ? `NFO:${peInst.tradingsymbol}` : null;

            const ceQuote = ceKey ? rawQuotes[ceKey] : null;
            const peQuote = peKey ? rawQuotes[peKey] : null;

            // Classify: ITM / ATM / OTM
            let classification;
            if (strike === atmStrike) {
                classification = 'ATM';
            } else if (strike < atmStrike) {
                classification = 'ITM';  // CE is ITM below ATM, PE is OTM
            } else {
                classification = 'OTM';  // CE is OTM above ATM, PE is ITM
            }

            chain.push({
                strike,
                classification,
                isATM: strike === atmStrike,
                CE: ceQuote ? {
                    tradingsymbol: ceInst.tradingsymbol,
                    token: ceInst.instrument_token,
                    ltp: ceQuote.last_price || 0,
                    oi: ceQuote.oi || 0,
                    volume: ceQuote.volume || 0,
                    chg: ceQuote.net_change || 0,
                    chg_pct: ceQuote.ohlc?.close
                        ? (((ceQuote.last_price - ceQuote.ohlc.close) / ceQuote.ohlc.close) * 100).toFixed(2)
                        : '0.00',
                    bid: ceQuote.depth?.buy?.[0]?.price || 0,
                    ask: ceQuote.depth?.sell?.[0]?.price || 0,
                    open: ceQuote.ohlc?.open || 0,
                    high: ceQuote.ohlc?.high || 0,
                    low: ceQuote.ohlc?.low || 0,
                    close: ceQuote.ohlc?.close || 0,
                } : null,
                PE: peQuote ? {
                    tradingsymbol: peInst.tradingsymbol,
                    token: peInst.instrument_token,
                    ltp: peQuote.last_price || 0,
                    oi: peQuote.oi || 0,
                    volume: peQuote.volume || 0,
                    chg: peQuote.net_change || 0,
                    chg_pct: peQuote.ohlc?.close
                        ? (((peQuote.last_price - peQuote.ohlc.close) / peQuote.ohlc.close) * 100).toFixed(2)
                        : '0.00',
                    bid: peQuote.depth?.buy?.[0]?.price || 0,
                    ask: peQuote.depth?.sell?.[0]?.price || 0,
                    open: peQuote.ohlc?.open || 0,
                    high: peQuote.ohlc?.high || 0,
                    low: peQuote.ohlc?.low || 0,
                    close: peQuote.ohlc?.close || 0,
                } : null,
            });
        }

        // ── 8. Build response ──
        const response = {
            status: 'success',
            symbol,
            ltp,
            atm: atmStrike,
            step,
            expiry,
            range: `${lowerBound}-${upperBound}`,
            count: chain.length,
            totalContracts: symbolsToFetch.length,
            timestamp: new Date().toISOString(),
            data: chain,
        };

        // Cache the response
        optionsChainCache[cacheKey] = { data: response, time: now };

        res.json(response);
    } catch (err) {
        console.error('Options chain error:', err.message);
        if (err.message?.includes('403') || err.message?.includes('expired')) {
            return res.status(503).json({ error: 'Kite session expired.', kite_disconnected: true });
        }
        res.status(500).json({ status: 'error', message: err.message });
    }
}));

// ══════════════════════════════════════════════════════════════
//   MCX CONTROLLED FUTURES + OPTIONS CHAIN
// ══════════════════════════════════════════════════════════════

// STRICT allowed MCX symbols — nothing else gets through
const MCX_ALLOWED = {
    // Main contracts
    GOLD: { step: 100, label: 'Gold' },
    SILVER: { step: 500, label: 'Silver' },
    CRUDEOIL: { step: 50, label: 'Crude Oil' },
    COPPER: { step: 5, label: 'Copper' },
    ZINC: { step: 5, label: 'Zinc' },
    ALUMINIUM: { step: 5, label: 'Aluminium' },
    LEAD: { step: 5, label: 'Lead' },
    NATURALGAS: { step: 10, label: 'Natural Gas' },
    // Mini contracts
    GOLDM: { step: 100, label: 'Gold Mini' },
    SILVERM: { step: 500, label: 'Silver Mini' },
    CRUDEOILM: { step: 50, label: 'Crude Oil Mini' },
    ZINCMINI: { step: 5, label: 'Zinc Mini' },
    ALUMINI: { step: 5, label: 'Aluminium Mini' },
    LEADMINI: { step: 5, label: 'Lead Mini' },
    COPPERM: { step: 5, label: 'Copper Mini' },
    NATGASMINI: { step: 10, label: 'Natural Gas Mini' },
    // Custom Merged contracts
    MGOLD: { step: 100, label: 'Merged Gold' },
    MCRUDEOIL: { step: 50, label: 'Merged Crude Oil' },
    MSILVER: { step: 500, label: 'Merged Silver' },
    MNATURALGAS: { step: 10, label: 'Merged Natural Gas' },
    MCOPPER: { step: 5, label: 'Merged Copper' },
    MLEAD: { step: 5, label: 'Merged Lead' },
    MZINC: { step: 5, label: 'Merged Zinc' },
    MALUMINIUM: { step: 5, label: 'Merged Aluminium' },
};

const MCX_MAIN = ['GOLD', 'SILVER', 'CRUDEOIL', 'COPPER', 'ZINC', 'ALUMINIUM', 'LEAD', 'NATURALGAS'];
const MCX_MINI = ['GOLDM', 'SILVERM', 'CRUDEOILM', 'ZINCMINI', 'ALUMINI', 'LEADMINI', 'COPPERM', 'NATGASMINI', 'MGOLD', 'MCRUDEOIL', 'MSILVER', 'MNATURALGAS', 'MCOPPER', 'MLEAD', 'MZINC', 'MALUMINIUM'];
const MCX_ALL_SYMBOLS = [...MCX_MAIN, ...MCX_MINI];

// Helper: fetch fresh quotes (NO cache, always live)
async function fetchFreshQuotes(symbols) {
    const quotes = {};
    const batchSize = 500;
    for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);
        try {
            const result = await kiteService.getQuote(batch);
            if (result && typeof result === 'object') Object.assign(quotes, result);
        } catch (err) {
            console.warn('MCX quote batch error:', err.message);
        }
        if (i + batchSize < symbols.length) await sleep(80);
    }
    return quotes;
}

function resolveNfoIndexSpotLtp(ltpQuotes, cfg) {
    if (!cfg) return 0;
    if (!global.LAST_KNOWN_LTPS) {
        global.LAST_KNOWN_LTPS = {};
    }
    const fromQuote = (key) => {
        if (!key || !ltpQuotes || !ltpQuotes[key]) return 0;
        const q = ltpQuotes[key];
        const lp = Number(q.last_price);
        if (Number.isFinite(lp) && lp > 0) return lp;
        const oc = Number(q.ohlc?.close);
        if (Number.isFinite(oc) && oc > 0) return oc;
        const av = Number(q.average_price);
        if (Number.isFinite(av) && av > 0) return av;
        return 0;
    };
    let ltp = fromQuote(cfg.idxKey);
    if (!ltp && cfg.futKey) {
        ltp = fromQuote(cfg.futKey);
    }
    const cacheKey = cfg.underlying || cfg.idxKey;
    if (ltp > 0) {
        global.LAST_KNOWN_LTPS[cacheKey] = ltp;
        if (cfg.idxKey) global.LAST_KNOWN_LTPS[cfg.idxKey] = ltp;
        if (cfg.futKey) global.LAST_KNOWN_LTPS[cfg.futKey] = ltp;
        return ltp;
    }
    if (global.LAST_KNOWN_LTPS[cacheKey] && global.LAST_KNOWN_LTPS[cacheKey] > 0) {
        return global.LAST_KNOWN_LTPS[cacheKey];
    }
    if (cfg.idxKey && global.LAST_KNOWN_LTPS[cfg.idxKey] && global.LAST_KNOWN_LTPS[cfg.idxKey] > 0) {
        return global.LAST_KNOWN_LTPS[cfg.idxKey];
    }
    const defaults = {
        NIFTY: 24000,
        BANKNIFTY: 52000,
        FINNIFTY: 23000,
        MIDCPNIFTY: 12000
    };
    const under = String(cfg.underlying || '').toUpperCase();
    return defaults[under] || 24000;
}

// Helper: format a quote into clean object
function formatMcxQuote(quote) {
    if (!quote) return null;
    return {
        ltp: quote.last_price || 0,
        bid: quote.depth?.buy?.[0]?.price || 0,
        ask: quote.depth?.sell?.[0]?.price || 0,
        oi: quote.oi || 0,
        volume: quote.volume || 0,
        chg: quote.net_change || 0,
        chg_pct: quote.ohlc?.close
            ? (((quote.last_price - quote.ohlc.close) / quote.ohlc.close) * 100).toFixed(2)
            : '0.00',
        open: quote.ohlc?.open || 0,
        high: quote.ohlc?.high || 0,
        low: quote.ohlc?.low || 0,
        close: quote.ohlc?.close || 0,
    };
}

function isExactMcxFutureForBase(tradingSymbol, base) {
    const ts = String(tradingSymbol || '').toUpperCase();
    const b = String(base || '').toUpperCase();
    if (!ts || !b) return false;
    if (ts === b) return true;
    return new RegExp(`^${b}\\d{1,2}[A-Z]{3}\\d{0,2}FUT$`).test(ts);
}

// ── /market/mcx-futures — Filtered MCX futures (main + mini) ──
router.get('/market/mcx-futures', authMiddleware, asyncHandler(async (req, res) => {
    try {
        if (!kiteService.isAuthenticated()) {
            return res.status(503).json({ error: 'Kite not connected.', kite_disconnected: true });
        }

        const filter = (req.query.filter || 'ALL').toUpperCase(); // ALL, MAIN, MINI, or specific symbol

        const instruments = await getInstrumentsFromCache();
        const today = new Date();

        // Decide which symbols
        let allowedList;
        if (filter === 'ALL') allowedList = MCX_ALL_SYMBOLS;
        else if (filter === 'MAIN') allowedList = MCX_MAIN;
        else if (filter === 'MINI') allowedList = MCX_MINI;
        else if (MCX_ALLOWED[filter]) allowedList = [filter];
        else return res.status(400).json({ error: `Unknown filter: ${filter}. Allowed: ALL, MAIN, MINI, ${MCX_ALL_SYMBOLS.join(', ')}` });

        // Find nearest FUT contract for each allowed symbol
        const futures = [];
        const symbolsToFetch = [];

        for (const base of allowedList) {
            const nearest = instruments
                .filter(i => i.exchange === 'MCX' && i.instrument_type === 'FUT'
                    && isExactMcxFutureForBase(i.tradingsymbol, base))
                .filter(i => new Date(i.expiry || 0) >= today)
                .sort((a, b) => new Date(a.expiry || 0) - new Date(b.expiry || 0))[0];

            if (nearest) {
                const fullKey = `MCX:${nearest.tradingsymbol}`;
                const futMatch = nearest.tradingsymbol.match(/^([A-Z]+?)(\d{2}[A-Z]{3}\d{0,2})FUT$/);
                futures.push({
                    base,
                    label: MCX_ALLOWED[base]?.label || base,
                    tradingsymbol: nearest.tradingsymbol,
                    fullKey,
                    expiry: new Date(nearest.expiry || 0).toISOString().substring(0, 10),
                    lot_size: nearest.lot_size || '',
                    displayName: futMatch ? `${futMatch[1]} ${futMatch[2]}` : nearest.tradingsymbol,
                    isMain: MCX_MAIN.includes(base),
                });
                symbolsToFetch.push(fullKey);
            }
        }

        // Fetch FRESH quotes — NO cache
        const rawQuotes = await fetchFreshQuotes(symbolsToFetch);

        // Build response
        const data = futures.map(f => ({
            ...f,
            ...formatMcxQuote(rawQuotes[f.fullKey]),
            timestamp: rawQuotes[f.fullKey]?.timestamp || null,
        }));

        res.json({
            status: 'success',
            filter,
            count: data.length,
            categories: { MAIN: MCX_MAIN, MINI: MCX_MINI },
            timestamp: new Date().toISOString(),
            data,
        });
    } catch (err) {
        console.error('MCX futures error:', err.message);
        if (err.message?.includes('403') || err.message?.includes('expired')) {
            return res.status(503).json({ error: 'Kite session expired.', kite_disconnected: true });
        }
        res.status(500).json({ status: 'error', message: err.message });
    }
}));

// ── /market/mcx-options — Options chain for a specific MCX commodity ──
router.get('/market/mcx-options', authMiddleware, asyncHandler(async (req, res) => {
    try {
        if (!kiteService.isAuthenticated()) {
            return res.status(503).json({ error: 'Kite not connected.', kite_disconnected: true });
        }

        const symbol = (req.query.symbol || '').toUpperCase();
        const expiry = req.query.expiry || '';
        const range = parseInt(req.query.range) || 2000;

        if (!symbol || !MCX_ALLOWED[symbol]) {
            return res.status(400).json({ error: `Invalid symbol. Allowed: ${MCX_ALL_SYMBOLS.join(', ')}` });
        }
        if (!expiry) {
            return res.status(400).json({ error: 'expiry is required (e.g. 2026-04-28)' });
        }

        const step = MCX_ALLOWED[symbol].step;
        const instruments = await getInstrumentsFromCache();
        const today = new Date();

        // ── 1. Get LTP from nearest futures contract ──
        const futContract = instruments
            .filter(i => i.exchange === 'MCX' && i.instrument_type === 'FUT'
                && isExactMcxFutureForBase(i.tradingsymbol, symbol))
            .filter(i => new Date(i.expiry || 0) >= today)
            .sort((a, b) => new Date(a.expiry || 0) - new Date(b.expiry || 0))[0];

        if (!futContract) {
            return res.status(400).json({ error: `No active futures found for ${symbol}` });
        }

        const futKey = `MCX:${futContract.tradingsymbol}`;
        const futQuoteRaw = await kiteService.getQuote([futKey]);
        const futQuote = futQuoteRaw?.[futKey];
        const ltp = futQuote?.last_price || 0;

        if (!ltp) {
            return res.status(400).json({ error: `Could not fetch LTP for ${symbol}. Market may be closed.` });
        }

        // ── 2. Calculate strike range ──
        const atmStrike = Math.round(ltp / step) * step;
        const lowerBound = Math.floor((ltp - range) / step) * step;
        const upperBound = Math.ceil((ltp + range) / step) * step;

        const strikes = [];
        for (let s = lowerBound; s <= upperBound; s += step) {
            strikes.push(s);
        }

        // ── 3. Find CE + PE instruments for this symbol + expiry + strike range ──
        const requestedExpiry = new Date(expiry).toDateString();
        const strikeSet = new Set(strikes);
        const instrumentMap = {};
        const symbolsToFetch = [futKey]; // include futures for live data

        for (const inst of instruments) {
            if (inst.exchange !== 'MCX') continue;
            if (inst.name !== symbol) continue;
            if (inst.instrument_type !== 'CE' && inst.instrument_type !== 'PE') continue;
            if (new Date(inst.expiry || 0).toDateString() !== requestedExpiry) continue;

            const strike = parseFloat(inst.strike);
            if (!strikeSet.has(strike)) continue;

            const key = `${strike}_${inst.instrument_type}`;
            instrumentMap[key] = inst;
            symbolsToFetch.push(`MCX:${inst.tradingsymbol}`);
        }

        console.log(`📊 MCX Options: ${symbol} LTP=${ltp} ATM=${atmStrike} | ${strikes.length} strikes | ${symbolsToFetch.length - 1} option contracts`);

        // ── 4. Fetch FRESH quotes — NO cache ──
        const rawQuotes = await fetchFreshQuotes(symbolsToFetch);

        // ── 5. Build options chain ──
        const chain = [];
        for (const strike of strikes) {
            const ceInst = instrumentMap[`${strike}_CE`];
            const peInst = instrumentMap[`${strike}_PE`];

            const ceQuote = ceInst ? rawQuotes[`MCX:${ceInst.tradingsymbol}`] : null;
            const peQuote = peInst ? rawQuotes[`MCX:${peInst.tradingsymbol}`] : null;

            let classification;
            if (strike === atmStrike) classification = 'ATM';
            else if (strike < atmStrike) classification = 'ITM';
            else classification = 'OTM';

            chain.push({
                strike,
                classification,
                isATM: strike === atmStrike,
                CE: ceQuote ? { tradingsymbol: ceInst.tradingsymbol, ...formatMcxQuote(ceQuote) } : null,
                PE: peQuote ? { tradingsymbol: peInst.tradingsymbol, ...formatMcxQuote(peQuote) } : null,
            });
        }

        // ── 6. Response with futures data + options chain ──
        res.json({
            status: 'success',
            symbol,
            label: MCX_ALLOWED[symbol].label,
            step,
            expiry,
            future: {
                tradingsymbol: futContract.tradingsymbol,
                expiry: new Date(futContract.expiry || 0).toISOString().substring(0, 10),
                ...formatMcxQuote(rawQuotes[futKey]),
            },
            ltp,
            atm: atmStrike,
            range: `${lowerBound}-${upperBound}`,
            count: chain.length,
            totalContracts: symbolsToFetch.length - 1,
            timestamp: new Date().toISOString(),
            data: chain,
        });
    } catch (err) {
        console.error('MCX options error:', err.message);
        if (err.message?.includes('403') || err.message?.includes('expired')) {
            return res.status(503).json({ error: 'Kite session expired.', kite_disconnected: true });
        }
        res.status(500).json({ status: 'error', message: err.message });
    }
}));

// ── /market/mcx-expiries — Available option expiries for a MCX symbol ──
router.get('/market/mcx-expiries', authMiddleware, asyncHandler(async (req, res) => {
    try {
        if (!kiteService.isAuthenticated()) {
            return res.status(503).json({ error: 'Kite not connected.', kite_disconnected: true });
        }

        const symbol = (req.query.symbol || '').toUpperCase();
        if (!symbol || !MCX_ALLOWED[symbol]) {
            return res.status(400).json({ error: `Invalid symbol. Allowed: ${MCX_ALL_SYMBOLS.join(', ')}` });
        }

        const instruments = await getInstrumentsFromCache();
        const now = new Date();
        const expiries = new Set();

        for (const inst of instruments) {
            if (inst.exchange !== 'MCX') continue;
            if (inst.name !== symbol) continue;
            if (inst.instrument_type !== 'CE' && inst.instrument_type !== 'PE') continue;
            const expDate = new Date(inst.expiry || 0);
            if (isNaN(expDate.getTime()) || expDate < now) continue;
            expiries.add(expDate.toISOString().substring(0, 10));
        }

        res.json({
            status: 'success',
            symbol,
            label: MCX_ALLOWED[symbol].label,
            count: expiries.size,
            expiries: Array.from(expiries).sort(),
        });
    } catch (err) {
        console.error('MCX expiries error:', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
}));

// ── /market/options-expiries — Get available expiry dates for a symbol ──
router.get('/market/options-expiries', authMiddleware, asyncHandler(async (req, res) => {
    try {
        if (!kiteService.isAuthenticated()) {
            return res.status(503).json({ error: 'Kite not connected.', kite_disconnected: true });
        }

        const symbol = (req.query.symbol || '').toUpperCase();
        if (!symbol) {
            return res.status(400).json({ error: 'symbol is required' });
        }

        const instruments = await getInstrumentsFromCache();
        const now = new Date();

        // Find all unique future expiries for this symbol
        // Normalize to YYYY-MM-DD format regardless of CSV format
        const expiries = new Set();
        for (const inst of instruments) {
            if (inst.exchange !== 'NFO') continue;
            if (inst.name !== symbol) continue;
            if (inst.instrument_type !== 'CE' && inst.instrument_type !== 'PE') continue;
            const expDate = new Date(inst.expiry || 0);
            if (isNaN(expDate.getTime())) continue;
            if (expDate >= now) {
                // Normalize to YYYY-MM-DD
                const normalized = expDate.toISOString().substring(0, 10);
                expiries.add(normalized);
            }
        }

        // Sort ascending
        const sortedExpiries = Array.from(expiries).sort();

        // DEBUG: Log first instrument expiry format for troubleshooting
        const sampleInst = instruments.find(i => i.exchange === 'NFO' && i.name === symbol && (i.instrument_type === 'CE' || i.instrument_type === 'PE'));
        if (sampleInst) {
            console.log(`📅 Expiries for ${symbol}: CSV expiry format = "${sampleInst.expiry}", found ${sortedExpiries.length} future expiries`);
        }

        res.json({
            status: 'success',
            symbol,
            count: sortedExpiries.length,
            expiries: sortedExpiries,
        });
    } catch (err) {
        console.error('Options expiries error:', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
}));

// ── /market/search — Search all instruments ──
router.get('/market/search', authMiddleware, asyncHandler(async (req, res) => {
    if (!kiteService.isAuthenticated()) {
        return res.status(503).json({ error: 'Kite not connected.', kite_disconnected: true });
    }
    const { q } = req.query;
    if (!q || q.length < 2) return res.json({ status: 'success', count: 0, data: [] });

    const instruments = await getInstrumentsFromCache();
    const query = q.toUpperCase();
    
    // Fetch lot sizes from scrip_data for script-wise dynamic values without strict matching
    const [lotRows] = await db.execute('SELECT symbol, lot_size FROM scrip_data');
    const scripList = lotRows.map(r => {
        const sym = (r.symbol || '').toUpperCase().trim();
        const base = sym.replace(/\d+[A-Z]{3}\d*[CP]E$|\d+[A-Z]{3}\d*FUT$/i, '').trim();
        return {
            symbol: sym,
            base: base,
            lotSize: parseFloat(r.lot_size || 1)
        };
    }).sort((a, b) => b.symbol.length - a.symbol.length);

    const getDynamicLotSize = (inst) => {
        const tSym = (inst.tradingsymbol || '').toUpperCase().trim();
        const nameSym = (inst.name || '').toUpperCase().trim();

        let matched = scripList.find(s => s.symbol === tSym);
        if (matched && matched.lotSize > 0) return matched.lotSize;

        matched = scripList.find(s => s.symbol === nameSym || s.base === nameSym);
        if (matched && matched.lotSize > 0) return matched.lotSize;

        matched = scripList.find(s => tSym.startsWith(s.symbol));
        if (matched && matched.lotSize > 0) return matched.lotSize;

        matched = scripList.find(s => s.base && s.base.length >= 3 && tSym.startsWith(s.base));
        if (matched && matched.lotSize > 0) return matched.lotSize;

        const kiteLot = parseFloat(inst.lot_size);
        return (!isNaN(kiteLot) && kiteLot > 0) ? kiteLot : 1;
    };

    const results = instruments
        .filter(i => i.tradingsymbol?.toUpperCase().startsWith(query) || i.name?.toUpperCase().startsWith(query))
        .slice(0, 100)
        .map(i => ({
            symbol: i.tradingsymbol,
            exchange: i.exchange,
            name: i.name || '',
            type: i.instrument_type || '',
            expiry: i.expiry || '',
            instrument_token: i.instrument_token,
            lot_size: getDynamicLotSize(i),
            lotSize: getDynamicLotSize(i)
        }));

    res.json({ status: 'success', count: results.length, data: results });
}));

// ── /market — Legacy compat ──
router.get('/market', authMiddleware, asyncHandler(async (req, res) => {
    if (!kiteService.isAuthenticated()) {
        return res.status(503).json({ error: 'Kite not connected.', kite_disconnected: true });
    }
    const nseStocks = ALL_NSE_STOCKS.map(s => `NSE:${s}`);
    const rawQuotes = await fetchQuotesBatch(nseStocks);
    res.json({ status: 'success', count: Object.keys(rawQuotes).length, timestamp: new Date().toISOString(), data: formatQuotes(rawQuotes) });
}));

// ── KITE DATA APIs ────────────────────────────────────

router.get('/profile', authMiddleware, asyncHandler(async (req, res) => {
    const data = await kiteService.getProfile();
    res.json(data);
}));

router.get('/margins', authMiddleware, asyncHandler(async (req, res) => {
    const data = await kiteService.getMargins();
    res.json(data);
}));

router.get('/holdings', authMiddleware, asyncHandler(async (req, res) => {
    const data = await kiteService.getHoldings();
    res.json(data);
}));

router.get('/positions', authMiddleware, asyncHandler(async (req, res) => {
    const data = await kiteService.getPositions();
    res.json(data);
}));

router.get('/orders', authMiddleware, asyncHandler(async (req, res) => {
    const data = await kiteService.getOrders();
    res.json(data);
}));

router.get('/trades', authMiddleware, asyncHandler(async (req, res) => {
    const data = await kiteService.getTrades();
    res.json(data);
}));

router.get('/quote', authMiddleware, asyncHandler(async (req, res) => {
    const { i } = req.query;
    if (!i) return res.status(400).json({ error: 'Instrument Required' });
    const data = await kiteService.getQuote(i);
    res.json(data);
}));

router.get('/quote/ltp', authMiddleware, asyncHandler(async (req, res) => {
    const { i } = req.query;
    if (!i) return res.status(400).json({ error: 'Instrument Required' });
    const data = await kiteService.getLTP(i);
    res.json(data);
}));

router.get('/instruments', authMiddleware, asyncHandler(async (req, res) => {
    const data = await kiteService.getInstruments();
    res.json(data);
}));

router.get('/instruments/search', authMiddleware, asyncHandler(async (req, res) => {
    const { q, exchange } = req.query;
    if (!q || q.length < 1) return res.json([]);
    const instruments = await getInstrumentsFromCache();
    
    // BACKEND SEARCH LOGIC: Split by spaces and ensure every word is matched
    const searchTokens = q.toUpperCase().split(/\s+/).filter(t => t.length > 0);
    
    // Fetch lot sizes from scrip_data for script-wise dynamic values without strict matching
    const [lotRows] = await db.execute('SELECT symbol, lot_size FROM scrip_data');
    const scripList = lotRows.map(r => {
        const sym = (r.symbol || '').toUpperCase().trim();
        const base = sym.replace(/\d+[A-Z]{3}\d*[CP]E$|\d+[A-Z]{3}\d*FUT$/i, '').trim();
        return {
            symbol: sym,
            base: base,
            lotSize: parseFloat(r.lot_size || 1)
        };
    }).sort((a, b) => b.symbol.length - a.symbol.length);

    const getDynamicLotSize = (inst) => {
        const tSym = (inst.tradingsymbol || '').toUpperCase().trim();
        const nameSym = (inst.name || '').toUpperCase().trim();

        let matched = scripList.find(s => s.symbol === tSym);
        if (matched && matched.lotSize > 0) return matched.lotSize;

        matched = scripList.find(s => s.symbol === nameSym || s.base === nameSym);
        if (matched && matched.lotSize > 0) return matched.lotSize;

        matched = scripList.find(s => tSym.startsWith(s.symbol));
        if (matched && matched.lotSize > 0) return matched.lotSize;

        matched = scripList.find(s => s.base && s.base.length >= 3 && tSym.startsWith(s.base));
        if (matched && matched.lotSize > 0) return matched.lotSize;

        const kiteLot = parseFloat(inst.lot_size);
        return (!isNaN(kiteLot) && kiteLot > 0) ? kiteLot : 1;
    };

    let results = instruments.filter(i => {
        const symbolClean = (i.tradingsymbol || '').toUpperCase();
        const nameClean = (i.name || '').toUpperCase();
        
        // All parts of the search query must exist in the symbol or name
        const matchesQuery = searchTokens.every(token => 
            symbolClean.includes(token) || nameClean.includes(token)
        );
        
        const matchesExchange = !exchange || i.exchange === exchange;
        return matchesQuery && matchesExchange;
    }).slice(0, 100);
    res.json(results.map(i => ({
        exchange: i.exchange,
        symbol: i.tradingsymbol,
        name: i.name,
        type: i.instrument_type,
        expiry: i.expiry,
        instrument_token: i.instrument_token,
        lot_size: getDynamicLotSize(i),
        lotSize: getDynamicLotSize(i)
    })));
}));

router.post('/quotes', authMiddleware, asyncHandler(async (req, res) => {
    const { tokens } = req.body;
    if (!Array.isArray(tokens) || tokens.length === 0) {
        return res.json({});
    }

    try {
        const quotes = await kiteService.getQuote(tokens);
        const formatted = {};
        if (quotes && typeof quotes === 'object') {
            for (const [key, quote] of Object.entries(quotes)) {
                formatted[key] = {
                    bid: quote.bid || quote.last_price || 0,
                    ask: quote.ask || quote.last_price || 0,
                    last_price: quote.last_price || 0,
                    high: quote.ohlc?.high || 0,
                    low: quote.ohlc?.low || 0,
                    open: quote.ohlc?.open || 0,
                    close: quote.ohlc?.close || 0,
                    volume: quote.volume || 0
                };
            }
        }
        res.json(formatted);
    } catch (err) {
        console.error('[Kite Quotes] Error:', err.message);
        res.json({});
    }
}));

router.get('/sync-instruments', authMiddleware, asyncHandler(async (req, res) => {
    const InstrumentSyncService = require('../services/InstrumentSyncService');
    const result = await InstrumentSyncService.sync();
    // Clear lot size cache after sync
    global.LOT_SIZE_CACHE = null;
    res.json({ success: true, count: result.count });
}));

router.get('/instruments/historical/:instrumentToken/:interval', authMiddleware, asyncHandler(async (req, res) => {
    const { instrumentToken, interval } = req.params;
    const { from, to } = req.query;
    const data = await kiteService.getHistoricalData(instrumentToken, interval, from, to);
    res.json(data);
}));

// ── Kite Ticker (WebSocket) routes ──

router.get('/ticker/status', authMiddleware, asyncHandler(async (req, res) => {
    res.json({
        connected: kiteTicker.isConnected(),
        fallbackToMock: kiteTicker.fallbackToMock,
        subscribedCount: kiteTicker.subscribedTokens.length,
    });
}));

router.get('/ticker/prices', authMiddleware, asyncHandler(async (req, res) => {
    res.json(kiteTicker.getPrices());
}));

router.post('/ticker/subscribe', authMiddleware, asyncHandler(async (req, res) => {
    const { tokens, instrumentMap } = req.body;
    if (!tokens || !Array.isArray(tokens)) {
        return res.status(400).json({ error: 'tokens array required' });
    }
    if (instrumentMap) kiteTicker.setInstrumentMap(instrumentMap);
    kiteTicker.subscribe(tokens);
    res.json({ success: true, subscribedCount: kiteTicker.subscribedTokens.length });
}));

router.post('/ticker/unsubscribe', authMiddleware, asyncHandler(async (req, res) => {
    const { tokens } = req.body;
    if (!tokens || !Array.isArray(tokens)) {
        return res.status(400).json({ error: 'tokens array required' });
    }
    kiteTicker.unsubscribe(tokens);
    res.json({ success: true, subscribedCount: kiteTicker.subscribedTokens.length });
}));

router.post('/ticker/reconnect', authMiddleware, asyncHandler(async (req, res) => {
    kiteTicker.disconnect();
    kiteTicker.fallbackToMock = false;
    const started = await kiteTicker.start();
    res.json({ success: started, connected: kiteTicker.isConnected() });
}));

/**
 * Unified watchlist for Socket.IO (same cache + build path as GET /market/watchlist).
 * @param {number} userId
 * @param {object} query - same query keys as HTTP route
 * @returns {Promise<{ ok: boolean, data?: any[], kite_disconnected?: boolean, error?: string }>}
 */
async function fetchUnifiedWatchlistForSocket(userId, query = {}) {
    try {
        // If global session is gone, try to restore from per-user DB (same as buildKiteDashboardPayload)
        if (!kiteService.isAuthenticated() && userId) {
            try {
                const status = await kiteAuthService.getStatus(userId);
                if (status.connected) {
                    const session = await require('../repositories/KiteRepository').getSessionByUserId(userId);
                    if (session?.access_token) {
                        kiteService.accessToken = session.access_token;
                        kiteService.sessionData = { access_token: session.access_token, user_name: session.user_name };
                    }
                }
            } catch (_) { }
        }

        if (!kiteService.isAuthenticated()) {
            return { ok: false, kite_disconnected: true, data: [], error: 'Kite not connected.' };
        }

        const configVer = global.WATCHLIST_CONFIG_VERSION || 0;
        const cacheKey = `${query.nse || ''}_${query.nfoUnderlyings || ''}_${query.mcxOptSymbols || ''}_${query.nfoIndexOptRange || ''}_${WATCHLIST_CACHE_BUST}_v${configVer}`;

        if (watchlistCache.data && watchlistCache.key === cacheKey) {
            console.log(`🔍 fetchUnifiedWatchlistForSocket: CACHE HIT (${watchlistCache.data.length} rows)`);
            watchlistLastQuery = query;
            watchlistLastUserId = userId;
            startWatchlistAutoRefresh();
            return { ok: true, data: watchlistCache.data };
        }

        console.log(`🔍 fetchUnifiedWatchlistForSocket: CACHE MISS — building fresh (cacheKey="${cacheKey}")`);
        const rows = await _buildWatchlistData(query, userId);
        console.log(`🔍 fetchUnifiedWatchlistForSocket: built ${rows.length} rows`);
        watchlistCache = { data: rows, time: Date.now(), key: cacheKey };
        watchlistLastQuery = query;
        watchlistLastUserId = userId;
        startWatchlistAutoRefresh();
        return { ok: true, data: rows };
    } catch (err) {
        console.error('fetchUnifiedWatchlistForSocket:', err.message);
        if (err.message?.includes('403') || err.message?.includes('expired')) {
            kiteService.clearSession();
            try { if (userId) await kiteAuthService.disconnect(userId); } catch (_) { }
            return { ok: false, kite_disconnected: true, data: [], error: 'Kite session expired. Please reconnect.' };
        }
        if (String(err.message || '').includes('Kite not connected')) {
            return { ok: false, kite_disconnected: true, data: [], error: err.message };
        }
        return { ok: false, data: [], error: err.message };
    }
}

module.exports = router;
module.exports.fetchUnifiedWatchlistForSocket = fetchUnifiedWatchlistForSocket;
module.exports.buildKiteDashboardPayload = buildKiteDashboardPayload;
