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
    
    const [rows] = await conn.query('SELECT tradingsymbol, lot_size, ltp FROM script_testing LIMIT 10');
    console.table(rows);
    await conn.end();
}
run().catch(console.error);
