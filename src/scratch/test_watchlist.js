const axios = require('axios');

async function testWatchlist() {
    try {
        const response = await axios.get('http://localhost:5000/api/kite/market/watchlist', {
            headers: {
                // You might need an auth token here if authMiddleware is enabled
                // But for local test, maybe I can bypass it or check if it's disabled for localhost
            }
        });
        const nifty = response.data.find(r => r.symbol.includes('NIFTY26MAYFUT'));
        console.log('Nifty Data:', nifty);
    } catch (err) {
        console.error('Error:', err.message);
    }
}

testWatchlist();
