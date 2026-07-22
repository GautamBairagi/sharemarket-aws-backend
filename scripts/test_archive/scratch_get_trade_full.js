const db = require('./src/config/db');

async function getTrade() {
    try {
        const [settings] = await db.execute(
            "SELECT config_json FROM client_settings WHERE user_id = 109"
        );
        const config = JSON.parse(settings[0].config_json || '{}');
        console.log("mcxLotMargins:", config.mcxLotMargins);
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

getTrade();
