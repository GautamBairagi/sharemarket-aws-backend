const db = require('./src/config/db');

async function testDb() {
  try {
    const [forexItems] = await db.execute('SELECT * FROM market_group_items WHERE group_id = 8');
    console.log('FOREX ITEMS:');
    console.log(forexItems.map(i => i.symbol));

    const [cryptoItems] = await db.execute('SELECT * FROM market_group_items WHERE group_id = 7');
    console.log('CRYPTO ITEMS:');
    console.log(cryptoItems.map(i => i.symbol));

    const [commodityItems] = await db.execute('SELECT * FROM market_group_items WHERE group_id = 15019');
    console.log('COMMODITY ITEMS:');
    console.log(commodityItems.map(i => i.symbol));
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    process.exit(0);
  }
}

testDb();
