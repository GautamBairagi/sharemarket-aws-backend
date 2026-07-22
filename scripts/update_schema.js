const mysql = require('mysql2/promise');
require('dotenv').config({ path: 'd:/KiaanProject/traders/Tradersbackend/.env' });

async function updateSchema() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });

    console.log("Adding columns to tickers table...");
    try {
        await connection.execute('ALTER TABLE tickers ADD COLUMN start_time DATETIME NULL');
        await connection.execute('ALTER TABLE tickers ADD COLUMN end_time DATETIME NULL');
        console.log("Columns added successfully.");
    } catch (err) {
        if (err.code === 'ER_DUP_COLUMN_NAME') {
            console.log("Columns already exist.");
        } else {
            throw err;
        }
    }
    await connection.end();
}

updateSchema().catch(err => {
    console.error(err);
    process.exit(1);
});
