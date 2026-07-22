const db = require('./src/config/db');
const bcrypt = require('bcryptjs');

async function checkUser() {
    try {
        const [rows] = await db.execute('SELECT * FROM users WHERE username = ?', ['trader']);
        if (rows.length === 0) {
            console.log('User "trader" NOT FOUND in database.');
            const [all] = await db.execute('SELECT username FROM users LIMIT 10');
            console.log('Available usernames:', all.map(u => u.username));
        } else {
            const user = rows[0];
            console.log('User found:', { id: user.id, username: user.username, role: user.role });
            // Let's check if 'trader123' matches
            const isMatch = await bcrypt.compare('trader123', user.password);
            console.log('Does "trader123" match?', isMatch);
        }
    } catch (err) {
        console.error('Error:', err);
    } finally {
        process.exit();
    }
}

checkUser();
