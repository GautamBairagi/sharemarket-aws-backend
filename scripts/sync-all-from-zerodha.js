const mysql = require('mysql2/promise');
const kiteService = require('../src/utils/kiteService');
require('dotenv').config();

// MCX Lot Sizes (hardcoded - 100% LOCKED)
const MCX_LOT_SIZES = {
    'ALUMINI': 5000, 'ALUMINIUM': 5000, 'ALUMINIUMM': 1000,
    'COPPER': 2500, 'COPPERM': 250,
    'COTTON': 25, 'COTTONCNDY': 20,
    'CRUDEOIL': 100, 'CRUDEOILM': 10,
    'GOLD': 100, 'GOLDGUINEA': 8, 'GOLDM': 10, 'GOLDPETAL': 1,
    'LEAD': 5000, 'LEADMINI': 1000,
    'MENTHAOIL': 360,
    'NATGASMINI': 125, 'NATURALGAS': 1250,
    'NICKEL': 1500, 'NICKELMINI': 100,
    'SILVER': 30, 'SILVERM': 5, 'SILVERMICRO': 1,
    'ZINC': 5000, 'ZINCMINI': 1000
};

// NFO Lot Sizes
const NFO_LOT_SIZES = {
    'ABBOTINDIA': 1, 'ADANIPORTS': 1, 'ALKEM': 1, 'APOLLOHOSP': 1,
    'ASIANPAINT': 1, 'AUBANK': 1, 'AUROPHARMA': 1, 'AXISBANK': 1,
    'BAJAJ-AUTO': 1, 'BAJAJFINSV': 1, 'BAJFINANCE': 1, 'BANDHANBNK': 1,
    'BANKBARODA': 1, 'BANKNIFTY': 50, 'BEL': 1, 'BHARTIARTL': 1,
    'BPCL': 1, 'BRITANNIA': 1, 'CANBK': 1, 'CHOLAFIN': 1,
    'CIPLA': 1, 'COALINDIA': 1, 'COFORGE': 1, 'COLPAL': 1,
    'CONCOR': 1, 'CUMMINSIND': 1, 'DELHIVERY': 1, 'DIVISLAB': 1,
    'DIXON': 1, 'DRREDDY': 1, 'EICHERMOT': 1, 'FEDERALBNK': 1,
    'FINNIFTY': 50, 'GODREJPROP': 1, 'GRASIM': 1, 'HCLTECH': 1,
    'HDFCBANK': 1, 'HDFCLIFE': 1, 'HEROMOTOCO': 1, 'HINDALCO': 1,
    'HINDUNILVR': 1, 'ICICIBANK': 1, 'ICICIPRULI': 1, 'IDFCFIRSTB': 1,
    'INDHOTEL': 1, 'INDUSINDBK': 1, 'INFY': 1, 'IRCTC': 1,
    'ITC': 1, 'JSPL': 1, 'JSWSTEEL': 1, 'JUBLFOOD': 1,
    'KOTAKBANK': 1, 'LICHSGFIN': 1, 'LINDEINDIA': 1, 'LT': 1,
    'LTIM': 1, 'LUPIN': 1, 'M&M': 1, 'M&MFIN': 1,
    'MANAPPURAM': 1, 'MARUTI': 1, 'MAXHEALTH': 1, 'MFSL': 1,
    'MIDCPNIFTY': 50, 'MUTHOOTFIN': 1, 'NESTLEIND': 1, 'NIFTY': 50,
    'NTPC': 1, 'OBEROIRLTY': 1, 'ONGC': 1, 'PERSISTENT': 1,
    'PFC': 1, 'PIIND': 1, 'PNB': 1, 'POLYCAB': 1,
    'POWERGRID': 1, 'RECLTD': 1, 'RELIANCE': 1, 'SBICARD': 1,
    'SBILIFE': 1, 'SBIN': 1, 'SENSEX': 10, 'SHRIRAMFIN': 1,
    'SUNPHARMA': 1, 'TATACONSUM': 1, 'TATAMOTORS': 1, 'TATASTEEL': 1,
    'TCS': 1, 'TECHM': 1, 'TITAN': 1, 'TRENT': 1,
    'ULTRACEMCO': 1, 'VOLTAS': 1, 'WIPRO': 1
};

