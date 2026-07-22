/**
 * rolloverSuggestionService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Smart Expiry Rollover Suggestion Service
 *
 * Analyses contracts loaded from Zerodha instruments cache and generates
 * intelligent rollover recommendations for:
 *   • NFO Futures   (threshold: 2 days)
 *   • NFO Options   (threshold: 2 days)
 *   • MCX Futures   (threshold: 7 days)
 *   • MCX Options   (threshold: 7 days)
 *
 * Does NOT touch any live-quote, socket, order, or watchlist logic.
 * Only reads from contractController's shared cache and produces suggestions.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CONTRACTS_CACHE_FILE = path.join(__dirname, '../data/contracts_cache.json');
const ROLLOVER_CONFIG_FILE = path.join(__dirname, '../data/rollover_config.json');

// ── Expiry thresholds (calendar days) ─────────────────────────────────────────
const THRESHOLD = {
    NFO: 2,   // NFO Futures & Options — 2 days
    MCX: 7,   // MCX Futures & Options — 7 days
    NSE: 2,   // NSE Futures           — 2 days
};

// ── Market close times (IST) ──────────────────────────────────────────────────
const MARKET_CLOSE_TIME = {
    MCX: { hour: 23, minute: 30 },  // MCX closes at 11:30 PM IST
    NFO: { hour: 15, minute: 30 },  // NFO closes at 3:30 PM IST
    NSE: { hour: 15, minute: 30 },  // NSE closes at 3:30 PM IST
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse an expiry string like "25JUN" or "26JUN25" into a JS Date.
 * Kite instruments use the raw expiry field (ISO date: "2025-06-25").
 */
function parseExpiry(expiryStr) {
    if (!expiryStr) return null;
    // ISO format from Zerodha: "2025-06-25"
    if (expiryStr.includes('-')) return new Date(expiryStr + 'T00:00:00+05:30');
    // Legacy shorthand like "25JUN" or "25JUN25"
    const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
    const m = expiryStr.match(/^(\d{1,2})([A-Z]{3})(\d{2,4})?$/);
    if (!m) return null;
    const day = parseInt(m[1], 10);
    const mon = months[m[2]];
    const yr = m[3] ? (m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10)) : new Date().getFullYear();
    return new Date(yr, mon, day, 0, 0, 0, 0);
}

/**
 * Days remaining until expiry from today (IST midnight).
 */
function daysRemaining(expiryDate) {
    if (!expiryDate || isNaN(expiryDate.getTime())) return Infinity;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const expDay = new Date(expiryDate.getFullYear(), expiryDate.getMonth(), expiryDate.getDate());
    return Math.ceil((expDay - today) / (1000 * 60 * 60 * 24));
}

/**
 * Check if market is closed for a given segment (IST time).
 * Returns true if market has closed for the day.
 */
function isMarketClosed(segment) {
    const now = new Date();
    const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const currentHour = istTime.getHours();
    const currentMin = istTime.getMinutes();

    const closeTime = MARKET_CLOSE_TIME[segment] || MARKET_CLOSE_TIME.NSE;

    // Market is closed if current time >= close time
    return (currentHour > closeTime.hour) ||
           (currentHour === closeTime.hour && currentMin >= closeTime.minute);
}

/**
 * Determine rollover_type label for the suggestion.
 */
function rolloverType(segment, instrType) {
    if (segment === 'MCX' && instrType === 'FUT') return 'MCX_FUT';
    if (segment === 'MCX' && instrType === 'CE') return 'MCX_OPT';
    if (segment === 'MCX' && instrType === 'PE') return 'MCX_OPT';
    if (segment === 'NFO' && instrType === 'FUT') return 'NFO_FUT';
    if (segment === 'NFO') return 'NFO_OPT';
    if (segment === 'NSE' && instrType === 'FUT') return 'NSE_FUT';
    return 'GENERIC';
}

// ── Config persistence ────────────────────────────────────────────────────────

function loadConfig() {
    try {
        if (fs.existsSync(ROLLOVER_CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(ROLLOVER_CONFIG_FILE, 'utf8'));
        }
    } catch (_) { /* ignore */ }
    return { enabled: false };
}

function saveConfig(cfg) {
    try {
        fs.writeFileSync(ROLLOVER_CONFIG_FILE, JSON.stringify(cfg, null, 2));
    } catch (_) { /* ignore */ }
}

// ── Core analysis ─────────────────────────────────────────────────────────────

/**
 * Reads contracts from the Zerodha instruments cache (raw instruments list)
 * and from the contract controller's parsed contracts cache.
 *
 * Returns an array of RolloverSuggestion objects.
 */
