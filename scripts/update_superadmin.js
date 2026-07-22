const db = require('./src/config/db');
const bcrypt = require('bcryptjs');

const updateSuperAdmin = async () => {
    try {
        console.log('🔄 Updating Superadmin password...');
        const hashedPassword = await bcrypt.hash('superadmin123', 10);
        
        await db.execute(
            'UPDATE users SET password = ? WHERE username = "superadmin"',
            [hashedPassword]
        );
        
        console.log('✅ Superadmin password set to: superadmin123');
    } catch (err) {
        console.error('❌ Failed to update password:', err.message);
    } finally {
        process.exit();
    }
};

updateSuperAdmin();
