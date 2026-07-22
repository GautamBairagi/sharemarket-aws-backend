const db = require('../config/db');
const { logAction } = require('./systemController');
const mockEngine = require('../utils/mockEngine');
const bcrypt = require('bcryptjs');
const { invalidateCache } = require('../utils/cacheManager');
const { getMcxBaseScrip, getLotSize } = require('../utils/symbolHelper');
const { buildTradeLog } = require('../utils/logFormatter');
const MarginService = require('../services/MarginService');
const tradeService = require('../services/TradeService');

const syncPaperPosition = async (userId, symbol, connection = db) => {
    try {
        console.log(`[syncPaperPosition] Syncing paper position for user ${userId}, symbol ${symbol}`);
        const [trades] = await connection.execute(
            "SELECT type, qty, entry_price FROM trades WHERE user_id = ? AND symbol = ? AND status = 'OPEN' AND is_pending = 0",
            [userId, symbol]
        );

        let totalBuyQty = 0;
        let totalBuyCost = 0;
        let totalSellQty = 0;
        let totalSellCost = 0;

        for (const trade of trades) {
            const qty = parseFloat(trade.qty);
            const entryPrice = parseFloat(trade.entry_price);
            if (trade.type.toUpperCase() === 'BUY') {
                totalBuyQty += qty;
                totalBuyCost += qty * entryPrice;
            } else if (trade.type.toUpperCase() === 'SELL') {
                totalSellQty += qty;
                totalSellCost += qty * entryPrice;
            }
        }

        const netQty = totalBuyQty - totalSellQty;
        let avgPrice = 0;
        if (netQty > 0) {
            avgPrice = totalBuyQty > 0 ? (totalBuyCost / totalBuyQty) : 0;
        } else if (netQty < 0) {
            avgPrice = totalSellQty > 0 ? (totalSellCost / totalSellQty) : 0;
        }

        if (netQty === 0) {
            // Delete position if closed
            await connection.execute(
                "DELETE FROM paper_positions WHERE user_id = ? AND symbol = ?",
                [userId, symbol]
            );
            console.log(`[syncPaperPosition] Deleted paper position (netQty = 0)`);
        } else {
            // Insert or update position
            await connection.execute(
                `INSERT INTO paper_positions (user_id, symbol, quantity, avg_price)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE quantity = ?, avg_price = ?, updated_at = CURRENT_TIMESTAMP`,
                [userId, symbol, netQty, avgPrice, netQty, avgPrice]
            );
            console.log(`[syncPaperPosition] Synced paper position: quantity = ${netQty}, avg_price = ${avgPrice}`);
        }
    } catch (err) {
        console.error(`[syncPaperPosition] Error syncing paper position:`, err.message);
    }
};

/**
 * Place a New Order
 */
