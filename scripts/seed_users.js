const db = require('../src/config/db');

const seedUsers = async () => {
    try {
        console.log('🌱 Seeding dummy users with multi-level hierarchy...');

        const hash = '$2a$10$mC7G5YvJ8H.4pX.L3.zFe.6D9f1v8Z7J8J8J8J8J8J8J8J8J8J8J8';

        // 1. Create SUPERADMIN (no parent)
        try {
            await db.execute(
                'INSERT INTO users (username, password, full_name, role, parent_id, status) VALUES (?, ?, ?, ?, NULL, "Active")',
                ['superadmin', hash, 'Super Admin User', 'SUPERADMIN']
            );
            console.log(`✅ Created: superadmin (SUPERADMIN) - parent_id: NULL`);
        } catch (err) {
            if (err.code !== 'ER_DUP_ENTRY') throw err;
            console.log(`⚠️  User superadmin already exists.`);
        }

        // Get SUPERADMIN id
        const [superAdminResult] = await db.execute('SELECT id FROM users WHERE username = ? LIMIT 1', ['superadmin']);
        const superAdminId = superAdminResult[0]?.id;

        if (!superAdminId) {
            console.error('❌ SUPERADMIN not found!');
            process.exit();
            return;
        }

        // 2. Create ADMIN as direct child of SUPERADMIN
        try {
            await db.execute(
                'INSERT INTO users (username, password, full_name, role, parent_id, status) VALUES (?, ?, ?, ?, ?, "Active")',
                ['admin', hash, 'Project Admin', 'ADMIN', superAdminId]
            );
            console.log(`✅ Created: admin (ADMIN) - parent_id: ${superAdminId} (SUPERADMIN)`);
        } catch (err) {
            if (err.code !== 'ER_DUP_ENTRY') throw err;
            console.log(`⚠️  User admin already exists.`);
        }

        // 3. Create BROKER as direct child of SUPERADMIN (not ADMIN)
        try {
            await db.execute(
                'INSERT INTO users (username, password, full_name, role, parent_id, status) VALUES (?, ?, ?, ?, ?, "Active")',
                ['broker', hash, 'Main Broker', 'BROKER', superAdminId]
            );
            console.log(`✅ Created: broker (BROKER) - parent_id: ${superAdminId} (SUPERADMIN)`);
        } catch (err) {
            if (err.code !== 'ER_DUP_ENTRY') throw err;
            console.log(`⚠️  User broker already exists.`);
        }

        // Get ADMIN id
        const [adminResult] = await db.execute('SELECT id FROM users WHERE username = ? LIMIT 1', ['admin']);
        const adminId = adminResult[0]?.id;

        // 4. Create TRADER as child of BROKER
        if (adminId) {
            try {
                await db.execute(
                    'INSERT INTO users (username, password, full_name, role, parent_id, status) VALUES (?, ?, ?, ?, ?, "Active")',
                    ['trader', hash, 'Test Trader', 'TRADER', adminId]
                );
                console.log(`✅ Created: trader (TRADER) - parent_id: ${adminId} (ADMIN)`);
            } catch (err) {
                if (err.code !== 'ER_DUP_ENTRY') throw err;
                console.log(`⚠️  User trader already exists.`);
            }
        }

        console.log('\n✨ Seeding complete with hierarchy:');
        console.log(`SUPERADMIN (${superAdminId})`);
        console.log(`├── ADMIN (${adminId})`);
        console.log(`│   └── TRADER (can create)`);
        console.log(`└── BROKER (can create)`);
        console.log(`    └── TRADER (clients)`);
    } catch (err) {
        console.error('❌ Seeding failed:', err.message);
    } finally {
        process.exit();
    }
};

seedUsers();