function generateSuggestions(allContracts, excludedContracts) {
    const suggestions = [];
    const now = new Date();

    // Group contracts by (segment + base instrument name)
    // Key: "MCX_GOLD" or "NFO_NIFTY"
    const groups = {};

    allContracts.forEach(c => {
        const seg = (c.segment || '').toUpperCase();
        const baseName = (c.name || '').replace(/\s+/g, '').toUpperCase();
        if (!baseName || !seg) return;

        // Determine instrument type from trading_symbol
        const ts = (c.trading_symbol || c.tradingsymbol || c.symbol || '').toUpperCase();
        let instrType = 'FUT';
        if (ts.endsWith('CE')) instrType = 'CE';
        else if (ts.endsWith('PE')) instrType = 'PE';
        else if (/FUT$/.test(ts)) instrType = 'FUT';

        const groupKey = `${seg}_${baseName}_${instrType}`;
        if (!groups[groupKey]) groups[groupKey] = { seg, baseName, instrType, contracts: [] };

        // Parse expiry date (prefer ISO field)
        let expiryDate = null;
        if (c.expiry) {
            // If expiry looks like "25JUN" (from parsed cache)
            expiryDate = parseExpiry(c.expiry);
        }
        if (!expiryDate || isNaN(expiryDate.getTime())) return;
        if (expiryDate < now && daysRemaining(expiryDate) < -7) return; // skip far-past

        groups[groupKey].contracts.push({ ...c, _expiryDate: expiryDate });
    });

    // Analyse each group
    Object.values(groups).forEach(({ seg, baseName, instrType, contracts }) => {
        // Sort by expiry ascending
        contracts.sort((a, b) => a._expiryDate - b._expiryDate);

        // Threshold
        const threshold = THRESHOLD[seg] ?? 2;

        contracts.forEach((current, idx) => {
            const days = daysRemaining(current._expiryDate);
            if (days > threshold) return; // not near expiry

            // Hide contract ONLY AFTER market closes on expiry day
            // If days === 0 (today is expiry) but market is still open → SHOW
            // If days === 0 and market closed → HIDE
            // If days < -1 (expired >1 day ago) → HIDE
            const shouldHide = (days < -1) || (days === 0 && isMarketClosed(seg));
            if (shouldHide) return;

            // Find next contract in same group (next expiry)
            const next = contracts[idx + 1];

            const currentSymbol = current.symbol || `${seg}:${current.trading_symbol || current.tradingsymbol}`;
            const isCurrentActive = !excludedContracts.includes(currentSymbol);

            // Only suggest if current is active
            if (!isCurrentActive) return;

            // Determine status and message
            let status = 'READY';
            let statusMessage = '✅ Next is Active';
            let nextSymbol = null;
            let nextDisplay = null;
            let nextExpiry = null;
            let isNextActive = false;
            let showDisableButton = true;
            let currentExists = true; // Check if current contract is available

            if (!next) {
                // Next contract not available yet
                status = 'WAITING';
                statusMessage = '⏳ Next contract not yet available';
                showDisableButton = false;
            } else {
                nextSymbol = next.symbol || `${seg}:${next.trading_symbol || next.tradingsymbol}`;
                nextDisplay = next.trading_symbol || next.tradingsymbol || nextSymbol;
                nextExpiry = next._expiryDate.toISOString().split('T')[0];
                isNextActive = !excludedContracts.includes(nextSymbol);

                if (isNextActive) {
                    statusMessage = '✅ Next is Active';
                } else {
                    statusMessage = '⚠️ Next contract available but not active';
                }
            }

            // If contract is already hidden/expired, don't show disable button
            if (days <= -1) {
                showDisableButton = false;
                currentExists = false;
                statusMessage = '🔴 Contract Expired (Auto-Disabled)';
            } else if (days === 0 && isMarketClosed(seg)) {
                showDisableButton = false;
                currentExists = false;
                statusMessage = '🔴 Contract Expired (Auto-Disabled)';
            }

            // If current contract doesn't exist in available contracts, hide disable button
            // (Already not in market watch = already disabled effectively)
            if (!currentExists || !isCurrentActive) {
                showDisableButton = false;
            }

            suggestions.push({
                current_contract: currentSymbol,
                current_display: current.trading_symbol || current.tradingsymbol || currentSymbol,
                next_contract: nextSymbol,
                next_display: nextDisplay,
                base_name: baseName,
                days_remaining: days,
                current_expiry: current._expiryDate.toISOString().split('T')[0],
                next_expiry: nextExpiry,
                segment: seg,
                instrument_type: instrType,
                rollover_type: rolloverType(seg, instrType),
                recommended_action: 'ENABLE_NEXT_EXPIRY',
                next_already_active: isNextActive,
                urgency: days <= 0 ? 'EXPIRED' : days <= 1 ? 'CRITICAL' : 'WARNING',
                status: status,
                status_message: statusMessage,
                show_disable_button: showDisableButton
            });
        });
    });

    // Sort: EXPIRED → CRITICAL → WARNING → days ascending
    const urgencyOrder = { EXPIRED: 0, CRITICAL: 1, WARNING: 2 };
    suggestions.sort((a, b) => {
        const ua = urgencyOrder[a.urgency] ?? 3;
        const ub = urgencyOrder[b.urgency] ?? 3;
        if (ua !== ub) return ua - ub;
        return a.days_remaining - b.days_remaining;
    });

    return suggestions;
}

// ── Public API ────────────────────────────────────────────────────────────────

module.exports = {
    /** Returns { enabled: boolean } */
    getConfig: loadConfig,

    /** Updates and persists the enabled flag */
    setEnabled(enabled) {
        const cfg = loadConfig();
        cfg.enabled = !!enabled;
        saveConfig(cfg);
        return cfg;
    },

    getSuggestions(allContracts, excludedContracts, forceEnabled = false) {
        const cfg = loadConfig();
        if (!cfg.enabled && !forceEnabled) return { enabled: false, suggestions: [] };
        const suggestions = generateSuggestions(allContracts, excludedContracts || []);
        return { enabled: true, suggestions };
    },

    /** Check if Smart Rollover is enabled */
    isEnabled() {
        return !!loadConfig().enabled;
    }
};
