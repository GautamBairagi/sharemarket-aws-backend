const express = require('express');
const router = express.Router();
const {
    getAlerts,
    createAlert,
    updateAlertStatus,
    deleteAlert,
    getAlertSettings,
    updateAlertSettings,
    testAlertTrigger,
    getAlertDiagnostics
} = require('../controllers/alertController');
const { authMiddleware } = require('../middleware/auth');

// Get all alerts for user
router.get('/', authMiddleware, getAlerts);

// Create new alert
router.post('/', authMiddleware, createAlert);

// Get alert settings
router.get('/settings', authMiddleware, getAlertSettings);

// Update alert settings
router.put('/settings', authMiddleware, updateAlertSettings);

// TEST ENDPOINT - Get system diagnostics
router.get('/test/diagnostics', authMiddleware, getAlertDiagnostics);

// TEST ENDPOINT - Manually test alert triggering (for debugging)
router.post('/test/trigger', authMiddleware, testAlertTrigger);

// Update alert status (must be before /:id to avoid conflicts)
router.put('/:id', authMiddleware, updateAlertStatus);

// Delete alert
router.delete('/:id', authMiddleware, deleteAlert);

module.exports = router;
