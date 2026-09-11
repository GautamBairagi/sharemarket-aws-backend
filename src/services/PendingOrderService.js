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
 * Uses price-crossing logic:
 * - BUY:  previousPrice < limitPrice && currentPrice >= limitPrice
 * - SELL: previousPrice > limitPrice && currentPrice <= limitPrice
 * Keeps entry_price / Avg Price equal to limitPrice.
 */
const monitorPendingOrders = async () => {
    try {
        // Fetch all trades that are OPEN and PENDING (is_pending = 1)
        const [pendingTrades] = await db.execute(
            `SELECT t.id, t.user_id, t.symbol, t.type, t.entry_price, t.qty, t.market_type, t.last_market_price, u.username, u.balance 
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
                const tradeType = (trade.type || '').toUpperCase();

                // Retrieve last recorded market price for this pending trade
                const previousPrice = trade.last_market_price !== null && trade.last_market_price !== undefined
                    ? parseFloat(trade.last_market_price)
                    : null;

                if (previousPrice === null) {
                    // Initialize last_market_price for legacy/newly placed trades if not set yet
                    await db.execute('UPDATE trades SET last_market_price = ? WHERE id = ?', [currentPrice, trade.id]);
                    continue;
                }

                let shouldExecute = false;

                // 🎯 PRICE-CROSSING TRIGGER LOGIC:
                // - BUY:  previousPrice < limitPrice AND currentPrice >= limitPrice
                // - SELL: previousPrice > limitPrice AND currentPrice <= limitPrice
                if (tradeType === 'BUY' && previousPrice < limitPrice && currentPrice >= limitPrice) {
                    shouldExecute = true;
                } else if (tradeType === 'SELL' && previousPrice > limitPrice && currentPrice <= limitPrice) {
                    shouldExecute = true;
                }

                if (!shouldExecute) {
                    // Price hasn't crossed limit yet; update last_market_price for next tick comparison
                    await db.execute('UPDATE trades SET last_market_price = ? WHERE id = ?', [currentPrice, trade.id]);
                    continue;
                }

                console.log(`[PendingOrder] 🚀 EXECUTING Trade #${trade.id} (${trade.symbol}) - Limit: ₹${limitPrice}, Prev: ₹${previousPrice}, Curr: ₹${currentPrice}`);

                // Execute pending order netting using limitPrice so entry_price/Avg Price = limitPrice
                const res = await tradeService.executePendingOrderNetting(trade.id, limitPrice, currentPrice);

                // Update last_market_price on executed trade
                await db.execute('UPDATE trades SET last_market_price = ? WHERE id = ?', [currentPrice, trade.id]);

                // Log execution
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

                // Socket notification
                const io = getIo();
                if (io) {
                    const remainingQty = res.nettingRes?.remainingQty;
                    if (remainingQty === undefined || remainingQty > 0) {
                        io.to(`user:${trade.user_id}`).emit('notification', {
                            message: `Pending ${trade.type} order for ${cleanSymbol} executed successfully at limit ₹${limitPrice}${remainingQty !== undefined ? ` (remaining open: ${remainingQty})` : ''}`,
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
            } catch (tradeErr) {
                console.error(`[PendingOrder] Error processing trade #${trade.id}:`, tradeErr.message);
            }
        }
    } catch (err) {
        console.error('[PendingOrder] Monitor error:', err.message);
    }
};

let isMonitoring = false;

const startPendingOrderMonitoring = () => {
    setInterval(() => {
        if (isMonitoring) return;
        isMonitoring = true;
        monitorPendingOrders()
            .finally(() => { isMonitoring = false; });
    }, 1000); // Check every 1s interval

    console.log('[PendingOrder] 🚀 Pending order matching service started (1s interval)');
};

module.exports = { startPendingOrderMonitoring };
