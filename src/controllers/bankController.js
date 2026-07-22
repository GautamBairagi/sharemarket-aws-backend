const db = require('../config/db');

const getBanks = async (req, res) => {
    try {
        const userId = req.user.id;
        const userRole = req.user.role;

        console.log(`[getBanks] User ${userId} (${userRole}) requesting banks`);

        // Each user sees only their created banks
        let query = 'SELECT * FROM bank_details WHERE (created_by = ? OR created_by IS NULL) ORDER BY id DESC';
        let params = [userId];

        // For TRADERS, also show banks created by their parent/admins
        if (userRole === 'TRADER') {
            query = `SELECT * FROM bank_details 
                     WHERE created_by = ? 
                     OR created_by IN (SELECT id FROM users WHERE role IN ('ADMIN', 'SUPERADMIN'))
                     OR created_by IS NULL
                     ORDER BY id DESC`;
            params = [userId];
        }

        // For SUPERADMIN/ADMIN, also include banks created by their children
        if (userRole === 'SUPERADMIN' || userRole === 'ADMIN') {
            query = `SELECT * FROM bank_details
                     WHERE created_by = ? OR created_by IN (
                         SELECT id FROM users WHERE parent_id = ?
                     ) OR created_by IS NULL
                     ORDER BY id DESC`;
            params = [userId, userId];
        }

        console.log(`[getBanks] Query params:`, params);
        const [rows] = await db.execute(query, params);
        console.log(`[getBanks] Returned ${rows.length} banks`);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

const createBank = async (req, res) => {
    const { bankName, accountHolder, accountNumber, ifsc, branch } = req.body;
    const userId = req.user.id;
    if (!bankName || !accountHolder || !accountNumber || !ifsc || !branch) {
        return res.status(400).json({ message: 'All fields are required' });
    }
    try {
        const [result] = await db.execute(
            'INSERT INTO bank_details (bank_name, account_holder, account_number, ifsc, branch, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [bankName, accountHolder, accountNumber, ifsc, branch, 'Active', userId]
        );
        res.status(201).json({ message: 'Bank added successfully', id: result.insertId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

const updateBank = async (req, res) => {
    const { id } = req.params;
    const { bankName, accountHolder, accountNumber, ifsc, branch, status } = req.body;
    try {
        await db.execute(
            'UPDATE bank_details SET bank_name=?, account_holder=?, account_number=?, ifsc=?, branch=?, status=? WHERE id=?',
            [bankName, accountHolder, accountNumber, ifsc, branch, status || 'Active', id]
        );
        res.json({ message: 'Bank updated successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

const deleteBank = async (req, res) => {
    const { id } = req.params;
    try {
        await db.execute('DELETE FROM bank_details WHERE id = ?', [id]);
        res.json({ message: 'Bank deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

const toggleBankStatus = async (req, res) => {
    const { id } = req.params;
    try {
        const [rows] = await db.execute('SELECT status FROM bank_details WHERE id = ?', [id]);
        if (!rows[0]) return res.status(404).json({ message: 'Bank not found' });
        const newStatus = rows[0].status === 'Active' ? 'Inactive' : 'Active';
        await db.execute('UPDATE bank_details SET status = ? WHERE id = ?', [newStatus, id]);
        res.json({ message: 'Status updated', status: newStatus });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

module.exports = { getBanks, createBank, updateBank, deleteBank, toggleBankStatus };
