const db = require('../config/db');

/**
 * Alert Monitor Service
 * Checks active alerts against current prices from mockEngine
 * Triggered via price updates from mockEngine
 */

class AlertMonitor {
    constructor() {
        this.triggeredAlerts = new Set(); // Track already-triggered alerts to prevent duplicates
        this.io = null; // Socket.io instance
        this.alertsCache = null;
        this.alertsCacheTime = 0;
        this.fetchingPromise = null;
    }

    /**
     * Initialize with socket.io instance
     */
    init(io) {
        this.io = io;
        console.log('✅ Alert Monitor initialized');
    }

    async getActiveAlerts() {
        const now = Date.now();
        if (this.alertsCache && (now - this.alertsCacheTime < 5000)) {
            return this.alertsCache;
        }

        if (this.fetchingPromise) {
            return this.fetchingPromise;
        }

        this.fetchingPromise = (async () => {
            try {
                const [allAlerts] = await db.execute(
                    `SELECT id, user_id, symbol, type, target_price, status
                     FROM alerts
                     WHERE status = 'active'`
                );
                this.alertsCache = allAlerts;
                this.alertsCacheTime = Date.now();
                return allAlerts;
            } catch (err) {
                console.error('[AlertMonitor] Error fetching active alerts:', err.message);
                return this.alertsCache || [];
            } finally {
                this.fetchingPromise = null;
            }
        })();

        return this.fetchingPromise;
    }

    /**
     * Check all active alerts against a price update
     * Called when price updates come from mockEngine
     */
    async checkAlerts(symbol, ltp) {
        if (!ltp || ltp <= 0) return;

        try {
            // ✅ Normalize symbol for matching (remove spaces, standardize)
            const cleanSymbol = symbol.toUpperCase().trim().replace(/\s+/g, '');


            // Fetch ALL active alerts from cache
            const allAlerts = await this.getActiveAlerts();

            // ✅ Filter alerts that match this symbol (fuzzy match with base symbol support)
            const matchingAlerts = allAlerts.filter(alert => {
                const alertCleanSymbol = alert.symbol.toUpperCase().trim().replace(/\s+/g, '');

                // Exact or prefix match
                let isMatch = alertCleanSymbol === cleanSymbol ||
                       alertCleanSymbol.startsWith(cleanSymbol) ||
                       cleanSymbol.startsWith(alertCleanSymbol);

                // ✅ Also check base symbols (e.g., "GOLD26JUN" matches "GOLD")
                if (!isMatch) {
                    const alertBaseSymbol = alertCleanSymbol.replace(/\d+[A-Z]*$/g, '').trim();
                    const incomingBaseSymbol = cleanSymbol.replace(/\d+[A-Z]*$/g, '').trim();

                    isMatch = alertBaseSymbol === incomingBaseSymbol ||
                             alertBaseSymbol === cleanSymbol ||
                             alertCleanSymbol === incomingBaseSymbol;
                }

                if (isMatch) {
                    // console.log(`[AlertMonitor] ✅ MATCH...`);
                }
                return isMatch;
            });

            const alerts = matchingAlerts;

            if (!alerts || alerts.length === 0) {
                // No alerts found
                return;
            }

            // Check each alert
            for (const alert of alerts) {
                const targetPrice = parseFloat(alert.target_price);
                const ltpAsNumber = parseFloat(ltp); // ✅ Ensure LTP is also a number
                let shouldTrigger = false;
                let triggerReason = '';

                // Check condition
                if (alert.type === 'above' && ltpAsNumber >= targetPrice) {
                    shouldTrigger = true;
                    triggerReason = `${symbol} ${alert.type} ₹${targetPrice} (LTP: ₹${ltpAsNumber})`;
                    console.log(`✅ TRIGGER: ${triggerReason}`);
                } else if (alert.type === 'below' && ltpAsNumber <= targetPrice) {
                    shouldTrigger = true;
                    triggerReason = `${symbol} ${alert.type} ₹${targetPrice} (LTP: ₹${ltpAsNumber})`;
                    console.log(`✅ TRIGGER: ${triggerReason}`);
                }

                // Update alert if triggered
                if (shouldTrigger && !this.triggeredAlerts.has(alert.id)) {
                    this.triggeredAlerts.add(alert.id);

                    // Immediately remove from active cache so it doesn't get evaluated in subsequent checks
                    if (this.alertsCache) {
                        this.alertsCache = this.alertsCache.filter(a => a.id !== alert.id);
                    }

                    console.log(`[AlertMonitor] 🔔 Triggering alert #${alert.id} for user #${alert.user_id}`);

                    // Update in database
                    await db.execute(
                        'UPDATE alerts SET status = ?, triggered_at = NOW() WHERE id = ?',
                        ['triggered', alert.id]
                    );

                    // Notify user via socket
                    if (this.io) {
                        this.io.to(`user:${alert.user_id}`).emit('alert_triggered', {
                            id: alert.id,
                            symbol: alert.symbol,
                            type: alert.type,
                            targetPrice: targetPrice,
                            currentPrice: ltp,
                            message: `Price alert! ${symbol} reached ₹${ltp} (${alert.type} ₹${targetPrice})`
                        });

                        console.log(`📢 Notification sent to user #${alert.user_id} for alert #${alert.id}`);
                    }
                } else if (shouldTrigger && this.triggeredAlerts.has(alert.id)) {
                    // Already triggered
                } else {
                    // Condition not met yet
                }
            }
        } catch (err) {
            console.error('❌ Alert check error:', err.message);
        }
    }

    /**
     * Invalidate the active alerts cache to force a reload on the next check
     */
    invalidateCache() {
        this.alertsCache = null;
        this.alertsCacheTime = 0;
    }

    /**
     * Reset triggered alerts when they're manually reset
     */
    resetAlert(alertId) {
        this.triggeredAlerts.delete(alertId);
        this.invalidateCache();
    }

    /**
     * Remove alert from tracking
     */
    removeAlert(alertId) {
        this.triggeredAlerts.delete(alertId);
        this.invalidateCache();
    }
}

module.exports = new AlertMonitor();
