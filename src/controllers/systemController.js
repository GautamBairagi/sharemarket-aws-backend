const db = require('../config/db');

const logAction = async (userId, action, target, details) => {
    try {
        // 1. Check if the initiator (userId) is a demo user
        if (userId) {
            const [[user]] = await db.execute('SELECT is_demo FROM users WHERE id = ?', [userId]);
            if (user && user.is_demo === 1) {
                return; // Skip logging for demo user
            }
        }

        // 2. Check if the details describe a demo user or demo trade
        if (typeof details === 'string') {
            // Try to extract user ID from parentheses, e.g. "username (123)"
            const userMatch = details.match(/\((\d+)\)/);
            if (userMatch) {
                const extractedUserId = parseInt(userMatch[1]);
                const [[tgtUser]] = await db.execute('SELECT is_demo FROM users WHERE id = ?', [extractedUserId]);
                if (tgtUser && tgtUser.is_demo === 1) {
                    return; // Skip logging
                }
            }

            // Try to extract user ID from patterns like "user ID 123", "user #123", "user ID: 123"
            const userPatternMatch = details.match(/(?:user ID|user #|user ID:)\s*(\d+)/i);
            if (userPatternMatch) {
                const extractedUserId = parseInt(userPatternMatch[1]);
                const [[tgtUser]] = await db.execute('SELECT is_demo FROM users WHERE id = ?', [extractedUserId]);
                if (tgtUser && tgtUser.is_demo === 1) {
                    return; // Skip logging
                }
            }

            // Try to extract trade ID from patterns like "Trade 123", "trade ID 123", "entry #123"
            const tradeMatch = details.match(/(?:Trade|trade|entry|ID:)\s*#?(\d+)/i);
            if (tradeMatch) {
                const extractedTradeId = parseInt(tradeMatch[1]);
                const [[tradeUser]] = await db.execute(
                    'SELECT u.is_demo FROM trades t JOIN users u ON t.user_id = u.id WHERE t.id = ?',
                    [extractedTradeId]
                );
                if (tradeUser && tradeUser.is_demo === 1) {
                    return; // Skip logging
                }
            }
        }

        await db.execute(
            'INSERT INTO action_ledger (admin_id, action_type, target_table, description) VALUES (?, ?, ?, ?)',
            [userId, action, target, details]
        );
    } catch (e) { console.error('logAction error:', e.message); }
};

const getActionLedger = async (req, res) => {
    try {
        const { message, page = 1, limit = 20 } = req.query;
        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.max(1, parseInt(limit) || 20);
        const offset = (pageNum - 1) * limitNum;

        // Build search filter safely
        const hasSearch = message && message.trim();
        const searchTerm = hasSearch ? `%${message.trim()}%` : null;

        // Main query - always same structure, params vary
        const mainQuery = `SELECT al.id, al.admin_id, al.action_type, al.target_table, al.description, al.timestamp, u.username
                          FROM action_ledger al
                          LEFT JOIN users u ON al.admin_id = u.id
                          WHERE (? IS NULL OR al.description LIKE ?)
                          ORDER BY al.timestamp DESC
                          LIMIT ? OFFSET ?`;

        const mainParams = [searchTerm, searchTerm, limitNum, offset];

        // Count query
        const countQuery = `SELECT COUNT(*) as total FROM action_ledger al
                           WHERE (? IS NULL OR al.description LIKE ?)`;
        const countParams = [searchTerm, searchTerm];

        console.log('[getActionLedger] Main params:', mainParams);
        console.log('[getActionLedger] Count params:', countParams);

        const [rows] = await db.query(mainQuery, mainParams);
        const [[{ total }]] = await db.query(countQuery, countParams);

        res.json({ rows, total, page: pageNum, limit: limitNum });
    } catch (err) {
        console.error('[getActionLedger] Error:', {
            message: err.message,
            code: err.code,
            sql: err.sql
        });
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

const debugLatestActionLedger = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM action_ledger ORDER BY created_at DESC LIMIT 10');
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

/**
 * Global Batch Update
 * Updates user_segments for selected users based on target/segment/parameter
 *
 * Body:
 *   target       : 'All Users' | 'Single user' | 'Multiple users' | 'Broker-wise users'
 *   targetIds    : [userId, ...]  — for Single/Multiple
 *   brokerId     : userId         — for Broker-wise
 *   segment      : 'MCX' | 'Equity' | 'Options' | 'Comex' | 'Forex' | 'Crypto'
 *   subSegment   : 'Futures' | 'Options'
 *   parameter    : 'Brokerage' | 'Leverage' | 'Max Lot' | 'Margin' | 'Exposure Multiplier'
 *   marginType   : 'Exposure' | 'Lot'
 *   value        : string | { intraday, holding } | { [scrip]: { INTRADAY, HOLDING } }
 */
const globalBatchUpdate = async (req, res) => {
    const { target, targetIds, brokerId, segment, parameter, marginType, value } = req.body;

    try {
        // ── 1. Resolve which user IDs to update ──────────────────────────────
        let userIds = [];

        if (target === 'All Users') {
            const [rows] = await db.execute(`SELECT id FROM users WHERE role = 'TRADER'`);
            userIds = rows.map(r => r.id);

        } else if (target === 'Single user' || target === 'Multiple users') {
            if (!targetIds || !targetIds.length)
                return res.status(400).json({ message: 'No users selected' });
            userIds = targetIds.map(Number);

        } else if (target === 'Broker-wise users') {
            if (!brokerId)
                return res.status(400).json({ message: 'No broker selected' });
            const [rows] = await db.execute(
                `SELECT id FROM users WHERE parent_id = ? AND role = 'TRADER'`,
                [brokerId]
            );
            userIds = rows.map(r => r.id);
            if (!userIds.length)
                return res.status(400).json({ message: 'No traders found under this broker' });

        } else {
            return res.status(400).json({ message: 'Invalid target' });
        }

        if (!userIds.length)
            return res.status(400).json({ message: 'No users found to update' });

        // ── 2. Build the SQL field to update ─────────────────────────────────
        let field = null;
        let fieldValue = null;

        if (parameter === 'Brokerage') {
            field = 'brokerage_value';
            fieldValue = parseFloat(value) || 0;

        } else if (parameter === 'Leverage') {
            field = 'leverage';
            fieldValue = parseInt(value) || 1;

        } else if (parameter === 'Max Lot') {
            field = 'max_lot_per_scrip';
            fieldValue = parseInt(value) || 1;

        } else if (parameter === 'Exposure Multiplier') {
            field = 'exposure_multiplier';
            fieldValue = parseFloat(value) || 1;

        } else if (parameter === 'Margin') {
            if (marginType === 'Exposure') {
                // value = { intraday, holding } — store as exposure_multiplier
                // We update margin_type to EXPOSURE and exposure_multiplier to intraday value
                field = 'exposure_multiplier';
                fieldValue = parseFloat(value?.intraday) || 1;
            } else {
                // Lot-wise — store as margin_type='PER_LOT'
                field = 'margin_type';
                fieldValue = 'PER_LOT';
            }
        } else {
            return res.status(400).json({ message: 'Invalid parameter' });
        }

        // ── 3. Apply update to user_segments for each user ───────────────────
        let updatedCount = 0;

        for (const uid of userIds) {
            // Upsert: if row exists update, else insert with default values
            await db.execute(
                `INSERT INTO user_segments (user_id, segment, is_enabled, ${field})
                 VALUES (?, ?, 1, ?)
                 ON DUPLICATE KEY UPDATE ${field} = ?`,
                [uid, segment, fieldValue, fieldValue]
            );
            updatedCount++;
        }

        // ── 4. Log the action ─────────────────────────────────────────────────
        await logAction(
            req.user.id,
            'GLOBAL_BATCH_UPDATE',
            'user_segments',
            `Updated ${parameter} → ${JSON.stringify(value)} for ${updatedCount} users | Segment: ${segment} | Target: ${target}`
        );

        res.json({
            message: `Successfully updated ${parameter} for ${updatedCount} user(s) in ${segment}`,
            updatedCount,
        });

    } catch (err) {
        console.error('[globalBatchUpdate]', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

/**
 * GET /system/segment-values?segment=MCX
 * Returns current user_segments values for all traders for a given segment
 */
const getSegmentValues = async (req, res) => {
    const { segment } = req.query;
    if (!segment) return res.status(400).json({ message: 'segment is required' });
    try {
        const [rows] = await db.execute(
            `SELECT u.id, u.username, u.full_name,
                    us.brokerage_value, us.leverage, us.max_lot_per_scrip,
                    us.exposure_multiplier, us.margin_type, us.is_enabled
             FROM users u
             LEFT JOIN user_segments us ON us.user_id = u.id AND us.segment = ?
             WHERE u.role = 'TRADER'
             ORDER BY u.username ASC`,
            [segment]
        );
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

/**
 * POST /system/reset-segment
 * Resets a parameter back to default for all/selected users in a segment
 * Body: { segment, parameter, target, targetIds, brokerId }
 */
const resetSegmentValues = async (req, res) => {
    const { segment, parameter, target, targetIds, brokerId } = req.body;

    const defaults = {
        'Brokerage':           { field: 'brokerage_value',    value: 0 },
        'Leverage':            { field: 'leverage',           value: 1 },
        'Max Lot':             { field: 'max_lot_per_scrip',  value: 10 },
        'Exposure Multiplier': { field: 'exposure_multiplier',value: 1 },
        'Margin':              { field: 'margin_type',        value: 'PER_LOT' },
    };

    const def = defaults[parameter];
    if (!def) return res.status(400).json({ message: 'Invalid parameter' });

    try {
        let userIds = [];
        if (!target || target === 'All Users') {
            const [rows] = await db.execute(`SELECT id FROM users WHERE role = 'TRADER'`);
            userIds = rows.map(r => r.id);
        } else if (target === 'Broker-wise users' && brokerId) {
            const [rows] = await db.execute(
                `SELECT id FROM users WHERE parent_id = ? AND role = 'TRADER'`, [brokerId]
            );
            userIds = rows.map(r => r.id);
        } else {
            userIds = (targetIds || []).map(Number);
        }

        if (!userIds.length) return res.status(400).json({ message: 'No users found' });

        for (const uid of userIds) {
            await db.execute(
                `UPDATE user_segments SET ${def.field} = ? WHERE user_id = ? AND segment = ?`,
                [def.value, uid, segment]
            );
        }

        await logAction(req.user.id, 'RESET_SEGMENT', 'user_segments',
            `Reset ${parameter} to default (${def.value}) for ${userIds.length} users | Segment: ${segment}`);

        res.json({ message: `Reset ${parameter} to default for ${userIds.length} user(s)`, count: userIds.length });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

module.exports = { getActionLedger, globalBatchUpdate, logAction, debugLatestActionLedger, getSegmentValues, resetSegmentValues };
