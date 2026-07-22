const db = require('../src/config/db');
const bcrypt = require('bcryptjs');

async function fixTrader01() {
    try {
        // 1. Find trader01
        const [rows] = await db.execute('SELECT id, username, role, status, password FROM users WHERE username = ?', ['trader01']);

        if (rows.length === 0) {
            console.log('❌ User "trader01" not found in database.');
            console.log('\n--- All users ---');
            const [all] = await db.execute('SELECT id, username, role, status FROM users');
            console.table(all);
            process.exit(1);
        }

        const user = rows[0];
        console.log(`✅ Found user: ${user.username} | Role: ${user.role} | Status: ${user.status}`);

        // 2. Check current KYC status
        const [kycRows] = await db.execute('SELECT * FROM user_documents WHERE user_id = ?', [user.id]);
        if (kycRows.length > 0) {
            console.log(`📋 Current KYC status: ${kycRows[0].kyc_status}`);
        } else {
            console.log('📋 No KYC record found.');
        }

        // 3. Fix KYC — set to VERIFIED
        await db.execute(
            'INSERT INTO user_documents (user_id, kyc_status) VALUES (?, ?) ON DUPLICATE KEY UPDATE kyc_status = ?',
            [user.id, 'VERIFIED', 'VERIFIED']
        );
        console.log('✅ KYC status set to VERIFIED');

        // 4. Reset password to "trader123"
        const newPassword = 'trader123';
        const hashed = await bcrypt.hash(newPassword, 10);
        await db.execute('UPDATE users SET password = ? WHERE id = ?', [hashed, user.id]);
        console.log(`✅ Password reset to: ${newPassword}`);

        console.log('\n🎉 Done! You can now login with:');
        console.log(`   Username: trader01`);
        console.log(`   Password: trader123`);

    } catch (err) {
        console.error('❌ Error:', err.message);
    } finally {
        process.exit();
    }
}

fixTrader01();
