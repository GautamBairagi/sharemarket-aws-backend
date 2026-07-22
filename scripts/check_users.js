const mysql = require('mysql2/promise');
require('dotenv').config();

async function checkUsers() {
  const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'traderdb',
    port: parseInt(process.env.DB_PORT || '3306')
  };

  try {
    const connection = await mysql.createConnection(dbConfig);
    const [rows] = await connection.execute('SELECT id, username, role FROM users LIMIT 5');
    console.log('Users:', JSON.stringify(rows, null, 2));
    await connection.end();
  } catch (err) {
    console.error('Error:', err.message);
  }
}

checkUsers();
