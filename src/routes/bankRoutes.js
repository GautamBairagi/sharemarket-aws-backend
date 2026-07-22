const express = require('express');
const router = express.Router();
const { getBanks, createBank, updateBank, deleteBank, toggleBankStatus } = require('../controllers/bankController');
const { authMiddleware, roleMiddleware } = require('../middleware/auth');

const adminOnly = roleMiddleware(['SUPERADMIN', 'ADMIN']);

router.get('/', authMiddleware, getBanks);
router.post('/', authMiddleware, adminOnly, createBank);
router.put('/:id', authMiddleware, adminOnly, updateBank);
router.delete('/:id', authMiddleware, adminOnly, deleteBank);
router.patch('/:id/toggle-status', authMiddleware, adminOnly, toggleBankStatus);

module.exports = router;
