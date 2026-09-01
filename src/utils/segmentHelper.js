/**
 * segmentHelper.js - Fixed isOptionsSymbol to avoid false positives like RELIANCE ending in CE
 */

const INDEX_OPTION_PREFIXES = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'];
const MCX_COMMODITY_PREFIXES = ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'COPPER', 'ZINC', 'NICKEL', 'LEAD', 'ALUMINIUM'];

/**
 * Detect if symbol is an options instrument.
 * Options symbols have a digit before the CE/PE suffix (e.g. BANKNIFTY26OCT56400CE, GOLD78000CE)
 * Plain stocks like RELIANCE, FINANCE end in CE/PE accidentally - exclude them.
 */
function isOptionsSymbol(symbol) {
    const upper = (symbol || '').toUpperCase().split(':').pop().trim();
    // Must end with CE or PE AND have a digit just before CE/PE
    // e.g. 56400CE ✅  RELIANCE ❌  TATASTEEL170CE ✅
    return /\d(CE|PE)$/.test(upper);
}

function getOptionSubType(symbol, marketType) {
    const upper = (symbol || '').toUpperCase().split(':').pop().trim();
    const mType = (marketType || '').toUpperCase();
    if (mType === 'MCX') return 'MCX_OPTION';
    if (INDEX_OPTION_PREFIXES.some(k => upper.startsWith(k))) return 'INDEX_OPTION';
    return 'EQUITY_OPTION';
}

/**
 * Get intraday + holding exposure for a symbol based on client config.
 */
function getSegmentExposure(symbol, marketType, clientConfig) {
    const cfg = clientConfig || {};
    const mType = (marketType || '').toUpperCase();

    // 1. MCX Futures (not options)
    if (mType === 'MCX' && !isOptionsSymbol(symbol)) {
        const expType = cfg.mcxExposureType || 'per_lot';
        const isTurnover = expType === 'per_turnover' || expType === 'PER_TURNOVER_BASIS' || expType === 'per_crore';
        return {
            intradayExposure: parseFloat(cfg.mcxIntradayMargin || cfg.mcx_intraday_exposure || 500),
            holdingExposure:  parseFloat(cfg.mcxHoldingMargin  || cfg.mcx_holding_exposure  || 100),
            segmentType: 'MCX_FUTURES',
            isTurnover
        };
    }

    // 2. Options instruments
    if (isOptionsSymbol(symbol)) {
        const subType = getOptionSubType(symbol, marketType);
        if (subType === 'MCX_OPTION') {
            return {
                intradayExposure: parseFloat(cfg.optionsMcxIntraday   || cfg.options_mcx_intraday   || 5),
                holdingExposure:  parseFloat(cfg.optionsMcxHolding    || cfg.options_mcx_holding    || 2),
                segmentType: 'MCX_OPTION', isTurnover: true
            };
        }
        if (subType === 'INDEX_OPTION') {
            return {
                intradayExposure: parseFloat(cfg.optionsIndexIntraday || cfg.options_index_intraday || 5),
                holdingExposure:  parseFloat(cfg.optionsIndexHolding  || cfg.options_index_holding  || 2),
                segmentType: 'INDEX_OPTION', isTurnover: true
            };
        }
        return {
            intradayExposure: parseFloat(cfg.optionsEquityIntraday || cfg.options_equity_intraday || 5),
            holdingExposure:  parseFloat(cfg.optionsEquityHolding  || cfg.options_equity_holding  || 2),
            segmentType: 'EQUITY_OPTION', isTurnover: true
        };
    }

    // 3. NSE Equity / NFO plain stocks
    if (mType === 'NSE' || mType === 'EQUITY' || mType === 'NFO') {
        return {
            intradayExposure: parseFloat(cfg.equityIntradayMargin || cfg.equity_intraday_exposure || 500),
            holdingExposure:  parseFloat(cfg.equityHoldingMargin  || cfg.equity_holding_exposure  || 100),
            segmentType: 'NSE_EQUITY', isTurnover: true
        };
    }

    // 4. COMEX / FOREX / CRYPTO / COMMODITY
    const segConfig = cfg[mType.toLowerCase() + 'Config'] || {};
    return {
        intradayExposure: parseFloat(segConfig.intradayMargin || 100),
        holdingExposure:  parseFloat(segConfig.holdingMargin  || 100),
        segmentType: mType, isTurnover: true
    };
}

module.exports = { getSegmentExposure, isOptionsSymbol, getOptionSubType };
