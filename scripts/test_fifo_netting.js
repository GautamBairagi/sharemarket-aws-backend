require('dotenv').config();
const db = require('../src/config/db');
const { placeOrder } = require('../src/controllers/tradeController');

// Helper to wait
const delay = ms => new Promise(resolve => resolve(setTimeout(resolve, ms)));

async function testFifoNetting() {
    console.log('🚀 --- STARTING FIFO NETTING INTEGRATION TEST --- 🚀');
    
    let testUserId = null;
    const testSymbol = 'GOLD_FIFO_TEST';

    try {
        // 1. Create a clean test user
        const username = 'fifo_test_user_' + Math.floor(Math.random() * 1000000);
        console.log(`Creating test user: ${username}...`);
        
        const [userRes] = await db.execute(
            `INSERT INTO users (username, password, role, balance)
             VALUES (?, 'dummy_hash', 'TRADER', 10000000.00)`,
            [username]
        );
        testUserId = userRes.insertId;
        console.log(`✅ Test user created with ID: ${testUserId}`);

        // 2. Setup client settings for user
        const configJson = JSON.stringify({
            mcxBrokerageType: 'per_lot',
            mcxLotBrokerage: {
                'GOLD_FIFO_TEST': 20.00
            }
        });
        await db.execute(
            `INSERT INTO client_settings (user_id, config_json)
             VALUES (?, ?)`,
            [testUserId, configJson]
        );
        console.log(`✅ Client settings configured.`);

        // 3. Setup mock scrip in scrip_data
        // Delete if exists
        await db.execute('DELETE FROM scrip_data WHERE symbol = ?', [testSymbol]);
        await db.execute(
            `INSERT INTO scrip_data (symbol, lot_size, market_type)
             VALUES (?, 100, 'MCX')`,
            [testSymbol]
        );
        console.log(`✅ Scrip metadata configured (lot size = 100).`);

        // Seed prices in MarketDataService
        const marketDataService = require('../src/services/MarketDataService');
        marketDataService.prices[testSymbol] = { ltp: 72000.00, bid: 72000.00, ask: 72000.00, symbol: testSymbol };
        marketDataService.prices[`MCX:${testSymbol}`] = { ltp: 72000.00, bid: 72000.00, ask: 72000.00, symbol: `MCX:${testSymbol}` };
        console.log(`✅ Seeded prices in MarketDataService.`);

        // Helper mock response
        const makeMockRes = () => {
            const res = {
                statusCode: 200,
                body: null
            };
            res.status = (code) => {
                res.statusCode = code;
                return res;
            };
            res.json = (data) => {
                res.body = data;
                return res;
            };
            return res;
        };

        // --- STEP 1: Buy 5 lots of GOLD_FIFO_TEST @ 72,000 ---
        console.log('\n🔵 STEP 1: Buying 5 lots @ ₹72,000');
        const req1 = {
            body: {
                symbol: testSymbol,
                type: 'BUY',
                qty: 5,
                price: 72000.00,
                order_type: 'MARKET',
                is_pending: false,
                userId: testUserId,
                transactionPassword: 'dummy'
            },
            user: {
                id: testUserId,
                role: 'TRADER'
            },
            method: 'POST',
            url: '/api/trades/place',
            headers: { 'content-type': 'application/json' }
        };
        const res1 = makeMockRes();
        await placeOrder(req1, res1);

        console.log('Result 1:', res1.body);
        if (res1.statusCode !== 201) {
            throw new Error(`Step 1 failed with status ${res1.statusCode}: ${JSON.stringify(res1.body)}`);
        }
        const tradeId1 = res1.body.tradeId;

        // Verify Trade 1 in DB
        const [trades1] = await db.execute('SELECT * FROM trades WHERE user_id = ? AND symbol = ?', [testUserId, testSymbol]);
        console.log(`Current Trades in DB (should be 1 OPEN trade, qty=5):`);
        console.table(trades1.map(t => ({ id: t.id, type: t.type, qty: t.qty, entry: t.entry_price, status: t.status })));

        // --- STEP 2: Sell 2 lots of GOLD_FIFO_TEST @ 73,000 (Nets against the 5 lots) ---
        console.log('\n🔵 STEP 2: Selling 2 lots @ ₹73,000 (Should net 2 lots of BUY trade, leaving 3 lots OPEN)');
        const req2 = {
            body: {
                symbol: testSymbol,
                type: 'SELL',
                qty: 2,
                price: 73000.00,
                order_type: 'MARKET',
                is_pending: false,
                userId: testUserId,
                transactionPassword: 'dummy'
            },
            user: {
                id: testUserId,
                role: 'TRADER'
            },
            method: 'POST',
            url: '/api/trades/place',
            headers: { 'content-type': 'application/json' }
        };
        const res2 = makeMockRes();
        await placeOrder(req2, res2);

        console.log('Result 2:', res2.body);
        if (res2.statusCode !== 201) {
            throw new Error(`Step 2 failed with status ${res2.statusCode}: ${JSON.stringify(res2.body)}`);
        }

        // Verify Trades in DB after Step 2
        const [trades2] = await db.execute('SELECT * FROM trades WHERE user_id = ? AND symbol = ? ORDER BY id ASC', [testUserId, testSymbol]);
        console.log(`Current Trades in DB (should be 1 OPEN trade qty=3, and 1 CLOSED trade qty=2 with PnL):`);
        console.table(trades2.map(t => ({
            id: t.id,
            type: t.type,
            qty: t.qty,
            entry: t.entry_price,
            exit: t.exit_price,
            status: t.status,
            pnl: t.pnl,
            brokerage: t.brokerage,
            remark: t.close_remark
        })));

        // PnL check:
        // Closed qty = 2 lots. Lot size = 100.
        // Buy entry = 72000. Sell exit = 73000.
        // PnL = (73000 - 72000) * (2 * 100) = 1000 * 200 = 200,000.
        // Brokerage = 2 lots * 20.00 = 40.
        // Expected balance change = 200,000 - 40 = 199,960.
        const [userRow] = await db.execute('SELECT balance FROM users WHERE id = ?', [testUserId]);
        const finalBalance = parseFloat(userRow[0].balance);
        const expectedBalance = 10000000.00 + 199960.00;
        console.log(`User Balance: Actual = ₹${finalBalance.toFixed(2)}, Expected = ₹${expectedBalance.toFixed(2)}`);
        if (Math.abs(finalBalance - expectedBalance) > 0.01) {
            throw new Error('Balance mismatch!');
        }
        console.log('✅ Balance check passed!');

        // --- STEP 3: Sell 4 lots of GOLD_FIFO_TEST @ 74,000 (Consumes the remaining 3 lots, and leaves 1 lot SELL open) ---
        console.log('\n🔵 STEP 3: Selling 4 lots @ ₹74,000 (Should consume the remaining 3 lots of BUY trade, and create a new 1 lot SELL trade)');
        const req3 = {
            body: {
                symbol: testSymbol,
                type: 'SELL',
                qty: 4,
                price: 74000.00,
                order_type: 'MARKET',
                is_pending: false,
                userId: testUserId,
                transactionPassword: 'dummy'
            },
            user: {
                id: testUserId,
                role: 'TRADER'
            },
            method: 'POST',
            url: '/api/trades/place',
            headers: { 'content-type': 'application/json' }
        };
        const res3 = makeMockRes();
        await placeOrder(req3, res3);

        console.log('Result 3:', res3.body);
        if (res3.statusCode !== 201) {
            throw new Error(`Step 3 failed with status ${res3.statusCode}: ${JSON.stringify(res3.body)}`);
        }

        // Verify Trades in DB after Step 3
        const [trades3] = await db.execute('SELECT * FROM trades WHERE user_id = ? AND symbol = ? ORDER BY id ASC', [testUserId, testSymbol]);
        console.log(`Current Trades in DB (should have two CLOSED BUY trades (qty=2 and qty=3), and one OPEN SELL trade (qty=1)):`);
        console.table(trades3.map(t => ({
            id: t.id,
            type: t.type,
            qty: t.qty,
            entry: t.entry_price,
            exit: t.exit_price,
            status: t.status,
            pnl: t.pnl,
            brokerage: t.brokerage,
            remark: t.close_remark
        })));

        // PnL check for Step 3:
        // Closed qty = 3 lots. Lot size = 100.
        // Buy entry = 72000. Sell exit = 74000.
        // PnL = (74000 - 72000) * (3 * 100) = 2000 * 300 = 600,000.
        // Brokerage = 3 lots * 20.00 = 60.
        // Expected balance change = 600,000 - 60 = 599,940.
        // Total expected balance = 10000000.00 + 199960.00 + 599940.00 = 10,799,900.00
        const [userRow2] = await db.execute('SELECT balance FROM users WHERE id = ?', [testUserId]);
        const finalBalance2 = parseFloat(userRow2[0].balance);
        const expectedBalance2 = 10799900.00;
        console.log(`User Balance: Actual = ₹${finalBalance2.toFixed(2)}, Expected = ₹${expectedBalance2.toFixed(2)}`);
        if (Math.abs(finalBalance2 - expectedBalance2) > 0.01) {
            throw new Error('Balance mismatch after Step 3!');
        }
        console.log('✅ Balance check 2 passed!');

        // Verify paper_positions
        const [positions] = await db.execute('SELECT * FROM paper_positions WHERE user_id = ? AND symbol = ?', [testUserId, testSymbol]);
        console.log(`Current Paper Positions in DB (should be -1 quantity @ 74000 average price):`);
        console.table(positions);
        if (positions.length !== 1 || parseFloat(positions[0].quantity) !== -1) {
            throw new Error('Paper position mismatch!');
        }
        console.log('✅ Paper position check passed!');

        console.log('\n🎉 ALL FIFO NETTING TESTS PASSED SUCCESSFULLY! 🎉');

    } catch (err) {
        console.error('❌ TEST FAILED:', err);
    } finally {
        // Cleanup test data
        if (testUserId) {
            console.log('\nCleaning up test data...');
            await db.execute('DELETE FROM trades WHERE user_id = ?', [testUserId]);
            await db.execute('DELETE FROM client_settings WHERE user_id = ?', [testUserId]);
            await db.execute('DELETE FROM paper_positions WHERE user_id = ?', [testUserId]);
            await db.execute('DELETE FROM users WHERE id = ?', [testUserId]);
            await db.execute('DELETE FROM scrip_data WHERE symbol = ?', [testSymbol]);
            console.log('Cleanup completed successfully.');
        }
        process.exit(0);
    }
}

testFifoNetting();
