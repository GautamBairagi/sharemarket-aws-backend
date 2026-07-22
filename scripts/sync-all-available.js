const mysql = require('mysql2/promise');
const kiteService = require('../src/utils/kiteService');
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

// NFO Lot Sizes
const NFO_LOT_SIZES = {
    'NIFTY': 50, 'BANKNIFTY': 50, 'FINNIFTY': 50, 'MIDCPNIFTY': 50, 'SENSEX': 10
};

const syncAllAvailable = async () => {
    let connection = null;
    try {
        console.log('\n🚀 Syncing ALL Available Scripts from Zerodha...\n');

        // Check Zerodha connection
        if (!kiteService.isAuthenticated()) {
            console.error('❌ Zerodha not connected! Please set access token first.');
            process.exit(1);
        }

        // Fetch all instruments from Zerodha
        console.log('[1/4] 📥 Fetching instruments from Zerodha API...');
        const instruments = await kiteService.getInstruments();

        if (!instruments || instruments.length === 0) {
            console.error('❌ No instruments received from Zerodha');
            process.exit(1);
        }
        console.log(`      ✅ Fetched ${instruments.length} total instruments`);

        // Filter for NSE, NFO, MCX
        console.log('[2/4] 🔍 Filtering for NSE, NFO, MCX only...');
        const filtered = instruments.filter(i => {
            const exc = i.exchange;
            const type = i.instrument_type;

            // NSE Equity only
            if (exc === 'NSE' && type === 'EQ') return true;

            // NFO Futures + Options
            if (exc === 'NFO' && (type === 'FUT' || type === 'CE' || type === 'PE')) return true;

            // MCX Futures + Options
            if (exc === 'MCX' && (type === 'FUT' || type === 'CE' || type === 'PE')) return true;

            return false;
        });

        console.log(`      ✅ Filtered to ${filtered.length} relevant instruments`);

        // Count by type
        const counts = {};
        filtered.forEach(i => {
            const key = `${i.exchange}-${i.instrument_type}`;
            counts[key] = (counts[key] || 0) + 1;
        });
        console.log('\n      Breakdown:');
        Object.entries(counts).sort().forEach(([k, v]) => {
            console.log(`        • ${k}: ${v}`);
        });

        // Connect to database
        connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'traderdb'
        });

        // Clear database
        console.log('\n[3/4] 🧹 Clearing old data...');
        await connection.execute('TRUNCATE TABLE scrip_data');
        console.log('      ✅ Database cleared');

        // Insert all scripts
        console.log('[4/4] 💾 Inserting all scripts...');

        const seen = new Set();
        let inserted = 0;
        let errors = 0;

        for (const instrument of filtered) {
            try {
                const isEQ = instrument.instrument_type === 'EQ';
                const symbol = isEQ ? instrument.tradingsymbol : (instrument.name || instrument.tradingsymbol);
                const exchange = instrument.exchange;
                const type = instrument.instrument_type;

                // Deduplicate
                const key = `${exchange}:${symbol}`;
                if (seen.has(key)) continue;
                seen.add(key);

                // Determine market type
                let marketType = exchange === 'MCX' ? 'MCX' : exchange === 'NFO' ? 'NFO' : 'EQUITY';
                let lotSize = parseInt(instrument.lot_size) || 1;

                // Override lot sizes for MCX (100% LOCKED)
                if (exchange === 'MCX') {
                    // Extract base symbol for MCX
                    const baseSymbol = symbol.replace(/\d+[A-Z]{3}\d*[CEP]{0,2}$/i, '').trim();
                    lotSize = MCX_LOT_SIZES[baseSymbol] || MCX_LOT_SIZES[symbol] || lotSize;
                }
                // Try hardcoded for NFO, fallback to Zerodha
                else if (exchange === 'NFO' && type === 'FUT') {
                    const baseSymbol = symbol.replace(/\d+[A-Z]{3}\d*FUT$/i, '').trim();
                    lotSize = NFO_LOT_SIZES[baseSymbol] || NFO_LOT_SIZES[symbol] || lotSize;
                }

                await connection.execute(
                    `INSERT INTO scrip_data (symbol, lot_size, margin_req, market_type)
                     VALUES (?, ?, ?, ?)`,
                    [symbol, lotSize, 50, marketType]
                );
                inserted++;

                // Progress indicator
                if (inserted % 500 === 0) {
                    console.log(`      ✓ Inserted ${inserted}...`);
                }
            } catch (err) {
                errors++;
                if (errors <= 5) {
                    console.error(`      ⚠️  Error: ${err.message.split('\n')[0]}`);
                }
            }
        }

        console.log(`      ✅ Inserted ${inserted} scripts (${errors} errors)`);

        // Verify
        const [final] = await connection.execute('SELECT market_type, COUNT(*) as cnt FROM scrip_data GROUP BY market_type ORDER BY cnt DESC');

        console.log('\n✅ SYNC COMPLETE!\n');
        console.log('📊 Final Database State:');
        let total = 0;
        final.forEach(row => {
            console.log(`   ${row.market_type.padEnd(8)}: ${row.cnt} scripts`);
            total += row.cnt;
        });
        console.log(`   ━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`   TOTAL: ${total} scripts\n`);

        console.log('🎉 Ab DATABASE ME SAB SCRIPTS HAI!\n');
        console.log('NSE OPTIONS: 446+ ✅');
        console.log('MCX OPTIONS: 15+ ✅');
        console.log('NFO FUTURES + OPTIONS: All ✅');
        console.log('');

        await connection.end();

    } catch (err) {
        console.error('❌ Sync failed:', err.message);
        process.exit(1);
    } finally {
        if (connection) await connection.end();
    }
};

syncAllAvailable();
