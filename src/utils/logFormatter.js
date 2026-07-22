/**
 * Centralized Log Formatter for Action Ledger
 * Ensures all activity logs are formatted exactly like the client's trading platform.
 */

const formatSide = (side) => {
    if (!side) return 'Buy Order';
    const s = side.toString().toUpperCase();
    if (s === 'BUY' || s === 'LONG' || s.startsWith('BUY')) return 'Buy Order';
    if (s === 'SELL' || s === 'SHORT' || s.startsWith('SELL')) return 'Sell Order';
    return side;
};

const buildTradeLog = (type, payload) => {
    const {
        username = '',
        userId = '',
        side = '',
        lots = '0',
        qty = '0',
        symbol = '',
        price = '0',
        availableFunds = '0',
        requiredFunds = '0',
        limitPrice = '0',
        condition = '1',
        execOrderId = '',
        parentTradeId = '',
        execPrice = '0',
        parentPrice = '0',
        adminUser = 'admin'
    } = payload;

    switch (type) {
        case 'MARKET_EXECUTED':
            return `${username} (${userId}) ${formatSide(side)} of ${lots} lots of ${symbol} executed successfully at Rs.${price}. Funds available=${availableFunds} . Funds Required=${requiredFunds}`;

        case 'EXIT_EXECUTED':
            return `${username} (${userId}) ${formatSide(side)} of ${lots} lots of ${symbol} executed successfully at Rs.${price}. Funds available=${availableFunds} . Funds Required=${requiredFunds} (EXIT)`;

        case 'LIMIT_MATCHED':
            return `${username} (${userId}) ${formatSide(side)} of ${lots} lots of ${symbol} executed successfully. Limit Order Price of Rs.${limitPrice} Matched.`;

        case 'PENDING_ABOVE':
            return `${username} (${userId}) ${formatSide(side)} of ${lots} lots of ${symbol} scheduled to execute Above Rs.${price}. (Pending)`;

        case 'PENDING_BELOW':
            return `${username} (${userId}) ${formatSide(side)} of ${lots} lots of ${symbol} scheduled to execute Below Rs.${price}. (Pending)`;

        case 'ORDER_CANCELLED':
            return `${username} (${userId}) ${formatSide(side)} of ${lots} lots of ${symbol} cancelled by trader.`;

        case 'STOPLOSS_SCHEDULED':
            return `${username} (${userId}) ${symbol} stoploss of ${lots}(qty:${qty}) is scheduled to execute ${condition} ${price}`;

        case 'COM1_CLOSED':
            return `COM1: Trade ${execOrderId} closed. Order ID: ${execOrderId}. Parent: ${parentTradeId}. Exec. Price: ${execPrice}. Parent Price: ${parentPrice}. Parent & Exec. Qty: ${qty}.`;

        case 'COM2_CLOSED':
            return `COM2: Trade ${parentTradeId} closed. Order ID: ${execOrderId}. Parent: ${parentTradeId}. Exec. Price: ${execPrice}. Parent Price: ${parentPrice}. Parent & Exec. Qty: ${qty}.`;

        case 'COM3_CLOSED':
            return `COM3: Trade ${parentTradeId} closed. Parent: ${parentTradeId}. Exec. Price: ${execPrice}. Parent Price: ${parentPrice}. Parent & Exec. Qty: ${qty}.`;

        case 'ORDER_DELETED':
            return `${username} (${userId}) ${formatSide(side)} of ${lots} lots of ${symbol} deleted by ${adminUser}.`;

        case 'ORDER_RESTORED':
            return `${username} (${userId}) ${formatSide(side)} of ${lots} lots of ${symbol} restored by ${adminUser}.`;

        case 'ORDER_UPDATED':
            return `${username} (${userId}) ${formatSide(side)} of ${lots} lots of ${symbol} updated by ${adminUser}.`;

        default:
            return '';
    }
};

module.exports = {
    buildTradeLog
};
