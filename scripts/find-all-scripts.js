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

        console.log('\n🔎 Searching for your 2550 scripts...\n');

        // Check market_groups
        const [mgroups] = await connection.execute('SELECT * FROM market_groups');
        console.log('📊 MARKET GROUPS:');
        mgroups.forEach(mg => {
            console.log(`   ID: ${mg.id}, Name: ${mg.name}, Items: ${mg.item_count || '?'}`);
        });

        // Check market_group_items count
        const [itemCounts] = await connection.execute('SELECT COUNT(*) as total FROM market_group_items');
        console.log(`\n📋 MARKET_GROUP_ITEMS: ${itemCounts[0].total} total items`);

        // Check tickers count
        const [tickerCounts] = await connection.execute('SELECT COUNT(*) as total FROM tickers');
        console.log(`📋 TICKERS: ${tickerCounts[0].total} total`);

        // Check scrip_data (जो हम sync कर रहे हैं)
        const [scripCounts] = await connection.execute('SELECT COUNT(*) as total FROM scrip_data');
        console.log(`📋 SCRIP_DATA: ${scripCounts[0].total} total\n`);

        // Show scrip_data breakdown
        const [scripBreakdown] = await connection.execute('SELECT market_type, COUNT(*) as cnt FROM scrip_data GROUP BY market_type');
        console.log('SCRIP_DATA Breakdown:');
        scripBreakdown.forEach(row => {
            console.log(`   ${row.market_type}: ${row.cnt}`);
        });

        await connection.end();

    } catch (err) {
        console.error('❌ Error:', err.message);
    }
})();
