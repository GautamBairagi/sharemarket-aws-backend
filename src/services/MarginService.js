const { getMcxBaseScrip } = require('../utils/symbolHelper');

/**
 * MarginService - Handles margin calculations for both exposure types
 * Support: Per Lot (fixed) and Per Crore (turnover-based)
 */
class MarginService {
  /**
   * Get margin configuration for a symbol
   * Supports both PER_LOT_BASIS (fixed) and PER_TURNOVER_BASIS (exposure-based)
   * @param {string} symbol - Trading symbol
   * @param {string} marketType - MCX, EQUITY, OPTIONS, etc.
   * @param {Object} clientConfig - Client configuration from database
   * @param {string} exposureTypeFromRequest - Exposure type from API request (priority)
   */
  static getMarginConfig(symbol, marketType, clientConfig, exposureTypeFromRequest) {
    if (!clientConfig) {
      throw new Error('Client configuration not found');
    }

    let config = {};
    const baseScrip = getMcxBaseScrip(symbol);
    const upperSym = symbol.toUpperCase();
    const scripName = symbol.split(':').pop().toUpperCase();

    // Market type specific config extraction
    if (marketType === 'MCX') {
      const mcxMargins = clientConfig.mcxLotMargins || {};

      // Try exact match first, then base symbol
      config = mcxMargins[upperSym] || mcxMargins[baseScrip] || {};

      if (!config || Object.keys(config).length === 0) {
        throw new Error(`No MCX margin configuration found for ${symbol}`);
      }
    } else if (marketType === 'EQUITY') {
      const equityMargins = clientConfig.equityLotMargins || {};
      config = equityMargins[upperSym] || {};

      if (!config || Object.keys(config).length === 0) {
        throw new Error(`No EQUITY margin configuration found for ${symbol}`);
      }
    } else if (marketType === 'OPTIONS') {
      // Options use different config structure
      config = {
        exposureType: 'PER_LOT_BASIS',
        INTRADAY: parseFloat(clientConfig.optionsIndexIntraday || 5),
        HOLDING: parseFloat(clientConfig.optionsIndexHolding || 2)
      };
    } else if (['COMEX', 'FOREX', 'CRYPTO', 'COMMODITY'].includes(marketType)) {
      let segConfig = {};
      if (marketType === 'COMMODITY' || marketType === 'COMEX') {
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
        segConfig = clientConfig[`${marketType.toLowerCase()}Config`] || {};
      }

      const lotMargins = segConfig.lotMargins || {};
      // scripName = last part after ':' (e.g. XAU/USD from COMMODITY:XAU/USD)
      config = lotMargins[scripName] || {};
      // If not found with full scripName, also try slash-stripped version (XAUUSD)
      if (!config || Object.keys(config).length === 0) {
        const noSlash = scripName.replace('/', '');
        config = lotMargins[noSlash] || {};
      }
    }

    // ✅ Read exposureType from request parameter, then from segment specific config, then default
    let segmentExposureType = 'per_crore';
    let intradayExp = 500;
    let holdingExp = 100;

    if (marketType === 'MCX') {
      segmentExposureType = clientConfig.mcxExposureType;
      intradayExp = clientConfig.mcxIntradayMargin;
      holdingExp = clientConfig.mcxHoldingMargin;
    } else if (marketType === 'EQUITY') {
      segmentExposureType = 'per_turnover';
      intradayExp = clientConfig.equityIntradayMargin;
      holdingExp = clientConfig.equityHoldingMargin;
    } else if (['COMEX', 'FOREX', 'CRYPTO', 'COMMODITY'].includes(marketType)) {
      let segConfig = {};
      if (marketType === 'COMMODITY' || marketType === 'COMEX') {
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
        segConfig = clientConfig[`${marketType.toLowerCase()}Config`] || {};
      }

      segmentExposureType = segConfig.exposureType || 'per_crore';
      intradayExp = segConfig.intradayMargin;
      holdingExp = segConfig.holdingMargin;
    }

    let normalizedExposureType = exposureTypeFromRequest
      || segmentExposureType
      || 'PER_TURNOVER_BASIS';

    // Convert old terminology to new (for backward compatibility)
    if (normalizedExposureType === 'per_lot') {
        normalizedExposureType = 'PER_LOT_BASIS';
    } else if (normalizedExposureType === 'per_crore' || normalizedExposureType === 'per_turnover') {
        normalizedExposureType = 'PER_TURNOVER_BASIS';
    }

    // Normalize config to include exposureType
    // FIX: Handle zero values correctly - don't use || for zero values
    const normalized = {
      exposureType: normalizedExposureType,
      // Per Lot fields
      INTRADAY: parseFloat(
        config.INTRADAY !== undefined ? config.INTRADAY : (config.intraday_margin || 0)
      ),
      HOLDING: parseFloat(
        config.HOLDING !== undefined ? config.HOLDING : (config.holding_margin || 0)
      ),
      // Per Turnover fields (global)
      intradayExposure: parseFloat(
        intradayExp !== undefined ? intradayExp : 500
      ),
      holdingExposure: parseFloat(
        holdingExp !== undefined ? holdingExp : 100
      ),
      // Lot size
      LOT: parseFloat(config.LOT || config.lot || 1)
    };

    return normalized;
  }

