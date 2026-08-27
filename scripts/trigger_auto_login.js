/**
 * CLI Trigger Script for Zerodha Auto-Login
 * Can be run manually or added to Linux OS crontab:
 * 30 8 * * 1-5 /usr/bin/node /path/to/sharemarket-aws-backend/scripts/trigger_auto_login.js >> /var/log/zerodha_autologin.log 2>&1
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const kiteAutoLoginService = require('../src/services/KiteAutoLoginService');

async function run() {
    console.log(`⏰ [CLI Trigger] Starting Zerodha Auto-Login at ${new Date().toISOString()}...`);
    try {
        const result = await kiteAutoLoginService.autoLogin();
        console.log('✅ [CLI Trigger] Success:', JSON.stringify(result.session ? { user: result.session.user_name, access_token: result.session.access_token?.substring(0, 8) + '...' } : result));
        process.exit(0);
    } catch (err) {
        console.error('❌ [CLI Trigger] Failed:', err.message);
        process.exit(1);
    }
}

run();
