const db = require('../config/db');
const kiteService = require('../utils/kiteService');
const cron = require('node-cron');

class InstrumentSyncService {
    constructor() {
        this.isSyncing = false;
    }

    /**
     * Start the 6-hour sync job
     */
    startSyncJob() {
        // Run every 6 hours
        cron.schedule('0 */6 * * *', async () => {
            console.log('⏰ [InstrumentSyncService] Starting scheduled 6-hour sync...');
            try {
                const kiteService = require('../utils/kiteService');
                await kiteService.loadSessionFromDb();
            } catch (sessionErr) {
                console.error('⚠️ [InstrumentSyncService] Failed to load session from DB before sync:', sessionErr.message);
            }
            await this.sync();
        });
        console.log('✅ [InstrumentSyncService] 6-hour sync job scheduled');
    }

    /**
     * Perform the sync:
     * 1. Get base symbols from market_group_items
     * 2. Fetch all instruments from Zerodha
     * 3. Filter and expand (variations)
     * 4. Update scrip_data table
     */
    async sync() {
        if (this.isSyncing) {
            console.log('⚠️ [InstrumentSyncService] Sync already in progress, skipping...');
            return;
        }

        this.isSyncing = true;
        try {
            console.log('📡 [InstrumentSyncService] Starting instrument sync...');

            if (!kiteService.isAuthenticated()) {
                console.warn('⚠️ [InstrumentSyncService] Zerodha not connected, cannot sync instruments');
                return { success: false, error: 'Zerodha not connected' };
            }

            // 1. Get base symbols from market_group_items
            const [baseRows] = await db.execute('SELECT DISTINCT symbol FROM market_group_items');
            const baseSymbols = new Set(baseRows.map(r => r.symbol.toUpperCase()));
            
            if (baseSymbols.size === 0) {
                console.warn('⚠️ [InstrumentSyncService] No base symbols found in market_group_items');
                return { success: false, error: 'No base symbols' };
            }

            // 2. Fetch Zerodha instruments
            const instruments = await kiteService.getInstruments();
            if (!Array.isArray(instruments) || instruments.length === 0) {
                throw new Error('No instruments received from Zerodha');
            }

            // 3. Filter and Map
            const toSync = [];
            const seen = new Set();

            // Segment-specific lot sizes (fallbacks)
            const MCX_LOT_SIZES = {
                'CRUDEOIL': 100, 'CRUDEOILM': 10, 'NATURALGAS': 1250, 'NATGASMINI': 250,
                'GOLD': 100, 'GOLDM': 10, 'SILVER': 30, 'SILVERM': 5, 'COPPER': 2500,
                'ZINC': 5000, 'ALUMINIUM': 5000, 'LEAD': 5000
            };

            for (const i of instruments) {
                const symbol = i.tradingsymbol.toUpperCase();
                const exchange = i.exchange;

                // Sync all NSE, NFO, and MCX instruments so derivatives like NIFTY26MAYFUT are included with correct lot sizes
                if (exchange !== 'NSE' && exchange !== 'NFO' && exchange !== 'MCX') {
                    continue; // Skip BSE, BFO, CDS, etc. to avoid invalid market_type ENUM issues
                }

                let marketType = exchange; // 'NSE', 'NFO', or 'MCX'

                const key = `${exchange}:${symbol}`;
                if (seen.has(key)) continue;
                seen.add(key);

                let lotSize = parseInt(i.lot_size) || 1;
                // MCX Special Lot Size Handling
                if (exchange === 'MCX') {
                    const baseName = (i.name || symbol).toUpperCase();
                    lotSize = MCX_LOT_SIZES[baseName] || lotSize;
                }

                toSync.push({
                    symbol: symbol,
                    lot_size: lotSize,
                    market_type: marketType,
                    exchange: exchange,
                    expiry: i.expiry || null
                });
            }

            console.log(`🔍 [InstrumentSyncService] Found ${toSync.length} relevant instruments to sync`);

            // 4. Update Database
            // We use a transaction or bulk insert to be safe
            const connection = await db.getConnection();
            try {
                await connection.beginTransaction();

                // Clean old data to ensure fresh lot sizes
                await connection.execute('DELETE FROM scrip_data');

                // Insert in batches of 2000 for better performance
                const batchSize = 2000;
                for (let i = 0; i < toSync.length; i += batchSize) {
                    const batch = toSync.slice(i, i + batchSize);
                    const values = batch.map(item => [item.symbol, item.lot_size, 50, item.market_type, item.expiry]);
                    
                    await connection.query(
                        'INSERT INTO scrip_data (symbol, lot_size, margin_req, market_type, expiry_date) VALUES ?',
                        [values]
                    );
                }

                await connection.commit();
                console.log(`✅ [InstrumentSyncService] Sync complete! Total symbols in DB: ${toSync.length}`);
                return { success: true, count: toSync.length };
            } catch (err) {
                await connection.rollback();
                throw err;
            } finally {
                connection.release();
            }

        } catch (err) {
            console.error('❌ [InstrumentSyncService] Sync failed:', err.message);
            return { success: false, error: err.message };
        } finally {
            this.isSyncing = false;
        }
    }
}

module.exports = new InstrumentSyncService();
