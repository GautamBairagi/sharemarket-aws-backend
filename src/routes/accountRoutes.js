const express = require('express');
const router = express.Router();
const { getHierarchyAccounts, getNegativeBalances } = require('../controllers/accountController');
const { authMiddleware, roleMiddleware } = require('../middleware/auth');

router.get('/hierarchy', authMiddleware, getHierarchyAccounts);
router.get('/negative-alerts', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), getNegativeBalances);

module.exports = router;
