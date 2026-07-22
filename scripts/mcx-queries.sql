-- 🔍 MCX SCRIPTS SQL QUERIES

-- 1️⃣ Total MCX scripts count
SELECT COUNT(*) as total_mcx_scripts FROM scrip_data WHERE market_type = 'MCX';

-- 2️⃣ MCX scripts by base symbol
SELECT
    SUBSTRING_INDEX(symbol, '26', 1) as base_symbol,
    COUNT(*) as count,
    GROUP_CONCAT(DISTINCT lot_size) as lot_sizes
FROM scrip_data
WHERE market_type = 'MCX'
GROUP BY base_symbol
ORDER BY base_symbol;

-- 3️⃣ Search MCX by symbol (e.g., GOLD)
SELECT symbol, lot_size, market_type
FROM scrip_data
WHERE market_type = 'MCX' AND symbol LIKE '%GOLD%'
ORDER BY symbol;

-- 4️⃣ All MCX scripts
SELECT symbol, lot_size, market_type
FROM scrip_data
WHERE market_type = 'MCX'
ORDER BY symbol;

-- 5️⃣ MCX futures only (without options)
SELECT symbol, lot_size, market_type
FROM scrip_data
WHERE market_type = 'MCX' AND symbol LIKE '%FUT%'
ORDER BY symbol;

-- 6️⃣ MCX options only
SELECT symbol, lot_size, market_type
FROM scrip_data
WHERE market_type = 'MCX' AND (symbol LIKE '%CE%' OR symbol LIKE '%PE%')
ORDER BY symbol;

-- 7️⃣ Database summary
SELECT market_type, COUNT(*) as count
FROM scrip_data
GROUP BY market_type
ORDER BY count DESC;

-- 8️⃣ Total scripts check
SELECT COUNT(*) as total_scripts FROM scrip_data;

-- 9️⃣ MCX by lot size distribution
SELECT lot_size, COUNT(*) as count
FROM scrip_data
WHERE market_type = 'MCX'
GROUP BY lot_size
ORDER BY count DESC;

-- 🔟 Find specific MCX symbol
SELECT * FROM scrip_data
WHERE market_type = 'MCX' AND symbol = 'GOLD26JUNFUT';

-- 1️⃣1️⃣ All commodities (MCX base symbols only)
SELECT DISTINCT SUBSTRING_INDEX(symbol, '26', 1) as base_symbol,
       MAX(lot_size) as lot_size
FROM scrip_data
WHERE market_type = 'MCX'
GROUP BY base_symbol
ORDER BY base_symbol;

-- 1️⃣2️⃣ MCX with expiry dates (extract from symbol)
SELECT
    symbol,
    CASE
        WHEN symbol LIKE '%MAY%' THEN 'MAY'
        WHEN symbol LIKE '%JUN%' THEN 'JUN'
        WHEN symbol LIKE '%JUL%' THEN 'JUL'
        WHEN symbol LIKE '%AUG%' THEN 'AUG'
        WHEN symbol LIKE '%SEP%' THEN 'SEP'
        WHEN symbol LIKE '%OCT%' THEN 'OCT'
        WHEN symbol LIKE '%NOV%' THEN 'NOV'
        WHEN symbol LIKE '%DEC%' THEN 'DEC'
        ELSE 'OTHER'
    END as expiry_month,
    lot_size
FROM scrip_data
WHERE market_type = 'MCX' AND symbol LIKE '%FUT%'
ORDER BY symbol;
