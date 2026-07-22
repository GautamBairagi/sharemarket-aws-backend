const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const updateCuratedList = async () => {
    let connection = null;
    try {
        console.log('\n🔄 Updating Curated List from Market Groups...\n');

        connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'traderdb'
        });

        // ─── STEP 1: Get all market group items ───
        const [items] = await connection.execute(`
            SELECT mg.name as group_name, mgi.symbol
            FROM market_groups mg
            LEFT JOIN market_group_items mgi ON mg.id = mgi.group_id
            WHERE mg.is_active = 1
            ORDER BY mg.sort_order, mgi.symbol
        `);

        const groupData = {};
        items.forEach(item => {
            if (!groupData[item.group_name]) groupData[item.group_name] = [];
            if (item.symbol) groupData[item.group_name].push(item.symbol);
        });

        console.log('📊 Market Groups Found:');
        Object.entries(groupData).forEach(([name, syms]) => {
            console.log(`   • ${name}: ${syms.length} symbols`);
        });

        // ─── STEP 2: Build comprehensive curated list ───
        const allNseSymbols = new Set();

        // Add NIFTY 50
        if (groupData['NIFTY 50']) {
            groupData['NIFTY 50'].forEach(s => allNseSymbols.add(s));
        }

        // Add BANK NIFTY
        if (groupData['BANK NIFTY']) {
            groupData['BANK NIFTY'].forEach(s => allNseSymbols.add(s));
        }

        // Add MIDCAP SELECT
        if (groupData['MIDCAP SELECT']) {
            groupData['MIDCAP SELECT'].forEach(s => allNseSymbols.add(s));
        }

        // Add FIN NIFTY
        if (groupData['FIN NIFTY']) {
            groupData['FIN NIFTY'].forEach(s => allNseSymbols.add(s));
        }

        const curatedList = {
            NSE: Array.from(allNseSymbols).sort(),
            MCX: (groupData['MCX FUTURES'] || []).sort(),
            NFO: (groupData['NFO INDICES'] || []).sort(),
            CRYPTO: (groupData['CRYPTO'] || []).sort(),
            FOREX: (groupData['FOREX'] || []).sort(),
            generatedAt: new Date().toISOString(),
            source: 'Market Groups + Database',
            totalSymbols: {
                NSE: Array.from(allNseSymbols).length,
                MCX: (groupData['MCX FUTURES'] || []).length,
                NFO: (groupData['NFO INDICES'] || []).length,
                CRYPTO: (groupData['CRYPTO'] || []).length,
                FOREX: (groupData['FOREX'] || []).length
            }
        };

        // ─── STEP 3: Save updated list ───
        const dataDir = path.join(__dirname, '../data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        fs.writeFileSync(
            path.join(dataDir, 'curated-symbols.json'),
            JSON.stringify(curatedList, null, 2)
        );

        console.log('\n✅ Updated Curated List:\n');
        console.log(`   🔵 NSE EQUITY: ${curatedList.totalSymbols.NSE} scripts`);
        console.log(`   🟠 MCX FUT: ${curatedList.totalSymbols.MCX} scripts`);
        console.log(`   🟣 NFO: ${curatedList.totalSymbols.NFO} underlyings`);
        console.log(`   💛 CRYPTO: ${curatedList.totalSymbols.CRYPTO} pairs`);
        console.log(`   💚 FOREX: ${curatedList.totalSymbols.FOREX} pairs`);
        console.log(`   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`   📈 TOTAL (approx): ${
            curatedList.totalSymbols.NSE +
            curatedList.totalSymbols.MCX +
            (curatedList.totalSymbols.NFO * 20) +
            curatedList.totalSymbols.CRYPTO +
            curatedList.totalSymbols.FOREX
        } scripts (with NFO expiries)`);

        console.log('\n📝 Updated list saved to: data/curated-symbols.json\n');

        // ─── STEP 4: Show sample ───
        console.log('📋 Sample NSE Symbols (first 20):');
        curatedList.NSE.slice(0, 20).forEach(s => console.log(`   • ${s}`));

        await connection.end();

    } catch (err) {
        console.error('❌ Error:', err.message);
        process.exit(1);
    } finally {
        if (connection) await connection.end();
    }
};

updateCuratedList();
