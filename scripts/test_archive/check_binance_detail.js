const axios = require('axios');

async function checkBinance() {
  console.log("========== BINANCE DETAILED CHECK ==========\n");
  
  // Check MATICUSDT with different endpoints
  const symbol = "MATICUSDT";
  
  try {
    // Endpoint 1: Book Ticker (best bid/ask)
    const bookRes = await axios.get(
      `https://api.binance.com/api/v3/bookTicker?symbol=${symbol}`,
      { timeout: 5000 }
    );
    console.log(`✅ ${symbol} (bookTicker):`);
    console.log(`   Bid: ${bookRes.data.bidPrice}`);
    console.log(`   Ask: ${bookRes.data.askPrice}`);
    console.log(`   Bid Qty: ${bookRes.data.bidQty}`);
    console.log(`   Ask Qty: ${bookRes.data.askQty}`);
  } catch (err) {
    console.log(`❌ bookTicker error:`, err.message);
  }
  
  try {
    // Endpoint 2: 24hr ticker
    const tickerRes = await axios.get(
      `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`,
      { timeout: 5000 }
    );
    console.log(`\n✅ ${symbol} (24hr ticker):`);
    console.log(`   Last Price: ${tickerRes.data.lastPrice}`);
    console.log(`   High: ${tickerRes.data.highPrice}`);
    console.log(`   Low: ${tickerRes.data.lowPrice}`);
    console.log(`   Volume: ${tickerRes.data.volume}`);
  } catch (err) {
    console.log(`❌ 24hr error:`, err.message);
  }
}

async function checkRapidAPI() {
  console.log("\n========== CHECKING RAPIDAPI AVAILABILITY ==========\n");
  console.log("Available free APIs on RapidAPI:");
  console.log("  ✓ Forex Data APIs - Support EUR/INR, GBP/INR");
  console.log("  ✓ Metals APIs - Support XAG/USD (Silver)");
  console.log("  ✓ Crypto APIs - Support MATIC/USD");
  console.log("  (All require free RapidAPI account + API key)");
}

checkBinance();
checkRapidAPI();
