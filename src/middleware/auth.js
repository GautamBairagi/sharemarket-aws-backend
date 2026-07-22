const jwt = require('jsonwebtoken');

const authMiddleware = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ message: 'No token, authorization denied' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;

    // Check active session token in DB to prevent concurrent logins
    const db = require('../config/db');
    const [rows] = await db.execute('SELECT session_token FROM users WHERE id = ?', [decoded.id]);
    if (rows.length === 0 || rows[0].session_token !== token) {
      return res.status(401).json({ message: 'Session invalidated: Logged in on another device', concurrent_logout: true });
    }

    next();
  } catch (err) {
    res.status(401).json({ message: 'Token is not valid' });
  }
};

const roleMiddleware = (allowedRoles) => {
  return (req, res, next) => {
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Access denied: Insufficient permissions' });
    }
    next();
  };
};

// Broker permission middleware — checks broker_shares.permissions_json
// permissionKey: one of 'subBrokerActions','payinAllowed','payoutAllowed',
//   'createClientsAllowed','clientTasksAllowed','tradeActivityAllowed',
//   'notificationsAllowed','canViewBackupData'
const brokerPermission = (permissionKey) => {
  return async (req, res, next) => {
    // SUPERADMIN and ADMIN bypass broker permission checks
    if (req.user.role === 'SUPERADMIN' || req.user.role === 'ADMIN') {
      return next();
    }
    // Only enforce on BROKER role
    if (req.user.role !== 'BROKER') {
      return next();
    }
    try {
      const db = require('../config/db');
      const [rows] = await db.execute(
        'SELECT permissions_json FROM broker_shares WHERE user_id = ?',
        [req.user.id]
      );
      if (rows.length === 0) {
        return res.status(403).json({ message: 'Broker configuration not found' });
      }
      const permissions = JSON.parse(rows[0].permissions_json || '{}');

      // Attach all permissions to req.user for use in controllers
      req.user.permissions = permissions;

      if (permissions[permissionKey] !== 'Yes') {
        return res.status(403).json({
          message: `Permission denied: ${permissionKey} is not enabled for your account`
        });
      }
      next();
    } catch (err) {
      console.error('Broker permission check error:', err);
      res.status(500).json({ message: 'Permission check failed' });
    }
  };
};

// Middleware to allow brokers to update shares for their own sub-brokers
const brokerSharesPermission = () => {
  return async (req, res, next) => {
    // SUPERADMIN and ADMIN can update any broker's shares
    if (req.user.role === 'SUPERADMIN' || req.user.role === 'ADMIN') {
      return next();
    }
    // BROKER can only update shares for brokers they created
    if (req.user.role === 'BROKER') {
      try {
        const db = require('../config/db');
        const targetBrokerId = req.params.id;
        // Check if the target broker has this broker as parent
        const [rows] = await db.execute(
          'SELECT id FROM users WHERE id = ? AND parent_id = ? AND role = "BROKER"',
          [targetBrokerId, req.user.id]
        );
        if (rows.length === 0) {
          return res.status(403).json({ message: 'You can only update shares for your own sub-brokers' });
        }
        return next();
      } catch (err) {
        console.error('Broker shares permission check error:', err);
        return res.status(500).json({ message: 'Permission check failed' });
      }
    }
    return res.status(403).json({ message: 'Access denied' });
  };
};

module.exports = { authMiddleware, roleMiddleware, brokerPermission, brokerSharesPermission };
