/**
 * AI Executor — Safely executes generated queries
 *
 * - Uses MySQL transactions for all write operations
 * - Validates existence before update/delete
 * - Returns structured UI-friendly responses
 * - Handles ADD_FUND, WITHDRAW, TRANSFER as special composite operations
 */

const db = require('../config/db');
const bcrypt = require('bcryptjs');
const MarginUtils = require('../utils/MarginUtils');

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE MAP (module → frontend route for redirects)
// ─────────────────────────────────────────────────────────────────────────────

const ROUTE_MAP = {
    users:             '/accounts',
    trades:            '/trades',
    ledger:            '/funds',
    funds:             '/funds',
    payment_requests:  '/deposit-requests',
    signals:           '/signals',
    banks:             '/bank-details',
    ip_logins:         '/ip-logs',
    support_tickets:   '/support',
    action_ledger:     '/action-ledger',
    scrip_data:        '/scrip-data',
    global_configs:    '/global-settings',
    notifications:     '/notifications',
};

// ─────────────────────────────────────────────────────────────────────────────
// RESPONSE BUILDER
// ─────────────────────────────────────────────────────────────────────────────

const buildResponse = (type, message, data, meta = {}) => ({
    type,       // 'table' | 'action' | 'aggregate' | 'error'
    message,
    data: data || [],
    meta,
});

// ─────────────────────────────────────────────────────────────────────────────
// SELECT EXECUTOR
// ─────────────────────────────────────────────────────────────────────────────

const executeSelect = async (query, parsed) => {
    const [rows] = await db.execute(query.sql, query.params);
    const module = parsed.module || query.table;
    const route = parsed.route || ROUTE_MAP[module] || '/';

    if (rows.length === 0) {
        return buildResponse('table', 'No records found', [], {
            module,
            table: query.table,
            count: 0,
            redirect: route,
        });
    }

    // Single record — return as detail view
    if (parsed.filters?.id && rows.length === 1) {
        return buildResponse('table', `Found 1 record`, rows, {
            module,
            table: query.table,
            count: 1,
            redirect: route,
            singleRecord: true,
        });
    }

    return buildResponse('table', `Found ${rows.length} record(s)`, rows, {
        module,
        table: query.table,
        count: rows.length,
        redirect: route,
        columns: Object.keys(rows[0]),
    });
};

// ─────────────────────────────────────────────────────────────────────────────
// AGGREGATE EXECUTOR
// ─────────────────────────────────────────────────────────────────────────────

const executeAggregate = async (query, parsed) => {
    const [rows] = await db.execute(query.sql, query.params);
    const result = rows[0] || {};
    const module = parsed.module || query.table;

    return buildResponse('aggregate', `Count: ${result.total_count || 0}`, [result], {
        module,
        table: query.table,
        redirect: parsed.route || ROUTE_MAP[module] || '/',
    });
};

// ─────────────────────────────────────────────────────────────────────────────
// ADD FUND EXECUTOR
// ─────────────────────────────────────────────────────────────────────────────

