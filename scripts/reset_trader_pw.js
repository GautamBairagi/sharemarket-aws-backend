const db = require('./src/config/db');
const bcrypt = require('bcryptjs');

async function resetPassword() {
    try {
        const hashedPassword = await bcrypt.hash('trader123', 10);
        await db.execute('UPDATE users SET password = ? WHERE username = ?', [hashedPassword, 'trader']);
        console.log('Password for user "trader" reset to "trader123" successfully.');
    } catch (err) {
        console.error('Error resetting password:', err);
    } finally {
        process.exit();
    }
}

resetPassword();
