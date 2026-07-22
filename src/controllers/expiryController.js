const db = require('../config/db');

const getExpiryRules = async (req, res) => {
    const userId = req.user.id;
    try {
        const [rows] = await db.execute('SELECT * FROM expiry_rules WHERE user_id = ?', [userId]);
        if (!rows.length) {
            // Return defaults if no settings found for this user
            return res.json({
                autoSquareOff: 'No',
                nseSquareOffTime: '15:20',
                mcxSquareOffTime: '23:30',
                cryptoSquareOffTime: '23:30',
                forexSquareOffTime: '23:30',
                comexSquareOffTime: '23:30',
                allowExpiringScrip: 'No',
                daysBeforeExpiry: '0',
                mcxOptionsAwayPoints: {}
            });
        }
        const row = rows[0];
        res.json({
            autoSquareOff: row.auto_square_off,
            nseSquareOffTime: row.square_off_time,
            mcxSquareOffTime: row.mcx_square_off_time,
            cryptoSquareOffTime: row.crypto_square_off_time,
            forexSquareOffTime: row.forex_square_off_time,
            comexSquareOffTime: row.comex_square_off_time,
            allowExpiringScrip: row.allow_expiring_scrip,
            daysBeforeExpiry: String(row.days_before_expiry),
            mcxOptionsAwayPoints: row.away_points ? JSON.parse(row.away_points) : {}
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

const updateExpiryRules = async (req, res) => {
    const { autoSquareOff, nseSquareOffTime, mcxSquareOffTime, cryptoSquareOffTime, forexSquareOffTime, comexSquareOffTime, allowExpiringScrip, daysBeforeExpiry, mcxOptionsAwayPoints } = req.body;
    const userId = req.user.id;

    try {
        console.log(`[ExpiryController] Updating rules for user ${userId}:`, { autoSquareOff, nseSquareOffTime, mcxSquareOffTime, cryptoSquareOffTime, forexSquareOffTime, comexSquareOffTime });
        await db.execute(
            `INSERT INTO expiry_rules (user_id, auto_square_off, square_off_time, mcx_square_off_time, crypto_square_off_time, forex_square_off_time, comex_square_off_time, allow_expiring_scrip, days_before_expiry, away_points)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                auto_square_off      = VALUES(auto_square_off),
                square_off_time      = VALUES(square_off_time),
                mcx_square_off_time  = VALUES(mcx_square_off_time),
                crypto_square_off_time = VALUES(crypto_square_off_time),
                forex_square_off_time  = VALUES(forex_square_off_time),
                comex_square_off_time  = VALUES(comex_square_off_time),
                allow_expiring_scrip = VALUES(allow_expiring_scrip),
                days_before_expiry   = VALUES(days_before_expiry),
                away_points          = VALUES(away_points)`,
            [
                userId,
                autoSquareOff || 'No',
                nseSquareOffTime || '15:20',
                mcxSquareOffTime || '23:30',
                cryptoSquareOffTime || '23:30',
                forexSquareOffTime || '23:30',
                comexSquareOffTime || '23:30',
                allowExpiringScrip || 'No',
                parseInt(daysBeforeExpiry) || 0,
                mcxOptionsAwayPoints ? JSON.stringify(mcxOptionsAwayPoints) : null
            ]
        );
        res.json({ message: 'Expiry rules updated successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

module.exports = { getExpiryRules, updateExpiryRules };
