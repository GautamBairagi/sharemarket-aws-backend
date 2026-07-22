const { KiteConnect } = require('kiteconnect');
const kiteRepo = require('../repositories/KiteRepository');
const crypto = require('crypto');

// Access keys from process.env (loaded by server.js)
const API_KEY = process.env.KITE_API_KEY;
const API_SECRET = process.env.KITE_API_SECRET;

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
        const session = await kiteRepo.getSessionByUserId(userId);
        if (!session || !session.access_token) {
            throw new Error('Kite not connected for this user');
        }

        // Session expiry check (Kite tokens expire daily around 6 AM)
        const savedDate = new Date(session.saved_at).toDateString();
        const today = new Date().toDateString();
        if (savedDate !== today) {
            throw new Error('Kite session expired. Please login again.');
        }

        const kite = new KiteConnect({ api_key: session.api_key });
        kite.setAccessToken(session.access_token);
        return kite;
    }

    async getStatus(userId) {
        try {
            const session = await kiteRepo.getSessionByUserId(userId);
            if (!session) return { connected: false };

            const savedDate = new Date(session.saved_at).toDateString();
            const today = new Date().toDateString();

            return {
                connected: savedDate === today,
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
