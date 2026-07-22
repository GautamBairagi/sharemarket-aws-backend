const db = require('../src/config/db');

async function fixAllKyc() {
    try {
        // Fix all traders who don't have VERIFIED KYC
        const [result] = await db.execute(`
            INSERT INTO user_documents (user_id, kyc_status)
            SELECT id, 'VERIFIED' FROM users WHERE role = 'TRADER'
            ON DUPLICATE KEY UPDATE kyc_status = 'VERIFIED'
        `);
        console.log(`✅ Fixed KYC for all traders (${result.affectedRows} rows affected)`);

        // Show current status
        const [rows] = await db.execute(`
            SELECT u.id, u.username, u.full_name, u.role, ud.kyc_status
            FROM users u
            LEFT JOIN user_documents ud ON u.id = ud.user_id
            WHERE u.role = 'TRADER'
        `);
        console.table(rows);
    } catch (err) {
        console.error('❌ Error:', err.message);
    } finally {
        process.exit();
    }
}

fixAllKyc();
