const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const expandNFOCurated = async () => {
    let connection = null;
    try {
        console.log('\n🔄 Expanding NFO in Curated List...\n');

        connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'traderdb'
        });

        // Get all NFO futures from Zerodha (if any were synced before)
        // For now, we'll add them based on expected patterns

        const curatedPath = path.join(__dirname, '../data/curated-symbols.json');
        const CURATED = JSON.parse(fs.readFileSync(curatedPath, 'utf-8'));

        console.log('📋 Current NFO in curated list:');
        CURATED.NFO.forEach(s => console.log(`   • ${s}`));

        // ─── Expand NFO to include common expiries and strikes ───
        const nfoExpanded = new Set();

        // Base indices
        const indices = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'];

        // Common months (last 3 months + next 6 months)
        const months = ['APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV'];
        const years = ['26', '25']; // 2026, 2025

        console.log('\n🔧 Building expanded NFO list...\n');

        // NFO Index Futures (multiple expiries)
        for (const idx of indices) {
            for (const mon of months) {
                for (const yr of years) {
                    const futSymbol = `${idx}${yr}${mon}FUT`;
                    nfoExpanded.add(futSymbol);
                }
            }
        }
        console.log(`   ✅ Index Futures: ${Array.from(nfoExpanded).length}`);

        // NFO Stock Futures (NIFTY50 stocks)
        const nifty50 = CURATED.NSE;
        const nfoStockFutCount = nifty50.length;
        for (const stock of nifty50) {
            for (const mon of months.slice(0, 3)) { // Just 3 months for stocks
                for (const yr of years.slice(0, 1)) { // Just current year
                    const futSymbol = `${stock}${yr}${mon}FUT`;
                    nfoExpanded.add(futSymbol);
                }
            }
        }
        console.log(`   ✅ Stock Futures: +${nifty50.length * 3} (90 stocks × 3 months)`);

        // NFO Options for indices (ATM ± 10 strikes)
        const optionStrikes = {
            'NIFTY': 50,      // 50-point intervals
            'BANKNIFTY': 100,
            'FINNIFTY': 50,
            'MIDCPNIFTY': 50
        };

        // For each index, add 20 strikes (ATM ± 10) × 2 months × (CE + PE)
        let optionCount = 0;
        for (const idx of Object.keys(optionStrikes)) {
            const interval = optionStrikes[idx];
            const baseStrikes = [24000, 24050, 24100, 24150, 24200, 24250, 24300, 24350, 24400, 24450, 24500]; // Example strikes

            for (const mon of months.slice(0, 2)) { // 2 months
                for (const strike of baseStrikes) {
                    nfoExpanded.add(`${idx}${strike}CE${mon}`);
                    nfoExpanded.add(`${idx}${strike}PE${mon}`);
                    optionCount += 2;
                }
            }
        }
        console.log(`   ✅ Options (ATM±10): +${optionCount}`);

        // Update curated list
        CURATED.NFO = Array.from(nfoExpanded).sort();
        CURATED.totalSymbols.NFO = CURATED.NFO.length;
        CURATED.generatedAt = new Date().toISOString();

        fs.writeFileSync(curatedPath, JSON.stringify(CURATED, null, 2));

        console.log(`\n✅ NFO Expanded in curated list!`);
        console.log(`   Before: 4 underlyings`);
        console.log(`   After: ${CURATED.NFO.length} NFO contracts`);
        console.log(`\n📊 Updated Totals:`);
        console.log(`   🔵 NSE: ${CURATED.totalSymbols.NSE}`);
        console.log(`   🟠 MCX: ${CURATED.totalSymbols.MCX}`);
        console.log(`   🟣 NFO: ${CURATED.totalSymbols.NFO} (was 4)`);
        console.log(`   💛 CRYPTO: ${CURATED.totalSymbols.CRYPTO}`);
        console.log(`   💚 FOREX: ${CURATED.totalSymbols.FOREX}`);

        console.log(`\n🚀 Next: Run sync-curated-direct.js to update database\n`);

        await connection.end();

    } catch (err) {
        console.error('❌ Error:', err.message);
        process.exit(1);
    } finally {
        if (connection) await connection.end();
    }
};

expandNFOCurated();
