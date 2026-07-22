const db = require('./src/config/db');

async function check() {
    try {
        console.log("--- commodity_forex_crypto_lot_sizes ---");
        const [lotSizes] = await db.query('SELECT * FROM commodity_forex_crypto_lot_sizes');
        console.log(JSON.stringify(lotSizes, null, 2));

        console.log("\n--- market_groups ---");
        const [groups] = await db.query('SELECT * FROM market_groups');
        console.log(groups);

        console.log("\n--- market_group_items (COMMODITY group) ---");
        const [commodityItems] = await db.query(`
            SELECT mgi.* FROM market_group_items mgi
            JOIN market_groups mg ON mgi.group_id = mg.id
            WHERE mg.name = 'COMMODITY'
        `);
        console.log(commodityItems);

        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}
check();
