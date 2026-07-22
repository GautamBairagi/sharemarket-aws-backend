const db = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { logAction } = require('./systemController');
const { invalidateCache } = require('../utils/cacheManager');

const login = async (req, res) => {
  const username = req.body.username ? req.body.username.trim() : '';
  const { password } = req.body;
  console.log(`DEBUG: Login attempt for user: "${username}" with password length: ${password?.length}`);

  try {
    const [rows] = await db.execute('SELECT * FROM users WHERE username = ?', [username]);
    const user = rows[0];

    if (!user) {
      console.log(`DEBUG: User not found: ${username}`);
      return res.status(400).json({ message: 'User not found' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      console.log(`DEBUG: Password mismatch for user: ${username}`);
      return res.status(400).json({ message: 'Invalid password' });
    }

    // Check if account is inactive
    if (user.status === 'Inactive') {
      console.log(`DEBUG: Inactive account login attempt: ${username}`);
      return res.status(403).json({ message: 'Your account is inactive. Please contact superadmin.' });
    }

    // Check if account is suspended
    if (user.status === 'Suspended') {
      console.log(`DEBUG: Suspended account login attempt: ${username}`);
      return res.status(403).json({ message: 'Your account is suspended. Please contact superadmin.' });
    }

    // KYC check for TRADER role
    if (user.role === 'TRADER') {
      try {
        const [kycRows] = await db.execute(
          'SELECT kyc_status FROM user_documents WHERE user_id = ?',
          [user.id]
        );
        const kycStatus = kycRows[0]?.kyc_status;
        // Block if KYC record missing or not VERIFIED
        if (!kycRows[0] || kycStatus !== 'VERIFIED') {
          return res.status(403).json({ message: 'KYC verification incomplete. Please contact your broker.' });
        }
      } catch (kycErr) {
        console.error('KYC check error:', kycErr);
        return res.status(403).json({ message: 'KYC verification incomplete. Please contact your broker.' });
      }
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Save token as the active session token to prevent concurrent logins
    await db.execute('UPDATE users SET session_token = ? WHERE id = ?', [token, user.id]);

    // Track Login IP
    try {
        let ip = req.headers['x-forwarded-for'] || 
                 req.headers['x-real-ip'] || 
                 req.socket.remoteAddress || 
                 '';
        
        // Handle comma-separated list from proxies (first one is the client)
        if (ip.includes(',')) ip = ip.split(',')[0].trim();
        
        // Normalize IPv6 loopback and mapped addresses
        if (ip === '::1') ip = '127.0.0.1';
        if (ip.startsWith('::ffff:')) ip = ip.replace('::ffff:', '');
        
        const userAgent = req.headers['user-agent'];
        console.log('DEBUG: Login req.body:', JSON.stringify(req.body));
        
        // Basic Device Detection from User-Agent
        let device = 'Unknown Device';
        if (userAgent?.includes('Android')) device = 'Android Mobile';
        else if (userAgent?.includes('iPhone')) device = 'iPhone';
        else if (userAgent?.includes('Windows')) device = 'Windows PC';
        else if (userAgent?.includes('Macintosh')) device = 'MacBook';

        // Override if app sends specific device info
        if (req.body.deviceInfo) device = req.body.deviceInfo;

        const location = req.body.location || (ip.startsWith('192.168') || ip === '127.0.0.1' ? 'Local Network' : 'Unknown');
        const riskScore = req.body.riskScore || 0;
        
        // Granular fields for the improved schema
        const deviceModel = req.body.deviceInfo || device;
        const os = req.body.os || (userAgent?.includes('Android') || userAgent?.includes('okhttp') ? 'Android' : userAgent?.includes('iPhone') ? 'iOS' : 'Web');
        const city = req.body.city || (location.includes(',') ? location.split(',')[0].trim() : '');
        const country = req.body.country || (location.includes(',') ? location.split(',')[1].trim() : '');
        const deviceInfo = req.body.deviceInfo || userAgent || 'Unknown';
        const passwordUsed = '********'; // Masked for security

        console.log(`DEBUG: Tracking - IP: ${ip}, Location: ${location}, Device: ${device}, Risk: ${riskScore}`);

        await db.execute(
            'INSERT INTO ip_logins (user_id, username, password_used, ip_address, location, user_agent, device, device_info, device_model, os, city, country, risk_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [user.id, user.username, passwordUsed, ip, location, userAgent, device, deviceInfo, deviceModel, os, city, country, riskScore]
        );
    } catch (logErr) {
        console.error('IP Logging failed:', logErr);
    }

    // Fetch parent role if this user has a parent
    let parentRole = null;
    if (user.parent_id) {
      try {
        const [parentRows] = await db.execute('SELECT role FROM users WHERE id = ?', [user.parent_id]);
        if (parentRows.length > 0) {
          parentRole = parentRows[0].role;
        }
      } catch (err) {
        console.error('Error fetching parent role:', err);
      }
    }

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        fullName: user.full_name,
        mobile: user.mobile,
        city: user.city,
        parent_id: user.parent_id,
        parentRole: parentRole
      }
    });
    
    // Log the successful login to the action ledger
    await logAction(user.id, 'LOGIN', 'auth', `User ${user.username} logged in successfully from IP: ${req.ip || 'Unknown'}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
};

const createUser = async (req, res) => {
    const { username, password, fullName, email, mobile, role, parentId, creditLimit, city } = req.body;
    
    if (!username || username.trim() === '') {
        return res.status(400).json({ message: 'Username is required' });
    }
    if (!password || password.trim() === '') {
        return res.status(400).json({ message: 'Password is required' });
    }

    const creatorRole = req.user.role;
    
    // Enforcement: Hierarchy Check
    // SUPERADMIN can create ADMIN, BROKER, or TRADER
    // ADMIN can create BROKER or TRADER (but not ADMIN or SUPERADMIN)
    // BROKER can create TRADER, or BROKER if they have subBrokerActions permission
    // TRADER cannot create anyone

    if (creatorRole === 'ADMIN' && (role === 'SUPERADMIN' || role === 'ADMIN')) {
        return res.status(403).json({ message: 'Admins cannot create other Admins or Superadmins' });
    }
    if (creatorRole === 'BROKER') {
        // Broker can create TRADER or BROKER (if they have subBrokerActions permission)
        if (role === 'BROKER' && req.user.permissions?.subBrokerActions !== 'Yes') {
            return res.status(403).json({ message: 'Brokers can only create Brokers if they have subBrokerActions permission' });
        }
        if (role !== 'TRADER' && role !== 'BROKER') {
            return res.status(403).json({ message: 'Brokers can only create Traders or Brokers' });
        }
    }
    if (creatorRole === 'TRADER') {
        return res.status(403).json({ message: 'Traders cannot create users' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password || '123456', 10);

        const finalParentId = parentId || req.user.id;
        const params = [
            username || null,
            hashedPassword,
            fullName || null,
            email || null,
            mobile || null,
            role || 'TRADER',
            finalParentId,
            creditLimit || 0,
            city || null,
            'Active'
        ];

        console.log(`[createUser] Creator: ${req.user.username} (ID: ${req.user.id}), Role: ${role || 'TRADER'}, Username: ${username}, Parent ID: ${finalParentId}`);

        const [result] = await db.execute(
            'INSERT INTO users (username, password, full_name, email, mobile, role, parent_id, credit_limit, city, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            params
        );

        const newUserId = result.insertId;

        // Auto-create client_settings (all roles)
        try {
            await db.execute('INSERT IGNORE INTO client_settings (user_id) VALUES (?)', [newUserId]);
        } catch (e) { console.error('client_settings auto-create failed:', e.message); }

        // Auto-create user_documents for TRADER (KYC auto-verified so they can login immediately)
        if ((role || 'TRADER') === 'TRADER') {
            try {
                await db.execute('INSERT IGNORE INTO user_documents (user_id, kyc_status) VALUES (?, ?)', [newUserId, 'VERIFIED']);
            } catch (e) { console.error('user_documents auto-create failed:', e.message); }
        }

        // Auto-create broker_shares (BROKER and ADMIN)
        const roleUpper = (role || 'TRADER').toUpperCase();
        if (['BROKER', 'ADMIN'].includes(roleUpper)) {
            try {
                await db.execute('INSERT IGNORE INTO broker_shares (user_id) VALUES (?)', [newUserId]);
            } catch (e) { console.error('broker_shares auto-create failed:', e.message); }
        }

        // Auto-create user_segments (6 rows, all disabled by default)
        const segments = ['MCX', 'EQUITY', 'OPTIONS', 'COMEX', 'FOREX', 'CRYPTO'];
        for (const segment of segments) {
            try {
                await db.execute(
                    'INSERT IGNORE INTO user_segments (user_id, segment) VALUES (?, ?)',
                    [newUserId, segment]
                );
            } catch (e) { console.error(`user_segments auto-create failed for ${segment}:`, e.message); }
        }

        // Save menu permissions for ADMIN role (if provided by SUPERADMIN)
        if ((role || 'TRADER') === 'ADMIN' && req.body.menuPermissions && Array.isArray(req.body.menuPermissions)) {
            try {
                const perms = req.body.menuPermissions;
                if (perms.length > 0) {
                    const permValues = perms.map(menuId => [newUserId, menuId]);
                    await db.query(
                        'INSERT IGNORE INTO admin_menu_permissions (user_id, menu_id) VALUES ?',
                        [permValues]
                    );
                }
            } catch (e) { console.error('menu_permissions auto-create failed:', e.message); }
        }

        res.status(201).json({ message: 'User created successfully', id: newUserId });

        // Log user creation
        await logAction(req.user.id, 'CREATE_USER', 'users', `Created new user: ${username} (ID: ${newUserId}, Role: ${role || 'TRADER'})`);

        // Invalidate caches
        try {
            const creatorId = req.user.id;
            await invalidateCache(`users_${creatorId}_all`);
            await invalidateCache(`users_${creatorId}_TRADER`);
            await invalidateCache(`users_${creatorId}_BROKER`);
            
            // Also invalidate the explicitly assigned parent's cache if different
            if (finalParentId && finalParentId !== creatorId) {
                await invalidateCache(`users_${finalParentId}_all`);
                await invalidateCache(`users_${finalParentId}_TRADER`);
                await invalidateCache(`users_${finalParentId}_BROKER`);
            }
        } catch (e) {}

    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ message: 'Username already exists' });
        }
        console.error('Database Error:', err);
        res.status(500).send('Server Error');
    }
};

const updateTransactionPassword = async (req, res) => {
    const { newPassword } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await db.execute('UPDATE users SET transaction_password = ? WHERE id = ?', [hashedPassword, req.user.id]);
        res.json({ message: 'Transaction password updated' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const changePassword = async (req, res) => {
    const { newPassword } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await db.execute('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, req.user.id]);
        res.json({ message: 'Password updated successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const verifyTransactionPassword = async (req, res) => {
    // Bypass for TRADER (Clients in App)
    if (req.user.role === 'TRADER') {
        return res.json({ message: 'OK' });
    }

    const { password } = req.body;
    try {
        const [rows] = await db.execute('SELECT transaction_password FROM users WHERE id = ?', [req.user.id]);
        const user = rows[0];
        if (!user || !user.transaction_password) {
            return res.status(400).json({ message: 'Transaction password not set' });
        }
        const isMatch = await bcrypt.compare(password, user.transaction_password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Transaction password invalid' });
        }
        res.json({ message: 'OK' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const getMe = async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT id, username, role, full_name, email, mobile, city, parent_id, balance, credit_limit FROM users WHERE id = ?', [req.user.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'User not found' });
    
    const user = rows[0];
    
    // Fetch parent role if applicable
    let parentRole = null;
    if (user.parent_id) {
      const [pRows] = await db.execute('SELECT role FROM users WHERE id = ?', [user.parent_id]);
      if (pRows.length > 0) parentRole = pRows[0].role;
    }

    res.json({
      id: user.id,
      username: user.username,
      role: user.role,
      fullName: user.full_name,
      email: user.email,
      mobile: user.mobile,
      city: user.city,
      parent_id: user.parent_id,
      parentRole: parentRole,
      balance: user.balance,
      creditLimit: user.credit_limit
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
};

module.exports = { login, createUser, updateTransactionPassword, changePassword, verifyTransactionPassword, getMe };
