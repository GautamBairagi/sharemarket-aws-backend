const db = require('../src/config/db');
const bcrypt = require('bcryptjs');

async function createDebug() {
    try {
        const username = 'testuser123';
        const password = 'password123';
        const hashedPassword = await bcrypt.hash(password, 10);
        
        await db.execute(
            'INSERT INTO users (username, password, full_name, role, status) VALUES (?, ?, ?, ?, "Active")',
            [username, hashedPassword, 'Test User', 'SUPERADMIN']
        );
        console.log(`✅ Created ${username} with password ${password}`);
    } catch (err) {
        console.error('Error:', err.message);
    } finally {
        process.exit();
    }
}

createDebug();
