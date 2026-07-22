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

        console.log('\n📊 YOUR MARKET GROUP ITEMS (159 total)\n');

        // Get all market group items with their group names
        const [items] = await connection.execute(`
            SELECT mg.name as market_group, mgi.symbol, mgi.name as item_name
            FROM market_group_items mgi
            JOIN market_groups mg ON mgi.market_group_id = mg.id
            ORDER BY mg.name, mgi.symbol
        `);

        const byGroup = {};
        items.forEach(item => {
            if (!byGroup[item.market_group]) {
                byGroup[item.market_group] = [];
            }
            byGroup[item.market_group].push(item.symbol);
        });

        // Display grouped
        Object.entries(byGroup).forEach(([group, symbols]) => {
            console.log(`\n🔵 ${group} (${symbols.length} items):`);
            symbols.slice(0, 10).forEach(sym => console.log(`   • ${sym}`));
            if (symbols.length > 10) {
                console.log(`   ... and ${symbols.length - 10} more`);
            }
        });

        console.log('\n✅ Total 159 base symbols');
        console.log('❓ With all NFO/MCX expiries, this becomes ~2500+\n');

        await connection.end();

    } catch (err) {
        console.error('❌ Error:', err.message);
    }
})();
