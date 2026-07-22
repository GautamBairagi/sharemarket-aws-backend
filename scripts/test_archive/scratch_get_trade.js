const db = require('./src/config/db');

async function getTrade() {
    try {
        const [rows] = await db.execute(
            "SELECT id, symbol, type, qty, entry_price, exit_price, pnl, brokerage, status, exit_time FROM trades WHERE user_id = 109 AND status = 'CLOSED' ORDER BY exit_time DESC LIMIT 1"
        );
        console.log("TRADE_DATA:", JSON.stringify(rows[0], null, 2));

        const [segments] = await db.execute(
            "SELECT * FROM user_segments WHERE user_id = 109 AND segment = 'MCX'"
        );
        if (segments.length > 0) {
            console.log("\nUSER_SEGMENTS MCX CONFIG:", JSON.stringify(segments[0], null, 2));
        }
        
        process.exit(0);
    } catch (err) {
        console.error("Error executing query:", err);
        process.exit(1);
    }
}

getTrade();
