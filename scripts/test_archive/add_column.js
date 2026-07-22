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
    
    try {
        await conn.query('ALTER TABLE script_testing ADD COLUMN lot_size INT DEFAULT 1 AFTER expiry');
        console.log("lot_size column added successfully.");
    } catch (err) {
        if (err.code === 'ER_DUP_FIELDNAME') {
            console.log("lot_size column already exists.");
        } else {
            console.error(err);
        }
    }
    await conn.end();
}
run().catch(console.error);
