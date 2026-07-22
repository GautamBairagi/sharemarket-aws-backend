const pool = require('./src/config/db');

const sampleScrips = [
    { symbol: 'CRUDEOIL', lot_size: 1, margin_req: 50000 },
    { symbol: 'GOLD', lot_size: 1, margin_req: 100000 },
    { symbol: 'SILVER', lot_size: 1, margin_req: 80000 },
    { symbol: 'NIFTY', lot_size: 50, margin_req: 150000 },
    { symbol: 'BANKNIFTY', lot_size: 25, margin_req: 130000 },
    { symbol: 'RELIANCE', lot_size: 250, margin_req: 200000 },
    { symbol: 'TCS', lot_size: 175, margin_req: 210000 },
    { symbol: 'HDFCBANK', lot_size: 550, margin_req: 180000 }
];

async function seedScrips() {
    try {
        console.log('Seeding scrip_data...');
        for (const scrip of sampleScrips) {
            await pool.execute(
                'INSERT IGNORE INTO scrip_data (symbol, lot_size, margin_req, status) VALUES (?, ?, ?, ?)',
                [scrip.symbol, scrip.lot_size, scrip.margin_req, 'OPEN']
            );
        }
        console.log('Seed completed successfully!');
    } catch (err) {
        console.error('Error seeding scrips:', err.message);
    } finally {
        process.exit();
    }
}

seedScrips();
