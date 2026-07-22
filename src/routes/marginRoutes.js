const express = require('express');
const router = express.Router();
const MarginService = require('../services/MarginService');
const db = require('../config/db');

/**
 * GET /api/margin/config/:symbol
 * Get margin configuration for a symbol
 */
router.get('/config/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { marketType = 'MCX' } = req.query;

    // Get user's client config
    const [configRows] = await db.execute(
      'SELECT config_json FROM client_settings WHERE user_id = ?',
      [req.user.id]
    );

    if (configRows.length === 0) {
      return res.status(400).json({ error: 'Client configuration not found' });
    }

    const clientConfig = JSON.parse(configRows[0].config_json || '{}');
    const marginConfig = MarginService.getMarginConfig(symbol, marketType, clientConfig);

    res.json({
      success: true,
      symbol,
      marketType,
      marginConfig: marginConfig
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * POST /api/margin/validate
 * Validate if user has sufficient margin for a trade
 *
 * Request body:
 * {
 *   "symbol": "GOLD26JUNFUT",
 *   "marketType": "MCX",
 *   "qty": 1,
 *   "price": 151363,
 *   "tradeType": "INTRADAY",
 *   "lotSize": 100  // optional
 * }
 */
router.post('/validate', async (req, res) => {
  try {
    const { symbol, marketType = 'MCX', qty, price, tradeType = 'INTRADAY', lotSize = 1 } = req.body;

    // Validate inputs
    if (!symbol || !qty || !price) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: symbol, qty, price'
      });
    }

    // Get user's client config
    const [configRows] = await db.execute(
      'SELECT config_json FROM client_settings WHERE user_id = ?',
      [req.user.id]
    );

    if (configRows.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Client configuration not found'
      });
    }

    const clientConfig = JSON.parse(configRows[0].config_json || '{}');

    // Get margin config
    const marginConfig = MarginService.getMarginConfig(symbol, marketType, clientConfig);

    // Calculate required margin
    const requiredMargin = MarginService.calculateRequiredMargin({
      qty: parseFloat(qty),
      price: parseFloat(price),
      marginConfig: marginConfig,
      tradeType: tradeType,
      lotSize: parseFloat(lotSize)
    });

    // Get user's balance
    const [userRows] = await db.execute(
      'SELECT balance FROM users WHERE id = ?',
      [req.user.id]
    );

    if (userRows.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'User not found'
      });
    }

    const availableBalance = parseFloat(userRows[0].balance || 0);

    // Validate margin
    const validation = MarginService.validateMargin(availableBalance, requiredMargin);

    res.json({
      success: true,
      symbol,
      marketType,
      exposureType: marginConfig.exposureType,
      required: parseFloat(validation.required),
      available: parseFloat(validation.available),
      allowed: validation.allowed,
      shortfall: parseFloat(validation.shortfall),
      reason: validation.reason
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * POST /api/margin/calculate
 * Calculate margin for a trade without validation
 *
 * Request body: Same as /validate
 */
router.post('/calculate', async (req, res) => {
  try {
    const { symbol, marketType = 'MCX', qty, price, tradeType = 'INTRADAY', lotSize = 1 } = req.body;

    if (!symbol || !qty || !price) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: symbol, qty, price'
      });
    }

    // Get user's client config
    const [configRows] = await db.execute(
      'SELECT config_json FROM client_settings WHERE user_id = ?',
      [req.user.id]
    );

    if (configRows.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Client configuration not found'
      });
    }

    const clientConfig = JSON.parse(configRows[0].config_json || '{}');
    const marginConfig = MarginService.getMarginConfig(symbol, marketType, clientConfig);
    const requiredMargin = MarginService.calculateRequiredMargin({
      qty: parseFloat(qty),
      price: parseFloat(price),
      marginConfig: marginConfig,
      tradeType: tradeType,
      lotSize: parseFloat(lotSize)
    });

    res.json({
      success: true,
      symbol,
      marketType,
      exposureType: marginConfig.exposureType,
      requiredMargin: parseFloat(requiredMargin.toFixed(2)),
      calculation: {
        qty: parseFloat(qty),
        price: parseFloat(price),
        lotSize: parseFloat(lotSize),
        tradeType: tradeType,
        type: marginConfig.exposureType
      }
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
});

module.exports = router;
