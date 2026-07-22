const mysql = require('mysql2/promise');
const kiteService = require('../src/utils/kiteService');
require('dotenv').config();

// MCX Lot Sizes
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

const cleanAndSync = async () => {
    let connection = null;
    try {
        console.log('\n🔄 CLEAN & SYNC - Removing duplicates...\n');

        // Check Zerodha
        if (!kiteService.isAuthenticated()) {
            console.error('❌ Zerodha not connected!');
            process.exit(1);
        }

        // Fetch instruments
        console.log('[1/5] 📥 Fetching instruments from Zerodha...');
        const instruments = await kiteService.getInstruments();
        console.log(`      ✅ Fetched ${instruments.length} instruments\n`);

        // Deduplicate in memory (FIRST)
        console.log('[2/5] 🔍 Deduplicating symbols in memory...');
        const uniqueSymbols = new Map(); // symbol -> instrument

        instruments.forEach(i => {
            const symbol = i.tradingsymbol || i.name;
            if (!symbol) return;

            // Keep first occurrence of each symbol
            if (!uniqueSymbols.has(symbol)) {
                uniqueSymbols.set(symbol, i);
            }
        });

        console.log(`      ✅ Unique symbols: ${uniqueSymbols.size}\n`);

        // Connect to DB
        connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'traderdb'
        });

        // Drop and recreate table with UNIQUE constraint
        console.log('[3/5] 🗑️  Dropping old table...');
        try {
            await connection.execute('DROP TABLE IF EXISTS scrip_data');
            console.log('      ✅ Old table dropped');
        } catch (err) {
            console.log('      ℹ️  Table did not exist');
        }

        console.log('[4/4] 📝 Creating fresh table with UNIQUE constraint...');
        await connection.execute(`
            CREATE TABLE scrip_data (
                id INT AUTO_INCREMENT PRIMARY KEY,
                symbol VARCHAR(50) NOT NULL UNIQUE,
                lot_size INT DEFAULT 1,
                margin_req DECIMAL(10,2) DEFAULT 50,
                market_type VARCHAR(20) DEFAULT 'OTHER',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('      ✅ Table created\n');

        // Insert unique symbols
        console.log('[5/5] 💾 Inserting unique symbols only...\n');

        const results = { EQUITY: 0, NFO: 0, MCX: 0, CRYPTO: 0, OTHER: 0 };
        let inserted = 0;

        for (const [symbol, instrument] of uniqueSymbols.entries()) {
            try {
                const exchange = instrument.exchange;
                const type = instrument.instrument_type;

                // Determine market type
                let marketType = 'OTHER';
                let lotSize = parseInt(instrument.lot_size) || 1;

                if (exchange === 'NSE') {
                    marketType = 'EQUITY';
                } else if (exchange === 'NFO') {
                    marketType = 'NFO';
                    const baseMatch = symbol.match(/^([A-Z&]+)/);
                    if (baseMatch) {
                        const baseSymbol = baseMatch[1];
                        lotSize = NFO_LOT_SIZES[baseSymbol] || lotSize;
                    }
                } else if (exchange === 'MCX') {
                    marketType = 'MCX';
                    const baseMatch = symbol.match(/^([A-Z]+)/);
                    if (baseMatch) {
                        const baseSymbol = baseMatch[1];
                        lotSize = MCX_LOT_SIZES[baseSymbol] || MCX_LOT_SIZES[symbol] || lotSize;
                    }
                }

                await connection.execute(
                    `INSERT INTO scrip_data (symbol, lot_size, margin_req, market_type)
                     VALUES (?, ?, ?, ?)`,
                    [symbol, lotSize, 50, marketType]
                );

                inserted++;
                results[marketType]++;

                if (inserted % 500 === 0) {
                    process.stdout.write(`\r      ✓ Inserted ${inserted}/${uniqueSymbols.size}`);
                }
            } catch (err) {
                console.error(`\n      ❌ Error with ${symbol}:`, err.message.split('\n')[0]);
            }
        }

        console.log(`\n      ✅ Inserted ${inserted} UNIQUE symbols\n`);

        // Verify
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

        console.log('🎉 CLEAN SYNC COMPLETE!\n');
        console.log(`✅ Zero duplicates - ${total} unique scripts only\n`);

        await connection.end();

    } catch (err) {
        console.error('❌ Error:', err.message);
        process.exit(1);
    } finally {
        if (connection) await connection.end();
    }
};

cleanAndSync();
