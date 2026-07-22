/**
 * CLEANUP SCRIPT
 * - Drops ALL tables that are NOT used by the trading app
 * - Truncates all trading app tables EXCEPT users
 * - Keeps only the 27 tables defined in migrate.js
 *
 * Run once:  node src/config/cleanup.js
 */

const db = require('./db');

const run = async () => {
    console.log('Starting database cleanup...\n');

    // These are the ONLY 27 tables our trading app uses (from migrate.js)
    const KEEP_TABLES = [
        'users',
        'user_documents',
        'client_settings',
        'broker_shares',
        'user_segments',
        'admin_menu_permissions',
        'admin_panel_settings',
        'trades',
        'ledger',
        'weekly_balances',
        'payment_requests',
        'ip_logins',
        'ip_logs',
        'signals',
        'action_ledger',
        'scrip_data',
        'tickers',
        'support_tickets',
        'internal_transfers',
        'notifications',
        'notification_reads',
        'voice_recordings',
        'user_kite_sessions',
        'paper_orders',
        'paper_trades',
        'paper_positions',
        'paper_holdings',
        'paper_gtt_triggers',
    ];

    try {
        await db.execute('SET FOREIGN_KEY_CHECKS = 0');

        // 1. Get ALL tables in the database
        const [allTables] = await db.execute('SHOW TABLES');
        const dbName = Object.keys(allTables[0])[0]; // column name like "Tables_in_traderdb"
        const tableNames = allTables.map(row => row[dbName]);

        console.log(`Found ${tableNames.length} tables in database.\n`);

        // 2. DROP every table that is NOT in our keep list
        const toDrop = tableNames.filter(t => !KEEP_TABLES.includes(t));
        console.log(`--- DROPPING ${toDrop.length} unused tables ---`);
        for (const t of toDrop) {
            try {
                await db.execute(`DROP TABLE \`${t}\``);
                console.log(`  Dropped: ${t}`);
            } catch (e) {
                console.log(`  Skip drop ${t}: ${e.message}`);
            }
        }

        // 3. TRUNCATE all kept tables EXCEPT users (keep user data)
        const toTruncate = KEEP_TABLES.filter(t => t !== 'users');
        console.log(`\n--- TRUNCATING ${toTruncate.length} tables (clearing data) ---`);
        for (const t of toTruncate) {
            try {
                await db.execute(`TRUNCATE TABLE \`${t}\``);
                console.log(`  Cleared: ${t}`);
            } catch (e) {
                console.log(`  Skip ${t}: ${e.message}`);
            }
        }

        await db.execute('SET FOREIGN_KEY_CHECKS = 1');

        const remaining = KEEP_TABLES.length;
        console.log(`\nCleanup complete!`);
        console.log(`Dropped: ${toDrop.length} tables | Kept: ${remaining} tables`);
        console.log(`Users table data: PRESERVED`);
        console.log(`All other tables: DATA CLEARED`);
        console.log(`\nRestart backend so migrations re-seed required rows.`);

    } catch (err) {
        console.error('Cleanup failed:', err.message);
    }

    process.exit(0);
};

run();
