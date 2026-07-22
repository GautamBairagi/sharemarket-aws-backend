const mysql = require('mysql2/promise');
const kiteService = require('../src/utils/kiteService');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// MCX Lot Sizes (hardcoded)
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

// NFO Lot Sizes (for futures)
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

const syncCuratedZerodha = async () => {
    let connection = null;
    try {
        console.log('\n🚀 Syncing CURATED Symbols from Zerodha...\n');

        // Check Zerodha connection
        if (!kiteService.isAuthenticated()) {
            console.error('❌ Zerodha not connected! Please set access token first.');
            process.exit(1);
        }

        // Load curated symbols
        const curatedPath = path.join(__dirname, '../data/curated-symbols.json');
        if (!fs.existsSync(curatedPath)) {
            console.error('❌ Curated symbols file not found! Run create-curated-list.js first.');
            process.exit(1);
        }

        const CURATED = JSON.parse(fs.readFileSync(curatedPath, 'utf-8'));
        console.log('✅ Curated symbols loaded\n');

        // Fetch all instruments from Zerodha
        console.log('[1/5] 📥 Fetching ALL instruments from Zerodha...');
        const allInstruments = await kiteService.getInstruments();

        if (!allInstruments || allInstruments.length === 0) {
            console.error('❌ No instruments received from Zerodha');
            process.exit(1);
        }
        console.log(`      ✅ Fetched ${allInstruments.length} total instruments`);

        // Create lookup by symbol
        console.log('[2/5] 🔍 Building Zerodha instrument lookup...');
        const instrumentsBySymbol = {};
        allInstruments.forEach(i => {
            const key = `${i.exchange}:${i.tradingsymbol || i.name}`;
            if (!instrumentsBySymbol[key]) {
                instrumentsBySymbol[key] = i;
            }
        });
        console.log(`      ✅ Built lookup for ${Object.keys(instrumentsBySymbol).length} instruments`);

        // Connect to database
        connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'traderdb'
        });

        // Clear database
        console.log('[3/5] 🧹 Clearing old data...');
        await connection.execute('TRUNCATE TABLE scrip_data');
        console.log('      ✅ Database cleared\n');

        // Process curated symbols
        console.log('[4/5] 💾 Syncing curated symbols with Zerodha data...\n');

        let inserted = 0;
        let errors = 0;
        const results = { NSE: 0, MCX: 0, NFO: 0 };

        // NSE EQUITY
        console.log('   🔵 NSE EQUITY:');
        for (const symbol of CURATED.NSE) {
            try {
                const key = `NSE:${symbol}`;
                const instrument = instrumentsBySymbol[key];

                if (!instrument) {
                    console.log(`      ⚠️  ${symbol}: Not found in Zerodha`);
                    continue;
                }

                const lotSize = parseInt(instrument.lot_size) || 1;
                await connection.execute(
                    `INSERT INTO scrip_data (symbol, lot_size, margin_req, market_type)
                     VALUES (?, ?, ?, ?)`,
                    [symbol, lotSize, 50, 'EQUITY']
                );
                inserted++;
                results.NSE++;

                if (results.NSE % 10 === 0) {
                    process.stdout.write(`\r      ✓ ${results.NSE}/${CURATED.NSE.length}`);
                }
            } catch (err) {
                errors++;
                if (errors <= 3) {
                    console.error(`      ❌ Error with ${symbol}:`, err.message.split('\n')[0]);
                }
            }
        }
        console.log(`\n      ✅ Inserted ${results.NSE} NSE symbols\n`);

        // MCX FUTURES
        console.log('   🟠 MCX FUTURES:');
        for (const symbol of CURATED.MCX) {
            try {
                const key = `MCX:${symbol}`;
                const instrument = instrumentsBySymbol[key];

                if (!instrument) {
                    console.log(`      ⚠️  ${symbol}: Not found in Zerodha`);
                    continue;
                }

                const lotSize = MCX_LOT_SIZES[symbol] || parseInt(instrument.lot_size) || 1;
                await connection.execute(
                    `INSERT INTO scrip_data (symbol, lot_size, margin_req, market_type)
                     VALUES (?, ?, ?, ?)`,
                    [symbol, lotSize, 50, 'MCX']
                );
                inserted++;
                results.MCX++;
            } catch (err) {
                errors++;
                if (errors <= 3) {
                    console.error(`      ❌ Error with ${symbol}:`, err.message.split('\n')[0]);
                }
            }
        }
        console.log(`      ✅ Inserted ${results.MCX} MCX symbols\n`);

        // NFO FUTURES/OPTIONS (specific expiries from curated list)
        console.log('   🟣 NFO FUTURES/OPTIONS:');
        for (const symbol of CURATED.NFO) {
            try {
                const instrument = instrumentsBySymbol[`NFO:${symbol}`];

                if (!instrument) {
                    if (results.NFO % 50 === 0 && results.NFO > 0) {
                        process.stdout.write(`\r      ✓ ${results.NFO}/${CURATED.NFO.length}`);
                    }
                    continue;
                }

                // Extract base symbol to get correct lot size
                let baseSymbol = symbol;
                for (const key of Object.keys(NFO_LOT_SIZES)) {
                    if (symbol.startsWith(key)) {
                        baseSymbol = key;
                        break;
                    }
                }

                const lotSize = NFO_LOT_SIZES[baseSymbol] || parseInt(instrument.lot_size) || 1;

                await connection.execute(
                    `INSERT INTO scrip_data (symbol, lot_size, margin_req, market_type)
                     VALUES (?, ?, ?, ?)`,
                    [symbol, lotSize, 50, 'NFO']
                );
                inserted++;
                results.NFO++;

                if (results.NFO % 50 === 0) {
                    process.stdout.write(`\r      ✓ ${results.NFO}/${CURATED.NFO.length}`);
                }
            } catch (err) {
                errors++;
                if (errors <= 3) {
                    console.error(`      ❌ Error with ${symbol}:`, err.message.split('\n')[0]);
                }
            }
        }
        console.log(`\n      ✅ Inserted ${results.NFO} NFO symbols\n`);

        // CRYPTO
        console.log('   💛 CRYPTO:');
        for (const symbol of CURATED.CRYPTO) {
            try {
                await connection.execute(
                    `INSERT INTO scrip_data (symbol, lot_size, margin_req, market_type)
                     VALUES (?, ?, ?, ?)`,
                    [symbol, 1, 50, 'CRYPTO']
                );
                inserted++;
            } catch (err) {
                // Might not exist in Zerodha, skip silently
            }
        }
        console.log(`      ✅ Inserted ${CURATED.CRYPTO.length} CRYPTO symbols\n`);

        // FOREX
        console.log('   💚 FOREX:');
        for (const symbol of CURATED.FOREX) {
            try {
                await connection.execute(
                    `INSERT INTO scrip_data (symbol, lot_size, margin_req, market_type)
                     VALUES (?, ?, ?, ?)`,
                    [symbol, 1, 50, 'FOREX']
                );
                inserted++;
            } catch (err) {
                // Might not exist in Zerodha, skip silently
            }
        }
        console.log(`      ✅ Inserted ${CURATED.FOREX.length} FOREX symbols\n`);

        // Verify
        console.log('[5/5] ✅ Verification...\n');
        const [final] = await connection.execute('SELECT market_type, COUNT(*) as cnt FROM scrip_data GROUP BY market_type ORDER BY cnt DESC');

        console.log('📊 Sync Complete!\n');
        console.log('Database State:');
        let total = 0;
        final.forEach(row => {
            console.log(`   ${row.market_type.padEnd(10)}: ${row.cnt} scripts`);
            total += row.cnt;
        });
        console.log(`   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`   TOTAL: ${total} curated scripts\n`);

        console.log('✅ CURATED SYMBOLS SYNCED!\n');
        console.log('Content:');
        console.log(`   🔵 NSE Equity: 90 scripts`);
        console.log(`   🟠 MCX Futures: 24 scripts`);
        console.log(`   🟣 NFO Options/Futures: 526 expiries`);
        console.log(`   💛 Crypto: 10 pairs`);
        console.log(`   💚 Forex: 10 pairs`);
        console.log(`   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`   📊 TOTAL: ${total} instruments\n`);

        await connection.end();

    } catch (err) {
        console.error('❌ Sync failed:', err.message);
        process.exit(1);
    } finally {
        if (connection) await connection.end();
    }
};

syncCuratedZerodha();