const placeOrder = async (req, res) => {
    // Safety check: ensure req.body exists
    console.log('[placeOrder] Request received:');
    console.log('  Method:', req.method);
    console.log('  URL:', req.url);
    console.log('  Content-Type:', req.headers['content-type']);
    console.log('  Body type:', typeof req.body);
    console.log('  Body is Array:', Array.isArray(req.body));
    console.log('  Body keys:', req.body ? Object.keys(req.body) : 'N/A');
    console.log('  Body:', JSON.stringify(req.body, null, 2));

    if (!req.body || Object.keys(req.body).length === 0) {
        console.error('[placeOrder] ERROR: req.body is empty or undefined!');
        console.error('[placeOrder] Request headers:', req.headers);
        return res.status(400).json({ message: 'Request body is empty. Please check your request format.' });
    }

    const {
        symbol, type, qty, price,
        order_type = 'MARKET',
        is_pending = false,
        userId: traderId,
        transactionPassword,
        exit_price,
        mcxExposureType = 'PER_LOT_BASIS',  // ✅ ADD THIS - from request body
        tradeType = 'INTRADAY'              // ✅ ADD THIS - from request body (INTRADAY or HOLDING)
    } = req.body;

    const requesterId = req.user.id;
    const requesterRole = req.user.role;
    const tradeIp = req.ip || req.headers['x-forwarded-for'] || '127.0.0.1';

    try {
        console.log('--- Place Order Request ---');
        console.log('Body:', JSON.stringify(req.body, null, 2));
        console.log('Incoming types:', { symbol: typeof symbol, type: typeof type, qtyType: typeof qty, qtyValue: qty });

        // 1. Basic Field Validation
        // Accept numeric strings for qty; treat undefined, null, or empty-string as missing
        const missing = [];
        if (!symbol) missing.push('symbol');
        if (!type) missing.push('type');
        if (qty === undefined || qty === null || qty === '') missing.push('qty');
        if (missing.length > 0) {
            return res.status(400).json({ message: 'Missing required fields: ' + missing.join(', ') });
        }

        // 2. Determine target user (Trader)
        let targetUserId = requesterId;
        if (requesterRole !== 'TRADER' && traderId) {
            targetUserId = traderId;
        }

        // 3. Validate User Exists and Get Balance/Passwo        // ─── OPTIMIZED PARALLELIZE READ PHASE ────────────────────────────────
        // Run all read queries in parallel to minimize round-trip DB latency (especially for remote DBs like Railway)
        const nowTime = new Date();
        const [
            [userRows],
            [requesterRows],
            [clientSettingsRows],
            [scripRows],
            [expiryRuleRows],
            [scripBanRows],
            [openTradesRows],
            [bannedLimitRows]
        ] = await Promise.all([
            db.execute(`
                SELECT u.id, u.username, u.balance, u.transaction_password, u.role,
                       IFNULL(ud.kyc_status, 'PENDING') AS kyc_status
                FROM users u
                LEFT JOIN user_documents ud ON u.id = ud.user_id
                WHERE u.id = ?
            `, [targetUserId]),
            // 2. Requester transaction password (if different user)
            (requesterRole !== 'TRADER')
                ? db.execute('SELECT transaction_password FROM users WHERE id = ?', [requesterId])
                : Promise.resolve([[]]),
            // 3. Client settings AND Broker segments via LEFT JOIN
            db.execute(`
                SELECT cs.config_json, cs.broker_id, bs.segments_json 
                FROM client_settings cs 
                LEFT JOIN broker_shares bs ON cs.broker_id = bs.user_id 
                WHERE cs.user_id = ?
            `, [targetUserId]),
            // 4. Scrip data
            db.execute('SELECT market_type, lot_size, expiry_date FROM scrip_data WHERE symbol = ?', [symbol]),
            // 5. Expiry rules
            db.execute('SELECT * FROM expiry_rules WHERE id = 1'),
            // 6. Banned scrip check
            db.execute('SELECT id FROM banned_scrips WHERE symbol = ?', [symbol]),
            // 7. All open trades for this user (to compute aggregations in memory)
            db.execute('SELECT type, symbol, qty, entry_price, margin_used, pnl, is_pending, market_type, entry_time FROM trades WHERE user_id = ? AND status = "OPEN"', [targetUserId]),
            // 8. Banned limit orders check (only if limit order)
            (order_type !== 'MARKET' && price)
                ? db.execute('SELECT id FROM banned_limit_orders WHERE scrip_id = ? AND start_time <= ? AND end_time >= ?', [symbol, nowTime, nowTime])
                : Promise.resolve([[]])
        ]);

        const targetUser = userRows[0];
        if (!targetUser) {
            return res.status(404).json({ message: 'Target user not found' });
        }

        // 4. Validate Transaction Password (Bypass for TRADER/Client)
        if (requesterRole !== 'TRADER') {
            const requester = requesterRows[0];

            if (!requester || !requester.transaction_password) {
                return res.status(400).json({ message: 'Your transaction password is not set' });
            }

            if (!transactionPassword) {
                return res.status(400).json({ message: 'Transaction password is required' });
            }

            const isMatch = await bcrypt.compare(transactionPassword, requester.transaction_password);
            if (!isMatch) {
                return res.status(403).json({ message: 'Invalid transaction password' });
            }
        }

        // ─── PARSE CLIENT CONFIG FOR VALIDATIONS ───────────────────────────────
        let clientConfig = {};
        let brokerIdForClient = null;
        let brokerSegments = null;
        if (clientSettingsRows.length > 0) {
            clientConfig = JSON.parse(clientSettingsRows[0].config_json || '{}');
            brokerIdForClient = clientSettingsRows[0].broker_id;
            if (clientSettingsRows[0].segments_json) {
                brokerSegments = JSON.parse(clientSettingsRows[0].segments_json);
            }
        }

        // ─── DETECT MARKET TYPE EARLY (needed for all segment-specific validations) ───
        const sym = symbol.toUpperCase();
        const MCX_SYMBOLS = ['GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'CRUDEOIL', 'COPPER', 'NICKEL', 'ZINC', 'LEAD', 'ALUMINIUM', 'ALUMINI', 'NATURALGAS', 'MENTHAOIL', 'COTTON', 'BULLDEX', 'CRUDEOIL MINI', 'ZINCMINI', 'LEADMINI', 'SILVER MIC', 'MGOLD', 'MCRUDEOIL', 'MSILVER', 'MNATURALGAS', 'MCOPPER', 'MLEAD', 'MZINC', 'MALUMINIUM'];
        let marketType = 'MCX';

        // Check explicit prefix first
        if (sym.startsWith('COMMODITY:')) {
            marketType = 'COMMODITY';
        } else if (sym.startsWith('COMEX:')) {
            marketType = 'COMEX';
        } else if (sym.startsWith('CRYPTO:')) {
            marketType = 'CRYPTO';
        } else if (sym.startsWith('FOREX:')) {
            marketType = 'FOREX';
        } else if (sym.startsWith('MCX:')) {
            marketType = 'MCX';
        } else if (sym.startsWith('NSE:') || sym.startsWith('NFO:')) {
            marketType = sym.startsWith('NFO:') ? 'OPTIONS' : 'EQUITY';
        } else if (MCX_SYMBOLS.some(s => sym.includes(s))) {
            marketType = 'MCX';
        } else if (['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'DOT', 'AVAX', 'LTC', 'LINK'].some(c => sym.includes(c)) || sym.includes('USDT')) {
            marketType = 'CRYPTO';
        } else if (['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'GBP/USD', 'EUR/USD', 'USD/JPY', 'USD/CHF', 'AUD/CAD'].some(f => sym.includes(f))) {
            marketType = 'FOREX';
        } else if (['XAU/USD', 'XAG/USD', 'USOIL', 'NGAS'].some(c => sym.includes(c))) {
            marketType = 'COMMODITY';
        } else if (sym.startsWith('COMEX') || ['GC', 'SI', 'HG', 'CL'].some(c => sym.startsWith(c))) {
            marketType = 'COMEX';
        } else if (sym.startsWith('FOREX') || sym.includes('/')) {
            marketType = 'FOREX';
        } else {
            marketType = 'EQUITY';
        }

        // Apply Database Override for Market Type if defined
        const dbScrip = scripRows[0];
        if (dbScrip && dbScrip.market_type) {
            marketType = dbScrip.market_type;
        }

        // ─── PARSE QUANTITY AND PRICE EARLY (needed for validations) ──────────────
        const qtyNum = parseInt(qty, 10);

        // 🚀 Live Price Fetcher (prioritize MarketDataService, then direct Kite API)
        let liveMarketPrice = null;
        const marketDataService = require('../services/MarketDataService');
        const kiteService = require('../utils/kiteService');

        // Normalize symbol - remove double prefixes from frontend
        let normalizedSymbol = symbol;
        if (symbol.includes('CRYPTO:CRYPTO:') || symbol.includes('FOREX:FOREX:') ||
            symbol.includes('COMMODITY:COMMODITY:') || symbol.includes('COMEX:COMEX:')) {
            normalizedSymbol = symbol
                .replace('CRYPTO:CRYPTO:', 'CRYPTO:')
                .replace('FOREX:FOREX:', 'FOREX:')
                .replace('COMMODITY:COMMODITY:', 'COMMODITY:')
                .replace('COMEX:COMEX:', 'COMEX:');
        }

        // Build search patterns
        const possibleSymbols = [];
        if (!normalizedSymbol.includes(':')) {
            possibleSymbols.push(
                normalizedSymbol,
                `MCX:${normalizedSymbol}`,
                `NSE:${normalizedSymbol}`,
                `NFO:${normalizedSymbol}`,
                `CRYPTO:${normalizedSymbol}`,
                `CRYPTO:${normalizedSymbol.replace(/USDT$/i, '/USD')}`,
                `FOREX:${normalizedSymbol}`,
                `COMMODITY:${normalizedSymbol}`
            );
        } else {
            possibleSymbols.push(normalizedSymbol);
            const colonIdx = normalizedSymbol.indexOf(':');
            const prefixPart = normalizedSymbol.substring(0, colonIdx);
            const symPart    = normalizedSymbol.substring(colonIdx + 1);

            if (prefixPart === 'COMMODITY') {
                const COMMODITY_ALLTICK_MAP = { 'XAU/USD': 'GOLD', 'XAG/USD': 'Silver', 'USOIL': 'USOIL', 'NGAS': 'NGAS' };
                const altCode = COMMODITY_ALLTICK_MAP[symPart] || COMMODITY_ALLTICK_MAP[symPart.toUpperCase()];
                if (altCode) {
                    possibleSymbols.push(`COMMODITY:${altCode}`, `FOREX:${altCode}`, `FOREX:${symPart}`);
                }
                if (symPart.includes('/')) {
                    const noSlash = symPart.replace('/', '');
                    possibleSymbols.push(`COMMODITY:${noSlash}`, `FOREX:${noSlash}`);
                }
            } else if (prefixPart === 'CRYPTO') {
                if (symPart.includes('/')) {
                    possibleSymbols.push(`CRYPTO:${symPart.replace('/', '').replace(/USD$/, 'USDT')}`);
                } else if (symPart.endsWith('USDT')) {
                    const base = symPart.slice(0, -4);
                    possibleSymbols.push(`CRYPTO:${base}/USD`);
                }
            } else {
                if (symPart.includes('/')) {
                    possibleSymbols.push(`${prefixPart}:${symPart.replace('/', '').replace(/USD$/, 'USDT')}`);
                } else if (symPart.endsWith('USDT')) {
                    possibleSymbols.push(`${prefixPart}:${symPart.slice(0, -4)}/USD`);
                }
            }
        }

        for (const s of possibleSymbols) {
            const liveData = marketDataService.getPrice(s);
            if (liveData && liveData.ltp) {
                liveMarketPrice = liveData.ltp;
                break;
            }
        }

        const isCryptoOrForex = marketType === 'CRYPTO' || marketType === 'FOREX';
        const isAllTickSymbol = isCryptoOrForex || marketType === 'COMMODITY';

        // Fetch direct quote from Kite API if not in stream
        if (!liveMarketPrice && !isAllTickSymbol && kiteService.isAuthenticated()) {
            try {
                let kiteSymbol = symbol;
                if (!symbol.includes(':')) {
                    if (marketType === 'MCX') kiteSymbol = `MCX:${symbol}`;
                    else if (marketType === 'EQUITY') kiteSymbol = `NSE:${symbol}`;
                    else if (marketType === 'OPTIONS' || marketType === 'NFO') kiteSymbol = `NFO:${symbol}`;
                }

                const quote = await kiteService.getQuote(kiteSymbol);
                const instrumentKey = Object.keys(quote)[0];
                if (quote[instrumentKey] && quote[instrumentKey].last_price) {
                    liveMarketPrice = quote[instrumentKey].last_price;
                    marketDataService.prices[kiteSymbol] = {
                        ...marketDataService.prices[kiteSymbol],
                        ltp: liveMarketPrice,
                        symbol: kiteSymbol
                    };
                }
            } catch (kiteErr) {
                console.warn(`[placeOrder] Kite Quote Failed for ${symbol}:`, kiteErr.message);
            }
        }

        // Reject order if live price is unavailable
        if (!liveMarketPrice) {
            if (isAllTickSymbol) {
                return res.status(400).json({
                    message: `Live price for ${marketType} symbol "${symbol}" not available. Please wait a moment for market data to load and try again.`
                });
            } else {
                return res.status(400).json({ message: 'Live price not available. Please login to Zerodha and ensure the symbol is available.' });
            }
        }

        const executionPrice = price ? parseFloat(price) : (order_type === 'MARKET' ? liveMarketPrice : 0);
        let marginRequired = 0;

        if (isNaN(executionPrice) || executionPrice <= 0) {
            return res.status(400).json({ message: 'Invalid price for the selected scrip' });
        }
        if (isNaN(qtyNum) || qtyNum <= 0) {
            return res.status(400).json({ message: 'Quantity must be a positive number' });
        }

        // ─── DEMO ACCOUNT CHECK REMOVED ───────────────────────────────────────

        // ─── SEGMENT ENABLE/DISABLE CHECK ─────────────────────────────────────
        if (marketType === 'MCX' && clientConfig.mcxTrading === false) {
            return res.status(400).json({
                message: `MCX Trading is disabled for your account. Please enable it to trade.`
            });
        }
        if (marketType === 'EQUITY' && clientConfig.equityTrading === false) {
            return res.status(400).json({
                message: `EQUITY Trading is disabled for your account. Please enable it to trade.`
            });
        }
        if (marketType === 'OPTIONS' && clientConfig.indexOptionsTrading === false && clientConfig.equityOptionsTrading === false && clientConfig.mcxOptionsTrading === false) {
            return res.status(400).json({
                message: `OPTIONS Trading is disabled for your account. Please enable it to trade.`
            });
        }
        if ((marketType === 'COMEX' || marketType === 'COMMODITY') && clientConfig.comexTrading === false) {
            return res.status(400).json({
                message: `COMEX Trading is disabled for your account. Please enable it to trade.`
            });
        }
        if (marketType === 'FOREX' && clientConfig.forexTrading === false) {
            return res.status(400).json({
                message: `FOREX Trading is disabled for your account. Please enable it to trade.`
            });
        }
        if (marketType === 'CRYPTO' && clientConfig.cryptoTrading === false) {
            return res.status(400).json({
                message: `CRYPTO Trading is disabled for your account. Please enable it to trade.`
            });
        }

        // ─── SCALPING STOP LOSS & SAME-SYMBOL HOLD TIME LOCK CHECK ───
        let minTimeSecondsForScalping = 0;
        if (marketType === 'MCX') minTimeSecondsForScalping = parseInt(clientConfig.mcxMinTimeToBookProfit || 0);
        else if (marketType === 'EQUITY') minTimeSecondsForScalping = parseInt(clientConfig.equityMinTimeToBookProfit || 0);
        else if (marketType === 'OPTIONS') minTimeSecondsForScalping = parseInt(clientConfig.optionsMinTimeToBookProfit || 0);
        else if (marketType === 'CRYPTO') minTimeSecondsForScalping = parseInt((clientConfig.cryptoConfig || {}).minTimeToBookProfit || 0);
        else if (marketType === 'FOREX') minTimeSecondsForScalping = parseInt((clientConfig.forexConfig || {}).minTimeToBookProfit || 0);
        else if (marketType === 'COMEX' || marketType === 'COMMODITY') minTimeSecondsForScalping = parseInt((clientConfig.comexConfig || {}).minTimeToBookProfit || 0);

        let scalpingStopLossEnabled = false;
        if (marketType === 'MCX') scalpingStopLossEnabled = clientConfig.mcxScalpingStopLoss === 'Enabled';
        else if (marketType === 'EQUITY') scalpingStopLossEnabled = clientConfig.equityScalpingStopLoss === 'Enabled';
        else if (marketType === 'OPTIONS') scalpingStopLossEnabled = clientConfig.optionsScalpingStopLoss === 'Enabled';
        else if (marketType === 'CRYPTO') scalpingStopLossEnabled = (clientConfig.cryptoConfig || {}).scalpingStopLoss === 'Enabled';
        else if (marketType === 'FOREX') scalpingStopLossEnabled = (clientConfig.forexConfig || {}).scalpingStopLoss === 'Enabled';
        else if (marketType === 'COMEX' || marketType === 'COMMODITY') scalpingStopLossEnabled = (clientConfig.comexConfig || {}).scalpingStopLoss === 'Enabled';

        if (order_type !== 'MARKET' && !scalpingStopLossEnabled && minTimeSecondsForScalping > 0) {
            // Check active (OPEN) trades of the same symbol in memory
            const activeSameSymbolTrades = openTradesRows.filter(t => t.symbol === symbol);

            for (const activeTrade of activeSameSymbolTrades) {
                const activeEntryTime = new Date(activeTrade.entry_time);
                const secondsHeldActive = Math.floor((new Date() - activeEntryTime) / 1000);
                if (secondsHeldActive < minTimeSecondsForScalping) {
                    const remaining = minTimeSecondsForScalping - secondsHeldActive;
                    return res.status(400).json({
                        message: `Scalping Stop Loss is Disabled. Multiple orders on the same symbol are blocked during hold time. Please wait ${remaining} seconds before re-entering.`
                    });
                }
            }
        }

        // ─── PERMANENT SCRIP BAN CHECK ──────────────────────────────────────────
        if (scripBanRows.length > 0) {
            return res.status(400).json({
                message: `Trading in ${symbol} is prohibited. Scrip is currently banned.`
            });
        }

        // ─── BANNED LIMIT ORDER CHECK ──────────────────────────────────────────
        if (order_type !== 'MARKET') {
            if (clientConfig.banAllSegmentLimitOrder) {
                return res.status(400).json({ message: `Limit orders are disabled for all segments` });
            }
            if (marketType === 'MCX' && clientConfig.banMcxLimitOrder) {
                return res.status(400).json({ message: `Limit orders are banned for MCX segment` });
            }
            if (marketType === 'EQUITY' && clientConfig.banEquityLimitOrder) {
                return res.status(400).json({ message: `Limit orders are banned for EQUITY segment` });
            }
            if (marketType === 'OPTIONS' && clientConfig.banOptionsLimitOrder) {
                return res.status(400).json({ message: `Limit orders are banned for OPTIONS segment` });
            }
            if ((marketType === 'COMEX' || marketType === 'COMMODITY') && clientConfig.comexConfig?.banLimitOrder) {
                return res.status(400).json({ message: `Limit orders are banned for COMEX segment` });
            }
            if (marketType === 'FOREX' && clientConfig.forexConfig?.banLimitOrder) {
                return res.status(400).json({ message: `Limit orders are banned for FOREX segment` });
            }
            if (marketType === 'CRYPTO' && clientConfig.cryptoConfig?.banLimitOrder) {
                return res.status(400).json({ message: `Limit orders are banned for CRYPTO segment` });
            }
            if (bannedLimitRows.length > 0) {
                return res.status(400).json({ message: `Limit orders are banned for ${symbol} during this time period` });
            }
        }

        // ─── MCX LOT SIZE VALIDATIONS (100% COMPLETE - DO NOT MODIFY) ────────
        const MCX_LOT_SIZES = {
            'GOLD': 100, 'GOLDM': 10, 'GOLDGUINEA': 8, 'GOLDPETAL': 1, 'MGOLD': 10,
            'SILVER': 30, 'SILVERM': 5, 'SILVERMIC': 1, 'MSILVER': 5,
            'CRUDEOIL': 100, 'CRUDEOILM': 10, 'MCRUDEOIL': 10,
            'NATURALGAS': 1250, 'NATGASMINI': 250, 'MNATURALGAS': 250,
            'COPPER': 2500, 'MCOPPER': 500,
            'ZINC': 5000, 'ZINCMINI': 1000, 'MZINC': 1000,
            'LEAD': 5000, 'LEADMINI': 1000, 'MLEAD': 1000,
            'NICKEL': 1500, 'NICKELMINI': 100,
            'ALUMINIUM': 5000, 'ALUMINI': 1000, 'MALUMINIUM': 1000,
            'MENTHAOIL': 360, 'COTTON': 25, 'BULLDEX': 1,
        };

        let lotSize = 1;
        if (marketType === 'MCX') {
            const minLot = parseInt(clientConfig.mcxMinLot || 1);
            const maxLot = parseInt(clientConfig.mcxMaxLot || 100);

            if (qtyNum < minLot) {
                return res.status(400).json({ message: `Minimum lot size for MCX is ${minLot}. You entered ${qtyNum}` });
            }
            if (qtyNum > maxLot) {
                return res.status(400).json({ message: `Maximum lot size for MCX is ${maxLot}. You entered ${qtyNum}` });
            }

            const baseSym = getMcxBaseScrip(symbol) || symbol.toUpperCase();
            if (MCX_LOT_SIZES[baseSym]) {
                lotSize = MCX_LOT_SIZES[baseSym];
            }

            let instrumentLotSize = parseInt(clientConfig?.mcxLotMargins?.[baseSym]?.LOT);
            if (isNaN(instrumentLotSize)) {
                instrumentLotSize = maxLot;
            }

            // Compute open MCX trades in memory
            let currentOpenBuyQty = 0;
            let currentOpenSellQty = 0;
            openTradesRows.forEach(trade => {
                const tradeMarketType = trade.market_type || '';
                if (tradeMarketType.toUpperCase() === 'MCX') {
                    const tradeBaseSym = getMcxBaseScrip(trade.symbol) || trade.symbol.toUpperCase();
                    if (tradeBaseSym === baseSym) {
                        if (trade.type === 'BUY') currentOpenBuyQty += parseFloat(trade.qty || 0);
                        if (trade.type === 'SELL') currentOpenSellQty += parseFloat(trade.qty || 0);
                    }
                }
            });

            const currentOpenQty = currentOpenBuyQty > 0 ? currentOpenBuyQty : currentOpenSellQty;
            const openType = currentOpenBuyQty > 0 ? 'BUY' : (currentOpenSellQty > 0 ? 'SELL' : null);
            let newTotalQty = qtyNum;
            const orderTypeUpper = type.toUpperCase();

            if (openType === orderTypeUpper) {
                newTotalQty = currentOpenQty + qtyNum;
            } else if (openType !== null) {
                newTotalQty = Math.max(0, qtyNum - currentOpenQty);
            }

            if (newTotalQty > instrumentLotSize) {
                return res.status(400).json({
                    message: `Maximum limit for ${baseSym} is ${instrumentLotSize} lot(s). You currently hold ${currentOpenQty} ${openType || ''} lot(s). This order would result in holding ${newTotalQty} lot(s).`
                });
            }
        } else if (marketType === 'EQUITY') {
            const minLot = parseInt(clientConfig.equityMinLot || 1);
            const maxLot = parseInt(clientConfig.equityMaxLot || 100);

            if (qtyNum < minLot) {
                return res.status(400).json({ message: `Minimum lot size for Equity is ${minLot}. You entered ${qtyNum}` });
            }
            if (qtyNum > maxLot) {
                return res.status(400).json({ message: `Maximum lot size for Equity is ${maxLot}. You entered ${qtyNum}` });
            }

            if (dbScrip && parseFloat(dbScrip.lot_size) > 0) {
                lotSize = parseFloat(dbScrip.lot_size);
            }
        } else {
            if (dbScrip && parseFloat(dbScrip.lot_size) > 0) {
                lotSize = parseFloat(dbScrip.lot_size);
            }
        }

        // ─── MAX LOT PER SCRIPT VALIDATION ───────────────────────────────────
        if (marketType === 'MCX') {
            const maxLotScrip = parseInt(clientConfig.mcxMaxLotScrip || 0);
            if (maxLotScrip > 0) {
                const currentQtyForSymbol = openTradesRows.filter(t => t.symbol === symbol).reduce((sum, t) => sum + parseFloat(t.qty || 0), 0);
                const newTotalForSymbol = currentQtyForSymbol + qtyNum;

                if (newTotalForSymbol > maxLotScrip) {
                    return res.status(400).json({
                        message: `Max lot size for ${symbol} is ${maxLotScrip}. Current: ${currentQtyForSymbol}, New trade: ${qtyNum}, Total would be: ${newTotalForSymbol}`
                    });
                }
            }
        }

        if (marketType === 'EQUITY') {
            const maxLotScrip = parseInt(clientConfig.equityMaxScrip || 0);
            if (maxLotScrip > 0) {
                const currentQtyForSymbol = openTradesRows.filter(t => t.symbol === symbol).reduce((sum, t) => sum + parseFloat(t.qty || 0), 0);
                const newTotalForSymbol = currentQtyForSymbol + qtyNum;

                if (newTotalForSymbol > maxLotScrip) {
                    return res.status(400).json({
                        message: `Max lot size for ${symbol} is ${maxLotScrip}. Current: ${currentQtyForSymbol}, New trade: ${qtyNum}, Total would be: ${newTotalForSymbol}`
                    });
                }
            }
        }

        // ─── VALIDATE MAX POSITION SIZE ──────────────────────────────────────
        if (marketType === 'MCX') {
            const maxSizeAll = parseInt(clientConfig.mcxMaxSizeAll || 5000);
            const currentOpenQty = openTradesRows.filter(t => (t.market_type || '').toUpperCase() === 'MCX').reduce((sum, t) => sum + parseFloat(t.qty || 0), 0);
            const newTotal = currentOpenQty + qtyNum;

            if (newTotal > maxSizeAll) {
                return res.status(400).json({
                    message: `Total MCX position limit is ${maxSizeAll}. Current: ${currentOpenQty}, New trade: ${qtyNum}, Total would be: ${newTotal}`
                });
            }
        }

        if (marketType === 'EQUITY') {
            const maxSizeAll = parseInt(clientConfig.equityMaxSizeAll || 2000);
            const currentOpenQty = openTradesRows.filter(t => (t.market_type || '').toUpperCase() === 'EQUITY').reduce((sum, t) => sum + parseFloat(t.qty || 0), 0);
            const newTotal = currentOpenQty + qtyNum;

            if (newTotal > maxSizeAll) {
                return res.status(400).json({
                    message: `Total Equity position limit is ${maxSizeAll}. Current: ${currentOpenQty}, New trade: ${qtyNum}, Total would be: ${newTotal}`
                });
            }
        }

        // ─── SEGMENT LIMIT VALIDATION ────────────────────────────────────────
        if (marketType === 'MCX') {
            const segmentLimit = parseInt(clientConfig.mcxSegmentLimit || 0);
            if (segmentLimit > 0) {
                const currentValue = openTradesRows.filter(t => (t.market_type || '').toUpperCase() === 'MCX').reduce((sum, t) => sum + (parseFloat(t.entry_price || 0) * parseFloat(t.qty || 0)), 0);
                const newTradeValue = executionPrice * qtyNum;
                const newTotal = currentValue + newTradeValue;

                if (newTotal > segmentLimit) {
                    return res.status(400).json({
                        message: `MCX segment limit is ₹${segmentLimit.toFixed(2)}. Current value: ₹${currentValue.toFixed(2)}, New trade: ₹${newTradeValue.toFixed(2)}, Total would be: ₹${newTotal.toFixed(2)}`
                    });
                }
            }
        }

        // ─── ALLOW FRESH ENTRY CHECK ─────────────────────────────────────────
        if (!clientConfig.allowFreshEntry) {
            const totalOpenPnL = openTradesRows.reduce((sum, t) => sum + parseFloat(t.pnl || 0), 0);
            const userBalance = parseFloat(targetUser.balance || 0);

            if (totalOpenPnL < 0 && userBalance > 0) {
                const lossPercentage = Math.abs(totalOpenPnL) / userBalance * 100;
                if (lossPercentage > 20) {
                    return res.status(400).json({
                        message: `New entries are blocked. Current loss: ${lossPercentage.toFixed(2)}%. Please close losing positions first.`
                    });
                }
            }
        }

        // ─── EXPIRY RULES CHECK ──────────────────────────────────────────────
        const expiryRule = expiryRuleRows[0];
        if (expiryRule && dbScrip && dbScrip.expiry_date) {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const expiryDate = new Date(dbScrip.expiry_date);
            expiryDate.setHours(0, 0, 0, 0);
            const daysLeft = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));

            const stopDays = parseInt(expiryRule.days_before_expiry) || 0;
            if (stopDays > 0 && daysLeft <= stopDays && expiryRule.allow_expiring_scrip === 'No') {
                return res.status(400).json({
                    message: `${symbol} expires in ${daysLeft} day(s). New orders are not allowed within ${stopDays} days of expiry.`
                });
            }

            // Away points check for limit orders
            if (order_type !== 'MARKET' && price) {
                let currentPriceNow = null;
                const searchPatterns = [];
                if (!normalizedSymbol.includes(':')) {
                    searchPatterns.push(
                        normalizedSymbol,
                        `MCX:${normalizedSymbol}`,
                        `NFO:${normalizedSymbol}`,
                        `NSE:${normalizedSymbol}`,
                        `CRYPTO:${normalizedSymbol}`,
                        `CRYPTO:${normalizedSymbol.replace(/USDT$/i, '/USD')}`,
                        `FOREX:${normalizedSymbol}`
                    );
                } else {
                    searchPatterns.push(normalizedSymbol);
                    if (normalizedSymbol.includes('/')) {
                        searchPatterns.push(normalizedSymbol.replace('/', '').replace(/USD$/, 'USDT'));
                    } else if (normalizedSymbol.endsWith('USDT')) {
                        const baseSym = normalizedSymbol.substring(0, normalizedSymbol.length - 4);
                        const prefix = normalizedSymbol.substring(0, normalizedSymbol.indexOf(':') + 1);
                        searchPatterns.push(`${prefix}${baseSym}/USD`);
                    }
                }

                for (const p of searchPatterns) {
                    const data = marketDataService.getPrice(p);
                    if (data && data.ltp) {
                        currentPriceNow = data.ltp;
                        break;
                    }
                }

                if (!currentPriceNow && kiteService.isAuthenticated()) {
                    try {
                        const kiteSym = symbol.includes(':') ? symbol : (marketType === 'MCX' ? `MCX:${symbol}` : (marketType === 'EQUITY' ? `NSE:${symbol}` : `NFO:${symbol}`));
                        const quoteRes = await kiteService.getQuote(kiteSym);
                        const quote = quoteRes[kiteSym] || Object.values(quoteRes)[0];
                        if (quote && quote.last_price) {
                            currentPriceNow = quote.last_price;
                        }
                    } catch (e) {
                        console.warn(`[placeOrder] Kite Quote Failed for ${symbol} during away-points check:`, e.message);
                    }
                }

                if (!currentPriceNow) {
                    return res.status(400).json({ message: 'Kite Zerodha is not connected. Please login first.' });
                }

                const diff = Math.abs(parseFloat(price) - currentPriceNow);
                let maxAllowedAway = 0;
                if (expiryRule) {
                    const awayPoints = expiryRule.away_points ? JSON.parse(expiryRule.away_points) : {};
                    maxAllowedAway = parseFloat(awayPoints[symbol] || 0);
                }

                let segmentOrdersAway = 0;
                if (marketType === 'MCX') {
                    segmentOrdersAway = parseInt(clientConfig.mcxOrdersAway || 0);
                } else if (marketType === 'EQUITY') {
                    segmentOrdersAway = parseInt(clientConfig.equityOrdersAway || 0);
                } else if (marketType === 'OPTIONS') {
                    segmentOrdersAway = parseInt(clientConfig.optionsOrdersAway || 0);
                } else if (marketType === 'COMEX' || marketType === 'COMMODITY') {
                    segmentOrdersAway = parseInt(clientConfig.comexConfig?.ordersAway || 0);
                } else if (marketType === 'FOREX') {
                    segmentOrdersAway = parseInt(clientConfig.forexConfig?.ordersAway || 0);
                } else if (marketType === 'CRYPTO') {
                    segmentOrdersAway = parseInt(clientConfig.cryptoConfig?.ordersAway || 0);
                }

                const effectiveLimit = Math.max(maxAllowedAway, segmentOrdersAway);
                if (effectiveLimit > 0 && diff > effectiveLimit) {
                    return res.status(400).json({
                        message: `Limit order price too far from market. Max ${effectiveLimit} points away. Current: ${currentPriceNow}, Your price: ${price}`
                    });
                }
            }
        }

        // ─── MARGIN CALCULATION via MARGIN SERVICE ───────────────────────────
        let marginConfig = null;
        let exposureTypeUsed = mcxExposureType || clientConfig?.mcxExposureType || 'PER_LOT_BASIS';

        if (exposureTypeUsed === 'per_lot') {
            exposureTypeUsed = 'PER_LOT_BASIS';
        } else if (exposureTypeUsed === 'per_crore' || exposureTypeUsed === 'per_turnover') {
            exposureTypeUsed = 'PER_TURNOVER_BASIS';
        }

        try {
            marginConfig = MarginService.getMarginConfig(sym, marketType, clientConfig, mcxExposureType);
            marginRequired = MarginService.calculateRequiredMargin({
                qty: qtyNum,
                price: executionPrice,
                marginConfig: marginConfig,
                tradeType: tradeType,
                lotSize: lotSize
            });
            exposureTypeUsed = marginConfig.exposureType;
        } catch (marginErr) {
            console.warn(`[placeOrder] MarginService error fallback: ${marginErr.message}`);
            if (exposureTypeUsed === 'PER_TURNOVER_BASIS') {
                const exposure = parseInt(clientConfig?.mcxIntradayMargin || 500);
                marginRequired = (executionPrice * qtyNum * lotSize) / exposure;
            } else {
                let marginPerLot = 0;
                if (marketType === 'MCX') {
                    const baseSym = getMcxBaseScrip(sym) || sym;
                    marginPerLot = parseFloat(clientConfig?.mcxLotMargins?.[baseSym]?.INTRADAY || 0);
                    if (marginPerLot <= 0) {
                        const exposure = parseInt(clientConfig?.mcxIntradayMargin || 500);
                        marginRequired = (executionPrice * qtyNum * lotSize) / exposure;
                    } else {
                        marginRequired = qtyNum * marginPerLot;
                    }
                } else if (marketType === 'EQUITY') {
                    const baseSym = sym.toUpperCase();
                    marginPerLot = parseFloat(clientConfig?.equityLotMargins?.[baseSym]?.INTRADAY || 0);
                    if (marginPerLot <= 0) {
                        const exposure = parseInt(clientConfig?.equityIntradayMargin || 500);
                        marginRequired = (executionPrice * qtyNum * lotSize) / exposure;
                    } else {
                        marginRequired = qtyNum * marginPerLot;
                    }
                } else {
                    marginRequired = (executionPrice * qtyNum * lotSize) * 0.1;
                }
            }

            marginConfig = {
                exposureType: exposureTypeUsed,
                INTRADAY: 0,
                HOLDING: 0,
                intradayExposure: parseFloat(clientConfig?.mcxIntradayMargin || 500),
                holdingExposure: parseFloat(clientConfig?.mcxHoldingMargin || 100),
                LOT: lotSize
            };
        }

        if (marginRequired < 0) {
            marginRequired = (executionPrice * qtyNum * lotSize) * 0.1;
        }

        if (targetUser.balance < marginRequired) {
            const avail = parseFloat(targetUser.balance || 0).toFixed(2);
            return res.status(400).json({
                message: `Insufficient balance. Required margin: ₹${marginRequired.toFixed(2)}, Available: ₹${avail}`,
                required: marginRequired.toFixed(2),
                available: avail
            });
        }

        // ─── BROKER SEGMENT VALIDATION ───────────────────────────────────────
        if (brokerSegments) {
            const brokerSegmentConfig = brokerSegments.segmentConfig || {};
            let segmentKey = null;
            if (marketType === 'MCX') segmentKey = 'mcx_all_future';
            else if (marketType === 'COMEX' || marketType === 'COMMODITY') segmentKey = 'comex_commodity_future';
            else if (marketType === 'FOREX') segmentKey = 'forex';
            else if (marketType === 'CRYPTO') segmentKey = 'crypto';
            else if (marketType === 'EQUITY') segmentKey = 'equity';

            if (segmentKey && brokerSegmentConfig[segmentKey]) {
                const segConfig = brokerSegmentConfig[segmentKey];
                if (!segConfig.enabled) {
                    return res.status(403).json({
                        message: `Trading disabled for ${marketType} segment by your broker`
                    });
                }
            }
        }

        // ─── SHORT SELLING VALIDATION ────────────────────────────────────────
        if (type.toUpperCase() === 'SELL') {
            let isShortSellingAllowed = true;
            let deniedReason = '';

            if (marketType === 'OPTIONS') {
                if (symbol.includes('NIFTY') || symbol.includes('BANKNIFTY')) {
                    isShortSellingAllowed = clientConfig.optionsIndexShortSelling === 'Yes';
                    if (!isShortSellingAllowed) deniedReason = 'Options Index';
                } else if (symbol.includes('MCX') || symbol.includes('GOLD') || symbol.includes('SILVER')) {
                    isShortSellingAllowed = clientConfig.optionsMcxShortSelling === 'Yes';
                    if (!isShortSellingAllowed) deniedReason = 'Options MCX';
                } else {
                    isShortSellingAllowed = clientConfig.optionsEquityShortSelling === 'Yes';
                    if (!isShortSellingAllowed) deniedReason = 'Options Equity';
                }
            }

            if (!isShortSellingAllowed) {
                return res.status(400).json({
                    message: `Short selling is not allowed for ${deniedReason || marketType} segment in your account`
                });
            }
        }

        // ─── OPTIONS-SPECIFIC VALIDATIONS ────────────────────────────────────
        if (marketType === 'OPTIONS') {
            const optionsMinBidPrice = parseFloat(clientConfig.optionsMinBidPrice || 1);
            if (price && parseFloat(price) < optionsMinBidPrice) {
                return res.status(400).json({
                    message: `Minimum bid price for options is ₹${optionsMinBidPrice}. Your price: ₹${price}`
                });
            }

            let maxLotConfig = 0;
            let maxLotScripConfig = 0;
            let marginIntradayConfig = 0;
            let marginHoldingConfig = 0;

            if (symbol.includes('NIFTY') || symbol.includes('BANKNIFTY')) {
                maxLotConfig = parseInt(clientConfig.optionsIndexMaxLot || 20);
                maxLotScripConfig = parseInt(clientConfig.optionsIndexMaxScrip || 200);
                marginIntradayConfig = parseInt(clientConfig.optionsIndexIntraday || 5);
                marginHoldingConfig = parseInt(clientConfig.optionsIndexHolding || 2);
            } else if (symbol.includes('MCX')) {
                maxLotConfig = parseInt(clientConfig.optionsMcxMaxLot || 50);
                maxLotScripConfig = parseInt(clientConfig.optionsMcxMaxScrip || 200);
                marginIntradayConfig = parseInt(clientConfig.optionsMcxIntraday || 5);
                marginHoldingConfig = parseInt(clientConfig.optionsMcxHolding || 2);
            } else {
                maxLotConfig = parseInt(clientConfig.optionsEquityMaxLot || 50);
                maxLotScripConfig = parseInt(clientConfig.optionsEquityMaxScrip || 200);
                marginIntradayConfig = parseInt(clientConfig.optionsEquityIntraday || 5);
                marginHoldingConfig = parseInt(clientConfig.optionsEquityHolding || 2);
            }

            if (qtyNum < parseInt(clientConfig.optionsEquityMinLot || 0)) {
                return res.status(400).json({
                    message: `Minimum lot size for OPTIONS is ${clientConfig.optionsEquityMinLot || 1}. You entered ${qtyNum}`
                });
            }
            if (qtyNum > maxLotConfig) {
                return res.status(400).json({
                    message: `Maximum lot size for OPTIONS is ${maxLotConfig}. You entered ${qtyNum}`
                });
            }

            const currentOptionsQtyForSymbol = openTradesRows.filter(t => t.symbol === symbol && (t.market_type || '').toUpperCase() === 'OPTIONS').reduce((sum, t) => sum + parseFloat(t.qty || 0), 0);
            const newOptionsTotalForSymbol = currentOptionsQtyForSymbol + qtyNum;

            if (newOptionsTotalForSymbol > maxLotScripConfig) {
                return res.status(400).json({
                    message: `Max lot size for ${symbol} is ${maxLotScripConfig}. Current: ${currentOptionsQtyForSymbol}, New: ${qtyNum}, Total would be: ${newOptionsTotalForSymbol}`
                });
            }

            let maxOptionsSizeAll = 200;
            if (symbol.includes('NIFTY') || symbol.includes('BANKNIFTY')) {
                maxOptionsSizeAll = parseInt(clientConfig.optionsMaxIndexSizeAll || 200);
            } else if (symbol.includes('MCX')) {
                maxOptionsSizeAll = parseInt(clientConfig.optionsMaxMcxSizeAll || 200);
            } else {
                maxOptionsSizeAll = parseInt(clientConfig.optionsMaxEquitySizeAll || 200);
            }

            const currentAllOptionsQty = openTradesRows.filter(t => (t.market_type || '').toUpperCase() === 'OPTIONS').reduce((sum, t) => sum + parseFloat(t.qty || 0), 0);
            const newAllOptionsTotal = currentAllOptionsQty + qtyNum;

            if (newAllOptionsTotal > maxOptionsSizeAll) {
                return res.status(400).json({
                    message: `Max OPTIONS position limit is ${maxOptionsSizeAll}. Current: ${currentAllOptionsQty}, New: ${qtyNum}, Total would be: ${newAllOptionsTotal}`
                });
            }
        }

        // ─── KYC VERIFICATION CHECK ──────────────────────────────────────────
        const userKycStatus = String(targetUser.kyc_status || 'PENDING').toUpperCase();
        if (userKycStatus === 'REJECTED' || userKycStatus === 'PENDING') {
            return res.status(403).json({
                message: `Your KYC status is ${userKycStatus}. Please complete KYC verification to trade.`
            });
        }

        // ─── INTERNATIONAL SEGMENT VALIDATIONS ──────────────────────────────
        if ((marketType === 'COMEX' || marketType === 'COMMODITY') && clientConfig.comexTrading) {
            const comexConfig = clientConfig.comexConfig || {};
            const minLot = parseInt(comexConfig.minLot || 1);
            const maxLot = parseInt(comexConfig.maxLot || 100);

            if (qtyNum < minLot) {
                return res.status(400).json({ message: `Minimum lot size for COMEX is ${minLot}. You entered ${qtyNum}` });
            }
            if (qtyNum > maxLot) {
                return res.status(400).json({ message: `Maximum lot size for COMEX is ${maxLot}. You entered ${qtyNum}` });
            }

            const comexMaxLotScrip = parseInt(comexConfig.maxLotScrip || 0);
            if (comexMaxLotScrip > 0) {
                const currentComexQty = openTradesRows.filter(t => t.symbol === symbol && ['COMEX', 'COMMODITY'].includes((t.market_type || '').toUpperCase())).reduce((sum, t) => sum + parseFloat(t.qty || 0), 0);
                if (currentComexQty + qtyNum > comexMaxLotScrip) {
                    return res.status(400).json({ message: `Max lot size for ${symbol} (COMEX) is ${comexMaxLotScrip}` });
                }
            }

            const comexMaxSizeAll = parseInt(comexConfig.maxSizeAll || 0);
            if (comexMaxSizeAll > 0) {
                const currentComexAll = openTradesRows.filter(t => ['COMEX', 'COMMODITY'].includes((t.market_type || '').toUpperCase())).reduce((sum, t) => sum + parseFloat(t.qty || 0), 0);
                if (currentComexAll + qtyNum > comexMaxSizeAll) {
                    return res.status(400).json({ message: `Max COMEX position limit is ${comexMaxSizeAll}. Current: ${currentComexAll}, New: ${qtyNum}` });
                }
            }
        }

        if (marketType === 'FOREX' && clientConfig.forexTrading) {
            const forexConfig = clientConfig.forexConfig || {};
            const minLot = parseInt(forexConfig.minLot || 1);
            const maxLot = parseInt(forexConfig.maxLot || 100);

            if (qtyNum < minLot || qtyNum > maxLot) {
                return res.status(400).json({ message: `FOREX lot size must be between ${minLot} and ${maxLot}. You entered ${qtyNum}` });
            }

            const forexMaxLotScrip = parseInt(forexConfig.maxLotScrip || 0);
            if (forexMaxLotScrip > 0) {
                const currentForexQty = openTradesRows.filter(t => t.symbol === symbol && (t.market_type || '').toUpperCase() === 'FOREX').reduce((sum, t) => sum + parseFloat(t.qty || 0), 0);
                if (currentForexQty + qtyNum > forexMaxLotScrip) {
                    return res.status(400).json({ message: `Max lot size for ${symbol} (FOREX) is ${forexMaxLotScrip}` });
                }
            }

            const forexMaxSizeAll = parseInt(forexConfig.maxSizeAll || 0);
            if (forexMaxSizeAll > 0) {
                const currentForexAll = openTradesRows.filter(t => (t.market_type || '').toUpperCase() === 'FOREX').reduce((sum, t) => sum + parseFloat(t.qty || 0), 0);
                if (currentForexAll + qtyNum > forexMaxSizeAll) {
                    return res.status(400).json({ message: `Max FOREX position limit is ${forexMaxSizeAll}` });
                }
            }
        }

        if (marketType === 'CRYPTO' && clientConfig.cryptoTrading) {
            const cryptoConfig = clientConfig.cryptoConfig || {};
            const minLot = parseInt(cryptoConfig.minLot || 1);
            const maxLot = parseInt(cryptoConfig.maxLot || 100);

            if (qtyNum < minLot || qtyNum > maxLot) {
                return res.status(400).json({ message: `CRYPTO lot size must be between ${minLot} and ${maxLot}. You entered ${qtyNum}` });
            }

            const cryptoMaxLotScrip = parseInt(cryptoConfig.maxLotScrip || 0);
            if (cryptoMaxLotScrip > 0) {
                const currentCryptoQty = openTradesRows.filter(t => t.symbol === symbol && (t.market_type || '').toUpperCase() === 'CRYPTO').reduce((sum, t) => sum + parseFloat(t.qty || 0), 0);
                if (currentCryptoQty + qtyNum > cryptoMaxLotScrip) {
                    return res.status(400).json({ message: `Max lot size for ${symbol} (CRYPTO) is ${cryptoMaxLotScrip}` });
                }
            }

            const cryptoMaxSizeAll = parseInt(cryptoConfig.maxSizeAll || 0);
            if (cryptoMaxSizeAll > 0) {
                const currentCryptoAll = openTradesRows.filter(t => (t.market_type || '').toUpperCase() === 'CRYPTO').reduce((sum, t) => sum + parseFloat(t.qty || 0), 0);
                if (currentCryptoAll + qtyNum > cryptoMaxSizeAll) {
                    return res.status(400).json({ message: `Max CRYPTO position limit is ${cryptoMaxSizeAll}` });
                }
            }
        }

        // ─── AUTO SQUARE-OFF AT EXPIRY CHECK ─────────────────────────────────
        if (clientConfig.autoSquareOff === 'Yes') {
            try {
                if (dbScrip && dbScrip.expiry_date) {
                    const expiryDate = new Date(dbScrip.expiry_date);
                    const timeUntilExpiry = expiryDate - nowTime;
                    const hoursUntilExpiry = timeUntilExpiry / (1000 * 60 * 60);
                    const squareOffTime = clientConfig.expirySquareOffTime || '11:30';
                    console.log(`[placeOrder] ℹ️ Auto square-off check: ExpiryIn=${hoursUntilExpiry.toFixed(1)}h, SquareOffAt=${squareOffTime}`);
                }
            } catch (e) {
                console.error('[placeOrder] Auto square-off check error:', e);
            }
        }

        // ─── FINAL MARGIN VALIDATION ─────────────────────────────────────────
        const totalUsedMargin = openTradesRows
            .filter(t => !t.is_pending)
            .reduce((sum, t) => sum + parseFloat(t.margin_used || 0), 0);

        const availableMargin = parseFloat(targetUser.balance) - parseFloat(totalUsedMargin);

        console.log('[placeOrder] 💰 Margin Check:', {
            ledgerBalance: targetUser.balance,
            totalUsedMargin,
            availableMargin,
            requiredForThisTrade: marginRequired
        });

        if (availableMargin < marginRequired) {
            return res.status(400).json({
                message: `Insufficient margin. Required: ₹${marginRequired.toFixed(2)}, Available: ₹${availableMargin.toFixed(2)}`,
                required: marginRequired.toFixed(2),
                available: availableMargin.toFixed(2),
                shortfall: (marginRequired - availableMargin).toFixed(2)
            });
        }

        // ═════════════════════════════════════════════════════════════
        // EQUITY UNITS/LOTS MODE - Calculate actual_qty based on instrument type
        // ═════════════════════════════════════════════════════════════
        const qtyInput = qtyNum;
        const lotSizeAtEntry = req.body.lot_size_at_entry || lotSize || 1;
        const equityUnitsMode = req.body.equity_units_mode || 0;
        const instrumentType = req.body.instrument_type || '';

        let actualQty = qtyNum;
        let tradeMode = 'LOTS';
        // Get leverage from request body or client config (default 5x)
        let leverageUsed = parseFloat(req.body.leverage_used) ||
            parseFloat(clientConfig?.holding_leverage) || 5;
        // Ensure leverage_used is within valid range (1-10)
        leverageUsed = Math.max(1, Math.min(10, leverageUsed));

        // Instrument Classification: NSE EQUITY vs Derivatives vs MCX
        const isNseEquity = marketType === 'EQUITY' || (marketType === 'NSE' && instrumentType === 'EQ');
        const isNseDerivative = (marketType === 'NSE' || marketType === 'NIFTY' || marketType === 'OPTIONS' || marketType === 'NFO') &&
            ['FUT', 'CE', 'PE', 'OPT'].includes(instrumentType);
        const isMcx = marketType === 'MCX';

        console.log('[placeOrder] 📊 Equity Units Mode Calculation:', {
            qtyInput,
            exchange: marketType,
            instrumentType,
            isNseEquity,
            isNseDerivative,
            isMcx,
            equityUnitsMode,
            lotSizeAtEntry
        });

        // UNITS vs LOTS calculation
        if (isNseEquity && equityUnitsMode === 1) {
            // ✅ NSE EQUITY UNITS MODE: actual_qty = qty_input (1 unit = 1 share)
            actualQty = qtyInput;
            tradeMode = 'UNITS';
            console.log(`[placeOrder] ✅ NSE EQUITY UNITS MODE: ${qtyInput} units = ${actualQty} shares`);
        }
        else if (isNseEquity && equityUnitsMode === 0) {
            // ✅ NSE EQUITY LOTS MODE: actual_qty = qty_input × lot_size
            actualQty = qtyInput * lotSizeAtEntry;
            tradeMode = 'LOTS';
            console.log(`[placeOrder] ✅ NSE EQUITY LOTS MODE: ${qtyInput} lots × ${lotSizeAtEntry} = ${actualQty} shares`);
        }
        else if (isNseDerivative) {
            // ✅ NSE DERIVATIVES (FUT, CE, PE): ALWAYS LOTS, ignore units mode
            actualQty = qtyInput * lotSizeAtEntry;
            tradeMode = 'LOTS';
            console.log(`[placeOrder] ✅ NSE DERIVATIVE (${instrumentType}): ${qtyInput} lots × ${lotSizeAtEntry} = ${actualQty}`);
        }
        else if (isMcx) {
            // ✅ MCX: actual_qty = qty_input × lot_size (standard lot-based calculation)
            actualQty = qtyInput * lotSizeAtEntry;
            tradeMode = 'LOTS';
            console.log(`[placeOrder] ✅ MCX LOTS MODE: ${qtyInput} lots × ${lotSizeAtEntry} = ${actualQty}`);
        }

        // --- Segment-specific Margin Calculation Logic ---
        let newMarginRequired = 0;
        const finalTurnover = executionPrice * actualQty;

        if (isNseEquity || isNseDerivative) {
            // NSE/NFO: Exposure-based (Turnover / Divisor)
            const leverage = tradeType === 'HOLDING'
                ? parseFloat(clientConfig?.equityHoldingMargin || 100)
                : parseFloat(clientConfig?.equityIntradayMargin || 500);

            newMarginRequired = finalTurnover / (leverage || 1);
            leverageUsed = leverage;
            console.log(`[placeOrder] 🏦 NSE/NFO Margin: ${finalTurnover} / ${leverage} = ${newMarginRequired}`);
        } else {
            // Default/MCX: Use MarginService (supports Per Lot Basis)
            try {
                newMarginRequired = MarginService.calculateRequiredMargin({
                    qty: qtyInput,
                    price: executionPrice,
                    marginConfig,
                    tradeType,
                    lotSize: lotSizeAtEntry
                });
            } catch (innerMarginErr) {
                console.warn(`[placeOrder] Inner MarginService error, falling back to Tier 1 marginRequired: ${innerMarginErr.message}`);
                newMarginRequired = parseFloat(marginRequired) || ((executionPrice * qtyInput * lotSizeAtEntry) / 500);
            }
            // Back-calculate leverage for logging
            // If margin is 0, leverage is 0 (not infinity or huge number)
            leverageUsed = newMarginRequired > 0 ? finalTurnover / newMarginRequired : 0;
            console.log(`[placeOrder] 🪙 MCX/Other Margin: ${newMarginRequired} (approx leverage: ${leverageUsed > 0 ? leverageUsed.toFixed(1) : '0'}x)`);
        }
        // --------------------------------------------------

        console.log('[placeOrder] 📊 Final Trade Values:', {
            qtyInput,
            actualQty,
            tradeMode,
            turnover: finalTurnover,
            leverage: leverageUsed,
            margin: newMarginRequired.toFixed(2)
        });

        // ─── MARGIN VALIDATION ─────────────────────────────────────────────
        const totalUsedMarginFinal = openTradesRows
            .filter(t => !t.is_pending)
            .reduce((sum, t) => sum + parseFloat(t.margin_used || 0), 0);

        const availableMarginFinal = parseFloat(targetUser.balance) - parseFloat(totalUsedMarginFinal);

        console.log('[placeOrder] 💰 Margin Check:', {
            ledgerBalance: targetUser.balance,
            totalUsedMargin: totalUsedMarginFinal,
            availableMargin: availableMarginFinal,
            requiredForThisTrade: newMarginRequired
        });

        if (availableMarginFinal < newMarginRequired) {
            return res.status(400).json({
                message: `Insufficient margin. Required: ₹${newMarginRequired.toFixed(2)}, Available: ₹${availableMarginFinal.toFixed(2)}`,
                required: newMarginRequired.toFixed(2),
                available: availableMarginFinal.toFixed(2),
                shortfall: (newMarginRequired - availableMarginFinal).toFixed(2)
            });
        }
        // ───────────────────────────────────────────────────────────────────

        let insertedTradeId = null;
        let finalQty = (isNseEquity || isNseDerivative) ? actualQty : qtyInput;
        let wasNetted = false;
        let nettingRes = null;

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            if (is_pending) {
                const [result] = await connection.execute(
                    `INSERT INTO trades
                        (user_id, symbol, type, order_type, qty, entry_price, exit_price, margin_used, is_pending, market_type, status, trade_ip, created_by, trade_type, margin_type,
                         qty_input, actual_qty, lot_size_at_entry, trade_mode, turnover, leverage_used, equity_units_mode, entry_time)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
                    [
                        targetUserId,
                        sym,
                        type.toUpperCase(),
                        order_type,
                        (isNseEquity || isNseDerivative) ? actualQty : qtyInput,
                        executionPrice,
                        exit_price ? parseFloat(exit_price) : null,
                        newMarginRequired.toFixed(2),
                        marketType,
                        tradeIp,
                        requesterId,
                        tradeType,
                        marginConfig.exposureType,
                        qtyInput,
                        actualQty,
                        lotSizeAtEntry,
                        tradeMode,
                        finalTurnover.toFixed(2),
                        leverageUsed,
                        equityUnitsMode
                    ]
                );
                insertedTradeId = result.insertId;
            } else {
                const incomingTrade = {
                    user_id: targetUserId,
                    symbol: sym,
                    type: type.toUpperCase(),
                    order_type,
                    qty: (isNseEquity || isNseDerivative) ? actualQty : qtyInput,
                    entry_price: executionPrice,
                    margin_used: newMarginRequired.toFixed(2),
                    is_pending: 0,
                    market_type: marketType,
                    trade_ip: tradeIp,
                    created_by: requesterId,
                    trade_type: tradeType,
                    margin_type: marginConfig.exposureType,
                    qty_input: qtyInput,
                    actual_qty: actualQty,
                    lot_size_at_entry: lotSizeAtEntry,
                    trade_mode: tradeMode,
                    turnover: finalTurnover.toFixed(2),
                    leverage_used: leverageUsed,
                    equity_units_mode: equityUnitsMode
                };

                nettingRes = await tradeService.executeNetting(
                    targetUserId,
                    sym,
                    marketType,
                    incomingTrade,
                    connection
                );

                wasNetted = nettingRes.netted;
                const remainingQty = nettingRes.remainingQty;

                if (remainingQty > 0) {
                    const ratio = remainingQty / incomingTrade.qty;
                    const [result] = await connection.execute(
                        `INSERT INTO trades
                            (user_id, symbol, type, order_type, qty, entry_price, exit_price, margin_used, is_pending, market_type, status, trade_ip, created_by, trade_type, margin_type,
                             qty_input, actual_qty, lot_size_at_entry, trade_mode, turnover, leverage_used, equity_units_mode, entry_time)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
                        [
                            targetUserId,
                            sym,
                            type.toUpperCase(),
                            order_type,
                            remainingQty,
                            executionPrice,
                            exit_price ? parseFloat(exit_price) : null,
                            (newMarginRequired * ratio).toFixed(2),
                            marketType,
                            tradeIp,
                            requesterId,
                            tradeType,
                            marginConfig.exposureType,
                            qtyInput * ratio,
                            actualQty * ratio,
                            lotSizeAtEntry,
                            tradeMode,
                            (finalTurnover * ratio).toFixed(2),
                            leverageUsed,
                            equityUnitsMode
                        ]
                    );
                    insertedTradeId = result.insertId;
                    finalQty = remainingQty;
                } else {
                    finalQty = 0;
                }
            }

            if (!is_pending) {
                await syncPaperPosition(targetUserId, sym, connection);
            }

            await connection.commit();
        } catch (txnErr) {
            await connection.rollback();
            throw txnErr;
        } finally {
            connection.release();
        }

        console.log(`[placeOrder] ℹ️ Margin Calculated (NEW FORMULA): ${newMarginRequired.toFixed(2)}`);
        console.log(`[placeOrder] ℹ️ Ledger Balance: ${targetUser.balance} (unchanged)`);
        if (insertedTradeId) {
            console.log('✅ Trade Inserted:', insertedTradeId);
        }

        res.status(201).json({
            message: wasNetted && finalQty === 0 ? 'Order placed and fully netted' : 'Order placed successfully',
            tradeId: insertedTradeId,
            executionPrice,
            marginUsed: newMarginRequired.toFixed(2),
            qtyInput,
            actualQty,
            tradeMode,
            turnover: finalTurnover.toFixed(2),
            leverage: leverageUsed,
            equityUnitsMode,
            wasNetted,
            remainingQty: finalQty
        });

        // Notify user via socket for real-time UI update
        try {
            const { getIo } = require('../config/socket');
            const io = getIo();
            if (io) {
                if (is_pending) {
                    io.to(`user:${targetUserId}`).emit('notification', {
                        message: `New ${type.toUpperCase()} order for ${sym.includes(':') ? sym.split(':')[1] : sym} placed successfully at ₹${executionPrice}`,
                        type: 'ORDER_PLACED',
                        tradeId: insertedTradeId
                    });
                    io.to(`user:${targetUserId}`).emit('trade_update', {
                        id: insertedTradeId,
                        is_pending: 1,
                        status: 'OPEN'
                    });
                } else if (finalQty > 0) {
                    io.to(`user:${targetUserId}`).emit('notification', {
                        message: `New ${type.toUpperCase()} order for ${sym.includes(':') ? sym.split(':')[1] : sym} placed successfully at ₹${executionPrice}${wasNetted ? ` (partially netted, remaining: ${finalQty})` : ''}`,
                        type: 'ORDER_PLACED',
                        tradeId: insertedTradeId
                    });
                    io.to(`user:${targetUserId}`).emit('trade_update', {
                        id: insertedTradeId,
                        is_pending: 0,
                        status: 'OPEN',
                        qty: finalQty
                    });
                }
            }
        } catch (socketErr) {
            console.error('[placeOrder] Socket emit error:', socketErr.message);
        }

        // Log the trade placement with custom activity messages
        const basePayload = {
            username: targetUser.username,
            userId: targetUserId,
            side: type,
            symbol: sym,
            price: executionPrice,
            availableFunds: parseFloat(targetUser.balance).toFixed(4),
            requiredFunds: parseFloat(newMarginRequired).toFixed(2)
        };

        if (is_pending) {
            if (order_type === 'STOP LOSS') {
                const slLog = buildTradeLog('STOPLOSS_SCHEDULED', {
                    ...basePayload,
                    lots: qtyInput,
                    qty: actualQty * lotSizeAtEntry,
                    condition: type.toUpperCase() === 'BUY' ? '1' : '2',
                    price: executionPrice
                });
                await logAction(requesterId, 'PLACE_ORDER', 'trades', slLog);
            } else {
                // Limit order: PENDING_ABOVE or PENDING_BELOW
                const curPrice = (typeof currentPriceNow !== 'undefined' && currentPriceNow) ? currentPriceNow : executionPrice;
                const isAbove = executionPrice > curPrice;
                const pendingType = isAbove ? 'PENDING_ABOVE' : 'PENDING_BELOW';
                const limitLog = buildTradeLog(pendingType, {
                    ...basePayload,
                    lots: qtyInput
                });
                await logAction(requesterId, 'PLACE_ORDER', 'trades', limitLog);
            }
        } else {
            // Market Order / Immediate execution
            if (wasNetted) {
                const nettedQty = qtyInput - finalQty; // portion of incoming order that was netted
                const openQty = finalQty; // portion that remains open

                if (nettedQty > 0) {
                    const exitLog = buildTradeLog('EXIT_EXECUTED', {
                        ...basePayload,
                        lots: nettedQty,
                        requiredFunds: parseFloat(newMarginRequired * (nettedQty / qtyInput)).toFixed(2)
                    });
                    await logAction(requesterId, 'PLACE_ORDER', 'trades', exitLog);
                }

                if (openQty > 0) {
                    const marketLog = buildTradeLog('MARKET_EXECUTED', {
                        ...basePayload,
                        lots: openQty,
                        requiredFunds: parseFloat(newMarginRequired * (openQty / qtyInput)).toFixed(2)
                    });
                    await logAction(requesterId, 'PLACE_ORDER', 'trades', marketLog);
                }
            } else {
                // Normal entry market execution (no netting)
                const marketLog = buildTradeLog('MARKET_EXECUTED', {
                    ...basePayload,
                    lots: qtyInput
                });
                await logAction(requesterId, 'PLACE_ORDER', 'trades', marketLog);
            }
        }


    } catch (err) {
        console.error('❌ Trade Placement Error:', err);
        res.status(500).json({ message: 'Internal Server Error', error: err.message });
    }
};

