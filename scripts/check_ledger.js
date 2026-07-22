const mysql = require('mysql2/promise');
require('dotenv').config();

async function checkLedger() {
  const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'traderdb',
    port: parseInt(process.env.DB_PORT || '3306')
  };

  try {
    const connection = await mysql.createConnection(dbConfig);
    const [rows] = await connection.execute('SELECT COUNT(*) as count FROM action_ledger');
    console.log('Action Ledger Count:', rows[0].count);
    
    if (rows[0].count > 0) {
        const [data] = await connection.execute('SELECT * FROM action_ledger LIMIT 5');
        console.log('Sample Data:', JSON.stringify(data, null, 2));
    }
    
    await connection.end();
  } catch (err) {
    console.error('Error:', err.message);
  }
}

checkLedger();