  /**
   * Calculate required margin for a trade
   * Automatically handles both PER_LOT_BASIS and PER_TURNOVER_BASIS based on config
   *
   * @param {Object} params
   * @param {number} params.qty - Quantity
   * @param {number} params.price - Execution price
   * @param {Object} params.marginConfig - Config from getMarginConfig()
   * @param {string} params.tradeType - 'INTRADAY' or 'HOLDING'
   * @param {number} params.lotSize - Lot multiplier (optional, default 1)
   * @returns {number} Required margin amount
   */
  static calculateRequiredMargin(params) {
    const { qty, price, marginConfig, tradeType = 'INTRADAY', lotSize = 1 } = params;

    const qtyNum = parseFloat(qty) || 0;
    const priceNum = parseFloat(price) || 0;

    if (qtyNum <= 0) {
      throw new Error('Quantity must be positive');
    }
    if (priceNum <= 0) {
      throw new Error('Price must be positive');
    }

    // ✅ USE NEW TERMINOLOGY! (Handle both old and new)
    let exposureType = marginConfig.exposureType || 'PER_LOT_BASIS';

    // Convert old terminology to new (for backward compatibility)
    if (exposureType === 'per_lot') {
        exposureType = 'PER_LOT_BASIS';
    } else if (exposureType === 'per_crore' || exposureType === 'per_turnover') {
        exposureType = 'PER_TURNOVER_BASIS';
    }

    // TYPE 1: PER_LOT_BASIS (Fixed Margin per lot)
    if (exposureType === 'PER_LOT_BASIS') {
      const marginField = tradeType === 'HOLDING' ? 'HOLDING' : 'INTRADAY';
      const marginPerLot = marginConfig[marginField] || 0;

      // Use the value as-is (even if 0) - no fallback to exposure
      const requiredMargin = qtyNum * marginPerLot;

      console.log(`[MarginService] ✅ PER_LOT_BASIS (${tradeType}): qty=${qtyNum} × ₹${marginPerLot} = ₹${requiredMargin.toFixed(2)}`);
      return requiredMargin;
    }

    // TYPE 2: PER_TURNOVER_BASIS (Exposure-based calculation)
    if (exposureType === 'PER_TURNOVER_BASIS') {
      const exposureField = tradeType === 'HOLDING' ? 'holdingExposure' : 'intradayExposure';
      const exposure = marginConfig[exposureField] || (tradeType === 'HOLDING' ? 100 : 500);

      // 🎯 FIXED: For PER_TURNOVER_BASIS, turnover = price × qty × lotSize
      // lotSize is critical for MCX (e.g. Crude Oil lot is 100)
      const turnover = priceNum * qtyNum * (lotSize || 1);
      const requiredMargin = turnover / exposure;

      console.log(`[MarginService] ✅ PER_TURNOVER_BASIS (${tradeType}): (₹${priceNum} × ${qtyNum} × ${lotSize}) / ${exposure} = ₹${requiredMargin.toFixed(2)}`);
      return requiredMargin;
    }

    throw new Error(`🔴 CRITICAL: Invalid exposure type "${exposureType}". Must be 'PER_LOT_BASIS' or 'PER_TURNOVER_BASIS'`);
  }

