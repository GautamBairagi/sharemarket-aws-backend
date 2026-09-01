const MarginUtils = {
    /**
     * Calculates the total holding margin required for a list of open trades.
     * Uses segments-specific logic (MCX, Equity, Options, Comex, etc.)
     */
    calculateTotalRequiredHoldingMargin(trades, clientConfig) {
        let totalMargin = 0;

        for (const trade of trades) {
            const qtyNum = parseFloat(trade.qty || 0);
            const entryPrice = parseFloat(trade.entry_price || 0);
            let tradeMargin = 0;

            let mType = (trade.market_type || '').toUpperCase();

            // ✅ Normalize market_type aliases so all branches match correctly
            if (mType === 'NSE' || mType === 'NFO') mType = 'EQUITY';
            if (mType === 'NIFTY') mType = 'OPTIONS';

            const isMcxSymbol = (trade.symbol || '').toUpperCase().startsWith('MCX:') ||
                                ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'COPPER', 'ZINC', 'NICKEL', 'LEAD', 'ALUMINIUM'].some(k => (trade.symbol || '').toUpperCase().includes(k));
            const isNseNfo = !isMcxSymbol && (['NSE', 'NFO', 'EQUITY', 'OPTIONS'].includes(mType) || ['NSE', 'NFO', 'EQUITY', 'OPTIONS'].includes((trade.market_type || '').toUpperCase()));
            const lotSize = isNseNfo ? 1 : parseFloat(trade.lot_size || trade.lot_size_at_entry || trade.multiplier || 1);
            const turnover = entryPrice * qtyNum * lotSize;


            if (mType === 'MCX') {
                const brokerMargins = clientConfig.mcxLotMargins || {};
                const upperSym = (trade.symbol || '').toUpperCase();
                const baseScrip = this.getMcxBaseScrip(trade.symbol, brokerMargins);

                // ✅ FIX: Check exposureType first - if TURNOVER, skip lot-wise config entirely
                const mcxExposureType = clientConfig.mcxExposureType || 'per_lot';
                const isTurnoverBased = mcxExposureType === 'per_turnover' || mcxExposureType === 'PER_TURNOVER_BASIS';

                if (isTurnoverBased) {
                    // TURNOVER-based: use global mcxHoldingMargin directly
                    const holdingExposure = parseFloat(clientConfig.mcxHoldingMargin || clientConfig.mcx_holding_exposure || 100);
                    tradeMargin = turnover / (holdingExposure || 1);
                } else {
                    // LOT-based: existing scrip-specific logic unchanged
                    const scripConfig = brokerMargins[upperSym] || brokerMargins[baseScrip];
                    // FIX: Handle 0 correctly - don't use || for zero values
                    const holdingMarginValue = parseFloat(
                        scripConfig?.HOLDING !== undefined ? scripConfig.HOLDING : scripConfig?.holding_exposure
                    );

                    if (Number.isFinite(holdingMarginValue) && holdingMarginValue >= 0) {  // Allow 0!
                        // If it's a fixed amount per lot (usually > 1000) or exposure divisor (usually 100)
                        if (holdingMarginValue > 500) {
                            // Fixed Amount per lot
                            tradeMargin = holdingMarginValue * qtyNum;
                        } else if (holdingMarginValue > 0) {
                            // Exposure Divisor
                            tradeMargin = turnover / holdingMarginValue;
                        } else {
                            // holdingMarginValue = 0, so margin = 0
                            tradeMargin = 0;
                        }
                    } else {
                        // Priority 2: Global Exposure-based Calculation (HOLDING)
                        const holdingExposure = parseFloat(clientConfig.mcxHoldingMargin || clientConfig.mcx_holding_exposure || 100);
                        tradeMargin = turnover / (holdingExposure || 1);
                    }
                }
            } else if (mType === 'EQUITY') {
                // ✅ Use equityHoldingMargin (not intraday) for holding margin calculation
                const holdingExposure = parseFloat(clientConfig.equityHoldingMargin || clientConfig.equity_holding_exposure || clientConfig.equityIntradayMargin || 100);
                tradeMargin = turnover / (holdingExposure || 1);
            } else if (mType === 'OPTIONS') {
                // ✅ Use segment-aware holding exposure for options (Index vs Equity vs MCX)
                try {
                    const { getSegmentExposure } = require('./segmentHelper');
                    const segExp = getSegmentExposure(trade.symbol, mType, clientConfig);
                    const holdingExposure = segExp.holdingExposure || 2;
                    tradeMargin = turnover / (holdingExposure || 1);
                } catch (e) {
                    tradeMargin = turnover / 2; // fallback if helper fails
                }
            } else if (mType === 'COMEX' || mType === 'FOREX' || mType === 'CRYPTO' || mType === 'COMMODITY') {
                let segConfig = {};
                if (mType === 'COMMODITY' || mType === 'COMEX') {
                    const commodityConfig = clientConfig.commodityConfig || {};
                    const comexConfig = clientConfig.comexConfig || {};
                    const forexConfig = clientConfig.forexConfig || {};

                    const isPopulated = (cfg) => {
                        if (!cfg) return false;
                        if (cfg.lotMargins && Object.keys(cfg.lotMargins).length > 0) return true;
                        if (cfg.exposureType && cfg.exposureType !== 'per_crore') return true;
                        if (parseFloat(cfg.intradayMargin || 0) > 0 || parseFloat(cfg.holdingMargin || 0) > 0) return true;
                        return false;
                    };

                    if (isPopulated(commodityConfig)) {
                        segConfig = commodityConfig;
                    } else if (isPopulated(comexConfig)) {
                        segConfig = comexConfig;
                    } else if (isPopulated(forexConfig)) {
                        segConfig = forexConfig;
                    } else {
                        segConfig = commodityConfig || comexConfig || forexConfig || {};
                    }
                } else {
                    segConfig = clientConfig[`${mType.toLowerCase()}Config`] || {};
                }

                const exposureType = segConfig.exposureType || 'per_crore';
                const rawScrip = (trade.symbol || '').split(':').pop().toUpperCase();

                if (exposureType === 'per_lot') {
                    // Try exact scrip name, then slash-stripped variant (XAUUSD vs XAU/USD)
                    const noSlash = rawScrip.replace('/', '');
                    const symbolMargins = (segConfig.lotMargins && (segConfig.lotMargins[rawScrip] || segConfig.lotMargins[noSlash])) || { HOLDING: '0' };
                    const holdingMarginVal = parseFloat(symbolMargins.HOLDING || 0);
                    tradeMargin = holdingMarginVal * qtyNum;
                } else {
                    const holdingExposure = parseFloat(segConfig.holdingMargin || segConfig.intradayMargin || 100);
                    tradeMargin = turnover / (holdingExposure || 1);
                }
            }

            // Fallback for any missed segments or 0 results (but keep 0 if intentional)
            // Only fallback if tradeMargin is undefined/NaN, not if it's 0
            if (!Number.isFinite(tradeMargin) && turnover > 0) {
                tradeMargin = turnover / 100; // 1% fallback
            }

            totalMargin += tradeMargin;
        }

        return totalMargin;
    },

    getMcxBaseScrip(symbol, configKeys) {
        if (!symbol) return '';
        const s = symbol.split(':').pop().toUpperCase();
        const cleanS = s.replace(/\s+/g, '');

        // 1. Try to match keys in the config directly (Longest match first)
        // This handles cases like "CRUDEOIL MINI" vs "CRUDEOIL"
        if (configKeys) {
            const sortedKeys = Object.keys(configKeys).sort((a, b) => b.length - a.length);
            for (const key of sortedKeys) {
                const cleanKey = key.replace(/\s+/g, '').toUpperCase();
                if (cleanS.startsWith(cleanKey)) return key;
            }
        }

        // 2. Generic prefix match
        const match = s.match(/^([A-Z]+)/);
        return match ? match[1] : s;
    }
};

module.exports = MarginUtils;
