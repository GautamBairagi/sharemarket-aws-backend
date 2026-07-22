const OpenAI = require('openai');

let openai = null;

if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
    });
    // Debug: log masked key presence (do not print full key)
    try {
        const k = process.env.OPENAI_API_KEY;
        const masked = `${k.slice(0, 8)}...(${k.length} chars)`;
        console.log('[OpenAI] OPENAI_API_KEY detected:', masked);
    } catch (e) { /* ignore */ }
} else {
    console.log('⚠️  OPENAI_API_KEY not set — AI features disabled');
}

module.exports = openai;
