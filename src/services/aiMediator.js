const OpenAI = require('openai');
const db = require('../config/db');

let openai = null;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
} else {
  console.warn("⚠️  OPENAI_API_KEY missing in .env — Universal AI Mediator feature will be disabled.");
}


// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA FOR FUNCTION CALLING
// ─────────────────────────────────────────────────────────────────────────────

const DB_SCHEMA = `
MySQL Database Tables:
users     (id, name, email, phone, balance, status[Active/Blocked], role[ADMIN/TRADER/CLIENT/BROKER], created_at)
trades    (id, user_id, symbol, type[buy/sell], qty, price, status[OPEN/CLOSED/PENDING], created_at)
funds     (id, user_id, amount, type[credit/debit], note, created_at)
ledger    (id, user_id, amount, type, balance_after, created_at)
portfolio (id, user_id, symbol, qty, avg_price, updated_at)
alerts    (id, user_id, symbol, condition, value, active, created_at)
brokers   (id, name, email, status, created_at)
admins    (id, user_id, permissions, created_at)
`;

// ─────────────────────────────────────────────────────────────────────────────
// OPENAI FUNCTION DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

const tools = [
  {
    type: 'function',
    function: {
      name: 'db_read',
      description: 'Execute a SELECT query to read data from the database. Use for any query, list, filter, or search operation.',
      parameters: {
        type: 'object',
        properties: {
          sql: {
            type: 'string',
            description: 'SQL SELECT query with ? placeholders for parameters. Example: "SELECT * FROM users WHERE id = ? AND status = ?"',
          },
          params: {
            type: 'array',
            description: 'Array of parameters to bind to the query placeholders in order. Example: [5, "Active"]',
            items: { type: ['string', 'number', 'boolean', 'null'] },
          },
          description: {
            type: 'string',
            description: 'Human-readable description of what this query does. Example: "Fetch all trades for user ID 5"',
          },
        },
        required: ['sql', 'params', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'db_write',
      description: 'Execute an INSERT, UPDATE, or DELETE query to modify data. Use for creating, updating, or deleting records.',
      parameters: {
        type: 'object',
        properties: {
          sql: {
            type: 'string',
            description: 'SQL INSERT/UPDATE/DELETE query with ? placeholders. Example: "UPDATE users SET balance = balance + ? WHERE id = ?"',
          },
          params: {
            type: 'array',
            description: 'Array of parameters to bind. Example: [5000, 16]',
            items: { type: ['string', 'number', 'boolean', 'null'] },
          },
          description: {
            type: 'string',
            description: 'What this operation does. Example: "Add 5000 rupees to user 16 balance"',
          },
        },
        required: ['sql', 'params', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'db_transaction',
      description: 'Execute multiple db_read and db_write operations as a single transaction. All succeed or all rollback.',
      parameters: {
        type: 'object',
        properties: {
          operations: {
            type: 'array',
            description: 'Array of operations, each with type (read/write), sql, params, description',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['read', 'write'],
                  description: 'Type of operation',
                },
                sql: {
                  type: 'string',
                  description: 'SQL query with ? placeholders',
                },
                params: {
                  type: 'array',
                  description: 'Query parameters',
                  items: { type: ['string', 'number', 'boolean', 'null'] },
                },
                description: {
                  type: 'string',
                  description: 'Human-readable description',
                },
              },
              required: ['type', 'sql', 'params', 'description'],
            },
            minItems: 2,
          },
          description: {
            type: 'string',
            description: 'Overall description of the transaction. Example: "Deduct 1000 from user 5 and log it in ledger"',
          },
        },
        required: ['operations', 'description'],
      },
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// TOOL EXECUTION FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

async function executeDbRead(sql, params) {
  try {
    const [rows] = await db.execute(sql, params);
    return {
      success: true,
      rowCount: rows.length,
      data: rows,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
    };
  }
}

async function executeDbWrite(sql, params) {
  try {
    const result = await db.execute(sql, params);
    return {
      success: true,
      affectedRows: result[0]?.affectedRows || 0,
      insertId: result[0]?.insertId || null,
      message: `Query executed. Affected rows: ${result[0]?.affectedRows || 0}`,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
    };
  }
}

async function executeDbTransaction(operations) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const results = [];

    for (const op of operations) {
      const { type, sql, params, description } = op;
      console.log(`[Transaction] Executing (${type}): ${description}`);

      try {
        if (type === 'read') {
          const [rows] = await conn.execute(sql, params);
          results.push({
            description,
            type: 'read',
            success: true,
            rowCount: rows.length,
            data: rows,
          });
        } else if (type === 'write') {
          const result = await conn.execute(sql, params);
          results.push({
            description,
            type: 'write',
            success: true,
            affectedRows: result[0]?.affectedRows || 0,
            insertId: result[0]?.insertId || null,
          });
        }
      } catch (err) {
        await conn.rollback();
        conn.release();
        return {
          success: false,
          error: `Transaction failed at: ${description}. Error: ${err.message}`,
          results,
        };
      }
    }

    await conn.commit();
    conn.release();
    return {
      success: true,
      message: `Transaction completed. ${operations.length} operations executed.`,
      results,
    };
  } catch (err) {
    await conn.rollback();
    conn.release();
    return {
      success: false,
      error: err.message,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN MEDIATOR FUNCTION WITH AGENTIC LOOP
// ─────────────────────────────────────────────────────────────────────────────

async function mediate(userMessage, messageHistory = []) {
  const systemPrompt = `You are the Universal AI Mediator for a Trading Software Admin Panel.

${DB_SCHEMA}

Your job:
1. Understand ANY user input in ANY language (Hindi, English, Hinglish, etc.)
2. Decide what database operations are needed
3. Use the available tools (db_read, db_write, db_transaction) to execute queries
4. Return a natural language response to the user

RULES:
- Always use parameterized queries with ? placeholders
- Extract userId as integers, userName as strings
- Match names case-insensitively if needed
- Return human-friendly messages in the user's language
- If multiple operations are needed, use db_transaction
- Never make assumptions; ask for clarification if ambiguous

EXAMPLES:
- "rahul ke trades" → db_read to get user ID by name, then fetch trades
- "5000 add karo user 16 me" → db_write to UPDATE users balance
- "user 5 ko block karo aur ledger me mark karo" → db_transaction with 2 writes
`;

  const messages = [
    ...messageHistory.map(m => ({
      role: m.role,
      content: m.content,
    })),
    {
      role: 'user',
      content: userMessage,
    },
  ];

  console.log(`\n[Mediator] Input: "${userMessage}"`);
  console.log(`[Mediator] Message History: ${messages.length} messages`);

  let response;
  let toolResults = [];

  // ─── Agentic Loop: Keep calling until no more tool calls ─────────────────
  let iteration = 0;
  while (iteration < 10) {
    iteration++;
    console.log(`[Mediator] 🔄 Iteration ${iteration}`);

    try {
      if (!openai) {
        throw new Error("OpenAI API key missing. AI features are disabled.");
      }
      response = await openai.chat.completions.create({

        model: 'gpt-4o-mini',
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0,
        max_tokens: 2000,
      });

      console.log(`[Mediator] Response stop_reason: ${response.choices[0].finish_reason}`);

      const assistantMessage = response.choices[0].message;
      messages.push({ role: 'assistant', content: assistantMessage.content || '' });

      // ─── Check for tool calls ───────────────────────────────────────────
      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        console.log('[Mediator] ✅ No more tool calls. Done.');
        break; // Exit loop — no more tools to call
      }

      // ─── Execute all tool calls in this iteration ───────────────────────
      const toolCallResults = [];
      for (const toolCall of assistantMessage.tool_calls) {
        const { id, function: func } = toolCall;
        const { name, arguments: argsStr } = func;

        console.log(`[Mediator] 🔧 Calling tool: ${name}`);

        let args;
        try {
          args = typeof argsStr === 'string' ? JSON.parse(argsStr) : argsStr;
        } catch (err) {
          console.error(`[Mediator] Failed to parse tool args: ${argsStr}`);
          toolCallResults.push({
            tool_call_id: id,
            content: `Error: Invalid tool arguments. ${err.message}`,
          });
          continue;
        }

        let toolResult;
        try {
          if (name === 'db_read') {
            const { sql, params, description } = args;
            console.log(`[Mediator]   Query: ${description}`);
            console.log(`[Mediator]   SQL: ${sql}`);
            toolResult = await executeDbRead(sql, params);
          } else if (name === 'db_write') {
            const { sql, params, description } = args;
            console.log(`[Mediator]   Operation: ${description}`);
            console.log(`[Mediator]   SQL: ${sql}`);
            toolResult = await executeDbWrite(sql, params);
          } else if (name === 'db_transaction') {
            const { operations, description } = args;
            console.log(`[Mediator]   Transaction: ${description}`);
            toolResult = await executeDbTransaction(operations);
          } else {
            toolResult = { success: false, error: `Unknown tool: ${name}` };
          }
        } catch (err) {
          toolResult = { success: false, error: err.message };
        }

        console.log(`[Mediator]   ✓ Result:`, toolResult.success ? 'success' : 'failed');
        toolResults.push(toolResult);

        toolCallResults.push({
          tool_call_id: id,
          content: JSON.stringify(toolResult),
        });
      }

      // ─── Add tool results to message history ────────────────────────────
      messages.push({
        role: 'user',
        content: toolCallResults,
      });

    } catch (err) {
      console.error(`[Mediator] Error in iteration ${iteration}:`, err.message);
      return {
        success: false,
        error: err.message,
        message: 'Mediator encountered an error. Please try again.',
        iterations: iteration,
      };
    }
  }

  // ─── Extract final response text ────────────────────────────────────────
  const finalMessage = messages[messages.length - 1];
  let responseText = '';

  if (typeof finalMessage.content === 'string') {
    responseText = finalMessage.content;
  } else if (Array.isArray(finalMessage.content)) {
    responseText = finalMessage.content
      .filter(c => typeof c === 'string')
      .join('\n');
  }

  console.log(`[Mediator] 🎉 Final response: ${responseText.substring(0, 100)}...`);

  return {
    success: true,
    message: responseText || 'Operation completed successfully',
    toolResults,
    iterations: iteration,
    messageHistory: messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : '[tool results]',
    })),
  };
}

module.exports = { mediate };
