const db = require('./src/config/db');

async function run() {
    try {
        console.log("Starting DB migration to add Mini and Custom Commodity symbols...");

        const lotSizes = [
            { symbol: 'NGASM', category: 'COMMODITY', lot_size: 1000, usdinr_value: 94.53 },
            { symbol: 'USOILM', category: 'COMMODITY', lot_size: 100, usdinr_value: 94.53 },
            { symbol: 'XAGUSDM', category: 'COMMODITY', lot_size: 500, usdinr_value: 94.53 },
            { symbol: 'XAUUSDM', category: 'COMMODITY', lot_size: 10, usdinr_value: 94.53 },
            { symbol: 'MNGAS', category: 'COMMODITY', lot_size: 1000, usdinr_value: 94.53 },
            { symbol: 'MUSOIL', category: 'COMMODITY', lot_size: 100, usdinr_value: 94.53 },
            { symbol: 'MXAG', category: 'COMMODITY', lot_size: 500, usdinr_value: 94.53 },
            { symbol: 'MXAU', category: 'COMMODITY', lot_size: 10, usdinr_value: 94.53 },
        ];

        for (const item of lotSizes) {
            // Check if symbol exists in commodity_forex_crypto_lot_sizes
            const [existing] = await db.query('SELECT id FROM commodity_forex_crypto_lot_sizes WHERE symbol = ?', [item.symbol]);
            if (existing.length > 0) {
                console.log(`Symbol ${item.symbol} already exists in commodity_forex_crypto_lot_sizes. Updating lot_size to ${item.lot_size}`);
                await db.query(
                    'UPDATE commodity_forex_crypto_lot_sizes SET lot_size = ?, category = ?, usdinr_value = ? WHERE symbol = ?',
                    [item.lot_size, item.category, item.usdinr_value, item.symbol]
                );
            } else {
                console.log(`Inserting ${item.symbol} into commodity_forex_crypto_lot_sizes with lot_size ${item.lot_size}`);
                await db.query(
                    'INSERT INTO commodity_forex_crypto_lot_sizes (symbol, category, lot_size, usdinr_value) VALUES (?, ?, ?, ?)',
                    [item.symbol, item.category, item.lot_size, item.usdinr_value]
                );
            }
        }

        const marketGroupItems = [
            { group_id: 15019, symbol: 'NGASM', name: 'Natural Gas Mini', category: 'commodity', exchange: 'COMMODITY', sort_order: 10 },
            { group_id: 15019, symbol: 'USOILM', name: 'WTI Crude Oil Mini', category: 'commodity', exchange: 'COMMODITY', sort_order: 11 },
            { group_id: 15019, symbol: 'XAGUSDM', name: 'Silver Spot Mini', category: 'commodity', exchange: 'COMMODITY', sort_order: 12 },
            { group_id: 15019, symbol: 'XAUUSDM', name: 'Gold Spot Mini', category: 'commodity', exchange: 'COMMODITY', sort_order: 13 },
            { group_id: 15019, symbol: 'MNGAS', name: 'Natural Gas Custom', category: 'commodity', exchange: 'COMMODITY', sort_order: 14 },
            { group_id: 15019, symbol: 'MUSOIL', name: 'WTI Crude Oil Custom', category: 'commodity', exchange: 'COMMODITY', sort_order: 15 },
            { group_id: 15019, symbol: 'MXAG', name: 'Silver Spot Custom', category: 'commodity', exchange: 'COMMODITY', sort_order: 16 },
            { group_id: 15019, symbol: 'MXAU', name: 'Gold Spot Custom', category: 'commodity', exchange: 'COMMODITY', sort_order: 17 },
        ];

        for (const item of marketGroupItems) {
            // Check if symbol exists in market_group_items COMMODITY group
            const [existing] = await db.query('SELECT id FROM market_group_items WHERE group_id = ? AND symbol = ?', [item.group_id, item.symbol]);
            if (existing.length > 0) {
                console.log(`Symbol ${item.symbol} already exists in market_group_items for group COMMODITY. Updating name to ${item.name}`);
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

        console.log("DB migration completed successfully!");
        process.exit(0);
    } catch (e) {
        console.error("Migration failed:", e);
        process.exit(1);
    }
}
run();
