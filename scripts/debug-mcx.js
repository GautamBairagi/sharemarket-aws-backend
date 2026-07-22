const kiteService = require('../src/utils/kiteService');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const debugMCX = async () => {
    try {
        console.log('\n🔍 Debugging MCX Symbols...\n');

        // Check Zerodha connection
        if (!kiteService.isAuthenticated()) {
            console.error('❌ Zerodha not connected!');
            process.exit(1);
        }

        // Load curated list
        const curatedPath = path.join(__dirname, '../data/curated-symbols.json');
        const CURATED = JSON.parse(fs.readFileSync(curatedPath, 'utf-8'));

        console.log('📋 CURATED MCX SYMBOLS:');
        console.log(CURATED.MCX);
        console.log(`\nTotal: ${CURATED.MCX.length}\n`);

        // Fetch all instruments
        console.log('📥 Fetching Zerodha instruments...');
        const instruments = await kiteService.getInstruments();
        console.log(`✅ Fetched ${instruments.length} total instruments\n`);

        // Find MCX instruments
        console.log('🔎 MCX instruments in Zerodha:\n');
        const mcxInstruments = instruments.filter(i => i.exchange === 'MCX');

        console.log(`Total MCX in Zerodha: ${mcxInstruments.length}\n`);

        // Show sample
        console.log('Sample MCX symbols from Zerodha:');
        mcxInstruments.slice(0, 30).forEach(i => {
            console.log(`  • ${i.tradingsymbol || i.name} (type: ${i.instrument_type})`);
        });

        if (mcxInstruments.length > 30) {
            console.log(`  ... and ${mcxInstruments.length - 30} more\n`);
        }

        // Check which curated MCX symbols are in Zerodha
        console.log('\n✔️  MATCHING CURATED MCX WITH ZERODHA:\n');

        const mcxMap = {};
        mcxInstruments.forEach(i => {
            const sym = i.tradingsymbol || i.name;
            if (!mcxMap[sym]) {
                mcxMap[sym] = i;
            }
        });

        let found = 0;
        let notFound = 0;

        CURATED.MCX.forEach(curatedSymbol => {
            if (mcxMap[curatedSymbol]) {
                console.log(`✅ ${curatedSymbol}`);
                found++;
            } else {
                console.log(`❌ ${curatedSymbol} (NOT FOUND)`);
                notFound++;
            }
        });

        console.log(`\n📊 Results:`);
        console.log(`   ✅ Found: ${found}/${CURATED.MCX.length}`);
        console.log(`   ❌ Not Found: ${notFound}/${CURATED.MCX.length}\n`);

        // Show available MCX symbols that are NOT in curated list
        console.log('🔹 Available MCX symbols NOT in curated list:');
        const availableExtra = mcxInstruments
            .map(i => i.tradingsymbol || i.name)
            .filter(sym => !CURATED.MCX.includes(sym))
            .slice(0, 20);

        if (availableExtra.length > 0) {
            availableExtra.forEach(sym => console.log(`  • ${sym}`));
            console.log(`  ... and more\n`);
        } else {
            console.log('  None (all are in curated list)\n');
        }

    } catch (err) {
        console.error('❌ Error:', err.message);
        process.exit(1);
    }
};

debugMCX();
