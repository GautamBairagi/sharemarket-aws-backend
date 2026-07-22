const mysql = require('mysql2/promise');
require('dotenv').config();

// Force local mode if DATABASE_URL is commented out or missing in .env (prevents shell environment leaks
const fs = require('fs');
const path = require('path');
const envPath = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const hasActiveDatabaseUrl = envContent.split(/\r?\n/).some(line => {
        const trimmed = line.trim();
        return trimmed.startsWith('DATABASE_URL=') && !trimmed.startsWith('#');
    });
    if (!hasActiveDatabaseUrl && process.env.DATABASE_URL) {
        console.log('💡 DATABASE_URL is commented out in .env. Deleting from process.env to force local DB connection.');
        delete process.env.DATABASE_URL;
    }
}

let pool;

if (process.env.DATABASE_URL) {
  console.log('🔌 Connecting using DATABASE_URL (Railway/Prod mode)');
  pool = mysql.createPool({
    uri: process.env.DATABASE_URL,
    connectionLimit: 15,
    waitForConnections: true,
    queueLimit: 0
  });
} else {
  console.log('🔌 Connecting using individual DB_Config variables (Local mode)');
  const dbConfig = {
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'traderdb',
    waitForConnections: true,
    connectionLimit: 10,
    connectTimeout: 30000,
    queueLimit: 0
  };

  // Use socketPath if provided (for XAMPP/MariaDB local connection)
  if (process.env.DB_SOCKET_PATH) {
    dbConfig.socketPath = process.env.DB_SOCKET_PATH;
  } else {
    dbConfig.host = process.env.DB_HOST || 'localhost';
    dbConfig.port = parseInt(process.env.DB_PORT || '3306');
  }

  pool = mysql.createPool(dbConfig);
}

// Test connection
pool.getConnection()
  .then(connection => {
    console.log('✅ MySQL Connected Successfully');
    connection.release();
  })
  .catch(err => {
    console.error('❌ MySQL Connection Failed:', err.message);
  });

module.exports = pool;
