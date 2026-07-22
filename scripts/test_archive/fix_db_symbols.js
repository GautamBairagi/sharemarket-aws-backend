const db = require('./src/config/db');

async function fixSymbols() {
  try {
    console.log('\n=== REMOVING NON-WORKING SYMBOLS FROM DATABASE ===\n');

    // Get group IDs
    const [cryptoGroup] = await db.execute(`
      SELECT id FROM market_groups WHERE name = 'CRYPTO'
    `);
    const [forexGroup] = await db.execute(`
      SELECT id FROM market_groups WHERE name = 'FOREX'
    `);

    if (cryptoGroup.length === 0 || forexGroup.length === 0) {
      console.log('❌ Groups not found');
      process.exit(1);
    }

    const cryptoGroupId = cryptoGroup[0].id;
    const forexGroupId = forexGroup[0].id;

    // Remove non-working crypto symbols
    const nonWorkingCrypto = ['MATIC/USD', 'LUNA/USD'];
    for (const sym of nonWorkingCrypto) {
      const [result] = await db.execute(
        `DELETE FROM market_group_items WHERE group_id = ? AND symbol = ?`,
        [cryptoGroupId, sym]
      );
      console.log(`Removed CRYPTO: ${sym} (deleted: ${result.affectedRows})`);
    }

    // Remove non-working forex symbols
    const nonWorkingForex = ['EUR/INR', 'GBP/INR', 'XAG/USD'];
    for (const sym of nonWorkingForex) {
      const [result] = await db.execute(
        `DELETE FROM market_group_items WHERE group_id = ? AND symbol = ?`,
        [forexGroupId, sym]
      );
      console.log(`Removed FOREX: ${sym} (deleted: ${result.affectedRows})`);
    }

    console.log('\n=== FINAL SYMBOL COUNTS ===\n');

    const [cryptoFinal] = await db.execute(`
      SELECT symbol FROM market_group_items WHERE group_id = ? ORDER BY symbol
    `, [cryptoGroupId]);

    const [forexFinal] = await db.execute(`
      SELECT symbol FROM market_group_items WHERE group_id = ? ORDER BY symbol
    `, [forexGroupId]);

    console.log(`✅ CRYPTO (${cryptoFinal.length} symbols):`);
    cryptoFinal.forEach(r => console.log(`   - ${r.symbol}`));

    console.log(`\n✅ FOREX (${forexFinal.length} symbols):`);
    forexFinal.forEach(r => console.log(`   - ${r.symbol}`));

    console.log('\n✅ Database cleaned! Restart server for changes to take effect.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

fixSymbols();
