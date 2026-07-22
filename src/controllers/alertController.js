const db = require('../config/db');

// Get all alerts for a user
const getAlerts = async (req, res) => {
    try {
        const userId = req.user.id;
        const [alerts] = await db.execute(
            'SELECT id, user_id, symbol, type, target_price, status, created_at, triggered_at FROM alerts WHERE user_id = ? ORDER BY created_at DESC',
            [userId]
        );

        // Convert snake_case to camelCase for frontend
        const formattedAlerts = (alerts || []).map(alert => ({
            id: alert.id,
            user_id: alert.user_id,
            symbol: alert.symbol,
            type: alert.type,
            targetPrice: alert.target_price,  // ✅ Convert to camelCase
            status: alert.status,
            createdAt: alert.created_at,
            triggeredAt: alert.triggered_at
        }));

        res.json(formattedAlerts);
    } catch (err) {
        console.error('❌ Get alerts error:', err.message);
        res.status(500).json({ message: `Failed to fetch alerts: ${err.message}` });
    }
};

// Create a new price alert
const createAlert = async (req, res) => {
    try {
        const userId = req.user.id;
        const { symbol, type, targetPrice } = req.body;

        // Validate input
        if (!symbol || !type || !targetPrice) {
            return res.status(400).json({ message: 'symbol, type, and targetPrice are required' });
        }

        if (!['above', 'below'].includes(type)) {
            return res.status(400).json({ message: 'type must be "above" or "below"' });
        }

        const price = parseFloat(targetPrice);
        if (isNaN(price) || price <= 0) {
            return res.status(400).json({ message: 'targetPrice must be a positive number' });
        }

        // Insert alert
        const [result] = await db.execute(
            `INSERT INTO alerts (user_id, symbol, type, target_price, status, created_at)
             VALUES (?, ?, ?, ?, ?, NOW())`,
            [userId, symbol, type, price, 'active']
        );

        const alertId = result.insertId;
        console.log(`[Alert] ✅ Created alert #${alertId} for ${symbol} ${type} ₹${price}`);

        // ✅ Invalidate in-memory alert cache
        const alertMonitor = require('../services/alertMonitorService');
        alertMonitor.invalidateCache();

        res.json({
            id: alertId,
            user_id: userId,
            symbol,
            type,
            targetPrice: price,  // ✅ camelCase
            status: 'active',
            createdAt: new Date().toISOString(),  // ✅ camelCase
            triggeredAt: null
        });
    } catch (err) {
        console.error('❌ Create alert error:', err.message);
        res.status(500).json({ message: `Failed to create alert: ${err.message}` });
    }
};

// Update alert status (active/triggered)
const updateAlertStatus = async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;
        const { status } = req.body;

        if (!['active', 'triggered', 'inactive'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status' });
        }

        // Verify ownership
        const [alerts] = await db.execute(
            'SELECT * FROM alerts WHERE id = ? AND user_id = ?',
            [id, userId]
        );

        if (alerts.length === 0) {
            return res.status(404).json({ message: 'Alert not found' });
        }

        // Update status and set triggered_at if status is triggered
        const triggeredAt = status === 'triggered' ? new Date() : null;
        await db.execute(
            'UPDATE alerts SET status = ?, triggered_at = ? WHERE id = ?',
            [status, triggeredAt, id]
        );

        // ✅ Clear alert from in-memory triggered state if being reset to 'active'
        if (status === 'active') {
            const alertMonitor = require('../services/alertMonitorService');
            alertMonitor.resetAlert(parseInt(id));
            console.log(`[Alert] 🔄 Cleared in-memory state for alert #${id}`);
        }

        console.log(`[Alert] ✅ Updated alert #${id} status to ${status}`);
        res.json({
            message: 'Alert status updated',
            id,
            status,
            triggeredAt: triggeredAt ? triggeredAt.toISOString() : null
        });
    } catch (err) {
        console.error('❌ Update alert status error:', err.message);
        res.status(500).json({ message: `Failed to update alert: ${err.message}` });
    }
};

// Delete an alert
const deleteAlert = async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;

        // Verify ownership
        const [alerts] = await db.execute(
            'SELECT * FROM alerts WHERE id = ? AND user_id = ?',
            [id, userId]
        );

        if (alerts.length === 0) {
            return res.status(404).json({ message: 'Alert not found' });
        }

        // Delete alert
        await db.execute('DELETE FROM alerts WHERE id = ?', [id]);

        // ✅ Remove alert from in-memory triggered state
        const alertMonitor = require('../services/alertMonitorService');
        alertMonitor.removeAlert(parseInt(id));

        console.log(`[Alert] ✅ Deleted alert #${id}`);
        res.json({ message: 'Alert deleted successfully' });
    } catch (err) {
        console.error('❌ Delete alert error:', err.message);
        res.status(500).json({ message: `Failed to delete alert: ${err.message}` });
    }
};

