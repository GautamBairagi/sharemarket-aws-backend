require('dotenv').config();
const syncService = require('./src/services/InstrumentSyncService');
async function run() {
    console.log("Starting manual sync...");
    await syncService.sync();
    console.log("Done.");
    process.exit(0);
}
run();
