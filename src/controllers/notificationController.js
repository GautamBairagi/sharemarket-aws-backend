const db = require('../config/db');
const { getIo } = require('../config/socket');

// ─── GET notifications for logged-in user ─────────────────────────────────────
const getNotifications = async (req, res) => {
    const userId = req.user.id;
    const role   = req.user.role;
    const source = req.query.source; // ?source=self → only show notifications created by this user

    try {
        let rows;

        if (source === 'self') {
            // User Notifications page — only show notifications created by this user
            [rows] = await db.execute(`
                SELECT
                    n.*,
                    CASE WHEN nr.user_id IS NOT NULL THEN 1 ELSE 0 END AS is_read
                FROM notifications n
                LEFT JOIN notification_reads nr
                    ON nr.notification_id = n.id AND nr.user_id = ?
                WHERE n.created_by = ?
                ORDER BY n.created_at DESC
                LIMIT 100
            `, [userId, userId]);
        } else if (role === 'SUPERADMIN') {
            // SUPERADMIN sees:
            // 1. Notifications they CREATED (sent)
            // 2. Notifications TARGETED to them (received)
            [rows] = await db.execute(`
                SELECT
                    n.*,
                    CASE WHEN nr.user_id IS NOT NULL THEN 1 ELSE 0 END AS is_read
                FROM notifications n
                LEFT JOIN notification_reads nr
                    ON nr.notification_id = n.id AND nr.user_id = ?
                WHERE
                    n.created_by = ?
                    OR n.target_role = 'ALL'
                    OR n.target_role = ?
                    OR FIND_IN_SET(?, REPLACE(n.target_user_ids, ' ', '')) > 0
                ORDER BY n.created_at DESC
                LIMIT 100
            `, [userId, userId, role, String(userId)]);
        } else if (role === 'ADMIN') {
            if (source === 'self') {
                // User Notifications page — only show notifications created by this admin
                [rows] = await db.execute(`
                    SELECT
                        n.*,
                        CASE WHEN nr.user_id IS NOT NULL THEN 1 ELSE 0 END AS is_read
                    FROM notifications n
                    LEFT JOIN notification_reads nr
                        ON nr.notification_id = n.id AND nr.user_id = ?
                    WHERE n.created_by = ?
                    ORDER BY n.created_at DESC
                    LIMIT 100
                `, [userId, userId]);
            } else {
                // Notifications page — only show notifications TARGETED to this admin
                [rows] = await db.execute(`
                    SELECT
                        n.*,
                        CASE WHEN nr.user_id IS NOT NULL THEN 1 ELSE 0 END AS is_read
                    FROM notifications n
                    LEFT JOIN notification_reads nr
                        ON nr.notification_id = n.id AND nr.user_id = ?
                    WHERE
                        n.target_role = 'ALL'
                        OR n.target_role = ?
                        OR FIND_IN_SET(?, REPLACE(n.target_user_ids, ' ', '')) > 0
                    ORDER BY n.created_at DESC
                    LIMIT 100
                `, [userId, role, String(userId)]);
            }
        } else {
            // BROKER and TRADER see notifications targeted to them only
            // Priority: Specific user targeting > Role-based targeting
            [rows] = await db.execute(`
                SELECT
                    n.*,
                    CASE WHEN nr.user_id IS NOT NULL THEN 1 ELSE 0 END AS is_read
                FROM notifications n
                LEFT JOIN notification_reads nr
                    ON nr.notification_id = n.id AND nr.user_id = ?
                WHERE
                    FIND_IN_SET(?, REPLACE(n.target_user_ids, ' ', '')) > 0
                    OR (n.target_user_ids IS NULL AND (n.target_role = ? OR n.target_role = 'ALL'))
                ORDER BY n.created_at DESC
                LIMIT 100
            `, [userId, String(userId), role]);
        }

        res.json(rows);
    } catch (err) {
        console.error('getNotifications:', err);
        res.status(500).json({ message: 'Server error' });
    }
};

// ─── MARK single notification as read ────────────────────────────────────────
const markRead = async (req, res) => {
    const userId = req.user.id;
    const { id }  = req.params;

    try {
        await db.execute(
            'INSERT IGNORE INTO notification_reads (notification_id, user_id) VALUES (?, ?)',
            [id, userId]
        );
        res.json({ message: 'Marked as read' });
    } catch (err) {
        console.error('markRead:', err);
        res.status(500).json({ message: 'Server error' });
    }
};

