const db = require('../src/config/db');
const bcrypt = require('bcryptjs');

const fixPasswords = async () => {
    try {
        console.log('🔄 Resetting all user passwords to "123456"...');
        const hashedPassword = await bcrypt.hash('123456', 10);
        
        const users = ['superadmin', 'admin', 'broker', 'trader', 'demo_user'];
        
        for (const username of users) {
            await db.execute(
                'UPDATE users SET password = ? WHERE username = ?',
                [hashedPassword, username]
            );
            console.log(`✅ Reset password for: ${username}`);
        }

        console.log('✨ Success! All accounts now use: 123456');
    } catch (err) {
        console.error('❌ Failed:', err.message);
    } finally {
        process.exit();
    }
};

fixPasswords();
