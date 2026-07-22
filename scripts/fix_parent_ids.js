const db = require('../src/config/db');

/**
 * Fix parent_id for existing users to establish proper multi-level hierarchy:
 * - SUPERADMIN: parent_id = NULL
 * - ADMIN: parent_id = first SUPERADMIN
 * - BROKER: parent_id = first SUPERADMIN (direct child, not through ADMIN)
 * - TRADER: parent_id = first ADMIN or BROKER (whoever created them)
 */
const fixParentIds = async () => {
    try {
        console.log('🔧 Fixing parent_id hierarchy...');

        // Get all users
        const [allUsers] = await db.execute('SELECT id, username, role FROM users ORDER BY id');

        if (allUsers.length === 0) {
            console.log('⚠️  No users found. Run seed_users.js first.');
            process.exit();
            return;
        }

        const usersByRole = {
            SUPERADMIN: [],
            ADMIN: [],
            BROKER: [],
            TRADER: []
        };

        // Categorize users by role
        allUsers.forEach(u => {
            if (usersByRole[u.role]) {
                usersByRole[u.role].push(u);
            }
        });

        // 1. Set SUPERADMIN parent_id to NULL
        for (const user of usersByRole.SUPERADMIN) {
            await db.execute('UPDATE users SET parent_id = NULL WHERE id = ?', [user.id]);
            console.log(`✅ SUPERADMIN: ${user.username} (${user.id}) - parent_id = NULL`);
        }

        // 2. Set ADMIN and BROKER parent_id to first SUPERADMIN (multi-level)
        if (usersByRole.SUPERADMIN.length > 0) {
            const superAdminId = usersByRole.SUPERADMIN[0].id;

            for (const user of usersByRole.ADMIN) {
                await db.execute('UPDATE users SET parent_id = ? WHERE id = ?', [superAdminId, user.id]);
                console.log(`✅ ADMIN: ${user.username} (${user.id}) - parent_id = ${superAdminId} (SUPERADMIN)`);
            }

            for (const user of usersByRole.BROKER) {
                await db.execute('UPDATE users SET parent_id = ? WHERE id = ?', [superAdminId, user.id]);
                console.log(`✅ BROKER: ${user.username} (${user.id}) - parent_id = ${superAdminId} (SUPERADMIN)`);
            }
        }

        // 3. Set TRADER parent_id based on who has permission to create them
        // TRADER with no parent (NULL) → assign to first SUPERADMIN or ADMIN
        if (usersByRole.SUPERADMIN.length > 0 || usersByRole.ADMIN.length > 0) {
            // Get TRADER with NULL parent_id
            const [tradersWithoutParent] = await db.execute(
                'SELECT id, username FROM users WHERE role = ? AND parent_id IS NULL',
                ['TRADER']
            );

            if (tradersWithoutParent.length > 0) {
                // Assign to first SUPERADMIN if exists, otherwise to first ADMIN
                const parentId = usersByRole.SUPERADMIN.length > 0
                    ? usersByRole.SUPERADMIN[0].id
                    : (usersByRole.ADMIN.length > 0 ? usersByRole.ADMIN[0].id : null);

                if (parentId) {
                    for (const user of tradersWithoutParent) {
                        await db.execute('UPDATE users SET parent_id = ? WHERE id = ?', [parentId, user.id]);
                        const parentRole = usersByRole.SUPERADMIN.length > 0 ? 'SUPERADMIN' : 'ADMIN';
                        console.log(`✅ TRADER: ${user.username} (${user.id}) - parent_id = ${parentId} (${parentRole})`);
                    }
                }
            }

            // TRADER with existing parent_id → leave as is (they were already assigned)
            const [tradersWithParent] = await db.execute(
                'SELECT id, username, parent_id FROM users WHERE role = ? AND parent_id IS NOT NULL',
                ['TRADER']
            );

            if (tradersWithParent.length > 0) {
                console.log(`ℹ️  Keeping ${tradersWithParent.length} TRADER with existing parent_id`);
            }
        }

        console.log('\n✨ Parent IDs fixed successfully!');
        console.log('\n📊 Multi-level Hierarchy:');
        console.log(`SUPERADMIN (parent_id: NULL) → creates ADMIN, BROKER, TRADER`);
        console.log(`├── ADMIN (parent_id: SUPERADMIN) → creates BROKER, TRADER`);
        console.log(`└── BROKER (parent_id: SUPERADMIN) → manages assigned TRADER clients`);
    } catch (err) {
        console.error('❌ Error fixing parent IDs:', err.message);
    } finally {
        process.exit();
    }
};

fixParentIds();
