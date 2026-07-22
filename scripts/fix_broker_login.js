const db = require('../src/config/db');
const bcrypt = require('bcryptjs');

async function fixBroker() {
    try {
        console.log('--- FIXING BROKER LOGIN ---');
        const username = 'broker';
        const newPass = 'broker123';
        
        const [rows] = await db.execute('SELECT id, username FROM users WHERE username = ?', [username]);
        
        if (rows.length === 0) {
            console.log(`❌ User "${username}" not found!`);
            // List all brokers to see if names are different
            const [brokers] = await db.execute('SELECT username FROM users WHERE role = "BROKER"');
            console.log('Available brokers:', brokers.map(b => b.username).join(', '));
        } else {
            const user = rows[0];
            const hashed = await bcrypt.hash(newPass, 10);
            await db.execute('UPDATE users SET password = ? WHERE id = ?', [hashed, user.id]);
            console.log(`✅ Password for "${username}" reset to "${newPass}"`);
            
            // Also reset for 'subbroker' if it exists
            const [subrows] = await db.execute('SELECT id FROM users WHERE username = ?', ['subbroker']);
            if (subrows.length > 0) {
                await db.execute('UPDATE users SET password = ? WHERE id = ?', [hashed, subrows[0].id]);
                console.log(`✅ Password for "subbroker" reset to "${newPass}"`);
            }
        }
    } catch (err) {
        console.error('❌ Error:', err);
    } finally {
        process.exit();
    }
}

fixBroker();
