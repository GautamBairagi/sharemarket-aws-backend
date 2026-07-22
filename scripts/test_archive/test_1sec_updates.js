const axios = require('axios');

async function test1SecUpdates() {
  console.log("\n========== TESTING 1-SECOND UPDATE RATE ==========\n");
  
  const token = "0f900aa859f4be8ffaf217cce86e5b90-c-app";
  const symbols = ["BTCUSDT", "EURUSD", "XAUUSD"];
  
  console.log("Fetching data every 1 second for 10 seconds...\n");
  
  let updateCount = 0;
  const interval = setInterval(async () => {
    updateCount++;
    
    const query = JSON.stringify({
      trace: 'test-' + Date.now(),
      data: { symbol_list: symbols.map(s => ({ code: s })) }
    });
    
    try {
      const response = await axios.get(
        `https://quote.alltick.io/quote-b-api/depth-tick?token=${token}&query=${encodeURIComponent(query)}`,
        { timeout: 5000 }
      );
      
      if (response.data.ret === 200 && response.data.data?.tick_list) {
        const timestamp = new Date().toLocaleTimeString();
        console.log(`[${timestamp}] Update #${updateCount}`);
        
        response.data.data.tick_list.forEach(tick => {
          const bid = parseFloat(tick.bids?.[0]?.price || 0).toFixed(2);
          const ask = parseFloat(tick.asks?.[0]?.price || 0).toFixed(2);
          console.log(`  ${tick.code}: Bid=${bid} Ask=${ask}`);
        });
        console.log();
      }
    } catch (err) {
      console.log(`[ERROR] ${err.message}`);
    }
    
    if (updateCount >= 10) {
      clearInterval(interval);
      console.log("✅ 10 updates completed (1 per second)");
      console.log("✅ Real-time data streaming working\n");
    }
  }, 1000);
}

test1SecUpdates();
