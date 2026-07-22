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
            const lotSize = parseFloat(trade.lot_size || trade.lot_size_at_entry || trade.multiplier || 1);
            const turnover = entryPrice * qtyNum * lotSize;
            let tradeMargin = 0;

            const mType = (trade.market_type || '').toUpperCase();

            if (mType === 'MCX') {
                const brokerMargins = clientConfig.mcxLotMargins || {};
                const upperSym = (trade.symbol || '').toUpperCase();
                const baseScrip = this.getMcxBaseScrip(trade.symbol, brokerMargins);

                // Priority 1: Scrip-specific Lot-wise HOLDING Margin (Fixed Amount or Exposure)
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
            } else if (mType === 'EQUITY') {
                const holdingExposure = parseFloat(clientConfig.equityIntradayMargin || clientConfig.equityHoldingMargin || 500);
                tradeMargin = turnover / (holdingExposure || 1);
            } else if (mType === 'OPTIONS') {
                // Options typically use a divisor of 1 or a small value
                tradeMargin = turnover / 1;
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