/**
 * Get Active Positions (grouped by symbol+type for Active Positions page)
 * Returns aggregated open positions: total_qty, avg_price, lot_size, market_type
 */
const getActivePositions = async (req, res) => {
    try {
        const { id, role } = req.user;

        // Build hierarchy-aware query for OPEN, non-pending trades
        let query = `
            SELECT
                t.symbol,
                t.type,
                t.market_type,
                SUM(t.actual_qty) AS total_qty,
                SUM(COALESCE(t.qty_input, t.qty, 0)) AS total_lots,
                AVG(t.entry_price) AS avg_price,
                MAX(sd.lot_size) AS lot_size,
                COUNT(*) AS trade_count
            FROM trades t
            LEFT JOIN scrip_data sd ON t.symbol = sd.symbol
            WHERE t.status = 'OPEN'
              AND t.is_pending = 0
        `;
        const params = [];

        // Hierarchy isolation
        if (role === 'TRADER') {
            query += ` AND t.user_id = ?`;
            params.push(id);
        } else {
            // Exclude demo users for all non-trader roles
            query += ` AND t.user_id IN (SELECT id FROM users WHERE is_demo = 0)`;
            if (role === 'SUPERADMIN') {
                // Superadmins see all active positions (no restriction filter needed)
            } else if (role === 'ADMIN') {
                query += ` AND (t.created_by = ? OR t.user_id IN (
                    SELECT u.id FROM users u
                    LEFT JOIN client_settings cs ON u.id = cs.user_id
                    WHERE u.parent_id = ? OR cs.broker_id IN (SELECT id FROM users WHERE parent_id = ?)
                ))`;
                params.push(id, id, id);
            } else if (role === 'BROKER') {
                query += ` AND (t.created_by = ? OR t.user_id IN (
                    SELECT u.id FROM users u
                    LEFT JOIN client_settings cs ON u.id = cs.user_id
                    WHERE u.parent_id = ? OR cs.broker_id = ?
                ))`;
                params.push(id, id, id);
            }
        }

        query += ` GROUP BY t.symbol, t.type, t.market_type ORDER BY t.symbol ASC`;

        const [rows] = await db.execute(query, params);
        const commodityLotService = require('../services/CommodityLotService');
        rows.forEach(pos => {
            const info = commodityLotService.getLotInfo(pos.symbol);
            if (info) {
                pos.lot_size = info.lot_size;
                pos.usdinr_value = info.usdinr_value;
                pos.is_commodity = info.category === 'COMMODITY' || info.category === 'FOREX' || info.category === 'CRYPTO';
                if (pos.is_commodity) {
                    try {
                        const marketDataService = require('../services/MarketDataService');
                        const liveUsdInr = marketDataService.prices['FOREX:USD/INR'] || marketDataService.prices['FOREX:USDINR'];
                        if (liveUsdInr) {
                            // Send the unadjusted base rate (ltp). The mobile app applies
                            // the 10% premium/discount based on actual profit/loss direction.
                            pos.usdinr_value = parseFloat(liveUsdInr.ltp || pos.usdinr_value);
                        }
                    } catch (e) {}
                }
            }
        });
        res.json(rows);
    } catch (err) {
        console.error('[getActivePositions] Error:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

/**
 * Get Trades by Status (Active, Closed, Deleted)
 */
const getTrades = async (req, res) => {
    const { status, user_id } = req.query; // OPEN, CLOSED, DELETED, CANCELLED
    try {
        let query = 'SELECT t.*, u.username, u.full_name, sd.lot_size, uc.username as created_by_name FROM trades t JOIN users u ON t.user_id = u.id LEFT JOIN users uc ON t.created_by = uc.id LEFT JOIN scrip_data sd ON t.symbol = sd.symbol WHERE 1=1';
        const params = [];

        if (status) {
            query += ' AND t.status = ?';
            params.push(status);
        } else {
            query += " AND t.status != 'DELETED'";
        }

        if (req.query.is_pending !== undefined) {
            const isPending = req.query.is_pending === 'true' || req.query.is_pending === '1' ? 1 : 0;
            query += ' AND t.is_pending = ?';
            params.push(isPending);
            // Pending orders list should only show active (OPEN) ones, not cancelled
            if (isPending === 1 && !status) {
                query += " AND t.status = 'OPEN'";
            }
        }

        // Filter by specific user_id (for client detail views)
        if (user_id) {
            query += ' AND t.user_id = ?';
            params.push(user_id);
        } else if (req.user.role !== 'TRADER') {
            // Exclude demo trades for overall lists viewed by admin/broker
            query += ' AND u.is_demo = 0';
        }

        // Role-based visibility isolation (consistent for both global list and client detail view)
        if (req.user.role === 'SUPERADMIN') {
            // Superadmins can see all trades in the system
        } else if (req.user.role === 'ADMIN') {
            // Admins see their own created trades OR trades of their descendants (clients and brokers under them)
            query += ` AND (t.created_by = ? OR t.user_id IN (
                SELECT u.id FROM users u 
                LEFT JOIN client_settings cs ON u.id = cs.user_id
                WHERE u.parent_id = ? OR cs.broker_id IN (SELECT id FROM users WHERE parent_id = ?)
            ))`;
            params.push(req.user.id, req.user.id, req.user.id);
        } else if (req.user.role === 'BROKER') {
            // Brokers see trades they created OR trades of their clients/sub-brokers
            query += ` AND (t.created_by = ? OR t.user_id IN (
                SELECT u.id FROM users u 
                LEFT JOIN client_settings cs ON u.id = cs.user_id 
                WHERE u.parent_id = ? OR cs.broker_id = ?
            ))`;
            params.push(req.user.id, req.user.id, req.user.id);
        } else {
            // TRADER sees only their own trades
            query += ' AND t.user_id = ?';
            params.push(req.user.id);
        }

        // Filter by username
        if (req.query.username) {
            query += ' AND u.username LIKE ?';
            params.push(`%${req.query.username}%`);
        }

        // Filter by scrip (symbol)
        if (req.query.scrip) {
            query += ' AND t.symbol LIKE ?';
            params.push(`%${req.query.scrip}%`);
        }

        // Filter by current week only
        if (req.query.current_week_only === 'true' || req.query.current_week_only === '1') {
            const { getWeekBoundaries, getISTDate } = require('../services/WeeklySettlementService');
            const boundaries = getWeekBoundaries(getISTDate());
            query += ' AND t.entry_time >= ?';
            params.push(boundaries.week_start + ' 00:00:00');
        }

        // Filter by date range
        if (req.query.fromDate) {
            query += ' AND DATE(t.entry_time) >= ?';
            params.push(req.query.fromDate);
        }
        if (req.query.toDate) {
            query += ' AND DATE(t.entry_time) <= ?';
            params.push(req.query.toDate);
        }

        const [rows] = await db.execute(query, params);
        const commodityLotService = require('../services/CommodityLotService');
        rows.forEach(trade => {
            const info = commodityLotService.getLotInfo(trade.symbol);
            if (info) {
                trade.lot_size = info.lot_size;
                trade.usdinr_value = info.usdinr_value;
                trade.is_commodity = info.category === 'COMMODITY' || info.category === 'FOREX' || info.category === 'CRYPTO';
                if (trade.is_commodity && trade.status === 'OPEN') {
                    try {
                        const marketDataService = require('../services/MarketDataService');
                        const liveUsdInr = marketDataService.prices['FOREX:USD/INR'] || marketDataService.prices['FOREX:USDINR'];
                        if (liveUsdInr) {
                            // Send the unadjusted base rate (ltp). The mobile app applies
                            // the 10% premium/discount based on actual profit/loss direction.
                            trade.usdinr_value = parseFloat(liveUsdInr.ltp || trade.usdinr_value);
                        }
                    } catch (e) {}
                }
            }
        });

        // --- ENHANCEMENT: Dynamic Margin and P/L for OPEN trades ---
        // If we are listing OPEN trades, we should calculate the current "Holding Margin Required"
        // and P/L based on live market prices.
        const statusUpper = status ? status.toUpperCase() : null;
        if (statusUpper === 'OPEN' || !statusUpper) {
            // Group by user to fetch configs once
            const userIds = [...new Set(rows.map(r => r.user_id))];
            if (userIds.length > 0) {
                const [configRows] = await db.query(
                    'SELECT user_id, config_json FROM client_settings WHERE user_id IN (?)',
                    [userIds]
                );
                const configMap = {};
                configRows.forEach(c => { configMap[c.user_id] = JSON.parse(c.config_json || '{}'); });

                // ✅ RECALCULATE: Dynamically calculate holding margin for OPEN trades
                // This ensures margins reflect the latest configuration (e.g., zero margin settings)
                const MarginUtils = require('../utils/MarginUtils');
                const marketDataService = require('../services/MarketDataService');
                rows.forEach(trade => {
                    const clientConfig = configMap[trade.user_id] || {};
                    const calc = MarginUtils.calculateTotalRequiredHoldingMargin([trade], clientConfig);
                    trade.margin_used = calc;
                    trade.holding_margin = calc;

                    // Calculate P/L dynamically for OPEN trades only if pnl is 0/null
                    if (trade.status === 'OPEN' && (!trade.pnl || parseFloat(trade.pnl) === 0)) {
                        const cleanSymbol = trade.symbol.includes(':') ? trade.symbol.split(':')[1] : trade.symbol;
                        const prefixForPnl = trade.market_type === 'EQUITY' ? 'NSE' : (trade.market_type === 'OPTIONS' ? 'NFO' : trade.market_type);
                        const possibleSymbols = [trade.symbol, `${prefixForPnl}:${cleanSymbol}`, cleanSymbol];

                        let currentPrice = null;
                        for (const sym of possibleSymbols) {
                            const data = marketDataService.getPrice(sym);
                            if (data && data.ltp) {
                                currentPrice = data.ltp;
                                break;
                            }
                        }

                        if (currentPrice) {
                            const commodityLotService = require('../services/CommodityLotService');
                            if (commodityLotService.isCommodityScrip(trade.symbol, trade.market_type)) {
                                const calc = commodityLotService.calculatePnL(trade.symbol, trade.type, trade.entry_price, currentPrice, trade.qty);
                                trade.pnl = calc.pnlInr;
                                // Send the base rate (divide out the 10% adjustment) so the
                                // mobile app can apply the 10% rule itself based on P/L direction.
                                // calc.usdInr is already adjusted (base * 1.10 or base * 0.90).
                                // We recover the base by reversing: if pnl < 0 → base = calc.usdInr / 1.10, else / 0.90
                                const baseRate = calc.pnlInr < 0
                                    ? calc.usdInr / 1.10
                                    : calc.usdInr / 0.90;
                                trade.usdinr_value = baseRate;
                            } else {
                                const lotSize = parseFloat(trade.lot_size_at_entry || 1);
                                const qtyForPnl = trade.qty * lotSize;
                                const entryPrice = parseFloat(trade.entry_price);

                                if (trade.type === 'BUY') {
                                    trade.pnl = (currentPrice - entryPrice) * qtyForPnl;
                                } else {
                                    trade.pnl = (entryPrice - currentPrice) * qtyForPnl;
                                }
                            }
                        }
                    }
                });
            }
        }


        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

/**
 * Get Single Trade by ID
 */
const getTradeById = async (req, res) => {
    try {
        const [rows] = await db.execute(
            `SELECT t.*, u.username, u.full_name
             FROM trades t
             JOIN users u ON t.user_id = u.id
             WHERE t.id = ?`,
            [req.params.id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Trade not found' });
        }

        const trade = rows[0];
        const { id: requesterId } = req.user;

        // Access check: "Jisme jo trade banai usko vahi dikhe"
        // ENHANCED: Also allow Admin/Broker to see if it's their subordinate's trade
        const isTargetUser = trade.user_id === requesterId;
        const isCreator = trade.created_by === requesterId;

        let isParent = false;
        if (!isTargetUser && !isCreator) {
            // Check if requester is parent or broker
            const [relRows] = await db.execute(
                `SELECT u.id FROM users u 
                 LEFT JOIN client_settings cs ON u.id = cs.user_id 
                 WHERE u.id = ? AND (u.parent_id = ? OR cs.broker_id = ?)`,
                [trade.user_id, requesterId, requesterId]
            );
            isParent = relRows.length > 0;
        }

        if (!isTargetUser && !isCreator && !isParent) {
            return res.status(403).json({ message: 'Not authorized to view this trade' });
        }

        res.json(trade);
    } catch (err) {
        console.error('Get Trade by ID Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

const getGroupTrades = async (req, res) => {
    try {
        const { id, role } = req.user;
        const { scrip, segment, fromDate, toDate, timeWindow = 30, minUsers = 2 } = req.query;

        let query = `
            SELECT
                t.id,
                t.user_id,
                t.symbol,
                t.type,
                t.market_type,
                t.qty,
                t.actual_qty,
                t.qty_input,
                t.entry_price,
                t.exit_price,
                t.entry_time,
                t.exit_time,
                t.status,
                t.is_pending,
                t.created_by,
                u.username,
                u.full_name
            FROM trades t
            JOIN users u ON t.user_id = u.id
            WHERE 1=1
        `;
        const params = [];

        // Hierarchy Isolation: "Jisme jo trade banai usko vahi dikhe"
        if (role === 'TRADER') {
            query += ` AND t.user_id = ?`;
            params.push(id);
        } else if (role === 'SUPERADMIN') {
            console.log('[getGroupTrades] SUPERADMIN viewing all groups');
        } else if (role === 'ADMIN') {
            query += ` AND (t.created_by = ? OR t.user_id IN (
                SELECT u.id FROM users u 
                LEFT JOIN client_settings cs ON u.id = cs.user_id
                WHERE u.parent_id = ? OR cs.broker_id IN (SELECT id FROM users WHERE parent_id = ?)
            ))`;
            params.push(id, id, id);
        } else if (role === 'BROKER') {
            query += ` AND (t.created_by = ? OR t.user_id IN (
                SELECT u.id FROM users u 
                LEFT JOIN client_settings cs ON u.id = cs.user_id 
                WHERE u.parent_id = ? OR cs.broker_id = ?
            ))`;
            params.push(id, id, id);
        }

        // Filter by scrip (symbol)
        if (scrip) {
            query += ` AND t.symbol LIKE ?`;
            params.push(`%${scrip}%`);
        }

        // Filter by segment (market type)
        if (segment && segment !== 'All') {
            query += ` AND t.market_type = ?`;
            params.push(segment);
        }

        // Filter by date range
        if (fromDate) {
            query += ` AND DATE(t.entry_time) >= ?`;
            params.push(fromDate);
        }
        if (toDate) {
            query += ` AND DATE(t.entry_time) <= ?`;
            params.push(toDate);
        }

        query += ` ORDER BY t.symbol ASC, t.type ASC, t.entry_time ASC`;

        const [rows] = await db.execute(query, params);

        // Group trades by (symbol, type, market_type)
        const groupedByScrip = {};
        for (const trade of rows) {
            const key = `${trade.symbol}_${trade.type}_${trade.market_type}`;
            if (!groupedByScrip[key]) {
                groupedByScrip[key] = [];
            }
            groupedByScrip[key].push(trade);
        }

        const detectedGroups = [];
        let groupCounter = 1;

        const timeWindowMs = (parseInt(timeWindow) || 30) * 1000;
        const minUsersCount = parseInt(minUsers) || 2;

        for (const key in groupedByScrip) {
            const trades = groupedByScrip[key];
            // Sort trades by entry_time
            trades.sort((a, b) => new Date(a.entry_time) - new Date(b.entry_time));

            let currentCluster = [];
            for (const trade of trades) {
                if (currentCluster.length === 0) {
                    currentCluster.push(trade);
                } else {
                    const lastTradeInCluster = currentCluster[currentCluster.length - 1];
                    const timeDiff = new Date(trade.entry_time) - new Date(lastTradeInCluster.entry_time);
                    if (timeDiff <= timeWindowMs) {
                        currentCluster.push(trade);
                    } else {
                        processCluster(currentCluster);
                        currentCluster = [trade];
                    }
                }
            }
            if (currentCluster.length > 0) {
                processCluster(currentCluster);
            }
        }

        function processCluster(cluster) {
            const uniqueUsers = [...new Set(cluster.map(t => t.user_id))];
            if (uniqueUsers.length >= minUsersCount) {
                const firstTradeTime = new Date(Math.min(...cluster.map(t => new Date(t.entry_time))));
                const lastTradeTime = new Date(Math.max(...cluster.map(t => new Date(t.entry_time))));
                const totalQty = cluster.reduce((sum, t) => sum + parseFloat(t.qty || 0), 0);
                const totalLots = cluster.reduce((sum, t) => sum + parseFloat(t.qty_input != null ? t.qty_input : (t.qty || 0)), 0);
                const avgPrice = cluster.reduce((sum, t) => sum + parseFloat(t.entry_price || 0), 0) / cluster.length;

                // Advanced Coordinated Exit Check:
                // Check if all users entered within entry window AND exited within exit window
                let highlyCoordinated = false;
                const exitTimes = cluster.map(t => t.exit_time).filter(t => t != null);
                if (exitTimes.length === cluster.length) {
                    const firstExitTime = new Date(Math.min(...exitTimes.map(t => new Date(t))));
                    const lastExitTime = new Date(Math.max(...exitTimes.map(t => new Date(t))));
                    const exitTimeDifference = Math.round((lastExitTime - firstExitTime) / 1000);
                    if (exitTimeDifference <= (parseInt(timeWindow) || 30)) {
                        highlyCoordinated = true;
                    }
                }

                const groupId = `G${String(groupCounter++).padStart(3, '0')}`;

                detectedGroups.push({
                    groupId,
                    symbol: cluster[0].symbol,
                    type: cluster[0].type,
                    market_type: cluster[0].market_type,
                    usersCount: uniqueUsers.length,
                    usersList: cluster.map(t => `${t.user_id} : ${t.username || t.full_name || ''}`).filter((v, i, a) => a.indexOf(v) === i),
                    totalQty,
                    totalLots,
                    firstTradeTime: firstTradeTime.toISOString(),
                    lastTradeTime: lastTradeTime.toISOString(),
                    timeDifference: Math.round((lastTradeTime - firstTradeTime) / 1000),
                    avgPrice: avgPrice.toFixed(2),
                    highlyCoordinated,
                    trades: cluster
                });
            }
        }

        res.json(detectedGroups);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

/**
 * Close/Square-off Trade
 * - Pending orders (is_pending=1): cancelled immediately, margin refunded, no PnL
 * - Open orders: closed at exitPrice or current market price
 */
const closeTrade = async (req, res) => {
    try {
        const { exitPrice, pnl } = req.body;
        const requesterId = req.user.id;

        // 1. Initial Fetch to check feasibility
        const [trades] = await db.execute('SELECT * FROM trades WHERE id = ?', [req.params.id]);
        if (trades.length === 0) return res.status(404).json({ message: 'Trade not found' });

        const trade = trades[0];
        if (trade.status !== 'OPEN') {
            return res.status(400).json({ message: 'Trade is already closed or inactive' });
        }

        // ─── VALIDATIONS (Min Time / Scalping SL) ─────────────────────────
        const [clientSettings] = await db.execute(
            'SELECT config_json FROM client_settings WHERE user_id = ?',
            [trade.user_id]
        );
        const clientConfig = clientSettings.length > 0 ? JSON.parse(clientSettings[0].config_json || '{}') : {};

        let minTimeSeconds = 0;
        if (trade.market_type === 'MCX') minTimeSeconds = parseInt(clientConfig.mcxMinTimeToBookProfit || 0);
        else if (trade.market_type === 'EQUITY') minTimeSeconds = parseInt(clientConfig.equityMinTimeToBookProfit || 0);
        else if (trade.market_type === 'OPTIONS') minTimeSeconds = parseInt(clientConfig.optionsMinTimeToBookProfit || 0);
        else if (trade.market_type === 'CRYPTO') minTimeSeconds = parseInt((clientConfig.cryptoConfig || {}).minTimeToBookProfit || 0);
        else if (trade.market_type === 'FOREX') minTimeSeconds = parseInt((clientConfig.forexConfig || {}).minTimeToBookProfit || 0);
        else if (trade.market_type === 'COMEX' || trade.market_type === 'COMMODITY') minTimeSeconds = parseInt((clientConfig.comexConfig || {}).minTimeToBookProfit || 0);

        const entryTime = new Date(trade.entry_time);
        const now = new Date();
        const secondsHeld = Math.floor((now - entryTime) / 1000);
        const [scripRows] = await db.execute('SELECT lot_size FROM scrip_data WHERE symbol = ?', [trade.symbol]);
        const lotSize = (scripRows.length > 0) ? parseFloat(scripRows[0].lot_size || 1) : 1;

        const cleanSymbol = trade.symbol.includes(':') ? trade.symbol.split(':')[1] : trade.symbol;
        const marketTypeForClose = (trade.market_type || 'MCX').toUpperCase();
        const prefixForClose = marketTypeForClose === 'EQUITY' ? 'NSE' : (marketTypeForClose === 'OPTIONS' ? 'NFO' : marketTypeForClose);

        let livePriceForClose = null;
        const possibleSymbolsForClose = [trade.symbol, `${prefixForClose}:${cleanSymbol}`, cleanSymbol];
        const marketDataService = require('../services/MarketDataService');
        for (const s of possibleSymbolsForClose) {
            const data = marketDataService.getPrice(s);
            if (data && data.ltp) {
                livePriceForClose = data.ltp;
                break;
            }
        }

        const currentPrice = exitPrice || livePriceForClose || trade.entry_price;
        const actualQuantity = trade.actual_qty || (trade.qty * lotSize);
        const validationPnl = trade.type === 'BUY'
            ? (currentPrice - trade.entry_price) * actualQuantity
            : (trade.entry_price - currentPrice) * actualQuantity;

        if (minTimeSeconds > 0 && secondsHeld < minTimeSeconds) {
            return res.status(400).json({
                message: `Minimum hold time is ${minTimeSeconds} seconds. Please wait ${minTimeSeconds - secondsHeld} more second(s).`,
                remainingSeconds: minTimeSeconds - secondsHeld
            });
        }

        // ─── EXECUTE CLOSURE VIA SERVICE ──────────────────────────────────
        const closeIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '127.0.0.1';
        const result = await tradeService.closeTrade(trade.id, exitPrice, requesterId, pnl, null, closeIp);
        await syncPaperPosition(trade.user_id, trade.symbol);

        res.json({
            message: 'Trade closed successfully',
            ...result
        });

        // Notify user via socket for real-time UI update
        try {
            const { getIo } = require('../config/socket');
            const io = getIo();
            if (io) {
                io.to(`user:${trade.user_id}`).emit('notification', {
                    message: `Your trade for ${trade.symbol.includes(':') ? trade.symbol.split(':')[1] : trade.symbol} has been closed`,
                    type: 'TRADE_CLOSED',
                    tradeId: trade.id
                });
                io.to(`user:${trade.user_id}`).emit('trade_update', {
                    id: trade.id,
                    status: 'CLOSED'
                });
            }
        } catch (socketErr) {
            console.error('[closeTrade] Socket emit error:', socketErr.message);
        }
    } catch (err) {
        console.error('❌ Close Trade Error:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

/**
 * Soft Delete Trade (Audit Trail) — refunds margin + PnL back to user
 */
const deleteTrade = async (req, res) => {
    try {
        // Verify transaction password if provided (Bypass for TRADER)
        if (req.user.role !== 'TRADER' && req.body && req.body.transactionPassword) {
            const [users] = await db.execute('SELECT transaction_password FROM users WHERE id = ?', [req.user.id]);
            if (users.length && users[0].transaction_password) {
                const match = await bcrypt.compare(req.body.transactionPassword, users[0].transaction_password);
                if (!match) return res.status(403).json({ message: 'Invalid transaction password' });
            }
        }

        const [trades] = await db.execute('SELECT * FROM trades WHERE id = ?', [req.params.id]);
        if (trades.length === 0) return res.status(404).json({ message: 'Trade not found' });

        const trade = trades[0];
        if (trade.status === 'DELETED') return res.status(400).json({ message: 'Trade already deleted' });

        // Refund: margin + PnL (for CLOSED trades) or just margin (for OPEN trades)
        const marginToRefund = parseFloat(trade.margin_used || 0);
        const pnlToRefund = trade.status === 'CLOSED' ? parseFloat(trade.pnl || 0) : 0;
        const balanceRefund = marginToRefund + pnlToRefund;

        await db.execute('UPDATE trades SET status = "DELETED", exit_time = NOW() WHERE id = ?', [req.params.id]);
        await syncPaperPosition(trade.user_id, trade.symbol);

        if (balanceRefund !== 0) {
            await db.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [balanceRefund, trade.user_id]);
        }

        let traderUsername = '';
        try {
            const [uRows] = await db.execute('SELECT username FROM users WHERE id = ?', [trade.user_id]);
            if (uRows.length > 0) traderUsername = uRows[0].username;
        } catch (e) { console.warn('Error fetching trader username for delete log:', e.message); }

        let adminName = 'admin';
        try {
            const [adminRows] = await db.execute('SELECT username, role FROM users WHERE id = ?', [req.user.id]);
            if (adminRows.length > 0) {
                adminName = `${adminRows[0].role} ${adminRows[0].username}`;
            }
        } catch (e) { console.warn('Error fetching admin details for delete log:', e.message); }

        const lotSz = getLotSize(trade.symbol, trade.market_type);
        const lots = trade.qty / lotSz;

        const deleteLog = buildTradeLog('ORDER_DELETED', {
            username: traderUsername,
            userId: trade.user_id,
            side: trade.type,
            lots,
            symbol: trade.symbol,
            adminUser: adminName
        });
        await logAction(req.user.id, 'DELETE_TRADE', 'trades', deleteLog);

        // Clear cache on trade delete (Option A)
        try {
            await invalidateCache(`m2m_${trade.user_id}_TRADER`);
            await invalidateCache(`m2m_${trade.user_id}_SUPERADMIN`);
        } catch (e) {
            console.log(`[Cache] Clear failed but trade deleted`);
        }

        res.json({ message: 'Trade deleted and refunded', marginRefunded: marginToRefund, pnlRefunded: pnlToRefund });

        // Notify user via socket for real-time UI update
        try {
            const { getIo } = require('../config/socket');
            const io = getIo();
            if (io) {
                io.to(`user:${trade.user_id}`).emit('notification', {
                    message: `Your trade for ${trade.symbol.includes(':') ? trade.symbol.split(':')[1] : trade.symbol} has been deleted by admin`,
                    type: 'TRADE_DELETED',
                    tradeId: trade.id
                });
                io.to(`user:${trade.user_id}`).emit('trade_update', {
                    id: trade.id,
                    status: 'DELETED'
                });
            }
        } catch (socketErr) {
            console.error('[deleteTrade] Socket emit error:', socketErr.message);
        }
    } catch (err) {
        console.error('Delete Trade Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

/**
 * Update Trade (modify entry_price, exit_price, qty)
 */
const updateTrade = async (req, res) => {
    try {
        const { entry_price, exit_price, qty, transactionPassword } = req.body;

        // Verify transaction password (Bypass for TRADER)
        if (req.user.role !== 'TRADER' && transactionPassword) {
            const [users] = await db.execute('SELECT transaction_password FROM users WHERE id = ?', [req.user.id]);
            if (users.length && users[0].transaction_password) {
                const match = await bcrypt.compare(transactionPassword, users[0].transaction_password);
                if (!match) return res.status(403).json({ message: 'Invalid transaction password' });
            }
        }

        const [trades] = await db.execute('SELECT * FROM trades WHERE id = ?', [req.params.id]);
        if (trades.length === 0) return res.status(404).json({ message: 'Trade not found' });

        const trade = trades[0];

        // Build dynamic update
        const updates = [];
        const params = [];

        if (qty !== undefined && qty !== '' && qty !== null) {
            const newQty = parseInt(qty);
            if (newQty <= 0) return res.status(400).json({ message: 'Quantity must be positive' });
            updates.push('qty = ?');
            params.push(newQty);

            // Recalculate margin: price * qty * lotSize * 0.1
            let lotSize = 1;
            try {
                const [scripRows] = await db.execute('SELECT lot_size FROM scrip_data WHERE symbol = ?', [trade.symbol]);
                if (scripRows.length > 0 && parseFloat(scripRows[0].lot_size) > 1) {
                    lotSize = parseFloat(scripRows[0].lot_size);
                } else if ((trade.market_type || '').toUpperCase() === 'MCX') {
                    const MarginUtils = require('../utils/MarginUtils');
                    const baseScrip = MarginUtils.getMcxBaseScrip(trade.symbol);
                    const MCX_LOT_SIZES = {
                        'GOLD': 100, 'GOLDM': 10, 'GOLDGUINEA': 8, 'GOLDPETAL': 1,
                        'SILVER': 30, 'SILVERM': 5, 'SILVERMIC': 1,
                        'CRUDEOIL': 100, 'CRUDEOILM': 10,
                        'NATURALGAS': 1250, 'NATGASMINI': 250,
                        'COPPER': 2500,
                        'ZINC': 5000, 'ZINCMINI': 1000,
                        'LEAD': 5000, 'LEADMINI': 1000,
                        'NICKEL': 1500, 'NICKELMINI': 100,
                        'ALUMINIUM': 5000, 'ALUMINI': 1000,
                        'MENTHAOIL': 360, 'COTTON': 25, 'BULLDEX': 1,
                    };
                    if (baseScrip && MCX_LOT_SIZES[baseScrip]) lotSize = MCX_LOT_SIZES[baseScrip];
                }
            } catch (e) { }

            const price = entry_price ? parseFloat(entry_price) : parseFloat(trade.entry_price);
            const newMargin = price * newQty * lotSize * 0.1;
            const oldMargin = parseFloat(trade.margin_used || 0);
            const marginDiff = newMargin - oldMargin;

            updates.push('margin_used = ?');
            params.push(newMargin);

            // Adjust user balance for margin difference
            if (marginDiff !== 0) {
                await db.execute('UPDATE users SET balance = balance - ? WHERE id = ?', [marginDiff, trade.user_id]);
            }
        }

        if (entry_price !== undefined && entry_price !== '' && entry_price !== null) {
            updates.push('entry_price = ?');
            params.push(parseFloat(entry_price));
        }

        if (exit_price !== undefined && exit_price !== '' && exit_price !== null) {
            updates.push('exit_price = ?');
            params.push(parseFloat(exit_price));

            // Recalculate PnL if both entry and exit price exist
            const entryP = entry_price ? parseFloat(entry_price) : parseFloat(trade.entry_price);
            const exitP = parseFloat(exit_price);
            const q = qty ? parseInt(qty) : trade.qty;
            let pnl = 0;
            const commodityLotService = require('../services/CommodityLotService');
            if (commodityLotService.isCommodityScrip(trade.symbol, trade.market_type)) {
                const calc = commodityLotService.calculatePnL(trade.symbol, trade.type, entryP, exitP, q);
                pnl = calc.pnlInr;
            } else {
                pnl = trade.type === 'BUY' ? (exitP - entryP) * q : (entryP - exitP) * q;
            }
            updates.push('pnl = ?');
            params.push(pnl);
        }

        if (updates.length === 0) return res.status(400).json({ message: 'No fields to update' });

        params.push(req.params.id);
        await db.execute(`UPDATE trades SET ${updates.join(', ')} WHERE id = ?`, params);
        await syncPaperPosition(trade.user_id, trade.symbol);

        let traderUsername = '';
        try {
            const [uRows] = await db.execute('SELECT username FROM users WHERE id = ?', [trade.user_id]);
            if (uRows.length > 0) traderUsername = uRows[0].username;
        } catch (e) { console.warn('Error fetching trader username for update log:', e.message); }

        let adminName = 'admin';
        try {
            const [adminRows] = await db.execute('SELECT username, role FROM users WHERE id = ?', [req.user.id]);
            if (adminRows.length > 0) {
                adminName = `${adminRows[0].role} ${adminRows[0].username}`;
            }
        } catch (e) { console.warn('Error fetching admin details for update log:', e.message); }

        const lotSz = getLotSize(trade.symbol, trade.market_type);
        const lots = (qty ? parseInt(qty) : trade.qty) / lotSz;

        const updateLog = buildTradeLog('ORDER_UPDATED', {
            username: traderUsername,
            userId: trade.user_id,
            side: trade.type,
            lots,
            symbol: trade.symbol,
            adminUser: adminName
        });
        await logAction(req.user.id, 'UPDATE_TRADE', 'trades', updateLog);

        res.json({ message: 'Trade updated successfully' });

        // Notify user via socket for real-time UI update
        try {
            const { getIo } = require('../config/socket');
            const io = getIo();
            if (io) {
                io.to(`user:${trade.user_id}`).emit('notification', {
                    message: `Your trade for ${trade.symbol.includes(':') ? trade.symbol.split(':')[1] : trade.symbol} has been updated by admin`,
                    type: 'TRADE_UPDATED',
                    tradeId: trade.id
                });
                io.to(`user:${trade.user_id}`).emit('trade_update', {
                    id: trade.id,
                    status: trade.status
                });
            }
        } catch (socketErr) {
            console.error('[updateTrade] Socket emit error:', socketErr.message);
        }
    } catch (err) {
        console.error('Update Trade Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

/**
 * Restore Trade — reopens a CLOSED trade by removing exit data
 * Reverses the close: removes exit_price, exit_time, resets PnL, re-deducts margin from balance
 */
const restoreTrade = async (req, res) => {
    try {
        const { transactionPassword } = req.body;

        // Verify transaction password (Bypass for TRADER)
        if (req.user.role !== 'TRADER' && transactionPassword) {
            const [users] = await db.execute('SELECT transaction_password FROM users WHERE id = ?', [req.user.id]);
            if (users.length && users[0].transaction_password) {
                const match = await bcrypt.compare(transactionPassword, users[0].transaction_password);
                if (!match) return res.status(403).json({ message: 'Invalid transaction password' });
            }
        }

        const [trades] = await db.execute('SELECT * FROM trades WHERE id = ?', [req.params.id]);
        if (trades.length === 0) return res.status(404).json({ message: 'Trade not found' });

        const trade = trades[0];
        if (trade.status !== 'CLOSED') {
            return res.status(400).json({ message: 'Only CLOSED trades can be restored' });
        }

        // Reverse the close: take back PnL + margin that was released, then re-lock margin
        const pnl = parseFloat(trade.pnl || 0);
        const margin = parseFloat(trade.margin_used || 0);
        // On close: balance += pnl + margin. To reverse: balance -= (pnl + margin) then balance += 0 (margin stays locked)
        // Net: balance -= pnl (refund the PnL reversal, keep margin locked)
        const balanceDeduction = pnl; // Remove the PnL that was credited on close

        // Reopen the trade
        await db.execute(
            'UPDATE trades SET status = "OPEN", exit_price = NULL, exit_time = NULL, pnl = 0 WHERE id = ?',
            [req.params.id]
        );
        await syncPaperPosition(trade.user_id, trade.symbol);

        // Reverse balance: deduct the PnL that was added on close
        if (balanceDeduction !== 0) {
            await db.execute('UPDATE users SET balance = balance - ? WHERE id = ?', [balanceDeduction, trade.user_id]);
        }

        let traderUsername = '';
        try {
            const [uRows] = await db.execute('SELECT username FROM users WHERE id = ?', [trade.user_id]);
            if (uRows.length > 0) traderUsername = uRows[0].username;
        } catch (e) { console.warn('Error fetching trader username for restore log:', e.message); }

        let adminName = 'admin';
        try {
            const [adminRows] = await db.execute('SELECT username, role FROM users WHERE id = ?', [req.user.id]);
            if (adminRows.length > 0) {
                adminName = `${adminRows[0].role} ${adminRows[0].username}`;
            }
        } catch (e) { console.warn('Error fetching admin details for restore log:', e.message); }

        const lotSz = getLotSize(trade.symbol, trade.market_type);
        const lots = trade.qty / lotSz;

        const restoreLog = buildTradeLog('ORDER_RESTORED', {
            username: traderUsername,
            userId: trade.user_id,
            side: trade.type,
            lots,
            symbol: trade.symbol,
            adminUser: adminName
        });
        await logAction(req.user.id, 'RESTORE_TRADE', 'trades', restoreLog);

        res.json({ message: 'Trade restored to OPEN', pnlReversed: pnl });

        // Notify user via socket for real-time UI update
        try {
            const { getIo } = require('../config/socket');
            const io = getIo();
            if (io) {
                io.to(`user:${trade.user_id}`).emit('notification', {
                    message: `Your trade for ${trade.symbol.includes(':') ? trade.symbol.split(':')[1] : trade.symbol} has been restored to OPEN by admin`,
                    type: 'TRADE_RESTORED',
                    tradeId: trade.id
                });
                io.to(`user:${trade.user_id}`).emit('trade_update', {
                    id: trade.id,
                    status: 'OPEN'
                });
            }
        } catch (socketErr) {
            console.error('[restoreTrade] Socket emit error:', socketErr.message);
        }
    } catch (err) {
        console.error('Restore Trade Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

/**
 * Modify Pending Order — trader can modify their own pending orders (qty, price)
 */
const modifyPendingOrder = async (req, res) => {
    try {
        const { qty, price } = req.body;
        const tradeId = req.params.id;
        const userId = req.user.id;

        const [trades] = await db.execute('SELECT * FROM trades WHERE id = ?', [tradeId]);
        if (trades.length === 0) return res.status(404).json({ message: 'Trade not found' });

        const trade = trades[0];

        // Trader can only modify their own orders
        if (trade.user_id !== userId) {
            return res.status(403).json({ message: 'Not authorized to modify this order' });
        }

        // Only pending orders can be modified
        if (trade.status !== 'PENDING' && trade.is_pending !== 1) {
            return res.status(400).json({ message: 'Only pending orders can be modified' });
        }

        const updates = [];
        const params = [];

        if (qty !== undefined && qty !== null) {
            let qtyToStore = parseInt(qty);

            // ✅ FOR MCX: Multiply by LOT size to get actual units
            if (trade.market_type === 'MCX') {
                try {
                    const MCX_LOT_SIZES = {
                        'GOLD': 100, 'GOLDM': 10, 'GOLDGUINEA': 8, 'GOLDPETAL': 1,
                        'SILVER': 30, 'SILVERM': 5, 'SILVERMIC': 1,
                        'CRUDEOIL': 100, 'CRUDEOILM': 10,
                        'COPPER': 250, 'COPPERMIC': 1, 'NICKEL': 250, 'NICKELMINI': 10,
                        'ZINC': 250, 'ZINCY': 250, 'LEAD': 250, 'LEADMINI': 10,
                        'ALUMINIUM': 1000, 'ALUMINI': 1000, 'NATURALGAS': 1250,
                        'MENTHAOIL': 360, 'COTTON': 100, 'BULLDEX': 100, 'CRUDEOIL MINI': 10
                    };

                    let lotSize = 1;
                    const [scripRows] = await db.execute('SELECT lot_size FROM scrip_data WHERE symbol = ?', [trade.symbol]);
                    if (scripRows.length > 0) {
                        lotSize = parseFloat(scripRows[0].lot_size || 1);
                    } else {
                        const baseSym = getMcxBaseScrip(trade.symbol);
                        if (baseSym && MCX_LOT_SIZES[baseSym]) {
                            lotSize = MCX_LOT_SIZES[baseSym];
                        }
                    }

                    // Store quantity as entered by user (no lot multiplication)
                    qtyToStore = parseInt(qty);
                } catch (e) {
                    console.warn('[modifyPendingOrder] Warning: Could not fetch lotSize, using qty as-is:', e.message);
                }
            }

            updates.push('qty = ?');
            params.push(qtyToStore);
        }
        if (price !== undefined && price !== null) {
            updates.push('entry_price = ?');
            params.push(parseFloat(price));
        }

        if (updates.length === 0) {
            return res.status(400).json({ message: 'Nothing to update' });
        }

        params.push(tradeId);
        await db.execute(`UPDATE trades SET ${updates.join(', ')} WHERE id = ?`, params);

        res.json({ message: 'Pending order modified successfully' });
    } catch (err) {
        console.error('Modify Pending Order Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

/**
 * Set Target & Stop Loss for a trade
 * Called from mobile app when user sets target/SL
 */
const setTargetSL = async (req, res) => {
    try {
        const tradeId = req.params.id;
        const { targetPrice, stopLoss } = req.body;
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({ message: 'Unauthorized: User not found in request' });
        }

        // Fetch trade to verify ownership
        const [trades] = await db.execute('SELECT * FROM trades WHERE id = ?', [tradeId]);
        if (trades.length === 0) {
            return res.status(404).json({ message: 'Trade not found' });
        }

        const trade = trades[0];

        // Authorization check
        if (trade.user_id !== userId && req.user.role === 'TRADER') {
            return res.status(403).json({ message: 'Not authorized to modify this trade' });
        }

        // Only open trades can have target/SL set
        if (trade.status !== 'OPEN') {
            return res.status(400).json({ message: 'Trade is not open' });
        }

        // Validate prices - convert NaN to null for database binding
        let target = null;
        let sl = null;

        if (targetPrice) {
            const parsed = parseFloat(targetPrice);
            target = isNaN(parsed) ? null : parsed;
        }

        if (stopLoss) {
            const parsed = parseFloat(stopLoss);
            sl = isNaN(parsed) ? null : parsed;
        }

        if (target && sl) {
            if (trade.type === 'BUY' && target <= sl) {
                return res.status(400).json({ message: 'For BUY trades: Target must be > Stop Loss' });
            }
            if (trade.type === 'SELL' && target >= sl) {
                return res.status(400).json({ message: 'For SELL trades: Target must be < Stop Loss' });
            }
        }

        // Validate all parameters before database update
        console.log(`[TargetSL] DEBUG - tradeId: ${tradeId}, target: ${target}, sl: ${sl}`);
        console.log(`[TargetSL] DEBUG - Types - tradeId: ${typeof tradeId}, target: ${typeof target}, sl: ${typeof sl}`);

        if (tradeId === undefined || tradeId === null) {
            return res.status(400).json({ message: 'Trade ID is required' });
        }

        // Update trade with target & SL
        await db.execute(
            'UPDATE trades SET target_price = ?, stop_loss = ? WHERE id = ?',
            [target, sl, tradeId]
        );

        console.log(`[TargetSL] ✅ Trade #${tradeId} updated - Target: ${target}, SL: ${sl}`);

        res.json({
            message: 'Target & Stop Loss set successfully',
            targetPrice: target,
            stopLoss: sl
        });
    } catch (err) {
        console.error('❌ Set Target/SL Error:', err.message || err);
        res.status(500).json({ message: `Failed to set Target/SL: ${err.message || 'Unknown error'}` });
    }
};

const completePendingOrder = async (req, res) => {
    try {
        const tradeId = req.params.id;
        const [trades] = await db.execute('SELECT * FROM trades WHERE id = ?', [tradeId]);
        if (trades.length === 0) return res.status(404).json({ message: 'Trade not found' });

        const trade = trades[0];
        if (trade.is_pending !== 1 || trade.status !== 'OPEN') {
            return res.status(400).json({ message: 'Only open pending orders can be completed' });
        }

        const executionPrice = parseFloat(trade.entry_price);
        const result = await tradeService.executePendingOrderNetting(tradeId, executionPrice);

        res.json({
            message: 'Order completed successfully',
            executionPrice,
            ...result
        });
    } catch (err) {
        console.error('Complete Pending Order Error:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

module.exports = { placeOrder, getTrades, getTradeById, getGroupTrades, getActivePositions, closeTrade, deleteTrade, updateTrade, restoreTrade, modifyPendingOrder, setTargetSL, completePendingOrder };
