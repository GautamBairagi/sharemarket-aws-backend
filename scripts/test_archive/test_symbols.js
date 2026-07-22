const axios = require('axios');

const token = "0f900aa859f4be8ffaf217cce86e5b90-c-app";
const testSymbols = {
  "missing_forex": ["EURINR", "GBPINR"],
  "missing_metals": ["XAGUSD"],
  "missing_crypto": ["MATICUSDT"]
};

async function testAllTicks() {
  const allSymbols = [...testSymbols.missing_forex, ...testSymbols.missing_metals, ...testSymbols.missing_crypto];
  
  const query = JSON.stringify({
    trace: 'test-' + Date.now(),
    data: { symbol_list: allSymbols.map(s => ({ code: s })) }
  });
  
  const url = `https://quote.alltick.io/quote-b-api/depth-tick?token=${token}&query=${encodeURIComponent(query)}`;
  
  try {
    const res = await axios.get(url, { timeout: 5000 });
    
    console.log("\n=== ALLTICKS TEST RESULTS ===\n");
    if (res.data.ret === 200 && res.data.data?.tick_list) {
      const ticks = res.data.data.tick_list;
      if (ticks.length === 0) {
        console.log("❌ AllTicks returned NO data for these symbols");
        allSymbols.forEach(s => console.log(`  ✗ ${s}`));
      } else {
        ticks.forEach(tick => {
          const hasBid = tick.bids?.[0]?.price;
          const hasAsk = tick.asks?.[0]?.price;
          const status = hasBid && hasAsk ? '✓' : '✗';
          console.log(`  ${status} ${tick.code}: bid=${hasBid || 'N/A'} ask=${hasAsk || 'N/A'}`);
        });
      }
    } else {
      console.log(`❌ Error: ret=${res.data.ret}`);
    }
  } catch (err) {
    console.log("❌ AllTicks API error:", err.message);
  }
}

testAllTicks();
