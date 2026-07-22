/**
 * Database Service for AI Command Execution
 * Handles all database operations for:
 * - ADD_FUND
 * - BLOCK_USER
 * - UNBLOCK_USER
 * - CREATE_ADMIN
 * - TRANSFER_FUND
 *
 * All operations use transactions with automatic rollback on error.
 * All queries are parameterized (no string concatenation).
 */

const db = require('../config/db');
const bcrypt = require('bcryptjs');

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: ADD_FUND
// ─────────────────────────────────────────────────────────────────────────────

const executeAddFund = async (connection, { userId, amount }) => {
    console.log('[ADD_FUND] Validating userId and amount');

    if (!userId || amount == null) {
        throw new Error('userId and amount are required for ADD_FUND');
    }

    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) {
        throw new Error('amount must be a positive number');
    }

    console.log(`[ADD_FUND] Fetching user ${userId}`);
    const [rows] = await connection.execute(
        'SELECT id, balance FROM users WHERE id = ?', [userId]
    );
    if (!rows.length) {
        throw new Error(`User ${userId} not found`);
    }

    const newBalance = parseFloat(rows[0].balance || 0) + amt;

    console.log(`[ADD_FUND] Updating user ${userId} balance: ${rows[0].balance} → ${newBalance}`);
    await connection.execute(
        'UPDATE users SET balance = balance + ? WHERE id = ?',
        [amt, userId]
    );

    console.log(`[ADD_FUND] Inserting ledger entry for DEPOSIT`);
    await connection.execute(
        'INSERT INTO ledger (user_id, amount, type, balance_after, remarks) VALUES (?, ?, ?, ?, ?)',
        [userId, amt, 'DEPOSIT', newBalance, 'AI Command: ADD_FUND']
    );

    return {
        success: true,
        message: 'Fund added successfully',
        userId,
        amountAdded: amt,
        newBalance,
    };
};

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: BLOCK_USER
// ─────────────────────────────────────────────────────────────────────────────

const executeBlockUser = async (connection, { userId }) => {
    console.log('[BLOCK_USER] Validating userId');

    if (!userId) {
        throw new Error('userId is required for BLOCK_USER');
    }

    console.log(`[BLOCK_USER] Fetching user ${userId}`);
    const [rows] = await connection.execute(
        'SELECT id, status FROM users WHERE id = ?', [userId]
    );
    if (!rows.length) {
        throw new Error(`User ${userId} not found`);
    }

    console.log(`[BLOCK_USER] Updating user ${userId} status to "Suspended"`);
    await connection.execute(
        "UPDATE users SET status = 'Suspended' WHERE id = ?", [userId]
    );

    return {
        success: true,
        message: `User ${userId} blocked (Suspended) successfully`,
        userId,
    };
};

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: UNBLOCK_USER
// ─────────────────────────────────────────────────────────────────────────────

const executeUnblockUser = async (connection, { userId }) => {
    console.log('[UNBLOCK_USER] Validating userId');

    if (!userId) {
        throw new Error('userId is required for UNBLOCK_USER');
    }

    console.log(`[UNBLOCK_USER] Fetching user ${userId}`);
    const [rows] = await connection.execute(
        'SELECT id, status FROM users WHERE id = ?', [userId]
    );
    if (!rows.length) {
        throw new Error(`User ${userId} not found`);
    }

    console.log(`[UNBLOCK_USER] Updating user ${userId} status to "Active"`);
    await connection.execute(
        "UPDATE users SET status = 'Active' WHERE id = ?", [userId]
    );

    return {
        success: true,
        message: `User ${userId} unblocked (Active) successfully`,
        userId,
    };
};

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: CREATE_ADMIN
// ─────────────────────────────────────────────────────────────────────────────

const executeCreateAdmin = async (connection, { name, email, password }) => {
    console.log('[CREATE_ADMIN] Validating name and email');

    if (!name || !email) {
        throw new Error('name and email are required for CREATE_ADMIN');
    }

    const baseUsername = name.toLowerCase().replace(/\s+/g, '_');
    const username = `${baseUsername}_${Date.now().toString().slice(-5)}`;

    console.log(`[CREATE_ADMIN] Checking for duplicate email: ${email}`);
    const [emailCheck] = await connection.execute(
        'SELECT id FROM users WHERE email = ?', [email]
    );
    if (emailCheck.length) {
        throw new Error(`Email ${email} already exists`);
    }

    const plainPassword = password || `Admin@${Math.floor(Math.random() * 9000) + 1000}`;
    console.log('[CREATE_ADMIN] Hashing password');
    const hashedPassword = await bcrypt.hash(plainPassword, 10);

    console.log(`[CREATE_ADMIN] Inserting new admin: ${username}`);
    const [result] = await connection.execute(
        `INSERT INTO users
            (username, password, full_name, email, role, status, balance, credit_limit)
         VALUES (?, ?, ?, ?, 'ADMIN', 'Active', 0, 0)`,
        [username, hashedPassword, name, email]
    );

    return {
        success: true,
        message: 'Admin created successfully',
        adminId: result.insertId,
        username,
        name,
        email,
        password: plainPassword,  // returned once so admin can log in
    };
};

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: TRANSFER_FUND
// ─────────────────────────────────────────────────────────────────────────────

