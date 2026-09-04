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
    const { target, targetIds, brokerId, segment, parameter, marginType, value, configUpdates } = req.body;

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

        // ── 2. Build the SQL field to update in user_segments if legacy parameter is passed ───────────────────
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
                field = 'exposure_multiplier';
                fieldValue = parseFloat(value?.intraday) || 1;
            } else {
                field = 'margin_type';
                fieldValue = 'PER_LOT';
            }
        }

        // Prepare config payload to merge into client_settings.config_json
        const payloadToMerge = configUpdates || {};
        if (value && typeof value === 'object' && !configUpdates) {
            Object.assign(payloadToMerge, value);
        } else if (value && typeof value !== 'object' && !configUpdates && field) {
            payloadToMerge[field] = value;
        }

        // ── 3. Apply update to client_settings and user_segments for each user ───────────────────
        let updatedCount = 0;

        for (const uid of userIds) {
            // Update user_segments if field is mapped
            if (field && fieldValue !== null) {
                await db.execute(
                    `INSERT INTO user_segments (user_id, segment, is_enabled, ${field})
                     VALUES (?, ?, 1, ?)
                     ON DUPLICATE KEY UPDATE ${field} = ?`,
                    [uid, segment, fieldValue, fieldValue]
                );
            }

            // Fetch current client_settings config_json
            const [csRows] = await db.execute(`SELECT config_json, min_time_to_book_profit, scalping_sl_enabled FROM client_settings WHERE user_id = ?`, [uid]);
            let currentConfig = {};
            if (csRows.length > 0 && csRows[0].config_json) {
                try { currentConfig = JSON.parse(csRows[0].config_json); } catch (e) { currentConfig = {}; }
            }

            // Merge new updates into config_json
            const mergedConfig = { ...currentConfig, ...payloadToMerge };
            const mergedJson = JSON.stringify(mergedConfig);

            // Extract specific columns if present in payloadToMerge
            let minProfitTime = csRows[0]?.min_time_to_book_profit ?? 120;
            if (payloadToMerge.mcxMinTimeToBookProfit !== undefined) minProfitTime = parseInt(payloadToMerge.mcxMinTimeToBookProfit) || 0;
            if (payloadToMerge.equityMinTimeToBookProfit !== undefined) minProfitTime = parseInt(payloadToMerge.equityMinTimeToBookProfit) || 0;

            let scalpingSl = csRows[0]?.scalping_sl_enabled ?? 0;
            if (payloadToMerge.mcxScalpingStopLoss !== undefined) scalpingSl = payloadToMerge.mcxScalpingStopLoss === 'Enabled' ? 1 : 0;
            if (payloadToMerge.equityScalpingStopLoss !== undefined) scalpingSl = payloadToMerge.equityScalpingStopLoss === 'Enabled' ? 1 : 0;

            await db.execute(`
                INSERT INTO client_settings (user_id, config_json, min_time_to_book_profit, scalping_sl_enabled)
                VALUES (?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE 
                    config_json = VALUES(config_json),
                    min_time_to_book_profit = VALUES(min_time_to_book_profit),
                    scalping_sl_enabled = VALUES(scalping_sl_enabled)
            `, [uid, mergedJson, minProfitTime, scalpingSl]);

            updatedCount++;
        }

        // ── 4. Build clean log description with client names & only modified fields ──
        let targetNamesStr = `Target: ${target} (${updatedCount} users)`;
        if (userIds.length > 0) {
            try {
                const placeholders = userIds.map(() => '?').join(',');
                const [uRows] = await db.execute(`SELECT username FROM users WHERE id IN (${placeholders})`, userIds);
                const names = uRows.map(r => r.username);
                if (names.length === 1) {
                    targetNamesStr = `Client: ${names[0]}`;
                } else if (names.length > 1 && names.length <= 3) {
                    targetNamesStr = `Clients: ${names.join(', ')}`;
                }
            } catch (e) {
                console.error('Failed to fetch usernames for audit log:', e);
            }
        }

        const activeUpdates = [];
        for (const [k, v] of Object.entries(payloadToMerge || {})) {
            if (v === undefined || v === null || v === '') continue;
            if (typeof v === 'object') {
                const nonZeroEntries = Object.entries(v).filter(([_, val]) => {
                    if (typeof val === 'object' && val !== null) {
                        return Object.values(val).some(x => x !== undefined && x !== '' && x !== '0' && x !== 0);
                    }
                    return val !== undefined && val !== '' && val !== '0' && val !== 0;
                });
                if (nonZeroEntries.length > 0) {
                    activeUpdates.push(`${k}: ${nonZeroEntries.length} items`);
                }
            } else {
                activeUpdates.push(`${k}: ${v}`);
            }
        }

        const cleanUpdatesStr = activeUpdates.length > 0 ? activeUpdates.join(', ') : (value ? `${parameter}: ${value}` : 'Updated');

        await logAction(
            req.user.id,
            'GLOBAL_BATCH_UPDATE',
            'client_settings',
            `Global Update [${parameter || 'Batch'}] | Segment: ${segment} | ${targetNamesStr} | Updates: ${cleanUpdatesStr}`
        );

        res.json({
            message: `Successfully applied global update for ${updatedCount} user(s) in ${segment}`,
            updatedCount,
        });

    } catch (err) {
        console.error('[globalBatchUpdate]', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
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
                    us.exposure_multiplier, us.margin_type, us.is_enabled,
                    cs.min_time_to_book_profit, cs.scalping_sl_enabled, cs.config_json
             FROM users u
             LEFT JOIN user_segments us ON us.user_id = u.id AND us.segment = ?
             LEFT JOIN client_settings cs ON cs.user_id = u.id
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
