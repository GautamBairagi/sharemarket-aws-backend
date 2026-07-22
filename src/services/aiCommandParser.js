const OpenAI = require("openai");

let openai = null;

const parseQuery = async (query, injectedSchema = null) => {
  try {
    if (!openai && process.env.OPENAI_API_KEY) {
      openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    if (!openai) {
      throw new Error("OpenAI API key missing");
    }
    const prompt = `
  You are an expert MySQL query generator.

  ### DATABASE SCHEMA:

  ${JSON.stringify(injectedSchema || {})}

  ### COLUMN RULES:
  - profit / pnl → use "pnl"
  - fund → use "margin_used"
  - trade type → use "type"
  - trade status → use "status"

  ### STATUS MAPPING (VERY IMPORTANT):
  - active trades → status = 'OPEN'
  - closed trades → status = 'CLOSED'

  ### STRICT RULES:
  1. ONLY SELECT query
  2. Use ONLY schema columns
  3. DO NOT guess columns
  4. DO NOT use profit_loss or balance
  5. Status values must match DB exactly (OPEN, CLOSED)

  6. LIMIT 50
  7. No explanation
  8. No markdown

  ### EXAMPLES:

  User: show active trades  
  SQL: SELECT * FROM trades WHERE status = 'OPEN' LIMIT 50;

  User: show closed trades  
  SQL: SELECT * FROM trades WHERE status = 'CLOSED' LIMIT 50;

  User: show buy trades  
  SQL: SELECT * FROM trades WHERE type = 'BUY' LIMIT 50;

  User: show sell trades  
  SQL: SELECT * FROM trades WHERE type = 'SELL' LIMIT 50;

  ### USER QUERY:
  "${query}"
  `;
    // Prepare final prompt: prefer injectedSchema (from controller) if provided
    let finalPrompt = prompt;
    if (injectedSchema && Object.keys(injectedSchema).length > 0) {
      const simple = {};
      for (const [tbl, cols] of Object.entries(injectedSchema)) {
        simple[tbl] = Array.isArray(cols) ? cols : Object.keys(cols || {});
      }
      const tablesSection = `### DATABASE SCHEMA:\n${JSON.stringify(simple, null, 2)}\n\n`;
      const enforceCols = `### COLUMN MAPPING (VERY IMPORTANT):\n- profit / pnl / earnings → use "pnl"\n- fund / balance / wallet → use "margin_used" or available column\n- trade type → use "type"\n- trade status → use "status"\n\n### STRICT RULES:\n1. ONLY SELECT query\n2. Use ONLY schema columns\n3. DO NOT guess (profit_loss, balance not allowed)\n4. trades table uses "pnl" NOT "profit_loss"\n5. users table may NOT have "balance"\n\n6. Always LIMIT 50\n7. No explanation\n8. No markdown\n\nStatus values are uppercase (ACTIVE, CLOSED)\n\n`;
      finalPrompt = tablesSection + enforceCols + prompt;
    } else {
      // Optionally attempt to load schema if none was injected
      try {
        // eslint-disable-next-line global-require
        const { loadSchema } = await import('./aiSchemaLoader.js');
        if (typeof loadSchema === 'function') {
          const schema = await loadSchema();
          if (schema && Object.keys(schema).length > 0) {
            const simple = {};
            for (const [tbl, info] of Object.entries(schema)) {
              if (info && info.columnNames) simple[tbl] = info.columnNames;
              else if (Array.isArray(info)) simple[tbl] = info;
            }
            const tablesSection = `### DATABASE SCHEMA:\n${JSON.stringify(simple, null, 2)}\n\n`;
            const enforceCols = `### COLUMN MAPPING (VERY IMPORTANT):\n- profit / pnl / earnings → use "pnl"\n- fund / balance / wallet → use "margin_used" or available column\n- trade type → use "type"\n- trade status → use "status"\n\n### STRICT RULES:\n1. ONLY SELECT query\n2. Use ONLY schema columns\n3. DO NOT guess (profit_loss, balance not allowed)\n4. trades table uses "pnl" NOT "profit_loss"\n5. users table may NOT have "balance"\n\n6. Always LIMIT 50\n7. No explanation\n8. No markdown\n\nStatus values are uppercase (ACTIVE, CLOSED)\n\n`;
            finalPrompt = tablesSection + enforceCols + prompt;
          }
        }
      } catch (e) {
        // ignore schema load errors and continue with prompt
      }
    }

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Generate SQL only" },
        { role: "user", content: finalPrompt }
      ],
      temperature: 0
    });

    const raw = response.choices[0].message.content;
    const sql = raw.trim();

    return { sql, raw };

  } catch (err) {
    console.error('[aiCommandParser] OpenAI error:', err && err.message ? err.message : err);

    // Lightweight fallback for very simple queries to keep UX responsive when OpenAI fails
    try {
      const t = (query || '').toString().toLowerCase();
      if (t.includes('admin')) {
        return { sql: "SELECT * FROM users WHERE role = 'admin' LIMIT 50" };
      }
      if (t.includes('broker')) {
        return { sql: "SELECT * FROM users WHERE role = 'broker' LIMIT 50" };
      }
      if (t.includes('trade')) {
        return { sql: 'SELECT * FROM trades ORDER BY created_at DESC LIMIT 50' };
      }
      if (t.includes('user') || t.includes('users')) {
        return { sql: 'SELECT * FROM users LIMIT 50' };
      }
    } catch (fallbackErr) {
      console.error('[aiCommandParser] Fallback generation failed:', fallbackErr.message || fallbackErr);
    }

    throw new Error("AI parsing failed: " + (err && err.message ? err.message : String(err)));
  }
};

module.exports = { parseQuery };
