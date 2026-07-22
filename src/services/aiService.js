/**
 * AI Command Parser Service
 * Supports: Hindi · Hinglish · English
 * Actions: ADD_FUND | CREATE_ADMIN | BLOCK_USER | UNBLOCK_USER | TRANSFER_FUND
 *
 * Provides two parsing engines:
 * 1. Rule-based (regex) — always available, fast
 * 2. OpenAI (gpt-4o-mini) — if OPENAI_API_KEY is valid, with automatic fallback
 */

// ─────────────────────────────────────────────────────────────────────────────
// DUMMY CREDENTIAL GENERATOR
// ─────────────────────────────────────────────────────────────────────────────

const makeDummy = () => {
    const adjectives = ['quick', 'smart', 'bold', 'swift', 'prime'];
    const nouns = ['admin', 'trader', 'broker', 'agent', 'user'];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    const num = Math.floor(Math.random() * 900) + 100;
    return {
        name: `${adj}_${noun}`,
        email: `${adj}.${noun}${num}@example.com`,
        password: `Pass${num}@!`,
    };
};

// ─────────────────────────────────────────────────────────────────────────────
// RULE-BASED PARSER
// ─────────────────────────────────────────────────────────────────────────────

const parseWithRules = (rawText) => {
    const t = rawText.trim();
    const tl = t.toLowerCase();

    // ── Helpers ───────────────────────────────────────────────────────────────

    const extractIdAfter = (str, keywordPattern) => {
        const re = new RegExp(keywordPattern.source + String.raw`\s*[:#]?\s*(\d+)`, 'i');
        const m = str.match(re);
        return m ? { value: parseInt(m[1], 10), fullMatch: m[0] } : null;
    };

    const parseAmount = (str) => {
        const sl = str.toLowerCase();
        // "2 peti" = 2 lakh, "3 khoka" = 3 crore
        const petiMatch = sl.match(/(\d+)\s*(?:peti|पेटी)/i);
        if (petiMatch) return parseInt(petiMatch[1], 10) * 100000;
        const khokaMatch = sl.match(/(\d+)\s*(?:khoka|खोका)/i);
        if (khokaMatch) return parseInt(khokaMatch[1], 10) * 10000000;
        // "1 peti" without number prefix
        if (sl.match(/\b(?:ek\s+)?(?:peti|पेटी)\b/)) return 100000;
        if (sl.match(/\b(?:ek\s+)?(?:khoka|खोका)\b/)) return 10000000;
        // "5k" = 5000
        const km = str.match(/(\d+)\s*k\b/i);
        if (km) return parseInt(km[1], 10) * 1000;
        // "5 lakh" / "5 crore"
        const lakhMatch = sl.match(/(\d+)\s*(?:lakh|lac|लाख)/i);
        if (lakhMatch) return parseInt(lakhMatch[1], 10) * 100000;
        const croreMatch = sl.match(/(\d+)\s*(?:crore|करोड़)/i);
        if (croreMatch) return parseInt(croreMatch[1], 10) * 10000000;
        const nm = str.match(/(\d[\d,]{2,})/);
        if (nm) return parseFloat(nm[1].replace(/,/g, ''));
        const sm = str.match(/(\d+)/);
        return sm ? parseFloat(sm[1]) : null;
    };

    // Extract username from natural language (Hindi/Hinglish/English patterns)
    const SKIP_WORDS = ['user', 'id', 'account', 'fund', 'rupee', 'rupees', 'the', 'a', 'an', 'to', 'from', 'se', 'me', 'ko'];
    const extractUsername = (str) => {
        // "username ke account" or "username ka account"
        let m = str.match(/([a-z][a-z0-9_]+)\s+ke\s+account/i)
            || str.match(/([a-z][a-z0-9_]+)\s+ka\s+account/i);
        if (m && !SKIP_WORDS.includes(m[1].toLowerCase())) return m[1];
        // "username me" or "username mein" — word before me/mein that isn't a keyword or number
        m = str.match(/([a-z][a-z0-9_]+)\s+(?:me|mein)\b/i);
        if (m && !/^\d+$/.test(m[1]) && !SKIP_WORDS.includes(m[1].toLowerCase())) return m[1];
        // "username se" — word before se
        m = str.match(/([a-z][a-z0-9_]+)\s+se\b/i);
        if (m && !/^\d+$/.test(m[1]) && !SKIP_WORDS.includes(m[1].toLowerCase())) return m[1];
        // English "to [username] account" or "to [username]"
        m = str.match(/\bto\s+([a-z][a-z0-9_]+)(?:\s+account)?/i);
        if (m && !/^\d+$/.test(m[1]) && !SKIP_WORDS.includes(m[1].toLowerCase())) return m[1];
        // English "from [username] account" or "from [username]"
        m = str.match(/\bfrom\s+([a-z][a-z0-9_]+)(?:\s+account)?/i);
        if (m && !/^\d+$/.test(m[1]) && !SKIP_WORDS.includes(m[1].toLowerCase())) return m[1];
        return null;
    };

    // ── Intent signals ────────────────────────────────────────────────────────

    const isTransfer = /transfer|bhejo|send\s+to|se\s+.*?\s+(?:me|ko)|from\s+.*?\s+to/.test(tl)
        && /(?:id|user)\s*[:#]?\s*\d+/.test(tl);

    const isCreateAdmin = /(?:new|naya|create|bana[ao]|add\s+a?n?\s*)\s*admin|admin\s+(?:banao|create|add|bana)|admin\s+with/.test(tl);

    const isBlock = /(?<!un)\bblock\b|suspend|band\s*karo|\broko\b/.test(tl);
    const isUnblock = /unblock|activate|chalu\s*karo|kholo/.test(tl);
    const isWithdraw = /nikalo|nikaalo|hatao|withdraw|deduct|wapas\s*karo|minus|ghataao|ghata/.test(tl);
    const isAddWord = /\badd\b|deposit|jama|daalo|dalo|credit|bdhao|badhao/.test(tl);
    const hasPetiKhoka = /peti|पेटी|khoka|खोका|lakh|lac|लाख|crore|करोड़/.test(tl);

    // ── Priority order: most specific → least specific ────────────────────────

    // 1. TRANSFER_FUND
    if (isTransfer) {
        const fromMatch = tl.match(/(?:id|user)\s*[:#]?\s*(\d+)\s+(?:se|from)/i)
            || tl.match(/(?:se|from)\s+(?:id|user)?\s*[:#]?\s*(\d+)/i)
            || tl.match(/(?:id|user)\s*[:#]?\s*(\d+)/i);
        const fromUserId = fromMatch ? parseInt(fromMatch[1], 10) : null;

        const allIds = [...tl.matchAll(/(?:id|user)\s*[:#]?\s*(\d+)/gi)].map(m => parseInt(m[1], 10));
        const toUserId = allIds.length >= 2 ? allIds[1] : null;

        let stripped = tl;
        for (const m of tl.matchAll(/(?:id|user)\s*[:#]?\s*\d+/gi)) stripped = stripped.replace(m[0], '');
        const amount = parseAmount(stripped) || 0;

        return {
            action: 'TRANSFER_FUND',
            fromUserId: fromUserId || null,
            toUserId: toUserId || null,
            amount,
        };
    }

    // 2. CREATE_ADMIN
    if (isCreateAdmin) {
        const emailMatch = tl.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i);
        const nameMatch = t.match(/(?:naam|name)\s+([A-Za-z][A-Za-z\s]{1,30}?)(?:\s+email|\s+id|\s+pass|\s*$)/i);
        const passMatch = t.match(/(?:password|pass|pwd)\s+([^\s]+)/i);

        const isDummy = /dummy|fake|test|sample|random/.test(tl);

        if (isDummy || (!nameMatch && !emailMatch)) {
            const d = makeDummy();
            return {
                action: 'CREATE_ADMIN',
                name: nameMatch ? nameMatch[1].trim() : d.name,
                email: emailMatch ? emailMatch[0] : d.email,
                password: passMatch ? passMatch[1] : d.password,
            };
        }

        return {
            action: 'CREATE_ADMIN',
            name: nameMatch ? nameMatch[1].trim() : 'admin',
            email: emailMatch ? emailMatch[0] : `admin${Date.now()}@example.com`,
            password: passMatch ? passMatch[1] : 'Admin@123',
        };
    }

    // 3. BLOCK_USER
    if (isBlock) {
        const userIdMatch = extractIdAfter(tl, /(?:user\s*id|user|id)/);
        return {
            action: 'BLOCK_USER',
            userId: userIdMatch ? userIdMatch.value : null,
        };
    }

    // 4. UNBLOCK_USER
    if (isUnblock) {
        const userIdMatch = extractIdAfter(tl, /(?:user\s*id|user|id)/);
        return {
            action: 'UNBLOCK_USER',
            userId: userIdMatch ? userIdMatch.value : null,
        };
    }

    // 5. WITHDRAW_FUND
    if ((isWithdraw || (hasPetiKhoka && /\bse\b/.test(tl))) && !isTransfer) {
        const userIdMatch = extractIdAfter(tl, /(?:user\s*id|user|id)/);
        const username = !userIdMatch ? extractUsername(tl) : null;
        const stripped = userIdMatch ? tl.replace(userIdMatch.fullMatch, '') : tl;
        const amount = parseAmount(stripped);
        return {
            action: 'WITHDRAW_FUND',
            userId: userIdMatch ? userIdMatch.value : null,
            username: username || null,
            amount: amount || null,
        };
    }

    // 6. ADD_FUND (flexible parsing — ID-based and username-based)
    if (isAddWord || (hasPetiKhoka && /\bme\b|\bmein\b/.test(tl))) {
        const userIdMatch = extractIdAfter(tl, /(?:user\s*id|user|id)/);
        const username = !userIdMatch ? extractUsername(tl) : null;
        const stripped = userIdMatch ? tl.replace(userIdMatch.fullMatch, '') : tl;
        const amount = parseAmount(stripped);

        if (userIdMatch && amount !== null) {
            return { action: 'ADD_FUND', userId: userIdMatch.value, username: null, amount };
        }
        if (username && amount !== null) {
            return { action: 'ADD_FUND', userId: null, username, amount };
        }
        // Last resort: two bare numbers → first is userId, second is amount
        const allNums = [...tl.matchAll(/\b(\d+)\b/g)].map(m => parseInt(m[1], 10));
        if (allNums.length >= 2) {
            return { action: 'ADD_FUND', userId: allNums[0], username: null, amount: allNums[1] };
        }
    }

    // 7. UNKNOWN
    return { action: 'UNKNOWN', raw: rawText };
};

// ─────────────────────────────────────────────────────────────────────────────
// OPENAI PARSER
// ─────────────────────────────────────────────────────────────────────────────

const OPENAI_SYSTEM_PROMPT = `You are an AI command parser for a trading admin panel.
Users may give commands in Hindi, Hinglish, or English.
Your job is to detect INTENT first, then extract fields. Return structured JSON only — no extra text.

⚠️  IMPORTANT: Do NOT default to ADD_FUND. Detect the correct intent from the sentence.

Supported actions:
1. ADD_FUND      → add/deposit money to a user's account
   With ID:       { "action": "ADD_FUND", "userId": <int>, "username": null, "amount": <int> }
   With username: { "action": "ADD_FUND", "userId": null, "username": "<str>", "amount": <int> }
2. WITHDRAW_FUND → deduct/withdraw money from a user's account
   With ID:       { "action": "WITHDRAW_FUND", "userId": <int>, "username": null, "amount": <int> }
   With username: { "action": "WITHDRAW_FUND", "userId": null, "username": "<str>", "amount": <int> }
3. CREATE_ADMIN  → { "action": "CREATE_ADMIN", "name": "<str>", "email": "<str>", "password": "<str>" }
4. BLOCK_USER    → { "action": "BLOCK_USER", "userId": <int> }
5. UNBLOCK_USER  → { "action": "UNBLOCK_USER", "userId": <int> }
6. TRANSFER_FUND → { "action": "TRANSFER_FUND", "fromUserId": <int>, "toUserId": <int>, "amount": <int> }

Examples:
Input : "ID 16 me 2000 add karo"
Output: { "action": "ADD_FUND", "userId": 16, "username": null, "amount": 2000 }

Input : "username ke account me 5000 daalo"
Output: { "action": "ADD_FUND", "userId": null, "username": "username", "amount": 5000 }

Input : "username me 5000 daalo"
Output: { "action": "ADD_FUND", "userId": null, "username": "username", "amount": 5000 }

Input : "add 3000 to john account"
Output: { "action": "ADD_FUND", "userId": null, "username": "john", "amount": 3000 }

Input : "username ke account se 5000 nikalo"
Output: { "action": "WITHDRAW_FUND", "userId": null, "username": "username", "amount": 5000 }

Input : "username se 2000 nikalo"
Output: { "action": "WITHDRAW_FUND", "userId": null, "username": "username", "amount": 2000 }

Input : "withdraw 1000 from john"
Output: { "action": "WITHDRAW_FUND", "userId": null, "username": "john", "amount": 1000 }

Input : "ID 16 se 500 withdraw karo"
Output: { "action": "WITHDRAW_FUND", "userId": 16, "username": null, "amount": 500 }

Input : "user 10 block karo"
Output: { "action": "BLOCK_USER", "userId": 10 }

Input : "ID 12 ko unblock karo"
Output: { "action": "UNBLOCK_USER", "userId": 12 }

Input : "ID 10 se ID 20 me 500 transfer karo"
Output: { "action": "TRANSFER_FUND", "fromUserId": 10, "toUserId": 20, "amount": 500 }

Input : "new admin banao naam Rahul email rahul@gmail.com"
Output: { "action": "CREATE_ADMIN", "name": "Rahul", "email": "rahul@gmail.com", "password": "Admin@123" }

Money slang:
- "peti" / "पेटी" = 1 lakh (₹1,00,000). "2 peti" = ₹2,00,000
- "khoka" / "खोका" = 1 crore (₹1,00,00,000). "3 khoka" = ₹3,00,00,000
- "5k" = ₹5,000, "2 lakh" = ₹2,00,000, "1 crore" = ₹1,00,00,000

Rules:
- "ke account me / me / daalo / jama / add / deposit" → ADD_FUND
- "ke account se / se / nikalo / hatao / withdraw / deduct" → WITHDRAW_FUND
- "username me 2 peti daalo" → ADD_FUND with amount 200000
- "username se 1 khoka nikalo" → WITHDRAW_FUND with amount 10000000
- "admin banao / create admin" → always CREATE_ADMIN, never ADD_FUND
- If user says a name (non-numeric word) → use "username" field; if numeric ID → use "userId" field
- If dummy/fake/test/sample is mentioned for admin → generate placeholder credentials
- Never return null for action — always detect the correct intent
- Return valid JSON only, no extra text`;

const parseWithOpenAI = async (text) => {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            { role: 'system', content: OPENAI_SYSTEM_PROMPT },
            { role: 'user', content: text },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
    });

    return JSON.parse(completion.choices[0].message.content);
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PARSER ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * parseCommand(text) → structured JSON
 *
 * Orchestrates parsing:
 * 1. Try OpenAI if OPENAI_API_KEY is valid
 * 2. Fallback to rule-based parser if OpenAI fails or key is invalid
 * 3. Logs each step
 * 4. Rejects if action is UNKNOWN
 *
 * @param {string} text - Raw user input
 * @returns {Promise<object>} Parsed command: { action, ...fields }
 * @throws {Error} if action is UNKNOWN
 */
const parseCommand = async (text) => {
    const hasValidKey =
        process.env.OPENAI_API_KEY &&
        process.env.OPENAI_API_KEY.length > 30 &&
        !process.env.OPENAI_API_KEY.startsWith('sk-your') &&
        !process.env.OPENAI_API_KEY.includes('placeholder');

    let result;

    // Force rule-based parser for peti/khoka/lakh/crore (OpenAI gets amounts wrong)
    const hasSlangAmount = /peti|पेटी|khoka|खोका|lakh|lac|लाख|crore|करोड़/i.test(text);

    if (hasSlangAmount) {
        console.log('[parseCommand] Using rule-based parser (slang amount detected: peti/khoka/lakh/crore)');
        result = parseWithRules(text);
    } else if (hasValidKey) {
        try {
            result = await parseWithOpenAI(text);
            console.log('[parseCommand] ✅ OpenAI parser success');
        } catch (err) {
            console.warn('[parseCommand] ⚠️  OpenAI parser failed:', err.message);
            console.log('[parseCommand] Falling back to rule-based parser');
            result = parseWithRules(text);
        }
    } else {
        console.log('[parseCommand] Using rule-based parser (no valid OPENAI_API_KEY)');
        result = parseWithRules(text);
    }

    // Check for unknown action
    if (result.action === 'UNKNOWN') {
        throw new Error('Command not understood. Try: "ID 16 me 5000 add karo" or "user 15 block karo"');
    }

    return result;
};

module.exports = { parseCommand };
