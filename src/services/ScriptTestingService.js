const db = require('../config/db');
const kiteService = require('../utils/kiteService');

class ScriptTestingService {
    async fetchAndStoreNfoFutures() {
        try {
            console.log('🚀 [ScriptTestingService] Starting fetch for ALL NFO Futures...');

            if (!kiteService.isAuthenticated()) {
                console.warn('⚠️ Zerodha not connected. Cannot fetch data.');
                return;
            }

            const instruments = await kiteService.getInstruments();

            if (!Array.isArray(instruments) || instruments.length === 0) {
                console.error('❌ No instruments received from Zerodha');
                return;
            }

            console.log(`📦 Total instruments received: ${instruments.length}`);

            const nfoFutures = instruments.filter(i =>
                i.exchange === 'NFO' &&
                i.instrument_type === 'FUT'
            );

            console.log(`🔍 Found ${nfoFutures.length} NFO FUT contracts`);

            if (nfoFutures.length === 0) {
                console.log('⚠️ No NFO FUT contracts found.');
                return;
            }

            const ltpQuerySymbols = nfoFutures.map(i => `NFO:${i.tradingsymbol}`);

            const chunkArray = (arr, size) => {
                const chunks = [];
                for (let i = 0; i < arr.length; i += size) {
                    chunks.push(arr.slice(i, i + size));
                }
                return chunks;
            };

            const chunks = chunkArray(ltpQuerySymbols, 100);
            let ltpData = {};

            console.log(`📡 Fetching LTP in ${chunks.length} batches...`);

            for (const [index, chunk] of chunks.entries()) {
                try {
                    console.log(`➡️ Batch ${index + 1}/${chunks.length}: ${chunk.length} symbols`);
                    const batchData = await kiteService.getLTP(chunk);
                    ltpData = { ...ltpData, ...batchData };
                } catch (err) {
                    console.error(`❌ LTP batch ${index + 1} failed:`, err.message);
                }
            }

            const connection = await db.getConnection();

            try {
                await connection.beginTransaction();

                await connection.execute('DELETE FROM script_testing');

                const values = nfoFutures.map(i => {
                    const key = `NFO:${i.tradingsymbol}`;
                    const ltpValue = ltpData[key]?.last_price || 0;

                    return [
                        i.tradingsymbol,
                        i.name,
                        i.instrument_token,
                        i.instrument_type,
                        i.exchange,
                        i.expiry || null,
                        parseInt(i.lot_size) || 1,
                        ltpValue
                    ];
                });

                if (values.length > 0) {
                    await connection.query(
                        `INSERT INTO script_testing 
            (tradingsymbol, name, instrument_token, instrument_type, exchange, expiry, lot_size, ltp) 
            VALUES ?`,
                        [values]
                    );
                }

                await connection.commit();

                console.log(`✅ Stored ${values.length} NFO FUT records in script_testing table.`);
            } catch (err) {
                await connection.rollback();
                console.error('❌ Database Error:', err);
            } finally {
                connection.release();
            }

        } catch (error) {
            console.error('❌ Execution Error:', error);
        }
    }
}

module.exports = new ScriptTestingService();