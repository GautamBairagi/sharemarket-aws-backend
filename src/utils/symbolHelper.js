/**
 * Helper to extract base scrip from MCX symbols (e.g. MCX:CRUDEOIL26APRFUT -> CRUDEOIL)
 */
const getMcxBaseScrip = (symbol) => {
    if (!symbol) return '';
    const s = symbol.split(':').pop().toUpperCase();
    
    // Ordered by length descending to match longest possible prefix first 
    const mcxBases = [
        'GOLDGUINEA', 'GOLDPETAL', 'GOLDM', 'GOLD', 'MGOLD',
        'SILVERMIC', 'SILVERM', 'SILVER', 'MSILVER',
        'CRUDEOILM', 'CRUDEOIL', 'MCRUDEOIL',
        'NATGASMINI', 'NATURALGAS', 'MNATURALGAS',
        'COPPERM', 'COPPER', 'MCOPPER',
        'ZINCMINI', 'ZINC', 'MZINC',
        'LEADMINI', 'LEAD', 'MLEAD',
        'NICKELMINI', 'NICKEL',
        'ALUMINI', 'ALUMINIUM', 'MALUMINIUM',
        'MENTHAOIL', 'COTTONCNDY', 'COTTON',
        'MCXBULLDEX', 'BULLDEX'
    ];

    for (const base of mcxBases) {
        if (s.startsWith(base)) return base;
    }
    return '';
};

/**
 * Static Lot Sizes for MCX
 */
const MCX_LOT_SIZES = {
    'CRUDEOIL': 100, 'NATURALGAS': 1250, 'GOLD': 100, 'GOLDM': 10, 'MGOLD': 10,
    'SILVER': 30, 'SILVERM': 5, 'MSILVER': 5, 'COPPER': 2500, 'MCOPPER': 500, 'ZINC': 5000,
    'MZINC': 1000, 'MLEAD': 1000, 'MALUMINIUM': 1000,
    'NICKEL': 1500, 'LEAD': 5000, 'ALUMINIUM': 5000, 'MENTHAOIL': 360,
    'COTTON': 25, 'BULLDEX': 1, 'GOLDGUINEA': 8, 'GOLDPETAL': 1,
    'ZINCMINI': 1000, 'LEADMINI': 1000, 'NICKELMINI': 100, 'ALUMINI': 1000,
    'CRUDEOILM': 10, 'MCRUDEOIL': 10, 'NATGASMINI': 250, 'MNATURALGAS': 250, 'SILVERMIC': 1
};

/**
 * Gets lot size for a symbol based on market type
 */
const getLotSize = (symbol, marketType) => {
    const mType = (marketType || '').toUpperCase();
    if (mType === 'MCX') {
        const base = getMcxBaseScrip(symbol);
        return MCX_LOT_SIZES[base] || 1;
    }
    // For other segments, default to 1 (should be fetched from DB if needed)
    return 1;
};

module.exports = { getMcxBaseScrip, getLotSize, MCX_LOT_SIZES };
