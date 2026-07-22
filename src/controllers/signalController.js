const db = require('../config/db');

const createSignal = async (req, res) => {
    const { symbol, type, entry_price, target, stop_loss, message } = req.body;
    try {
        const [result] = await db.execute(
            'INSERT INTO signals (symbol, type, entry_price, target, stop_loss, message) VALUES (?, ?, ?, ?, ?, ?)',
            [symbol, type, entry_price, target, stop_loss, message]
        );
        res.status(201).json({ message: 'Signal broadcasted', id: result.insertId });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const getActiveSignals = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM signals WHERE is_active = 1 ORDER BY created_at DESC');
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const closeSignal = async (req, res) => {
    try {
        await db.execute('UPDATE signals SET is_active = 0 WHERE id = ?', [req.params.id]);
        res.json({ message: 'Signal deactivated' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

module.exports = { createSignal, getActiveSignals, closeSignal };
