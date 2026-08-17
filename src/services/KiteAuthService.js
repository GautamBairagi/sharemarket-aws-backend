const { KiteConnect } = require('kiteconnect');
const kiteRepo = require('../repositories/KiteRepository');
const crypto = require('crypto');

// Access keys from process.env (loaded by server.js)
const API_KEY = process.env.KITE_API_KEY;
const API_SECRET = process.env.KITE_API_SECRET;

// Server runs in IST (TZ=Asia/Kolkata), so new Date() gives IST directly
function getIstDateStr(dateLike = new Date()) {
    if (!dateLike) return '';
    try {
        return new Date(dateLike).toLocaleDateString('en-IN');
    } catch (_) {
        return new Date(dateLike).toDateString();
    }
}

/**
 * Service to handle Zerodha Kite Authentication (per user).
 */
class KiteAuthService {
    
    getLoginURL() {
        if (!API_KEY) throw new Error('KITE_API_KEY not set in .env');
        return `https://kite.trade/connect/login?api_key=${API_KEY}&v=3`;
    }

    async handleCallback(userId, requestToken) {
        if (!requestToken) throw new Error('request_token is required');
        
        const kite = new KiteConnect({ api_key: API_KEY });
        
        try {
            const checksum = crypto.createHash('sha256')
                .update(API_KEY + requestToken + API_SECRET)
                .digest('hex');

            const response = await kite.generateSession(requestToken, API_SECRET);
            
            // Save to DB
            await kiteRepo.saveSession(userId, {
                ...response,
                api_key: API_KEY
            });

            return response;
        } catch (err) {
            console.error('Kite callback error:', err);
            throw new Error(err.message || 'Kite authentication failed');
        }
    }

    async getKiteInstance(userId) {
        let session = await kiteRepo.getSessionByUserId(userId);
        let isValid = false;

        if (session && session.access_token && session.saved_at) {
            const savedDate = getIstDateStr(session.saved_at);
            const today = getIstDateStr();
            if (savedDate === today) isValid = true;
        }

        // Fallback to latest global/platform session if per-user session is not active
        if (!isValid) {
            const latestSession = await kiteRepo.getLatestSession();
            if (latestSession && latestSession.access_token && latestSession.saved_at) {
                const savedDate = getIstDateStr(latestSession.saved_at);
                const today = getIstDateStr();
                if (savedDate === today) {
                    session = latestSession;
                    isValid = true;
                }
            }
        }

        if (!isValid || !session || !session.access_token) {
            throw new Error('Kite session expired. Please login again.');
        }

        const kite = new KiteConnect({ api_key: session.api_key || API_KEY });
        kite.setAccessToken(session.access_token);
        return kite;
    }

    async getStatus(userId) {
        try {
            let session = await kiteRepo.getSessionByUserId(userId);
            let isConnected = false;

            if (session && session.saved_at) {
                const savedDate = getIstDateStr(session.saved_at);
                const today = getIstDateStr();
                if (savedDate === today) {
                    isConnected = true;
                }
            }

            // Fallback to latest global/platform session if per-user session is not active
            if (!isConnected) {
                const latestSession = await kiteRepo.getLatestSession();
                if (latestSession && latestSession.saved_at) {
                    const savedDate = getIstDateStr(latestSession.saved_at);
                    const today = getIstDateStr();
                    if (savedDate === today) {
                        session = latestSession;
                        isConnected = true;
                    }
                }
            }

            if (!isConnected || !session) return { connected: false };

            return {
                connected: true,
                user_name: session.user_name,
                kite_user_id: session.kite_user_id,
                email: session.email,
                saved_at: session.saved_at
            };
        } catch (err) {
            return { connected: false, error: err.message };
        }
    }

    async setAccessToken(userId, accessToken) {
        if (!accessToken) throw new Error('access_token is required');

        // Validate token by calling Kite API
        const kite = new KiteConnect({ api_key: API_KEY });
        kite.setAccessToken(accessToken);
        let profile;
        try {
            profile = await kite.getProfile();
        } catch (err) {
            throw new Error('Invalid access token: ' + (err.message || 'Token rejected by Zerodha'));
        }

        // Token is valid — save to DB
        await this.saveTokenToDB(userId, accessToken, profile);
        return profile;
    }

    // Save token to DB without re-validating (used when already validated by kiteService)
    async saveTokenToDB(userId, accessToken, profile = {}) {
        let session = await kiteRepo.getSessionByUserId(userId);

        if (!session) {
            await kiteRepo.saveSession(userId, {
                api_key: API_KEY,
                access_token: accessToken,
                public_token: null,
                user_id: profile.user_id || null,
                user_name: profile.user_name || 'Unknown',
                email: profile.email || null
            });
        } else {
            await kiteRepo.updateAccessToken(userId, accessToken);
        }
    }

    async disconnect(userId) {
        await kiteRepo.deleteSession(userId);
    }
}

module.exports = new KiteAuthService();
