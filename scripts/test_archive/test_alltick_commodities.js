const axios = require('axios');

async function testCommodities() {
  const token = "0f900aa859f4be8ffaf217cce86e5b90-c-app";
  const symbols = ["GOLD", "Silver", "SILVER", "USOIL", "NGAS", "XAUUSD", "XAGUSD"];
  
  console.log("\n========== ALLTICKS COMMODITIES TEST ==========\n");
  
  for (const symbol of symbols) {
    const query = JSON.stringify({
      trace: 'test-' + Date.now(),
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
        console.log(`  ✅ DATA FOUND:`, JSON.stringify(res.data.data.tick_list[0], null, 2));
      } else {
        console.log(`  ❌ No tick_list data`);
      }
    } catch (err) {
      console.log(`${symbol}: Error -`, err.message);
    }
    console.log("----------------------------------------\n");
    await new Promise(r => setTimeout(r, 500));
  }
}

testCommodities();
