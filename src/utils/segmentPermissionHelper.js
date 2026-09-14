const db = require('../config/db');

/**
 * Returns allowed trading segments for a user based on client_settings.config_json and user_segments.
 */
async function getClientAllowedSegments(userId, userRole) {
    const defaultAllAllowed = {
        MCX_FUT: true,
        MCX_OPT: true,
        NFO_FUT: true,
        NFO_OPT: true,
        CRYPTO: true,
        FOREX: true,
        COMMODITY: true
    };

    if (!userId || userRole === 'SUPERADMIN' || userRole === 'ADMIN') {
        return defaultAllAllowed;
    }

    try {
        const [rows] = await db.execute(
            'SELECT config_json FROM client_settings WHERE user_id = ?',
            [userId]
        );

        if (rows.length && rows[0].config_json) {
            let config = {};
            try {
                config = JSON.parse(rows[0].config_json);
            } catch (_) {}

            const allowed = {
                MCX_FUT: !!(config.mcxTrading),
                MCX_OPT: !!(config.mcxOptionsTrading),
                NFO_FUT: !!(config.equityTrading),
                NFO_OPT: !!(config.indexOptionsTrading || config.equityOptionsTrading),
                CRYPTO: !!(config.cryptoTrading),
                FOREX: !!(config.forexTrading),
                COMMODITY: !!(config.comexTrading || config.commodityTrading)
            };

            return allowed;
        }

        // Fallback: check user_segments table
        const [segRows] = await db.execute(
            'SELECT segment, is_enabled FROM user_segments WHERE user_id = ?',
            [userId]
        );

        if (segRows.length > 0) {
            const segMap = {};
            segRows.forEach(r => {
                segMap[r.segment] = r.is_enabled === 1;
            });

            return {
                MCX_FUT: segMap['MCX'] !== false,
                MCX_OPT: segMap['OPTIONS'] !== false || segMap['MCX'] !== false,
                NFO_FUT: segMap['EQUITY'] !== false,
                NFO_OPT: segMap['OPTIONS'] !== false,
                CRYPTO: segMap['CRYPTO'] !== false,
                FOREX: segMap['FOREX'] !== false,
                COMMODITY: segMap['COMEX'] !== false
            };
        }

        return defaultAllAllowed;
    } catch (err) {
        console.error('[getClientAllowedSegments] Error:', err);
        return defaultAllAllowed;
    }
}

/**
 * Checks if a given scrip symbol belongs to an allowed segment for the user.
 */
function isScripSegmentAllowed(symbol, allowedMap) {
    if (!symbol || !allowedMap) return true;

    const sym = String(symbol).toUpperCase().trim();
    const isOptionSymbol = sym.endsWith('CE') || sym.endsWith('PE');

    if (sym.startsWith('CRYPTO:') || ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'DOT', 'AVAX', 'LTC', 'LINK'].some(c => sym.includes(c))) {
        return !!allowedMap.CRYPTO;
    }

    if (sym.startsWith('FOREX:') || ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'GBP/USD', 'EUR/USD', 'USD/JPY', 'USD/CHF', 'AUD/CAD'].some(f => sym.includes(f))) {
        return !!allowedMap.FOREX;
    }

    if (sym.startsWith('COMMODITY:') || sym.startsWith('COMEX:')) {
        return !!allowedMap.COMMODITY;
    }

    if (sym.startsWith('MCX:')) {
        if (isOptionSymbol) {
            return !!allowedMap.MCX_OPT;
        }
        return !!allowedMap.MCX_FUT;
    }

    if (sym.startsWith('NFO:')) {
        if (isOptionSymbol || sym.includes('OPT')) {
            return !!allowedMap.NFO_OPT;
        }
        return !!allowedMap.NFO_FUT;
    }

    if (sym.startsWith('NSE:')) {
        return !!allowedMap.NFO_FUT;
    }

    // Unprefixed symbols: check CE/PE for options
    if (isOptionSymbol) {
        return !!allowedMap.NFO_OPT || !!allowedMap.MCX_OPT;
    }

    return true;
}

module.exports = {
    getClientAllowedSegments,
    isScripSegmentAllowed
};
