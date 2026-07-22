const db = require('../src/config/db');

const customScripts = [
    { symbol: 'MGOLD', lot_size: 10 },
    { symbol: 'MCRUDEOIL', lot_size: 10 },
    { symbol: 'MSILVER', lot_size: 5 },
    { symbol: 'MNATURALGAS', lot_size: 250 },
    { symbol: 'MCOPPER', lot_size: 500 },
    { symbol: 'MLEAD', lot_size: 1000 },
    { symbol: 'MZINC', lot_size: 1000 },
    { symbol: 'MALUMINIUM', lot_size: 1000 }
];

async function insertCustomScripts() {
    try {
        console.log('Inserting custom MCX scripts into scrip_data...');
        for (const script of customScripts) {
            // Check if already exists
            const [rows] = await db.execute('SELECT * FROM scrip_data WHERE symbol = ? AND market_type = ?', [script.symbol, 'MCX']);
            if (rows.length === 0) {
                await db.execute(
                    `INSERT INTO scrip_data (symbol, lot_size, margin_req, market_type) 
                     VALUES (?, ?, ?, ?)`,
                    [script.symbol, script.lot_size, 50, 'MCX']
                );
                console.log(`Inserted: ${script.symbol} (Lot Size: ${script.lot_size})`);
            } else {
                // Update lot size just in case
                await db.execute(
                    `UPDATE scrip_data SET lot_size = ? WHERE symbol = ? AND market_type = ?`,
                    [script.lot_size, script.symbol, 'MCX']
                );
                console.log(`Updated: ${script.symbol} (Lot Size: ${script.lot_size})`);
            }
        }
        console.log('Done.');
        process.exit(0);
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}

insertCustomScripts();
