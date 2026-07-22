const mysql = require('mysql2/promise');
const kiteService = require('../src/utils/kiteService');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

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

const NFO_INDEX_UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY'];

const NFO_LOT_SIZES = {
    'NIFTY': 50, 'BANKNIFTY': 50, 'FINNIFTY': 50, 'MIDCPNIFTY': 50, 'SENSEX': 10
};

const balancedSync2550 = async () => {
    let connection = null;
    try {
        console.log('\n🎯 BALANCED SYNC - 2550 SCRIPTS (With MCX)\n');

        if (!kiteService.isAuthenticated()) {
            console.error('❌ Zerodha not connected!');
            process.exit(1);
        }

        console.log('[1/6] 📥 Loading NSE watchlist...');
        const watchlistPath = path.join(__dirname, '../src/data/user_nse_equity_watchlist.json');
        let nseWatchlist = [];
        try {
            nseWatchlist = JSON.parse(fs.readFileSync(watchlistPath, 'utf-8'));
            if (!Array.isArray(nseWatchlist)) nseWatchlist = [];
        } catch (err) {
            console.error(`⚠️  Failed to load watchlist:`, err.message);
        }
        console.log(`      ✅ Loaded ${nseWatchlist.length} NSE scripts\n`);

        console.log('[2/6] 📥 Fetching Zerodha instruments...');
        const instruments = await kiteService.getInstruments();
        console.log(`      ✅ Fetched ${instruments.length} instruments\n`);

        console.log('[3/6] 🔍 Building lookup...');
        const instrumentsBySymbol = {};
        instruments.forEach(i => {
            const symbol = i.tradingsymbol || i.name;
            if (!instrumentsBySymbol[symbol]) {
                instrumentsBySymbol[symbol] = i;
            }
        });
        console.log(`      ✅ Lookup ready\n`);

        // Collect with balanced distribution
        const nseScripts = [];
        const nfoScripts = [];
        const mcxScripts = [];
        const seen = new Set();

        // 1. NSE Watchlist
        console.log('   📍 NSE: Collecting stocks...');
        for (const symbol of nseWatchlist) {
            if (instrumentsBySymbol[symbol]) {
                nseScripts.push({
                    symbol: symbol,
                    type: 'EQUITY',
                    lotSize: 1,
                    instrument: instrumentsBySymbol[symbol]
                });
                seen.add(`NSE:${symbol}`);
            }
        }
        console.log(`      ✅ ${nseScripts.length} NSE scripts`);

        // 2. NFO - Limit to ~1800 to leave room for MCX
        console.log('   📍 NFO: Collecting options/futures...');

        // NFO for stocks
        for (const baseSymbol of nseWatchlist) {
            const nfoMatches = Object.keys(instrumentsBySymbol)
                .filter(k => k.startsWith(baseSymbol) && instrumentsBySymbol[k].exchange === 'NFO')
                .slice(0, 25); // 25 per stock

            for (const nfoSymbol of nfoMatches) {
                const key = `NFO:${nfoSymbol}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    const instrument = instrumentsBySymbol[nfoSymbol];
                    const lotSize = NFO_LOT_SIZES[baseSymbol] || 1;
                    nfoScripts.push({
                        symbol: nfoSymbol,
                        type: 'NFO',
                        lotSize: lotSize,
                        instrument: instrument
                    });
                }
            }
        }

        // NFO Index options
        for (const indexName of NFO_INDEX_UNDERLYINGS) {
            const indexMatches = Object.keys(instrumentsBySymbol)
                .filter(k => k.includes(indexName) && instrumentsBySymbol[k].exchange === 'NFO')
                .slice(0, 80);

            for (const symbol of indexMatches) {
                const key = `NFO:${symbol}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    const instrument = instrumentsBySymbol[symbol];
                    const lotSize = NFO_LOT_SIZES[indexName] || 50;
                    nfoScripts.push({
                        symbol: symbol,
                        type: 'NFO',
                        lotSize: lotSize,
                        instrument: instrument
                    });
                }
            }
        }
        console.log(`      ✅ ${nfoScripts.length} NFO scripts`);

        // 3. MCX - Get more variations
        console.log('   📍 MCX: Collecting commodity futures...');
        const MCX_USED = Object.keys(MCX_LOT_SIZES);
        for (const baseSymbol of MCX_USED) {
            const mcxMatches = Object.keys(instrumentsBySymbol)
                .filter(k => k.includes(baseSymbol) && instrumentsBySymbol[k].exchange === 'MCX')
                .slice(0, 50); // 50 per base

            for (const mcxSymbol of mcxMatches) {
                const key = `MCX:${mcxSymbol}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    const instrument = instrumentsBySymbol[mcxSymbol];
                    const lotSize = MCX_LOT_SIZES[baseSymbol] || parseInt(instrument.lot_size) || 1;
                    mcxScripts.push({
                        symbol: mcxSymbol,
                        type: 'MCX',
                        lotSize: lotSize,
                        instrument: instrument
                    });
                }
            }
        }
        console.log(`      ✅ ${mcxScripts.length} MCX scripts\n`);

        // Balance distribution to 2550
        console.log(`   📊 Available: NSE=${nseScripts.length} | NFO=${nfoScripts.length} | MCX=${mcxScripts.length}`);

        // Strategy: Keep all NSE, distribute NFO+MCX to fill 2550
        const remaining = 2550 - nseScripts.length;
        const nfoTarget = Math.floor(remaining * 0.85); // 85% NFO, 15% MCX
        const mcxTarget = remaining - nfoTarget;

        const toInsert = [
            ...nseScripts,
            ...nfoScripts.slice(0, nfoTarget),
            ...mcxScripts.slice(0, mcxTarget)
        ];

        console.log(`   ✂️  Trimming to 2550:`);
        console.log(`       NSE: ${nseScripts.length} (all)`);
        console.log(`       NFO: ${Math.min(nfoScripts.length, nfoTarget)}`);
        console.log(`       MCX: ${Math.min(mcxScripts.length, mcxTarget)}`);
        console.log(`   ✅ Final: ${toInsert.length}\n`);

        // Connect and sync
        connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'traderdb'
        });

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
                // Skip duplicates
            }
        }
        console.log(`\r      ✅ Inserted ${inserted}/${toInsert.length}\n`);

        // Verify
        console.log('[6/6] ✅ Verification...\n');
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
        } else {
            console.log(`✅ SYNCED ${total} SCRIPTS\n`);
        }

        await connection.end();

    } catch (err) {
        console.error('❌ Error:', err.message);
        process.exit(1);
    } finally {
        if (connection) await connection.end();
    }
};

balancedSync2550();
