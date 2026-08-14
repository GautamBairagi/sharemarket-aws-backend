/**
 * Test Script for Zerodha Automated Login via Puppeteer & TOTP
 * Run command: node scripts/test_auto_login.js
 */
const kiteAutoLoginService = require('../src/services/KiteAutoLoginService');

async function testAutoLogin() {
    console.log('🧪 Starting Zerodha Auto-Login Test...');
    try {
        const result = await kiteAutoLoginService.autoLogin();
        console.log('🎉 SUCCESS! Result:', JSON.stringify(result, null, 2));
    } catch (err) {
        console.error('❌ FAILURE! Error:', err.message);
        console.log('\n💡 Tip: Make sure ZERODHA_USER_ID, ZERODHA_PASSWORD, and ZERODHA_TOTP_SECRET are set in .env');
    }
}

testAutoLogin();
