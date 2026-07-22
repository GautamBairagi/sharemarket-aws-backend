========== ALLTICK METADATA - COMPREHENSIVE ANALYSIS ==========

PLAN LIMITATIONS ($199):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

AllTick API Endpoints Status:
┌──────────────────────────┬──────────┬──────────────────────┐
│ Endpoint                 │ Status   │ Your Plan Access     │
├──────────────────────────┼──────────┼──────────────────────┤
│ /depth-tick              │ ✅ 200   │ ✅ YES (Working)     │
│ /tick                    │ 402      │ ❌ Plan Limited      │
│ /quote                   │ 402      │ ❌ Plan Limited      │
│ /instrument              │ 402      │ ❌ Plan Limited      │
│ /instruments             │ 402      │ ❌ Plan Limited      │
│ /symbols                 │ 402      │ ❌ Plan Limited      │
│ /symbol-info             │ 402      │ ❌ Plan Limited      │
│ /contract                │ 402      │ ❌ Plan Limited      │
│ /search                  │ 402      │ ❌ Plan Limited      │
│ /filter                  │ 402      │ ❌ Plan Limited      │
│ /kline / /bars           │ 402      │ ❌ Plan Limited      │
│ /market-info             │ 402      │ ❌ Plan Limited      │
│ /categories              │ 402      │ ❌ Plan Limited      │
│ /exchanges               │ 402      │ ❌ Plan Limited      │
└──────────────────────────┴──────────┴──────────────────────┘

VERDICT: ❌ NO METADATA AVAILABLE FROM ALLTICK

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

WEBSOCKET ALTERNATIVES:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

cmd_id 22998 (Tick Push)
  Response: { code, bids, asks, tick_time, seq }
  Contains: Price data ONLY ❌ No metadata

cmd_id 22005 (Subscription Ack)
  Response: { code, status: "subscribed" }
  Contains: Subscription confirmation ONLY ❌ No metadata

cmd_id 22001 (Heartbeat Pong)
  Response: Empty/minimal
  Contains: Nothing useful ❌

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

THIRD-PARTY SOURCES FOR METADATA:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Since AllTick doesn't provide metadata, you need EXTERNAL sources:

CRYPTO (Binance API - FREE):
  Source: https://api.binance.com/api/v3/exchangeInfo
  Provides: 
    ✓ Lot size (minQty, maxQty, stepSize)
    ✓ Price precision (pricePrecision)
    ✓ Quantity precision (quantityPrecision)
    ✓ Min notional value
    
FOREX (Standards - NO API):
  Source: Industry standards (hardcode)
  Values:
    ✓ Lot size: 100,000 units (standard)
    ✓ Pip value: 0.0001 (standard)
    ✓ Multiplier: 1x (standard)
    
METALS (Spot Specs - NO API):
  Source: Commodity standards (hardcode)
  Values:
    ✓ Unit: 1 troy ounce
    ✓ Tick: 0.01 USD
    ✓ Multiplier: 1x

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

RECOMMENDED APPROACH FOR YOUR APP:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Create "instrument_specs" table in your database:

   Crypto:
   ├─ symbol: BTCUSDT
   ├─ asset_class: CRYPTO
   ├─ tick_size: 0.01
   ├─ qty_precision: 8
   ├─ lot_size: 1
   └─ multiplier: 1
   
   Forex:
   ├─ symbol: EURUSD
   ├─ asset_class: FOREX
   ├─ tick_size: 0.0001
   ├─ qty_precision: 2
   ├─ lot_size: 100000
   └─ multiplier: 1
   
   Metals:
   ├─ symbol: XAUUSD
   ├─ asset_class: METAL
   ├─ tick_size: 0.01
   ├─ qty_precision: 2
   ├─ lot_size: 1
   └─ multiplier: 1

2. Link AllTick price data with your spec data at trade time

3. Use this for PnL calculations

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SAMPLE CODE STRUCTURE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Get AllTick price (from depth-tick)
const price = alltick.getPrice("BTCUSDT"); 

// Get metadata (from YOUR database)
const spec = db.getInstrumentSpec("BTCUSDT");

// Calculate PnL
const pnl = (exit_price - entry_price) 
  × quantity 
  × spec.multiplier;

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ANSWER TO YOUR QUESTION:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Q: Kuch dusre endpoint se ata he kya?
(Is it available from any other endpoint?)

A: ❌ NAH... AllTick $199 plan SIRF depth-tick deta hai.
   
   - instrument, symbols, contract, search - sab 402 (blocked)
   - WebSocket - sirf prices, no metadata
   - Aur kisi API se nahi ata
   
   → You MUST use external sources or hardcode specs
   → AllTick = PRICES ONLY
   → Metadata = YOUR responsibility

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

