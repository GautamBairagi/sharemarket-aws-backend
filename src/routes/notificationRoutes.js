const express = require('express');
const router  = express.Router();
const { authMiddleware: authenticate, roleMiddleware, brokerPermission } = require('../middleware/auth');
const {
    getNotifications,
    markRead,
    markAllRead,
    createNotification,
    deleteNotification,
    getUsersByRole,
} = require('../controllers/notificationController');

router.get ('/',              authenticate, getNotifications);
router.get ('/users/:role',   authenticate, getUsersByRole);
router.put ('/read-all',      authenticate, markAllRead);
router.put ('/:id/read',      authenticate, markRead);
router.post('/',              authenticate, roleMiddleware(['SUPERADMIN', 'ADMIN', 'BROKER']), brokerPermission('notificationsAllowed'), createNotification);
router.delete('/:id',         authenticate, roleMiddleware(['SUPERADMIN', 'ADMIN']), deleteNotification);

module.exports = router;
