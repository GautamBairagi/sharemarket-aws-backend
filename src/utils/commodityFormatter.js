/**
 * Commodity Formatter Utility
 * Formats raw AllTick data into the frontend-compatible object
 */

const formatCommodityData = (instrument, data) => {
    // Map AllTick codes back to standard database symbols
    let formattedInstrument = instrument;
    if (instrument) {
        if (instrument === 'GOLD') {
            formattedInstrument = 'XAU/USD';
        } else if (instrument.toLowerCase() === 'silver') {
            formattedInstrument = 'XAG/USD';
        }
        // Mini/Custom symbols: XAUUSDM, MXAU, XAGUSDM, MXAG, USOILM, MUSOIL, NGASM, MNGAS
        // These are passed directly from the mini alias broadcast — keep them as-is
        // (They don't match GOLD/Silver/USOIL/NGAS so no mapping needed)
    }

    const bid = parseFloat(data.bid || data.price || 0);
    const ask = parseFloat(data.ask || data.price || 0);
    // LTP priority: real trade-tick ltp > real price field > mid-price formula
    const ltp = data.ltp || (data.price ? parseFloat(data.price) : 0) || (bid + ask) / 2;

    // Change calculation if not provided directly
    let change = data.change || 0;
    if (data.previousClose && data.previousClose !== 0) {
        change = ((ltp - data.previousClose) / data.previousClose) * 100;
    }

    return {
        instrument: formattedInstrument,
        type: "COMMODITY",
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

module.exports = { formatCommodityData };
