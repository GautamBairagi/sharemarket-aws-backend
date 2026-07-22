const db = require('../config/db');

// BFS — get all descendant user IDs under a given user
const getDescendantIds = async (userId) => {
    const ids = [];
    const queue = [userId];
    while (queue.length > 0) {
        const current = queue.shift();
        const [children] = await db.execute('SELECT id FROM users WHERE parent_id = ?', [current]);
        for (const child of children) {
            ids.push(child.id);
            queue.push(child.id);
        }
    }
    return ids;
};

// POST /support — create ticket + first message
const createTicket = async (req, res) => {
    const { subject, message, priority } = req.body;
    console.log('📩 Create ticket request:', { userId: req.user?.id, subject, priority, hasMessage: !!message });
    if (!subject || !message) {
        return res.status(400).json({ message: 'Subject and message are required' });
    }
    let conn;
    try {
        conn = await db.getConnection();
    } catch (connErr) {
        console.error('❌ DB connection failed:', connErr.message);
        return res.status(500).json({ message: 'Database connection failed' });
    }
    try {
        await conn.beginTransaction();
        const [result] = await conn.execute(
            'INSERT INTO support_tickets (user_id, subject, message, priority) VALUES (?, ?, ?, ?)',
            [req.user.id, subject, message, priority || 'NORMAL']
        );
        const ticketId = result.insertId;
        await conn.execute(
            'INSERT INTO ticket_messages (ticket_id, sender_id, sender_role, message) VALUES (?, ?, ?, ?)',
            [ticketId, req.user.id, req.user.role, message]
        );
        await conn.commit();
        res.status(201).json({ message: 'Ticket raised successfully', id: ticketId });
    } catch (err) {
        await conn.rollback();
        console.error('❌ Support ticket create error:', err.message, err.code);
        res.status(500).json({ message: err.code === 'ER_NO_SUCH_TABLE' ? 'Support tables not found. Please restart server to run migrations.' : ('Server Error: ' + err.message) });
    } finally {
        conn.release();
    }
};

// GET /support — list tickets (filtered by role hierarchy)
const getTickets = async (req, res) => {
    try {
        const role = req.user.role;
        const userId = req.user.id;

        let rows;

        if (role === 'SUPERADMIN') {
            [rows] = await db.execute(
                `SELECT t.*, u.username, u.full_name, u.role AS user_role
                 FROM support_tickets t
                 JOIN users u ON t.user_id = u.id
                 ORDER BY t.created_at DESC`
            );
        } else if (role === 'ADMIN') {
            const descendantIds = await getDescendantIds(userId);
            if (!descendantIds.length) return res.json([]);
            const placeholders = descendantIds.map(() => '?').join(',');
            [rows] = await db.execute(
                `SELECT t.*, u.username, u.full_name, u.role AS user_role
                 FROM support_tickets t
                 JOIN users u ON t.user_id = u.id
                 WHERE t.user_id IN (${placeholders})
                 ORDER BY t.created_at DESC`,
                descendantIds
            );
        } else {
            [rows] = await db.execute(
                `SELECT t.*, u.username, u.full_name, u.role AS user_role
                 FROM support_tickets t
                 JOIN users u ON t.user_id = u.id
                 WHERE t.user_id = ?
                 ORDER BY t.created_at DESC`,
                [userId]
            );
        }

        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

// GET /support/:id/messages — all chat messages for a ticket
const getTicketMessages = async (req, res) => {
    try {
        const ticketId = req.params.id;
        const [messages] = await db.execute(
            `SELECT tm.*, u.username, u.full_name
             FROM ticket_messages tm
             JOIN users u ON tm.sender_id = u.id
             WHERE tm.ticket_id = ?
             ORDER BY tm.created_at ASC`,
            [ticketId]
        );
        res.json(messages);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

// POST /support/:id/messages — send a new message in thread
const addMessage = async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ message: 'Message is required' });
    try {
        await db.execute(
            'INSERT INTO ticket_messages (ticket_id, sender_id, sender_role, message) VALUES (?, ?, ?, ?)',
            [req.params.id, req.user.id, req.user.role, message]
        );
        // Bump updated_at so it floats to top
        await db.execute('UPDATE support_tickets SET updated_at = NOW() WHERE id = ?', [req.params.id]);
        res.status(201).json({ message: 'Message sent' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

// PUT /support/:id/resolve — mark ticket as resolved (admin only)
const resolveTicket = async (req, res) => {
    try {
        await db.execute(
            `UPDATE support_tickets SET status = 'RESOLVED', updated_at = NOW() WHERE id = ?`,
            [req.params.id]
        );
        res.json({ message: 'Ticket resolved' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

// DELETE /support/:id — delete ticket (admin any, user only own)
const deleteTicket = async (req, res) => {
    try {
        const ticketId = req.params.id;
        const role = req.user.role;
        const userId = req.user.id;

        // Users can only delete their own tickets
        if (role !== 'SUPERADMIN' && role !== 'ADMIN') {
            const [rows] = await db.execute('SELECT user_id FROM support_tickets WHERE id = ?', [ticketId]);
            if (!rows.length || rows[0].user_id !== userId) {
                return res.status(403).json({ message: 'Not allowed' });
            }
        }

        await db.execute('DELETE FROM support_tickets WHERE id = ?', [ticketId]);
        res.json({ message: 'Ticket deleted' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

module.exports = { createTicket, getTickets, getTicketMessages, addMessage, resolveTicket, deleteTicket };
