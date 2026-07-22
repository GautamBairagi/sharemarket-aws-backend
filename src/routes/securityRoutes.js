const express = require('express');
const router = express.Router();
const { getIpClusters, getTradeIpAudit, getRiskScoring, getIpLogins } = require('../controllers/securityController');
const { deleteIpLogin } = require('../controllers/securityController');
const { authMiddleware, roleMiddleware } = require('../middleware/auth');

// Only Superadmins and Admins can access forensic data
router.get('/clusters', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), getIpClusters);
router.get('/trade-audit', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), getTradeIpAudit);
router.get('/ip-tracking', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), getIpLogins);
router.delete('/ip-tracking/:id', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), deleteIpLogin);

module.exports = router;
// Forensic audit routes finalized
