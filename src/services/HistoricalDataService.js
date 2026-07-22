const kiteAuthService = require('./KiteAuthService');

/**
 * Service to fetch historical data from Zerodha for charts and analysis.
 */
class HistoricalDataService {
    
    async getHistoricalData(userId, instrumentToken, interval, from, to) {
        try {
            const kite = await kiteAuthService.getKiteInstance(userId);
            
            // Format dates if they are strings
            const fromDate = typeof from === 'string' ? from : from.toISOString().split('T')[0];
            const toDate = typeof to === 'string' ? to : to.toISOString().split('T')[0];

            console.log(`📊 Fetching Historical Data: ${instrumentToken} (${interval}) from ${fromDate} to ${toDate}`);
            
            const data = await kite.getHistoricalData(instrumentToken, interval, fromDate, toDate);
            return data;
        } catch (err) {
            console.error('Historical data fetch failed:', err.message);
            throw err;
        }
    }

    async getQuote(userId, instruments) {
        try {
            const kite = await kiteAuthService.getKiteInstance(userId);
            return await kite.getQuote(instruments);
        } catch (err) {
            console.error('Quote fetch failed:', err.message);
            throw err;
        }
    }
}

module.exports = new HistoricalDataService();
