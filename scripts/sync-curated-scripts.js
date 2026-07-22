const fetch = require('node-fetch');
require('dotenv').config();

const API_URL = `http://localhost:${process.env.PORT || 5000}`;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-token';

const syncCuratedScripts = async () => {
    console.log('\n🧹 Syncing Curated Scripts Only...\n');

    try {
        const response = await fetch(`${API_URL}/api/scrips/sync`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${ADMIN_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        if (response.ok) {
            console.log('✅ SYNC SUCCESSFUL!\n');
            console.log(`📊 Results:`);
            console.log(`   • Scripts synced: ${data.count}`);
            console.log(`   • Message: ${data.message}`);
            if (data.breakdown) {
                console.log(`\n📈 Breakdown:`);
                console.log(`   • NSE: ${data.breakdown.NSE} scripts`);
                console.log(`   • MCX: ${data.breakdown.MCX} scripts`);
                console.log(`   • NFO: ${data.breakdown.NFO} underlyings`);
            }
            console.log(`\n${data.note}\n`);
        } else {
            console.log('❌ SYNC FAILED!');
            console.log(`Error: ${data.error}\n`);
        }
    } catch (err) {
        console.error('❌ Request failed:', err.message);
        console.log('\n⚠️ Make sure the backend server is running on port', process.env.PORT || 5000);
    }
};

syncCuratedScripts();
