const db = require('../src/config/db');

/**
 * Check and display current hierarchy
 */
const checkHierarchy = async () => {
    try {
        console.log('📊 Checking current user hierarchy...\n');

        const [allUsers] = await db.execute('SELECT id, username, role, parent_id FROM users ORDER BY role, id');

        if (allUsers.length === 0) {
            console.log('❌ No users found');
            process.exit();
            return;
        }

        // Group by role
        const usersByRole = {};
        allUsers.forEach(u => {
            if (!usersByRole[u.role]) usersByRole[u.role] = [];
            usersByRole[u.role].push(u);
        });

        // Display each role
        for (const [role, users] of Object.entries(usersByRole)) {
            console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
            console.log(`📌 ${role} (${users.length} users)`);
            console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

            for (const user of users) {
                const parentInfo = user.parent_id === null ? 'NULL (root)' : user.parent_id;
                console.log(`  ID: ${user.id.toString().padEnd(3)} | ${user.username.padEnd(15)} | parent_id: ${parentInfo}`);
            }
        }

        // Show who can see what
        console.log(`\n\n🔍 VISIBILITY ANALYSIS:`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

        for (const [role, users] of Object.entries(usersByRole)) {
            for (const user of users) {
                // Find all users where parent_id = this user's id
                const children = allUsers.filter(u => u.parent_id === user.id);
                if (children.length > 0) {
                    console.log(`\n${user.username} (${role}, id: ${user.id}) sees ${children.length} user(s):`);
                    children.forEach(c => {
                        console.log(`  - ${c.username} (${c.role})`);
                    });
                }
            }
        }

        console.log('\n');
    } catch (err) {
        console.error('❌ Error:', err.message);
    } finally {
        process.exit();
    }
};

checkHierarchy();
