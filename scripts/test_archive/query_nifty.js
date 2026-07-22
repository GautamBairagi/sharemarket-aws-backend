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
    
    const [rows] = await conn.query("SELECT symbol, lot_size FROM scrip_data WHERE symbol LIKE 'NIFTY%FUT' LIMIT 5");
    console.log(rows);
    await conn.end();
}
run().catch(console.error);
