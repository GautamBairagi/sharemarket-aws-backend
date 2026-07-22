const mysql = require('mysql2/promise');
require('dotenv').config();

async function checkAdminLogos() {
  const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'traderdb',
    port: parseInt(process.env.DB_PORT || '3306')
  };

  try {
    const connection = await mysql.createConnection(dbConfig);
    
    // Check admin_panel_settings table
    console.log('\n=== Checking admin_panel_settings table ===');
    const [settings] = await connection.execute(`
      SELECT user_id, logo_path, profile_image_path, theme_json FROM admin_panel_settings
    `);
    
    console.log('Admin Panel Settings:');
    console.log(JSON.stringify(settings, null, 2));
    
    // Get all ADMIN users
    console.log('\n=== All ADMIN users ===');
    const [admins] = await connection.execute(`
      SELECT id, username, full_name FROM users WHERE role = 'ADMIN'
    `);
    
    console.log(JSON.stringify(admins, null, 2));
    
    // Check which admins have logos
    console.log('\n=== Admin Logo Status ===');
    for (const admin of admins) {
      const settings = settings.find(s => s.user_id === admin.id);
      const logoStatus = settings?.logo_path ? '✅ Has logo' : '❌ No logo';
      console.log(`${admin.username} (ID: ${admin.id}): ${logoStatus}`);
      if (settings?.logo_path) {
        console.log(`  Path: ${settings.logo_path}`);
      }
    }
    
    await connection.end();
  } catch (err) {
    console.error('Error:', err.message);
  }
}

checkAdminLogos();
