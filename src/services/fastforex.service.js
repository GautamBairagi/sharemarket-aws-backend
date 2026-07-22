const axios = require('axios');

class FastForexService {
    constructor() {
        this.intervalId = null;
        this.isRunning = false;
        this.isPolling = false;
        this.previousPrices = {};
        this.highPrices = {};
        this.lowPrices = {};

        // Slashed versions matching DB seeded symbols
        this.forexPairsMap = {
            "AUDCAD": "AUD/CAD",
            "EURINR": "EUR/INR",
            "EURUSD": "EUR/USD",
            "GBPINR": "GBP/INR",
            "GBPUSD": "GBP/USD",
            "USDCHF": "USD/CHF",
            "USDINR": "USD/INR",
            "USDJPY": "USD/JPY",
            "XAGUSD": "XAG/USD",
            "XAUUSD": "XAU/USD"
        };

        this.cryptoPairsList = [
            "ADA/USD", "AVAX/USD", "BNB/USD", "BTC/USD", "DOGE/USD",
            "DOT/USD", "ETH/USD", "MATIC/USD", "SOL/USD", "XRP/USD"
        ];
    }

    start() {
        const apiKey = process.env.FASTFOREX_API_KEY;
        if (!apiKey) {
            console.log('ℹ️ FASTFOREX_API_KEY not found. FastForex service waiting for env key.');
            return;
        }

        this.stop();
        console.log('🚀 Starting FastForex Integration Service...');
        this.isRunning = true;
        this.poll();
        this.intervalId = setInterval(() => this.poll(), 1000);
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.isRunning = false;
        this.isPolling = false;
    }

    async poll() {
        const apiKey = process.env.FASTFOREX_API_KEY;
        if (!apiKey || !this.isRunning || this.isPolling) return;

        this.isPolling = true;
        try {
            await this.fetchForexQuotes();
        } catch (err) {
            console.error('⚠️ FastForex fetchForexQuotes error:', err.message);
        }

        try {
            await this.fetchCryptoQuotes();
        } catch (err) {
            console.error('⚠️ FastForex fetchCryptoQuotes error:', err.message);
        } finally {
            this.isPolling = false;
        }
    }

    calculateLTP(bid, ask) {
        return (bid + ask) / 2;
    }

    calculateChange(ltp, previousPrice) {
        if (!previousPrice || previousPrice === 0) return 0;
        return ((ltp - previousPrice) / previousPrice) * 100;
    }

    formatForexData(instrument, price) {
        let bid = price;
        let ask = price;
        const ltp = this.calculateLTP(bid, ask);

        // Special client rule for USDINR: Ask 10% lower, Bid 10% higher
        if (instrument === 'USD/INR' || instrument === 'USDINR') {
            const basePrice = ltp || bid || ask || 95.1;
            ask = basePrice * 0.90;
            bid = basePrice * 1.10;
        }

        let prevPrice = this.previousPrices[instrument];
        if (!prevPrice) {
            this.previousPrices[instrument] = ltp;
            prevPrice = ltp;
            this.highPrices[instrument] = ltp * 1.0025;
            this.lowPrices[instrument] = ltp * 0.9975;
        }

        if (ltp > (this.highPrices[instrument] || 0)) {
            this.highPrices[instrument] = ltp;
        }
        if (!this.lowPrices[instrument] || ltp < this.lowPrices[instrument]) {
            this.lowPrices[instrument] = ltp;
        }

        const highVal = this.highPrices[instrument];
        const lowVal = this.lowPrices[instrument];

        const changePercent = this.calculateChange(ltp, prevPrice);
        const changeVal = parseFloat((ltp - prevPrice).toFixed(5));

        return {
            instrument,
            type: "FOREX",
            category: "forex",
            name: instrument,
            bid: parseFloat(bid.toFixed(5)),
            ask: parseFloat(ask.toFixed(5)),
            ltp: parseFloat(ltp.toFixed(5)),
            high: parseFloat(highVal.toFixed(5)),
            low: parseFloat(lowVal.toFixed(5)),
            open: parseFloat(prevPrice.toFixed(5)),
            close: parseFloat(prevPrice.toFixed(5)),
            ohlc: {
                open: parseFloat(prevPrice.toFixed(5)),
                high: parseFloat(highVal.toFixed(5)),
                low: parseFloat(lowVal.toFixed(5)),
                close: parseFloat(prevPrice.toFixed(5))
            },
            expiry: "-",
            strike: "-",
            opt: "-",
            change: parseFloat(changePercent.toFixed(2)),
            change_abs: changeVal,
            chg_pct: changePercent.toFixed(2),
            direction: changeVal >= 0 ? "up" : "down",
            volume: "-"
        };
    }

    formatCryptoData(instrument, price) {
        const bid = price;
        const ask = price;
        const ltp = this.calculateLTP(bid, ask);

        let prevPrice = this.previousPrices[instrument];
        if (!prevPrice) {
            this.previousPrices[instrument] = ltp;
            prevPrice = ltp;
            this.highPrices[instrument] = ltp * 1.0025;
            this.lowPrices[instrument] = ltp * 0.9975;
        }

        if (ltp > (this.highPrices[instrument] || 0)) {
            this.highPrices[instrument] = ltp;
        }
        if (!this.lowPrices[instrument] || ltp < this.lowPrices[instrument]) {
            this.lowPrices[instrument] = ltp;
        }

        const highVal = this.highPrices[instrument];
        const lowVal = this.lowPrices[instrument];

        const changePercent = this.calculateChange(ltp, prevPrice);
        const changeVal = parseFloat((ltp - prevPrice).toFixed(5));

        return {
            instrument,
            type: "CRYPTO",
            category: "crypto",
            name: instrument,
            bid: parseFloat(bid.toFixed(5)),
            ask: parseFloat(ask.toFixed(5)),
            ltp: parseFloat(ltp.toFixed(5)),
            high: parseFloat(highVal.toFixed(5)),
            low: parseFloat(lowVal.toFixed(5)),
            open: parseFloat(prevPrice.toFixed(5)),
            close: parseFloat(prevPrice.toFixed(5)),
            ohlc: {
                open: parseFloat(prevPrice.toFixed(5)),
                high: parseFloat(highVal.toFixed(5)),
                low: parseFloat(lowVal.toFixed(5)),
                close: parseFloat(prevPrice.toFixed(5))
            },
            expiry: "-",
            strike: "-",
            opt: "-",
            change: parseFloat(changePercent.toFixed(2)),
            change_abs: changeVal,
            chg_pct: changePercent.toFixed(2),
            direction: changeVal >= 0 ? "up" : "down",
            volume: "-"
        };
    }

