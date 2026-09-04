const db = require('../config/db');
const { runWeeklySettlement, getWeekBoundaries } = require('../services/WeeklySettlementService');

/**
 * SuperAdmin: Manually trigger Weekly Settlement
 */
const runSettlementNow = async (req, res) => {
    try {
        if (req.user?.role !== 'SUPERADMIN') {
            return res.status(403).json({ success: false, message: 'Access denied. SuperAdmin only.' });
        }

        const { targetDate } = req.body;
        const result = await runWeeklySettlement({
            targetDate: targetDate ? new Date(targetDate) : new Date(),
            settledByUserId: req.user.id
        });

        return res.json({
            success: true,
            message: `Weekly Settlement completed for week ${result.week_start} to ${result.week_end}`,
            data: result
        });
    } catch (err) {
        console.error('[weeklySettlementController] Run error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * Get Weekly Settlements History (with optional filters)
 */
const getSettlementsHistory = async (req, res) => {
    try {
        const { userId, fromDate, toDate, status } = req.query;
        let whereClauses = [];
        let params = [];

        if (userId) {
            whereClauses.push('ws.user_id = ?');
            params.push(userId);
        }
        if (fromDate) {
            whereClauses.push('ws.week_start_date >= ?');
            params.push(fromDate);
        }
        if (toDate) {
            whereClauses.push('ws.week_end_date <= ?');
            params.push(toDate);
        }
        if (status) {
            whereClauses.push('ws.settlement_status = ?');
            params.push(status);
        }

        const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
        const [rows] = await db.execute(
            `SELECT ws.*, u.username, u.full_name
             FROM weekly_settlements ws
             JOIN users u ON ws.user_id = u.id
             ${whereSql}
             ORDER BY ws.week_end_date DESC, ws.id DESC
             LIMIT 500`,
            params
        );

        if (rows.length > 0) {
            const settlementIds = rows.map(r => r.id);
            const placeholders = settlementIds.map(() => '?').join(',');
            const [items] = await db.execute(
                `SELECT * FROM weekly_settlement_items WHERE settlement_id IN (${placeholders}) ORDER BY id ASC`,
                settlementIds
            );

            const itemsBySettlement = {};
            for (const item of items) {
                if (!itemsBySettlement[item.settlement_id]) itemsBySettlement[item.settlement_id] = [];
                itemsBySettlement[item.settlement_id].push(item);
            }

            for (const row of rows) {
                row.items = itemsBySettlement[row.id] || [];
            }
        }

        return res.json({ success: true, count: rows.length, data: rows });
    } catch (err) {
        console.error('[weeklySettlementController] History error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * Get Settlement Configuration from expiry_rules
 */
const getSettlementConfig = async (req, res) => {
    try {
        const [rows] = await db.execute(
            `SELECT weekly_settlement_day, weekly_settlement_time, weekly_settlement_enabled 
             FROM expiry_rules LIMIT 1`
        );
        const config = rows[0] || {
            weekly_settlement_day: 'Sunday',
            weekly_settlement_time: '12:00',
            weekly_settlement_enabled: 'Yes'
        };

        const currentWeek = getWeekBoundaries(new Date());

        return res.json({
            success: true,
            data: {
                ...config,
                current_week_start: currentWeek.week_start,
                current_week_end: currentWeek.week_end
            }
        });
    } catch (err) {
        console.error('[weeklySettlementController] Get config error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * Update Settlement Configuration (SuperAdmin Only)
 */
const updateSettlementConfig = async (req, res) => {
    try {
        if (req.user?.role !== 'SUPERADMIN') {
            return res.status(403).json({ success: false, message: 'Access denied. SuperAdmin only.' });
        }

        const { weekly_settlement_day, weekly_settlement_time, weekly_settlement_enabled } = req.body;

        await db.execute(
            `UPDATE expiry_rules 
             SET weekly_settlement_day = COALESCE(?, weekly_settlement_day),
                 weekly_settlement_time = COALESCE(?, weekly_settlement_time),
                 weekly_settlement_enabled = COALESCE(?, weekly_settlement_enabled)`,
            [
                weekly_settlement_day || 'Sunday',
                weekly_settlement_time || '12:00',
                weekly_settlement_enabled || 'Yes'
            ]
        );

        return res.json({
            success: true,
            message: 'Weekly Settlement configuration updated successfully.'
        });
    } catch (err) {
        console.error('[weeklySettlementController] Update config error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

module.exports = {
    runSettlementNow,
    getSettlementsHistory,
    getSettlementConfig,
    updateSettlementConfig
};