// Get alert settings
const getAlertSettings = async (req, res) => {
    try {
        const userId = req.user.id;

        // Get or create settings
        const [settings] = await db.execute(
            'SELECT settings_json FROM user_alert_settings WHERE user_id = ?',
            [userId]
        );

        if (settings.length > 0) {
            try {
                const parsedSettings = JSON.parse(settings[0].settings_json || '{}');
                return res.json(parsedSettings);
            } catch (e) {
                return res.json({});
            }
        }

        // Default settings
        res.json({
            priceAlerts: true,
            percentChange: true,
            marketTiming: true,
            technical: false,
            tradeAlerts: true,
            percentThreshold: 2
        });
    } catch (err) {
        console.error('❌ Get alert settings error:', err.message);
        res.status(500).json({ message: `Failed to fetch settings: ${err.message}` });
    }
};

// Update alert settings
const updateAlertSettings = async (req, res) => {
    try {
        const userId = req.user.id;
        const settings = req.body;

        if (!settings || Object.keys(settings).length === 0) {
            return res.status(400).json({ message: 'Settings object is required' });
        }

        const settingsJson = JSON.stringify(settings);

        // Try to update, if no row exists, insert
        const [existing] = await db.execute(
            'SELECT id FROM user_alert_settings WHERE user_id = ?',
            [userId]
        );

        if (existing.length > 0) {
            await db.execute(
                'UPDATE user_alert_settings SET settings_json = ? WHERE user_id = ?',
                [settingsJson, userId]
            );
        } else {
            await db.execute(
                'INSERT INTO user_alert_settings (user_id, settings_json) VALUES (?, ?)',
                [userId, settingsJson]
            );
        }

        console.log(`[Alert] ✅ Updated settings for user #${userId}`);
        res.json({ message: 'Settings updated successfully', settings });
    } catch (err) {
        console.error('❌ Update alert settings error:', err.message);
        res.status(500).json({ message: `Failed to update settings: ${err.message}` });
    }
};

// Test endpoint - manually trigger alerts for debugging
const testAlertTrigger = async (req, res) => {
    try {
        const { symbol, ltp } = req.body;

        if (!symbol || !ltp) {
            return res.status(400).json({ message: 'symbol and ltp are required' });
        }

        console.log(`\n🧪 TEST: Manually triggering alert check for ${symbol} @ ₹${ltp}\n`);

        // Import alert monitor and test it
        const alertMonitor = require('../services/alertMonitorService');
        await alertMonitor.checkAlerts(symbol, parseFloat(ltp));

        res.json({
            message: 'Test alert check completed',
            symbol,
            ltp: parseFloat(ltp),
            checkTime: new Date().toISOString()
        });
    } catch (err) {
        console.error('❌ Test alert error:', err.message);
        res.status(500).json({ message: `Failed to test alert: ${err.message}` });
    }
};

// Diagnostic endpoint - check system status
const getAlertDiagnostics = async (req, res) => {
    try {
        // Get all active alerts
        const [allAlerts] = await db.execute(
            'SELECT id, user_id, symbol, type, target_price, status FROM alerts WHERE status = "active"'
        );

        // Get alert monitor state
        const alertMonitor = require('../services/alertMonitorService');
        const marketDataService = require('../services/MarketDataService');

        const diagnostics = {
            timestamp: new Date().toISOString(),
            activeAlerts: allAlerts.length,
            alerts: allAlerts.map(a => ({
                id: a.id,
                symbol: a.symbol,
                type: a.type,
                targetPrice: a.target_price,
                status: a.status
            })),
            alertMonitor: {
                initialized: !!alertMonitor.io,
                triggeredAlertsCount: alertMonitor.triggeredAlerts?.size || 0
            },
            message: 'Check backend console for detailed price update logs'
        };

        res.json(diagnostics);
    } catch (err) {
        console.error('❌ Diagnostic error:', err.message);
        res.status(500).json({ message: `Failed to get diagnostics: ${err.message}` });
    }
};

module.exports = {
    getAlerts,
    createAlert,
    updateAlertStatus,
    deleteAlert,
    getAlertSettings,
    updateAlertSettings,
    testAlertTrigger,
    getAlertDiagnostics
};
