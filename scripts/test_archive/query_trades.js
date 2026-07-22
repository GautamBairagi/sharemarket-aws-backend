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
    
    const [rows] = await conn.query("SELECT id, symbol FROM trades WHERE market_type = 'MCX' LIMIT 5");
    console.table(rows);
    await conn.end();
}
run().catch(console.error);
