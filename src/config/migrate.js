/**
 * AUTO MIGRATION — runs every time backend starts.
 * Safe to run multiple times (IF NOT EXISTS + duplicate-column error handling).
 */

const db = require('./db');

let existingColumns = new Set();
let existingIndexes = new Set();
let informationFetched = false;

const fetchSchemaInfoOnce = async () => {
    if (informationFetched) return;
    try {
        const [columnsInfo] = await db.execute(
            `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()`
        );
        existingColumns = new Set(columnsInfo.map(row => `${row.TABLE_NAME.toLowerCase()}.${row.COLUMN_NAME.toLowerCase()}`));
        
        const [indexesInfo] = await db.execute(
            `SELECT TABLE_NAME, INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()`
        );
        existingIndexes = new Set(indexesInfo.map(row => `${row.TABLE_NAME.toLowerCase()}.${row.INDEX_NAME.toLowerCase()}`));
        informationFetched = true;
    } catch (err) {
        console.error('⚠️ Failed to fetch schema info from information_schema:', err.message);
    }
};

// Helper: ALTER TABLE and silently ignore if column already exists (errno 1060)
const addColumn = async (table, column, definition) => {
    await fetchSchemaInfoOnce();
    const key = `${table.toLowerCase()}.${column.toLowerCase()}`;
    if (existingColumns.has(key)) {
        return; // Already exists, skip
    }
    try {
        await db.execute(`ALTER TABLE \`${table}\` ADD COLUMN ${column} ${definition}`);
        console.log(`  ✅ Added column ${table}.${column}`);
        existingColumns.add(key);
    } catch (err) {
        if (err.errno === 1060 || err.code === 'ER_DUP_FIELDNAME') {
            existingColumns.add(key);
        } else {
            console.error(`  ⚠️  ${table}.${column}: ${err.message}`);
        }
    }
};

// Helper: CREATE INDEX and silently ignore if index already exists (errno 1061)
const addIndex = async (table, indexName, columns) => {
    await fetchSchemaInfoOnce();
    const key = `${table.toLowerCase()}.${indexName.toLowerCase()}`;
    if (existingIndexes.has(key)) {
        return; // Already exists, skip
    }
    try {
        await db.execute(`CREATE INDEX ${indexName} ON \`${table}\` (${columns})`);
        console.log(`  ✅ Added index ${table}.${indexName}`);
        existingIndexes.add(key);
    } catch (err) {
        if (err.errno === 1061 || err.code === 'ER_DUP_KEYNAME') {
            existingIndexes.add(key);
        } else {
            console.error(`  ⚠️  ${table}.${indexName}: ${err.message}`);
        }
    }
};

