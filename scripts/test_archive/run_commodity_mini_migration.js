const db = require('./src/config/db');

async function run() {
    try {
        console.log("=== STARTING COMMODITY MINI MIGRATION ===");

        // 1. Get the COMMODITY group ID dynamically
        const [groups] = await db.query("SELECT id FROM market_groups WHERE name = 'COMMODITY'");
        if (groups.length === 0) {
            console.error("❌ Error: COMMODITY group not found in market_groups table!");
            process.exit(1);
        }
        const commodityGroupId = groups[0].id;
        console.log(`✅ Found COMMODITY group with ID: ${commodityGroupId}`);

        // 2. Define Mini symbols data
        const miniSymbols = [
            { symbol: 'XAUUSDM', category: 'COMMODITY', lot_size: 10, usdinr_value: 94.53, name: 'Gold Mini' },
            { symbol: 'XAGUSDM', category: 'COMMODITY', lot_size: 500, usdinr_value: 94.53, name: 'Silver Mini' },
            { symbol: 'USOILM', category: 'COMMODITY', lot_size: 100, usdinr_value: 94.53, name: 'Crude Oil Mini' },
            { symbol: 'NGASM', category: 'COMMODITY', lot_size: 1000, usdinr_value: 94.53, name: 'Natural Gas Mini' },
            { symbol: 'COPPERM', category: 'COMMODITY', lot_size: 250, usdinr_value: 94.53, name: 'Copper Mini' }
        ];

        // 3. Upsert into commodity_forex_crypto_lot_sizes
        console.log("\n--- Syncing commodity_forex_crypto_lot_sizes ---");
        for (const item of miniSymbols) {
            const [existing] = await db.query('SELECT id FROM commodity_forex_crypto_lot_sizes WHERE symbol = ?', [item.symbol]);
            if (existing.length > 0) {
                console.log(`Updating lot size for ${item.symbol} to ${item.lot_size}`);
                await db.query(
                    'UPDATE commodity_forex_crypto_lot_sizes SET lot_size = ?, category = ?, usdinr_value = ? WHERE symbol = ?',
                    [item.lot_size, item.category, item.usdinr_value, item.symbol]
                );
            } else {
                console.log(`Inserting ${item.symbol} with lot_size ${item.lot_size}`);
                await db.query(
                    'INSERT INTO commodity_forex_crypto_lot_sizes (symbol, category, lot_size, usdinr_value) VALUES (?, ?, ?, ?)',
                    [item.symbol, item.category, item.lot_size, item.usdinr_value]
                );
            }
        }

        // 4. Upsert into market_group_items
        console.log("\n--- Syncing market_group_items ---");
        for (let i = 0; i < miniSymbols.length; i++) {
            const item = miniSymbols[i];
            const [existing] = await db.query(
                'SELECT id FROM market_group_items WHERE group_id = ? AND symbol = ?',
                [commodityGroupId, item.symbol]
            );

            if (existing.length > 0) {
                console.log(`Updating ${item.symbol} in market_group_items`);
                await db.query(
                    'UPDATE market_group_items SET name = ?, category = ?, exchange = ?, sort_order = ? WHERE group_id = ? AND symbol = ?',
                    [item.name, 'commodity', 'COMMODITY', 10 + i, commodityGroupId, item.symbol]
                );
            } else {
                console.log(`Inserting ${item.symbol} into market_group_items`);
                await db.query(
                    'INSERT INTO market_group_items (group_id, symbol, name, category, exchange, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
                    [commodityGroupId, item.symbol, item.name, 'commodity', 'COMMODITY', 10 + i]
                );
            }
        }

        // 5. Cleanup custom symbols
        const customSymbols = ['MXAU', 'MXAG', 'MUSOIL', 'MNGAS', 'MCOPPER'];
        console.log("\n--- Cleaning up obsolete Custom symbols ---");
        for (const sym of customSymbols) {
            const [res1] = await db.query('DELETE FROM commodity_forex_crypto_lot_sizes WHERE symbol = ?', [sym]);
            const [res2] = await db.query('DELETE FROM market_group_items WHERE symbol = ?', [sym]);
            console.log(`Removed ${sym}: ${res1.affectedRows} from lot_sizes, ${res2.affectedRows} from market_group_items`);
        }

        console.log("\n=== COMMODITY MINI MIGRATION COMPLETED SUCCESSFULLY ===");
        process.exit(0);
    } catch (e) {
        console.error("❌ Migration Error:", e);
        process.exit(1);
    }
}
run();
