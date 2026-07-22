const axios = require('axios');

const FASTFOREX_KEY = "2477ea0fda-ba1733037f-tezbgq";

async function testFastForex() {
  const pairs = ["EURINR", "GBPINR"];
  
  console.log("\n=== FASTFOREX TEST ===\n");
  
  for (const pair of pairs) {
    try {
      const url = `https://api.fastforex.io/fetch-one?from=${pair.substring(0,3)}&to=${pair.substring(3)}&api_key=${FASTFOREX_KEY}`;
      const res = await axios.get(url, { timeout: 5000 });
      
      if (res.data && res.data.result) {
        const result = res.data.result;
        console.log(`✓ ${pair}: available`);
        console.log(`  Result keys:`, Object.keys(result));
      } else {
        console.log(`✗ ${pair}: no data`);
      }
    } catch (err) {
      console.log(`✗ ${pair}: ${err.message}`);
    }
  }
}

testFastForex();