const syncAllFromZerodha = async () => {
    let connection = null;
    try {
        console.log('\n🚀 Syncing ALL Scripts from Zerodha...\n');

        // Check Zerodha connection
        if (!kiteService.isAuthenticated()) {
            console.error('❌ Zerodha not connected!');
            process.exit(1);
        }

        // Fetch all instruments
        console.log('[1/4] 📥 Fetching ALL instruments from Zerodha...');
        const instruments = await kiteService.getInstruments();

        if (!instruments || instruments.length === 0) {
            console.error('❌ No instruments received from Zerodha');
            process.exit(1);
        }
        console.log(`      ✅ Fetched ${instruments.length} total instruments\n`);

        // Group by exchange
        const byExchange = {};
        instruments.forEach(i => {
            const exc = i.exchange;
            if (!byExchange[exc]) byExchange[exc] = [];
            byExchange[exc].push(i);
        });

        console.log('📊 Breakdown by Exchange:');
        Object.entries(byExchange).forEach(([exc, arr]) => {
            console.log(`   ${exc}: ${arr.length}`);
        });
        console.log('');

        // Connect to database
        connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'traderdb'
        });

        // Clear database & add unique constraint
        console.log('[2/4] 🧹 Clearing old data...');
        await connection.execute('TRUNCATE TABLE scrip_data');
        console.log('      ✅ Database cleared');

        // Add unique constraint if not exists (to prevent duplicate inserts)
        try {
            await connection.execute(`
                ALTER TABLE scrip_data
                ADD UNIQUE KEY unique_symbol (symbol)
            `);
            console.log('      ✅ Unique constraint added\n');
        } catch (err) {
            // Constraint already exists, that's fine
            console.log('      ℹ️  Unique constraint already exists\n');
        }

        // Insert all scripts
        console.log('[3/4] 💾 Inserting ALL scripts...\n');

        let processed = 0;
        let inserted = 0;
        let skipped = 0;
        let errors = 0;
        const results = { NSE: 0, NFO: 0, MCX: 0, CRYPTO: 0, OTHER: 0 };

        for (const instrument of instruments) {
            try {
                const exchange = instrument.exchange;
                const symbol = instrument.tradingsymbol || instrument.name;
                const type = instrument.instrument_type;

                // Skip if no symbol
                if (!symbol) {
                    skipped++;
                    continue;
                }

                processed++;

                // Determine market type and lot size
                let marketType = 'OTHER';
                let lotSize = parseInt(instrument.lot_size) || 1;

                if (exchange === 'NSE') {
                    marketType = 'EQUITY';
                } else if (exchange === 'NFO') {
                    marketType = 'NFO';
                    // Extract base symbol for lot size
                    const baseMatch = symbol.match(/^([A-Z&]+)/);
                    if (baseMatch) {
                        const baseSymbol = baseMatch[1];
                        lotSize = NFO_LOT_SIZES[baseSymbol] || lotSize;
                    }
                } else if (exchange === 'MCX') {
                    marketType = 'MCX';
                    // Extract base symbol for lot size
                    const baseMatch = symbol.match(/^([A-Z]+)/);
                    if (baseMatch) {
                        const baseSymbol = baseMatch[1];
                        lotSize = MCX_LOT_SIZES[baseSymbol] || MCX_LOT_SIZES[symbol] || lotSize;
                    }
                } else if (exchange === 'CDS' || exchange === 'NCDEX') {
                    marketType = 'COMMODITY';
                }

                await connection.execute(
                    `INSERT IGNORE INTO scrip_data (symbol, lot_size, margin_req, market_type)
                     VALUES (?, ?, ?, ?)`,
                    [symbol, lotSize, 50, marketType]
                );

                inserted++;
                results[marketType]++;

                // Progress indicator
                if (processed % 1000 === 0) {
                    console.log(`      ✓ Processed ${processed}... (Inserted: ${inserted})`);
                }
            } catch (err) {
                // Duplicate insert or other error - counted as skipped
                skipped++;
                errors++;
                if (errors <= 5) {
                    console.error(`      ⚠️  Error:`, err.message.split('\n')[0]);
                }
            }
        }

        console.log(`\n      ✅ Processed: ${processed}`);
        console.log(`      ✅ Inserted: ${inserted}`);
        console.log(`      ⚠️  Skipped/Duplicates: ${skipped}`);
        console.log(`      ❌ Errors: ${errors}\n`);

        // Verify
        console.log('[4/4] ✅ Verification...\n');
        const [final] = await connection.execute('SELECT market_type, COUNT(*) as cnt FROM scrip_data GROUP BY market_type ORDER BY cnt DESC');

        console.log('📊 FINAL DATABASE STATE:\n');
        let total = 0;
        final.forEach(row => {
            const type = row.market_type.padEnd(12);
            console.log(`   ${type}: ${row.cnt.toString().padStart(5)} scripts`);
            total += row.cnt;
        });
        console.log(`   ${'━'.repeat(35)}`);
        console.log(`   ${'TOTAL'.padEnd(12)}: ${total.toString().padStart(5)} scripts\n`);

        console.log('🎉 ALL SCRIPTS SYNCED FROM ZERODHA!\n');

        await connection.end();

    } catch (err) {
        console.error('❌ Sync failed:', err.message);
        process.exit(1);
    } finally {
        if (connection) await connection.end();
    }
};

syncAllFromZerodha();
