const express = require('express');
const router = express.Router();
const { getNewClientBank, updateNewClientBank } = require('../controllers/newClientBankController');
const { authMiddleware, roleMiddleware } = require('../middleware/auth');

router.get('/', authMiddleware, getNewClientBank);
router.put('/', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), updateNewClientBank);

module.exports = router;
