const mysql = require('mysql2/promise');
require('dotenv').config({ path: 'd:/KiaanProject/traders/Tradersbackend/.env' });

async function checkScrips() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });

    try {
        console.log('--- Table Structure (scrip_data) ---');
        const [schema] = await connection.execute('DESCRIBE scrip_data');
        console.log(JSON.stringify(schema, null, 2));

        console.log('\n--- Sample Data (scrip_data) ---');
        const [data] = await connection.execute('SELECT * FROM scrip_data LIMIT 5');
        console.log(JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('Error checking scrip_data:', err.message);
    } finally {
        await connection.end();
    }
}

checkScrips();
