const db = require('../config/db');
const kiteService = require('../utils/kiteService');
const fs = require('fs');
const path = require('path');

// Cache for Kite instruments (so we don't fetch every time)
let kiteScripCache = null;
let kiteScripCacheTime = 0;
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

// Load curated symbol list
let CURATED_SYMBOLS = null;
function loadCuratedSymbols() {
    try {
        const filePath = path.join(__dirname, '../data/curated-symbols.json');
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf-8');
            CURATED_SYMBOLS = JSON.parse(content);
            console.log('✅ Curated symbols loaded successfully');
            return true;
        } else {
            console.warn('⚠️ Curated symbols file not found. Using all Zerodha symbols.');
            return false;
        }
    } catch (err) {
        console.error('Error loading curated symbols:', err.message);
        return false;
    }
}

loadCuratedSymbols();

const getAllScrips = async (req, res) => {
    try {
        console.log('[getAllScrips] Fetching scrips from Zerodha (Pure Zerodha, curated list only)');

        // 1. Check Zerodha connection
        if (!kiteService.isAuthenticated()) {
            console.warn('[getAllScrips] ⚠️ Zerodha not connected - returning cached data');
            if (kiteScripCache && kiteScripCache.length > 0) {
                console.log(`[getAllScrips] ✅ Using cached data (${kiteScripCache.length} scrips)`);
                return res.json(kiteScripCache);
            } else {
                return res.status(400).json({
                    error: 'Zerodha not connected and no cache available. Please authenticate Zerodha.'
                });
            }
        }

        // 2. Check cache (6 hour TTL)
        const now = Date.now();
        if (kiteScripCache && (now - kiteScripCacheTime) < CACHE_TTL) {
            console.log(`[getAllScrips] ✅ Using cached data (${kiteScripCache.length} scrips, cache age: ${Math.round((now - kiteScripCacheTime) / 60000)}min)`);
            return res.json(kiteScripCache);
        }

        // 3. Fetch fresh from Zerodha
        console.log('[getAllScrips] 🔄 Fetching fresh data from Zerodha API...');
        const instruments = await kiteService.getInstruments();

        if (!instruments || instruments.length === 0) {
            return res.status(400).json({
                error: 'No instruments received from Zerodha'
            });
        }

        // 4. Filter & process - ONLY CURATED SYMBOLS
        const seen = new Set();
        const scrips = instruments
            .filter(i => {
                // Only NSE Equity, MCX Futures, NFO Futures
                if (!(i.exchange === 'NSE' && i.instrument_type === 'EQ') &&
                    !(i.exchange === 'MCX' && i.instrument_type === 'FUT') &&
                    !(i.exchange === 'NFO' && i.instrument_type === 'FUT')) {
                    return false;
                }

                // Check if symbol is in curated list
                if (CURATED_SYMBOLS) {
                    const isEQ = i.instrument_type === 'EQ';
                    const symbol = isEQ ? i.tradingsymbol : (i.name || i.tradingsymbol);
                    const baseSymbol = symbol.replace(/\d+[A-Z]{3}\d*FUT$/i, '').trim();

                    if (i.exchange === 'NSE' && CURATED_SYMBOLS.NSE && CURATED_SYMBOLS.NSE.includes(symbol)) {
                        return true;
                    }
                    if (i.exchange === 'MCX' && CURATED_SYMBOLS.MCX && CURATED_SYMBOLS.MCX.includes(baseSymbol)) {
                        return true;
                    }
                    if (i.exchange === 'NFO' && CURATED_SYMBOLS.NFO && CURATED_SYMBOLS.NFO.includes(baseSymbol)) {
                        return true;
                    }
                    return false;
                }
                return true;
            })
            .map(i => {
                const isEQ = i.instrument_type === 'EQ';
                const symbol = isEQ ? i.tradingsymbol : (i.name || i.tradingsymbol);

                return {
                    symbol: symbol,
                    name: i.name || i.tradingsymbol,
                    exchange: i.exchange,
                    instrument_type: i.instrument_type,
                    lot_size: parseInt(i.lot_size) || 1,
                    market_type: i.exchange === 'MCX' ? 'MCX' : i.exchange === 'NFO' ? 'NFO' : 'EQUITY',
                };
            })
            .filter(i => {
                // Deduplicate by exchange:symbol
                const key = `${i.exchange}:${i.symbol}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

        // 5. Cache the result
        kiteScripCache = scrips;
        kiteScripCacheTime = now;

        console.log(`[getAllScrips] ✅ Fetched ${scrips.length} curated scrips from Zerodha and cached`);
        res.json(scrips);

    } catch (err) {
        console.error('[getAllScrips] Error:', err.message);

        // Fallback to cache if error occurs
        if (kiteScripCache && kiteScripCache.length > 0) {
            console.log(`[getAllScrips] ⚠️ Zerodha error, falling back to cache (${kiteScripCache.length} scrips)`);
            return res.json(kiteScripCache);
        }

        res.status(500).json({
            error: 'Failed to fetch scrips from Zerodha',
            details: err.message
        });
    }
};

const MCX_LOT_SIZES = {
    'GOLD': 100, 'GOLDM': 10, 'GOLDPETAL': 1, 'GOLDGUINEA': 8,
    'SILVER': 30, 'SILVERM': 5, 'SILVERMIC': 1,
    'CRUDEOIL': 100, 'CRUDEOILM': 10,
    'NATURALGAS': 1250, 'NATGASMINI': 250,
    'COPPER': 2500, 'COPPERM': 500,
    'ZINC': 5000, 'ZINCMINI': 1000,
    'LEAD': 5000, 'LEADMINI': 1000,
    'NICKEL': 1500, 'NICKELMINI': 100,
    'ALUMINIUM': 5000, 'ALUMINI': 1000,
    'MENTHAOIL': 360, 'COTTON': 25, 'COTTONCNDY': 20, 'BULLDE X': 1
};

const NFO_LOT_SIZES = {
    'NIFTY': 50, 'BANKNIFTY': 50, 'FINNIFTY': 50, 'MIDCPNIFTY': 50, 'SENSEX': 10
};

// ✅ CURATED SYNC - Only sync needed scripts to database
const syncKiteInstruments = async (req, res) => {
    try {
        const instrumentSyncService = require('../services/InstrumentSyncService');
        const result = await instrumentSyncService.sync();

        if (result.success) {
            res.json({
                success: true,
                message: `✅ Sync complete: ${result.count} scripts saved to database`,
                note: '🧹 Old scripts deleted. Database now contains only necessary scripts from Market Groups.',
                count: result.count
            });
        } else {
            res.status(400).json({ error: result.error });
        }
    } catch (err) {
        console.error('[syncKiteInstruments] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
};

// ℹ️ OPTIONAL: Manual override (admin only, not needed with pure Zerodha)
const updateScrip = async (req, res) => {
    const { symbol, lot_size, margin_req, status } = req.body;
    try {
        console.log(`[updateScrip] ℹ️ Updating scrip backup (${symbol}): lot_size=${lot_size}, margin=${margin_req}, status=${status}`);

        await db.execute(
            'UPDATE scrip_data SET lot_size = ?, margin_req = ?, status = ? WHERE symbol = ?',
            [lot_size, margin_req, status, symbol]
        );

        res.json({
            message: 'Scrip backup updated in database',
            note: 'App still uses Zerodha API. This is for admin reference only.'
        });
    } catch (err) {
        console.error('[updateScrip] Error:', err);
        res.status(500).json({ error: err.message });
    }
};

const getTickers = async (req, res) => {
    try {
        const userId = req.user.id;

        // If ?all=true (admin panel), return only user's created tickers
        if (req.query.all === 'true') {
            // All users see only tickers they created
            const query = 'SELECT * FROM tickers WHERE created_by = ? ORDER BY id DESC';
            const params = [userId];

            const [rows] = await db.execute(query, params);
            return res.json(rows);
        }

        // For public view, only active tickers within schedule
        const [rows] = await db.execute(
            `SELECT * FROM tickers
             WHERE is_active = 1
               AND (start_time IS NULL OR start_time <= NOW())
               AND (end_time IS NULL OR end_time >= NOW())
             ORDER BY id DESC`
        );
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const createTicker = async (req, res) => {
    const { text, start_time, end_time } = req.body;
    const userId = req.user.id;
    try {
        await db.execute(
            'INSERT INTO tickers (text, start_time, end_time, is_active, created_by) VALUES (?, ?, ?, ?, ?)',
            [text, start_time, end_time, 1, userId]
        );
        res.json({ message: 'Ticker created successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const updateTicker = async (req, res) => {
    const { text, speed, is_active, start_time, end_time } = req.body;
    try {
        await db.execute(
            'UPDATE tickers SET text = ?, speed = ?, is_active = ?, start_time = ?, end_time = ? WHERE id = ?',
            [text, speed || 10, is_active ?? 1, start_time, end_time, req.params.id]
        );
        res.json({ message: 'Ticker updated' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const deleteTicker = async (req, res) => {
    try {
        await db.execute('DELETE FROM tickers WHERE id = ?', [req.params.id]);
        res.json({ message: 'Ticker deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

module.exports = { getAllScrips, syncKiteInstruments, updateScrip, getTickers, createTicker, updateTicker, deleteTicker };