    async fetchForexQuotes() {
        const apiKey = process.env.FASTFOREX_API_KEY;
        if (!apiKey) return;

        const url = `https://api.fastforex.io/fetch-all?api_key=${apiKey}`;
        const response = await axios.get(url, { timeout: 5000 });
        const results = response.data?.results;

        if (!results) return;

        const getRate = (curr) => results[curr];
        const usdEur = getRate('EUR');
        const usdGbp = getRate('GBP');
        const usdInr = getRate('INR');
        const usdJpy = getRate('JPY');
        const usdChf = getRate('CHF');
        const usdAud = getRate('AUD');
        const usdCad = getRate('CAD');
        const usdXau = getRate('XAU');
        const usdXag = getRate('XAG');

        const rawRates = {};
        rawRates['EUR/USD'] = usdEur ? 1 / usdEur : null;
        rawRates['GBP/USD'] = usdGbp ? 1 / usdGbp : null;
        rawRates['USD/INR'] = usdInr || null;
        rawRates['USD/JPY'] = usdJpy || null;
        rawRates['USD/CHF'] = usdChf || null;
        rawRates['EUR/INR'] = (usdInr && usdEur) ? usdInr / usdEur : null;
        rawRates['GBP/INR'] = (usdInr && usdGbp) ? usdInr / usdGbp : null;
        rawRates['AUD/CAD'] = (usdCad && usdAud) ? usdCad / usdAud : null;
        rawRates['XAU/USD'] = usdXau ? 1 / usdXau : (results['XAU/USD'] || 2350.50);
        rawRates['XAG/USD'] = usdXag ? 1 / usdXag : (results['XAG/USD'] || 30.20);

        const formattedList = [];
        Object.entries(this.forexPairsMap).forEach(([flatKey, slashedKey]) => {
            const price = rawRates[slashedKey];
            if (price && !isNaN(price)) {
                formattedList.push(this.formatForexData(slashedKey, price));
            }
        });

        if (formattedList.length > 0) {
            this.broadcastForexSocket(formattedList);
        }
    }

    async fetchCryptoQuotes() {
        const apiKey = process.env.FASTFOREX_API_KEY;
        if (!apiKey) return;

        const pairsParam = this.cryptoPairsList.join(',');
        const url = `https://api.fastforex.io/crypto/fetch-prices?pairs=${pairsParam}&api_key=${apiKey}`;
        const response = await axios.get(url, { timeout: 5000 });
        const pricesObj = response.data?.prices || response.data?.results;

        if (!pricesObj) return;

        const formattedList = [];
        this.cryptoPairsList.forEach(pair => {
            const price = pricesObj[pair];
            if (price && !isNaN(price)) {
                formattedList.push(this.formatCryptoData(pair, price));
            }
        });

        if (formattedList.length > 0) {
            this.broadcastCryptoSocket(formattedList);
        }
    }

    broadcastForexSocket(formattedDataList) {
        const marketDataService = require('./MarketDataService');
        if (!marketDataService?.prices) return;

        formattedDataList.forEach(item => {
            const slashedSymbol = `FOREX:${item.instrument}`;
            const unslashedInstrument = item.instrument.replace('/', '');
            const unslashedSymbol = `FOREX:${unslashedInstrument}`;

            marketDataService.prices[slashedSymbol] = {
                ...marketDataService.prices[slashedSymbol],
                ...item,
                symbol: slashedSymbol
            };
            marketDataService.dirtySymbols.add(slashedSymbol);

            marketDataService.prices[unslashedSymbol] = {
                ...marketDataService.prices[unslashedSymbol],
                ...item,
                instrument: unslashedInstrument,
                symbol: unslashedSymbol,
                name: unslashedInstrument
            };
            marketDataService.dirtySymbols.add(unslashedSymbol);
        });
    }

    broadcastCryptoSocket(formattedDataList) {
        const marketDataService = require('./MarketDataService');
        if (!marketDataService?.prices) return;

        formattedDataList.forEach(item => {
            const slashedSymbol = `CRYPTO:${item.instrument}`;
            const unslashedInstrument = item.instrument.replace('/', '');
            const unslashedSymbol = `CRYPTO:${unslashedInstrument}`;

            marketDataService.prices[slashedSymbol] = {
                ...marketDataService.prices[slashedSymbol],
                ...item,
                symbol: slashedSymbol
            };
            marketDataService.dirtySymbols.add(slashedSymbol);

            marketDataService.prices[unslashedSymbol] = {
                ...marketDataService.prices[unslashedSymbol],
                ...item,
                instrument: unslashedInstrument,
                symbol: unslashedSymbol,
                name: unslashedInstrument
            };
            marketDataService.dirtySymbols.add(unslashedSymbol);
        });
    }
}

module.exports = new FastForexService();
