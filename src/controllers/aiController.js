/**
 * AI Controller — Main API for the Smart AI-Driven System
 *
 * Endpoints:
 *   POST /api/ai/smart-command   → Full pipeline: parse → generate → execute → respond
 *   POST /api/ai/ai-command      → Legacy unified endpoint (backward compat)
 *   POST /api/ai/schema          → Get database schema summary
 *   POST /api/ai/parse-only      → Parse without executing (for preview)
 *
 * All legacy endpoints still work for backward compatibility.
 */

const db = require('../config/db');
const MarginUtils = require('../utils/MarginUtils');
const openai = require('../config/openai');
const { parseQuery } = require('../services/aiCommandParser');
const { generateQuery } = require('../services/aiQueryGenerator');
const { executeQuery } = require('../services/aiExecutor');
const { loadSchema, getSchemaSummary } = require('../services/aiSchemaLoader');
const { processMasterCommand } = require('../services/aiMasterPrompt');
const { executeMasterCommand } = require('../services/aiMasterExecutor');
const { mediate } = require('../services/aiMediator');

// Legacy imports (backward compat)
const { parseCommand: legacyParseCommand } = require('../services/aiService');
const { executeAction: legacyExecuteAction } = require('../services/dbService');

/**
 * Convert legacy parsed format { action, userId, amount, ... }
 * to the structured format { module, operation, filters, data }
 * that generateQuery() expects.
 */
const adaptLegacyParsed = (legacy) => {
    const ACTION_MAP = {
        ADD_FUND:      { module: 'funds',  operation: 'add_fund' },
        WITHDRAW_FUND: { module: 'funds',  operation: 'withdraw' },
        TRANSFER_FUND: { module: 'funds',  operation: 'transfer' },
        BLOCK_USER:    { module: 'users',  operation: 'block' },
        UNBLOCK_USER:  { module: 'users',  operation: 'unblock' },
        CREATE_ADMIN:  { module: 'users',  operation: 'create' },
        READ:          { module: 'users',  operation: 'read' },
        AGGREGATE:     { module: 'users',  operation: 'aggregate' },
        UPDATE:        { module: 'users',  operation: 'update' },
        DELETE:        { module: 'users',  operation: 'delete' },
    };

    const mapped = ACTION_MAP[legacy.action] || { module: 'users', operation: 'read' };
    const filters = {};
    const data = {};

    if (legacy.userId) filters.id = legacy.userId;
    if (legacy.amount) data.amount = legacy.amount;
    if (legacy.fromUserId) data.fromUserId = legacy.fromUserId;
    if (legacy.toUserId) data.toUserId = legacy.toUserId;
    if (legacy.name) data.name = legacy.name;
    if (legacy.email) data.email = legacy.email;
    if (legacy.password) data.password = legacy.password;
    if (legacy.role) data.role = legacy.role;

    return {
        module: mapped.module,
        operation: mapped.operation,
        filters,
        data,
        sort: null,
        limit: 100,
        raw: legacy,
    };
};

/**
 * parseCommand — parse user text into structured intent for the smart pipeline.
 * Uses the legacy parser (aiService) and adapts its output.
 * If the legacy parser returns a username instead of userId, resolves it via DB lookup.
 */
