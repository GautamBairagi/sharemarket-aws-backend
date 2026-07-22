const db = require('../config/db');

/**
 * Repository for managing Zerodha Kite user sessions in MySQL.
 */
class KiteRepository {
    async getSessionByUserId(userId) {
        const [rows] = await db.execute(
            'SELECT * FROM user_kite_sessions WHERE user_id = ?',
            [userId]
        );
        return rows[0] || null;
    }

    async saveSession(userId, sessionData) {
        const {
            api_key,
            access_token,
            public_token,
            user_id: kite_user_id,
            user_name,
            email
        } = sessionData;

        await db.execute(
            `INSERT INTO user_kite_sessions 
            (user_id, api_key, access_token, public_token, kite_user_id, user_name, email, saved_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON DUPLICATE KEY UPDATE
            api_key = VALUES(api_key),
            access_token = VALUES(access_token),
            public_token = VALUES(public_token),
            kite_user_id = VALUES(kite_user_id),
            user_name = VALUES(user_name),
            email = VALUES(email),
            saved_at = CURRENT_TIMESTAMP`,
            [userId, api_key, access_token, public_token, kite_user_id, user_name, email]
        );
    }

    async deleteSession(userId) {
        await db.execute('DELETE FROM user_kite_sessions WHERE user_id = ?', [userId]);
    }

    async updateAccessToken(userId, accessToken) {
        await db.execute(
            'UPDATE user_kite_sessions SET access_token = ?, saved_at = CURRENT_TIMESTAMP WHERE user_id = ?',
            [accessToken, userId]
        );
    }
}

module.exports = new KiteRepository();
