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

        console.log('\n🔍 Checking your scripts in database...\n');

        // Get all tables
        const [tables] = await connection.execute('SHOW TABLES');
        console.log('📋 TABLES IN DATABASE:');
        tables.forEach(t => {
            const tableName = Object.values(t)[0];
            console.log(`   • ${tableName}`);
        });

        // Check trades table for unique symbols
        try {
            const [trades] = await connection.execute('SELECT COUNT(DISTINCT symbol) as cnt FROM trades');
            console.log(`\n📊 TRADES TABLE: ${trades[0].cnt} unique symbols`);

            const [symbols] = await connection.execute('SELECT DISTINCT symbol FROM trades ORDER BY symbol LIMIT 30');
            console.log('\nFirst 30 symbols from trades:');
            symbols.forEach(s => console.log(`   • ${s.symbol}`));

            if (trades[0].cnt > 30) {
                console.log(`   ... and ${trades[0].cnt - 30} more symbols`);
            }
        } catch (err) {
            console.log('\n❌ No trades table or error');
        }

        await connection.end();

    } catch (err) {
        console.error('❌ Database error:', err.message);
    }
})();
