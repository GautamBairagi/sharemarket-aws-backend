const express = require('express');
const router = express.Router();
const multer = require('multer');
const {
    getUsers, getUserProfile, updateStatus, deleteUser, updatePasswords, resetPassword,
    updateUser, updateClientSettings, getBrokerShares, updateBrokerShares,
    getDocuments, updateDocuments, getUserSegments, updateUserSegments, getBrokerClients,
    resetAccount, recalculateBrokerage, saveWatchlist, getWatchlist, getWeeklyBalance
} = require('../controllers/userController');
const { authMiddleware, roleMiddleware, brokerPermission, brokerSharesPermission } = require('../middleware/auth');

// Multer setup - memory storage for ImageKit uploads
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB limit

// ─── EXISTING ROUTES ─────────────────────────────────
router.get('/', authMiddleware, getUsers);
router.get('/:id', authMiddleware, getUserProfile);
router.get('/:id/weekly-balance', authMiddleware, getWeeklyBalance);
router.put('/:id/status', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN', 'BROKER']), updateStatus);
router.delete('/:id', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN', 'BROKER']), deleteUser);
router.put('/:id/passwords', authMiddleware, brokerPermission('createClientsAllowed'), updatePasswords);
router.post('/:id/reset-password', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN', 'BROKER']), brokerPermission('createClientsAllowed'), resetPassword);
router.post('/:id/reset-account', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), resetAccount);
router.post('/:id/recalculate-brokerage', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), recalculateBrokerage);

// ─── NEW ROUTES ───────────────────────────────────────
router.put('/:id', authMiddleware, brokerPermission('createClientsAllowed'), updateUser);
router.put('/:id/settings', authMiddleware, brokerPermission('createClientsAllowed'), updateClientSettings);
router.get('/:id/broker-clients', authMiddleware, getBrokerClients);
router.get('/:id/broker-shares', authMiddleware, getBrokerShares);
router.put('/:id/broker-shares', authMiddleware, brokerSharesPermission(), updateBrokerShares);
router.get('/:id/documents', authMiddleware, getDocuments);
router.put('/:id/documents', authMiddleware, upload.fields([
    { name: 'panScreenshot', maxCount: 1 },
    { name: 'aadharFront', maxCount: 1 },
    { name: 'aadharBack', maxCount: 1 },
    { name: 'bankProof', maxCount: 1 }
]), updateDocuments);
router.get('/:id/segments', authMiddleware, getUserSegments);
router.put('/:id/segments', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), updateUserSegments);

// ─── WATCHLIST PERSISTENCE ────────────────────────────
router.get('/me/watchlist', authMiddleware, getWatchlist);
router.post('/me/watchlist', authMiddleware, saveWatchlist);

module.exports = router;
