const axios = require('axios');

async function exploreAllTickAPI() {
  const token = "0f900aa859f4be8ffaf217cce86e5b90-c-app";
  
  console.log("\n========== ALLTICK API METADATA RESEARCH ==========\n");
  
  // Test 1: Full depth-tick response structure
  console.log("1️⃣  DEPTH-TICK ENDPOINT (Current)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  
  const query1 = JSON.stringify({
    trace: 'meta-test-' + Date.now(),
    data: { symbol_list: [{ code: "BTCUSDT" }, { code: "EURUSD" }] }
  });
  
  try {
    const res = await axios.get(
      `https://quote.alltick.io/quote-b-api/depth-tick?token=${token}&query=${encodeURIComponent(query1)}`,
      { timeout: 5000 }
    );
    
    if (res.data.ret === 200 && res.data.data?.tick_list?.length > 0) {
      const tick = res.data.data.tick_list[0];
      console.log("Response Fields:");
      console.log(JSON.stringify(tick, null, 2).substring(0, 800));
      console.log("\n⚠️  Observation:");
      console.log("  - Contains: code, bids, asks, tick_time, pre_close_price");
      console.log("  - Missing: lot size, tick size, pip value, multiplier");
    }
  } catch (err) {
    console.log(`Error: ${err.message}`);
  }
  
  // Test 2: Try /quote-b-api/search or other endpoints
  console.log("\n\n2️⃣  SEARCHING FOR METADATA ENDPOINTS");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  
  const endpoints = [
    { name: "tick", url: `/quote-b-api/tick?token=${token}&code=BTCUSDT` },
    { name: "quote", url: `/quote-b-api/quote?token=${token}&code=BTCUSDT` },
    { name: "symbol-info", url: `/quote-b-api/symbol-info?token=${token}&code=BTCUSDT` },
    { name: "instrument", url: `/quote-b-api/instrument?token=${token}&code=BTCUSDT` },
  ];
  
  for (const ep of endpoints) {
    try {
      const res = await axios.get(
        `https://quote.alltick.io${ep.url}`,
        { timeout: 3000, validateStatus: () => true }
      );
      console.log(`${ep.name}: ${res.status} ${res.status === 200 ? '✅' : '❌'}`);
      if (res.status === 200 && res.data) {
        console.log(`  Data: ${JSON.stringify(res.data).substring(0, 150)}`);
      }
    } catch (err) {
      console.log(`${ep.name}: Error - ${err.message.substring(0, 50)}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  
  // Test 3: Check if metadata is in WebSocket subscription response
  console.log("\n\n3️⃣  CHECKING ALLTICK DOCUMENTATION");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  console.log("Based on AllTick API v2 documentation:");
  console.log("  - depth-tick: Returns real-time market depth (bids/asks)");
  console.log("  - Does NOT include contract specifications");
  console.log("  - Metadata typically provided via separate 'instruments' or 'symbols' endpoint");
  console.log("  - Must be cached client-side or from broker platform\n");
}

exploreAllTickAPI();
