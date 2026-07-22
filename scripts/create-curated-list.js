const mysql = require('mysql2/promise');
require('dotenv').config();

// ═══════════════════════════════════════════════════════════════════════════════
// CURATED SYMBOL LIST - Only ~100-150 scripts needed for live quotes
// ═══════════════════════════════════════════════════════════════════════════════

// 🔵 NIFTY50 Stocks (50 scripts)
const NIFTY50_SYMBOLS = [
    'RELIANCE', 'TCS', 'HDFCBANK', 'ICICIBANK', 'INFY',
    'HDFC', 'SBIN', 'MARUTI', 'BAJAJ-AUTO', 'LT',
    'ITC', 'SUNPHARMA', 'ASIANPAINT', 'AXISBANK', 'WIPRO',
    'KOTAKBANK', 'DMARUTI', 'ULTRACEMCO', 'BAJAJFINSV', 'M&M',
    'TATASTEEL', 'BHARATIARTL', 'ADANIPORTS', 'HINDALCO', 'POWERGRID',
    'GRASIM', 'JSWSTEEL', 'HCLTECH', 'BPCL', 'DRREDDY',
    'NESTLEIND', 'DIVISLAB', 'LICI', 'INDIGO', 'SBILIFE',
    'TECHM', 'TITAN', 'ONGC', 'UMANGINDUS', 'BRITANNIA',
    'NTPC', 'HEROMOTOCO', 'CHOLAFIN', 'SHREECEM', 'EICHERMOT',
    'MARICO', 'SIEMENS', 'APOLLOHOSP', 'ADANIENT', 'ICICIPRULI'
];

// 🟠 MCX Futures - Specific Instruments (28 scripts)
const MCX_SYMBOLS = [
    // GOLD
    'GOLD', 'GOLDM', 'GOLDGUINEA', 'GOLDPETAL',
    // SILVER
    'SILVER', 'SILVERM', 'SILVERMIC',
    // CRUDE OIL
    'CRUDEOIL', 'CRUDEOILM',
    // NATURAL GAS
    'NATURALGAS', 'NATURALGASM',
    // BASE METALS
    'COPPER', 'COPPERM',
    'ZINC', 'ZINCMINI',
    'NICKEL', 'NICKELMINI',
    'LEAD', 'LEADMINI',
    'ALUMINIUM', 'ALUMINIUMM',
    // AGRICULTURAL
    'MENTHAOIL', 'COTTON', 'COTTONCNDY', 'KAPAS'
];

// 🟣 NFO - Index Futures (base symbols only)
const NFO_UNDERLYINGS = [
    'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'
];

// 💛 CRYPTO (10 symbols)
const CRYPTO_SYMBOLS = [
    'BTC/USDT', 'ETH/USDT', 'BNB/USDT', 'XRP/USDT', 'DOGE/USDT',
    'SOL/USDT', 'ADA/USDT', 'MATIC/USDT', 'LTC/USDT', 'AVAX/USDT'
];

// 💚 FOREX (10 symbols)
const FOREX_SYMBOLS = [
    'EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/INR', 'EUR/INR',
    'GBP/INR', 'XAU/USD', 'XAG/USD', 'CRUDE/USD', 'NATURAL GAS/USD'
];

const buildCuratedList = async () => {
    let connection = null;
    try {
        console.log('\n🔍 Building Curated Symbol List...\n');

        connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'traderdb'
        });

        // ─── STEP 1: Get active trade symbols from NSE ───
        const [activeTrades] = await connection.execute(`
            SELECT DISTINCT symbol
            FROM trades
            WHERE symbol LIKE 'NSE:%'
            AND status IN ('OPEN', 'CLOSED')
            AND symbol IS NOT NULL
            LIMIT 20
        `);

        const activeNseSymbols = new Set();
        activeTrades.forEach(row => {
            const sym = row.symbol.replace('NSE:', '').trim();
            if (sym) activeNseSymbols.add(sym);
        });

        console.log(`✅ Found ${activeNseSymbols.size} active NSE symbols from trades:`);
        Array.from(activeNseSymbols).slice(0, 10).forEach(s => console.log(`   • ${s}`));
        if (activeNseSymbols.size > 10) console.log(`   ... and ${activeNseSymbols.size - 10} more`);

        // ─── STEP 2: Combine all curated lists ───
        const allSymbols = {
            NSE: new Set([...NIFTY50_SYMBOLS, ...activeNseSymbols]),
            MCX: new Set(MCX_SYMBOLS),
            NFO: new Set(NFO_UNDERLYINGS),
            CRYPTO: new Set(CRYPTO_SYMBOLS),
            FOREX: new Set(FOREX_SYMBOLS)
        };

        console.log('\n📊 Curated Symbol Counts:');
        console.log(`   🔵 NSE EQUITY: ${allSymbols.NSE.size} scripts`);
        console.log(`   🟠 MCX FUT: ${allSymbols.MCX.size} scripts`);
        console.log(`   🟣 NFO: ${allSymbols.NFO.size} underlyings`);
        console.log(`   💛 CRYPTO: ${allSymbols.CRYPTO.size} pairs`);
        console.log(`   💚 FOREX: ${allSymbols.FOREX.size} pairs`);
        console.log(`   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`   📈 TOTAL (approx): ${allSymbols.NSE.size + allSymbols.MCX.size + (allSymbols.NFO.size * 20) + allSymbols.CRYPTO.size + allSymbols.FOREX.size} scripts (with NFO expiries)`);

        // ─── STEP 3: Save to JSON ───
        const curatedList = {
            NSE: Array.from(allSymbols.NSE).sort(),
            MCX: Array.from(allSymbols.MCX).sort(),
            NFO: Array.from(allSymbols.NFO).sort(),
            CRYPTO: Array.from(allSymbols.CRYPTO).sort(),
            FOREX: Array.from(allSymbols.FOREX).sort(),
            generatedAt: new Date().toISOString(),
            totalSymbols: {
                NSE: allSymbols.NSE.size,
                MCX: allSymbols.MCX.size,
                NFO: allSymbols.NFO.size,
                CRYPTO: allSymbols.CRYPTO.size,
                FOREX: allSymbols.FOREX.size
            }
        };

        const fs = require('fs');
        fs.writeFileSync(
            require('path').join(__dirname, '../data/curated-symbols.json'),
            JSON.stringify(curatedList, null, 2)
        );

        console.log('\n✅ Curated list saved to: data/curated-symbols.json\n');

        // ─── STEP 4: Show sample ───
        console.log('📋 Sample Curated List:');
        console.log('\nNSE EQUITY (first 10):');
        curatedList.NSE.slice(0, 10).forEach(s => console.log(`  • ${s}`));

        console.log('\nMCX FUT (all):');
        curatedList.MCX.forEach(s => console.log(`  • ${s}`));

        console.log('\nNFO (all):');
        curatedList.NFO.forEach(s => console.log(`  • ${s}`));

        await connection.end();

    } catch (err) {
        console.error('❌ Error:', err.message);
        process.exit(1);
    } finally {
        if (connection) await connection.end();
    }
};

buildCuratedList();
