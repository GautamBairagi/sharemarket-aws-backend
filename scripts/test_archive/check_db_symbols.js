const db = require('./src/config/db');

async function checkSymbols() {
  try {
    const [cryptoRows] = await db.execute(`
      SELECT symbol FROM market_group_items mgi
      JOIN market_groups mg ON mgi.group_id = mg.id
      WHERE mg.name = 'CRYPTO'
      ORDER BY mgi.symbol
    `);

    console.log('\n=== CRYPTO SYMBOLS IN DATABASE ===\n');
    if (cryptoRows.length > 0) {
      console.log('Format found:');
      cryptoRows.forEach((row, i) => {
        console.log(`  ${i + 1}. ${row.symbol}`);
      });
    } else {
      console.log('No crypto symbols found in database');
    }

    const [forexRows] = await db.execute(`
      SELECT symbol FROM market_group_items mgi
      JOIN market_groups mg ON mgi.group_id = mg.id
      WHERE mg.name = 'FOREX'
      ORDER BY mgi.symbol
    `);

    console.log('\n=== FOREX SYMBOLS IN DATABASE ===\n');
    if (forexRows.length > 0) {
      console.log('Format found:');
      forexRows.forEach((row, i) => {
        console.log(`  ${i + 1}. ${row.symbol}`);
      });
    } else {
      console.log('No forex symbols found');
    }

    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

checkSymbols();
