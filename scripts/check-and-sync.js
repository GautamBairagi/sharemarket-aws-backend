const kiteService = require('../src/utils/kiteService');
const { execSync } = require('child_process');
const path = require('path');
require('dotenv').config();

console.log('\n🔍 Checking Zerodha Connection...\n');

const status = kiteService.getStatus();
console.log('Zerodha Status:');
console.log(`   Connected: ${status.connected ? '✅ YES' : '❌ NO'}`);
console.log(`   User: ${status.user || 'Not logged in'}`);
console.log(`   API Key: ${status.api_key || 'Not set'}\n`);

if (!status.connected) {
    console.log('⚠️  Zerodha not connected!\n');
    console.log('📋 To authenticate Zerodha:\n');
    console.log('Option 1: Web Login');
    console.log('   1. Start the trading backend: npm start');
    console.log('   2. Go to: http://localhost:5000/api/kite/login');
    console.log('   3. Login with Zerodha account');
    console.log('   4. You\'ll be redirected with access token\n');

    console.log('Option 2: Manual Token (if you have access_token):');
    console.log('   1. Set KITE_ACCESS_TOKEN in .env file');
    console.log('   2. Restart backend\n');

    console.log('Option 3: Test with mock data (for development):');
    console.log('   - Database already has previous sync data\n');

    process.exit(0);
}

console.log('✅ Zerodha Connected!\n');
console.log('🚀 Starting full sync to database...\n');

try {
    // Run the sync script
    execSync('node ' + path.join(__dirname, 'sync-all-available.js'), {
        stdio: 'inherit',
        cwd: __dirname + '/..'
    });
} catch (err) {
    console.error('Sync failed:', err.message);
    process.exit(1);
}
