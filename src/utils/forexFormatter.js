/**
 * Forex Formatter Utility
 * Formats raw AllTick data into the frontend-compatible object
 */

const formatForexData = (instrument, data) => {
    // Ensure instrument is in format like "EUR/USD"
    let formattedInstrument = instrument;
    if (instrument && !instrument.includes('/')) {
        if (instrument.toLowerCase() === 'silver') {
            formattedInstrument = 'XAG/USD';
        } else if (instrument === 'GOLD') {
            formattedInstrument = 'XAU/USD';
        }
        // EURUSD -> EUR/USD
        else if (instrument.length === 6) {
            formattedInstrument = `${instrument.substring(0, 3)}/${instrument.substring(3)}`;
        } else if (instrument.endsWith('USD') || instrument.endsWith('INR')) {
            // XAUUSD -> XAU/USD
            const base = instrument.replace(/USD$|INR$/, '');
            const quote = instrument.substring(base.length);
            formattedInstrument = `${base}/${quote}`;
        }
    }

    let bid = parseFloat(data.bid || data.price || 0);
    let ask = parseFloat(data.ask || data.price || 0);
    // LTP priority: real trade-tick ltp > real price field > mid-price formula
    const ltp = data.ltp || (data.price ? parseFloat(data.price) : 0) || (bid + ask) / 2;

    // Special client rule for USDINR: Ask 10% lower, Bid 10% higher
    if (formattedInstrument === 'USD/INR' || formattedInstrument === 'USDINR') {
        const basePrice = ltp || bid || ask || 95.1;
        ask = basePrice * 0.90;
        bid = basePrice * 1.10;
    }

    // Change calculation if not provided directly
    let change = data.change || 0;
    if (data.previousClose && data.previousClose !== 0) {
        change = ((ltp - data.previousClose) / data.previousClose) * 100;
    }

    return {
        instrument: formattedInstrument,
        type: "FOREX",
        bid: bid,
        ask: ask,
        ltp: ltp,
        expiry: "-",
        strike: "-",
        opt: "-",
        change: parseFloat(change.toFixed(2)),
        volume: data.volume || "-"
    };
};

module.exports = { formatForexData };
