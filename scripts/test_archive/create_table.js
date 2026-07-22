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
    
    await conn.query(`
        CREATE TABLE IF NOT EXISTS script_testing (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tradingsymbol VARCHAR(100),
            name VARCHAR(100),
            instrument_token INT,
            instrument_type VARCHAR(20),
            exchange VARCHAR(20),
            expiry VARCHAR(50),
            ltp DECIMAL(10,2),
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    `);
    console.log("Table script_testing created.");
    await conn.end();
}
run().catch(console.error);
