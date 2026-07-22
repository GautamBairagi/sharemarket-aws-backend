/**
 * AI Query Generator — Intent → Safe SQL Query
 *
 * Uses schema from aiSchemaLoader + parsed intent from aiCommandParser
 * to generate parameterized SQL queries dynamically.
 *
 * NEVER uses string concatenation for values — always parameterized.
 * Returns { sql, params, type, table } ready for execution.
 */

const { loadSchema, getTableInfo } = require('./aiSchemaLoader');

// ─────────────────────────────────────────────────────────────────────────────
// TABLE / COLUMN RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the actual MySQL table name from module string.
 * e.g. 'funds' → 'users' (for balance ops), 'users' → 'users'
 */
const resolveTable = (module, operation) => {
    const MAP = {
        users: 'users',
        trades: 'trades',
        ledger: 'ledger',
        funds: 'users',        // fund operations target users.balance
        payment_requests: 'payment_requests',
        signals: 'signals',
        banks: 'banks',
        ip_logins: 'ip_logins',
        support_tickets: 'support_tickets',
        action_ledger: 'action_ledger',
        scrip_data: 'scrip_data',
        global_configs: 'global_configs',
        notifications: 'notifications',
    };
    return MAP[module] || module;
};

/**
 * Get the date column for a table (for date range filtering)
 */
const getDateColumn = (table) => {
    const MAP = {
        users: 'created_at',
        trades: 'entry_time',
        ledger: 'created_at',
        payment_requests: 'created_at',
        signals: 'created_at',
        ip_logins: 'timestamp',
        ip_logs: 'timestamp',
        support_tickets: 'created_at',
        action_ledger: 'timestamp',
        forensic_logs: 'created_at',
        notifications: 'created_at',
    };
    return MAP[table] || 'created_at';
};

/**
 * Get SELECT columns for a table (exclude sensitive fields)
 */
const getSafeColumns = async (table) => {
    const info = await getTableInfo(table);
    if (!info) return ['*'];

    // Never expose these in results
    const HIDDEN = ['password', 'transaction_password', 'password_used'];
    return info.columnNames.filter(c => !HIDDEN.includes(c));
};

// ─────────────────────────────────────────────────────────────────────────────
// QUERY GENERATORS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a SELECT query from intent
 */
const generateReadQuery = async (parsed) => {
    const table = resolveTable(parsed.module, 'read');
    const columns = await getSafeColumns(table);
    const info = await getTableInfo(table);

    if (!info) {
        return { sql: null, params: [], error: `Table "${table}" not found in database` };
    }

    const conditions = [];
    const params = [];

    // Process filters
    for (const [key, value] of Object.entries(parsed.filters || {})) {
        if (key === 'dateRange' && value && value.start && value.end) {
            const dateCol = getDateColumn(table);
            if (info.columnNames.includes(dateCol)) {
                conditions.push(`\`${dateCol}\` BETWEEN ? AND ?`);
                params.push(formatDate(value.start), formatDate(value.end));
            }
            continue;
        }

        if (key === 'id') {
            const pk = info.primaryKey || 'id';
            conditions.push(`\`${pk}\` = ?`);
            params.push(value);
            continue;
        }

        // Only filter on columns that actually exist
        if (info.columnNames.includes(key)) {
            conditions.push(`\`${key}\` = ?`);
            params.push(value);
        }
    }

    let sql = `SELECT ${columns.map(c => `\`${c}\``).join(', ')} FROM \`${table}\``;
    if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;

    // Sort
    if (parsed.sort?.field && info.columnNames.includes(parsed.sort.field)) {
        const order = parsed.sort.order === 'ASC' ? 'ASC' : 'DESC';
        sql += ` ORDER BY \`${parsed.sort.field}\` ${order}`;
    } else {
        // Default sort by primary key DESC
        sql += ` ORDER BY \`${info.primaryKey || 'id'}\` DESC`;
    }

    // Limit
    const limit = parsed.limit || 100;
    sql += ` LIMIT ?`;
    params.push(limit);

    return { sql, params, type: 'SELECT', table };
};

/**
 * Generate an aggregate/count query
 */
