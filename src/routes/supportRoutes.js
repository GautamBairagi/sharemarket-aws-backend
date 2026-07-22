const express = require('express');
const router = express.Router();
const { createTicket, getTickets, getTicketMessages, addMessage, resolveTicket, deleteTicket } = require('../controllers/supportController');
const { authMiddleware, roleMiddleware } = require('../middleware/auth');

router.get('/',                  authMiddleware, getTickets);
router.post('/',                 authMiddleware, createTicket);
router.get('/:id/messages',      authMiddleware, getTicketMessages);
router.post('/:id/messages',     authMiddleware, addMessage);
router.put('/:id/resolve',       authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), resolveTicket);
router.delete('/:id',            authMiddleware, deleteTicket);

module.exports = router;