const executeTransferFund = async (connection, { fromUserId, toUserId, amount }) => {
    console.log('[TRANSFER_FUND] Validating fromUserId, toUserId, and amount');

    if (!fromUserId || !toUserId || amount == null) {
        throw new Error('fromUserId, toUserId and amount are required for TRANSFER_FUND');
    }

    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) {
        throw new Error('amount must be a positive number');
    }

    console.log(`[TRANSFER_FUND] Locking and fetching source user ${fromUserId}`);
    const [fromRows] = await connection.execute(
        'SELECT id, balance FROM users WHERE id = ? FOR UPDATE', [fromUserId]
    );
    if (!fromRows.length) {
        throw new Error(`Source user ${fromUserId} not found`);
    }

    console.log(`[TRANSFER_FUND] Locking and fetching destination user ${toUserId}`);
    const [toRows] = await connection.execute(
        'SELECT id, balance FROM users WHERE id = ? FOR UPDATE', [toUserId]
    );
    if (!toRows.length) {
        throw new Error(`Destination user ${toUserId} not found`);
    }

    const fromBal = parseFloat(fromRows[0].balance || 0);
    const toBal   = parseFloat(toRows[0].balance   || 0);

    if (fromBal < amt) {
        throw new Error(`Insufficient balance. User ${fromUserId} has ₹${fromBal}`);
    }

    const newFromBal = fromBal - amt;
    const newToBal   = toBal   + amt;

    console.log(`[TRANSFER_FUND] Deducting ₹${amt} from user ${fromUserId}`);
    await connection.execute(
        'UPDATE users SET balance = balance - ? WHERE id = ?', [amt, fromUserId]
    );

    console.log(`[TRANSFER_FUND] Adding ₹${amt} to user ${toUserId}`);
    await connection.execute(
        'UPDATE users SET balance = balance + ? WHERE id = ?', [amt, toUserId]
    );

    console.log(`[TRANSFER_FUND] Recording WITHDRAW for user ${fromUserId}`);
    await connection.execute(
        'INSERT INTO ledger (user_id, amount, type, balance_after, remarks) VALUES (?, ?, ?, ?, ?)',
        [fromUserId, amt, 'WITHDRAW', newFromBal, `AI Command: TRANSFER to user ${toUserId}`]
    );

    console.log(`[TRANSFER_FUND] Recording DEPOSIT for user ${toUserId}`);
    await connection.execute(
        'INSERT INTO ledger (user_id, amount, type, balance_after, remarks) VALUES (?, ?, ?, ?, ?)',
        [toUserId, amt, 'DEPOSIT', newToBal, `AI Command: TRANSFER from user ${fromUserId}`]
    );

    return {
        success: true,
        message: `₹${amt} transferred from user ${fromUserId} to user ${toUserId}`,
        fromUserId,
        toUserId,
        amount: amt,
        fromBalance: newFromBal,
        toBalance: newToBal,
    };
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXECUTOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * executeAction(parsedData) → result object
 *
 * Executes the parsed AI command as a database transaction.
 * On error, automatically rolls back and throws.
 * On success, commits and returns { success: true, ...data }
 *
 * @param {object} parsedData - Parsed command from aiService.parseCommand()
 *                              Must include: action, and action-specific fields
 * @returns {Promise<object>} { success: true, message, ...data }
 * @throws {Error} with descriptive message on any failure
 */
const executeAction = async (parsedData) => {
    const { action } = parsedData;

    console.log(`\n[executeAction] Starting transaction for action: ${action}`);

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        let result;

        switch (action) {
            case 'ADD_FUND':
                result = await executeAddFund(connection, parsedData);
                break;

            case 'BLOCK_USER':
                result = await executeBlockUser(connection, parsedData);
                break;

            case 'UNBLOCK_USER':
                result = await executeUnblockUser(connection, parsedData);
                break;

            case 'CREATE_ADMIN':
                result = await executeCreateAdmin(connection, parsedData);
                break;

            case 'TRANSFER_FUND':
                result = await executeTransferFund(connection, parsedData);
                break;

            default:
                throw new Error(`Unknown action: "${action}". Supported: ADD_FUND, BLOCK_USER, UNBLOCK_USER, CREATE_ADMIN, TRANSFER_FUND`);
        }

        await connection.commit();
        console.log(`[executeAction] ✅ Transaction committed for ${action}`);

        return result;

    } catch (err) {
        await connection.rollback();
        console.error(`[executeAction] ❌ Transaction rolled back for ${action}:`, err.message);
        throw err;
    } finally {
        connection.release();
    }
};

module.exports = { executeAction };
