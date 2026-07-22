const db = require('../config/db');
const mockEngine = require('../utils/mockEngine');
const { logAction } = require('../controllers/systemController');
const { invalidateCache } = require('../utils/cacheManager');
const kiteService = require('../utils/kiteService');
const { getLotSize } = require('../utils/symbolHelper');
const { buildTradeLog } = require('../utils/logFormatter');

// ═══════════════════════════════════════════════════════════════════
// 🔒 LAST VALID BID/ASK CACHE: Store last valid prices when market open
// ═══════════════════════════════════════════════════════════════════
const lastValidBidAskCache = {};  // Format: { 'SYMBOL': { bid: X, ask: Y, timestamp: Z } }

const cacheLastValidBidAsk = (symbol, bid, ask) => {
    if (bid > 0 && ask > 0) {
        lastValidBidAskCache[symbol] = {
            bid: parseFloat(bid),
            ask: parseFloat(ask),
            timestamp: new Date().toISOString()
        };
        console.log(`[Cache] Stored last valid bid/ask for ${symbol}: bid=${bid}, ask=${ask}`);
    }
};

const getLastValidBidAsk = (symbol) => {
    return lastValidBidAskCache[symbol] || null;
};

const syncPaperPosition = async (userId, symbol, connection = db) => {
    try {
        console.log(`[syncPaperPosition] Syncing paper position (Service) for user ${userId}, symbol ${symbol}`);
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
 * Service to handle core Trade operations like closing and auto-squaring off.
 */
class TradeService {

    /**
     * Closes a single trade by its ID.
     * Reusable for manual close, auto-close, and expiry square-off.
     */
    async closeTrade(tradeId, exitPrice = null, requesterId = 0, providedPnl = null, remark = null, closeIp = null) {
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            // 1. Fetch trade and client settings
            const [tradeRows] = await connection.execute(
                `SELECT t.*, cs.config_json, cs.broker_id 
                 FROM trades t
                 JOIN client_settings cs ON t.user_id = cs.user_id
                 WHERE t.id = ?`,
                [tradeId]
            );

            if (tradeRows.length === 0) throw new Error('Trade not found');
            const trade = tradeRows[0];
            if (trade.status !== 'OPEN') throw new Error('Trade is already closed');

            const clientConfig = JSON.parse(trade.config_json || '{}');
            const marginToRelease = parseFloat(trade.margin_used || 0);

            // 2. Handle Pending Orders
            if (trade.is_pending == 1) {
                await connection.execute(
                    'UPDATE trades SET status = "CANCELLED", exit_price = entry_price, exit_time = NOW(), pnl = 0 WHERE id = ?',
                    [tradeId]
                );
                await connection.execute(
                    'UPDATE users SET balance = balance + ? WHERE id = ?',
                    [marginToRelease, trade.user_id]
                );
                await connection.commit();

                // Fetch username for logging
                let username = '';
                try {
                    const [uRows] = await connection.execute('SELECT username FROM users WHERE id = ?', [trade.user_id]);
                    if (uRows.length > 0) username = uRows[0].username;
                } catch (e) { console.warn('Error fetching username for cancel log:', e.message); }

                const lotSz = getLotSize(trade.symbol, trade.market_type);
                const lots = trade.qty / lotSz;
                const cancelLog = buildTradeLog('ORDER_CANCELLED', {
                    username,
                    userId: trade.user_id,
                    side: trade.type,
                    lots,
                    symbol: trade.symbol
                });

                await logAction(requesterId || trade.user_id, 'CANCEL_TRADE', 'trades', cancelLog);
                return { success: true, message: 'Pending order cancelled', pnl: 0 };
            }

            // 3. Normal Market Order Closure
            let lotSize = 1;
            let mType = (trade.market_type || '').toUpperCase();
            if (mType === 'COMMODITY') {
                mType = 'COMEX';
            }

            // ══════════════════════════════════════════════════════════════════
            // LOT SIZE CALCULATION (Sync with dashboardController.js)
            // ══════════════════════════════════════════════════════════════════
            if (mType === 'MCX') {
                const { getMcxBaseScrip, MCX_LOT_SIZES } = require('../utils/symbolHelper');
                const base = getMcxBaseScrip(trade.symbol);
                const symTrimmed = (trade.symbol || '').toUpperCase().replace(/\d+.*/, '');

                // 1. Try Hardcoded MCX_LOT_SIZES first (Primary source)
                if (base && MCX_LOT_SIZES[base]) {
                    lotSize = MCX_LOT_SIZES[base];
                } else if (MCX_LOT_SIZES[symTrimmed]) {
                    lotSize = MCX_LOT_SIZES[symTrimmed];
                }

                console.log(`[TradeService] Final MCX Lot Size: ${trade.symbol} → ${lotSize}`);
            }
            else if (mType === 'EQUITY' || mType === 'NSE' || mType === 'NFO' || mType === 'OPTIONS') {
                // NSE/Equity generally uses 1 share = 1 unit for P/L calculation, 
                // unless it's a derivative where we might need to check DB for lot_size.
                lotSize = 1;
                if (mType !== 'EQUITY') {
                    try {
                        const [scripRows] = await connection.execute('SELECT lot_size FROM scrip_data WHERE symbol = ?', [trade.symbol]);
                        if (scripRows.length > 0) lotSize = parseFloat(scripRows[0].lot_size) || 1;
                    } catch (e) { console.warn(`[TradeService] Error fetching ${mType} lot size:`, e.message); }
                }
            }
            else {
                // Default fallback to scrip_data
                try {
                    const [scripRows] = await connection.execute(
                        'SELECT lot_size FROM scrip_data WHERE symbol = ?',
                        [trade.symbol]
                    );
                    if (scripRows.length > 0 && parseFloat(scripRows[0].lot_size) > 0) {
                        lotSize = parseFloat(scripRows[0].lot_size);
                        console.log(`[TradeService] ${mType} Lot Size (from DB): ${trade.symbol} → ${lotSize}`);
                    } else {
                        lotSize = 1;
                    }
                } catch (e) {
                    lotSize = 1;
                }
            }

            let finalExitPrice = exitPrice;
            const isIndianSegment = ['MCX', 'NSE', 'NFO', 'EQUITY', 'OPTIONS'].includes(mType);

            if (!finalExitPrice || finalExitPrice <= 0) {
                const { getMcxBaseScrip } = require('../utils/symbolHelper');
                const base = getMcxBaseScrip(trade.symbol);
                const marketDataService = require('./MarketDataService');

                // 🎯 1. For Indian Segments, try Kite API (Direct Quote) FIRST for accuracy
                if (isIndianSegment && kiteService.isAuthenticated()) {
                    try {
                        const kiteSym = trade.symbol.includes(':') ? trade.symbol : (mType === 'MCX' ? `MCX:${trade.symbol}` : (mType === 'EQUITY' ? `NSE:${trade.symbol}` : `NFO:${trade.symbol}`));
                        console.log(`[TradeService] Fetching Real-time Kite Quote for ${kiteSym}...`);
                        const quoteRes = await kiteService.getQuote(kiteSym);
                        const quote = quoteRes[kiteSym] || Object.values(quoteRes)[0];
                        if (quote && quote.last_price > 0) {
                            let bid = quote.depth?.buy?.[0]?.price;
                            let ask = quote.depth?.sell?.[0]?.price;

                            // If depth data available, cache it for later use
                            if (bid > 0 && ask > 0) {
                                cacheLastValidBidAsk(kiteSym, bid, ask);
                            }

                            if (!bid || bid <= 0) bid = quote.last_price;
                            if (!ask || ask <= 0) ask = quote.last_price;

                            finalExitPrice = trade.type === 'BUY' ? bid : ask;

                            // If it still evaluates to 0, use last_price
                            if (!finalExitPrice || finalExitPrice <= 0) {
                                finalExitPrice = quote.last_price;
                            }

                            console.log(`[TradeService] ✅ Real Zerodha Price Received: ${finalExitPrice} (LTP: ${quote.last_price}, Bid: ${bid}, Ask: ${ask})`);
                        }
                    } catch (e) {
                        console.warn(`[TradeService] Kite Quote Fallback triggered:`, e.message);
                    }
                }

                // 🎯 2. Try Memory Ticker (Primary for Forex/Crypto, Fallback for others)
                if (!finalExitPrice || finalExitPrice <= 0) {
                    const searchPatterns = [trade.symbol, `MCX:${trade.symbol}`, `NFO:${trade.symbol}`, `NSE:${trade.symbol}`, `FOREX:${trade.symbol}`, `CRYPTO:${trade.symbol}`];
                    let liveData = null;
                    for (const p of searchPatterns) {
                        liveData = marketDataService.getPrice(p);
                        if (liveData) break;
                    }

                    if (liveData) {
                        let bid = liveData.bid > 0 ? liveData.bid : liveData.ltp;
                        let ask = liveData.ask > 0 ? liveData.ask : liveData.ltp;
                        finalExitPrice = trade.type === 'BUY' ? bid : ask;
                        console.log(`[TradeService] Found in Ticker: ${finalExitPrice} (LTP: ${liveData.ltp}, Bid: ${bid}, Ask: ${ask})`);
                    }
                }

                // 🎯 3. Use Cached Valid Bid/Ask (Market Close Protection)
                if (!finalExitPrice || finalExitPrice <= 0) {
                    const cachedBidAsk = getLastValidBidAsk(trade.symbol);
                    if (cachedBidAsk && cachedBidAsk.bid > 0 && cachedBidAsk.ask > 0) {
                        const cachedPrice = trade.type === 'BUY' ? cachedBidAsk.bid : cachedBidAsk.ask;
                        finalExitPrice = cachedPrice;
                        console.log(`[TradeService] ✅ Using cached bid/ask from ${cachedBidAsk.timestamp}: ${finalExitPrice} (Bid: ${cachedBidAsk.bid}, Ask: ${cachedBidAsk.ask})`);
                    } else {
                        // 🎯 4. Final Fallback (Entry Price) - only if no cache available
                        finalExitPrice = trade.entry_price;
                        console.warn(`[TradeService] ⚠️ No cached bid/ask and no live price, using Entry Price: ${finalExitPrice}`);
                    }
                }
            }

            // ═══════════════════════════════════════════════════════════════════
            // 🔒 DEPTH DATA CHECK: Use cached bid/ask when Zerodha depth unavailable
            // ═══════════════════════════════════════════════════════════════════

            // Get market close status
            const now = new Date();
            const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
            const currentHour = istTime.getHours();
            const currentMin = istTime.getMinutes();
            const isMcxMarketClosed = (mType === 'MCX' && (currentHour >= 23 || (currentHour === 23 && currentMin >= 30)));

            // Check if depth data was available from Zerodha
            let depthDataWasAvailable = false;
            let priceSource = 'UNKNOWN';

            // If we got Kite quote and it had depth, mark it as available
            if (exitPrice === null || exitPrice <= 0) {
                if (isIndianSegment && kiteService.isAuthenticated()) {
                    try {
                        const kiteSym = trade.symbol.includes(':') ? trade.symbol : (mType === 'MCX' ? `MCX:${trade.symbol}` : (mType === 'EQUITY' ? `NSE:${trade.symbol}` : `NFO:${trade.symbol}`));
                        const quoteRes = await kiteService.getQuote(kiteSym);
                        const quote = quoteRes[kiteSym] || Object.values(quoteRes)[0];

                        // Check if depth data exists
                        if (quote && quote.depth?.buy?.[0]?.price && quote.depth?.sell?.[0]?.price) {
                            depthDataWasAvailable = true;
                            priceSource = 'KITE_DEPTH';
                            console.log(`[TradeService] ✅ Depth data available from Kite`);
                        } else if (quote && quote.last_price > 0) {
                            depthDataWasAvailable = false;
                            priceSource = 'KITE_LTP_ONLY';
                            console.warn(`[TradeService] ⚠️ Depth data NOT available from Kite, only LTP received`);
                        }
                    } catch (e) {
                        depthDataWasAvailable = false;
                        priceSource = 'FALLBACK';
                    }
                }
            }

            // If market is closed and depth was NOT available, warn about potential stale LTP
            if (isMcxMarketClosed && !depthDataWasAvailable) {
                console.warn(`
🚨 [MARKET CLOSE + NO DEPTH DATA]
   Time: ${currentHour}:${currentMin} IST (Market Closed)
   Symbol: ${trade.symbol}
   Issue: Zerodha depth data not available, using stale/fallback price
   Exit Price: ₹${finalExitPrice}
   Source: ${priceSource}
   ⚠️  Price may be LTP from before market close, not current bid/ask
                `);
            }

            console.log(`
[TradeService] 📊 PRICE SOURCE INFO
   Trade ID: ${trade.id}
   Symbol: ${trade.symbol}
   Entry: ₹${parseFloat(trade.entry_price).toFixed(2)}
   Exit: ₹${parseFloat(finalExitPrice).toFixed(2)}
   Source: ${priceSource}
   Depth Available: ${depthDataWasAvailable ? 'YES' : 'NO'}
   Market Status: ${isMcxMarketClosed ? 'CLOSED (23:30+)' : 'OPEN'}
            `);

            // Use provided P/L from frontend if available (calculated at the moment of exit)
            // Otherwise calculate it based on exit price and actual_qty (for new trades with units/lots mode)
            let pnl;
            if (providedPnl !== null && providedPnl !== undefined) {
                pnl = parseFloat(providedPnl);
                console.log(`[TradeService] Using provided P/L: ${pnl}`);
            } else {
                const commodityLotService = require('./CommodityLotService');
                if (commodityLotService.isCommodityScrip(trade.symbol, trade.market_type)) {
                    const calc = commodityLotService.calculatePnL(trade.symbol, trade.type, trade.entry_price, finalExitPrice, trade.qty);
                    pnl = calc.pnlInr;
                    console.log(`[TradeService] Calculated Commodity P/L: ${pnl} INR (USD: ${calc.pnlUsd}, Lot Size: ${calc.lotSize}, USDINR: ${calc.usdInr})`);
                } else {
                    // 🎯 FIXED: Always use (qty * lotSize) for consistent P/L across all segments
                    const qtyForPnl = trade.qty * lotSize;
                    pnl = trade.type === 'BUY'
                        ? (finalExitPrice - trade.entry_price) * qtyForPnl
                        : (trade.entry_price - finalExitPrice) * qtyForPnl;
                    console.log(`[TradeService] Calculated P/L using qty×lotSize (${trade.qty}×${lotSize}): ${pnl}`);
                }
            }

            // 4. Calculate Brokerage & Swap
            let brokerage = 0;
            let swap = 0;
            let brokerSwapRate = 5;

            // Helper: calculate brokerage based on type
            const calcBrokerage = (brokerageVal, brokerageType, qty, exitPrice, entryPrice, multiplier = 1) => {
                const rate = Math.abs(parseFloat(brokerageVal || 0));
                if (rate <= 0) return 0;

                const type = (brokerageType || 'PER_LOT').toUpperCase();
                let result = 0;

                if (type === 'PER_LOT' || type === 'PER LOT') {
                    result = qty * rate;
                } else if (type === 'PER_CRORE' || type === 'PER CRORE') {
                    const turnover = (parseFloat(entryPrice) + parseFloat(exitPrice)) * qty * multiplier;
                    result = (turnover / 10000000) * rate;
                } else {
                    result = qty * rate;
                }

                // Ensure brokerage is never negative
                return Math.max(0, result);
            };

            // Clean symbol (remove exchange prefix like "MCX:" and handle formats like GOLD26JUNFUT)
            let rawSymbol = (trade.symbol || '').toUpperCase();
            let cleanSymbol = rawSymbol.includes(':') ? rawSymbol.split(':')[1] : rawSymbol;

            // Try to find scrip-specific brokerage in client_settings config
            let scripRate = undefined;

            if (mType === 'MCX') {
                // Priority based on mcxBrokerageType
                const brokerageType = (clientConfig.mcxBrokerageType || 'per_crore').toLowerCase();

                // ONLY look for scrip-specific brokerage if in per_lot mode
                if (brokerageType === 'per_lot') {
                    const lotBrokerageMap = { ...clientConfig.brokerMcxBrokerage, ...clientConfig.mcxLotBrokerage };

                    // 1. Try exact match on clean symbol
                    if (lotBrokerageMap[cleanSymbol] !== undefined) {
                        scripRate = parseFloat(lotBrokerageMap[cleanSymbol]);
                    } else {
                        // 2. Try to find if any key in map is a prefix or part of cleanSymbol
                        // Sort keys by length descending to match longest first
                        const sortedKeys = Object.keys(lotBrokerageMap).sort((a, b) => b.length - a.length);
                        for (const key of sortedKeys) {
                            if (cleanSymbol.startsWith(key.toUpperCase().replace(/\s+/g, ''))) {
                                scripRate = parseFloat(lotBrokerageMap[key]);
                                break;
                            }
                        }
                    }
                }
            } else if (mType === 'EQUITY') {
                const equityMap = clientConfig.brokerEquityBrokerage || {};
                if (equityMap[cleanSymbol] !== undefined) {
                    scripRate = parseFloat(equityMap[cleanSymbol]);
                } else {
                    const sortedKeys = Object.keys(equityMap).sort((a, b) => b.length - a.length);
                    for (const key of sortedKeys) {
                        if (cleanSymbol.startsWith(key.toUpperCase())) {
                            scripRate = parseFloat(equityMap[key]);
                            break;
                        }
                    }
                }
            }

            if (scripRate !== undefined && scripRate > 0) {
                // Priority 1: Scrip-specific from config
                // Always use (qty * lotSize) for lot-based scripts
                const qtyForBrokerage = trade.qty * lotSize;
                brokerage = (trade.qty) * scripRate; // For per-lot, we just use number of lots
                console.log(`[TradeService] Scrip-specific Brokerage: Raw=${rawSymbol}, Clean=${cleanSymbol}, Rate=${scripRate}, Lots=${trade.qty}, Calculated=${brokerage.toFixed(2)}`);
            } else {
                // Priority 2: Segment Settings from user_segments
                const [segmentRows] = await connection.execute(
                    'SELECT * FROM user_segments WHERE user_id = ? AND segment = ?',
                    [trade.user_id, trade.market_type]
                );

                if (segmentRows.length > 0 && parseFloat(segmentRows[0].brokerage_value) > 0) {
                    const seg = segmentRows[0];
                    // 🎯 FIXED: Always use trade.qty and lotSize multiplier for consistency
                    const qtyForBrokerageCalc = trade.qty;
                    const multiplierForBrokerage = lotSize;

                    // NSE and NFO segments must always use PER_CRORE calculation
                    let forcedType = (seg.brokerage_type || 'PER_LOT').toUpperCase();
                    if (mType === 'EQUITY' || mType === 'NFO' || mType === 'OPTIONS') {
                        forcedType = 'PER_CRORE';
                    }

                    brokerage = calcBrokerage(seg.brokerage_value, forcedType, qtyForBrokerageCalc, finalExitPrice, trade.entry_price, multiplierForBrokerage);
                    console.log(`[TradeService] Segment ${trade.market_type} Brokerage: Rate=${seg.brokerage_value}, Type=${forcedType} (Forced if NSE/NFO), Lots=${qtyForBrokerageCalc}, Mult=${multiplierForBrokerage}, Calculated=${brokerage.toFixed(2)}`);
                } else {
                    // Priority 3: General Fallback from client_settings
                    const qtyForClientBrokerage = trade.qty;
                    const multiplierForClientBrokerage = lotSize;

                    if (mType === 'MCX') {
                        const brokerageType = (clientConfig.mcxBrokerageType || 'per_crore').toLowerCase();
                        let rate = parseFloat(clientConfig.mcxBrokerage || 0);

                        const calcType = brokerageType === 'per_lot' ? 'PER_LOT' : 'PER_CRORE';
                        brokerage = calcBrokerage(rate, calcType, qtyForClientBrokerage, finalExitPrice, trade.entry_price, multiplierForClientBrokerage);
                    } else if (mType === 'EQUITY') {
                        const rate = parseFloat(clientConfig.brokerEquityBrokerage || clientConfig.equityBrokerage || 0);
                        // NSE Equity must always use PER_CRORE
                        brokerage = calcBrokerage(rate, 'PER_CRORE', qtyForClientBrokerage, finalExitPrice, trade.entry_price, multiplierForClientBrokerage);
                    } else if (mType === 'OPTIONS') {
                        let rate = 0;
                        if (cleanSymbol.includes('NIFTY') || cleanSymbol.includes('BANKNIFTY')) {
                            rate = parseFloat(clientConfig.brokerOptionsIndexBrokerage || clientConfig.optionsIndexBrokerage || 20);
                        } else if (mType === 'MCX' || cleanSymbol.includes('MCX')) {
                            rate = parseFloat(clientConfig.brokerOptionsMcxBrokerage || clientConfig.optionsMcxBrokerage || 20);
                        } else {
                            rate = parseFloat(clientConfig.brokerOptionsEquityBrokerage || clientConfig.optionsEquityBrokerage || 20);
                        }
                        // NFO Options must always use PER_CRORE as per user request
                        brokerage = calcBrokerage(rate, 'PER_CRORE', qtyForClientBrokerage, finalExitPrice, trade.entry_price, multiplierForClientBrokerage);
                    } else if (mType === 'COMEX') {
                        const comexCfg = clientConfig.comexConfig || {};
                        const rate = parseFloat(comexCfg.brokerage || clientConfig.comexBrokerage || 0);
                        const bType = comexCfg.brokerageType || 'per_lot';
                        brokerage = calcBrokerage(rate, bType, qtyForClientBrokerage, finalExitPrice, trade.entry_price, multiplierForClientBrokerage);
                    } else if (mType === 'FOREX') {
                        const forexCfg = clientConfig.forexConfig || {};
                        const rate = parseFloat(forexCfg.brokerage || clientConfig.forexBrokerage || 0);
                        const bType = forexCfg.brokerageType || 'per_lot';
                        brokerage = calcBrokerage(rate, bType, qtyForClientBrokerage, finalExitPrice, trade.entry_price, multiplierForClientBrokerage);
                    } else if (mType === 'CRYPTO') {
                        const cryptoCfg = clientConfig.cryptoConfig || {};
                        const rate = parseFloat(cryptoCfg.brokerage || clientConfig.cryptoBrokerage || 0);
                        const bType = cryptoCfg.brokerageType || 'per_lot';
                        brokerage = calcBrokerage(rate, bType, qtyForClientBrokerage, finalExitPrice, trade.entry_price, multiplierForClientBrokerage);
                    }

                    if (brokerage > 0) {
                        console.log(`[TradeService] Fallback ${mType} Brokerage Calculated: ${brokerage.toFixed(2)}`);
                    }
                }
            }

            // Calculate Swap if applicable
            if (trade.broker_id) {
                const [brokerRows] = await connection.execute('SELECT swap_rate FROM broker_shares WHERE user_id = ?', [trade.broker_id]);
                if (brokerRows.length > 0) brokerSwapRate = parseFloat(brokerRows[0].swap_rate || 5);

                const entryTime = new Date(trade.entry_time);
                const daysHeld = Math.ceil((new Date() - entryTime) / (1000 * 60 * 60 * 24));
                if ((trade.market_type === 'MCX' || trade.market_type === 'EQUITY') && daysHeld > 1) {
                    const qtyForSwap = trade.actual_qty || trade.qty;
                    swap = qtyForSwap * brokerSwapRate * (daysHeld - 1);
                }
            }

            // 5. Update Database
            const balanceChange = pnl - brokerage - swap;

            // Determine closed_by: Store username if TRADER, role name if ADMIN/SUPERADMIN
            let closedByValue = 'TRADER';
            if (requesterId === 0) {
                closedByValue = 'ADMIN';
            } else {
                const [reqUserRows] = await connection.execute(
                    'SELECT role, username FROM users WHERE id = ?',
                    [requesterId]
                );
                if (reqUserRows.length > 0) {
                    if (reqUserRows[0].role !== 'TRADER') {
                        // Admin/SuperAdmin — store role
                        closedByValue = reqUserRows[0].role;
                    } else {
                        // Trader — store actual username for display
                        closedByValue = reqUserRows[0].username || 'TRADER';
                    }
                }
            }

            await connection.execute(
                'UPDATE trades SET status = "CLOSED", exit_price = ?, exit_time = NOW(), pnl = ?, brokerage = ?, swap = ?, closed_by = ?, close_remark = ?, close_ip = ? WHERE id = ?',
                [finalExitPrice, pnl, brokerage, swap, closedByValue, remark, closeIp, tradeId]
            );

            await connection.execute(
                'UPDATE users SET balance = balance + ? WHERE id = ?',
                [balanceChange, trade.user_id]
            );

            await syncPaperPosition(trade.user_id, trade.symbol, connection);

            await connection.commit();

            // 6. Housekeeping (Logs & Cache)
            let ownerUsername = '';
            let ownerBalance = 0;
            try {
                const [ownerRows] = await connection.execute('SELECT username, balance FROM users WHERE id = ?', [trade.user_id]);
                if (ownerRows.length > 0) {
                    ownerUsername = ownerRows[0].username;
                    ownerBalance = ownerRows[0].balance;
                }
            } catch (e) { console.warn('Error fetching owner details for close log:', e.message); }

            const exitSide = trade.type.toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
            const lotsVal = trade.qty_input || (trade.qty / lotSize);
            
            const exitLogMsg = buildTradeLog('EXIT_EXECUTED', {
                username: ownerUsername,
                userId: trade.user_id,
                side: exitSide,
                lots: lotsVal,
                symbol: trade.symbol,
                price: finalExitPrice,
                availableFunds: parseFloat(ownerBalance).toFixed(4),
                requiredFunds: parseFloat(trade.margin_used || 0).toFixed(2)
            });
            await logAction(requesterId || trade.user_id, 'CLOSE_TRADE', 'trades', exitLogMsg);

            // Also log COM1, COM2, COM3
            const comPayload = {
                execOrderId: tradeId,
                parentTradeId: tradeId,
                execPrice: finalExitPrice,
                parentPrice: trade.entry_price,
                qty: trade.qty
            };
            await logAction(requesterId || trade.user_id, 'CLOSE_TRADE', 'trades', buildTradeLog('COM1_CLOSED', comPayload));
            await logAction(requesterId || trade.user_id, 'CLOSE_TRADE', 'trades', buildTradeLog('COM2_CLOSED', comPayload));
            await logAction(requesterId || trade.user_id, 'CLOSE_TRADE', 'trades', buildTradeLog('COM3_CLOSED', comPayload));

            try {
                await invalidateCache(`m2m_${trade.user_id}_TRADER`);
                await invalidateCache(`m2m_${trade.user_id}_BROKER`);
                await invalidateCache(`m2m_${trade.user_id}_SUPERADMIN`);
            } catch (_) { }

            return { success: true, pnl, brokerage, swap, balanceChange };
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }
    }

    /**
     * Calculates brokerage and swap for a given trade.
     */
    async calculateBrokerageAndSwapForTrade(trade, exitPrice, exitTime = new Date(), connection = db) {
        let lotSize = 1;
        let mType = (trade.market_type || '').toUpperCase();
        if (mType === 'COMMODITY') {
            mType = 'COMEX';
        }
        const clientConfig = JSON.parse(trade.config_json || '{}');

        // Lot size calculation
        if (mType === 'MCX') {
            const { getMcxBaseScrip, MCX_LOT_SIZES } = require('../utils/symbolHelper');
            const base = getMcxBaseScrip(trade.symbol);
            const symTrimmed = (trade.symbol || '').toUpperCase().replace(/\d+.*/, '');

            if (base && MCX_LOT_SIZES[base]) {
                lotSize = MCX_LOT_SIZES[base];
            } else if (MCX_LOT_SIZES[symTrimmed]) {
                lotSize = MCX_LOT_SIZES[symTrimmed];
            }
        }
        else if (mType === 'EQUITY' || mType === 'NSE' || mType === 'NFO' || mType === 'OPTIONS') {
            lotSize = 1;
            if (mType !== 'EQUITY') {
                try {
                    const [scripRows] = await connection.execute('SELECT lot_size FROM scrip_data WHERE symbol = ?', [trade.symbol]);
                    if (scripRows.length > 0) lotSize = parseFloat(scripRows[0].lot_size) || 1;
                } catch (e) { console.warn(`[TradeService] Error fetching ${mType} lot size:`, e.message); }
            }
        }
        else {
            try {
                const [scripRows] = await connection.execute(
                    'SELECT lot_size FROM scrip_data WHERE symbol = ?',
                    [trade.symbol]
                );
                if (scripRows.length > 0 && parseFloat(scripRows[0].lot_size) > 0) {
                    lotSize = parseFloat(scripRows[0].lot_size);
                } else {
                    lotSize = 1;
                }
            } catch (e) {
                lotSize = 1;
            }
        }

        let brokerage = 0;
        let swap = 0;
        let brokerSwapRate = 5;

        const calcBrokerage = (brokerageVal, brokerageType, qty, exitPrice, entryPrice, multiplier = 1) => {
            const rate = Math.abs(parseFloat(brokerageVal || 0));
            if (rate <= 0) return 0;

            const type = (brokerageType || 'PER_LOT').toUpperCase();
            let result = 0;

            if (type === 'PER_LOT' || type === 'PER LOT') {
                result = qty * rate;
            } else if (type === 'PER_CRORE' || type === 'PER CRORE') {
                const turnover = (parseFloat(entryPrice) + parseFloat(exitPrice)) * qty * multiplier;
                result = (turnover / 10000000) * rate;
            } else {
                result = qty * rate;
            }

            return Math.max(0, result);
        };

        let rawSymbol = (trade.symbol || '').toUpperCase();
        let cleanSymbol = rawSymbol.includes(':') ? rawSymbol.split(':')[1] : rawSymbol;
        let scripRate = undefined;

        if (mType === 'MCX') {
            const brokerageType = (clientConfig.mcxBrokerageType || 'per_crore').toLowerCase();
            if (brokerageType === 'per_lot') {
                const lotBrokerageMap = { ...clientConfig.brokerMcxBrokerage, ...clientConfig.mcxLotBrokerage };
                if (lotBrokerageMap[cleanSymbol] !== undefined) {
                    scripRate = parseFloat(lotBrokerageMap[cleanSymbol]);
                } else {
                    const sortedKeys = Object.keys(lotBrokerageMap).sort((a, b) => b.length - a.length);
                    for (const key of sortedKeys) {
                        if (cleanSymbol.startsWith(key.toUpperCase().replace(/\s+/g, ''))) {
                            scripRate = parseFloat(lotBrokerageMap[key]);
                            break;
                        }
                    }
                }
            }
        } else if (mType === 'EQUITY') {
            const equityMap = clientConfig.brokerEquityBrokerage || {};
            if (equityMap[cleanSymbol] !== undefined) {
                scripRate = parseFloat(equityMap[cleanSymbol]);
            } else {
                const sortedKeys = Object.keys(equityMap).sort((a, b) => b.length - a.length);
                for (const key of sortedKeys) {
                    if (cleanSymbol.startsWith(key.toUpperCase())) {
                        scripRate = parseFloat(equityMap[key]);
                        break;
                    }
                }
            }
        }

        if (scripRate !== undefined && scripRate > 0) {
            brokerage = (trade.qty) * scripRate;
        } else {
            const [segmentRows] = await connection.execute(
                'SELECT * FROM user_segments WHERE user_id = ? AND segment = ?',
                [trade.user_id, trade.market_type]
            );

            if (segmentRows.length > 0 && parseFloat(segmentRows[0].brokerage_value) > 0) {
                const seg = segmentRows[0];
                const qtyForBrokerageCalc = trade.qty;
                const multiplierForBrokerage = lotSize;

                let forcedType = (seg.brokerage_type || 'PER_LOT').toUpperCase();
                if (mType === 'EQUITY' || mType === 'NFO' || mType === 'OPTIONS') {
                    forcedType = 'PER_CRORE';
                }

                brokerage = calcBrokerage(seg.brokerage_value, forcedType, qtyForBrokerageCalc, exitPrice, trade.entry_price, multiplierForBrokerage);
            } else {
                const qtyForClientBrokerage = trade.qty;
                const multiplierForClientBrokerage = lotSize;

                if (mType === 'MCX') {
                    const brokerageType = (clientConfig.mcxBrokerageType || 'per_crore').toLowerCase();
                    let rate = parseFloat(clientConfig.mcxBrokerage || 0);
                    const calcType = brokerageType === 'per_lot' ? 'PER_LOT' : 'PER_CRORE';
                    brokerage = calcBrokerage(rate, calcType, qtyForClientBrokerage, exitPrice, trade.entry_price, multiplierForClientBrokerage);
                } else if (mType === 'EQUITY') {
                    const rate = parseFloat(clientConfig.brokerEquityBrokerage || clientConfig.equityBrokerage || 0);
                    brokerage = calcBrokerage(rate, 'PER_CRORE', qtyForClientBrokerage, exitPrice, trade.entry_price, multiplierForClientBrokerage);
                } else if (mType === 'OPTIONS') {
                    let rate = 0;
                    if (cleanSymbol.includes('NIFTY') || cleanSymbol.includes('BANKNIFTY')) {
                        rate = parseFloat(clientConfig.brokerOptionsIndexBrokerage || clientConfig.optionsIndexBrokerage || 20);
                    } else if (mType === 'MCX' || cleanSymbol.includes('MCX')) {
                        rate = parseFloat(clientConfig.brokerOptionsMcxBrokerage || clientConfig.optionsMcxBrokerage || 20);
                    } else {
                        rate = parseFloat(clientConfig.brokerOptionsEquityBrokerage || clientConfig.optionsEquityBrokerage || 20);
                    }
                    brokerage = calcBrokerage(rate, 'PER_CRORE', qtyForClientBrokerage, exitPrice, trade.entry_price, multiplierForClientBrokerage);
                } else if (mType === 'COMEX') {
                    const comexCfg = clientConfig.comexConfig || {};
                    const rate = parseFloat(comexCfg.brokerage || clientConfig.comexBrokerage || 0);
                    const bType = comexCfg.brokerageType || 'per_lot';
                    brokerage = calcBrokerage(rate, bType, qtyForClientBrokerage, exitPrice, trade.entry_price, multiplierForClientBrokerage);
                } else if (mType === 'FOREX') {
                    const forexCfg = clientConfig.forexConfig || {};
                    const rate = parseFloat(forexCfg.brokerage || clientConfig.forexBrokerage || 0);
                    const bType = forexCfg.brokerageType || 'per_lot';
                    brokerage = calcBrokerage(rate, bType, qtyForClientBrokerage, exitPrice, trade.entry_price, multiplierForClientBrokerage);
                } else if (mType === 'CRYPTO') {
                    const cryptoCfg = clientConfig.cryptoConfig || {};
                    const rate = parseFloat(cryptoCfg.brokerage || clientConfig.cryptoBrokerage || 0);
                    const bType = cryptoCfg.brokerageType || 'per_lot';
                    brokerage = calcBrokerage(rate, bType, qtyForClientBrokerage, exitPrice, trade.entry_price, multiplierForClientBrokerage);
                }
            }
        }

        if (trade.broker_id) {
            const [brokerRows] = await connection.execute('SELECT swap_rate FROM broker_shares WHERE user_id = ?', [trade.broker_id]);
            if (brokerRows.length > 0) brokerSwapRate = parseFloat(brokerRows[0].swap_rate || 5);

            const entryTime = new Date(trade.entry_time);
            const daysHeld = Math.ceil((exitTime - entryTime) / (1000 * 60 * 60 * 24));
            if ((trade.market_type === 'MCX' || trade.market_type === 'EQUITY') && daysHeld > 1) {
                const qtyForSwap = trade.actual_qty || trade.qty;
                swap = qtyForSwap * brokerSwapRate * (daysHeld - 1);
            }
        }

        return { brokerage, swap, lotSize };
    }

    /**
     * Executes FIFO netting against opposite open positions.
     */
    async executeNetting(userId, symbol, marketType, incomingTrade, connection) {
        console.log(`[executeNetting] Starting netting for user ${userId}, symbol ${symbol}, type ${incomingTrade.type}, qty ${incomingTrade.qty}`);

        const oppositeType = incomingTrade.type === 'BUY' ? 'SELL' : 'BUY';
        const [oppositeTrades] = await connection.execute(
            `SELECT t.*, cs.config_json, cs.broker_id 
             FROM trades t
             JOIN client_settings cs ON t.user_id = cs.user_id
             WHERE t.user_id = ? AND t.symbol = ? AND t.market_type = ? AND t.type = ? AND t.status = 'OPEN' AND t.is_pending = 0
             ORDER BY t.entry_time ASC`,
            [userId, symbol, marketType, oppositeType]
        );

        if (oppositeTrades.length === 0) {
            console.log(`[executeNetting] No opposite open trades found. No netting needed.`);
            return { netted: false, remainingQty: incomingTrade.qty };
        }

        let remainingQty = incomingTrade.qty;
        let totalPnl = 0;
        let totalBrokerage = 0;
        let totalSwap = 0;

        const { getIo } = require('../config/socket');
        const io = getIo();

        for (const oppositeTrade of oppositeTrades) {
            if (remainingQty <= 0) break;

            const closeQty = Math.min(oppositeTrade.qty, remainingQty);
            const exitPrice = incomingTrade.entry_price;
            const exitTime = new Date();

            const calcRes = await this.calculateBrokerageAndSwapForTrade(
                { ...oppositeTrade, qty: closeQty },
                exitPrice,
                exitTime,
                connection
            );
            const lotSize = calcRes.lotSize;
            
            let pnl = 0;
            const commodityLotService = require('./CommodityLotService');
            if (commodityLotService.isCommodityScrip(oppositeTrade.symbol, oppositeTrade.market_type)) {
                const calc = commodityLotService.calculatePnL(oppositeTrade.symbol, oppositeTrade.type, oppositeTrade.entry_price, exitPrice, closeQty);
                pnl = calc.pnlInr;
            } else {
                const qtyForPnl = closeQty * lotSize;
                if (oppositeTrade.type === 'BUY') {
                    pnl = (exitPrice - oppositeTrade.entry_price) * qtyForPnl;
                } else {
                    pnl = (oppositeTrade.entry_price - exitPrice) * qtyForPnl;
                }
            }

            const brokerage = calcRes.brokerage;
            const swap = calcRes.swap;
            const balanceChange = pnl - brokerage - swap;

            totalPnl += pnl;
            totalBrokerage += brokerage;
            totalSwap += swap;

            console.log(`[executeNetting] Matching with opposite trade #${oppositeTrade.id} (qty: ${oppositeTrade.qty}). Closing: ${closeQty}, P&L: ${pnl}, Brokerage: ${brokerage}, Swap: ${swap}`);

            if (oppositeTrade.qty > remainingQty) {
                // PARTIAL CLOSE of the opposite open trade
                const remQty = oppositeTrade.qty - closeQty;
                const remRatio = remQty / oppositeTrade.qty;

                await connection.execute(
                    `UPDATE trades 
                     SET qty = ?, qty_input = qty_input * ?, actual_qty = actual_qty * ?, turnover = turnover * ?, margin_used = margin_used * ?
                     WHERE id = ?`,
                    [
                        remQty,
                        remRatio,
                        remRatio,
                        remRatio,
                        remRatio,
                        oppositeTrade.id
                    ]
                );

                const ratio = closeQty / oppositeTrade.qty;
                const closedByValue = 'TRADER';
                
                await connection.execute(
                    `INSERT INTO trades 
                     (user_id, symbol, type, order_type, qty, entry_price, exit_price, margin_used, is_pending, market_type, status, trade_ip, created_by, trade_type, margin_type,
                      qty_input, actual_qty, lot_size_at_entry, trade_mode, turnover, leverage_used, equity_units_mode, entry_time, exit_time, pnl, brokerage, swap, closed_by, close_remark)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'CLOSED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Netted (FIFO)')`,
                    [
                        oppositeTrade.user_id,
                        oppositeTrade.symbol,
                        oppositeTrade.type,
                        oppositeTrade.order_type,
                        closeQty,
                        oppositeTrade.entry_price,
                        exitPrice,
                        (parseFloat(oppositeTrade.margin_used) * ratio).toFixed(2),
                        oppositeTrade.market_type,
                        oppositeTrade.trade_ip,
                        oppositeTrade.created_by,
                        oppositeTrade.trade_type,
                        oppositeTrade.margin_type,
                        oppositeTrade.qty_input * ratio,
                        oppositeTrade.actual_qty * ratio,
                        oppositeTrade.lot_size_at_entry,
                        oppositeTrade.trade_mode,
                        (oppositeTrade.turnover * ratio).toFixed(2),
                        oppositeTrade.leverage_used,
                        oppositeTrade.equity_units_mode,
                        oppositeTrade.entry_time,
                        exitTime,
                        pnl,
                        brokerage,
                        swap,
                        closedByValue
                    ]
                );

                await connection.execute(
                    'UPDATE users SET balance = balance + ? WHERE id = ?',
                    [balanceChange, userId]
                );

                try {
                    if (io) {
                        io.to(`user:${userId}`).emit('trade_update', {
                            id: oppositeTrade.id,
                            qty: remQty,
                            status: 'OPEN'
                        });
                        io.to(`user:${userId}`).emit('notification', {
                            message: `Position partially netted: closed ${closeQty} @ ₹${exitPrice}, remaining: ${remQty}`,
                            type: 'TRADE_UPDATE',
                            tradeId: oppositeTrade.id
                        });
                    }
                } catch (socketErr) {
                    console.error('[executeNetting] Socket partial close emit error:', socketErr.message);
                }

                remainingQty = 0;
            } else {
                // FULL CLOSE of the opposite open trade
                const closedByValue = 'TRADER';

                await connection.execute(
                    `UPDATE trades 
                     SET status = 'CLOSED', exit_price = ?, exit_time = ?, pnl = ?, brokerage = ?, swap = ?, closed_by = ?, close_remark = 'Netted (FIFO)'
                     WHERE id = ?`,
                    [
                        exitPrice,
                        exitTime,
                        pnl,
                        brokerage,
                        swap,
                        closedByValue,
                        oppositeTrade.id
                    ]
                );

                await connection.execute(
                    'UPDATE users SET balance = balance + ? WHERE id = ?',
                    [balanceChange, userId]
                );

                try {
                    if (io) {
                        io.to(`user:${userId}`).emit('trade_update', {
                            id: oppositeTrade.id,
                            status: 'CLOSED'
                        });
                        io.to(`user:${userId}`).emit('notification', {
                            message: `Position netted: closed ${oppositeTrade.qty} of ${oppositeType} @ ₹${exitPrice}`,
                            type: 'ORDER_CLOSED',
                            tradeId: oppositeTrade.id
                        });
                    }
                } catch (socketErr) {
                    console.error('[executeNetting] Socket full close emit error:', socketErr.message);
                }

                remainingQty -= oppositeTrade.qty;
            }

            const execOrderId = incomingTrade.id || Math.floor(10000000 + Math.random() * 90000000);
            const comPayload = {
                execOrderId,
                parentTradeId: oppositeTrade.id,
                execPrice: exitPrice,
                parentPrice: oppositeTrade.entry_price,
                qty: closeQty
            };
            await logAction(incomingTrade.created_by || userId, 'CLOSE_TRADE', 'trades', buildTradeLog('COM1_CLOSED', comPayload));
            await logAction(incomingTrade.created_by || userId, 'CLOSE_TRADE', 'trades', buildTradeLog('COM2_CLOSED', comPayload));
            await logAction(incomingTrade.created_by || userId, 'CLOSE_TRADE', 'trades', buildTradeLog('COM3_CLOSED', comPayload));
        }

        console.log(`[executeNetting] Netting complete. Remaining quantity for incoming order: ${remainingQty}`);

        return { netted: true, remainingQty, totalPnl, totalBrokerage, totalSwap };
    }

    /**
     * Executes netting for a pending order when it gets active.
     */
    async executePendingOrderNetting(tradeId, currentPrice) {
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            const [tradeRows] = await connection.execute(
                `SELECT t.*, cs.config_json, cs.broker_id 
                 FROM trades t
                 JOIN client_settings cs ON t.user_id = cs.user_id
                 WHERE t.id = ?`,
                [tradeId]
            );

            if (tradeRows.length === 0) throw new Error('Pending trade not found');
            const trade = tradeRows[0];
            
            trade.entry_price = currentPrice;

            const nettingRes = await this.executeNetting(
                trade.user_id,
                trade.symbol,
                trade.market_type,
                trade,
                connection
            );

            if (nettingRes.netted) {
                const remainingQty = nettingRes.remainingQty;
                if (remainingQty === 0) {
                    await connection.execute(
                        'DELETE FROM trades WHERE id = ?',
                        [tradeId]
                    );
                    console.log(`[executePendingOrderNetting] Pending trade #${tradeId} fully consumed by netting and deleted.`);
                } else {
                    const ratio = remainingQty / trade.qty;
                    await connection.execute(
                        `UPDATE trades 
                         SET is_pending = 0, executed_from_pending = 1, entry_time = NOW(), entry_price = ?,
                             qty = ?, qty_input = qty_input * ?, actual_qty = actual_qty * ?, turnover = turnover * ?, margin_used = margin_used * ?
                         WHERE id = ?`,
                        [
                            currentPrice,
                            remainingQty,
                            ratio,
                            ratio,
                            ratio,
                            ratio,
                            tradeId
                        ]
                    );
                    console.log(`[executePendingOrderNetting] Pending trade #${tradeId} partially consumed. Remaining: ${remainingQty}.`);
                }
            } else {
                await connection.execute(
                    'UPDATE trades SET is_pending = 0, executed_from_pending = 1, entry_time = NOW(), entry_price = ? WHERE id = ?',
                    [currentPrice, tradeId]
                );
                console.log(`[executePendingOrderNetting] Pending trade #${tradeId} activated without netting.`);
            }

            await syncPaperPosition(trade.user_id, trade.symbol, connection);

            await connection.commit();

            try {
                await invalidateCache(`m2m_${trade.user_id}_TRADER`);
                await invalidateCache(`m2m_${trade.user_id}_BROKER`);
                await invalidateCache(`m2m_${trade.user_id}_SUPERADMIN`);
            } catch (_) { }

            return { success: true, nettingRes };
        } catch (err) {
            await connection.rollback();
            console.error(`[executePendingOrderNetting] Error:`, err.message);
            throw err;
        } finally {
            connection.release();
        }
    }

    /**
     * Closes all open positions and cancels all pending orders for a user.
     * Used for RMS Auto-Squaring off.
     */
    async closeAllUserTrades(userId, requesterId = 0, reason = 'RMS_AUTO_CLOSE', remark = null) {
        const [trades] = await db.execute(
            "SELECT id FROM trades WHERE user_id = ? AND status = 'OPEN'",
            [userId]
        );

        const results = [];
        for (const trade of trades) {
            try {
                const res = await this.closeTrade(trade.id, null, requesterId, null, remark);
                results.push({ id: trade.id, success: true, ...res });
            } catch (err) {
                console.error(`[TradeService] Failed to auto-close trade #${trade.id}:`, err.message);
                results.push({ id: trade.id, success: false, error: err.message });
            }
        }

        if (results.length > 0) {
            await logAction(requesterId, reason, 'users', `Mass squared off ${results.length} trades for user #${userId}`);
        }

        return results;
    }
}

module.exports = new TradeService();
