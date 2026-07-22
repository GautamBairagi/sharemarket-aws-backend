const mysql = require('mysql2/promise');
require('dotenv').config();

(async () => {
    try {
        const connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'traderdb'
        });

        console.log('\n📊 CHECKING YOUR ACTUAL DATA IN DATABASE...\n');

        // Total count
        const [totalCount] = await connection.execute('SELECT COUNT(*) as total FROM scrip_data');
        console.log(`📈 TOTAL SCRIPTS: ${totalCount[0].total}\n`);

        // Breakdown by type
        const [breakdown] = await connection.execute(`
            SELECT market_type, COUNT(*) as cnt FROM scrip_data
            GROUP BY market_type ORDER BY cnt DESC
        `);

        console.log('📊 BREAKDOWN:');
        breakdown.forEach(row => {
            console.log(`   ${row.market_type.padEnd(12)}: ${row.cnt} scripts`);
        });
        console.log('');

        // NSE Scripts
        const [nseCount] = await connection.execute(`
            SELECT COUNT(*) as total FROM scrip_data WHERE market_type = 'EQUITY'
        `);
        console.log(`\n🔵 NSE EQUITY: ${nseCount[0].total} scripts`);
        console.log('   First 20:');
        const [nseScripts] = await connection.execute(`
            SELECT symbol FROM scrip_data WHERE market_type = 'EQUITY'
            ORDER BY symbol LIMIT 20
        `);
        nseScripts.forEach(s => console.log(`      • ${s.symbol}`));

        // MCX Futures
        const [mcxCount] = await connection.execute(`
            SELECT COUNT(*) as total FROM scrip_data WHERE market_type = 'MCX'
        `);
        console.log(`\n🟠 MCX FUTURES: ${mcxCount[0].total} scripts`);
        console.log('   All MCX:');
        const [mcxScripts] = await connection.execute(`
            SELECT DISTINCT SUBSTRING_INDEX(symbol, '26', 1) as base,
                   COUNT(*) as cnt
            FROM scrip_data WHERE market_type = 'MCX'
            GROUP BY base ORDER BY base
        `);
        mcxScripts.forEach(s => console.log(`      • ${s.base}: ${s.cnt} contracts`));

        // NFO Scripts
        const [nfoCount] = await connection.execute(`
            SELECT COUNT(*) as total FROM scrip_data WHERE market_type = 'NFO'
        `);
        console.log(`\n🟣 NFO OPTIONS/FUTURES: ${nfoCount[0].total} scripts`);

        // NFO Breakdown by base symbol
        const [nfoBreakdown] = await connection.execute(`
            SELECT SUBSTRING_INDEX(symbol, '26', 1) as base,
                   COUNT(*) as cnt
            FROM scrip_data WHERE market_type = 'NFO'
            GROUP BY base ORDER BY cnt DESC LIMIT 20
        `);
        console.log('   Top 20 NFO bases (script + expiry count):');
        nfoBreakdown.forEach(s => {
            console.log(`      • ${s.base.padEnd(20)}: ${s.cnt} variations`);
        });

        // Export to file for reference
        const fs = require('fs');

        // Get all NSE scripts
        const [allNse] = await connection.execute(`
            SELECT symbol FROM scrip_data WHERE market_type = 'EQUITY'
            ORDER BY symbol
        `);

        // Get all MCX scripts
        const [allMcx] = await connection.execute(`
            SELECT symbol FROM scrip_data WHERE market_type = 'MCX'
            ORDER BY symbol
        `);

        // Get all NFO scripts
        const [allNfo] = await connection.execute(`
            SELECT symbol FROM scrip_data WHERE market_type = 'NFO'
            ORDER BY symbol
        `);

        const exportData = {
            total: totalCount[0].total,
            breakdown: {
                EQUITY: allNse.length,
                MCX: allMcx.length,
                NFO: allNfo.length
            },
            NSE: allNse.map(s => s.symbol),
            MCX: allMcx.map(s => s.symbol),
            NFO: allNfo.map(s => s.symbol)
        };

        fs.writeFileSync(
            require('path').join(__dirname, '../data/exported-scripts.json'),
            JSON.stringify(exportData, null, 2)
        );

        console.log(`\n✅ Complete list exported to: data/exported-scripts.json\n`);

        await connection.end();

    } catch (err) {
        console.error('❌ Error:', err.message);
    }
})();
