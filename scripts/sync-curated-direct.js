const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// MCX Lot Sizes (hardcoded - 100% LOCKED)
const MCX_LOT_SIZES = {
    'GOLD': 100, 'GOLDM': 10, 'GOLDPETAL': 1, 'GOLDGUINEA': 8,
    'SILVER': 30, 'SILVERM': 5, 'SILVERMIC': 1,
    'CRUDEOIL': 100, 'CRUDEOILM': 10,
    'NATURALGAS': 1250, 'NATURALGASM': 125,
    'COPPER': 2500, 'COPPERM': 250,
    'ZINC': 5000, 'ZINCMINI': 1000,
    'LEAD': 5000, 'LEADMINI': 1000,
    'NICKEL': 1500, 'NICKELMINI': 100,
    'ALUMINIUM': 5000, 'ALUMINIUMM': 1000,
    'MENTHAOIL': 360, 'COTTON': 25, 'COTTONCNDY': 20, 'KAPAS': 2
};

// NFO Lot Sizes (hardcoded - try this first, fallback to Zerodha)
const NFO_LOT_SIZES = {
    'NIFTY': 50, 'BANKNIFTY': 50, 'FINNIFTY': 50, 'MIDCPNIFTY': 50, 'SENSEX': 10
};

const syncCuratedDirect = async () => {
    let connection = null;
    try {
        console.log('\n🧹 Direct Curated Sync to Database...\n');

        // Load curated symbols
        const curatedPath = path.join(__dirname, '../data/curated-symbols.json');
        if (!fs.existsSync(curatedPath)) {
            console.error('❌ Curated symbols file not found! Run update-curated-list.js first.');
            process.exit(1);
        }

        const CURATED = JSON.parse(fs.readFileSync(curatedPath, 'utf-8'));
        console.log('✅ Curated symbols loaded');

        connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'traderdb'
        });

        // ─── STEP 1: Clear old data ───
        console.log('[1/4] 🧹 Deleting old scrip_data...');
        await connection.execute('DELETE FROM scrip_data');
        console.log('     ✅ Database cleared');

        // ─── STEP 2: Insert NSE symbols ───
        console.log('[2/4] 📝 Inserting NSE EQUITY symbols...');
        let nseCount = 0;
        for (const symbol of CURATED.NSE) {
            try {
                await connection.execute(
                    `INSERT INTO scrip_data (symbol, lot_size, margin_req, market_type)
                     VALUES (?, ?, ?, ?)`,
                    [symbol, 1, 50, 'EQUITY']
                );
                nseCount++;
            } catch (err) {
                console.error(`     ⚠️  Error inserting ${symbol}:`, err.message.split('\n')[0]);
            }
        }
        console.log(`     ✅ Inserted ${nseCount} NSE symbols`);

        // ─── STEP 3: Insert MCX symbols ───
        console.log('[3/4] 📝 Inserting MCX FUT symbols...');
        let mcxCount = 0;
        for (const symbol of CURATED.MCX) {
            try {
                const lotSize = MCX_LOT_SIZES[symbol] || 1;
                await connection.execute(
                    `INSERT INTO scrip_data (symbol, lot_size, margin_req, market_type)
                     VALUES (?, ?, ?, ?)`,
                    [symbol, lotSize, 50, 'MCX']
                );
                mcxCount++;
            } catch (err) {
                console.error(`     ⚠️  Error inserting ${symbol}:`, err.message.split('\n')[0]);
            }
        }
        console.log(`     ✅ Inserted ${mcxCount} MCX symbols (with hardcoded lot sizes)`);

        // ─── STEP 4: Insert NFO symbols ───
        console.log('[4/4] 📝 Inserting NFO symbols...');
        let nfoCount = 0;
        for (const symbol of CURATED.NFO) {
            try {
                const lotSize = NFO_LOT_SIZES[symbol] || 1;
                await connection.execute(
                    `INSERT INTO scrip_data (symbol, lot_size, margin_req, market_type)
                     VALUES (?, ?, ?, ?)`,
                    [symbol, lotSize, 50, 'NFO']
                );
                nfoCount++;
            } catch (err) {
                console.error(`     ⚠️  Error inserting ${symbol}:`, err.message.split('\n')[0]);
            }
        }
        console.log(`     ✅ Inserted ${nfoCount} NFO symbols (with hardcoded lot sizes)`);

        // ─── Summary ───
        console.log('\n✅ SYNC COMPLETE!\n');
        console.log('📊 Summary:');
        console.log(`   🔵 NSE: ${nseCount} scripts`);
        console.log(`   🟠 MCX: ${mcxCount} scripts (with MCX lot sizes)`);
        console.log(`   🟣 NFO: ${nfoCount} scripts (with NFO lot sizes)`);
        console.log(`   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`   📈 TOTAL: ${nseCount + mcxCount + nfoCount} scripts\n`);

        console.log('🎉 Database cleaned! Now using only 200 curated scripts.\n');

        await connection.end();

    } catch (err) {
        console.error('❌ Sync failed:', err.message);
        process.exit(1);
    } finally {
        if (connection) await connection.end();
    }
};

syncCuratedDirect();