const executeAddFund = async (query, parsed, reqUser) => {
    const { userId, amount } = query;

    if (!userId || !amount || amount <= 0) {
        return buildResponse('error', 'Valid userId and positive amount required', null, { module: 'funds' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // Verify user exists
        const [rows] = await connection.execute('SELECT id, balance, full_name FROM users WHERE id = ?', [userId]);
        if (!rows.length) {
            await connection.rollback();
            return buildResponse('error', `User ${userId} not found`, null, { module: 'funds' });
        }

        const currentBalance = parseFloat(rows[0].balance || 0);
        const newBalance = currentBalance + amount;

        // Update balance
        await connection.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, userId]);

        // Insert ledger entry
        await connection.execute(
            'INSERT INTO ledger (user_id, amount, type, balance_after, remarks) VALUES (?, ?, ?, ?, ?)',
            [userId, amount, 'DEPOSIT', newBalance, `AI Command: Fund added by ${reqUser?.full_name || 'system'}`]
        );

        await connection.commit();

        return buildResponse('action', `₹${amount} added to ${rows[0].full_name || 'user ' + userId}. New balance: ₹${newBalance}`, [{
            userId,
            name: rows[0].full_name,
            amountAdded: amount,
            previousBalance: currentBalance,
            newBalance,
        }], {
            module: 'funds',
            redirect: '/funds',
            actionType: 'ADD_FUND',
        });
    } catch (err) {
        await connection.rollback();
        throw err;
    } finally {
        connection.release();
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// WITHDRAW EXECUTOR
// ─────────────────────────────────────────────────────────────────────────────

const executeWithdraw = async (query, parsed, reqUser) => {
    const { userId, amount } = query;

    if (!userId || !amount || amount <= 0) {
        return buildResponse('error', 'Valid userId and positive amount required', null, { module: 'funds' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const [rows] = await connection.execute('SELECT id, balance, full_name FROM users WHERE id = ? FOR UPDATE', [userId]);
        if (!rows.length) {
            await connection.rollback();
            return buildResponse('error', `User ${userId} not found`, null, { module: 'funds' });
        }

        const currentBalance = parseFloat(rows[0].balance || 0);

        // Fetch Open Trades and Config for Margin Check
        const [trades] = await connection.execute('SELECT * FROM trades WHERE user_id = ? AND status = "OPEN"', [userId]);
        const [settings] = await connection.execute('SELECT config_json FROM client_settings WHERE user_id = ?', [userId]);
        const clientConfig = settings.length > 0 ? JSON.parse(settings[0].config_json || '{}') : {};

        const blockedMargin = MarginUtils.calculateTotalRequiredHoldingMargin(trades, clientConfig);
        const withdrawable = currentBalance - blockedMargin;

        if (amount > withdrawable) {
            await connection.rollback();
            return buildResponse('error', `Insufficient Withdrawable Balance. Required Holding Margin: ₹${blockedMargin.toFixed(2)}, Available to Withdraw: ₹${withdrawable.toFixed(2)}`, null, { module: 'funds' });
        }

        const newBalance = currentBalance - amount;

        await connection.execute('UPDATE users SET balance = balance - ? WHERE id = ?', [amount, userId]);
        await connection.execute(
            'INSERT INTO ledger (user_id, amount, type, balance_after, remarks) VALUES (?, ?, ?, ?, ?)',
            [userId, amount, 'WITHDRAW', newBalance, `AI Command: Fund withdrawn by ${reqUser?.full_name || 'system'}`]
        );

        await connection.commit();

        return buildResponse('action', `₹${amount} withdrawn from ${rows[0].full_name || 'user ' + userId}. New balance: ₹${newBalance}`, [{
            userId,
            name: rows[0].full_name,
            amountWithdrawn: amount,
            previousBalance: currentBalance,
            newBalance,
        }], {
            module: 'funds',
            redirect: '/funds',
            actionType: 'WITHDRAW',
        });
    } catch (err) {
        await connection.rollback();
        throw err;
    } finally {
        connection.release();
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// TRANSFER EXECUTOR
// ─────────────────────────────────────────────────────────────────────────────

const executeTransfer = async (query, parsed, reqUser) => {
    const { fromUserId, toUserId, amount } = query;

    if (!fromUserId || !toUserId || !amount || amount <= 0) {
        return buildResponse('error', 'fromUserId, toUserId, and positive amount required', null, { module: 'funds' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // Lock both rows
        const [fromRows] = await connection.execute('SELECT id, balance, full_name FROM users WHERE id = ? FOR UPDATE', [fromUserId]);
        if (!fromRows.length) {
            await connection.rollback();
            return buildResponse('error', `Source user ${fromUserId} not found`, null, { module: 'funds' });
        }

        const [toRows] = await connection.execute('SELECT id, balance, full_name FROM users WHERE id = ? FOR UPDATE', [toUserId]);
        if (!toRows.length) {
            await connection.rollback();
            return buildResponse('error', `Destination user ${toUserId} not found`, null, { module: 'funds' });
        }

        const fromBal = parseFloat(fromRows[0].balance || 0);
        const toBal = parseFloat(toRows[0].balance || 0);

        if (fromBal < amount) {
            await connection.rollback();
            return buildResponse('error', `Insufficient balance. ${fromRows[0].full_name || 'User ' + fromUserId} has ₹${fromBal}`, null, { module: 'funds' });
        }

        const newFromBal = fromBal - amount;
        const newToBal = toBal + amount;

        await connection.execute('UPDATE users SET balance = balance - ? WHERE id = ?', [amount, fromUserId]);
        await connection.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, toUserId]);

        await connection.execute(
            'INSERT INTO ledger (user_id, amount, type, balance_after, remarks) VALUES (?, ?, ?, ?, ?)',
            [fromUserId, amount, 'WITHDRAW', newFromBal, `AI Transfer to ${toRows[0].full_name || 'user ' + toUserId}`]
        );
        await connection.execute(
            'INSERT INTO ledger (user_id, amount, type, balance_after, remarks) VALUES (?, ?, ?, ?, ?)',
            [toUserId, amount, 'DEPOSIT', newToBal, `AI Transfer from ${fromRows[0].full_name || 'user ' + fromUserId}`]
        );

        await connection.commit();

        return buildResponse('action', `₹${amount} transferred from ${fromRows[0].full_name || fromUserId} → ${toRows[0].full_name || toUserId}`, [{
            fromUserId,
            fromName: fromRows[0].full_name,
            toUserId,
            toName: toRows[0].full_name,
            amount,
            fromNewBalance: newFromBal,
            toNewBalance: newToBal,
        }], {
            module: 'funds',
            redirect: '/funds',
            actionType: 'TRANSFER',
        });
    } catch (err) {
        await connection.rollback();
        throw err;
    } finally {
        connection.release();
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// CREATE USER EXECUTOR
// ─────────────────────────────────────────────────────────────────────────────

const executeCreateUser = async (query, parsed, reqUser) => {
    const data = query.data;
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        // Check duplicate email
        if (data.email) {
            const [dup] = await connection.execute('SELECT id FROM users WHERE email = ?', [data.email]);
            if (dup.length) {
                await connection.rollback();
                return buildResponse('error', `Email ${data.email} already exists`, null, { module: 'users' });
            }
        }

        const baseName = (data.name || 'user').toLowerCase().replace(/\s+/g, '_');
        const username = `${baseName}_${Date.now().toString().slice(-5)}`;
        const plainPassword = data.password || `Pass${Math.floor(Math.random() * 9000) + 1000}@!`;
        const hashedPassword = await bcrypt.hash(plainPassword, 10);
        const role = data.role || 'ADMIN';

        const [result] = await connection.execute(
            `INSERT INTO users (username, password, full_name, email, mobile, role, status, balance, credit_limit, parent_id)
             VALUES (?, ?, ?, ?, ?, ?, 'Active', 0, 0, ?)`,
            [username, hashedPassword, data.name, data.email, data.mobile || null, role, reqUser?.id || null]
        );

        // Create related records for new user
        await connection.execute('INSERT IGNORE INTO client_settings (user_id) VALUES (?)', [result.insertId]);

        if (role === 'BROKER' || role === 'ADMIN') {
            await connection.execute('INSERT IGNORE INTO broker_shares (user_id) VALUES (?)', [result.insertId]);
        }

        if (role === 'TRADER') {
            await connection.execute('INSERT IGNORE INTO user_documents (user_id, kyc_status) VALUES (?, ?)', [result.insertId, 'PENDING']);
        }

        await connection.commit();

        const routeMap = { ADMIN: '/accounts', BROKER: '/broker-accounts', TRADER: '/trading-clients', SUPERADMIN: '/accounts' };

        return buildResponse('action', `${role} "${data.name}" created successfully`, [{
            id: result.insertId,
            username,
            name: data.name,
            email: data.email,
            role,
            password: plainPassword,   // returned once
        }], {
            module: 'users',
            redirect: routeMap[role] || '/accounts',
            actionType: 'CREATE_USER',
        });
    } catch (err) {
        await connection.rollback();
        throw err;
    } finally {
        connection.release();
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GENERIC UPDATE/DELETE EXECUTOR (with transaction)
// ─────────────────────────────────────────────────────────────────────────────

const executeWrite = async (query, parsed, reqUser) => {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // Pre-check: verify the target record exists
        const pk = parsed.filters?.id;
        if (pk) {
            const [check] = await connection.execute(
                `SELECT * FROM \`${query.table}\` WHERE id = ? LIMIT 1`,
                [pk]
            );
            if (!check.length) {
                await connection.rollback();
                return buildResponse('error', `Record #${pk} not found in ${query.table}`, null, {
                    module: parsed.module,
                    table: query.table,
                });
            }
        }

        const [result] = await connection.execute(query.sql, query.params);
        await connection.commit();

        const affectedRows = result.affectedRows || 0;
        const module = parsed.module || query.table;

        let message;
        if (query.subAction === 'BLOCK') {
            message = `User #${pk} blocked (Suspended) successfully`;
        } else if (query.subAction === 'UNBLOCK') {
            message = `User #${pk} activated successfully`;
        } else if (query.subAction === 'SOFT_DELETE') {
            message = `Trade #${pk} deleted successfully`;
        } else if (query.type === 'DELETE') {
            message = `Record #${pk} deleted from ${query.table}`;
        } else {
            message = `${affectedRows} row(s) updated in ${query.table}`;
        }

        return buildResponse('action', message, [{ affectedRows, id: pk }], {
            module,
            table: query.table,
            redirect: parsed.route || ROUTE_MAP[module] || '/',
            actionType: query.subAction || query.type,
        });
    } catch (err) {
        await connection.rollback();
        throw err;
    } finally {
        connection.release();
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GENERIC INSERT EXECUTOR
// ─────────────────────────────────────────────────────────────────────────────

const executeInsert = async (query, parsed) => {
    const [result] = await db.execute(query.sql, query.params);
    const module = parsed.module || query.table;

    return buildResponse('action', `Record created in ${query.table} (ID: ${result.insertId})`, [{
        id: result.insertId,
    }], {
        module,
        table: query.table,
        redirect: parsed.route || ROUTE_MAP[module] || '/',
        actionType: 'INSERT',
    });
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXECUTOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * executeQuery(query, parsed, reqUser) → structured response
 *
 * Routes to correct execution handler based on query.type
 * @param {object} query - From aiQueryGenerator.generateQuery()
 * @param {object} parsed - From aiCommandParser.parseCommand()
 * @param {object} reqUser - req.user (authenticated user)
 */
const executeQuery = async (query, parsed, reqUser) => {
    // Check for generation errors
    if (query.error) {
        return buildResponse('error', query.error, null, {
            module: parsed.module,
            redirect: parsed.route || '/',
        });
    }

    switch (query.type) {
        case 'SELECT':
            return executeSelect(query, parsed);

        case 'AGGREGATE':
            return executeAggregate(query, parsed);

        case 'ADD_FUND':
            return executeAddFund(query, parsed, reqUser);

        case 'WITHDRAW':
            return executeWithdraw(query, parsed, reqUser);

        case 'TRANSFER':
            return executeTransfer(query, parsed, reqUser);

        case 'CREATE_USER':
            return executeCreateUser(query, parsed, reqUser);

        case 'INSERT':
            return executeInsert(query, parsed);

        case 'UPDATE':
        case 'DELETE':
            return executeWrite(query, parsed, reqUser);

        default:
            return buildResponse('error', `Unknown query type: ${query.type}`, null, { module: parsed.module });
    }
};

module.exports = { executeQuery };
