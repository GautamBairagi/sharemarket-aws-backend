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

        console.log('\n🔍 MCX SCRIPTS IN DATABASE\n');

        // Get total MCX count
        const [mcxTotal] = await connection.execute(
            "SELECT COUNT(*) as total FROM scrip_data WHERE market_type = 'MCX'"
        );
        console.log(`📊 Total MCX scripts: ${mcxTotal[0].total}\n`);

        // Get MCX scripts by base symbol
        const [mcxByBase] = await connection.execute(`
            SELECT SUBSTRING_INDEX(symbol, '26', 1) as base_symbol,
                   COUNT(*) as count
            FROM scrip_data
            WHERE market_type = 'MCX'
            GROUP BY base_symbol
            ORDER BY base_symbol
        `);

        console.log('📋 MCX by Base Symbol:\n');
        mcxByBase.forEach(row => {
            console.log(`   ${row.base_symbol.padEnd(15)}: ${row.count.toString().padStart(3)} contracts`);
        });

        // Get first 50 MCX scripts
        const [mcxScripts] = await connection.execute(`
            SELECT symbol, lot_size FROM scrip_data
            WHERE market_type = 'MCX'
            ORDER BY symbol
            LIMIT 50
        `);

        console.log(`\n📜 First 50 MCX Scripts:\n`);
        mcxScripts.forEach(row => {
            console.log(`   ${row.symbol.padEnd(20)} | Lot Size: ${row.lot_size}`);
        });

        console.log(`\n... and ${Math.max(0, mcxTotal[0].total - 50)} more\n`);

        await connection.end();

    } catch (err) {
        console.error('❌ Error:', err.message);
    }
})();
