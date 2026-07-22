require('dotenv').config();
const service = require('./src/services/ScriptTestingService');
async function run() {
    await service.fetchAndStoreNfoFutures();
    process.exit(0);
}
run();
