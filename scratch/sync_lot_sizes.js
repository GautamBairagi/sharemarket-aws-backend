const db = require('../src/config/db');

async function syncLotSizes() {
    console.log('🔄 Syncing all 27 lot sizes into commodity_forex_crypto_lot_sizes...');

    const comexLotSizes = [
        { symbol: 'XAU/USD', category: 'COMMODITY', lot_size: 100.0, usdinr_value: 94.53 },
        { symbol: 'XAG/USD', category: 'COMMODITY', lot_size: 5000.0, usdinr_value: 94.53 },
        { symbol: 'USOIL', category: 'COMMODITY', lot_size: 1000.0, usdinr_value: 94.53 },
        { symbol: 'NGAS', category: 'COMMODITY', lot_size: 10000.0, usdinr_value: 94.53 },
        { symbol: 'UKOIL', category: 'COMMODITY', lot_size: 1000.0, usdinr_value: 94.53 },
        { symbol: 'COPPER', category: 'COMMODITY', lot_size: 2500.0, usdinr_value: 94.53 },
        { symbol: 'EUR/USD', category: 'FOREX', lot_size: 100000.0, usdinr_value: 94.53 },
        { symbol: 'GBP/USD', category: 'FOREX', lot_size: 100000.0, usdinr_value: 94.53 },
        { symbol: 'USD/CHF', category: 'FOREX', lot_size: 100000.0, usdinr_value: 94.53 },
        { symbol: 'USD/JPY', category: 'FOREX', lot_size: 100000.0, usdinr_value: 94.53 },
        { symbol: 'AUD/CAD', category: 'FOREX', lot_size: 100000.0, usdinr_value: 94.53 },
        { symbol: 'USD/INR', category: 'FOREX', lot_size: 1000.0, usdinr_value: 94.53 },
        { symbol: 'BTC/USD', category: 'CRYPTO', lot_size: 1.0, usdinr_value: 94.53 },
        { symbol: 'ETH/USD', category: 'CRYPTO', lot_size: 1.0, usdinr_value: 94.53 },
        { symbol: 'BNB/USD', category: 'CRYPTO', lot_size: 1.0, usdinr_value: 94.53 },
        { symbol: 'SOL/USD', category: 'CRYPTO', lot_size: 1.0, usdinr_value: 94.53 },
        { symbol: 'ADA/USD', category: 'CRYPTO', lot_size: 1.0, usdinr_value: 94.53 },
        { symbol: 'AVAX/USD', category: 'CRYPTO', lot_size: 1.0, usdinr_value: 94.53 },
        { symbol: 'DOT/USD', category: 'CRYPTO', lot_size: 1.0, usdinr_value: 94.53 },
        { symbol: 'DOGE/USD', category: 'CRYPTO', lot_size: 1.0, usdinr_value: 94.53 },
        { symbol: 'XRP/USD', category: 'CRYPTO', lot_size: 1.0, usdinr_value: 94.53 },
        { symbol: 'XAUUSDM', category: 'COMMODITY', lot_size: 10.0, usdinr_value: 94.53 },
        { symbol: 'XAGUSDM', category: 'COMMODITY', lot_size: 500.0, usdinr_value: 94.53 },
        { symbol: 'USOILM', category: 'COMMODITY', lot_size: 100.0, usdinr_value: 94.53 },
        { symbol: 'NGASM', category: 'COMMODITY', lot_size: 1000.0, usdinr_value: 94.53 },
        { symbol: 'COPPERM', category: 'COMMODITY', lot_size: 250.0, usdinr_value: 94.53 },
        { symbol: 'MCOPPER', category: 'COMMODITY', lot_size: 250.0, usdinr_value: 94.53 }
    ];

    for (const item of comexLotSizes) {
        await db.execute(`
            INSERT INTO commodity_forex_crypto_lot_sizes (symbol, category, lot_size, usdinr_value)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE lot_size = VALUES(lot_size), category = VALUES(category), usdinr_value = VALUES(usdinr_value)
        `, [item.symbol, item.category, item.lot_size, item.usdinr_value]);
    }

    const [rows] = await db.execute('SELECT COUNT(*) as cnt FROM commodity_forex_crypto_lot_sizes');
    console.log(`✅ Success! Total rows in commodity_forex_crypto_lot_sizes: ${rows[0].cnt}`);

    // Trigger reload in CommodityLotService
    const commodityLotService = require('../src/services/CommodityLotService');
    await commodityLotService.load();
    process.exit(0);
}

syncLotSizes().catch(err => {
    console.error('❌ Error syncing lot sizes:', err);
    process.exit(1);
});
