const db = require('../config/db');
const marketDataService = require('./MarketDataService');
const { getIo } = require('../config/socket');
const { logAction } = require('../controllers/systemController');
const { getLotSize } = require('../utils/symbolHelper');
const { buildTradeLog } = require('../utils/logFormatter');

const tradeService = require('./TradeService');

/**
 * Pending Order Matching Service
 * Periodically checks if pending orders (is_pending = 1) match live prices.
 * If matched, moves trade to active (is_pending = 0).
 */
const monitorPendingOrders = async () => {
    try {
        // Fetch all trades that are OPEN and PENDING (is_pending = 1)
        const [pendingTrades] = await db.execute(
            `SELECT t.id, t.user_id, t.symbol, t.type, t.entry_price, t.qty, t.market_type, u.username, u.balance 
             FROM trades t 
             JOIN users u ON t.user_id = u.id 
             WHERE t.status = 'OPEN' AND t.is_pending = 1`
        );

        if (pendingTrades.length === 0) return;

        for (const trade of pendingTrades) {
            try {
                // Normalize symbol for matching with live data
                const cleanSymbol = trade.symbol.includes(':') ? trade.symbol.split(':')[1] : trade.symbol;
                const marketType = (trade.market_type || 'MCX').toUpperCase();

                // Determine the correct prefix for MarketDataService lookup
                let prefix = 'NSE';
                if (marketType === 'MCX') prefix = 'MCX';
                else if (marketType === 'NFO' || marketType === 'OPTIONS') prefix = 'NFO';
                else if (marketType === 'CRYPTO') prefix = 'CRYPTO';
                else if (marketType === 'FOREX') prefix = 'FOREX';

                let currentPrice = null;
                const possibleSymbols = [trade.symbol, `${prefix}:${cleanSymbol}`, cleanSymbol];

                for (const s of possibleSymbols) {
                    const data = marketDataService.getPrice(s);
                    if (data && data.ltp) {
                        currentPrice = data.ltp;
                        break;
                    }
                }

                if (!currentPrice) continue;

                const limitPrice = parseFloat(trade.entry_price);
                let shouldExecute = false;

                // 🎯 REVISED EXECUTION LOGIC:
                // User wants strict matching: Execute ONLY if market price hits the exact limit price.
                // This prevents immediate execution when the current price is already "better" than the limit.
                // We use a very small tolerance (0.0001% or 0.05 points) to handle decimal precision.
                const priceDiff = Math.abs(currentPrice - limitPrice);
                const tolerance = Math.max(limitPrice * 0.000001, 0.05);

                if (priceDiff <= tolerance) {
                    shouldExecute = true;
                }

                if (shouldExecute) {
                    console.log(`[PendingOrder] 🚀 EXECUTING Trade #${trade.id} (${trade.symbol}) at ${currentPrice} (Limit: ${limitPrice})`);

                    // Call TradeService to handle netting and execution
                    const res = await tradeService.executePendingOrderNetting(trade.id, currentPrice);

                    // Log the execution
                    const lotSize = getLotSize(trade.symbol, trade.market_type);
                    const lotsVal = trade.qty / lotSize;
                    const matchedLog = buildTradeLog('LIMIT_MATCHED', {
                        username: trade.username,
                        userId: trade.user_id,
                        side: trade.type,
                        lots: lotsVal,
                        symbol: trade.symbol,
                        limitPrice: limitPrice
                    });
                    await logAction(trade.user_id, 'EXECUTE_PENDING', 'trades', matchedLog);

                    // Notify user via Socket
                    const io = getIo();
                    if (io) {
                        const remainingQty = res.nettingRes?.remainingQty;
                        if (remainingQty === undefined || remainingQty > 0) {
                            io.to(`user:${trade.user_id}`).emit('notification', {
                                message: `Pending ${trade.type} order for ${cleanSymbol} executed successfully at ₹${currentPrice}${remainingQty !== undefined ? ` (remaining open: ${remainingQty})` : ''}`,
                                type: 'ORDER_EXECUTED',
                                tradeId: trade.id
                            });

                            io.to(`user:${trade.user_id}`).emit('trade_update', {
                                id: trade.id,
                                is_pending: 0,
                                status: 'OPEN',
                                qty: remainingQty
                            });
                        }
                    }
                }
            } catch (tradeErr) {
                console.error(`[PendingOrder] Error processing trade #${trade.id}:`, tradeErr.message);
            }
        }
    } catch (err) {
        console.error('[PendingOrder] Monitor error:', err.message);
    }
};

let isMonitoring = false;
/**
 * Start the monitoring service
 * Checks every 3 seconds for price matches
 */
const startPendingOrderMonitoring = () => {
    setInterval(() => {
        if (isMonitoring) return;
        isMonitoring = true;
        monitorPendingOrders()
            .finally(() => { isMonitoring = false; });
    }, 3000);

    console.log('[PendingOrder] 🚀 Pending order matching service started (3s interval)');
};

module.exports = { startPendingOrderMonitoring };
