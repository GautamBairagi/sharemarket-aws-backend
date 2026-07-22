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

const syncExact2550 = async () => {
    let connection = null;
    try {
        console.log('\n🎯 SYNCING EXACTLY 2550 SCRIPTS...\n');

        // Check Zerodha
        if (!kiteService.isAuthenticated()) {
            console.error('❌ Zerodha not connected!');
            process.exit(1);
        }

        // Connect to DB
        connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'traderdb'
        });

        // Get your 159 symbols from market_group_items
        console.log('[1/6] 📥 Getting your 159 base symbols...');
        const [yourSymbols] = await connection.execute(`
            SELECT DISTINCT symbol FROM market_group_items
            ORDER BY symbol
        `);
        console.log(`      ✅ Found ${yourSymbols.length} base symbols\n`);

        // Fetch all Zerodha instruments
        console.log('[2/6] 📥 Fetching Zerodha instruments...');
        const instruments = await kiteService.getInstruments();
        console.log(`      ✅ Fetched ${instruments.length} instruments\n`);

        // Collect ALL relevant symbols for your 159 base symbols
        console.log('[3/6] 🔍 Collecting all relevant symbols...');
        const allRelevantSymbols = [];
        const seen = new Set();
        const basesToProcess = new Set(yourSymbols.map(s => s.symbol));

        for (const baseSymbol of basesToProcess) {
            // Get NSE equity
            const nseMatches = instruments.filter(i =>
                i.tradingsymbol === baseSymbol && i.exchange === 'NSE' && i.instrument_type === 'EQ'
            );
            for (const match of nseMatches) {
                const sym = match.tradingsymbol || match.name;
                if (!seen.has(sym)) {
                    seen.add(sym);
                    allRelevantSymbols.push({
                        symbol: sym,
                        type: 'EQUITY',
                        lotSize: parseInt(match.lot_size) || 1,
                        instrument: match
                    });
                }
            }

            // Get NFO variations
            const nfoMatches = instruments.filter(i =>
                i.tradingsymbol?.startsWith(baseSymbol) && i.exchange === 'NFO'
            );
            for (const match of nfoMatches) {
                const sym = match.tradingsymbol || match.name;
                if (!seen.has(sym)) {
                    seen.add(sym);
                    const lotSize = NFO_LOT_SIZES[baseSymbol] || parseInt(match.lot_size) || 1;
                    allRelevantSymbols.push({
                        symbol: sym,
                        type: 'NFO',
                        lotSize: lotSize,
                        instrument: match
                    });
                }
            }

            // Get MCX variations
            const mcxMatches = instruments.filter(i =>
                i.tradingsymbol?.includes(baseSymbol) && i.exchange === 'MCX'
            );
            for (const match of mcxMatches) {
                const sym = match.tradingsymbol || match.name;
                if (!seen.has(sym)) {
                    seen.add(sym);
                    const lotSize = MCX_LOT_SIZES[baseSymbol] || parseInt(match.lot_size) || 1;
                    allRelevantSymbols.push({
                        symbol: sym,
                        type: 'MCX',
                        lotSize: lotSize,
                        instrument: match
                    });
                }
            }
        }

        console.log(`      ✅ Collected ${allRelevantSymbols.length} total symbols`);
        console.log(`      📊 Breakdown before trim:`);
        const beforeBreakdown = {};
        allRelevantSymbols.forEach(s => {
            beforeBreakdown[s.type] = (beforeBreakdown[s.type] || 0) + 1;
        });
        Object.entries(beforeBreakdown).forEach(([type, count]) => {
            console.log(`         ${type}: ${count}`);
        });

        // TRIM TO EXACTLY 2550
        console.log(`\n[4/6] ✂️  Trimming to exactly 2550 symbols...`);
        const targetCount = 2550;
        const toInsert = allRelevantSymbols.slice(0, targetCount);

        console.log(`      ✅ Will insert ${toInsert.length} symbols\n`);

        const afterBreakdown = {};
        toInsert.forEach(s => {
            afterBreakdown[s.type] = (afterBreakdown[s.type] || 0) + 1;
        });

        // Clear and recreate table
        console.log('[5/6] 🗑️  Recreating database...');
        await connection.execute('DROP TABLE IF EXISTS scrip_data');
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
        console.log('      ✅ Table ready\n');

        // Insert exactly 2550
        console.log('[6/6] 💾 Inserting exactly 2550 symbols...\n');

        let inserted = 0;
        for (const item of toInsert) {
            try {
                await connection.execute(
                    `INSERT INTO scrip_data (symbol, lot_size, margin_req, market_type)
                     VALUES (?, ?, ?, ?)`,
                    [item.symbol, item.lotSize, 50, item.type]
                );
                inserted++;

                if (inserted % 500 === 0) {
                    process.stdout.write(`\r      ✓ Inserted ${inserted}/2550`);
                }
            } catch (err) {
                console.error(`\n      ❌ Error with ${item.symbol}:`, err.message.split('\n')[0]);
            }
        }

        console.log(`\r      ✅ Inserted ${inserted}/2550\n`);

        // Verify - EXACT COUNT
        const [final] = await connection.execute('SELECT market_type, COUNT(*) as cnt FROM scrip_data GROUP BY market_type ORDER BY cnt DESC');
        const [totalCheck] = await connection.execute('SELECT COUNT(*) as total FROM scrip_data');

        console.log('📊 FINAL DATABASE STATE:\n');
        let total = 0;
        final.forEach(row => {
            const type = row.market_type.padEnd(12);
            console.log(`   ${type}: ${row.cnt.toString().padStart(5)} scripts`);
            total += row.cnt;
        });
        console.log(`   ${'━'.repeat(40)}`);
        console.log(`   ${'TOTAL'.padEnd(12)}: ${total.toString().padStart(5)} SCRIPTS\n`);

        if (total === 2550) {
            console.log('✅ PERFECT! EXACTLY 2550 SCRIPTS!\n');
        } else if (total > 2550) {
            console.log(`⚠️  ${total} scripts (${total - 2550} extra)\n`);
        } else {
            console.log(`⚠️  ${total} scripts (${2550 - total} short)\n`);
        }

        await connection.end();

    } catch (err) {
        console.error('❌ Error:', err.message);
        process.exit(1);
    } finally {
        if (connection) await connection.end();
    }
};

syncExact2550();
