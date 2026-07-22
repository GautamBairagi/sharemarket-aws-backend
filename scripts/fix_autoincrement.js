/**
 * FIX AUTO_INCREMENT issue on live database
 * Run this ONCE when you get "Field 'id' doesn't have a default value" error
 *
 * Command: node fix_autoincrement.js
 */

const db = require('./src/config/db');

const fixAutoIncrement = async () => {
    console.log('🔧 Fixing AUTO_INCREMENT for tables...\n');

    const tables = [
        'users',
        'ip_logins',
        'user_documents',
        'trades',
        'positions',
        'wallets',
        'transactions',
        'notifications',
        'notification_reads',
        'action_logs',
        'broker_accounts',
        'client_settings',
        'funds',
        'withdrawal_requests',
        'deposit_requests',
    ];

    for (const table of tables) {
        try {
            // Get current AUTO_INCREMENT value
            const [[info]] = await db.execute(
                `SELECT AUTO_INCREMENT FROM information_schema.TABLES
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
                [table]
            );

            if (!info || !info.AUTO_INCREMENT) {
                console.log(`⚠️  ${table}: No AUTO_INCREMENT found, attempting to fix...`);
                // Try to get max id and set AUTO_INCREMENT
                const [[maxRow]] = await db.execute(`SELECT MAX(id) as max_id FROM \`${table}\``);
                const nextId = (maxRow?.max_id || 0) + 1;

                await db.execute(`ALTER TABLE \`${table}\` MODIFY id INT AUTO_INCREMENT`);
                await db.execute(`ALTER TABLE \`${table}\` AUTO_INCREMENT = ${nextId}`);
                console.log(`✅ ${table}: Fixed AUTO_INCREMENT = ${nextId}`);
            } else {
                console.log(`✅ ${table}: AUTO_INCREMENT = ${info.AUTO_INCREMENT}`);
            }
        } catch (err) {
            console.log(`⏭️  ${table}: ${err.message}`);
        }
    }

    console.log('\n✨ AUTO_INCREMENT fix completed!');
    process.exit(0);
};

fixAutoIncrement().catch(err => {
    console.error('❌ Error:', err);
    process.exit(1);
});
