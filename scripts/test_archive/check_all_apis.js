const axios = require('axios');

async function checkAllTicks() {
  console.log("\n========== ALLTICKS ==========\n");
  const token = "0f900aa859f4be8ffaf217cce86e5b90-c-app";
  const missing = ["EURINR", "GBPINR", "XAGUSD", "MATICUSDT"];
  
  for (const symbol of missing) {
    const query = JSON.stringify({
      trace: 'check-' + Date.now(),
      data: { symbol_list: [{ code: symbol }] }
    });
    
    try {
      const res = await axios.get(
        `https://quote.alltick.io/quote-b-api/depth-tick?token=${token}&query=${encodeURIComponent(query)}`,
        { timeout: 5000, validateStatus: () => true }
      );
      
      console.log(`${symbol}:`);
      console.log(`  Status: ${res.status}`);
      console.log(`  Response ret: ${res.data?.ret}`);
      if (res.data?.data?.tick_list?.length > 0) {
        console.log(`  ✅ DATA FOUND:`, JSON.stringify(res.data.data.tick_list[0], null, 2).substring(0, 200));
      } else {
        console.log(`  ❌ No tick_list data`);
      }
    } catch (err) {
      console.log(`${symbol}: Error -`, err.message);
    }
    await new Promise(r => setTimeout(r, 500));
  }
}

async function checkBinance() {
  console.log("\n========== BINANCE API ==========\n");
  const symbols = ["MATICUSDT"]; // Only crypto
  
  for (const symbol of symbols) {
    try {
      const res = await axios.get(
        `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`,
        { timeout: 5000, validateStatus: () => true }
      );
      
      if (res.status === 200) {
        console.log(`✅ ${symbol}: FOUND`);
        console.log(`   Bid: ${res.data?.bidPrice}, Ask: ${res.data?.askPrice}`);
      } else {
        console.log(`❌ ${symbol}: ${res.status} - ${res.data?.msg}`);
      }
    } catch (err) {
      console.log(`❌ ${symbol}: ${err.message}`);
    }
  }
}

async function checkCoinGecko() {
  console.log("\n========== COINGECKO API ==========\n");
  const symbols = { 
    "matic-network": "MATIC",
    "gold": "XAU"
  };
  
  for (const [id, name] of Object.entries(symbols)) {
    try {
      const res = await axios.get(
        `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
        { timeout: 5000, validateStatus: () => true }
      );
      
      if (res.status === 200 && res.data[id]) {
        console.log(`✅ ${name}: FOUND - USD ${res.data[id].usd}`);
      } else {
        console.log(`❌ ${name}: No data`);
      }
    } catch (err) {
      console.log(`❌ ${name}: ${err.message}`);
    }
  }
}

async function checkTwelveData() {
  console.log("\n========== TWELVEDATA (Free Tier) ==========\n");
  // EURINR, GBPINR would need API key
  const pairs = ["EUR/INR", "GBP/INR", "XAG/USD"];
  console.log("❌ Requires API key (limited free tier) - checking if symbols exist in coverage...");
  pairs.forEach(p => console.log(`  ${p} - Available in paid plan`));
}

async function checkAlphaVantage() {
  console.log("\n========== ALPHA VANTAGE ==========\n");
  // Forex: EUR to INR, GBP to INR
  const pairs = [
    { from: "EUR", to: "INR" },
    { from: "GBP", to: "INR" },
    { from: "XAG", to: "USD" }
  ];
  
  console.log("⚠️  Alpha Vantage requires API key and has strict rate limits");
  console.log("   These pairs might be available but need API key");
  pairs.forEach(p => console.log(`   ${p.from}/${p.to}`));
}

async function run() {
  await checkAllTicks();
  await checkBinance();
  await checkCoinGecko();
  await checkTwelveData();
  await checkAlphaVantage();
}

run();
