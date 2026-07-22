const db = require('./src/config/db');

async function run() {
    try {
        const customSymbols = ['MXAU', 'MXAG', 'MUSOIL', 'MNGAS', 'MCOPPER'];

        console.log("Removing custom symbols from commodity_forex_crypto_lot_sizes...");
        for (const sym of customSymbols) {
            const [res] = await db.query('DELETE FROM commodity_forex_crypto_lot_sizes WHERE symbol = ?', [sym]);
            console.log(`${sym}: ${res.affectedRows} row(s) deleted`);
        }

        console.log("\nRemoving custom symbols from market_group_items...");
        for (const sym of customSymbols) {
            const [res] = await db.query('DELETE FROM market_group_items WHERE symbol = ?', [sym]);
            console.log(`${sym}: ${res.affectedRows} row(s) deleted`);
        }

        console.log("\nDone!");
        process.exit(0);
    } catch (e) {
        console.error("Error:", e);
        process.exit(1);
    }
}
run();
