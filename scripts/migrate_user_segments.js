const mysql = require('mysql2/promise');
require('dotenv').config({ path: 'd:/KiaanProject/traders/Tradersbackend/.env' });

async function migrate() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });

    console.log('Running migration: user_segments table...');

    try {
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS user_segments (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                segment ENUM('MCX','EQUITY','OPTIONS','COMEX','FOREX','CRYPTO') NOT NULL,
                is_enabled TINYINT(1) DEFAULT 0,
                brokerage_type ENUM('PER_LOT','PER_CRORE') DEFAULT 'PER_LOT',
                brokerage_value DECIMAL(10,2) DEFAULT 0,
                leverage DECIMAL(10,2) DEFAULT 1,
                max_lot_per_scrip INT DEFAULT 10,
                margin_type ENUM('PER_LOT','PERCENTAGE','FIXED') DEFAULT 'PER_LOT',
                exposure_multiplier DECIMAL(10,2) DEFAULT 1,
                auto_square_off TINYINT(1) DEFAULT 0,
                square_off_time TIME DEFAULT NULL,
                UNIQUE KEY uq_user_segment (user_id, segment),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        console.log('user_segments table created (or already exists).');
    } catch (err) {
        console.error('Error creating user_segments:', err.message);
    }

    // Also ensure user_documents table exists
    try {
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS user_documents (
                user_id INT PRIMARY KEY,
                pan_number VARCHAR(20),
                pan_screenshot VARCHAR(500),
                aadhar_number VARCHAR(20),
                aadhar_front VARCHAR(500),
                aadhar_back VARCHAR(500),
                bank_proof VARCHAR(500),
                kyc_status ENUM('PENDING','VERIFIED','REJECTED') DEFAULT 'PENDING',
                verified_at DATETIME,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        console.log('user_documents table created (or already exists).');
    } catch (err) {
        console.error('Error creating user_documents:', err.message);
    }

    // Also ensure broker_shares table exists
    try {
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS broker_shares (
                user_id INT PRIMARY KEY,
                share_pl_pct DECIMAL(5,2) DEFAULT 0,
                share_brokerage_pct DECIMAL(5,2) DEFAULT 0,
                share_swap_pct DECIMAL(5,2) DEFAULT 0,
                brokerage_type ENUM('Percentage','Fixed') DEFAULT 'Percentage',
                trading_clients_limit INT DEFAULT 10,
                sub_brokers_limit INT DEFAULT 3,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        console.log('broker_shares table created (or already exists).');
    } catch (err) {
        console.error('Error creating broker_shares:', err.message);
    }

    // Also ensure client_settings table exists
    try {
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS client_settings (
                user_id INT PRIMARY KEY,
                allow_fresh_entry TINYINT(1) DEFAULT 1,
                allow_orders_between_hl TINYINT(1) DEFAULT 1,
                trade_equity_units TINYINT(1) DEFAULT 0,
                auto_close_at_m2m_pct DECIMAL(5,2) DEFAULT 90,
                notify_at_m2m_pct DECIMAL(5,2) DEFAULT 70,
                min_time_to_book_profit INT DEFAULT 120,
                scalping_sl_enabled TINYINT(1) DEFAULT 0,
                config_json TEXT DEFAULT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        console.log('client_settings table created (or already exists).');
    } catch (err) {
        console.error('Error creating client_settings:', err.message);
    }

    // Add config_json column if not exists (for existing tables)
    try {
        await connection.execute('ALTER TABLE client_settings ADD COLUMN config_json TEXT DEFAULT NULL');
        console.log('config_json column added to client_settings.');
    } catch (err) {
        if (err.code === 'ER_DUP_COLUMN_NAME') {
            console.log('config_json column already exists.');
        } else {
            console.error('Error adding config_json:', err.message);
        }
    }

    // Also add permissions_json to broker_shares if not exists
    try {
        await connection.execute('ALTER TABLE broker_shares ADD COLUMN permissions_json TEXT DEFAULT NULL');
        await connection.execute('ALTER TABLE broker_shares ADD COLUMN segments_json TEXT DEFAULT NULL');
        console.log('permissions_json and segments_json added to broker_shares.');
    } catch (err) {
        if (err.code === 'ER_DUP_COLUMN_NAME') {
            console.log('broker_shares extra columns already exist.');
        } else {
            console.error('Error updating broker_shares:', err.message);
        }
    }

    await connection.end();
    console.log('Migration complete.');
}

migrate().catch(err => {
    console.error(err);
    process.exit(1);
});
