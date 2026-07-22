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

        console.log('\n📋 MARKET_GROUPS Schema:');
        const [mgSchema] = await connection.execute('DESCRIBE market_groups');
        mgSchema.forEach(col => console.log(`   ${col.Field}: ${col.Type}`));

        console.log('\n📋 MARKET_GROUP_ITEMS Schema:');
        const [mgiSchema] = await connection.execute('DESCRIBE market_group_items');
        mgiSchema.forEach(col => console.log(`   ${col.Field}: ${col.Type}`));

        console.log('\n📊 Sample Market Group Items:');
        const [items] = await connection.execute('SELECT * FROM market_group_items LIMIT 20');
        console.log(JSON.stringify(items, null, 2));

        await connection.end();

    } catch (err) {
        console.error('❌ Error:', err.message);
    }
})();
