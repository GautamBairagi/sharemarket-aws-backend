const cron = require('node-cron');
const db = require('../config/db');
const { getMcxBaseScrip } = require('../utils/symbolHelper');
const MarginUtils = require('../utils/MarginUtils');
const MarginService = require('./MarginService');

/**
 * Helper to calculate brokerage based on type
 */
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

const startExpirySquareOffJob = () => {
    cron.schedule('* * * * *', async () => {
        try {
            const marketDataService = require('./MarketDataService');
            const kiteService = require('../utils/kiteService');
            const tradeService = require('./TradeService');

            const [rules] = await db.execute('SELECT * FROM expiry_rules');
            if (!rules.length) return;

            // ⚠️ TIMEZONE FIX: Railway runs in UTC. Convert to IST (UTC+5:30) before comparing.
            const now = new Date();
            const istNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
            const currentH = istNow.getHours();
            const currentM = istNow.getMinutes();
            const currentTimeStr = `${currentH.toString().padStart(2, '0')}:${currentM.toString().padStart(2, '0')}`;

            if (currentM % 10 === 0) { // Log every 10 mins to avoid spam
                console.log(`[ExpirySquareOff] 🕒 Cron running at ${currentTimeStr} IST`);
            }
            console.log(`[ExpirySquareOff] ⏰ IST Time: ${String(currentH).padStart(2, '0')}:${String(currentM).padStart(2, '0')} | UTC: ${now.toISOString()}`);

            const [allUsers] = await db.execute('SELECT id, parent_id FROM users');

            for (const rule of rules) {
                if (rule.auto_square_off !== 'Yes') continue;

                const [nseH, nseM] = (rule.square_off_time || '15:20').split(':');
                const [mcxH, mcxM] = (rule.mcx_square_off_time || '23:30').split(':');
                const [cryptoH, cryptoM] = (rule.crypto_square_off_time || '23:30').split(':');
                const [forexH, forexM] = (rule.forex_square_off_time || '23:30').split(':');
                const [comexH, comexM] = (rule.comex_square_off_time || '23:30').split(':');

                const isNseTriggered = parseInt(nseH) === currentH && parseInt(nseM) === currentM;
                const isMcxTriggered = parseInt(mcxH) === currentH && parseInt(mcxM) === currentM;
                const isCryptoTriggered = parseInt(cryptoH) === currentH && parseInt(cryptoM) === currentM;
                const isForexTriggered = parseInt(forexH) === currentH && parseInt(forexM) === currentM;
                const isComexTriggered = parseInt(comexH) === currentH && parseInt(comexM) === currentM;

                if (!isNseTriggered && !isMcxTriggered && !isCryptoTriggered && !isForexTriggered && !isComexTriggered) continue;

                console.log(`[ExpirySquareOff] 🕒 Square-off reached for Admin #${rule.user_id}`);

                const descendantIds = [];
                const queue = [rule.user_id];
                const processed = new Set();
                while (queue.length > 0) {
                    const pid = queue.shift();
                    if (processed.has(pid)) continue;
                    processed.add(pid);
                    const children = allUsers.filter(u => u.parent_id === pid).map(u => u.id);
                    descendantIds.push(...children);
                    queue.push(...children);
                }

                if (!descendantIds.length) continue;

                const [allOpenTrades] = await db.execute(
                    `SELECT t.*, u.balance, cs.config_json
                     FROM trades t
                     JOIN users u ON t.user_id = u.id
                     JOIN client_settings cs ON t.user_id = cs.user_id
                     WHERE t.status = 'OPEN' AND t.is_pending = 0
                     AND t.user_id IN (${descendantIds.join(',')})`
                );

                for (const trade of allOpenTrades) {
                    try {
                        const userConfig = JSON.parse(trade.config_json || '{}');
                        const mType = (trade.market_type || '').toUpperCase();
                        const isNSE = ['NSE', 'EQUITY', 'NIFTY', 'OPTIONS', 'NFO', 'INDEX', 'INDICES', 'NSE_INDEX'].includes(mType) || (trade.symbol || '').toUpperCase().includes('NIFTY');
                        const isMCX = mType === 'MCX';
                        const isCrypto = mType === 'CRYPTO';
                        const isForex = mType === 'FOREX';
                        const isComex = mType === 'COMEX';
                        const isCommodity = mType === 'COMMODITY';

                        if (!isNSE && !isMCX && !isCrypto && !isForex && !isComex && !isCommodity) continue; // Skip other segments for now

                        // Check segment specific trigger (commodity squares off with forex time)
                        if (isNSE && !isNseTriggered) continue;
                        if (isMCX && !isMcxTriggered) continue;
                        if (isCrypto && !isCryptoTriggered) continue;
                        if (isForex && !isForexTriggered) continue;
                        if (isComex && !isComexTriggered) continue;
                        if (isCommodity && !isComexTriggered) continue; 

                        const holdingMarginRequired = MarginUtils.calculateTotalRequiredHoldingMargin([trade], userConfig);

                        console.log(`[ExpirySquareOff] 📊 Checking Trade #${trade.id} (${trade.symbol}): Required: ${holdingMarginRequired.toFixed(2)}, Available: ${trade.balance}`);

                        // ─── FINAL DECISION: SHOULD WE CLOSE? ──────────────────────────
                        // Only close if available balance is less than required margin
                        if (parseFloat(trade.balance) < holdingMarginRequired) {
                            try {
                                console.log(`[ExpirySquareOff] 🚨 Closing trade #${trade.id} (${trade.symbol}) due to insufficient margin: Bal=${trade.balance} < Req=${holdingMarginRequired.toFixed(2)}`);
                                const result = await tradeService.closeTrade(trade.id, null, 0, null, 'Insufficient Holding Margin');
                                if (result.success) {
                                    console.log(`[ExpirySquareOff] ✅ Squared off trade #${trade.id} (${trade.symbol}) @ ${result.exitPrice || 'market'}`);
                                }
                            } catch (closeErr) {
                                console.error(`[ExpirySquareOff] ❌ Failed to auto-close trade #${trade.id}:`, closeErr.message);
                            }
                        }
                    } catch (err) {
                        console.error(`[ExpirySquareOff] Error trade #${trade.id}:`, err.message);
                    }
                }
            }
        } catch (err) {
            console.error('[ExpirySquareOff] Cron error:', err.message);
        }
    });
};

module.exports = { startExpirySquareOffJob };
