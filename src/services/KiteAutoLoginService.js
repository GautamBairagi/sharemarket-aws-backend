const puppeteer = require('puppeteer');
const otplib = require('otplib');
const kiteService = require('../utils/kiteService');
const kiteAuthService = require('./KiteAuthService');
require('dotenv').config();

class KiteAutoLoginService {

    /**
     * Helper to generate 6-digit TOTP code across different otplib API versions
     */
    generateTotp(secretKey) {
        if (!secretKey) throw new Error('TOTP secret key is required');
        const cleanSecret = secretKey.replace(/\s+/g, '').toUpperCase();

        // 1. Try otplib.generateSync (otplib v13+)
        if (typeof otplib.generateSync === 'function') {
            return otplib.generateSync({ secret: cleanSecret });
        }
        // 2. Try otplib.authenticator.generate
        if (otplib.authenticator && typeof otplib.authenticator.generate === 'function') {
            return otplib.authenticator.generate(cleanSecret);
        }
        // 3. Try otplib.generate
        if (typeof otplib.generate === 'function') {
            return otplib.generate({ secret: cleanSecret });
        }
        // 4. Try otplib.totp.generate
        if (otplib.totp && typeof otplib.totp.generate === 'function') {
            return otplib.totp.generate(cleanSecret);
        }

        throw new Error('Could not generate TOTP code from otplib');
    }

    /**
     * Executes automated login to Zerodha Kite Connect using Puppeteer & TOTP.
     * @param {Object} customCreds Optional custom credentials
     * @returns {Promise<{success: boolean, message: string, session?: Object}>}
     */
    async autoLogin(customCreds = {}) {
        const apiKey = (process.env.KITE_API_KEY || '').trim();
        const userId = customCreds.userId || (process.env.ZERODHA_USER_ID || '').trim();
        const password = customCreds.password || (process.env.ZERODHA_PASSWORD || '').trim();
        const totpSecret = customCreds.totpSecret || (process.env.ZERODHA_TOTP_SECRET || '').trim();

        if (!apiKey) {
            throw new Error('KITE_API_KEY is not set in environment');
        }
        if (!userId || !password || !totpSecret) {
            throw new Error('Zerodha credentials (ZERODHA_USER_ID, ZERODHA_PASSWORD, ZERODHA_TOTP_SECRET) are missing');
        }

        console.log(`[KiteAutoLogin] Starting automated login for Zerodha User: ${userId}...`);

        let browser = null;
        let capturedRequestToken = null;

        try {
            const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

            browser = await puppeteer.launch({
                headless: 'new',
                executablePath,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu',
                    '--single-process',
                    '--ignore-certificate-errors'
                ]
            });

            const page = await browser.newPage();

            // Intercept redirect request to capture request_token BEFORE remote server consumes it
            await page.setRequestInterception(true);
            page.on('request', (request) => {
                const reqUrl = request.url();
                if (reqUrl.includes('request_token=') && !capturedRequestToken) {
                    try {
                        const urlObj = new URL(reqUrl);
                        const token = urlObj.searchParams.get('request_token');
                        if (token) {
                            capturedRequestToken = token;
                            console.log(`[KiteAutoLogin] 🎯 Intercepted request_token: ${token.substring(0, 8)}... (Aborting redirect to prevent duplicate consumption)`);
                            request.abort();
                            return;
                        }
                    } catch (_) {}
                }
                request.continue().catch(() => {});
            });

            // Set standard user agent
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

            const loginUrl = `https://kite.trade/connect/login?api_key=${apiKey}&v=3`;
            console.log(`[KiteAutoLogin] Navigating to login URL...`);
            await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 30000 });

            // 1. Enter User ID & Password
            await page.waitForSelector('input[type="text"]', { timeout: 10000 });
            await page.type('input[type="text"]', userId, { delay: 30 });

            await page.waitForSelector('input[type="password"]', { timeout: 10000 });
            await page.type('input[type="password"]', password, { delay: 30 });

            console.log(`[KiteAutoLogin] Submitting User ID & Password...`);
            await page.click('button[type="submit"]').catch(() => page.keyboard.press('Enter'));

            // 2. Wait for navigation/2FA page load
            await new Promise(r => setTimeout(r, 2500));

            // 3. Generate 6-digit TOTP
            const totpCode = this.generateTotp(totpSecret);
            console.log(`[KiteAutoLogin] Generated 6-digit TOTP code: ${totpCode}`);

            // 4. Enter TOTP directly using page.type on selector
            const totpSelector = 'input[type="text"], input[type="number"]';
            await page.waitForSelector(totpSelector, { timeout: 15000 });
            await page.focus(totpSelector).catch(() => {});
            await page.type(totpSelector, String(totpCode), { delay: 50 });

            console.log(`[KiteAutoLogin] Submitting TOTP...`);
            await page.click('button[type="submit"]').catch(() => page.keyboard.press('Enter'));

            // Wait for redirect to occur and capture request_token
            for (let i = 0; i < 30; i++) {
                if (capturedRequestToken) break;
                await new Promise(r => setTimeout(r, 200));
            }

            if (!capturedRequestToken) {
                const currentUrl = page.url();
                if (currentUrl.includes('request_token=')) {
                    const urlObj = new URL(currentUrl);
                    capturedRequestToken = urlObj.searchParams.get('request_token');
                }
            }

            if (!capturedRequestToken) {
                throw new Error(`Failed to capture request_token. Final URL: ${page.url()}`);
            }

            console.log(`[KiteAutoLogin] Processing captured request_token: ${capturedRequestToken.substring(0, 8)}...`);

            // 5. Exchange request_token for access_token via Kite API
            const session = await kiteService.handleCallback(capturedRequestToken);
            console.log(`[KiteAutoLogin] 🎉 Session created successfully! User: ${session.user_name || session.user_id}`);

            // Save to DB (default to User ID 1 if not specified)
            const targetUserId = customCreds.userId || 1;
            try {
                await kiteAuthService.saveTokenToDB(targetUserId, session.access_token, session);
                console.log(`[KiteAutoLogin] 💾 Session saved to DB for User ID ${targetUserId}`);
            } catch (dbErr) {
                console.error('[KiteAutoLogin] DB session save failed:', dbErr.message);
            }

            // Immediately re-initialize real-time market data socket feeds & WebSocket ticker
            try {
                const marketDataService = require('./MarketDataService');
                marketDataService.init(customCreds.userId || null).catch(() => {});
            } catch (_) {}

            return {
                success: true,
                message: 'Zerodha automated login successful',
                session
            };

        } catch (err) {
            console.error(`[KiteAutoLogin] Automated login failed:`, err.message);
            throw err;
        } finally {
            if (browser) {
                await browser.close().catch(() => {});
            }
        }
    }
}

module.exports = new KiteAutoLoginService();