const generateAggregateQuery = async (parsed) => {
    const table = resolveTable(parsed.module, 'read');
    const info = await getTableInfo(table);

    if (!info) {
        return { sql: null, params: [], error: `Table "${table}" not found` };
    }

    const conditions = [];
    const params = [];

    for (const [key, value] of Object.entries(parsed.filters || {})) {
        if (key === 'dateRange') continue;
        if (key === 'id') {
            conditions.push(`\`${info.primaryKey || 'id'}\` = ?`);
            params.push(value);
            continue;
        }
        if (info.columnNames.includes(key)) {
            conditions.push(`\`${key}\` = ?`);
            params.push(value);
        }
    }

    let sql = `SELECT COUNT(*) as total_count`;

    // If table has amount/balance, add sum
    if (info.columnNames.includes('amount')) {
        sql += `, COALESCE(SUM(amount), 0) as total_amount`;
    }
    if (info.columnNames.includes('balance')) {
        sql += `, COALESCE(SUM(balance), 0) as total_balance`;
    }
    if (info.columnNames.includes('pnl')) {
        sql += `, COALESCE(SUM(pnl), 0) as total_pnl`;
    }

    sql += ` FROM \`${table}\``;
    if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;

    return { sql, params, type: 'AGGREGATE', table };
};

/**
 * Generate ADD_FUND query (update balance + insert ledger)
 */
const generateAddFundQuery = (parsed) => {
    const userId = parsed.filters?.id;
    const amount = parsed.data?.amount;

    if (!userId || !amount) {
        return { sql: null, params: [], error: 'userId and amount required for add_fund' };
    }

    return {
        type: 'ADD_FUND',
        table: 'users',
        userId: parseInt(userId, 10),
        amount: parseFloat(amount),
    };
};

/**
 * Generate WITHDRAW query (deduct balance + insert ledger)
 */
const generateWithdrawQuery = (parsed) => {
    const userId = parsed.filters?.id;
    const amount = parsed.data?.amount;

    if (!userId || !amount) {
        return { sql: null, params: [], error: 'userId and amount required for withdraw' };
    }

    return {
        type: 'WITHDRAW',
        table: 'users',
        userId: parseInt(userId, 10),
        amount: parseFloat(amount),
    };
};

/**
 * Generate TRANSFER query
 */
const generateTransferQuery = (parsed) => {
    const fromId = parsed.data?.fromUserId;
    const toId = parsed.data?.toUserId;
    const amount = parsed.data?.amount;

    if (!fromId || !toId || !amount) {
        return { sql: null, params: [], error: 'fromUserId, toUserId, and amount required for transfer' };
    }

    return {
        type: 'TRANSFER',
        table: 'users',
        fromUserId: parseInt(fromId, 10),
        toUserId: parseInt(toId, 10),
        amount: parseFloat(amount),
    };
};

/**
 * Generate BLOCK query
 */
const generateBlockQuery = (parsed) => {
    const userId = parsed.filters?.id;
    if (!userId) return { sql: null, params: [], error: 'userId required for block' };

    return {
        sql: "UPDATE `users` SET `status` = 'Suspended' WHERE `id` = ?",
        params: [parseInt(userId, 10)],
        type: 'UPDATE',
        table: 'users',
        subAction: 'BLOCK',
    };
};

/**
 * Generate UNBLOCK query
 */
const generateUnblockQuery = (parsed) => {
    const userId = parsed.filters?.id;
    if (!userId) return { sql: null, params: [], error: 'userId required for unblock' };

    return {
        sql: "UPDATE `users` SET `status` = 'Active' WHERE `id` = ?",
        params: [parseInt(userId, 10)],
        type: 'UPDATE',
        table: 'users',
        subAction: 'UNBLOCK',
    };
};

/**
 * Generate CREATE query (insert new user/admin/broker)
 */
