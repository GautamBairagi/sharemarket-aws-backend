/**
 * Shared Socket.io instance — avoids circular deps between server.js and controllers.
 */
const socketManager = require('../websocket/SocketManager');

const setIo = (io) => { 
    // This is already handled in SocketManager.init, but we bridge it for compat
};

const getIo = () => socketManager.getIo();

module.exports = { setIo, getIo };
