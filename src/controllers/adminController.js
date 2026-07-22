const db = require('../config/db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { uploadFile } = require('../utils/imagekit');

// Tables are now created by src/config/migrate.js on server startup.

// ─── UPLOAD SETUP ─────────────────────────────────
// Use memoryStorage so files are buffered in memory for ImageKit uplo
const storage = multer.memoryStorage();

const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        // Only process logo, profileImage, and bgImage fields
        if (file.fieldname !== 'logo' && file.fieldname !== 'profileImage' && file.fieldname !== 'bgImage') {
            return cb(null, false); // skip unknown fields silently
        }
        const mimeOk = /^image\//.test(file.mimetype);
        cb(null, mimeOk); // accept images, discard non-images without throwing
    },
    limits: { fileSize: 5 * 1024 * 1024 },
});

// Accepts both logo and profileImage fields
const uploadPanelFilesMiddleware = upload.fields([
    { name: 'logo',         maxCount: 1 },
    { name: 'profileImage', maxCount: 1 },
    { name: 'bgImage',      maxCount: 1 },
]);

// Keep old single-field middleware for legacy /logo route
const uploadLogoMiddleware = upload.single('logo');

// ─── MENU PERMISSIONS ─────────────────────────────────

const getMenuPermissions = async (req, res) => {
    const { userId } = req.params;
    try {
        const [rows] = await db.execute(
            'SELECT menu_id FROM admin_menu_permissions WHERE user_id = ?',
            [userId]
        );
        res.json({ menuPermissions: rows.map(r => r.menu_id) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

const saveMenuPermissions = async (req, res) => {
    const { userId } = req.params;
    const { menuPermissions } = req.body;
    try {
        await db.execute('DELETE FROM admin_menu_permissions WHERE user_id = ?', [userId]);
        if (menuPermissions && menuPermissions.length > 0) {
            const values = menuPermissions.map(menuId => [parseInt(userId), menuId]);
            await db.query('INSERT INTO admin_menu_permissions (user_id, menu_id) VALUES ?', [values]);
        }
        res.json({ message: 'Permissions saved' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

// ─── PER-ADMIN PANEL SETTINGS (theme + logo + profileImage) ───────────────────
// POST /api/admin/panel-settings/:userId
// Body: multipart — theme (JSON string), logo (file, optional), profileImage (file, optional)

const savePanelSettings = async (req, res) => {
    const { userId } = req.params;
    try {
        // Parse theme JSON
        let themeJson = null;
        if (req.body.theme) {
            try {
                JSON.parse(req.body.theme); // validate
                themeJson = req.body.theme;
            } catch (_) {}
        }

        // Handle logo file - Upload to ImageKit
        let logoPath = null;
        const logoFile = req.files?.logo?.[0];
        console.log(`[savePanelSettings] req.files keys:`, req.files ? Object.keys(req.files) : 'none');
        console.log(`[savePanelSettings] logoFile exists:`, !!logoFile);

        if (logoFile) {
            try {
                console.log(`[Logo Upload] Starting upload for admin ${userId}...`);
                console.log(`[Logo Upload] File: ${logoFile.originalname}, Size: ${logoFile.size} bytes, Mimetype: ${logoFile.mimetype}`);

                const result = await uploadFile(
                    logoFile.buffer,
                    `logo-${userId}-${Date.now()}`,
                    '/admin/logos'
                );

                console.log(`[Logo Upload] uploadFile returned:`, result);

                if (result && result.url) {
                    logoPath = result.url;
                    console.log(`[Logo Upload] ✅ Success! URL: ${logoPath}`);
                } else {
                    console.error(`[Logo Upload] ❌ uploadFile returned null or no URL:`, result);
                    logoPath = null;
                }
            } catch (err) {
                console.error(`[Logo Upload] ❌ ERROR:`, {
                    message: err.message,
                    code: err.code,
                    stack: err.stack
                });
                logoPath = null;
            }
        } else {
            console.log(`[Logo Upload] ⚠️ No logo file provided for admin ${userId}`);
        }

        // Handle profile image file - Upload to ImageKit
        let profileImagePath = null;
        const profileFile = req.files?.profileImage?.[0];
        if (profileFile) {
            try {
                const result = await uploadFile(
                    profileFile.buffer,
                    `profile-${userId}`,
                    '/admin/profiles'
                );
                profileImagePath = result.url;
            } catch (err) {
                console.error('Profile image upload failed:', err.message);
            }
        }

        // Handle background image file - Upload to ImageKit
        let bgImagePath = null;
        const bgFile = req.files?.bgImage?.[0];
        console.log(`[BG Image Upload] bgFile exists:`, !!bgFile);

        if (bgFile) {
            try {
                console.log(`[BG Image Upload] Starting upload for admin ${userId}...`);
                console.log(`[BG Image Upload] File: ${bgFile.originalname}, Size: ${bgFile.size} bytes`);

                const result = await uploadFile(
                    bgFile.buffer,
                    `bg-${userId}-${Date.now()}`,
                    '/admin/backgrounds'
                );

                console.log(`[BG Image Upload] uploadFile returned:`, result);

                if (result && result.url) {
                    bgImagePath = result.url;
                    console.log(`[BG Image Upload] ✅ Success! URL: ${bgImagePath}`);
                } else {
                    console.error(`[BG Image Upload] ❌ uploadFile returned null:`, result);
                    bgImagePath = null;
                }
            } catch (err) {
                console.error(`[BG Image Upload] ❌ ERROR:`, err.message);
                bgImagePath = null;
            }
        } else {
            console.log(`[BG Image Upload] ⚠️ No background image provided`);
        }

        // Build upsert — only update columns that were provided
        const cols = [];
        const vals = [];

        if (themeJson !== null)        { cols.push('theme_json');         vals.push(themeJson); }
        if (logoPath !== null)         { cols.push('logo_path');           vals.push(logoPath); }
        if (profileImagePath !== null) { cols.push('profile_image_path'); vals.push(profileImagePath); }
        if (bgImagePath !== null)      { cols.push('bg_image_path');      vals.push(bgImagePath); }

        console.log(`[savePanelSettings] Columns to update:`, cols);
        console.log(`[savePanelSettings] logoPath value:`, logoPath);

        // ✅ Simple approach: DELETE old record, then INSERT new one
        try {
            await db.execute('DELETE FROM admin_panel_settings WHERE user_id = ?', [userId]);
            console.log(`[savePanelSettings] Deleted old record for user ${userId}`);
        } catch (e) {
            console.log(`[savePanelSettings] No old record to delete (first time)`);
        }

        // Now INSERT with all values (even if some are null, that's okay)
        try {
            await db.execute(
                `INSERT INTO admin_panel_settings (user_id, theme_json, logo_path, bg_image_path)
                 VALUES (?, ?, ?, ?)`,
                [userId, themeJson, logoPath, bgImagePath]
            );
            console.log(`[savePanelSettings] ✅ Successfully inserted record`);
            console.log(`[savePanelSettings] Saved - theme: ${!!themeJson}, logo: ${!!logoPath}, bg: ${!!bgImagePath}`);
        } catch (err) {
            console.error(`[savePanelSettings] ❌ Database insert failed:`, err.message);
            return res.status(500).json({ message: 'Failed to save settings: ' + err.message });
        }

        // ✅ After saving to DB, fetch back to confirm what was actually saved
        const [savedRows] = await db.execute(
            'SELECT logo_path, bg_image_path FROM admin_panel_settings WHERE user_id = ?',
            [userId]
        );

        const savedLogoPath = savedRows[0]?.logo_path || null;
        const savedBgImagePath = savedRows[0]?.bg_image_path || null;

        console.log(`[savePanelSettings] FINAL SAVED IN DB - logoPath: ${savedLogoPath}, bgImagePath: ${savedBgImagePath}`);
        res.json({
            message: 'Panel settings saved',
            logoPath: savedLogoPath,
            bgImagePath: savedBgImagePath
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

// GET per-admin settings (SUPERADMIN use — to prefill edit form)
const getPanelSettings = async (req, res) => {
    const { userId } = req.params;
    try {
        const [rows] = await db.execute(
            'SELECT theme_json, logo_path, bg_image_path FROM admin_panel_settings WHERE user_id = ?',
            [userId]
        );
        let theme = {};
        let logoPath = null;
        let bgImagePath = null;
        if (rows[0]) {
            if (rows[0].theme_json) {
                try { theme = JSON.parse(rows[0].theme_json); } catch (_) {}
            }
            logoPath = rows[0].logo_path || null;
            bgImagePath = rows[0].bg_image_path || null;
        }
        res.json({ theme, logoPath, bgImagePath });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

// ─── INIT DATA (called once after login) ──────────────

const getInitData = async (req, res) => {
    try {
        const userId = req.user.id;
        const role = req.user.role;

        // Menu permissions — only for ADMIN role
        let menuPermissions = null;
        if (role === 'ADMIN') {
            const [rows] = await db.execute(
                'SELECT menu_id FROM admin_menu_permissions WHERE user_id = ?',
                [userId]
            );
            menuPermissions = rows.map(r => r.menu_id);
        }

        // Per-admin theme + logo — SUPERADMIN always gets empty (uses default)
        let theme = {};
        let logoPath = null;

        if (role === 'ADMIN') {
            const [rows] = await db.execute(
                'SELECT theme_json, logo_path FROM admin_panel_settings WHERE user_id = ?',
                [userId]
            );
            if (rows[0]) {
                if (rows[0].theme_json) {
                    try { theme = JSON.parse(rows[0].theme_json); } catch (_) {}
                }
                logoPath = rows[0].logo_path || null;
            }
        }

        res.json({ menuPermissions, theme, logoPath });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

// ─── LEGACY ENDPOINTS (kept for compatibility) ────────

const getTheme = async (req, res) => res.json({ theme: {} });
const saveTheme = async (req, res) => res.json({ message: 'Use /panel-settings/:userId instead' });
const getLogo = async (req, res) => res.json({ logoPath: null });
const uploadLogo = async (req, res) => res.json({ logoPath: null });

const triggerWeeklyClosing = async (req, res) => {
    try {
        const { runWeeklyClosing } = require('../services/WeeklySettlementService');
        // Admin can optionally pass a targetDate in request body to simulate or trigger for a specific date
        const targetDate = req.body.targetDate ? new Date(req.body.targetDate) : new Date();
        
        const result = await runWeeklyClosing(targetDate);
        res.json({
            message: 'Weekly closing settlement executed successfully',
            ...result
        });
    } catch (err) {
        console.error('Trigger Weekly Closing Error:', err);
        res.status(500).json({ message: 'Failed to execute weekly closing: ' + err.message });
    }
};

module.exports = {
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
};
