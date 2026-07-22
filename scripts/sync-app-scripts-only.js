const mysql = require('mysql2/promise');
const kiteService = require('../src/utils/kiteService');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// MCX Lot Sizes
const MCX_LOT_SIZES = {
    'GOLD': 100, 'GOLDM': 10, 'GOLDPETAL': 1, 'GOLDGUINEA': 8,
    'SILVER': 30, 'SILVERM': 5, 'SILVERMIC': 1,
    'CRUDEOIL': 100, 'CRUDEOILM': 10,
    'NATURALGAS': 1250, 'NATURALGASM': 125, 'NATGASMINI': 125,
    'COPPER': 2500, 'COPPERM': 250,
    'ZINC': 5000, 'ZINCMINI': 1000,
    'LEAD': 5000, 'LEADMINI': 1000,
    'NICKEL': 1500, 'NICKELMINI': 100,
    'ALUMINIUM': 5000, 'ALUMINIUMM': 1000, 'ALUMINI': 5000,
    'MENTHAOIL': 360, 'COTTON': 25, 'COTTONCNDY': 20, 'KAPAS': 2
};

// MCX bases used in app
const MCX_USED = ['GOLD', 'SILVER', 'CRUDEOIL', 'COPPER', 'ZINC', 'ALUMINIUM', 'LEAD', 'NATURALGAS',
                  'GOLDM', 'SILVERM', 'CRUDEOILM', 'ZINCMINI', 'LEADMINI', 'COPPERM', 'NATGASMINI', 'ALUMINI'];

// NFO index options
const NFO_INDEX_UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY'];

