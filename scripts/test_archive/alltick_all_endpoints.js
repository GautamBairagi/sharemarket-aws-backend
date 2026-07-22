const axios = require('axios');

async function checkAllEndpoints() {
  const token = "0f900aa859f4be8ffaf217cce86e5b90-c-app";
  
  console.log("\n========== ALLTICK API - ALL POSSIBLE ENDPOINTS ==========\n");
  
  // Comprehensive list of potential endpoints
  const endpoints = [
    // Market Data
    { path: "/quote-b-api/depth-tick", method: "GET", params: "?token=TOKEN&query=JSON", desc: "Depth tick (current - WORKS)" },
    { path: "/quote-b-api/tick", method: "GET", params: "?token=TOKEN&code=SYMBOL", desc: "Single tick" },
    { path: "/quote-b-api/quote", method: "GET", params: "?token=TOKEN&code=SYMBOL", desc: "Quote info" },
    
    // Instrument/Symbol Info
    { path: "/quote-b-api/instrument", method: "GET", params: "?token=TOKEN&code=SYMBOL", desc: "Instrument details" },
    { path: "/quote-b-api/instruments", method: "GET", params: "?token=TOKEN", desc: "All instruments" },
    { path: "/quote-b-api/symbols", method: "GET", params: "?token=TOKEN", desc: "Symbol list with specs" },
    { path: "/quote-b-api/symbol-info", method: "GET", params: "?token=TOKEN&code=SYMBOL", desc: "Symbol metadata" },
    { path: "/quote-b-api/contract", method: "GET", params: "?token=TOKEN&code=SYMBOL", desc: "Contract specs" },
    
    // Search/Filter
    { path: "/quote-b-api/search", method: "GET", params: "?token=TOKEN&q=BTC", desc: "Search symbols" },
    { path: "/quote-b-api/filter", method: "GET", params: "?token=TOKEN&category=crypto", desc: "Filter by category" },
    
    // Quotes/Summary
    { path: "/quote-b-api/quotes", method: "POST", params: "body: {codes: []}", desc: "Batch quotes" },
    { path: "/quote-b-api/summary", method: "GET", params: "?token=TOKEN&code=SYMBOL", desc: "Price summary" },
    
    // Historical/OHLC
    { path: "/quote-b-api/kline", method: "GET", params: "?token=TOKEN&code=SYMBOL", desc: "OHLCV data" },
    { path: "/quote-b-api/bars", method: "GET", params: "?token=TOKEN&code=SYMBOL", desc: "Bar data" },
    
    // Market Info
    { path: "/quote-b-api/market-info", method: "GET", params: "?token=TOKEN", desc: "Market information" },
    { path: "/quote-b-api/categories", method: "GET", params: "?token=TOKEN", desc: "Asset categories" },
    { path: "/quote-b-api/exchanges", method: "GET", params: "?token=TOKEN", desc: "Exchanges list" },
  ];
  
  console.log("Testing endpoints...\n");
  
  for (const ep of endpoints) {
    try {
      let url;
      if (ep.path.includes("symbols") || ep.path.includes("instruments") || ep.path.includes("market-info")) {
        url = `https://quote.alltick.io${ep.path}?token=${token}`;
      } else if (ep.path.includes("SYMBOL")) {
        url = `https://quote.alltick.io${ep.path}?token=${token}&code=BTCUSDT`;
      } else {
        url = `https://quote.alltick.io${ep.path}?token=${token}`;
      }
      
      const res = await axios.get(url, { 
        timeout: 2000, 
        validateStatus: () => true,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      
      const status = res.status;
      let result;
      if (status === 200) {
        result = "✅ 200 OK";
        if (res.data?.data || res.data?.instruments || res.data?.symbols) {
          result += " (HAS DATA)";
        }
      } else if (status === 400) {
        result = "⚠️  400 Bad Request";
      } else if (status === 401) {
        result = "🔒 401 Unauthorized";
      } else if (status === 402) {
        result = "💰 402 Plan Limited";
      } else if (status === 404) {
        result = "❌ 404 Not Found";
      } else {
        result = `${status}`;
      }
      
      console.log(`${ep.path}`);
      console.log(`   ${result}`);
      if (status === 200 && res.data) {
        const preview = JSON.stringify(res.data).substring(0, 120);
        console.log(`   Preview: ${preview}...`);
      }
      console.log();
      
    } catch (err) {
      console.log(`${ep.path}`);
      console.log(`   ❌ Timeout/Error: ${err.message.substring(0, 40)}\n`);
    }
    
    await new Promise(r => setTimeout(r, 200));
  }
  
  console.log("\n========== CONCLUSION ==========\n");
}

checkAllEndpoints();
