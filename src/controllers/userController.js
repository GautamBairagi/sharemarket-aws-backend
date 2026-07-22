const db = require('../config/db');
const bcrypt = require('bcryptjs');
const { logAction } = require('./systemController');
const { getFromCache, saveToCache, invalidateCache } = require('../utils/cacheManager');
const { getLotSize } = require('../utils/symbolHelper');

const { uploadFile, deleteFile } = require('../utils/imagekit');

const getUsers = async (req, res) => {
    try {
        const { role } = req.query;
        const currentUserId = req.user.id;
        const currentUserRole = req.user.role;

        console.log(`[getUsers] User ${currentUserId} (${currentUserRole}) requesting users with role filter: ${role || 'all'}`);

        // Try to get from cache first (safe: if fails, continues to DB query)
        const cacheKey = `users_${currentUserId}_${role || 'all'}`;
        try {
            const cachedData = await getFromCache(cacheKey);
            if (cachedData) {
                return res.json(cachedData);
            }
        } catch (cacheErr) {
            console.log(`[getUsers] Cache read failed, proceeding with DB query`);
        }

        let query = `
            SELECT
                u.*,
                p.username as parent_username,
                p.full_name as parent_name,
                u.balance as ledger_balance,
                u.credit_limit,
                IFNULL(ud.kyc_status, 'PENDING') as kycStatus,
                IFNULL((SELECT SUM(pnl) FROM trades WHERE user_id = u.id AND status = 'CLOSED'), 0.00) as gross_pl,
                IFNULL((SELECT SUM(brokerage) FROM trades WHERE user_id = u.id AND status = 'CLOSED'), 0.00) as brokerage,
                IFNULL((SELECT SUM(swap) FROM trades WHERE user_id = u.id AND status = 'CLOSED'), 0.00) as swap_charges,
                IFNULL((SELECT SUM(pnl - brokerage - swap) FROM trades WHERE user_id = u.id AND status = 'CLOSED'), 0.00) as net_pl,
                (SELECT COUNT(*) FROM trades WHERE user_id = u.id AND status = 'OPEN') as active_trades_count,
                cs.config_json,
                cs.broker_id
            FROM users u
            LEFT JOIN users p ON u.parent_id = p.id
            LEFT JOIN user_documents ud ON u.id = ud.user_id
            LEFT JOIN client_settings cs ON u.id = cs.user_id
            WHERE 1=1
        `;
        const params = [];

        // Apply hierarchy filtering based on role
        // SUPERADMIN/ADMIN: See only clients they created (parent_id = current user id)
        // BROKER: If viewing BROKER role, see sub-brokers (parent_id = current user id)
        //         If viewing TRADER role, see assigned clients (broker_id = current user id)
        // OTHERS: See only their own created clients (parent_id = current user id)

        if (role) {
            query += ' AND u.role = ?';
            params.push(role);
        }

        if (currentUserRole === 'SUPERADMIN') {
            // SUPERADMIN: See only users they directly created
            console.log(`[getUsers] SUPERADMIN ${currentUserId} viewing their own direct users`);
            query += ' AND u.parent_id = ?';
            params.push(currentUserId);
        } else if (currentUserRole === 'ADMIN') {
            // ADMIN: See users they created OR users assigned to their brokers
            query += ' AND (u.parent_id = ? OR u.id IN (SELECT user_id FROM client_settings WHERE broker_id IN (SELECT id FROM users WHERE parent_id = ?)))';
            params.push(currentUserId, currentUserId);
        } else if (currentUserRole === 'BROKER') {
            // BROKER: See users where they are the parent OR assigned broker
            query += ' AND (u.parent_id = ? OR cs.broker_id = ?)';
            params.push(currentUserId, currentUserId);
        } else {
            // Default/Trader/Other: See only themselves or their direct creations
            query += ' AND u.parent_id = ?';
            params.push(currentUserId);
        }

        console.log(`[getUsers] Executing query with params:`, params);

        const [rows] = await db.execute(query, params);
        console.log(`[getUsers] Returned ${rows.length} users`);

        // Save to cache (safe: if fails, response still sent)
        try {
            await saveToCache(cacheKey, rows, 300); // 5 min cache
        } catch (cacheErr) {
            console.log(`[getUsers] Cache save failed, but data sent`);
        }

        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const getUserProfile = async (req, res) => {
    try {
        const [userRows] = await db.execute(`
            SELECT 
                u.*,
                IFNULL((SELECT SUM(pnl) FROM trades WHERE user_id = u.id AND status = 'CLOSED'), 0.00) as gross_pl,
                IFNULL((SELECT SUM(brokerage) FROM trades WHERE user_id = u.id AND status = 'CLOSED'), 0.00) as brokerage,
                IFNULL((SELECT SUM(swap) FROM trades WHERE user_id = u.id AND status = 'CLOSED'), 0.00) as swap_charges,
                IFNULL((SELECT SUM(pnl - brokerage - swap) FROM trades WHERE user_id = u.id AND status = 'CLOSED'), 0.00) as net_pl
            FROM users u 
            WHERE u.id = ?
        `, [req.params.id]);
        if (userRows.length === 0) return res.status(404).json({ message: 'User not found' });

        const [settingsRows] = await db.execute('SELECT * FROM client_settings WHERE user_id = ?', [req.params.id]);
        const [brokerSharesRows] = await db.execute('SELECT * FROM broker_shares WHERE user_id = ?', [req.params.id]);
        const [segmentRows] = await db.execute('SELECT * FROM user_segments WHERE user_id = ?', [req.params.id]);
        const [docRows] = await db.execute('SELECT * FROM user_documents WHERE user_id = ?', [req.params.id]);

        const settings = settingsRows[0] || {};
        if (settings.config_json) {
            try { settings.config = JSON.parse(settings.config_json); } catch (e) { settings.config = {}; }
        }

        const brokerShares = brokerSharesRows[0] || {};
        if (brokerShares.permissions_json) {
            try { brokerShares.permissions = JSON.parse(brokerShares.permissions_json); } catch (e) { brokerShares.permissions = {}; }
        }
        if (brokerShares.segments_json) {
            try { brokerShares.segments = JSON.parse(brokerShares.segments_json); } catch (e) { brokerShares.segments = {}; }
        }

        res.json({
            profile: userRows[0],
            settings,
            brokerShares,
            segments: segmentRows,
            documents: docRows[0] || {}
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const updateStatus = async (req, res) => {
    const { status } = req.body;
    const targetUserId = req.params.id;
    const currentUserId = req.user.id;
    const currentUserRole = req.user.role;
    try {
        // Brokers can only update status for their own created users or assigned clients
        if (currentUserRole === 'BROKER') {
            const [userRows] = await db.execute(
                'SELECT id FROM users WHERE id = ? AND (parent_id = ? OR broker_id = ?)',
                [targetUserId, currentUserId, currentUserId]
            );
            if (userRows.length === 0) {
                return res.status(403).json({ message: 'You can only update status for your own clients' });
            }
        }

        await db.execute('UPDATE users SET status = ? WHERE id = ?', [status, targetUserId]);

        // Log the action
        await logAction(currentUserId, 'UPDATE_STATUS', 'users', `Updated status of user ID ${targetUserId} to ${status}`);

        // Invalidate caches
        try {
            await invalidateCache(`users_${currentUserId}_all`);
            await invalidateCache(`users_${currentUserId}_TRADER`);
            await invalidateCache(`users_${currentUserId}_BROKER`);
        } catch (e) { }

        res.json({ message: 'Status updated successfully' });
    } catch (err) {

        console.error(err);
        res.status(500).send('Server Error');
    }
};

const resetPassword = async (req, res) => {
    const { newPassword } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await db.execute('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, req.params.id]);

        // Log the action
        await logAction(req.user.id, 'RESET_PASSWORD', 'users', `Reset password for user ID ${req.params.id}`);

        res.json({ message: 'Password reset successfully' });
    } catch (err) {

        console.error(err);
        res.status(500).send('Server Error');
    }
};

const updatePasswords = async (req, res) => {
    const { newPassword, transactionPassword } = req.body;
    try {
        if (newPassword) {
            const hashedPassword = await bcrypt.hash(newPassword, 10);
            await db.execute('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, req.params.id]);
        }
        if (transactionPassword) {
            const hashedTransPassword = await bcrypt.hash(transactionPassword, 10);
            await db.execute('UPDATE users SET transaction_password = ? WHERE id = ?', [hashedTransPassword, req.params.id]);
        }
        res.json({ message: 'Passwords updated successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const deleteUser = async (req, res) => {
    try {
        const targetUserId = req.params.id;
        const currentUserId = req.user.id;
        const currentUserRole = req.user.role;

        // Brokers can only delete their own created users or assigned clients
        if (currentUserRole === 'BROKER') {
            const [userRows] = await db.execute(
                'SELECT id FROM users WHERE id = ? AND (parent_id = ? OR broker_id = ?)',
                [targetUserId, currentUserId, currentUserId]
            );
            if (userRows.length === 0) {
                return res.status(403).json({ message: 'You can only delete your own clients' });
            }
        }

        await db.execute('DELETE FROM users WHERE id = ?', [targetUserId]);

        // Log the action
        await logAction(currentUserId, 'DELETE_USER', 'users', `Deleted user ID ${targetUserId}`);

        // Invalidate caches
        try {
            await invalidateCache(`users_${currentUserId}_all`);
            await invalidateCache(`users_${currentUserId}_TRADER`);
            await invalidateCache(`users_${currentUserId}_BROKER`);
        } catch (e) { }

        res.json({ message: 'User deleted successfully' });
    } catch (err) {

        console.error(err);
        res.status(500).send('Server Error');
    }
};

// ─── UPDATE USER PROFILE ─────────────────────────────
const updateUser = async (req, res) => {
    const { fullName, email, mobile, city, creditLimit, exposureMultiplier, isDemo, status, parentId } = req.body;
    try {
        const fields = [];
        const values = [];

        if (fullName !== undefined) { fields.push('full_name = ?'); values.push(fullName); }
        if (email !== undefined) { fields.push('email = ?'); values.push(email); }
        if (mobile !== undefined) { fields.push('mobile = ?'); values.push(mobile); }
        if (city !== undefined) { fields.push('city = ?'); values.push(city); }
        if (creditLimit !== undefined) { fields.push('credit_limit = ?'); values.push(creditLimit); }
        if (exposureMultiplier !== undefined) { fields.push('exposure_multiplier = ?'); values.push(exposureMultiplier); }
        if (isDemo !== undefined) { fields.push('is_demo = ?'); values.push(isDemo ? 1 : 0); }
        if (status !== undefined) { fields.push('status = ?'); values.push(status); }
        if (parentId !== undefined) { fields.push('parent_id = ?'); values.push(parseInt(parentId) || null); }

        if (fields.length === 0) return res.status(400).json({ message: 'No fields to update' });

        values.push(req.params.id);
        await db.execute(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);

        // Log the action with summary of changes
        const summary = Object.keys(req.body).join(', ');
        await logAction(req.user.id, 'UPDATE_USER', 'users', `Updated user ID ${req.params.id}: modified ${summary}`);

        // Invalidate ALL user list caches to ensure consistency across all admins/brokers
        try {
            await invalidateCache(`users_${req.user.id}_all`);
            await invalidateCache(`users_${req.user.id}_TRADER`);
            await invalidateCache(`users_${req.user.id}_BROKER`);

            // Also invalidate the parent's cache if different
            if (parentId && parseInt(parentId) !== req.user.id) {
                await invalidateCache(`users_${parentId}_all`);
                await invalidateCache(`users_${parentId}_TRADER`);
                await invalidateCache(`users_${parentId}_BROKER`);
            }

            console.log(`[Cache] Cleared user list caches for updater ${req.user.id}`);
        } catch (e) {
            console.log(`[Cache] Clear failed but update succeeded`);
        }

        res.json({ message: 'User updated successfully' });
    } catch (err) {

        console.error(err);
        res.status(500).send('Server Error');
    }
};

// ─── CLIENT SETTINGS ─────────────────────────────────
const updateClientSettings = async (req, res) => {
    console.log('[DEBUG] REACHED updateClientSettings for user:', req.params.id);
    const {
        allowFreshEntry, allowOrdersBetweenHL, tradeEquityUnits,
        autoCloseEnabled, banAllSegmentLimitOrder,
        autoClosePct, notifyPct, minProfitTime, scalpingSlEnabled,
        brokerId,  // Broker assignment
        config  // full complex config JSON (all segment data)
    } = req.body;

    try {
        let configObj = config || {};
        if (autoCloseEnabled !== undefined) configObj.autoCloseEnabled = autoCloseEnabled;

        // ─── If broker is assigned, fetch & apply broker's segment config ─────
        if (brokerId) {
            console.log(`[updateClientSettings] Broker assigned (ID: ${brokerId}). Fetching broker's segment config...`);
            const [brokerSharesRows] = await db.execute(
                'SELECT segments_json FROM broker_shares WHERE user_id = ?',
                [brokerId]
            );

            if (brokerSharesRows.length > 0 && brokerSharesRows[0].segments_json) {
                try {
                    const brokerSegments = JSON.parse(brokerSharesRows[0].segments_json);
                    if (brokerSegments.segmentConfig) {
                        console.log(`[updateClientSettings] ✅ Applied broker's segment config to client`);
                        // Apply broker's segment configuration to client
                        configObj.brokerSegments = brokerSegments.segmentConfig;
                        configObj.brokerMcxMargins = brokerSegments.mcxMargins || {};
                        configObj.brokerMcxBrokerage = brokerSegments.mcxBrokerage || {};
                    }
                } catch (e) {
                    console.error(`[updateClientSettings] Failed to parse broker segments:`, e);
                }
            }
        }

        const configJson = Object.keys(configObj).length > 0 ? JSON.stringify(configObj) : null;

        const sqlParams = [
            req.params.id,
            allowFreshEntry !== undefined ? (allowFreshEntry == 1 || allowFreshEntry === true || allowFreshEntry === 'true' ? 1 : 0) : 1,
            allowOrdersBetweenHL !== undefined ? (allowOrdersBetweenHL == 1 || allowOrdersBetweenHL === true || allowOrdersBetweenHL === 'true' ? 1 : 0) : 1,
            tradeEquityUnits !== undefined ? (tradeEquityUnits == 1 || tradeEquityUnits === true || tradeEquityUnits === 'true' ? 1 : 0) : 0,
            autoClosePct !== undefined ? autoClosePct : 90,
            notifyPct !== undefined ? notifyPct : 70,
            minProfitTime !== undefined ? minProfitTime : 120,
            scalpingSlEnabled !== undefined ? (scalpingSlEnabled === true || scalpingSlEnabled === 'Enabled' || scalpingSlEnabled == 1 ? 1 : 0) : 0,
            banAllSegmentLimitOrder !== undefined ? (banAllSegmentLimitOrder == 1 || banAllSegmentLimitOrder === true || banAllSegmentLimitOrder === 'true' ? 1 : 0) : 0,
            configJson,
            brokerId || null
        ];
        console.log('[DEBUG] SQL Params for Client Settings:', sqlParams);

        await db.execute(`
            INSERT INTO client_settings
                (user_id, allow_fresh_entry, allow_orders_between_hl, trade_equity_units,
                 auto_close_at_m2m_pct, notify_at_m2m_pct, min_time_to_book_profit,
                 scalping_sl_enabled, ban_all_segment_limit_order, config_json, broker_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                allow_fresh_entry = VALUES(allow_fresh_entry),
                allow_orders_between_hl = VALUES(allow_orders_between_hl),
                trade_equity_units = VALUES(trade_equity_units),
                auto_close_at_m2m_pct = VALUES(auto_close_at_m2m_pct),
                notify_at_m2m_pct = VALUES(notify_at_m2m_pct),
                min_time_to_book_profit = VALUES(min_time_to_book_profit),
                scalping_sl_enabled = VALUES(scalping_sl_enabled),
                ban_all_segment_limit_order = VALUES(ban_all_segment_limit_order),
                config_json = VALUES(config_json),
                broker_id = VALUES(broker_id)
        `, sqlParams);

        // ─── SYNC to user_segments table for mobile app consistency ─────
        if (configObj) {
            const userId = req.params.id;
            const segmentsToSync = [
                { name: 'MCX', enabled: configObj.mcxTrading, bType: configObj.mcxBrokerageType, bVal: configObj.mcxBrokerage, maxLot: configObj.mcxMaxLotScrip, exp: configObj.mcxExposureMultiplier },
                { name: 'EQUITY', enabled: configObj.equityTrading, bType: 'PER_LOT', bVal: configObj.equityBrokerage, maxLot: configObj.equityMaxScrip, exp: configObj.equityExposureMultiplier },
                { name: 'OPTIONS', enabled: configObj.indexOptionsTrading || configObj.equityOptionsTrading, bType: configObj.optionsIndexBrokerageType, bVal: configObj.optionsIndexBrokerage, maxLot: configObj.optionsIndexMaxScrip, exp: 1 },
                { name: 'COMEX', enabled: configObj.comexTrading, bType: configObj.comexConfig?.brokerageType || 'PER_LOT', bVal: configObj.comexConfig?.brokerage || configObj.comexBrokerage, maxLot: configObj.comexConfig?.maxLotScrip || configObj.maxLotComex, exp: 1 },
                { name: 'FOREX', enabled: configObj.forexTrading, bType: configObj.forexConfig?.brokerageType || 'PER_LOT', bVal: configObj.forexConfig?.brokerage || configObj.forexBrokerage, maxLot: configObj.forexConfig?.maxLotScrip || configObj.maxLotForex, exp: 1 },
                { name: 'CRYPTO', enabled: configObj.cryptoTrading, bType: configObj.cryptoConfig?.brokerageType || 'PER_LOT', bVal: configObj.cryptoConfig?.brokerage || configObj.cryptoBrokerage, maxLot: configObj.cryptoConfig?.maxLotScrip || configObj.maxLotCrypto, exp: 1 }
            ];

            console.log('[updateClientSettings] Syncing segments for user', userId, ':', segmentsToSync.map(s => ({ name: s.name, enabled: s.enabled, bVal: s.bVal, maxLot: s.maxLot })));

            for (const s of segmentsToSync) {
                if (s.enabled !== undefined || s.bVal !== undefined) {
                    await db.execute(`
                        INSERT INTO user_segments (user_id, segment, is_enabled, brokerage_type, brokerage_value, max_lot_per_scrip, exposure_multiplier)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE
                            is_enabled = IFNULL(VALUES(is_enabled), is_enabled),
                            brokerage_type = IFNULL(VALUES(brokerage_type), brokerage_type),
                            brokerage_value = IFNULL(VALUES(brokerage_value), brokerage_value),
                            max_lot_per_scrip = IFNULL(VALUES(max_lot_per_scrip), max_lot_per_scrip),
                            exposure_multiplier = IFNULL(VALUES(exposure_multiplier), exposure_multiplier)
                    `, [userId, s.name, s.enabled ? 1 : 0, s.bType || 'PER_LOT', s.bVal || 0, s.maxLot || 10, s.exp || 1]);
                }
            }
        }

        res.json({ message: 'Client settings updated' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

// ─── BROKER SHARES ───────────────────────────────────
const getBrokerShares = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM broker_shares WHERE user_id = ?', [req.params.id]);
        const data = rows[0] || {};
        if (data.permissions_json) {
            try { data.permissions = JSON.parse(data.permissions_json); } catch (e) { data.permissions = {}; }
        }
        if (data.segments_json) {
            try { data.segments = JSON.parse(data.segments_json); } catch (e) { data.segments = {}; }
        }
        res.json(data);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const updateBrokerShares = async (req, res) => {
    const {
        sharePL, shareBrokerage, shareSwap, brokerageType,
        tradingClientsLimit, subBrokersLimit, permissions, segments, swapRate
    } = req.body;

    try {
        await db.execute(`
            INSERT INTO broker_shares
                (user_id, share_pl_pct, share_brokerage_pct, share_swap_pct,
                 brokerage_type, trading_clients_limit, sub_brokers_limit,
                 permissions_json, segments_json, swap_rate)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                share_pl_pct = VALUES(share_pl_pct),
                share_brokerage_pct = VALUES(share_brokerage_pct),
                share_swap_pct = VALUES(share_swap_pct),
                brokerage_type = VALUES(brokerage_type),
                trading_clients_limit = VALUES(trading_clients_limit),
                sub_brokers_limit = VALUES(sub_brokers_limit),
                permissions_json = VALUES(permissions_json),
                segments_json = VALUES(segments_json),
                swap_rate = VALUES(swap_rate)
        `, [
            req.params.id,
            sharePL || 0,
            shareBrokerage || 50,
            shareSwap || 10,
            brokerageType || 'Percentage',
            tradingClientsLimit || 10,
            subBrokersLimit || 3,
            permissions ? JSON.stringify(permissions) : null,
            segments ? JSON.stringify(segments) : null,
            swapRate || 5  // Default ₹5 per lot per day
        ]);

        res.json({ message: 'Broker shares updated' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

// ─── DOCUMENTS ───────────────────────────────────────
const getDocuments = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM user_documents WHERE user_id = ?', [req.params.id]);
        res.json(rows[0] || {});
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const updateDocuments = async (req, res) => {
    const { panNumber, aadharNumber, kycStatus } = req.body;
    const files = req.files || {};

    try {
        // Upload files to ImageKit
        let panScreenshot, aadharFront, aadharBack, bankProof;

        if (files.panScreenshot && files.panScreenshot[0]) {
            const result = await uploadFile(files.panScreenshot[0].buffer, files.panScreenshot[0].originalname, `/traders/kyc/${req.params.id}`);
            panScreenshot = result.url;
        }
        if (files.aadharFront && files.aadharFront[0]) {
            const result = await uploadFile(files.aadharFront[0].buffer, files.aadharFront[0].originalname, `/traders/kyc/${req.params.id}`);
            aadharFront = result.url;
        }
        if (files.aadharBack && files.aadharBack[0]) {
            const result = await uploadFile(files.aadharBack[0].buffer, files.aadharBack[0].originalname, `/traders/kyc/${req.params.id}`);
            aadharBack = result.url;
        }
        if (files.bankProof && files.bankProof[0]) {
            const result = await uploadFile(files.bankProof[0].buffer, files.bankProof[0].originalname, `/traders/kyc/${req.params.id}`);
            bankProof = result.url;
        }

        // Build dynamic upsert
        const setFields = ['user_id = ?'];
        const values = [req.params.id];

        if (panNumber !== undefined) { setFields.push('pan_number = ?'); values.push(panNumber); }
        if (aadharNumber !== undefined) { setFields.push('aadhar_number = ?'); values.push(aadharNumber); }
        if (kycStatus !== undefined) { setFields.push('kyc_status = ?'); values.push(kycStatus); }
        if (panScreenshot !== undefined) { setFields.push('pan_screenshot = ?'); values.push(panScreenshot); }
        if (aadharFront !== undefined) { setFields.push('aadhar_front = ?'); values.push(aadharFront); }
        if (aadharBack !== undefined) { setFields.push('aadhar_back = ?'); values.push(aadharBack); }
        if (bankProof !== undefined) { setFields.push('bank_proof = ?'); values.push(bankProof); }

        // Safety: If no documents are being updated (only user_id is in setFields), return early
        if (setFields.length <= 1 && panNumber === undefined && aadharNumber === undefined && kycStatus === undefined) {
            return res.json({ message: 'No changes detected' });
        }

        await db.execute(`
            INSERT INTO user_documents (${setFields.map(f => f.split(' = ?')[0]).join(', ')})
            VALUES (${values.map(() => '?').join(', ')})
            ON DUPLICATE KEY UPDATE
                ${setFields.filter(f => !f.startsWith('user_id')).join(', ')}
        `, [...values, ...values.slice(1).filter((v, i) => !setFields[i + 1].startsWith('user_id'))]);

        // Return the uploaded URLs so frontend can display them
        res.json({
            message: 'Documents updated',
            urls: {
                panScreenshot: panScreenshot || undefined,
                aadharFront: aadharFront || undefined,
                aadharBack: aadharBack || undefined,
                bankProof: bankProof || undefined
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

// ─── USER SEGMENTS ───────────────────────────────────
const getUserSegments = async (req, res) => {
    try {
        let [rows] = await db.execute('SELECT * FROM user_segments WHERE user_id = ?', [req.params.id]);

        // Check if rows are all disabled — brokerage value is irrelevant here.
        // Previously this also checked brokerage_value === 0, which caused a bug:
        // user_segments could have is_enabled=0 with non-zero brokerage (set up but not yet enabled),
        // making isDefault=false and skipping the config_json fallback entirely, so the mobile
        // app would always see DISABLED even after the broker enabled the segments in config_json.
        const isDefault = rows.length > 0 && rows.every(r => r.is_enabled === 0);

        if (rows.length === 0 || isDefault) {
            console.log(`[getUserSegments] Fallback: user_segments is default/empty for user ${req.params.id}. Checking client_settings...`);
            const [settingsRows] = await db.execute('SELECT config_json FROM client_settings WHERE user_id = ?', [req.params.id]);

            if (settingsRows.length > 0 && settingsRows[0].config_json) {
                try {
                    const config = JSON.parse(settingsRows[0].config_json);

                    const mappedSegments = [
                        { segment: 'MCX', is_enabled: config.mcxTrading ? 1 : 0, brokerage_type: config.mcxBrokerageType || 'PER_LOT', brokerage_value: config.mcxBrokerage || 0, max_lot_per_scrip: config.mcxMaxLotScrip || 0, exposure_multiplier: config.mcxExposureMultiplier || 1, auto_square_off: config.autoSquareOff === 'Yes' ? 1 : 0, square_off_time: config.expirySquareOffTime },
                        { segment: 'EQUITY', is_enabled: config.equityTrading ? 1 : 0, brokerage_type: 'PER_LOT', brokerage_value: config.equityBrokerage || 0, max_lot_per_scrip: config.equityMaxScrip || 0, exposure_multiplier: config.equityExposureMultiplier || 1, auto_square_off: config.autoSquareOff === 'Yes' ? 1 : 0, square_off_time: config.expirySquareOffTime },
                        { segment: 'OPTIONS', is_enabled: (config.indexOptionsTrading || config.equityOptionsTrading) ? 1 : 0, brokerage_type: config.optionsIndexBrokerageType || 'PER_LOT', brokerage_value: config.optionsIndexBrokerage || 0, max_lot_per_scrip: config.optionsIndexMaxScrip || 0, exposure_multiplier: 1, auto_square_off: config.autoSquareOff === 'Yes' ? 1 : 0, square_off_time: config.expirySquareOffTime },
                        { segment: 'COMEX', is_enabled: config.comexTrading ? 1 : 0, brokerage_type: config.comexConfig?.brokerageType || 'PER_LOT', brokerage_value: config.comexConfig?.brokerage || 0, max_lot_per_scrip: config.comexConfig?.maxLotScrip || 0, exposure_multiplier: 1, auto_square_off: config.autoSquareOff === 'Yes' ? 1 : 0, square_off_time: config.expirySquareOffTime },
                        { segment: 'FOREX', is_enabled: config.forexTrading ? 1 : 0, brokerage_type: config.forexConfig?.brokerageType || 'PER_LOT', brokerage_value: config.forexConfig?.brokerage || 0, max_lot_per_scrip: config.forexConfig?.maxLotScrip || 0, exposure_multiplier: 1, auto_square_off: config.autoSquareOff === 'Yes' ? 1 : 0, square_off_time: config.expirySquareOffTime },
                        { segment: 'CRYPTO', is_enabled: config.cryptoTrading ? 1 : 0, brokerage_type: config.cryptoConfig?.brokerageType || 'PER_LOT', brokerage_value: config.cryptoConfig?.brokerage || 0, max_lot_per_scrip: config.cryptoConfig?.maxLotScrip || 0, exposure_multiplier: 1, auto_square_off: config.autoSquareOff === 'Yes' ? 1 : 0, square_off_time: config.expirySquareOffTime }
                    ];

                    // Return all enabled segments regardless of brokerage value (zero is allowed)
                    const finalSegments = mappedSegments.filter(s => s.is_enabled === 1);

                    console.log(`[getUserSegments] Parsed config for user ${req.params.id}:`, {
                        allSegments: mappedSegments.length,
                        enabledSegments: finalSegments.length,
                        forexTrading: config.forexTrading,
                        cryptoTrading: config.cryptoTrading,
                        comexTrading: config.comexTrading,
                        forexBrokerage: config.forexConfig?.brokerage,
                        cryptoBrokerage: config.cryptoConfig?.brokerage,
                        comexBrokerage: config.comexConfig?.brokerage
                    });

                    if (finalSegments.length > 0) {
                        return res.json(finalSegments);
                    }
                } catch (e) {
                    console.error('[getUserSegments] Fallback parse failed:', e);
                }
            }
        }

        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const updateUserSegments = async (req, res) => {
    // segments: array of { segment, isEnabled, brokerageType, brokerageValue, leverage, maxLotPerScrip, marginType, exposureMultiplier, autoSquareOff, squareOffTime }
    const { segments } = req.body;
    if (!Array.isArray(segments)) return res.status(400).json({ message: 'segments must be an array' });

    try {
        for (const seg of segments) {
            await db.execute(`
                INSERT INTO user_segments
                    (user_id, segment, is_enabled, brokerage_type, brokerage_value,
                     leverage, max_lot_per_scrip, margin_type, exposure_multiplier,
                     auto_square_off, square_off_time)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    is_enabled = VALUES(is_enabled),
                    brokerage_type = VALUES(brokerage_type),
                    brokerage_value = VALUES(brokerage_value),
                    leverage = VALUES(leverage),
                    max_lot_per_scrip = VALUES(max_lot_per_scrip),
                    margin_type = VALUES(margin_type),
                    exposure_multiplier = VALUES(exposure_multiplier),
                    auto_square_off = VALUES(auto_square_off),
                    square_off_time = VALUES(square_off_time)
            `, [
                req.params.id,
                seg.segment,
                seg.isEnabled ? 1 : 0,
                seg.brokerageType || 'PER_LOT',
                seg.brokerageValue || 0,
                seg.leverage || 1,
                seg.maxLotPerScrip || 10,
                seg.marginType || 'PER_LOT',
                seg.exposureMultiplier || 1,
                seg.autoSquareOff ? 1 : 0,
                seg.squareOffTime || null
            ]);
        }
        res.json({ message: 'Segments updated' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const getBrokerClients = async (req, res) => {
    try {
        const brokerId = req.params.id;
        const brokerIdStr = String(brokerId);

        const [rows] = await db.execute(
            `SELECT u.id, u.username, u.full_name, u.email, u.mobile, u.status, u.role,
                    u.balance as ledger_balance, u.created_at, u.is_demo,
                    p.username as parent_username,
                    IFNULL((SELECT SUM(pnl) FROM trades WHERE user_id = u.id AND status = 'CLOSED'), 0.00) as gross_pl,
                    IFNULL((SELECT SUM(brokerage) FROM trades WHERE user_id = u.id AND status = 'CLOSED'), 0.00) as brokerage,
                    IFNULL((SELECT SUM(swap) FROM trades WHERE user_id = u.id AND status = 'CLOSED'), 0.00) as swap_charges,
                    IFNULL((SELECT SUM(pnl - brokerage - swap) FROM trades WHERE user_id = u.id AND status = 'CLOSED'), 0.00) as net_pl
             FROM users u
             LEFT JOIN client_settings cs ON cs.user_id = u.id
             LEFT JOIN users p ON u.parent_id = p.id
             WHERE u.role = 'TRADER' AND (
                u.parent_id = ?
                OR cs.broker_id = ?
                OR cs.config_json LIKE CONCAT('%"broker":"', ?, ' :%')
             )
             ORDER BY u.id ASC`,
            [brokerId, brokerId, brokerIdStr]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

/**
 * Reset Account — deletes all trades, refunds margin, resets PnL for a user
 * Ledger balance and fund transactions remain untouched
 */
const resetAccount = async (req, res) => {
    const userId = req.params.id;
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Get all OPEN trades to refund margin
        const [openTrades] = await connection.execute(
            'SELECT SUM(margin_used) as totalMargin FROM trades WHERE user_id = ? AND status = "OPEN"',
            [userId]
        );
        const marginToRefund = parseFloat(openTrades[0]?.totalMargin || 0);

        // 2. Delete all trades for this user
        const [deleteResult] = await connection.execute(
            'DELETE FROM trades WHERE user_id = ?', [userId]
        );

        // 3. Refund locked margin back to balance
        if (marginToRefund > 0) {
            await connection.execute(
                'UPDATE users SET balance = balance + ? WHERE id = ?',
                [marginToRefund, userId]
            );
        }

        await connection.commit();

        await logAction(req.user.id, 'RESET_ACCOUNT', 'users',
            `Reset account for user #${userId}. Deleted ${deleteResult.affectedRows} trades, refunded margin: ${marginToRefund}`);

        res.json({
            message: 'Account reset successfully',
            tradesDeleted: deleteResult.affectedRows,
            marginRefunded: marginToRefund
        });
    } catch (err) {
        await connection.rollback();
        console.error('Reset Account Error:', err);
        res.status(500).json({ message: 'Failed to reset account' });
    } finally {
        connection.release();
    }
};

/**
 * Recalculate Brokerage — recalculates brokerage for all closed trades of a user
 * Uses broker's lot-wise brokerage configuration if available
 */
const recalculateBrokerage = async (req, res) => {
    const userId = req.params.id;
    try {
        // Get user's client settings for brokerage config
        const [settingsRows] = await db.execute(
            'SELECT config_json FROM client_settings WHERE user_id = ?', [userId]
        );
        const config = settingsRows.length > 0 ? JSON.parse(settingsRows[0].config_json || '{}') : {};

        // Get all closed trades
        const [trades] = await db.execute(
            'SELECT id, symbol, qty, entry_price, exit_price, type FROM trades WHERE user_id = ? AND status = "CLOSED"',
            [userId]
        );

        // Fetch all segment settings for this user once
        const [segmentSettings] = await db.execute('SELECT * FROM user_segments WHERE user_id = ?', [userId]);
        const segmentMap = {};
        segmentSettings.forEach(s => segmentMap[s.segment] = s);

        let totalBrokerage = 0;

        for (const trade of trades) {
            let brokerage = 0;
            const seg = segmentMap[trade.market_type || 'MCX'];

            if (seg) {
                const rate = parseFloat(seg.brokerage_value || 0);
                const type = (seg.brokerage_type || 'PER_LOT').toUpperCase();

                if (type === 'PER_LOT' || type === 'PER LOT') {
                    brokerage = trade.qty * rate;
                } else if (type === 'PER_CRORE' || type === 'PER CRORE') {
                    const lotSize = getLotSize(trade.symbol, trade.market_type || 'MCX');
                    const turnover = (parseFloat(trade.entry_price) + parseFloat(trade.exit_price || 0)) * trade.qty * lotSize;
                    brokerage = (turnover / 10000000) * rate;
                } else {
                    brokerage = trade.qty * rate;
                }

                // Ensure brokerage is never negative
                brokerage = Math.max(0, brokerage);
            } else {
                // Fallback to legacy config - respect mcxBrokerageType
                const brokerageType = (config.mcxBrokerageType || 'per_crore').toLowerCase();
                let symbolBrokerage;

                if (brokerageType === 'per_lot') {
                    // Per-lot mode: check mcxLotBrokerage first, then broker's
                    symbolBrokerage = config.mcxLotBrokerage?.[trade.symbol] || config.brokerMcxBrokerage?.[trade.symbol];
                } else {
                    // Per-crore mode: only use broker's brokerage
                    symbolBrokerage = config.brokerMcxBrokerage?.[trade.symbol];
                }

                if (symbolBrokerage !== undefined) {
                    brokerage = trade.qty * parseFloat(symbolBrokerage);
                } else {
                    const brokeragePerLot = parseFloat(config.mcxBrokerage || 0);
                    if (brokerageType === 'per_lot') {
                        brokerage = trade.qty * brokeragePerLot;
                    } else {
                        const lotSize = getLotSize(trade.symbol, 'MCX');
                        const turnover = trade.qty * lotSize * (parseFloat(trade.entry_price) + parseFloat(trade.exit_price || 0));
                        brokerage = (turnover / 10000000) * brokeragePerLot;
                    }
                }

                // Ensure brokerage is never negative
                brokerage = Math.max(0, brokerage);
            }

            totalBrokerage += brokerage;
            await db.execute('UPDATE trades SET brokerage = ? WHERE id = ?', [brokerage, trade.id]);
        }

        await logAction(req.user.id, 'RECALCULATE_BROKERAGE', 'users',
            `Recalculated brokerage for user #${userId}. Total: ${totalBrokerage.toFixed(2)} across ${trades.length} trades`);

        res.json({
            message: 'Brokerage recalculated successfully',
            tradesUpdated: trades.length,
            totalBrokerage: totalBrokerage.toFixed(2)
        });
    } catch (err) {
        console.error('Recalculate Brokerage Error:', err);
        res.status(500).json({ message: 'Failed to recalculate brokerage' });
    }
};

/**
 * Save user watchlist (pinned symbols)
 */
const saveWatchlist = async (req, res) => {
    try {
        const userId = req.user.id;
        const { watchlist } = req.body; // Array of symbols

        if (!Array.isArray(watchlist)) {
            return res.status(400).json({ message: 'Watchlist must be an array of symbols' });
        }

        await db.execute(`
            INSERT INTO client_settings (user_id, watchlist_json)
            VALUES (?, ?)
            ON DUPLICATE KEY UPDATE watchlist_json = VALUES(watchlist_json)
        `, [userId, JSON.stringify(watchlist)]);

        res.json({ message: 'Watchlist saved successfully' });
    } catch (err) {
        console.error('Save Watchlist Error:', err);
        res.status(500).json({ message: 'Failed to save watchlist' });
    }
};

/**
 * Get user watchlist
 */
const getWatchlist = async (req, res) => {
    try {
        const userId = req.user.id;
        const [rows] = await db.execute('SELECT watchlist_json FROM client_settings WHERE user_id = ?', [userId]);

        if (!rows.length || !rows[0].watchlist_json) {
            return res.json([]);
        }

        const watchlist = typeof rows[0].watchlist_json === 'string'
            ? JSON.parse(rows[0].watchlist_json)
            : rows[0].watchlist_json;

        res.json(watchlist);
    } catch (err) {
        console.error('Get Watchlist Error:', err);
        res.status(500).json({ message: 'Failed to fetch watchlist' });
    }
};

/**
 * Get user weekly balance (opening/closing balance for current week)
 */
const getWeeklyBalance = async (req, res) => {
    try {
        const userId = req.params.id;
        const { getWeekBoundaries, getISTDate } = require('../services/WeeklySettlementService');
        const boundaries = getWeekBoundaries(getISTDate());
        const { week_start, week_end } = boundaries;

        // Fetch the record for the current week (ending on current week_end)
        const [rows] = await db.execute(
            'SELECT * FROM weekly_balances WHERE user_id = ? AND week_end = ?',
            [userId, week_end]
        );

        let weeklyBalance = null;
        if (rows.length > 0) {
            weeklyBalance = rows[0];
        } else {
            // If the weekly closing has not run for this week yet, get the latest available record
            const [latestRows] = await db.execute(
                'SELECT * FROM weekly_balances WHERE user_id = ? ORDER BY week_end DESC LIMIT 1',
                [userId]
            );
            
            if (latestRows.length > 0) {
                // If there's a previous record, the opening balance for the current week is that week's closing balance
                weeklyBalance = {
                    user_id: parseInt(userId),
                    week_start,
                    week_end,
                    opening_balance: parseFloat(latestRows[0].closing_balance),
                    closing_balance: 0 // Not closed yet
                };
            } else {
                // Otherwise fall back to the user's current balance
                const [userRows] = await db.execute('SELECT balance, credit_limit FROM users WHERE id = ?', [userId]);
                const opening = userRows.length > 0 ? parseFloat(userRows[0].balance || 0) : 0;
                weeklyBalance = {
                    user_id: parseInt(userId),
                    week_start,
                    week_end,
                    opening_balance: opening,
                    closing_balance: opening
                };
            }
        }

        res.json(weeklyBalance);
    } catch (err) {
        console.error('Get Weekly Balance Error:', err);
        res.status(500).json({ message: 'Failed to fetch weekly balance' });
    }
};

module.exports = {
    getUsers, getUserProfile, updateStatus, resetPassword, deleteUser, updatePasswords,
    updateUser, updateClientSettings, getBrokerShares, updateBrokerShares,
    getDocuments, updateDocuments, getUserSegments, updateUserSegments, getBrokerClients,
    resetAccount, recalculateBrokerage,
    saveWatchlist, getWatchlist, getWeeklyBalance
};