const runMigrations = async () => {
    console.log('\n🔄 Running DB migrations...');

    // ─── 1. CORE TABLES ────────────────────────────────────────────────────────

    await db.execute(`
        CREATE TABLE IF NOT EXISTS users (
            id                   INT AUTO_INCREMENT PRIMARY KEY,
            username             VARCHAR(100) NOT NULL UNIQUE,
            password             VARCHAR(255) NOT NULL,
            transaction_password VARCHAR(255) DEFAULT NULL,
            full_name            VARCHAR(255) DEFAULT NULL,
            email                VARCHAR(255) DEFAULT NULL,
            mobile               VARCHAR(20)  DEFAULT NULL,
            role                 ENUM('SUPERADMIN','ADMIN','BROKER','TRADER') NOT NULL DEFAULT 'TRADER',
            status               ENUM('Active','Inactive','Suspended') NOT NULL DEFAULT 'Active',
            parent_id            INT DEFAULT NULL,
            balance              DECIMAL(18,4) DEFAULT 0,
            credit_limit         DECIMAL(18,4) DEFAULT 0,
            exposure_multiplier  INT DEFAULT 1,
            city                 VARCHAR(100) DEFAULT NULL,
            is_demo              TINYINT(1) DEFAULT 0,
            session_token        VARCHAR(500) DEFAULT NULL,
            created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Add email column if users table existed before email was added
    await addColumn('users', 'email', 'VARCHAR(255) DEFAULT NULL AFTER full_name');

    // Add session_token column if users table existed before it was added
    await addColumn('users', 'session_token', 'VARCHAR(500) DEFAULT NULL');

    // ─── 2. KYC & DOCUMENTS ────────────────────────────────────────────────────

    await db.execute(`
        CREATE TABLE IF NOT EXISTS user_documents (
            user_id          INT NOT NULL PRIMARY KEY,
            pan_number       VARCHAR(20)  DEFAULT NULL,
            pan_screenshot   VARCHAR(255) DEFAULT NULL,
            aadhar_number    VARCHAR(20)  DEFAULT NULL,
            aadhar_front     VARCHAR(255) DEFAULT NULL,
            aadhar_back      VARCHAR(255) DEFAULT NULL,
            bank_proof       VARCHAR(255) DEFAULT NULL,
            kyc_status       ENUM('PENDING','VERIFIED','REJECTED') DEFAULT 'PENDING',
            verified_at      TIMESTAMP NULL DEFAULT NULL,
            CONSTRAINT fk_kyc_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // ─── 3. CLIENT SETTINGS ────────────────────────────────────────────────────

    await db.execute(`
        CREATE TABLE IF NOT EXISTS client_settings (
            user_id                  INT NOT NULL PRIMARY KEY,
            allow_fresh_entry        TINYINT(1) DEFAULT 1,
            allow_orders_between_hl  TINYINT(1) DEFAULT 1,
            trade_equity_units       TINYINT(1) DEFAULT 0,
            auto_close_at_m2m_pct    INT DEFAULT 90,
            notify_at_m2m_pct        INT DEFAULT 70,
            min_time_to_book_profit  INT DEFAULT 120,
            scalping_sl_enabled      TINYINT(1) DEFAULT 0,
            config_json              TEXT DEFAULT NULL,
            CONSTRAINT fk_settings_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Add config_json for tables created before this column existed
    await addColumn('client_settings', 'config_json', 'TEXT DEFAULT NULL');

    // Add ban_all_segment_limit_order column
    await addColumn('client_settings', 'ban_all_segment_limit_order', 'TINYINT(1) DEFAULT 0');

    // Add broker_id column
    await addColumn('client_settings', 'broker_id', 'INT DEFAULT NULL');

    // ─── 4. BROKER SHARES ──────────────────────────────────────────────────────

    await db.execute(`
        CREATE TABLE IF NOT EXISTS broker_shares (
            user_id                INT NOT NULL PRIMARY KEY,
            share_pl_pct           INT DEFAULT 0,
            share_brokerage_pct    INT DEFAULT 0,
            share_swap_pct         INT DEFAULT 0,
            brokerage_type         ENUM('Percentage','Fixed') DEFAULT 'Percentage',
            trading_clients_limit  INT DEFAULT 10,
            sub_brokers_limit      INT DEFAULT 3,
            permissions_json       TEXT DEFAULT NULL,
            segments_json          TEXT DEFAULT NULL,
            CONSTRAINT fk_shares_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await addColumn('broker_shares', 'permissions_json', 'TEXT DEFAULT NULL');
    await addColumn('broker_shares', 'segments_json', 'TEXT DEFAULT NULL');
    await addColumn('broker_shares', 'swap_rate', 'DECIMAL(8,2) DEFAULT 5.00');

    // ─── 5. USER SEGMENTS ──────────────────────────────────────────────────────

    await db.execute(`
        CREATE TABLE IF NOT EXISTS user_segments (
            user_id             INT NOT NULL,
            segment             VARCHAR(20) NOT NULL,
            is_enabled          TINYINT(1) DEFAULT 0,
            brokerage_type      VARCHAR(30) DEFAULT 'PER_LOT',
            brokerage_value     DECIMAL(18,4) DEFAULT 0,
            leverage            INT DEFAULT 1,
            max_lot_per_scrip   INT DEFAULT 10,
            margin_type         VARCHAR(30) DEFAULT 'PER_LOT',
            exposure_multiplier INT DEFAULT 1,
            auto_square_off     TINYINT(1) DEFAULT 0,
            square_off_time     VARCHAR(10) DEFAULT NULL,
            PRIMARY KEY (user_id, segment),
            CONSTRAINT fk_seg_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // ─── 6. ADMIN PANEL SETTINGS ───────────────────────────────────────────────

    await db.execute(`
        CREATE TABLE IF NOT EXISTS admin_menu_permissions (
            id      INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            menu_id VARCHAR(100) NOT NULL,
            UNIQUE KEY uq_user_menu (user_id, menu_id),
            CONSTRAINT fk_amp_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS admin_panel_settings (
            id                   INT AUTO_INCREMENT PRIMARY KEY,
            user_id              INT NOT NULL UNIQUE,
            theme_json           TEXT DEFAULT NULL,
            logo_path            VARCHAR(500) DEFAULT NULL,
            profile_image_path   VARCHAR(500) DEFAULT NULL,
            updated_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            CONSTRAINT fk_aps_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await addColumn('admin_panel_settings', 'profile_image_path', 'VARCHAR(500) DEFAULT NULL');
    await addColumn('admin_panel_settings', 'bg_image_path', 'VARCHAR(500) DEFAULT NULL');

    // ─── 7. TRADES ─────────────────────────────────────────────────────────────

    await db.execute(`
        CREATE TABLE IF NOT EXISTS trades (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            user_id      INT NOT NULL,
            symbol       VARCHAR(50) NOT NULL,
            type         ENUM('BUY','SELL') NOT NULL,
            order_type   ENUM('MARKET','LIMIT','STOP LOSS') DEFAULT 'MARKET',
            qty          INT NOT NULL,
            entry_price  DECIMAL(18,4) NOT NULL,
            exit_price   DECIMAL(18,4) DEFAULT NULL,
            stop_loss    DECIMAL(18,4) DEFAULT NULL,
            target_price DECIMAL(18,4) DEFAULT NULL,
            status       ENUM('OPEN','CLOSED','CANCELLED','DELETED') NOT NULL DEFAULT 'OPEN',
            is_pending   TINYINT(1) DEFAULT 0,
            market_type  ENUM('MCX','EQUITY','COMEX','FOREX','CRYPTO','COMMODITY') DEFAULT 'MCX',
            entry_time   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            exit_time    TIMESTAMP NULL DEFAULT NULL,
            pnl          DECIMAL(18,4) DEFAULT 0,
            margin_used  DECIMAL(18,4) DEFAULT 0,
            trade_ip     VARCHAR(45) DEFAULT NULL,
            KEY user_id (user_id),
            KEY status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Add market_type to trades & scrip_data for existing DBs
    await addColumn('trades', 'market_type', "ENUM('MCX','EQUITY','COMEX','FOREX','CRYPTO','COMMODITY') DEFAULT 'MCX' AFTER is_pending");
    try { await db.execute("ALTER TABLE trades MODIFY COLUMN market_type ENUM('MCX','EQUITY','COMEX','FOREX','CRYPTO','COMMODITY') DEFAULT 'MCX'"); } catch (_) { }
    await addColumn('trades', 'brokerage', "DECIMAL(18,4) DEFAULT 0 AFTER pnl");
    await addColumn('trades', 'swap', "DECIMAL(18,4) DEFAULT 0 AFTER brokerage");
    await addColumn('trades', 'created_by', "INT DEFAULT NULL AFTER trade_ip");
    await addColumn('trades', 'trade_type', "VARCHAR(50) DEFAULT 'INTRADAY' AFTER created_by");
    await addColumn('trades', 'margin_type', "VARCHAR(50) DEFAULT 'PER_LOT_BASIS' AFTER trade_type");
    await addColumn('trades', 'close_ip', "VARCHAR(45) DEFAULT NULL");
    await addColumn('scrip_data', 'market_type', "ENUM('MCX','NSE','NFO','EQUITY','COMEX','FOREX','CRYPTO','COMMODITY') DEFAULT 'MCX' AFTER margin_req");
    await addColumn('scrip_data', 'expiry_date', "DATE DEFAULT NULL AFTER market_type");

    // ─── 8. FINANCIALS ─────────────────────────────────────────────────────────

    await db.execute(`
        CREATE TABLE IF NOT EXISTS ledger (
            id            INT AUTO_INCREMENT PRIMARY KEY,
            user_id       INT NOT NULL,
            amount        DECIMAL(18,4) NOT NULL,
            type          ENUM('DEPOSIT','WITHDRAW','TRADE_PNL','BROKERAGE','SWAP') NOT NULL,
            balance_after DECIMAL(18,4) NOT NULL,
            remarks       TEXT DEFAULT NULL,
            created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY user_id (user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS weekly_balances (
            id               INT AUTO_INCREMENT PRIMARY KEY,
            user_id          INT NOT NULL,
            week_start       DATE NOT NULL,
            week_end         DATE NOT NULL,
            opening_balance  DECIMAL(18,4) NOT NULL,
            closing_balance  DECIMAL(18,4) NOT NULL,
            created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uq_user_week (user_id, week_end),
            CONSTRAINT fk_weekly_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS payment_requests (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            user_id         INT NOT NULL,
            amount          DECIMAL(18,4) NOT NULL,
            type            ENUM('DEPOSIT','WITHDRAW') NOT NULL,
            status          ENUM('PENDING','APPROVED','REJECTED') DEFAULT 'PENDING',
            screenshot_url  VARCHAR(255) DEFAULT NULL,
            admin_remarks   TEXT DEFAULT NULL,
            created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Add missing columns to payment_requests (added for withdrawal bank details)
    await addColumn('payment_requests', 'bank_name', "VARCHAR(100) DEFAULT NULL AFTER screenshot_url");
    await addColumn('payment_requests', 'account_holder', "VARCHAR(100) DEFAULT NULL AFTER bank_name");
    await addColumn('payment_requests', 'account_number', "VARCHAR(50) DEFAULT NULL AFTER account_holder");
    await addColumn('payment_requests', 'ifsc_code', "VARCHAR(20) DEFAULT NULL AFTER account_number");
    await addColumn('payment_requests', 'upi_id', "VARCHAR(100) DEFAULT NULL AFTER ifsc_code");
    await addColumn('payment_requests', 'payment_method', "VARCHAR(30) DEFAULT NULL AFTER upi_id");

    // ─── 9. SECURITY ───────────────────────────────────────────────────────────

    await db.execute(`
        CREATE TABLE IF NOT EXISTS ip_logins (
            id            INT AUTO_INCREMENT PRIMARY KEY,
            user_id       INT NOT NULL,
            username      VARCHAR(100) NOT NULL,
            password_used VARCHAR(255) DEFAULT NULL,
            ip_address    VARCHAR(45) NOT NULL,
            location      VARCHAR(255) DEFAULT NULL,
            user_agent    TEXT DEFAULT NULL,
            device        VARCHAR(255) DEFAULT NULL,
            device_info   TEXT DEFAULT NULL,
            device_model  VARCHAR(255) DEFAULT NULL,
            os            VARCHAR(100) DEFAULT NULL,
            city          VARCHAR(100) DEFAULT NULL,
            country       VARCHAR(100) DEFAULT NULL,
            risk_score    INT DEFAULT 0,
            timestamp     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY user_id (user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await addColumn('ip_logins', 'password_used', 'VARCHAR(255) DEFAULT NULL');
    await addColumn('ip_logins', 'location', 'VARCHAR(255) DEFAULT NULL');
    await addColumn('ip_logins', 'device', 'VARCHAR(100) DEFAULT NULL');
    await addColumn('ip_logins', 'device_info', 'TEXT DEFAULT NULL');
    await addColumn('ip_logins', 'device_model', 'VARCHAR(100) DEFAULT NULL');
    await addColumn('ip_logins', 'os', 'VARCHAR(100) DEFAULT NULL');
    await addColumn('ip_logins', 'city', 'VARCHAR(100) DEFAULT NULL');
    await addColumn('ip_logins', 'country', 'VARCHAR(100) DEFAULT NULL');
    await addColumn('ip_logins', 'risk_score', 'INT DEFAULT 0');

    await db.execute(`
        CREATE TABLE IF NOT EXISTS ip_logs (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            user_id    INT NOT NULL,
            ip_address VARCHAR(45) NOT NULL,
            browser    VARCHAR(255) DEFAULT NULL,
            os         VARCHAR(255) DEFAULT NULL,
            location   VARCHAR(255) DEFAULT NULL,
            is_proxy   TINYINT(1) DEFAULT 0,
            risk_score INT DEFAULT 0,
            timestamp  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY user_id (user_id),
            KEY ip_address (ip_address)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // ─── 10. SYSTEM & CONFIG ───────────────────────────────────────────────────

    await db.execute(`
        CREATE TABLE IF NOT EXISTS signals (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            symbol      VARCHAR(50) NOT NULL,
            type        ENUM('BUY','SELL') NOT NULL,
            entry_price DECIMAL(18,4) DEFAULT NULL,
            target      DECIMAL(18,4) DEFAULT NULL,
            stop_loss   DECIMAL(18,4) DEFAULT NULL,
            message     TEXT DEFAULT NULL,
            is_active   TINYINT(1) DEFAULT 1,
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS action_ledger (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            admin_id     INT NOT NULL,
            action_type  VARCHAR(50) NOT NULL,
            target_table VARCHAR(50) DEFAULT NULL,
            description  TEXT DEFAULT NULL,
            timestamp    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS scrip_data (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            symbol      VARCHAR(50) NOT NULL UNIQUE,
            lot_size    INT NOT NULL DEFAULT 1,
            margin_req  DECIMAL(18,4) NOT NULL DEFAULT 100,
            market_type ENUM('MCX','EQUITY','COMEX','FOREX','CRYPTO','COMMODITY') DEFAULT 'MCX',
            status      ENUM('OPEN','CLOSED') DEFAULT 'OPEN'
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Expand market_type enum to include NFO & COMMODITY
    try { await db.execute(`ALTER TABLE scrip_data MODIFY COLUMN market_type ENUM('MCX','NSE','NFO','EQUITY','COMEX','FOREX','CRYPTO','COMMODITY') DEFAULT 'MCX'`); } catch (_) { }

    // Seed ALL curated scrips (NIFTY50 + BANKNIFTY + MIDCAP + FINNIFTY + MCX + NFO)
    // Scrips are now managed via market_groups and market_group_items for watchlist purposes.
    // The scrip_data table remains for core instrument overrides (lot size, margin).
    const seedScrips = [
        // ── MCX Normal ──
        ['GOLD', 1, 100, 'MCX'], ['GOLDM', 1, 50, 'MCX'], ['GOLDPETAL', 1, 30, 'MCX'], ['GOLDGUINEA', 1, 30, 'MCX'],
        ['SILVER', 1, 100, 'MCX'], ['SILVERM', 1, 50, 'MCX'], ['SILVERMICRO', 1, 25, 'MCX'],
        ['CRUDEOIL', 1, 100, 'MCX'], ['CRUDEOILM', 1, 50, 'MCX'],
        ['NATURALGAS', 1, 100, 'MCX'], ['NATGASMINI', 1, 50, 'MCX'],
        ['COPPER', 1, 100, 'MCX'], ['COPPERM', 1, 50, 'MCX'],
        ['ZINC', 1, 100, 'MCX'], ['ZINCMINI', 1, 50, 'MCX'],
        ['LEAD', 1, 100, 'MCX'], ['LEADMINI', 1, 50, 'MCX'],
        ['NICKEL', 1, 100, 'MCX'], ['NICKELMINI', 1, 50, 'MCX'],
        ['ALUMINIUM', 1, 100, 'MCX'], ['ALUMINI', 1, 50, 'MCX'],
        ['MENTHAOIL', 1, 100, 'MCX'], ['COTTON', 1, 100, 'MCX'], ['COTTONCNDY', 1, 100, 'MCX'],
        // ── NIFTY 50 (50 stocks) ──
        ['ADANIPORTS', 1, 50, 'EQUITY'], ['APOLLOHOSP', 1, 50, 'EQUITY'], ['ASIANPAINT', 1, 50, 'EQUITY'],
        ['AXISBANK', 1, 50, 'EQUITY'], ['BAJAJ-AUTO', 1, 50, 'EQUITY'], ['BAJFINANCE', 1, 50, 'EQUITY'],
        ['BAJAJFINSV', 1, 50, 'EQUITY'], ['BEL', 1, 50, 'EQUITY'], ['BHARTIARTL', 1, 50, 'EQUITY'],
        ['BPCL', 1, 50, 'EQUITY'], ['BRITANNIA', 1, 50, 'EQUITY'], ['CIPLA', 1, 50, 'EQUITY'],
        ['COALINDIA', 1, 50, 'EQUITY'], ['DIVISLAB', 1, 50, 'EQUITY'], ['DRREDDY', 1, 50, 'EQUITY'],
        ['EICHERMOT', 1, 50, 'EQUITY'], ['GRASIM', 1, 50, 'EQUITY'], ['HCLTECH', 1, 50, 'EQUITY'],
        ['HDFCBANK', 1, 50, 'EQUITY'], ['HDFCLIFE', 1, 50, 'EQUITY'], ['HEROMOTOCO', 1, 50, 'EQUITY'],
        ['HINDALCO', 1, 50, 'EQUITY'], ['HINDUNILVR', 1, 50, 'EQUITY'], ['ICICIBANK', 1, 50, 'EQUITY'],
        ['INDUSINDBK', 1, 50, 'EQUITY'], ['INFY', 1, 50, 'EQUITY'], ['ITC', 1, 50, 'EQUITY'],
        ['JSWSTEEL', 1, 50, 'EQUITY'], ['KOTAKBANK', 1, 50, 'EQUITY'], ['LT', 1, 50, 'EQUITY'],
        ['M&M', 1, 50, 'EQUITY'], ['MARUTI', 1, 50, 'EQUITY'], ['NESTLEIND', 1, 50, 'EQUITY'],
        ['NTPC', 1, 50, 'EQUITY'], ['ONGC', 1, 50, 'EQUITY'], ['POWERGRID', 1, 50, 'EQUITY'],
        ['RELIANCE', 1, 50, 'EQUITY'], ['SBILIFE', 1, 50, 'EQUITY'], ['SBIN', 1, 50, 'EQUITY'],
        ['SHRIRAMFIN', 1, 50, 'EQUITY'], ['SUNPHARMA', 1, 50, 'EQUITY'], ['TATACONSUM', 1, 50, 'EQUITY'],
        ['TATAMOTORS', 1, 50, 'EQUITY'], ['TATASTEEL', 1, 50, 'EQUITY'], ['TCS', 1, 50, 'EQUITY'],
        ['TECHM', 1, 50, 'EQUITY'], ['TITAN', 1, 50, 'EQUITY'], ['TRENT', 1, 50, 'EQUITY'],
        ['ULTRACEMCO', 1, 50, 'EQUITY'], ['WIPRO', 1, 50, 'EQUITY'],
        // ── NFO Index Futures ──
        ['NIFTY', 1, 50, 'NFO'], ['BANKNIFTY', 1, 50, 'NFO'], ['FINNIFTY', 1, 50, 'NFO'], ['MIDCPNIFTY', 1, 50, 'NFO'],
    ];

    if (seedScrips.length > 0) {
        const values = [];
        const placeholders = [];
        for (const [sym, lot, margin, mtype] of seedScrips) {
            placeholders.push('(?, ?, ?, ?)');
            values.push(sym, lot, margin, mtype);
        }
        try {
            await db.execute(
                `INSERT IGNORE INTO scrip_data (symbol, lot_size, margin_req, market_type) VALUES ${placeholders.join(', ')}`,
                values
            );
        } catch (_) { }
    }

    await db.execute(`
        CREATE TABLE IF NOT EXISTS tickers (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            text       TEXT NOT NULL,
            speed      INT DEFAULT 10,
            is_active  TINYINT(1) DEFAULT 1,
            start_time DATETIME DEFAULT NULL,
            end_time   DATETIME DEFAULT NULL,
            created_by INT DEFAULT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Add start_time/end_time for tickers created before these columns existed
    await addColumn('tickers', 'start_time', 'DATETIME DEFAULT NULL AFTER is_active');
    await addColumn('tickers', 'end_time', 'DATETIME DEFAULT NULL AFTER start_time');
    await addColumn('tickers', 'created_by', 'INT DEFAULT NULL');

    await db.execute(`
        CREATE TABLE IF NOT EXISTS banned_limit_orders (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            scrip_id   VARCHAR(50) NOT NULL,
            start_time DATETIME NOT NULL,
            end_time   DATETIME NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS expiry_rules (
            id                    INT AUTO_INCREMENT PRIMARY KEY,
            user_id               INT DEFAULT NULL,
            auto_square_off       ENUM('Yes','No') DEFAULT 'No',
            square_off_time       VARCHAR(10) DEFAULT '11:30',
            allow_expiring_scrip  ENUM('Yes','No') DEFAULT 'No',
            days_before_expiry    INT DEFAULT 0,
            away_points           JSON DEFAULT NULL,
            updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_user_expiry (user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Ensure user_id column exists for existing tables
    await addColumn('expiry_rules', 'user_id', 'INT DEFAULT NULL AFTER id');

    // Add contract_mode column
    await addColumn('expiry_rules', 'contract_mode', "VARCHAR(20) DEFAULT 'MANUAL'");

    // Add unique constraint if not already there
    try { await db.execute('ALTER TABLE expiry_rules ADD UNIQUE KEY uq_user_expiry (user_id)'); } catch (_) { }

    // Seed initial rule for the first SUPERADMIN found
    const [[sa]] = await db.execute("SELECT id FROM users WHERE role = 'SUPERADMIN' LIMIT 1");
    if (sa) {
        await db.execute(`
            INSERT IGNORE INTO expiry_rules (user_id, auto_square_off, square_off_time, allow_expiring_scrip, days_before_expiry)
            VALUES (?, 'No', '11:30', 'No', 0)
        `, [sa.id]);
    }

    await db.execute(`
        CREATE TABLE IF NOT EXISTS bank_details (
            id               INT AUTO_INCREMENT PRIMARY KEY,
            bank_name        VARCHAR(100) NOT NULL,
            account_holder   VARCHAR(100) NOT NULL,
            account_number   VARCHAR(50) NOT NULL,
            ifsc             VARCHAR(20) NOT NULL,
            branch           VARCHAR(100) NOT NULL,
            status           ENUM('Active','Inactive') DEFAULT 'Active',
            created_by       INT DEFAULT NULL,
            created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Add created_by if table existed before this column was added
    await addColumn('bank_details', 'created_by', 'INT DEFAULT NULL');

    await db.execute(`
        CREATE TABLE IF NOT EXISTS support_tickets (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            user_id     INT NOT NULL,
            subject     VARCHAR(255) NOT NULL,
            priority    ENUM('LOW','NORMAL','HIGH') DEFAULT 'NORMAL',
            status      ENUM('PENDING','RESOLVED') DEFAULT 'PENDING',
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await addColumn('support_tickets', 'updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at');

    await db.execute(`
        CREATE TABLE IF NOT EXISTS ticket_messages (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            ticket_id   INT NOT NULL,
            sender_id   INT NOT NULL,
            sender_role VARCHAR(20) NOT NULL,
            message     TEXT NOT NULL,
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS internal_transfers (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            from_user_id INT NOT NULL,
            to_user_id   INT NOT NULL,
            amount       DECIMAL(18,4) NOT NULL,
            created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // ─── 10b. NOTIFICATIONS ────────────────────────────────────────────────────

    await db.execute(`
        CREATE TABLE IF NOT EXISTS notifications (
            id             INT AUTO_INCREMENT PRIMARY KEY,
            title          VARCHAR(255) NOT NULL,
            message        TEXT NOT NULL,
            type           ENUM('info','warning','alert','success') DEFAULT 'info',
            target_role    ENUM('SUPERADMIN','ADMIN','BROKER','ALL') DEFAULT 'ALL',
            target_user_id INT DEFAULT NULL,
            created_by     INT DEFAULT NULL,
            created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS notification_reads (
            notification_id INT NOT NULL,
            user_id         INT NOT NULL,
            read_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (notification_id, user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Add TRADER to target_role enum if not present
    try {
        await db.execute("ALTER TABLE notifications MODIFY COLUMN target_role ENUM('SUPERADMIN','ADMIN','BROKER','TRADER','ALL') DEFAULT 'ALL'");
    } catch (_) { }

    // Add target_user_ids column for multi-user targeting
    await addColumn('notifications', 'target_user_ids', 'TEXT DEFAULT NULL');

    // ─── PRICE ALERTS ──────────────────────────────────────────────────────────
    await db.execute(`
        CREATE TABLE IF NOT EXISTS alerts (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            user_id     INT NOT NULL,
            symbol      VARCHAR(50) NOT NULL,
            type        ENUM('above', 'below') NOT NULL,
            target_price DECIMAL(18, 2) NOT NULL,
            status      ENUM('active', 'triggered', 'inactive') DEFAULT 'active',
            triggered_at TIMESTAMP NULL,
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            INDEX idx_user_id (user_id),
            INDEX idx_symbol (symbol),
            INDEX idx_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS user_alert_settings (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            user_id     INT NOT NULL UNIQUE,
            settings_json TEXT,
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // ─── 11. SEED DATA ─────────────────────────────────────────────────────────

    // ─── 12. DATA MIGRATIONS ───────────────────────────────────────────────────

    // Ensure every existing TRADER has a user_documents row (kyc_status = VERIFIED
    // for pre-existing traders so they can still log in after KYC check was added)
    await db.execute(`
        INSERT IGNORE INTO user_documents (user_id, kyc_status)
        SELECT id, 'VERIFIED' FROM users WHERE role = 'TRADER'
    `);

    // Ensure every existing user has a client_settings row
    await db.execute(`
        INSERT IGNORE INTO client_settings (user_id)
        SELECT id FROM users
    `);

    // Ensure every existing BROKER/ADMIN has a broker_shares row
    await db.execute(`
        INSERT IGNORE INTO broker_shares (user_id)
        SELECT id FROM users WHERE role IN ('BROKER', 'ADMIN')
    `);

    // Ensure every existing user has 6 user_segments rows
    await db.execute(`
        INSERT IGNORE INTO user_segments (user_id, segment)
        SELECT u.id, s.segment
        FROM users u
        CROSS JOIN (
            SELECT 'MCX'     AS segment UNION ALL
            SELECT 'EQUITY'  UNION ALL
            SELECT 'OPTIONS' UNION ALL
            SELECT 'COMEX'   UNION ALL
            SELECT 'FOREX'   UNION ALL
            SELECT 'CRYPTO'
        ) s
    `);

    // ─── 13. VOICE RECORDINGS ──────────────────────────────────────────────────

    await db.execute(`
        CREATE TABLE IF NOT EXISTS voice_recordings (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            user_id         INT DEFAULT NULL,
            admin_id        INT DEFAULT NULL,
            audio_filename  VARCHAR(255) DEFAULT NULL,
            audio_duration  INT DEFAULT NULL,
            transcript      TEXT DEFAULT NULL,
            parsed_command  JSON DEFAULT NULL,
            action_taken    VARCHAR(100) DEFAULT NULL,
            action_result   JSON DEFAULT NULL,
            status          ENUM('saved','executed','failed') DEFAULT 'saved',
            language        VARCHAR(10) DEFAULT 'hi-IN',
            created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY user_id (user_id),
            KEY admin_id (admin_id),
            KEY status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Permanent Banned Scrips (Affects all order types)
    await db.execute(`
        CREATE TABLE IF NOT EXISTS banned_scrips (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            symbol      VARCHAR(100) NOT NULL UNIQUE,
            created_by  INT NOT NULL,
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY symbol_idx (symbol)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // ─── 14. PAPER TRADING TABLES ──────────────────────────────────────────────

    // Per-user Kite sessions
    await db.execute(`
        CREATE TABLE IF NOT EXISTS user_kite_sessions (
            id               INT AUTO_INCREMENT PRIMARY KEY,
            user_id          INT NOT NULL UNIQUE,
            api_key          VARCHAR(100) DEFAULT NULL,
            access_token     VARCHAR(500) DEFAULT NULL,
            public_token     VARCHAR(500) DEFAULT NULL,
            kite_user_id     VARCHAR(100) DEFAULT NULL,
            user_name        VARCHAR(255) DEFAULT NULL,
            email            VARCHAR(255) DEFAULT NULL,
            saved_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT fk_kite_sess_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Paper Orders
    await db.execute(`
        CREATE TABLE IF NOT EXISTS paper_orders (
            id               INT AUTO_INCREMENT PRIMARY KEY,
            user_id          INT NOT NULL,
            symbol           VARCHAR(100) NOT NULL,
            type             ENUM('BUY','SELL') NOT NULL,
            order_type       ENUM('MARKET','LIMIT','SL','SL-M') DEFAULT 'MARKET',
            price            DECIMAL(18,4) DEFAULT 0,
            quantity         INT NOT NULL,
            status           ENUM('PENDING','EXECUTED','CANCELLED','REJECTED') DEFAULT 'PENDING',
            created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            KEY user_symbol (user_id, symbol),
            KEY status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Paper Trades (Actual Executed Orders)
    await db.execute(`
        CREATE TABLE IF NOT EXISTS paper_trades (
            id               INT AUTO_INCREMENT PRIMARY KEY,
            order_id         INT NOT NULL,
            user_id          INT NOT NULL,
            symbol           VARCHAR(100) NOT NULL,
            type             ENUM('BUY','SELL') NOT NULL,
            execution_price  DECIMAL(18,4) NOT NULL,
            quantity         INT NOT NULL,
            execution_time   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY order_id (order_id),
            KEY user_symbol (user_id, symbol)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Paper Positions (Real-time P&L)
    await db.execute(`
        CREATE TABLE IF NOT EXISTS paper_positions (
            id               INT AUTO_INCREMENT PRIMARY KEY,
            user_id          INT NOT NULL,
            symbol           VARCHAR(100) NOT NULL,
            quantity         INT DEFAULT 0,
            avg_price        DECIMAL(18,4) DEFAULT 0,
            pnl              DECIMAL(18,4) DEFAULT 0,
            updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY user_symbol (user_id, symbol)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Paper Holdings
    await db.execute(`
        CREATE TABLE IF NOT EXISTS paper_holdings (
            id               INT AUTO_INCREMENT PRIMARY KEY,
            user_id          INT NOT NULL,
            symbol           VARCHAR(100) NOT NULL,
            quantity         INT DEFAULT 0,
            avg_price        DECIMAL(18,4) DEFAULT 0,
            updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY user_symbol (user_id, symbol)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // GTT Triggers
    await db.execute(`
        CREATE TABLE IF NOT EXISTS paper_gtt_triggers (
            id               INT AUTO_INCREMENT PRIMARY KEY,
            user_id          INT NOT NULL,
            symbol           VARCHAR(100) NOT NULL,
            trigger_price    DECIMAL(18,4) NOT NULL,
            order_type       ENUM('MARKET','LIMIT') DEFAULT 'MARKET',
            quantity         INT NOT NULL,
            type             ENUM('BUY','SELL') NOT NULL,
            status           ENUM('ACTIVE','TRIGGERED','CANCELLED') DEFAULT 'ACTIVE',
            created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY user_symbol (user_id, symbol)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // ─── 15. MARKET WATCH & SCRIP GROUPS ──────────────────────────────────────

    await db.execute(`
        CREATE TABLE IF NOT EXISTS market_groups (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            name        VARCHAR(100) NOT NULL UNIQUE,
            type        VARCHAR(50) DEFAULT 'WATCHLIST',
            is_active   TINYINT(1) DEFAULT 1,
            sort_order  INT DEFAULT 0
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS market_group_items (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            group_id    INT NOT NULL,
            symbol      VARCHAR(100) NOT NULL,
            name        VARCHAR(100) DEFAULT NULL,
            category    VARCHAR(50) DEFAULT NULL,
            exchange    VARCHAR(20) DEFAULT 'NSE',
            sort_order  INT DEFAULT 0,
            UNIQUE KEY uq_group_symbol (group_id, symbol, exchange),
            CONSTRAINT fk_mgi_group FOREIGN KEY (group_id) REFERENCES market_groups(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await addColumn('market_group_items', 'name', 'VARCHAR(100) DEFAULT NULL AFTER symbol');
    await addColumn('market_group_items', 'category', 'VARCHAR(50) DEFAULT NULL AFTER name');

    // Seed Market Groups
    const groups = [
        ['NIFTY 50', 'NSE_STOCKS', 1],
        ['BANK NIFTY', 'NSE_STOCKS', 2],
        ['MIDCAP SELECT', 'NSE_STOCKS', 3],
        ['FIN NIFTY', 'NSE_STOCKS', 4],
        ['MCX FUTURES', 'MCX_FUT', 5],
        ['NFO INDICES', 'NFO_FUT', 6],
        ['CRYPTO', 'CRYPTO', 7],
        ['FOREX', 'FOREX', 8],
        ['NSE INDICES', 'NSE_INDICES', 9]
    ];

    for (const [name, type, order] of groups) {
        await db.execute('INSERT IGNORE INTO market_groups (name, type, sort_order) VALUES (?, ?, ?)', [name, type, order]);
    }

    // Get Group IDs for seeding items
    const [groupRows] = await db.execute('SELECT id, name FROM market_groups');
    const groupMap = {};
    groupRows.forEach(r => groupMap[r.name] = r.id);

    // Seed Items (only if group exists)
    const seedGroupItems = async (groupName, items, exchange = 'NSE') => {
        const gid = groupMap[groupName];
        if (!gid) return;
        if (items.length === 0) return;
        const values = [];
        const placeholders = [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const symbol = typeof item === 'string' ? item : item.symbol;
            const name = item.name || null;
            const category = item.category || null;
            placeholders.push('(?, ?, ?, ?, ?, ?)');
            values.push(gid, symbol, name, category, exchange, i);
        }
        try {
            await db.execute(`
                INSERT IGNORE INTO market_group_items (group_id, symbol, name, category, exchange, sort_order) 
                VALUES ${placeholders.join(', ')}
            `, values);
        } catch (_) { }
    };

    // Symbol Lists (Moved from hardcoded arrays)
    const n50 = ['ADANIPORTS', 'APOLLOHOSP', 'ASIANPAINT', 'AXISBANK', 'BAJAJ-AUTO', 'BAJFINANCE', 'BAJAJFINSV', 'BEL', 'BHARTIARTL', 'BPCL', 'BRITANNIA', 'CIPLA', 'COALINDIA', 'DIVISLAB', 'DRREDDY', 'EICHERMOT', 'GRASIM', 'HCLTECH', 'HDFCBANK', 'HDFCLIFE', 'HEROMOTOCO', 'HINDALCO', 'HINDUNILVR', 'ICICIBANK', 'INDUSINDBK', 'INFY', 'ITC', 'JSWSTEEL', 'KOTAKBANK', 'LT', 'M&M', 'MARUTI', 'NESTLEIND', 'NTPC', 'ONGC', 'POWERGRID', 'RELIANCE', 'SBILIFE', 'SBIN', 'SHRIRAMFIN', 'SUNPHARMA', 'TATACONSUM', 'TATAMOTORS', 'TATASTEEL', 'TCS', 'TECHM', 'TITAN', 'TRENT', 'ULTRACEMCO', 'WIPRO'];
    const bn = ['HDFCBANK', 'ICICIBANK', 'SBIN', 'KOTAKBANK', 'AXISBANK', 'INDUSINDBK', 'BANKBARODA', 'PNB', 'FEDERALBNK', 'IDFCFIRSTB', 'BANDHANBNK', 'AUBANK'];
    const mc = ['ABBOTINDIA', 'ALKEM', 'AUROPHARMA', 'CANBK', 'COFORGE', 'COLPAL', 'CONCOR', 'CUMMINSIND', 'DELHIVERY', 'DIXON', 'FEDERALBNK', 'GODREJPROP', 'INDHOTEL', 'IRCTC', 'JSPL', 'JUBLFOOD', 'LINDEINDIA', 'LTIM', 'LUPIN', 'MAXHEALTH', 'OBEROIRLTY', 'PERSISTENT', 'PIIND', 'POLYCAB', 'VOLTAS'];
    const fn = ['HDFCBANK', 'ICICIBANK', 'SBIN', 'KOTAKBANK', 'AXISBANK', 'BAJFINANCE', 'BAJAJFINSV', 'HDFCLIFE', 'SBILIFE', 'ICICIPRULI', 'MUTHOOTFIN', 'CHOLAFIN', 'SHRIRAMFIN', 'MANAPPURAM', 'PFC', 'RECLTD', 'LICHSGFIN', 'MFSL', 'SBICARD', 'M&MFIN'];
    const mcx = ['GOLD', 'GOLDM', 'GOLDPETAL', 'GOLDGUINEA', 'SILVER', 'SILVERM', 'SILVERMICRO', 'CRUDEOIL', 'CRUDEOILM', 'NATURALGAS', 'NATGASMINI', 'COPPER', 'COPPERM', 'ZINC', 'ZINCMINI', 'LEAD', 'LEADMINI', 'NICKEL', 'NICKELMINI', 'ALUMINIUM', 'ALUMINI', 'MENTHAOIL', 'COTTON', 'COTTONCNDY'];
    const nfoIdx = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'];
    const crypto = [
        { symbol: 'BTC/USD', name: 'Bitcoin', category: 'crypto' },
        { symbol: 'ETH/USD', name: 'Ethereum', category: 'crypto' },
        { symbol: 'BNB/USD', name: 'BNB', category: 'crypto' },
        { symbol: 'SOL/USD', name: 'Solana', category: 'crypto' },
        { symbol: 'XRP/USD', name: 'Ripple', category: 'crypto' },
        { symbol: 'ADA/USD', name: 'Cardano', category: 'crypto' },
        { symbol: 'DOGE/USD', name: 'Dogecoin', category: 'crypto' },
        { symbol: 'DOT/USD', name: 'Polkadot', category: 'crypto' },
        { symbol: 'AVAX/USD', name: 'Avalanche', category: 'crypto' }
    ];
    const forex = [
        { symbol: 'USD/INR', name: 'USD/INR', category: 'forex' },
        { symbol: 'GBP/USD', name: 'GBP/USD', category: 'forex' },
        { symbol: 'USD/JPY', name: 'USD/JPY', category: 'forex' },
        { symbol: 'USD/CHF', name: 'USD/CHF', category: 'forex' },
        { symbol: 'AUD/CAD', name: 'AUD/CAD', category: 'forex' },
        { symbol: 'EUR/USD', name: 'EUR/USD', category: 'forex' }
    ];
    const nseInd = [
        { symbol: 'NIFTY 50', name: 'NIFTY 50' },
        { symbol: 'NIFTY BANK', name: 'NIFTY BANK' },
        { symbol: 'NIFTY FIN SERVICE', name: 'NIFTY FIN SERVICE' },
        { symbol: 'NIFTY MID SELECT', name: 'NIFTY MID SELECT' }
    ];

    await seedGroupItems('NIFTY 50', n50, 'NSE');
    await seedGroupItems('BANK NIFTY', bn, 'NSE');
    await seedGroupItems('MIDCAP SELECT', mc, 'NSE');
    await seedGroupItems('FIN NIFTY', fn, 'NSE');
    await seedGroupItems('MCX FUTURES', mcx, 'MCX');
    await seedGroupItems('NFO INDICES', nfoIdx, 'NFO');
    await seedGroupItems('CRYPTO', crypto, 'CRYPTO');
    await seedGroupItems('FOREX', forex, 'FOREX');
    await seedGroupItems('NSE INDICES', nseInd, 'NSE');

    // ─── 16. NEW CLIENT BANK SETTINGS ──────────────────────────────────────────

    await db.execute(`
        CREATE TABLE IF NOT EXISTS new_client_bank (
            id               INT AUTO_INCREMENT PRIMARY KEY,
            account_holder   VARCHAR(255) DEFAULT NULL,
            account_number   VARCHAR(255) DEFAULT NULL,
            bank_name        VARCHAR(255) DEFAULT NULL,
            ifsc             VARCHAR(255) DEFAULT NULL,
            phone_pe         VARCHAR(255) DEFAULT NULL,
            google_pay       VARCHAR(255) DEFAULT NULL,
            paytm            VARCHAR(255) DEFAULT NULL,
            upi_id           VARCHAR(255) DEFAULT NULL,
            updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // ─── 17. SCRIPT TESTING & COMMODITY LOT SIZES ─────────────────────────────

    await db.execute(`
        CREATE TABLE IF NOT EXISTS script_testing (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tradingsymbol VARCHAR(100) DEFAULT NULL,
            name VARCHAR(100) DEFAULT NULL,
            instrument_token INT DEFAULT NULL,
            instrument_type VARCHAR(20) DEFAULT NULL,
            exchange VARCHAR(20) DEFAULT NULL,
            expiry VARCHAR(50) DEFAULT NULL,
            lot_size INT DEFAULT 1,
            ltp DECIMAL(10,2) DEFAULT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS commodity_forex_crypto_lot_sizes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            symbol VARCHAR(100) NOT NULL UNIQUE,
            category VARCHAR(50) NOT NULL,
            lot_size DECIMAL(18,6) NOT NULL DEFAULT 1.000000,
            usdinr_value DECIMAL(18,6) NOT NULL DEFAULT 83.500000,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Seed/Update standard commodity lot sizes (e.g. COPPER = 2500, COPPERM = 250)
    const comexLotSizes = [
        { symbol: 'COPPER', category: 'COMMODITY', lot_size: 2500.0, usdinr_value: 94.53 },
        { symbol: 'COPPERM', category: 'COMMODITY', lot_size: 250.0, usdinr_value: 94.53 },
        { symbol: 'MCOPPER', category: 'COMMODITY', lot_size: 250.0, usdinr_value: 94.53 }
    ];

    for (const item of comexLotSizes) {
        await db.execute(`
            INSERT INTO commodity_forex_crypto_lot_sizes (symbol, category, lot_size, usdinr_value)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE lot_size = VALUES(lot_size)
        `, [item.symbol, item.category, item.lot_size, item.usdinr_value]);
    }

    // ─── PERFORMANCE INDEXES ───────────────────────────────────────────────────
    console.log('\n📊 Adding performance indexes...');

    // Users table indexes
    await addIndex('users', 'idx_users_parent_id', 'parent_id');
    await addIndex('users', 'idx_users_role', 'role');
    await addIndex('users', 'idx_users_status', 'status');
    await addIndex('users', 'idx_users_role_status', 'role, status');

    // Trades table indexes
    await addIndex('trades', 'idx_trades_user_id', 'user_id');
    await addIndex('trades', 'idx_trades_status', 'status');
    await addIndex('trades', 'idx_trades_entry_time', 'entry_time');
    await addIndex('trades', 'idx_trades_user_status', 'user_id, status');
    await addIndex('trades', 'idx_trades_symbol', 'symbol');
    await addIndex('trades', 'idx_trades_created_by', 'created_by');

    // Ledger table indexes
    await addIndex('ledger', 'idx_ledger_user_id', 'user_id');
    await addIndex('ledger', 'idx_ledger_created_at', 'created_at');
    await addIndex('ledger', 'idx_ledger_user_created', 'user_id, created_at');

    // Payment requests indexes
    await addIndex('payment_requests', 'idx_payment_user_id', 'user_id');
    await addIndex('payment_requests', 'idx_payment_status', 'status');
    await addIndex('payment_requests', 'idx_payment_created_at', 'created_at');

    // IP logs indexes
    await addIndex('ip_logs', 'idx_ip_logs_user_id', 'user_id');
    await addIndex('ip_logs', 'idx_ip_logs_ip_address', 'ip_address');

    // IP logins indexes
    await addIndex('ip_logins', 'idx_ip_logins_user_id', 'user_id');
    await addIndex('ip_logins', 'idx_ip_logins_timestamp', 'timestamp');

    // ─── ENSURE AUTO_INCREMENT ──────────────────────────────────────────────────
    console.log('\n🔧 Ensuring AUTO_INCREMENT on critical tables...');
    const criticalTables = [
        'users', 'ip_logins', 'trades', 'paper_positions', 'notifications',
        'paper_orders', 'paper_trades', 'ledger', 'payment_requests',
        'signals', 'action_ledger', 'scrip_data', 'support_tickets',
        'ticket_messages', 'voice_recordings', 'new_client_bank',
        'script_testing', 'commodity_forex_crypto_lot_sizes'
    ];

    try {
        const [tableInfos] = await db.execute(
            `SELECT TABLE_NAME, AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`
        );
        const autoIncMap = {};
        tableInfos.forEach(row => {
            autoIncMap[row.TABLE_NAME.toLowerCase()] = row.AUTO_INCREMENT;
        });

        for (const table of criticalTables) {
            try {
                const currentAutoInc = autoIncMap[table.toLowerCase()];
                if (currentAutoInc === null || currentAutoInc === undefined) {
                    // Check if table actually has an 'id' column
                    const [cols] = await db.execute(`SHOW COLUMNS FROM \`${table}\` LIKE 'id'`);
                    if (cols.length === 0) continue;

                    const [[maxRow]] = await db.execute(`SELECT MAX(id) as max_id FROM \`${table}\``);
                    const nextId = (maxRow?.max_id || 0) + 1;
                    await db.execute(`ALTER TABLE \`${table}\` MODIFY id INT AUTO_INCREMENT`);
                    await db.execute(`ALTER TABLE \`${table}\` AUTO_INCREMENT = ${nextId}`);
                    console.log(`  ✅ ${table}: AUTO_INCREMENT restored = ${nextId}`);
                }
            } catch (err) {
                // Table might not exist yet — silently skip
            }
        }
    } catch (err) {
        console.error('⚠️ Failed to check AUTO_INCREMENT status:', err.message);
    }

    console.log('✅ DB migrations complete\n');
};

module.exports = runMigrations;
