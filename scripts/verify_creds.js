const db = require('../src/config/db');
const bcrypt = require('bcryptjs');

async function checkUsers() {
    try {
        const usernames = ['superadmin', 'admin', 'broker', 'trader'];
        console.log('--- PASSWORD VERIFICATION REPORT ---');
        for (const username of usernames) {
            const [rows] = await db.execute('SELECT * FROM users WHERE username = ?', [username]);
            if (rows.length === 0) {
                console.log(`[NOT FOUND] ${username}`);
            } else {
                const user = rows[0];
                const isMatchAdmin = await bcrypt.compare('admin123', user.password);
                const isMatchTrader = await bcrypt.compare('trader123', user.password);
                const isMatchSuper = await bcrypt.compare('superadmin123', user.password);
                const isMatchBroker = await bcrypt.compare('broker123', user.password);
                const isMatchDefault = await bcrypt.compare('123456', user.password);
                
                console.log(`User: ${username.padEnd(12)} | Role: ${user.role.padEnd(12)} | admin123: ${isMatchAdmin} | trader123: ${isMatchTrader} | superadmin123: ${isMatchSuper} | broker123: ${isMatchBroker} | 123456: ${isMatchDefault}`);
            }
        }
    } catch (err) {
        console.error('Error:', err);
    } finally {
        process.exit();
    }
}

checkUsers();
