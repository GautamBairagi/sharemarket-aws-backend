const db = require('../config/db');
const MarginUtils = require('../utils/MarginUtils');

const getLedger = async (req, res) => {
    try {
        const { userId, type } = req.query; // type: CREDIT/DEBIT
        let query = 'SELECT * FROM internal_transfers';
        const params = [];

        if (userId) {
            query += ' WHERE to_user_id = ? OR from_user_id = ?';
            params.push(userId, userId);
        }

        const [rows] = await db.execute(query, params);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const internalTransfer = async (req, res) => {
    const { toUserId, amount, notes } = req.body;
    const fromUserId = req.user.id;
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        // Check balance of sender if not SUPERADMIN
        if (req.user.role !== 'SUPERADMIN') {
            const [sender] = await connection.execute('SELECT balance FROM users WHERE id = ?', [fromUserId]);
            if (sender[0].balance < amount) throw new Error('Insufficient balance');
        }

        // Update balances
        await connection.execute('UPDATE users SET balance = balance - ? WHERE id = ?', [amount, fromUserId]);
        await connection.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, toUserId]);

        // Log transfer
        await connection.execute(
            'INSERT INTO internal_transfers (from_user_id, to_user_id, amount, notes) VALUES (?, ?, ?, ?)',
            [fromUserId, toUserId, amount, notes]
        );

        await connection.commit();
        res.json({ message: 'Transfer successful' });
    } catch (err) {
        await connection.rollback();
        res.status(400).json({ message: err.message });
    } finally {
        connection.release();
    }
};

// GET /portfolio/balance — real balance, margin, P/L for logged-in user
const getBalance = async (req, res) => {
    try {
        const userId = req.user.id;

        // 1. User balance from DB
        const [userRows] = await db.execute('SELECT balance, credit_limit FROM users WHERE id = ?', [userId]);
        if (!userRows.length) return res.status(404).json({ message: 'User not found' });
        const balance = parseFloat(userRows[0].balance);

        // 2. Total margin used from OPEN trades (DYNAMIC)
        const [openTrades] = await db.execute(
            `SELECT t.*, s.lot_size 
             FROM trades t 
             LEFT JOIN scrip_data s ON t.symbol = s.symbol 
             WHERE t.user_id = ? AND t.status = "OPEN"`,
            [userId]
        );

        const [clientSettings] = await db.execute('SELECT config_json FROM client_settings WHERE user_id = ?', [userId]);
        const clientConfig = clientSettings.length ? JSON.parse(clientSettings[0].config_json || '{}') : {};

        // Calculate breakdown by segment manually or via a new helper
        const marginBySegment = { MCX: 0, EQUITY: 0, OPTIONS: 0, COMEX: 0, FOREX: 0, CRYPTO: 0 };
        let totalMarginUsed = 0;

        openTrades.forEach(trade => {
            let mType = (trade.market_type || 'MCX').toUpperCase();
            if (mType === 'COMMODITY') {
                mType = 'COMEX'; // Map COMMODITY to COMEX segment for portfolio breakdown
            }
            const calc = MarginUtils.calculateTotalRequiredHoldingMargin([trade], clientConfig);
            totalMarginUsed += calc;
            if (marginBySegment[mType] !== undefined) {
                marginBySegment[mType] += calc;
            }
        });

        // 4. Gross P/L from closed trades
        const [plRows] = await db.execute(
            'SELECT IFNULL(SUM(pnl), 0) as gross_pl FROM trades WHERE user_id = ? AND status = "CLOSED"',
            [userId]
        );
        const grossPL = parseFloat(plRows[0].gross_pl);

        // 5. Brokerage from closed trades
        const [brkRows] = await db.execute(
            'SELECT IFNULL(SUM(brokerage), 0) as total_brokerage FROM trades WHERE user_id = ? AND status = "CLOSED"',
            [userId]
        );
        const totalBrokerage = parseFloat(brkRows[0].total_brokerage);

        res.json({
            balance,
            credit_limit: parseFloat(userRows[0].credit_limit),
            margin_used: totalMarginUsed,
            margin_available: balance - totalMarginUsed,
            margin_by_segment: marginBySegment,
            gross_pl: grossPL,
            brokerage: totalBrokerage,
            net_pl: grossPL - totalBrokerage,
        });
    } catch (err) {
        console.error('getBalance error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

module.exports = { getLedger, internalTransfer, getBalance };
