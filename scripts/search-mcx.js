const mysql = require('mysql2/promise');
require('dotenv').config();

const searchMCX = async (searchTerm) => {
    try {
        const connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'traderdb'
        });

        const query = searchTerm ?
            `SELECT symbol, lot_size, market_type FROM scrip_data WHERE market_type = 'MCX' AND symbol LIKE ? ORDER BY symbol` :
            `SELECT symbol, lot_size, market_type FROM scrip_data WHERE market_type = 'MCX' ORDER BY symbol`;

        const params = searchTerm ? [`%${searchTerm.toUpperCase()}%`] : [];
        const [results] = await connection.execute(query, params);

        console.log(`\n📋 MCX SCRIPTS ${searchTerm ? `matching "${searchTerm}"` : ''}\n`);
        console.log(`Found: ${results.length} scripts\n`);

        results.forEach((row, idx) => {
            console.log(`${(idx + 1).toString().padStart(3)}. ${row.symbol.padEnd(25)} | Lot Size: ${row.lot_size}`);
        });
        console.log('');

        await connection.end();

    } catch (err) {
        console.error('❌ Error:', err.message);
    }
};

const term = process.argv[2] || '';
searchMCX(term);
