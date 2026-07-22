const mysql = require('mysql2/promise');
require('dotenv').config();

async function checkNewClient() {
  const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'traderdb',
    port: parseInt(process.env.DB_PORT || '3306')
  };

  try {
    const connection = await mysql.createConnection(dbConfig);
    
    // Get all TRADERS with their parent info
    const [traders] = await connection.execute(`
      SELECT u.id, u.username, u.role, u.parent_id, p.username as parent_username, u.created_at
      FROM users u
      LEFT JOIN users p ON u.parent_id = p.id
      WHERE u.role = 'TRADER'
      ORDER BY u.created_at DESC
      LIMIT 10
    `);
    
    console.log('\n=== ALL TRADERS (Latest First) ===');
    console.log(JSON.stringify(traders, null, 2));
    
    // Get SUPERADMIN info
    const [superAdmins] = await connection.execute('SELECT id, username FROM users WHERE role = "SUPERADMIN"');
    console.log('\n=== SUPERADMIN ===');
    console.log(JSON.stringify(superAdmins, null, 2));
    
    if (superAdmins.length > 0) {
      const superAdminId = superAdmins[0].id;
      const [myclients] = await connection.execute(
        'SELECT id, username, parent_id FROM users WHERE role = "TRADER" AND parent_id = ?',
        [superAdminId]
      );
      console.log(`\nClients with parent_id=${superAdminId} (SUPERADMIN's clients):`);
      console.log(JSON.stringify(myclients, null, 2));
    }
    
    await connection.end();
  } catch (err) {
    console.error('Error:', err.message);
  }
}

checkNewClient();
  // test this