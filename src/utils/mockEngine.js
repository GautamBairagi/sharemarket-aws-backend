const EventEmitter = require('events');

class MockMarketEngine extends EventEmitter {
    constructor() {
        super();
        this.prices = {
            'GOLD': 72540.00,
            'SILVER': 89420.00,
            'CRUDEOIL': 6540.00,
            'ALUMINIUM': 212.45,
            'NIFTY': 22450.00,
            'BANKNIFTY': 47800.00
        };
        this.startEngine();
    }

    startEngine() {
        setInterval(() => {
            Object.keys(this.prices).forEach(symbol => {
                const volatility = symbol.includes('NIFTY') ? 2.0 : 5.0;
                const change = (Math.random() * volatility - (volatility / 2));
                this.prices[symbol] = parseFloat((this.prices[symbol] + change).toFixed(2));
            });
            this.emit('update', this.prices);
        }, 1000);
    }

    getPrices() {
        return this.prices;
    }

    getPrice(symbol) {
        // ✅ First try exact match
        if (this.prices[symbol]) {
            return this.prices[symbol];
        }

        // ✅ Create a list of allowed base symbols to prevent option-to-index mapping
        const allowedBases = ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'NIFTY', 'BANKNIFTY'];
        const baseSymbol = symbol.replace(/\d+[A-Z]*$/g, '').trim();

        if (baseSymbol && baseSymbol !== symbol && allowedBases.includes(baseSymbol) && this.prices[baseSymbol]) {
            // ONLY use base price if it's NOT an option (options shouldn't use index price)
            if (!symbol.includes('CE') && !symbol.includes('PE')) {
                console.log(`[MockEngine] 📌 Symbol "${symbol}" → using base "${baseSymbol}" price ₹${this.prices[baseSymbol]}`);
                return this.prices[baseSymbol];
            }
        }

        // ✅ Fallback: Return null if price is unknown. 
        // DO NOT generate random prices as it causes dangerous jumps in trading.
        return null;
    }
}

const engine = new MockMarketEngine();
module.exports = engine;
//   test this 