// ─── MARK ALL as read for current user ────────────────────────────────────────
const markAllRead = async (req, res) => {
    const userId = req.user.id;
    const role   = req.user.role;

    try {
        await db.execute(`
            INSERT IGNORE INTO notification_reads (notification_id, user_id)
            SELECT n.id, ?
            FROM notifications n
            LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = ?
            WHERE nr.user_id IS NULL
              AND (n.target_role = 'ALL' OR n.target_role = ? OR n.target_user_id = ?
                   OR FIND_IN_SET(?, REPLACE(n.target_user_ids, ' ', '')) > 0)
        `, [userId, userId, role, userId, String(userId)]);

        res.json({ message: 'All marked as read' });
    } catch (err) {
        console.error('markAllRead:', err);
        res.status(500).json({ message: 'Server error' });
    }
};

// ─── CREATE notification ──────────────────────────────────────────────────────
const createNotification = async (req, res) => {
    const { title, message, type = 'info', target_role = 'ALL', target_user_ids = [] } = req.body;
    const createdBy = req.user.id;

    if (!title || !message) {
        return res.status(400).json({ message: 'title and message are required' });
    }

    try {
        // If specific users selected, store their IDs
        const userIdsStr = Array.isArray(target_user_ids) && target_user_ids.length > 0
            ? target_user_ids.join(',')
            : null;

        const [result] = await db.execute(
            `INSERT INTO notifications (title, message, type, target_role, target_user_ids, created_by)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [title, message, type, target_role, userIdsStr, createdBy]
        );

        const notifId = result.insertId;

        const [[notif]] = await db.execute(
            'SELECT * FROM notifications WHERE id = ?', [notifId]
        );

        // Emit via socket
        const io = getIo();
        if (io) {
            if (userIdsStr) {
                // Send to each specific user
                target_user_ids.forEach(uid => {
                    io.to(`user:${uid}`).emit('notification', { ...notif, is_read: 0 });
                });
            } else if (target_role === 'ALL') {
                io.emit('notification', { ...notif, is_read: 0 });
            } else {
                io.to(`role:${target_role}`).emit('notification', { ...notif, is_read: 0 });
            }
        }

        res.status(201).json({ message: 'Notification sent', id: notifId });
    } catch (err) {
        console.error('createNotification:', err);
        res.status(500).json({ message: 'Server error' });
    }
};

// ─── GET users by role (for notification targeting) ───────────────────────────
const getUsersByRole = async (req, res) => {
    const { role } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    try {
        let query = 'SELECT id, username, full_name, email, role FROM users WHERE role = ? AND status = ? ';
        let params = [role, 'Active'];

        // Each user sees only the users they created (parent_id = current user id)
        if (userRole === 'SUPERADMIN') {
            // SUPERADMIN sees only their created users of the requested role
            query += 'AND parent_id = ?';
            params.push(userId);
        } else if (userRole === 'ADMIN') {
            // ADMIN sees only their created users of the requested role
            query += 'AND parent_id = ?';
            params.push(userId);
        } else if (userRole === 'BROKER') {
            // BROKER sees only their created traders
            query += 'AND parent_id = ?';
            params.push(userId);
        }

        query += ' ORDER BY full_name ASC';
        console.log('[getUsersByRole] Query:', query, 'Params:', params);
        const [rows] = await db.execute(query, params);
        console.log('[getUsersByRole] Returned', rows.length, 'users');
        res.json(rows);
    } catch (err) {
        console.error('getUsersByRole:', err);
        res.status(500).json({ message: 'Server error' });
    }
};

// ─── DELETE notification (admin/superadmin only) ──────────────────────────────
const deleteNotification = async (req, res) => {
    const { id } = req.params;

    try {
        await db.execute('DELETE FROM notification_reads WHERE notification_id = ?', [id]);
        await db.execute('DELETE FROM notifications WHERE id = ?', [id]);

        const io = getIo();
        if (io) io.emit('notification_deleted', { id: Number(id) });

        res.json({ message: 'Deleted' });
    } catch (err) {
        console.error('deleteNotification:', err);
        res.status(500).json({ message: 'Server error' });
    }
};

module.exports = { getNotifications, markRead, markAllRead, createNotification, deleteNotification, getUsersByRole };