  /**
   * Validate if user has sufficient margin for a trade
   *
   * @param {number} availableBalance - User's available balance/margin
   * @param {number} requiredMargin - Margin required for trade
   * @returns {Object} { allowed: boolean, required, available, shortfall }
   */
  static validateMargin(availableBalance, requiredMargin) {
    const available = parseFloat(availableBalance) || 0;
    const required = parseFloat(requiredMargin) || 0;
    const allowed = available >= required;
    const shortfall = Math.max(0, required - available);

    return {
      allowed,
      required: required.toFixed(2),
      available: available.toFixed(2),
      shortfall: shortfall.toFixed(2),
      reason: !allowed ? `Insufficient margin. Required: ₹${required.toFixed(2)}, Available: ₹${available.toFixed(2)}, Shortfall: ₹${shortfall.toFixed(2)}` : null
    };
  }

  /**
   * Get holding margin for existing open trades
   * Used to calculate total holding margin required overnight
   */
  static calculateTotalHoldingMargin(trades, clientConfig) {
    let totalMargin = 0;

    for (const trade of trades) {
      try {
        let mType = (trade.market_type || '').toUpperCase();
        if (mType === 'NSE') mType = 'EQUITY';
        if (mType === 'NFO') mType = 'OPTIONS';

        let marginConfig;
        try {
          marginConfig = this.getMarginConfig(trade.symbol, mType, clientConfig);
        } catch (configErr) {
          // Fallback if specific config is not found in getMarginConfig
          if (mType === 'EQUITY' || mType === 'OPTIONS' || ['COMEX', 'FOREX', 'CRYPTO', 'COMMODITY'].includes(mType)) {
            // Create a default marginConfig for exposure based
            let segmentExposureType = 'per_crore';
            let intradayExp = 500;
            let holdingExp = 100;

            if (mType === 'EQUITY') {
              segmentExposureType = 'per_turnover';
              intradayExp = clientConfig.equityIntradayMargin;
              holdingExp = clientConfig.equityHoldingMargin;
            } else if (mType === 'OPTIONS') {
              segmentExposureType = 'PER_LOT_BASIS';
              intradayExp = parseFloat(clientConfig.optionsIndexIntraday || 5);
              holdingExp = parseFloat(clientConfig.optionsIndexHolding || 2);
            } else {
              // COMEX, FOREX, CRYPTO, COMMODITY
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

              segmentExposureType = segConfig.exposureType || 'per_crore';
              intradayExp = segConfig.intradayMargin;
              holdingExp = segConfig.holdingMargin;
            }

            let normalizedExposureType = segmentExposureType || 'PER_TURNOVER_BASIS';
            if (normalizedExposureType === 'per_lot') {
                normalizedExposureType = 'PER_LOT_BASIS';
            } else if (normalizedExposureType === 'per_crore' || normalizedExposureType === 'per_turnover') {
                normalizedExposureType = 'PER_TURNOVER_BASIS';
            }

            marginConfig = {
              exposureType: normalizedExposureType,
              INTRADAY: 0,
              HOLDING: 0,
              intradayExposure: parseFloat(intradayExp !== undefined ? intradayExp : 500),
              holdingExposure: parseFloat(holdingExp !== undefined ? holdingExp : 100),
              LOT: 1
            };
          } else {
            throw configErr;
          }
        }

        const lotSize = parseFloat(trade.lot_size || trade.multiplier || 1);

        const margin = this.calculateRequiredMargin({
          qty: trade.qty,
          price: trade.entry_price,
          marginConfig,
          tradeType: 'HOLDING',
          lotSize
        });

        totalMargin += margin;
      } catch (err) {
        console.error(`[MarginService] Error calculating holding margin for ${trade.symbol}:`, err.message);
        // Continue with other trades
      }
    }

    return totalMargin;
  }
}

module.exports = MarginService;