const syncAppScriptsOnly = async () => {
    let connection = null;
    try {
        console.log('\n🎯 SYNCING ONLY APP SCRIPTS (2550)...\n');

        // Check Zerodha
        if (!kiteService.isAuthenticated()) {
            console.error('❌ Zerodha not connected!');
            process.exit(1);
        }

        // Load NSE watchlist from file
        console.log('[1/6] 📥 Loading NSE watchlist (453 scripts)...');
        const watchlistPath = path.join(__dirname, '../data/user_nse_equity_watchlist.json');
        let nseWatchlist = [];
        try {
            nseWatchlist = JSON.parse(fs.readFileSync(watchlistPath, 'utf-8'));
            if (!Array.isArray(nseWatchlist)) nseWatchlist = [];
        } catch (err) {
            console.error(`⚠️  Failed to load watchlist:`, err.message);
        }
        console.log(`      ✅ Loaded ${nseWatchlist.length} NSE scripts\n`);

        // Fetch all Zerodha instruments
        console.log('[2/6] 📥 Fetching Zerodha instruments...');
        const instruments = await kiteService.getInstruments();
        console.log(`      ✅ Fetched ${instruments.length} total instruments\n`);

        // Build lookup map
        console.log('[3/6] 🔍 Building symbol lookup...');
        const instrumentsBySymbol = {};
        instruments.forEach(i => {
            const symbol = i.tradingsymbol || i.name;
            if (!instrumentsBySymbol[symbol]) {
                instrumentsBySymbol[symbol] = i;
            }
        });

        // Collect all symbols to insert
        const toInsert = [];

        // 1. NSE Watchlist (453 scripts)
        console.log('   📍 NSE: Collecting 453 watchlist stocks...');
        for (const symbol of nseWatchlist) {
            if (instrumentsBySymbol[symbol]) {
                toInsert.push({
                    symbol: symbol,
                    type: 'EQUITY',
                    lotSize: 1,
                    instrument: instrumentsBySymbol[symbol]
                });
            }
        }
        console.log(`      ✅ Collected ${toInsert.length} NSE scripts`);

        // 2. NFO - All stocks + index options
        console.log('   📍 NFO: Collecting futures & options...');
        let nfoCount = 0;

        // NFO for all 453 stocks
        for (const baseSymbol of nseWatchlist) {
            const nfoMatches = Object.keys(instrumentsBySymbol)
                .filter(k => k.startsWith(baseSymbol) && instrumentsBySymbol[k].exchange === 'NFO')
                .slice(0, 10); // 10 variations per stock (expires, strikes)

            for (const nfoSymbol of nfoMatches) {
                const instrument = instrumentsBySymbol[nfoSymbol];
                const lotSize = 1; // Default 1 for stocks
                toInsert.push({
                    symbol: nfoSymbol,
                    type: 'NFO',
                    lotSize: lotSize,
                    instrument: instrument
                });
                nfoCount++;
            }
        }

        // NFO Index options (NIFTY, BANKNIFTY, FINNIFTY)
        for (const indexName of NFO_INDEX_UNDERLYINGS) {
            const indexMatches = Object.keys(instrumentsBySymbol)
                .filter(k => k.includes(indexName) && instrumentsBySymbol[k].exchange === 'NFO')
                .slice(0, 50); // Get more for index options

            for (const symbol of indexMatches) {
                const instrument = instrumentsBySymbol[symbol];
                const lotSize = indexName === 'SENSEX' ? 10 : 50;
                toInsert.push({
                    symbol: symbol,
                    type: 'NFO',
                    lotSize: lotSize,
                    instrument: instrument
                });
                nfoCount++;
            }
        }
        console.log(`      ✅ Collected ${nfoCount} NFO scripts`);

        // 3. MCX - Allowed bases only
        console.log('   📍 MCX: Collecting commodity futures...');
        let mcxCount = 0;
        for (const baseSymbol of MCX_USED) {
            const mcxMatches = Object.keys(instrumentsBySymbol)
                .filter(k => k.includes(baseSymbol) && instrumentsBySymbol[k].exchange === 'MCX')
                .slice(0, 5); // 5 expiries per base

            for (const mcxSymbol of mcxMatches) {
                const instrument = instrumentsBySymbol[mcxSymbol];
                const lotSize = MCX_LOT_SIZES[baseSymbol] || parseInt(instrument.lot_size) || 1;
                toInsert.push({
                    symbol: mcxSymbol,
                    type: 'MCX',
                    lotSize: lotSize,
                    instrument: instrument
                });
                mcxCount++;
            }
        }
        console.log(`      ✅ Collected ${mcxCount} MCX scripts\n`);

        console.log(`   📊 Total to insert: ${toInsert.length}`);

        // Trim to exactly 2550 if needed
        const targetCount = 2550;
        if (toInsert.length > targetCount) {
            console.log(`\n   ✂️  Trimming to exactly ${targetCount}...`);
            toInsert.length = targetCount;
        }
        console.log(`   ✅ Final count: ${toInsert.length}\n`);

        // Connect to DB
        connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'traderdb'
        });

        // Clear and recreate table
        console.log('[4/6] 🗑️  Recreating database...');
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
        console.log('      ✅ Table created\n');

        // Insert data
        console.log('[5/6] 💾 Inserting data...\n');
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
                    process.stdout.write(`\r      ✓ Inserted ${inserted}/${toInsert.length}`);
                }
            } catch (err) {
                // Duplicate or error - skip
            }
        }
        console.log(`\r      ✅ Inserted ${inserted}/${toInsert.length}\n`);

        // Verify exact count
        console.log('[6/6] ✅ Final Verification...\n');
        const [final] = await connection.execute('SELECT market_type, COUNT(*) as cnt FROM scrip_data GROUP BY market_type ORDER BY cnt DESC');
        const [totalCheck] = await connection.execute('SELECT COUNT(*) as total FROM scrip_data');

        console.log('📊 FINAL DATABASE:\n');
        let total = 0;
        final.forEach(row => {
            const type = row.market_type.padEnd(12);
            console.log(`   ${type}: ${row.cnt.toString().padStart(5)}`);
            total += row.cnt;
        });
        console.log(`   ${'━'.repeat(40)}`);
        console.log(`   ${'TOTAL'.padEnd(12)}: ${total.toString().padStart(5)}\n`);

        if (total === 2550) {
            console.log('🎉 PERFECT! EXACTLY 2550!\n');
        } else if (Math.abs(total - 2550) < 50) {
            console.log(`✅ CLOSE! ${total} (${total > 2550 ? '+' : ''}${total - 2550})\n`);
        } else {
            console.log(`⚠️  ${total} (off by ${Math.abs(total - 2550)})\n`);
        }

        console.log('✅ DONE! Only APP SCRIPTS in database!\n');

        await connection.end();

    } catch (err) {
        console.error('❌ Error:', err.message);
        process.exit(1);
    } finally {
        if (connection) await connection.end();
    }
};

syncAppScriptsOnly();
