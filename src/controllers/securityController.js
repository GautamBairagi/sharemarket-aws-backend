const db = require('../config/db');

/**
 * Detects "Multi-Account Clusters"
 * Finding different user_ids that have logged in from the same IP address.
 */
const getIpClusters = async (req, res) => {
    try {
        const query = `
            SELECT ip_address, GROUP_CONCAT(DISTINCT u.username) as users, COUNT(DISTINCT l.user_id) as user_count
            FROM ip_logins l
            JOIN users u ON l.user_id = u.id
            GROUP BY ip_address
            HAVING user_count > 1
            ORDER BY user_count DESC
        `;
        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

/**
 * Tracks IP at the exact moment of trade placement
 * (This is used by the tradeController during order placement)
 */
const getTradeIpAudit = async (req, res) => {
    try {
        const query = `
            SELECT t.id as trade_id, t.symbol, t.trade_ip, u.username, t.entry_time
            FROM trades t
            JOIN users u ON t.user_id = u.id
            WHERE t.trade_ip IS NOT NULL
            ORDER BY t.entry_time DESC
            LIMIT 100
        `;
        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

/**
 * Flags risky IPs (Proxy/VPN/Rapid Switching)
 * Logic: If a single user has > 5 different IPs in the last 24 hours.
 */
const getRiskScoring = async (req, res) => {
    try {
        const query = `
            SELECT u.username, COUNT(DISTINCT l.ip_address) as ip_count
            FROM ip_logins l
            JOIN users u ON l.user_id = u.id
            WHERE l.timestamp > NOW() - INTERVAL 1 DAY
            GROUP BY l.user_id
            HAVING ip_count > 3
        `;
        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

/**
 * General Login History
 */
const getIpLogins = async (req, res) => {
    const { startDate, endDate, location, search, role } = req.query;
    console.log('DEBUG: IP Logins Filters received:', { startDate, endDate, location, search, role });
    try {
        let query = `
            SELECT 
                l.id, l.user_id, l.username, 
                l.ip_address as ip, 
                l.location, 
                l.device as userAgent, 
                l.risk_score as riskScore, 
                l.timestamp,
                l.city, l.country as isp, l.os, l.device_model,
                u.full_name, u.role
            FROM ip_logins l
            LEFT JOIN users u ON l.user_id = u.id
            WHERE 1=1
        `;
        const params = [];

        if (startDate) {
            query += ' AND l.timestamp >= ?';
            params.push(`${startDate} 00:00:00`);
        }
        if (endDate) {
            query += ' AND l.timestamp <= ?';
            params.push(`${endDate} 23:59:59`);
        }
        if (location) {
            query += ' AND (l.location LIKE ? OR l.city LIKE ? OR l.country LIKE ?)';
            const locVal = `%${location}%`;
            params.push(locVal, locVal, locVal);
        }
        if (search) {
            query += ' AND (l.username LIKE ? OR l.ip_address LIKE ? OR l.city LIKE ? OR u.full_name LIKE ?)';
            const searchVal = `%${search}%`;
            params.push(searchVal, searchVal, searchVal, searchVal);
        }
        if (role) {
            query += ' AND u.role = ?';
            params.push(role);
        }

        query += ' ORDER BY l.timestamp DESC LIMIT 500';

        console.log('DEBUG: Executing Query:', query);
        console.log('DEBUG: With Params:', params);

        const [rows] = await db.execute(query, params);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};

/**
 * Deletes a specific login record
 */
const deleteIpLogin = async (req, res) => {
    const { id } = req.params;
    try {
        const [result] = await db.execute('DELETE FROM ip_logins WHERE id = ?', [id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Log entry not found' });
        }
        res.json({ message: 'Log entry deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

module.exports = { getIpClusters, getTradeIpAudit, getRiskScoring, getIpLogins, deleteIpLogin };
// Forensic audit control finalized
