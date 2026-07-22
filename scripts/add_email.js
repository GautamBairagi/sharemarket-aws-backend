const db = require('./src/config/db');
async function addEmailColumn() {
    try {
        await db.execute('ALTER TABLE users ADD COLUMN email VARCHAR(255) AFTER full_name');
        console.log('Email column added successfully');
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}
addEmailColumn();