const generateCreateQuery = async (parsed) => {
    const table = resolveTable(parsed.module, 'create');
    const info = await getTableInfo(table);
    if (!info) return { sql: null, params: [], error: `Table "${table}" not found` };

    const data = parsed.data || {};

    if (table === 'users') {
        // Must have name + email for user creation
        if (!data.name && !data.email) {
            return { sql: null, params: [], error: 'name and email required for user creation' };
        }

        return {
            type: 'CREATE_USER',
            table: 'users',
            data: {
                name: data.name || 'user',
                email: data.email || `user${Date.now()}@example.com`,
                password: data.password || 'Admin@123',
                role: data.role || 'ADMIN',
                mobile: data.mobile || null,
            },
        };
    }

    // Generic insert for other tables
    const insertCols = [];
    const insertVals = [];
    const params = [];

    for (const [key, val] of Object.entries(data)) {
        if (info.columnNames.includes(key) && key !== info.primaryKey) {
            insertCols.push(`\`${key}\``);
            insertVals.push('?');
            params.push(val);
        }
    }

    if (!insertCols.length) {
        return { sql: null, params: [], error: 'No valid data fields provided for insert' };
    }

    const sql = `INSERT INTO \`${table}\` (${insertCols.join(', ')}) VALUES (${insertVals.join(', ')})`;
    return { sql, params, type: 'INSERT', table };
};

/**
 * Generate DELETE query
 */
const generateDeleteQuery = async (parsed) => {
    const table = resolveTable(parsed.module, 'delete');
    const info = await getTableInfo(table);
    if (!info) return { sql: null, params: [], error: `Table "${table}" not found` };

    const id = parsed.filters?.id;
    if (!id) return { sql: null, params: [], error: 'id required for delete' };

    const pk = info.primaryKey || 'id';

    // For trades, soft-delete by setting status to DELETED
    if (table === 'trades') {
        return {
            sql: `UPDATE \`trades\` SET \`status\` = 'DELETED' WHERE \`${pk}\` = ?`,
            params: [parseInt(id, 10)],
            type: 'UPDATE',
            table,
            subAction: 'SOFT_DELETE',
        };
    }

    return {
        sql: `DELETE FROM \`${table}\` WHERE \`${pk}\` = ?`,
        params: [parseInt(id, 10)],
        type: 'DELETE',
        table,
    };
};

/**
 * Generate UPDATE query
 */
const generateUpdateQuery = async (parsed) => {
    const table = resolveTable(parsed.module, 'update');
    const info = await getTableInfo(table);
    if (!info) return { sql: null, params: [], error: `Table "${table}" not found` };

    const id = parsed.filters?.id;
    if (!id) return { sql: null, params: [], error: 'id required for update' };

    const data = parsed.data || {};
    const setClauses = [];
    const params = [];

    // Sensitive fields that should never be set via AI
    const PROTECTED = ['password', 'transaction_password', 'id'];

    for (const [key, val] of Object.entries(data)) {
        if (info.columnNames.includes(key) && !PROTECTED.includes(key)) {
            setClauses.push(`\`${key}\` = ?`);
            params.push(val);
        }
    }

    if (!setClauses.length) {
        return { sql: null, params: [], error: 'No valid fields to update' };
    }

    const pk = info.primaryKey || 'id';
    const sql = `UPDATE \`${table}\` SET ${setClauses.join(', ')} WHERE \`${pk}\` = ?`;
    params.push(parseInt(id, 10));

    return { sql, params, type: 'UPDATE', table };
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN GENERATOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * generateQuery(parsed) → { sql, params, type, table, ... }
 *
 * Routes to the correct generator based on operation.
 */
const generateQuery = async (parsed) => {
    const { operation } = parsed;

    switch (operation) {
        case 'read':
            return generateReadQuery(parsed);
        case 'aggregate':
            return generateAggregateQuery(parsed);
        case 'add_fund':
            return generateAddFundQuery(parsed);
        case 'withdraw':
            return generateWithdrawQuery(parsed);
        case 'transfer':
            return generateTransferQuery(parsed);
        case 'block':
            return generateBlockQuery(parsed);
        case 'unblock':
            return generateUnblockQuery(parsed);
        case 'create':
            return generateCreateQuery(parsed);
        case 'delete':
            return generateDeleteQuery(parsed);
        case 'update':
            return generateUpdateQuery(parsed);
        default:
            return { sql: null, params: [], error: `Unknown operation: ${operation}` };
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const formatDate = (date) => {
    if (date instanceof Date) {
        return date.toISOString().slice(0, 19).replace('T', ' ');
    }
    return date;
};

module.exports = { generateQuery, resolveTable };
