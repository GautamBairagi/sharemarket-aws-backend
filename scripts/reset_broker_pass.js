const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
require('dotenv').config();

async function resetPassword() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });

    try {
        console.log('Resetting password for broker...');
        const hashed = await bcrypt.hash('broker123', 10);
        await connection.execute('UPDATE users SET password = ? WHERE username = ?', [hashed, 'broker']);
        console.log('Password updated successfully for broker!');
    } catch (err) {
        console.error('Error:', err.message);
    } finally {
        await connection.end();
        process.exit();
    }
}

resetPassword();
