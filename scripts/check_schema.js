const mysql = require('mysql2/promise');
require('dotenv').config({ path: 'd:/KiaanProject/traders/Tradersbackend/.env' });

async function checkSchema() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });

    const [userSchema] = await connection.execute('DESCRIBE users');
    console.log('--- users Table ---');
    console.log(JSON.stringify(userSchema, null, 2));

    try {
        const [settingsSchema] = await connection.execute('DESCRIBE client_settings');
        console.log('\n--- client_settings Table ---');
        console.log(JSON.stringify(settingsSchema, null, 2));
    } catch (e) {
        console.log('\nclient_settings table does not exist.');
    }

    // Auto-create bank_details table if not exists
    await connection.execute(`
        CREATE TABLE IF NOT EXISTS bank_details (
            id INT AUTO_INCREMENT PRIMARY KEY,
            bank_name VARCHAR(100) NOT NULL,
            account_holder VARCHAR(150) NOT NULL,
            account_number VARCHAR(50) NOT NULL,
            ifsc VARCHAR(20) NOT NULL,
            branch VARCHAR(150) NOT NULL,
            status ENUM('Active','Inactive') DEFAULT 'Active',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    console.log('\nbank_details table ensured.');

    // Auto-create new_client_bank table if not exists
    await connection.execute(`
        CREATE TABLE IF NOT EXISTS new_client_bank (
            id INT AUTO_INCREMENT PRIMARY KEY,
            account_holder VARCHAR(150) DEFAULT '',
            account_number VARCHAR(50) DEFAULT '',
            bank_name VARCHAR(100) DEFAULT '',
            ifsc VARCHAR(20) DEFAULT '',
            phone_pe VARCHAR(20) DEFAULT '',
            google_pay VARCHAR(20) DEFAULT '',
            paytm VARCHAR(20) DEFAULT '',
            upi_id VARCHAR(100) DEFAULT '',
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    `);
    console.log('new_client_bank table ensured.');

    await connection.end();
}

checkSchema().catch(err => {
    console.error(err);
    process.exit(1);
});
