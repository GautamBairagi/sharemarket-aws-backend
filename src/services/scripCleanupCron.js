const cron = require('node-cron');
const db = require('../config/db');
const { sendPdfReportAndPurge } = require('../controllers/scripTickController');

/**
 * Initialize Weekly Script Data Cleanup & PDF Export Cron Job
 */
const initScripCleanupCron = () => {
    console.log('⏰ [scripCleanupCron] Initializing Weekly Script Data Cleanup Cron (Every Sunday at 00:00)...');

    // Run every Sunday at midnight (00:00)
    cron.schedule('0 0 * * 0', async () => {
        console.log('🔄 [scripCleanupCron] Running weekly automated script data export & purge...');
        try {
            const [settingsRows] = await db.execute('SELECT auto_clean_days FROM scrip_export_settings WHERE id = 1');
            const cleanDays = settingsRows[0]?.auto_clean_days || 7;

            const result = await sendPdfReportAndPurge({ forceAll: false, daysBefore: cleanDays });
            console.log(`✅ [scripCleanupCron] Weekly cleanup completed. Purged ${result.count} records. PDF emailed to ${result.emailSentTo}`);
        } catch (err) {
            console.error('❌ [scripCleanupCron] Error during weekly script data cleanup:', err.message);
        }
    });
};

module.exports = { initScripCleanupCron };
