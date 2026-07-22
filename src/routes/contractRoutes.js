const express = require('express');
const router = express.Router();
const contractController = require('../controllers/contractController');

// Get all available contracts
router.get('/all', contractController.getAllContracts);

// Get selected/active contracts
router.get('/selected', contractController.getSelectedContracts);

// Save selected contracts
router.post('/save-selection', contractController.saveContractSelection);

// Get contracts by search
router.get('/search', contractController.searchContracts);

// ── Smart Rollover Suggestion System (read-only recommendation layer) ──────────
// GET  /api/contracts/rollover/suggestions  → list rollover suggestions
// POST /api/contracts/rollover/config       → { enabled: true/false }
// POST /api/contracts/rollover/enable-next  → { next_contract, current_contract }
router.get('/rollover/suggestions', contractController.getRolloverSuggestions);
router.post('/rollover/config', contractController.setRolloverConfig);
router.post('/rollover/enable-next', contractController.enableNextContract);
router.post('/rollover/complete', contractController.completeRollover);
router.post('/rollover/disable-current', contractController.disableCurrentContract);

// GET /api/contracts/market-watch-expiries
// Returns ALL expiry contracts from Zerodha for only the scripts used in Market Watch
router.get('/market-watch-expiries', contractController.getMarketWatchExpiries);

module.exports = router;
