const db = require('./src/config/db');

async function run() {
    try {
        console.log("Adding COPPER Mini & Custom symbols...");

        const lotSizes = [
            { symbol: 'COPPER', category: 'COMMODITY', lot_size: 2500, usdinr_value: 94.53 },
            { symbol: 'COPPERM', category: 'COMMODITY', lot_size: 250, usdinr_value: 94.53 },
            { symbol: 'MCOPPER', category: 'COMMODITY', lot_size: 250, usdinr_value: 94.53 },
        ];

        for (const item of lotSizes) {
            const [existing] = await db.query('SELECT id FROM commodity_forex_crypto_lot_sizes WHERE symbol = ?', [item.symbol]);
            if (existing.length > 0) {
                console.log(`${item.symbol} already exists. Updating...`);
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

        const marketGroupItems = [
            { group_id: 15019, symbol: 'COPPERM', name: 'Copper Mini', category: 'commodity', exchange: 'COMMODITY', sort_order: 18 },
            { group_id: 15019, symbol: 'MCOPPER', name: 'Copper Custom', category: 'commodity', exchange: 'COMMODITY', sort_order: 19 },
        ];

        for (const item of marketGroupItems) {
            const [existing] = await db.query('SELECT id FROM market_group_items WHERE group_id = ? AND symbol = ?', [item.group_id, item.symbol]);
            if (existing.length > 0) {
                console.log(`${item.symbol} already in market_group_items. Updating...`);
                await db.query(
                    'UPDATE market_group_items SET name = ?, category = ?, exchange = ?, sort_order = ? WHERE group_id = ? AND symbol = ?',
                    [item.name, item.category, item.exchange, item.sort_order, item.group_id, item.symbol]
                );
            } else {
                console.log(`Inserting ${item.symbol} into market_group_items`);
                await db.query(
                    'INSERT INTO market_group_items (group_id, symbol, name, category, exchange, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
                    [item.group_id, item.symbol, item.name, item.category, item.exchange, item.sort_order]
                );
            }
        }

        console.log("Done!");
        process.exit(0);
    } catch (e) {
        console.error("Error:", e);
        process.exit(1);
    }
}
run();
