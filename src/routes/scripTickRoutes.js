const express = require('express');
const router = express.Router();
const scripTickController = require('../controllers/scripTickController');
const { authMiddleware } = require('../middleware/auth');

// Get list of all scrip symbols
router.get('/scrips', authMiddleware, scripTickController.getScripList);

// Get filtered tick history
router.get('/history', authMiddleware, scripTickController.getTickHistory);

// Get export settings
router.get('/settings', authMiddleware, scripTickController.getExportSettings);

// Update export settings
router.post('/settings', authMiddleware, scripTickController.updateExportSettings);

// Download PDF directly
router.get('/export-pdf', authMiddleware, scripTickController.downloadPdf);

// Manual trigger for PDF export & database cleanup
router.post('/cleanup', authMiddleware, scripTickController.triggerCleanup);

// Get total database tick records count
router.get('/total-count', authMiddleware, scripTickController.getTotalDbCount);

module.exports = router;

