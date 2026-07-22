require('dotenv').config();
const mysql = require('mysql2/promise');
async function run() {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        port: process.env.DB_PORT || 3308,
        database: process.env.DB_NAME || 'traderdb'
    });
    
    // Check market_type ENUM values
    const [cols] = await conn.query("SHOW COLUMNS FROM scrip_data LIKE 'market_type'");
    console.log("market_type definition:", cols[0].Type);

    // Check what's in market_group_items
    const [items] = await conn.query("SELECT DISTINCT symbol FROM market_group_items LIMIT 10");
    console.log("Sample market_group_items symbols:", items.map(i => i.symbol));

    await conn.end();
}
run().catch(console.error);
