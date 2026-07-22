const db = require('../src/config/db');
const bcrypt = require('bcryptjs');

const fixPasswords = async () => {
    try {
        console.log('🔄 Fixing user passwords...');
        const hashedPassword = await bcrypt.hash('admin123', 10);
        console.log('✅ Generated Hash for "admin123":', hashedPassword);

        const users = ['superadmin', 'admin', 'broker', 'trader'];
        
        for (const username of users) {
            await db.execute(
                'UPDATE users SET password = ? WHERE username = ?',
                [hashedPassword, username]
            );
            console.log(`✅ Updated password for: ${username}`);
        }

        console.log('✨ All passwords fixed!');
    } catch (err) {
        console.error('❌ Failed to fix passwords:', err.message);
    } finally {
        process.exit();
    }
};

fixPasswords();
