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

const parseOptionSymbol = (sym) => {
    if (!sym) return null;
    const clean = sym.includes(':') ? sym.split(':')[1] : sym;
    const s = clean.trim().toUpperCase();
    
    const matchType = s.match(/(CE|PE)$/);
    if (!matchType) return null;
    const optionType = matchType[1];
    
    const body = s.slice(0, -2).trim();
    
    const rootMatch = body.match(/^([A-Z]+)/);
    if (!rootMatch) return null;
    const root = rootMatch[1];
    
    const remainder = body.slice(root.length).replace(/[\s\-_]/g, '');
    if (!remainder) return null;
    
    let strike = '';
    let expiry = '';
    
    const monthMatch = remainder.match(/^(\d{2}[A-Z]{3}\d{0,2})(\d+)$/);
    if (monthMatch) {
        expiry = monthMatch[1];
        strike = monthMatch[2];
    } else if (remainder.length >= 8) {
        const weeklyMatch = remainder.match(/^(\d{5})(\d+)$/);
        if (weeklyMatch) {
            expiry = weeklyMatch[1];
            strike = weeklyMatch[2];
        } else {
            const digitMatch = remainder.match(/(\d+)$/);
            strike = digitMatch ? digitMatch[1] : remainder;
        }
    } else {
        strike = remainder;
    }
    
    const cleanStrike = parseInt(strike, 10);
    return { root, strike: isNaN(cleanStrike) ? strike : cleanStrike.toString(), optionType, expiry };
};

const parseFuturesBaseSymbol = (sym) => {
    if (!sym) return '';
    const clean = sym.includes(':') ? sym.split(':')[1] : sym;
    let s = clean.replace(/[\s\-_]/g, '').toUpperCase();
    s = s.replace(/(EQ|BE|FUT)$/, '');
    s = s.replace(/\d{2}[A-Z]{3}|\d{6}|\d{5}/g, '');
    s = s.replace(/(FUT)$/, '');
    return s;
};

const isSameInstrument = (sym1, sym2, marketType = '') => {
    if (!sym1 || !sym2) return false;
    const s1 = String(sym1).trim().toUpperCase();
    const s2 = String(sym2).trim().toUpperCase();

    if (s1 === s2) return true;

    const clean1 = s1.includes(':') ? s1.split(':')[1] : s1;
    const clean2 = s2.includes(':') ? s2.split(':')[1] : s2;
    if (clean1 === clean2) return true;

    const noSpace1 = clean1.replace(/[\s\-_]/g, '');
    const noSpace2 = clean2.replace(/[\s\-_]/g, '');
    if (noSpace1 === noSpace2) return true;

    // MCX Scrip comparison using getMcxBaseScrip
    const mcxBase1 = getMcxBaseScrip(s1) || getMcxBaseScrip(clean1);
    const mcxBase2 = getMcxBaseScrip(s2) || getMcxBaseScrip(clean2);
    if (mcxBase1 && mcxBase2 && mcxBase1 === mcxBase2) {
        return true;
    }

    // Options matching
    const opt1 = parseOptionSymbol(s1);
    const opt2 = parseOptionSymbol(s2);
    if (opt1 && opt2) {
        return opt1.root === opt2.root && opt1.strike === opt2.strike && opt1.optionType === opt2.optionType;
    }
    if ((opt1 && !opt2) || (!opt1 && opt2)) {
        return false;
    }

    // Futures / Stock base symbol matching (e.g. NFO:NIFTY26APRFUT vs NIFTY FUT)
    const futBase1 = parseFuturesBaseSymbol(s1);
    const futBase2 = parseFuturesBaseSymbol(s2);
    if (futBase1 && futBase2 && futBase1 === futBase2) {
        return true;
    }

    const eq1 = noSpace1.replace(/(EQ|BE)$/, '');
    const eq2 = noSpace2.replace(/(EQ|BE)$/, '');
    if (eq1 === eq2) return true;

    const norm1 = noSpace1.replace(/USDT$/, 'USD');
    const norm2 = noSpace2.replace(/USDT$/, 'USD');
    if (norm1 === norm2) return true;

    const COMMODITY_MAP = {
        'XAU/USD': 'GOLD', 'XAUUSD': 'GOLD', 'GOLD': 'GOLD',
        'XAG/USD': 'SILVER', 'XAGUSD': 'SILVER', 'SILVER': 'SILVER',
        'USOIL': 'CRUDEOIL', 'CRUDEOIL': 'CRUDEOIL',
        'NGAS': 'NATURALGAS', 'NATURALGAS': 'NATURALGAS'
    };
    const c1 = COMMODITY_MAP[clean1] || COMMODITY_MAP[noSpace1] || clean1;
    const c2 = COMMODITY_MAP[clean2] || COMMODITY_MAP[noSpace2] || clean2;
    if (c1 === c2) return true;

    return false;
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

module.exports = { getMcxBaseScrip, parseOptionSymbol, parseFuturesBaseSymbol, isSameInstrument, getLotSize, MCX_LOT_SIZES };
