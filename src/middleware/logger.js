const db = require('../config/db');

const logIp = async (req, res, next) => {
    const ip = req.ip || req.headers['x-forwarded-for'];
    const userAgent = req.headers['user-agent'];
    const userId = req.user ? req.user.id : null;

    if (userId) {
        try {
            await db.execute(
                'INSERT INTO ip_logs (user_id, ip_address, browser) VALUES (?, ?, ?)',
                [userId, ip, userAgent]
            );
        } catch (err) {
            console.error('Logging failed:', err);
        }
    }
    next();
};

const getIpLogs = async (req, res) => {
    try {
        const [rows] = await db.execute(
            'SELECT l.*, u.username FROM ip_logs l JOIN users u ON l.user_id = u.id ORDER BY l.timestamp DESC LIMIT 100'
        );
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

module.exports = { logIp, getIpLogs };
