const express = require('express');
const router = express.Router();
const { authMiddleware, roleMiddleware } = require('../middleware/auth');
const {
    getMenuPermissions,
    saveMenuPermissions,
    savePanelSettings,
    getPanelSettings,
    getTheme,
    saveTheme,
    uploadLogoMiddleware,
    uploadPanelFilesMiddleware,
    uploadLogo,
    getLogo,
    getInitData,
    triggerWeeklyClosing
} = require('../controllers/adminController');

// Init data — all authenticated users call this after login
router.get('/init', authMiddleware, getInitData);

// Weekly Closing / Settlement - SUPERADMIN and ADMIN only
router.post('/weekly-settlement', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), triggerWeeklyClosing);

// Menu Permissions — SUPERADMIN only
router.get('/menu-permissions/:userId', authMiddleware, roleMiddleware(['SUPERADMIN']), getMenuPermissions);
router.post('/menu-permissions/:userId', authMiddleware, roleMiddleware(['SUPERADMIN']), saveMenuPermissions);

// Per-admin panel settings (theme + logo) — SUPERADMIN only
router.post('/panel-settings/:userId', authMiddleware, roleMiddleware(['SUPERADMIN']), uploadPanelFilesMiddleware, savePanelSettings);
router.get('/panel-settings/:userId', authMiddleware, roleMiddleware(['SUPERADMIN']), getPanelSettings);

// Theme — read: any authenticated, write: SUPERADMIN only
router.get('/theme', authMiddleware, getTheme);
router.post('/theme', authMiddleware, roleMiddleware(['SUPERADMIN']), saveTheme);

// Logo — read: public, write: SUPERADMIN only
router.get('/logo', getLogo);
router.post('/logo', authMiddleware, roleMiddleware(['SUPERADMIN']), uploadLogoMiddleware, uploadLogo);

module.exports = router;
