const express = require('express');
const router = express.Router();
const { createFund, getFunds, updateFund, deleteFund } = require('../controllers/fundController');
const { authMiddleware, roleMiddleware, brokerPermission } = require('../middleware/auth');

router.post('/', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN', 'BROKER']), brokerPermission('payinAllowed'), createFund);
router.get('/', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN', 'BROKER']), getFunds);
router.put('/:id', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), updateFund);
router.delete('/:id', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), deleteFund);

module.exports = router;
