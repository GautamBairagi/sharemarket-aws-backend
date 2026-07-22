/**
 * Migration Script: Add exposureType to mcxLotMargins
 *
 * This script updates existing client configurations to include the
 * exposureType field needed by the new MarginService.
 *
 * USAGE:
 * node scripts/migrate_exposure_types.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const db = require('../src/config/db');

const EXPOSURE_TYPE = process.env.MCX_EXPOSURE_TYPE || 'per_lot'; // Default to per_lot if not specified

async function migrateExposureTypes() {
  const connection = await db.getConnection();

  try {
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║  Migrating mcxLotMargins to include exposureType          ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    console.log(`📋 Configuration: Using exposureType="${EXPOSURE_TYPE}"`);
    console.log(`   Set MCX_EXPOSURE_TYPE env var to change this.\n`);

    // Get all client settings
    const [clients] = await connection.execute(
      'SELECT user_id, config_json FROM client_settings WHERE config_json IS NOT NULL'
    );

    let updatedCount = 0;
    let skippedCount = 0;

    for (const client of clients) {
      try {
        const config = JSON.parse(client.config_json || '{}');

        // Check if mcxLotMargins exists
        if (!config.mcxLotMargins || typeof config.mcxLotMargins !== 'object') {
          console.log(`⏭️  Skipped user_id=${client.user_id} (no mcxLotMargins)`);
          skippedCount++;
          continue;
        }

        let updated = false;

        // Add exposureType to each instrument if not already present
        for (const [symbol, marginConfig] of Object.entries(config.mcxLotMargins)) {
          if (!marginConfig.exposureType) {
            marginConfig.exposureType = EXPOSURE_TYPE;
            updated = true;
            console.log(`  ✓ ${symbol}: Added exposureType="${EXPOSURE_TYPE}"`);
          } else {
            console.log(`  ℹ ${symbol}: Already has exposureType="${marginConfig.exposureType}"`);
          }
        }

        if (updated) {
          // Update database
          await connection.execute(
            'UPDATE client_settings SET config_json = ? WHERE user_id = ?',
            [JSON.stringify(config), client.user_id]
          );
          console.log(`✅ Updated user_id=${client.user_id}\n`);
          updatedCount++;
        } else {
          console.log(`✅ Already up-to-date user_id=${client.user_id}\n`);
          updatedCount++;
        }
      } catch (err) {
        console.error(`❌ Error processing user_id=${client.user_id}:`, err.message);
      }
    }

    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║  Migration Complete                                       ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
    console.log(`📊 Summary:`);
    console.log(`   Updated: ${updatedCount}`);
    console.log(`   Skipped: ${skippedCount}`);
    console.log(`   Total:   ${updatedCount + skippedCount}\n`);

    connection.release();
  } catch (err) {
    console.error('❌ Migration failed:', err);
    connection.release();
    process.exit(1);
  }
}

// Run migration
migrateExposureTypes()
  .then(() => {
    console.log('🚀 Migration completed successfully!');
    process.exit(0);
  })
  .catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
  });
