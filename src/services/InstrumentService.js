const fs = require('fs');
const path = require('path');
const kiteAuthService = require('./KiteAuthService');

const INSTRUMENTS_CACHE = path.join(__dirname, '../../data/instruments.json');

/**
 * Optimized Instrument Service
 * Uses in-memory Map for O(1) lookups to prevent server lag.
 */
class InstrumentService {
    constructor() {
        this.instruments = null;
        this.symbolMap = new Map(); // token -> instrument
        this.tradingsymbolMap = new Map(); // symbol -> instrument (e.g. "NSE:SBIN")
        this.isLoaded = false;
        this.loadingPromise = null;
    }

    async _loadInstruments() {
        if (this.isLoaded) return;
        if (this.loadingPromise) return this.loadingPromise;

        this.loadingPromise = (async () => {
            try {
                if (!fs.existsSync(INSTRUMENTS_CACHE)) {
                    console.warn('⚠️ Instruments cache file not found. Symbols will not map correctly!');
                    return;
                }

                console.log('📂 Loading instruments into memory...');
                const data = fs.readFileSync(INSTRUMENTS_CACHE, 'utf8');
                this.instruments = JSON.parse(data);

                this.symbolMap.clear();
                this.tradingsymbolMap.clear();

                this.instruments.forEach(inst => {
                    // Map by token
                    this.symbolMap.set(String(inst.instrument_token), inst);
                    
                    // Map by full tradingsymbol (e.g. "NSE:SBIN")
                    if (inst.exchange && inst.tradingsymbol) {
                        const fullKey = `${inst.exchange}:${inst.tradingsymbol}`.toUpperCase();
                        this.tradingsymbolMap.set(fullKey, inst);
                        // Also map by tradingsymbol alone for convenience
                        this.tradingsymbolMap.set(inst.tradingsymbol.toUpperCase(), inst);
                    }
                });

                console.log(`✅ Loaded ${this.symbolMap.size} instruments into cache`);
                this.isLoaded = true;
            } catch (err) {
                console.error('❌ Failed to load instruments:', err.message);
            } finally {
                this.loadingPromise = null;
            }
        })();

        return this.loadingPromise;
    }

    async syncInstruments(userId) {
        try {
            const kite = await kiteAuthService.getKiteInstance(userId);
            console.log('📡 Fetching instruments from Zerodha...');
            const instruments = await kite.getInstruments();

            if (Array.isArray(instruments) && instruments.length > 0) {
                const dataDir = path.dirname(INSTRUMENTS_CACHE);
                if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
                fs.writeFileSync(INSTRUMENTS_CACHE, JSON.stringify(instruments));

                this.isLoaded = false; // Trigger reload
                await this._loadInstruments();
                
                return { success: true, count: instruments.length };
            }
            throw new Error('No instruments received');
        } catch (err) {
            console.error('Instrument sync failed:', err.message);
            throw err;
        }
    }

    async getInstrumentBySymbol(symbol) {
        await this._loadInstruments();
        const s = String(symbol).toUpperCase();
        return this.tradingsymbolMap.get(s) || null;
    }

    async getInstrumentsBySymbols(symbols = []) {
        await this._loadInstruments();
        const result = new Map();
        if (!Array.isArray(symbols) || symbols.length === 0) return result;
        symbols.forEach((symbol) => {
            const key = String(symbol || '').toUpperCase();
            if (!key) return;
            const instrument = this.tradingsymbolMap.get(key) || null;
            result.set(symbol, instrument);
        });
        return result;
    }

    async getInstrumentByToken(token) {
        await this._loadInstruments();
        return this.symbolMap.get(String(token)) || null;
    }

    async searchInstruments(query) {
        await this._loadInstruments();
        if (!this.instruments) return [];
        const q = query.toUpperCase();
        return this.instruments
            .filter(i => (i.tradingsymbol && i.tradingsymbol.includes(q)) || (i.name && i.name.includes(q)))
            .slice(0, 20);
    }
}

module.exports = new InstrumentService();