const parseCommand = async (text) => {
    if (typeof legacyParseCommand !== 'function') {
        throw new Error('AI parser service not available. Please restart the server.');
    }
    const legacy = await legacyParseCommand(text);

    // Resolve username → userId if needed
    if (legacy.username && !legacy.userId) {
        try {
            const [rows] = await db.execute(
                'SELECT id FROM users WHERE full_name = ? OR email = ? LIMIT 1',
                [legacy.username, legacy.username]
            );
            if (rows.length > 0) {
                legacy.userId = rows[0].id;
            }
        } catch (e) {
            console.warn('[parseCommand] Username lookup failed:', e.message);
        }
    }

    return adaptLegacyParsed(legacy);
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/smart-command
// THE MAIN ENDPOINT — Natural Language → Database Action Engine
// ─────────────────────────────────────────────────────────────────────────────

const smartCommand = async (req, res) => {
    const { text } = req.body;
    const reqUser = req.user || {};

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('[smart-command] 📝 Input:', text);
    console.log('[smart-command] 👤 User:', reqUser.full_name || reqUser.id || 'anonymous');
    console.log('═══════════════════════════════════════════════════════════════');

    // ── Step 0: Validate ────────────────────────────────────────────────────
    if (!text || !text.trim()) {
        return res.status(400).json({
            type: 'error',
            message: 'text is required',
            data: [],
            meta: {},
        });
    }

    try {
        // ── Step 1: Load Schema (cached) ────────────────────────────────────
        console.log('[smart-command] 📊 Loading schema...');
        await loadSchema();

        // ── Step 2: Parse Command (inlined to avoid scope issues) ───────────
        console.log('[smart-command] 🤖 Parsing command...');
        console.log('[smart-command] legacyParseCommand type:', typeof legacyParseCommand);
        console.log('[smart-command] parseCommand type:', typeof parseCommand);

        let parsed;
        try {
            parsed = await parseCommand(text.trim());
        } catch (parseErr) {
            console.error('[smart-command] Parse error:', parseErr.message, parseErr.stack);
            throw parseErr;
        }
        console.log('[smart-command] ✅ Parsed:', JSON.stringify(parsed, null, 2));

        // ── Step 3: Generate Query ──────────────────────────────────────────
        console.log('[smart-command] 🔧 Generating query...');
        const query = await generateQuery(parsed);
        console.log('[smart-command] ✅ Query:', JSON.stringify({
            type: query.type,
            sql: query.sql || '(composite operation)',
            params: query.params,
        }));

        // ── Step 4: Execute ─────────────────────────────────────────────────
        console.log('[smart-command] ▶️  Executing...');
        const result = await executeQuery(query, parsed, reqUser);
        console.log('[smart-command] ✅ Result:', result.message);

        // ── Step 5: Return ──────────────────────────────────────────────────
        console.log('[smart-command] 🎉 Done');
        console.log('═══════════════════════════════════════════════════════════════\n');

        return res.json({
            success: result.type !== 'error',
            ...result,
            parsed: {
                module: parsed.module,
                operation: parsed.operation,
                filters: parsed.filters,
                route: parsed.route,
            },
        });

    } catch (err) {
        console.error('[smart-command] ❌ Error:', err.message);
        console.error('[smart-command] ❌ Stack:', err.stack);
        return res.status(500).json({
            type: 'error',
            message: err.message || 'AI command failed',
            data: [],
            meta: { module: 'system' },
        });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/parse-only
// Parse without executing — for command preview / confirmation UI
// ─────────────────────────────────────────────────────────────────────────────

const parseOnly = async (req, res) => {
    const { text } = req.body;

    if (!text || !text.trim()) {
        return res.status(400).json({ success: false, message: 'text is required' });
    }

    try {
        await loadSchema();
        const parsed = await parseCommand(text.trim());
        const query = await generateQuery(parsed);

        return res.json({
            success: true,
            parsed,
            query: {
                type: query.type,
                sql: query.sql || null,
                table: query.table || null,
                error: query.error || null,
            },
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ai/schema
// Returns database schema summary (for debugging/admin tools)
// ─────────────────────────────────────────────────────────────────────────────

const getSchema = async (req, res) => {
    try {
        const summary = await getSchemaSummary();
        return res.json({ success: true, schema: summary });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/master-command
// ADVANCED: Uses comprehensive master prompt (single OpenAI call)
// Returns execution-ready JSON with SQL queries
// ─────────────────────────────────────────────────────────────────────────────

const masterCommand = async (req, res) => {
    const { text } = req.body;
    const reqUser = req.user || {};

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('[master-command] 🧠 Input:', text);
    console.log('[master-command] 👤 User:', reqUser.full_name || reqUser.id || 'anonymous');
    console.log('═══════════════════════════════════════════════════════════════');

    if (!text || !text.trim()) {
        return res.status(400).json({
            success: false,
            message: 'text is required',
        });
    }

    try {
        // Step 1: Process through master prompt
        console.log('[master-command] 🧠 Processing through master AI...');
        const masterOutput = await processMasterCommand(text.trim(), {
            id: reqUser.id,
            role: reqUser.role,
            full_name: reqUser.full_name,
        });

        console.log('[master-command] ✅ Master output:', JSON.stringify({
            module: masterOutput.intent?.module,
            operation: masterOutput.intent?.operation,
            executionType: masterOutput.execution?.type,
        }));

        // Step 2: Execute the plan
        console.log('[master-command] ▶️  Executing...');
        const execResult = await executeMasterCommand(masterOutput, reqUser);

        console.log('[master-command] ✅ Execution result:', execResult.message);
        console.log('═══════════════════════════════════════════════════════════════\n');

        return res.json({
            success: execResult.success,
            ...execResult,
            intent: masterOutput.intent,
            ui: masterOutput.ui,
        });

    } catch (err) {
        console.error('[master-command] ❌ Error:', err.message);
        return res.status(500).json({
            success: false,
            message: err.message || 'Master command failed',
        });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/mediate
// UNIVERSAL AI MEDIATOR — Handles ANY user input in ANY language
// Supports multi-turn conversations with message history
// ─────────────────────────────────────────────────────────────────────────────

const mediatorCommand = async (req, res) => {
    const { text, messageHistory = [] } = req.body;
    const reqUser = req.user || {};

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('[mediator] 🤝 Input:', text);
    console.log('[mediator] 👤 User:', reqUser.full_name || reqUser.id || 'anonymous');
    console.log('[mediator] 📜 History length:', messageHistory.length);
    console.log('═══════════════════════════════════════════════════════════════');

    if (!text || !text.trim()) {
        return res.status(400).json({
            success: false,
            message: 'text is required',
        });
    }

    try {
        const result = await mediate(text.trim(), messageHistory);

        console.log('[mediator] ✅ Completed in', result.iterations, 'iterations');
        console.log('═══════════════════════════════════════════════════════════════\n');

        return res.json({
            success: result.success,
            message: result.message,
            toolResults: result.toolResults,
            iterations: result.iterations,
            messageHistory: result.messageHistory,
        });

    } catch (err) {
        console.error('[mediator] ❌ Error:', err.message);
        return res.status(500).json({
            success: false,
            message: err.message || 'Mediator failed',
        });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY: POST /api/ai/ai-command (kept for backward compatibility)
// Routes through NEW system but returns OLD format
// ─────────────────────────────────────────────────────────────────────────────

const aiCommand = async (req, res) => {
    const { text } = req.body;

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('[ai-command] 📝 User Input:', text);
    console.log('═══════════════════════════════════════════════════════════════');

    if (!text || !text.trim()) {
        return res.status(400).json({ success: false, message: 'text is required' });
    }

    try {
        // Try new smart system first
        await loadSchema();
        const parsed = await parseCommand(text.trim());
        const query = await generateQuery(parsed);
        const result = await executeQuery(query, parsed, req.user || {});

        return res.json({
            success: result.type !== 'error',
            action: `${parsed.operation}`.toUpperCase(),
            ...result,
        });
    } catch (err) {
        // Fallback to legacy system
        console.warn('[ai-command] Smart system failed, trying legacy:', err.message);
        try {
            const legacyParsed = await legacyParseCommand(text);
            const legacyResult = await legacyExecuteAction(legacyParsed);
            return res.json({ success: true, action: legacyParsed.action, ...legacyResult });
        } catch (legacyErr) {
            return res.status(500).json({ success: false, message: legacyErr.message });
        }
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY ENDPOINTS (unchanged for backward compatibility)
// ─────────────────────────────────────────────────────────────────────────────

const bcryptLib = require('bcryptjs');

const makeDummy = () => {
    const adj = ['quick', 'smart', 'bold', 'swift', 'prime'][Math.floor(Math.random() * 5)];
    const noun = ['admin', 'trader', 'broker', 'agent', 'user'][Math.floor(Math.random() * 5)];
    const num = Math.floor(Math.random() * 900) + 100;
    return { name: `${adj}_${noun}`, email: `${adj}.${noun}${num}@example.com`, password: `Pass${num}@!` };
};

// ── POST /api/ai/voice-command ──────────────────────────────────────────────

const processVoiceCommand = async (req, res) => {
    const { command } = req.body;
    try {
        let response = "I didn't quite catch that. Try 'Active trades' or 'My balance'.";
        if (command.toLowerCase().includes('balance')) {
            const [rows] = await db.execute('SELECT balance FROM users WHERE id = ?', [req.user.id]);
            response = `Your current balance is ${rows[0].balance}`;
        } else if (command.toLowerCase().includes('trades')) {
            const [rows] = await db.execute('SELECT COUNT(*) as count FROM trades WHERE user_id = ? AND status = "OPEN"', [req.user.id]);
            response = `You have ${rows[0].count} active trades.`;
        }
        res.json({ text: response });
    } catch (err) {
        res.status(500).send('AI Engine Error');
    }
};

// ── POST /api/ai/ai-parse (legacy) ─────────────────────────────────────────

const aiParse = async (req, res) => {
    const { text } = req.body;

    if (!text || !text.trim()) {
        return res.status(400).json({ message: 'text is required' });
    }

    try {
        // Use legacy parser (aiService) which handles Hindi/Hinglish/English
        const parsed = await legacyParseCommand(text.trim());

        // Add backward-compatible fields so legacy UI (VoiceModulationPage) can display summary
        const compat = { ...parsed };
        if (!compat.action) {
            const opMap = {
                add_fund: 'ADD_FUND', withdraw: 'WITHDRAW', transfer: 'TRANSFER_FUND',
                block: 'BLOCK_USER', unblock: 'UNBLOCK_USER', create: 'CREATE_USER',
                read: 'READ', aggregate: 'AGGREGATE', update: 'UPDATE', delete: 'DELETE',
            };
            compat.action = opMap[parsed.operation] || parsed.operation?.toUpperCase() || 'READ';
        }
        if ((parsed.filters?.userId || parsed.filters?.id) && !compat.userId) compat.userId = parsed.filters.userId || parsed.filters.id;
        if (parsed.data?.amount && !compat.amount) compat.amount = parsed.data.amount;
        if (parsed.data?.fromUserId) compat.fromUserId = parsed.data.fromUserId;
        if (parsed.data?.toUserId) compat.toUserId = parsed.data.toUserId;
        if (parsed.data?.name) compat.name = parsed.data.name;
        if (parsed.data?.email) compat.email = parsed.data.email;

        return res.json(compat);
    } catch (err) {
        console.error('[aiParse] Error:', err.message);
        return res.status(422).json({
            message: 'Please rephrase your command',
            error: err.message,
            displayMessage: 'Please rephrase your command or explain it differently',
        });
    }
};

// ── POST /api/ai/smart-search — Smart search with AI parsing ─────────────────

const smartSearch = async (req, res) => {
    const q = req.body.query || req.body.text;

    try {
        if (!q || !q.toString().trim()) {
            return res.status(400).json({ success: false, message: 'Query is required' });
        }

        // --- Fast lexical shortcuts for simple trade queries (bypass AI) ---
        try {
            const lowerQ = q.toString().toLowerCase();
            if (lowerQ.includes('trade') || lowerQ.includes('trades')) {
                // closed trades
                if (lowerQ.includes('closed')) {
                    const [rows] = await db.execute("SELECT * FROM trades WHERE status = 'CLOSED' LIMIT 50");
                    return res.json({ success: true, data: rows, count: Array.isArray(rows) ? rows.length : 0, query: "SELECT * FROM trades WHERE status = 'CLOSED' LIMIT 50" });
                }
                // active trades (map to OPEN in DB)
                if (lowerQ.includes('active')) {
                    const [rows] = await db.execute("SELECT * FROM trades WHERE status = 'OPEN' LIMIT 50");
                    return res.json({ success: true, data: rows, count: Array.isArray(rows) ? rows.length : 0, query: "SELECT * FROM trades WHERE status = 'OPEN' LIMIT 50" });
                }
                // buy trades
                if (lowerQ.includes('buy')) {
                    const [rows] = await db.execute("SELECT * FROM trades WHERE type = 'BUY' LIMIT 50");
                    return res.json({ success: true, data: rows, count: Array.isArray(rows) ? rows.length : 0, query: "SELECT * FROM trades WHERE type = 'BUY' LIMIT 50" });
                }
                // sell trades
                if (lowerQ.includes('sell')) {
                    const [rows] = await db.execute("SELECT * FROM trades WHERE type = 'SELL' LIMIT 50");
                    return res.json({ success: true, data: rows, count: Array.isArray(rows) ? rows.length : 0, query: "SELECT * FROM trades WHERE type = 'SELL' LIMIT 50" });
                }
            }
        } catch (lexErr) {
            console.warn('[smartSearch] lexical shortcut error:', lexErr && lexErr.message ? lexErr.message : lexErr);
        }

                // Load DB schema and pass to parser so AI uses real columns
                let simpleSchema = {};
                try {
                    const fullSchema = await loadSchema();
                    for (const [tbl, info] of Object.entries(fullSchema || {})) {
                        if (info && info.columnNames) simpleSchema[tbl] = info.columnNames;
                        else if (Array.isArray(info)) simpleSchema[tbl] = info;
                        else if (info && info.columns) simpleSchema[tbl] = info.columns.map(c => c.name);
                        else simpleSchema[tbl] = Object.keys(info || {});
                    }
                } catch (e) {
                    console.warn('[smartSearch] Could not load schema for injection:', e.message || e);
                }

                // ✅ AI se direct SQL lo (also get raw AI output)
                const { sql: aiSql, raw } = await parseQuery(q.toString(), simpleSchema);

        console.log('AI RAW OUTPUT:', raw);

        // Clean: remove markdown fences (```sql, ```) and any leading/trailing text
        let source = (raw || aiSql || '').toString();
        source = source.replace(/```\s*sql/gi, '');
        source = source.replace(/```/g, '');
        source = source.trim();

        // Remove any leading text before the first SELECT
        let sql = source;
        const selectIndex = source.toLowerCase().indexOf('select');
        if (selectIndex !== -1) {
            sql = source.substring(selectIndex).trim();
        }

        console.log('AI SQL (cleaned):', sql);

        // --- Auto-fix common column/name mismatches before validation/execution ---
        try {
            // replace legacy or guessed names
            sql = sql.replace(/profit_loss/gi, 'pnl');
            sql = sql.replace(/\bbalance\b/gi, 'margin_used');

            // normalize status values to match DB (OPEN/CLOSED)
            sql = sql.replace(/'active'/gi, "'OPEN'");
            sql = sql.replace(/'closed'/gi, "'CLOSED'");

            // Ensure LIMIT 50
            if (!/\blimit\b/i.test(sql)) {
                sql = sql.replace(/;?\s*$/g, '');
                sql = sql + ' LIMIT 50';
            }
        } catch (fixErr) {
            console.warn('[smartSearch] sql auto-fix failed:', fixErr && fixErr.message ? fixErr.message : fixErr);
        }

        // 🔐 VALIDATION
        if (!sql.toLowerCase().startsWith('select')) {
            console.log('INVALID SQL FROM AI:', sql);
            return res.status(400).json({
                success: false,
                message: 'AI did not generate valid SELECT query',
                aiOutput: raw || aiSql || sql,
            });
        }

        const blocked = ['DROP', 'DELETE', 'UPDATE', 'INSERT'];
        for (let word of blocked) {
            if (sql.toUpperCase().includes(word)) {
                console.log('UNSAFE SQL DETECTED from AI:', sql);
                return res.status(400).json({ success: false, message: 'Unsafe query detected', aiOutput: raw || aiSql || sql });
            }
        }

        // ✅ EXECUTE QUERY (with SQL error handling)
        try {
            const [rows] = await db.execute(sql);
            return res.json({
                success: true,
                data: rows,
                count: Array.isArray(rows) ? rows.length : 0,
                query: sql,
            });
        } catch (execErr) {
            console.error('SQL EXECUTION ERROR:', execErr.message, 'SQL:', sql);
            return res.status(400).json({
                success: false,
                message: 'Invalid column or SQL error from AI-generated query',
                error: execErr.message,
                sql,
                aiOutput: raw || aiSql,
            });
        }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/ai/execute-command (legacy) ───────────────────────────────────

const executeVoiceCommand = async (req, res) => {
    const { action, userId, username, amount, fromUserId, toUserId, name, email, password } = req.body;

    // ── New format detection: if body has module+operation (from new parser), route through smart system
    const LEGACY_ACTIONS = ['ADD_FUND', 'BLOCK_USER', 'UNBLOCK_USER', 'CREATE_ADMIN', 'TRANSFER_FUND'];
    if (req.body.module && req.body.operation && (!action || !LEGACY_ACTIONS.includes(action))) {
        console.log('[execute-command] Detected new format, routing through smart system');
        try {
            await loadSchema();
            const query = await generateQuery(req.body);
            const result = await executeQuery(query, req.body, req.user || {});
            return res.json({ success: result.type !== 'error', ...result });
        } catch (err) {
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    if (!action) {
        return res.status(400).json({ success: false, message: 'action is required' });
    }

    // ── Devanagari → Latin transliteration (so Hindi speech → DB username match) ──
    const transliterateDevanagari = (text) => {
        const VOWEL_MOD = { 'ा':'a','ि':'i','ी':'i','ु':'u','ू':'u','े':'e','ै':'ai','ो':'o','ौ':'au','ं':'n','ः':'h','्':'' };
        const CONSONANT = {
            'क':'k','ख':'kh','ग':'g','घ':'gh','ङ':'ng',
            'च':'ch','छ':'chh','ज':'j','झ':'jh','ञ':'n',
            'ट':'t','ठ':'th','ड':'d','ढ':'dh','ण':'n',
            'त':'t','थ':'th','द':'d','ध':'dh','न':'n',
            'प':'p','फ':'f','ब':'b','भ':'bh','म':'m',
            'य':'y','र':'r','ल':'l','व':'v','श':'sh',
            'ष':'sh','स':'s','ह':'h','ळ':'l','ड़':'r','ढ़':'r',
            'अ':'a','आ':'aa','इ':'i','ई':'i','उ':'u','ऊ':'u',
            'ए':'e','ऐ':'ai','ओ':'o','औ':'au','ऋ':'ri',
        };
        const chars = [...text];
        let result = '';
        let i = 0;
        while (i < chars.length) {
            const ch = chars[i];
            const next = chars[i + 1];
            if (CONSONANT[ch]) {
                result += CONSONANT[ch];
                if (next && VOWEL_MOD[next] !== undefined) {
                    result += VOWEL_MOD[next]; // explicit vowel modifier
                    i += 2;
                } else if (next && CONSONANT[next]) {
                    result += 'a'; // inherent vowel before next consonant
                    i++;
                } else {
                    i++; // final consonant — drop inherent vowel
                }
            } else if (VOWEL_MOD[ch] !== undefined) {
                result += VOWEL_MOD[ch];
                i++;
            } else {
                result += ch; // keep non-Devanagari as-is
                i++;
            }
        }
        return result;
    };

    // ── Smart user resolver: exact → partial username → partial full_name ──
    // Scoped to only find users under the current admin's hierarchy (parent_id)
    const reqUserForResolve = req.user || {};
    const scopeParentId = (reqUserForResolve.role === 'SUPERADMIN' || reqUserForResolve.role === 'ADMIN') ? reqUserForResolve.id : null;

    const resolveUserByName = async (conn, rawName) => {
        const term = rawName.toString().trim();
        const isDevanagari = /[\u0900-\u097F]/.test(term);
        const latinTerm = isDevanagari ? transliterateDevanagari(term) : term;
        const searchTerms = [...new Set([term, latinTerm])];

        const parentFilter = scopeParentId ? ' AND parent_id = ?' : '';
        const parentParam = scopeParentId ? [scopeParentId] : [];

        for (const t of searchTerms) {
            // 1. Exact username match (case-insensitive)
            const [exact] = await conn.execute(
                `SELECT id, username, full_name FROM users WHERE LOWER(username) = LOWER(?)${parentFilter} LIMIT 1`, [t, ...parentParam]
            );
            if (exact.length) return exact[0];
        }
        for (const t of searchTerms) {
            // 2. Partial username OR full_name match
            const [partial] = await conn.execute(
                `SELECT id, username, full_name FROM users WHERE (LOWER(username) LIKE LOWER(?) OR LOWER(full_name) LIKE LOWER(?))${parentFilter} LIMIT 1`,
                [`%${t}%`, `%${t}%`, ...parentParam]
            );
            if (partial.length) return partial[0];
        }
        return null;
    };

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        // ── Resolve username → userId if username was spoken instead of numeric ID ──
        let resolvedUserId = userId ? parseInt(userId) : null;
        let resolvedUserRow = null;
        if (!resolvedUserId && username) {
            resolvedUserRow = await resolveUserByName(connection, username);
            if (!resolvedUserRow) {
                await connection.rollback();
                return res.status(404).json({ success: false, message: `User "${username}" not found. Please check the name and try again.` });
            }
            resolvedUserId = resolvedUserRow.id;
        }

        // ── Verify target user belongs to the logged-in admin/superadmin ──
        const reqUser = req.user || {};
        if (resolvedUserId && (reqUser.role === 'SUPERADMIN' || reqUser.role === 'ADMIN')) {
            const [parentCheck] = await connection.execute(
                'SELECT id, parent_id, username FROM users WHERE id = ? LIMIT 1', [resolvedUserId]
            );
            if (parentCheck.length && parentCheck[0].parent_id !== reqUser.id) {
                await connection.rollback();
                return res.status(403).json({
                    success: false,
                    message: `User "${parentCheck[0].username}" is not your trading client. You can only execute commands on your own clients.`
                });
            }
        }

        if (action === 'ADD_FUND') {
            if (!resolvedUserId || amount == null) {
                await connection.rollback();
                return res.status(400).json({ success: false, message: 'User (ID or username) and amount are required' });
            }
            const amt = parseFloat(amount);
            if (isNaN(amt) || amt <= 0) {
                await connection.rollback();
                return res.status(400).json({ success: false, message: 'amount must be positive' });
            }
            const [rows] = await connection.execute('SELECT id, balance, username FROM users WHERE id = ?', [resolvedUserId]);
            if (!rows.length) { await connection.rollback(); return res.status(404).json({ success: false, message: `User not found` }); }
            const newBalance = parseFloat(rows[0].balance || 0) + amt;
            await connection.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [amt, resolvedUserId]);
            await connection.execute('INSERT INTO ledger (user_id, amount, type, balance_after, remarks) VALUES (?, ?, ?, ?, ?)', [resolvedUserId, amt, 'DEPOSIT', newBalance, 'Voice command: ADD_FUND']);
            await connection.commit();
            return res.json({ success: true, message: `₹${amt} added to ${rows[0].username}'s account`, userId: resolvedUserId, username: rows[0].username, amountAdded: amt, newBalance });
        }

        if (action === 'WITHDRAW_FUND') {
            if (!resolvedUserId || amount == null) {
                await connection.rollback();
                return res.status(400).json({ success: false, message: 'User (ID or username) and amount are required' });
            }
            const amt = parseFloat(amount);
            if (isNaN(amt) || amt <= 0) {
                await connection.rollback();
                return res.status(400).json({ success: false, message: 'amount must be positive' });
            }
            const [rows] = await connection.execute('SELECT id, balance, username FROM users WHERE id = ?', [resolvedUserId]);
            if (!rows.length) { await connection.rollback(); return res.status(404).json({ success: false, message: `User not found` }); }
            const currentBal = parseFloat(rows[0].balance || 0);
            
            // Margin Block Check
            const [trades] = await connection.execute('SELECT * FROM trades WHERE user_id = ? AND status = "OPEN"', [resolvedUserId]);
            const [settings] = await connection.execute('SELECT config_json FROM client_settings WHERE user_id = ?', [resolvedUserId]);
            const clientConfig = settings.length > 0 ? JSON.parse(settings[0].config_json || '{}') : {};

            const blockedMargin = MarginUtils.calculateTotalRequiredHoldingMargin(trades, clientConfig);
            const withdrawable = currentBal - blockedMargin;

            if (amt > withdrawable) {
                await connection.rollback();
                return res.status(400).json({ success: false, message: `Insufficient Withdrawable Balance. Client has open trades. Available: ₹${withdrawable.toFixed(2)}, Blocked: ₹${blockedMargin.toFixed(2)}` });
            }
            const newBalance = currentBal - amt;
            await connection.execute('UPDATE users SET balance = balance - ? WHERE id = ?', [amt, resolvedUserId]);
            await connection.execute('INSERT INTO ledger (user_id, amount, type, balance_after, remarks) VALUES (?, ?, ?, ?, ?)', [resolvedUserId, amt, 'WITHDRAW', newBalance, 'Voice command: WITHDRAW_FUND']);
            await connection.commit();
            return res.json({ success: true, message: `₹${amt} withdrawn from ${rows[0].username}'s account`, userId: resolvedUserId, username: rows[0].username, amountWithdrawn: amt, newBalance });
        }

        if (action === 'BLOCK_USER') {
            if (!resolvedUserId) { await connection.rollback(); return res.status(400).json({ success: false, message: 'userId or username is required' }); }
            const [rows] = await connection.execute('SELECT id, username FROM users WHERE id = ?', [resolvedUserId]);
            if (!rows.length) { await connection.rollback(); return res.status(404).json({ success: false, message: `User not found` }); }
            await connection.execute("UPDATE users SET status = 'Suspended' WHERE id = ?", [resolvedUserId]);
            await connection.commit();
            return res.json({ success: true, message: `${rows[0].username}'s account blocked successfully` });
        }

        if (action === 'UNBLOCK_USER') {
            if (!resolvedUserId) { await connection.rollback(); return res.status(400).json({ success: false, message: 'userId or username is required' }); }
            const [rows] = await connection.execute('SELECT id, username FROM users WHERE id = ?', [resolvedUserId]);
            if (!rows.length) { await connection.rollback(); return res.status(404).json({ success: false, message: `User not found` }); }
            await connection.execute("UPDATE users SET status = 'Active' WHERE id = ?", [resolvedUserId]);
            await connection.commit();
            return res.json({ success: true, message: `${rows[0].username}'s account unblocked successfully` });
        }

        if (action === 'CREATE_ADMIN') {
            if (!name || !email) { await connection.rollback(); return res.status(400).json({ success: false, message: 'name and email required' }); }
            const username = `${name.toLowerCase().replace(/\s+/g, '_')}_${Date.now().toString().slice(-5)}`;
            const [dup] = await connection.execute('SELECT id FROM users WHERE email = ?', [email]);
            if (dup.length) { await connection.rollback(); return res.status(409).json({ success: false, message: `Email ${email} already exists` }); }
            const plainPass = password || `Admin@${Math.floor(Math.random() * 9000) + 1000}`;
            const hashed = await bcryptLib.hash(plainPass, 10);
            const [result] = await connection.execute(`INSERT INTO users (username, password, full_name, email, role, status, balance, credit_limit) VALUES (?, ?, ?, ?, 'ADMIN', 'Active', 0, 0)`, [username, hashed, name, email]);
            await connection.commit();
            return res.json({ success: true, message: 'Admin created', adminId: result.insertId, username, name, email, password: plainPass });
        }

        if (action === 'TRANSFER_FUND') {
            if (!fromUserId || !toUserId || amount == null) { await connection.rollback(); return res.status(400).json({ success: false, message: 'fromUserId, toUserId and amount required' }); }
            const amt = parseFloat(amount);
            const [fromRows] = await connection.execute('SELECT id, balance FROM users WHERE id = ? FOR UPDATE', [fromUserId]);
            if (!fromRows.length) { await connection.rollback(); return res.status(404).json({ success: false, message: `Source user ${fromUserId} not found` }); }
            const [toRows] = await connection.execute('SELECT id, balance FROM users WHERE id = ? FOR UPDATE', [toUserId]);
            if (!toRows.length) { await connection.rollback(); return res.status(404).json({ success: false, message: `Dest user ${toUserId} not found` }); }
            const fromBal = parseFloat(fromRows[0].balance || 0);

            // Margin Block Check for Source User
            const [trades] = await connection.execute('SELECT * FROM trades WHERE user_id = ? AND status = "OPEN"', [fromUserId]);
            const [settings] = await connection.execute('SELECT config_json FROM client_settings WHERE user_id = ?', [fromUserId]);
            const clientConfig = settings.length > 0 ? JSON.parse(settings[0].config_json || '{}') : {};

            const blockedMargin = MarginUtils.calculateTotalRequiredHoldingMargin(trades, clientConfig);
            const withdrawable = fromBal - blockedMargin;

            if (amt > withdrawable) {
                await connection.rollback();
                return res.status(400).json({ success: false, message: `Insufficient balance to transfer. Source user has open trades. Available: ₹${withdrawable.toFixed(2)}` });
            }

            const newFrom = fromBal - amt;
            const newTo = parseFloat(toRows[0].balance || 0) + amt;
            await connection.execute('UPDATE users SET balance = balance - ? WHERE id = ?', [amt, fromUserId]);
            await connection.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [amt, toUserId]);
            await connection.execute('INSERT INTO ledger (user_id, amount, type, balance_after, remarks) VALUES (?, ?, ?, ?, ?)', [fromUserId, amt, 'WITHDRAW', newFrom, `Transfer to user ${toUserId}`]);
            await connection.execute('INSERT INTO ledger (user_id, amount, type, balance_after, remarks) VALUES (?, ?, ?, ?, ?)', [toUserId, amt, 'DEPOSIT', newTo, `Transfer from user ${fromUserId}`]);
            await connection.commit();
            return res.json({ success: true, message: `₹${amt} transferred`, fromUserId, toUserId, amount: amt, fromBalance: newFrom, toBalance: newTo });
        }

        await connection.rollback();
        return res.status(400).json({ success: false, message: `Unknown action: "${action}"` });

    } catch (err) {
        await connection.rollback();
        return res.status(500).json({ success: false, message: err.message });
    } finally {
        connection.release();
    }
};

// ── POST /api/ai/voice-execute (legacy) ─────────────────────────────────────

const voiceExecute = async (req, res) => {
    const { text } = req.body;

    if (!text || !text.trim()) {
        return res.status(400).json({ success: false, message: 'text is required' });
    }

    // Route through smart system
    req.body.text = text;
    return smartCommand(req, res);
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/chat
// General AI Chat Endpoint — For conversational queries (not command execution)
// Uses OpenAI ChatGPT API for natural language responses
// ─────────────────────────────────────────────────────────────────────────────

const chatWithAI = async (req, res) => {
    const { message } = req.body;
    const reqUser = req.user || {};

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('[chat] 💬 Input:', message);
    console.log('[chat] 👤 User:', reqUser.full_name || reqUser.id || 'anonymous');
    console.log('═══════════════════════════════════════════════════════════════');

    if (!message || !message.trim()) {
        return res.status(400).json({
            success: false,
            message: 'Message is required',
        });
    }

    try {
        // System prompt for trading app assistant with multilingual support
        const systemPrompt = `You are an AI Assistant for a stock trading mobile app called VTRKM.

🌍 LANGUAGE SUPPORT:
- English (English)
- Hindi (हिंदी)
- Hinglish (Mix of Hindi + English)
- Marathi (मराठी)

📱 APP FEATURES:
- Buy/Sell stocks
- View portfolio
- View trades
- Navigate pages (watchlist, trades, portfolio, account)
- Real-time market data

🤖 GUIDELINES:
1. **LANGUAGE DETECTION**: Identify the user's language automatically
2. **SAME LANGUAGE RESPONSE**: Always reply in the EXACT same language the user used
   - If they use English → respond in English
   - If they use Hindi → respond in Hindi (हिंदी)
   - If they use Hinglish → respond in Hinglish (English words + Hindi script)
   - If they use Marathi → respond in Marathi (मराठी)
3. **CONTENT QUALITY**:
   - Be helpful, concise, and friendly
   - Answer trading-related questions
   - Provide market insights and education
   - Suggest how to use app features
4. **IMPORTANT DISCLAIMER**:
   - Never give financial advice
   - Always remind users to do their own research
   - No guaranteed predictions
5. **TONE**: Encouraging, supportive, professional`;

        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: systemPrompt,
                },
                {
                    role: 'user',
                    content: message.trim(),
                },
            ],
            temperature: 0.7,
            max_tokens: 500,
        });

        const aiMessage = response.choices[0]?.message?.content || 'Sorry, I could not generate a response.';

        console.log('[chat] ✅ Response generated');
        console.log('═══════════════════════════════════════════════════════════════\n');

        return res.json({
            success: true,
            message: aiMessage,
            user: reqUser.full_name || reqUser.id || 'User',
        });

    } catch (err) {
        console.error('[chat] ❌ Error:', err.message);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to get AI response',
        });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/transcribe-voice — Convert voice audio to text using Whisper API
// ─────────────────────────────────────────────────────────────────────────────

const transcribeVoice = async (req, res) => {
    const reqUser = req.user || {};

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('[transcribe-voice] 🎙️  Transcribing audio...');
    console.log('[transcribe-voice] 👤 User:', reqUser.full_name || reqUser.id || 'anonymous');
    console.log('═══════════════════════════════════════════════════════════════');

    if (!req.file) {
        return res.status(400).json({
            success: false,
            message: 'Audio file is required',
        });
    }

    try {
        const audioBuffer = req.file.buffer;
        const fileName = req.file.originalname || 'audio.wav';

        // Call OpenAI Whisper API to transcribe
        const transcript = await openai.audio.transcriptions.create({
            file: new File([audioBuffer], fileName, { type: 'audio/wav' }),
            model: 'whisper-1',
            language: 'en', // or auto-detect if needed
        });

        const transcribedText = transcript.text || '';

        console.log('[transcribe-voice] ✅ Transcript:', transcribedText);
        console.log('═══════════════════════════════════════════════════════════════\n');

        return res.json({
            success: true,
            transcript: transcribedText,
            language: 'en',
        });

    } catch (err) {
        console.error('[transcribe-voice] ❌ Error:', err.message);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to transcribe audio',
        });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/tutor
// Educational AI Tutor — Contextual trading education (beginner to advanced)
// Supports Hindi, English, Hinglish. Adapts to user's experience level.
// ─────────────────────────────────────────────────────────────────────────────

const TUTOR_TOPICS = {
    basics: {
        label: 'Trading Basics',
        keywords: ['basic', 'basics', 'beginner', 'start', 'shuru', 'शुरू', 'kaise', 'कैसे', 'what is trading', 'trading kya hai', 'ट्रेडिंग क्या'],
    },
    options: {
        label: 'Options Trading',
        keywords: ['option', 'options', 'call', 'put', 'ce', 'pe', 'strike', 'premium', 'expiry', 'ऑप्शन', 'कॉल', 'पुट'],
    },
    futures: {
        label: 'Futures Trading',
        keywords: ['future', 'futures', 'lot', 'lot size', 'contract', 'margin', 'फ्यूचर', 'लॉट', 'मार्जिन'],
    },
    technical: {
        label: 'Technical Analysis',
        keywords: ['chart', 'candle', 'candlestick', 'support', 'resistance', 'rsi', 'macd', 'moving average', 'indicator', 'pattern', 'चार्ट', 'सपोर्ट', 'रेसिस्टेंस'],
    },
    risk: {
        label: 'Risk Management',
        keywords: ['risk', 'stop loss', 'stoploss', 'sl', 'target', 'tp', 'risk reward', 'position size', 'money management', 'रिस्क', 'स्टॉप लॉस'],
    },
    orders: {
        label: 'Order Types',
        keywords: ['order', 'market order', 'limit order', 'stop order', 'gtt', 'amo', 'bracket', 'ऑर्डर', 'लिमिट', 'मार्केट'],
    },
    commodities: {
        label: 'Commodities (MCX)',
        keywords: ['commodity', 'commodities', 'mcx', 'gold', 'silver', 'crude', 'natural gas', 'copper', 'कमोडिटी', 'सोना', 'चांदी', 'क्रूड'],
    },
    indices: {
        label: 'Index Trading',
        keywords: ['index', 'indices', 'nifty', 'bank nifty', 'sensex', 'midcap', 'finnifty', 'निफ्टी', 'बैंक निफ्टी', 'सेंसेक्स'],
    },
    psychology: {
        label: 'Trading Psychology',
        keywords: ['psychology', 'emotion', 'fear', 'greed', 'discipline', 'patience', 'loss', 'mindset', 'डर', 'लालच', 'माइंडसेट'],
    },
    strategies: {
        label: 'Trading Strategies',
        keywords: ['strategy', 'strategies', 'scalping', 'intraday', 'swing', 'positional', 'hedging', 'स्ट्रेटेजी', 'इंट्राडे', 'स्विंग'],
    },
};

const tutorChat = async (req, res) => {
    const { message, topic, conversationHistory } = req.body;
    const reqUser = req.user || {};

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('[tutor] 📚 Input:', message);
    console.log('[tutor] 📂 Topic:', topic || 'auto-detect');
    console.log('[tutor] 👤 User:', reqUser.full_name || reqUser.id || 'anonymous');
    console.log('═══════════════════════════════════════════════════════════════');

    if (!message || !message.trim()) {
        return res.status(400).json({
            success: false,
            message: 'Message is required',
        });
    }

    try {
        // ── Fetch user's trade stats for contextual teaching ────────────
        let userStats = null;
        try {
            const userId = reqUser.id;
            if (userId) {
                const [tradeRows] = await db.query(
                    `SELECT
                        COUNT(*) as total_trades,
                        SUM(CASE WHEN status = 'CLOSED' THEN 1 ELSE 0 END) as closed_trades,
                        SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) as active_trades,
                        SUM(CASE WHEN type = 'BUY' THEN 1 ELSE 0 END) as buy_trades,
                        SUM(CASE WHEN type = 'SELL' THEN 1 ELSE 0 END) as sell_trades,
                        SUM(CASE WHEN market_type = 'MCX' THEN 1 ELSE 0 END) as mcx_trades,
                        SUM(CASE WHEN market_type = 'NSE' OR market_type = 'EQUITY' THEN 1 ELSE 0 END) as equity_trades,
                        SUM(CASE WHEN market_type = 'NFO' OR market_type = 'OPTIONS' THEN 1 ELSE 0 END) as options_trades,
                        MIN(entry_time) as first_trade_date
                    FROM trades WHERE user_id = ?`,
                    [userId]
                );
                if (tradeRows && tradeRows.length > 0) {
                    userStats = tradeRows[0];
                }
            }
        } catch (statsErr) {
            console.warn('[tutor] ⚠️ Could not fetch user stats:', statsErr.message);
        }

        // ── Determine experience level ──────────────────────────────────
        let experienceLevel = 'beginner';
        let experienceContext = '';
        if (userStats && userStats.total_trades > 0) {
            const totalTrades = userStats.total_trades || 0;
            if (totalTrades > 100) {
                experienceLevel = 'advanced';
                experienceContext = `This user is EXPERIENCED (${totalTrades} total trades, ${userStats.closed_trades} closed). They trade ${userStats.mcx_trades > 0 ? 'MCX commodities' : ''}${userStats.equity_trades > 0 ? ', Equities' : ''}${userStats.options_trades > 0 ? ', Options' : ''}. First trade: ${userStats.first_trade_date || 'unknown'}. Give them advanced insights, pro tips, and deeper analysis.`;
            } else if (totalTrades > 20) {
                experienceLevel = 'intermediate';
                experienceContext = `This user is INTERMEDIATE (${totalTrades} trades so far). They are familiar with basics but still learning. Explain concepts clearly with practical examples from their trading context.`;
            } else {
                experienceLevel = 'beginner';
                experienceContext = `This user is a BEGINNER (only ${totalTrades} trades). Explain everything simply, use analogies, avoid jargon or explain it when used. Be encouraging and patient.`;
            }
        } else {
            experienceContext = 'This user has NO trade history yet. They are completely new. Start from absolute basics, use simple language, real-life analogies, and be very encouraging.';
        }

        // ── Detect topic from message ───────────────────────────────────
        let detectedTopic = topic || null;
        if (!detectedTopic) {
            const msgLower = message.toLowerCase();
            for (const [key, topicData] of Object.entries(TUTOR_TOPICS)) {
                if (topicData.keywords.some(kw => msgLower.includes(kw))) {
                    detectedTopic = key;
                    break;
                }
            }
        }

        // ── Build system prompt ─────────────────────────────────────────
        const systemPrompt = `You are an Expert Trading Tutor AI for a stock/commodity trading app called VTRKM.

🎓 YOUR ROLE:
You are a patient, knowledgeable, and friendly trading tutor. Your job is to TEACH and EDUCATE users about trading concepts — from absolute basics to advanced strategies.

👤 USER CONTEXT:
- Experience Level: ${experienceLevel.toUpperCase()}
- ${experienceContext}

🌍 LANGUAGE SUPPORT:
- English, Hindi (हिंदी), Hinglish (mix), Marathi (मराठी)
- ALWAYS respond in the SAME language the user used
- If user writes in Hinglish, respond in Hinglish

📚 TEACHING STYLE:
1. **For Beginners**: Use simple language, real-life analogies (like vegetable market, cricket betting odds), step-by-step explanations, and emoji for engagement
2. **For Intermediate**: Give practical examples with numbers, compare strategies, share common mistakes to avoid
3. **For Advanced**: Share pro tips, advanced strategies, risk management frameworks, institutional-level insights

📖 TOPICS YOU CAN TEACH:
- Trading Basics (what is trading, how markets work, types of markets)
- Options Trading (calls, puts, strike price, premium, Greeks, strategies)
- Futures Trading (lot size, margin, expiry, rollover, hedging)
- Technical Analysis (charts, candlesticks, indicators, patterns, support/resistance)
- Risk Management (stop loss, position sizing, risk-reward ratio, money management)
- Order Types (market, limit, stop loss, GTT, bracket, cover orders)
- Commodities (MCX - gold, silver, crude oil, natural gas, copper)
- Index Trading (Nifty 50, Bank Nifty, Fin Nifty, Sensex)
- Trading Psychology (emotions, discipline, fear & greed, journaling)
- Trading Strategies (scalping, intraday, swing, positional, hedging)
- Fundamental Analysis (P/E ratio, EPS, market cap, sectors)
- IPO & Mutual Funds (basics for beginners)

${detectedTopic ? `🎯 DETECTED TOPIC: ${TUTOR_TOPICS[detectedTopic]?.label || detectedTopic}\nFocus your response on this topic area.` : ''}

📏 RESPONSE FORMAT:
- Keep responses concise but comprehensive (150-400 words max)
- Use bullet points and numbered lists for clarity
- Include a practical example with real numbers when explaining concepts
- End with a "💡 Quick Tip" relevant to the topic
- If the concept connects to app features, mention how to use them (e.g., "You can set a stop loss in our app when placing an order")
- For complex topics, break into simple parts and ask "Shall I explain more about any part?"

⚠️ IMPORTANT RULES:
- NEVER give specific buy/sell advice or price predictions
- Always say "this is for education only, not financial advice"
- Be encouraging — trading is hard, motivate the learner
- If asked about a topic outside trading, politely redirect: "I'm your trading tutor! Ask me anything about markets and trading."
- Use the user's app context when relevant (e.g., "Since you trade MCX commodities...")`;

        // ── Build messages array ────────────────────────────────────────
        const messages = [
            { role: 'system', content: systemPrompt },
        ];

        // Add conversation history if provided (for multi-turn learning)
        if (conversationHistory && Array.isArray(conversationHistory)) {
            const recentHistory = conversationHistory.slice(-6); // last 3 exchanges
            for (const msg of recentHistory) {
                if (msg.role === 'user' || msg.role === 'assistant') {
                    messages.push({ role: msg.role, content: msg.content });
                }
            }
        }

        messages.push({ role: 'user', content: message.trim() });

        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages,
            temperature: 0.7,
            max_tokens: 800,
        });

        const aiMessage = response.choices[0]?.message?.content || 'Sorry, I could not generate a response.';

        console.log('[tutor] ✅ Response generated | Level:', experienceLevel, '| Topic:', detectedTopic || 'general');
        console.log('═══════════════════════════════════════════════════════════════\n');

        return res.json({
            success: true,
            message: aiMessage,
            experienceLevel,
            detectedTopic: detectedTopic || null,
            topicLabel: detectedTopic ? (TUTOR_TOPICS[detectedTopic]?.label || null) : null,
            user: reqUser.full_name || reqUser.id || 'User',
        });

    } catch (err) {
        console.error('[tutor] ❌ Error:', err.message);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to get tutor response',
        });
    }
};

// GET /api/ai/tutor/topics — Return available tutor topics for the frontend
const getTutorTopics = (req, res) => {
    const topics = Object.entries(TUTOR_TOPICS).map(([key, val]) => ({
        id: key,
        label: val.label,
    }));
    return res.json({ success: true, topics });
};

module.exports = {
    smartCommand,
    masterCommand,
    mediatorCommand,
    parseOnly,
    getSchema,
    aiCommand,
    processVoiceCommand,
    aiParse,
    smartSearch,
    executeVoiceCommand,
    voiceExecute,
    chatWithAI,
    transcribeVoice,
    tutorChat,
    getTutorTopics,
};
