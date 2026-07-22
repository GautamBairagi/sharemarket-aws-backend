const db = require('../config/db');
const marketDataService = require('../services/MarketDataService');
const { getMcxBaseScrip } = require('../utils/symbolHelper');
const MarginUtils = require('../utils/MarginUtils');

/**
 * Live Market Prices (Snapshot)
 */
const getLiveMarket = async (req, res) => {
    try {
        const prices = marketDataService.prices;
        res.json(prices);
    } catch (err) {
        console.error('getLiveMarket Error:', err);
        res.status(500).send('Server Error');
    }
};

const instrumentService = require('../services/InstrumentService');
const kiteService = require('../utils/kiteService');

const syncPricesForTrades = async (trades) => {
    try {
        const openSymbols = new Set();
        trades.forEach(t => {
            if (t.status === 'OPEN' && t.symbol) {
                openSymbols.add(t.symbol.toUpperCase());
            }
        });

        if (openSymbols.size === 0) return;

        const symbolsArr = Array.from(openSymbols);

        // 1. Subscribe in live ticker so we get future updates
        const instrumentsBySymbol = await instrumentService.getInstrumentsBySymbols(symbolsArr);
        symbolsArr.forEach(symbol => {
            const inst = instrumentsBySymbol.get(symbol);
            if (inst) {
                marketDataService.subscribe(symbol, inst.instrument_token);
            }
        });

        // 2. Fetch missing prices from REST API if Kite is connected
        const missingSymbols = symbolsArr.filter(s => !marketDataService.getPrice(s));
        if (missingSymbols.length > 0 && kiteService.isAuthenticated()) {
            console.log(`📡 Dashboard: Fetching quotes for ${missingSymbols.length} symbols...`);
            try {
                const quotes = await kiteService.getQuote(missingSymbols);
                // Seed the cache with REST data so the first load isn't zero
                Object.keys(quotes).forEach(sym => {
                    const q = quotes[sym];
                    if (!marketDataService.prices[sym]) {
                        marketDataService.prices[sym] = {
                            ltp: q.last_price,
                            bid: q.buy_quantity > 0 ? q.depth.buy[0].price : q.last_price,
                            ask: q.sell_quantity > 0 ? q.depth.sell[0].price : q.last_price,
                            change: q.net_change,
                            timestamp: new Date()
                        };
                    }
                });
            } catch (err) {
                console.warn('Dashboard getQuote fallback failed:', err.message);
            }
        }
    } catch (err) {
        console.error('syncPricesForTrades error:', err);
    }
};

/**
 * Superadmin Dashboard - Dynamic Implementation
 * Returns: { clients: [], stats: { buyTurnover, sellTurnover, totalTurnover, activeUsers, profitLoss, brokerage } }
 */
const getClientLiveM2M = async (req, res) => {
    try {
        const { id: userId, role } = req.user;
        const filterUserId = req.query.userId || req.query.id;

        let filterUserRole = null;
        if (filterUserId) {
            const [userRows] = await db.execute('SELECT role FROM users WHERE id = ?', [filterUserId]);
            if (userRows.length > 0) {
                filterUserRole = userRows[0].role;
            }
        }

        let isBrokerList = false;
        let brokers = [];
        let clientToBrokerMap = {};

        // 1. Fetch all relevant trades (Non-Deleted)
        let tradeQuery = `
            SELECT t.*, u.username, u.full_name, u.role as user_role, u.balance, u.is_demo, cs.config_json as user_config
            FROM trades t
            JOIN users u ON t.user_id = u.id
            LEFT JOIN client_settings cs ON u.id = cs.user_id
            WHERE t.status != 'DELETED'
        `;
        let tradeParams = [];

        if ((role === 'SUPERADMIN' || role === 'ADMIN') && !filterUserId) {
            isBrokerList = true;
            let brokerQuery = "SELECT id, username, full_name, role FROM users WHERE role = 'BROKER'";
            let brokerParams = [];
            if (role === 'ADMIN') {
                brokerQuery = "SELECT id, username, full_name, role FROM users WHERE role = 'BROKER' AND parent_id = ?";
                brokerParams.push(userId);
            } else if (role === 'SUPERADMIN') {
                brokerQuery = "SELECT id, username, full_name, role FROM users WHERE role IN ('BROKER', 'ADMIN')";
            }
            const [bRows] = await db.execute(brokerQuery, brokerParams);
            brokers = bRows;

            const brokerIds = brokers.map(b => b.id);

            if (role === 'ADMIN') {
                tradeQuery += ` AND (t.created_by = ? OR t.user_id = ? OR cs.broker_id = ? OR cs.broker_id IN (${brokerIds.length > 0 ? brokerIds.join(',') : '-1'}) OR t.user_id IN (${brokerIds.length > 0 ? brokerIds.join(',') : '-1'}))`;
                tradeParams.push(userId, userId, userId);
            }
        } else if (filterUserId) {
            if (filterUserRole === 'ADMIN') {
                isBrokerList = true;
                const [bRows] = await db.execute(
                    "SELECT id, username, full_name, role FROM users WHERE role = 'BROKER' AND parent_id = ?",
                    [filterUserId]
                );
                brokers = bRows;

                tradeQuery += ` AND (t.user_id IN (
                    SELECT u.id FROM users u
                    LEFT JOIN client_settings cs ON cs.user_id = u.id
                    WHERE u.role = 'TRADER' AND (
                        u.parent_id IN (SELECT id FROM users WHERE parent_id = ? AND role = 'BROKER')
                        OR cs.broker_id IN (SELECT id FROM users WHERE parent_id = ? AND role = 'BROKER')
                    )
                ) OR t.user_id = ? OR t.user_id IN (SELECT id FROM users WHERE parent_id = ? AND role = 'BROKER'))`;
                tradeParams.push(filterUserId, filterUserId, filterUserId, filterUserId);
            } else if (filterUserRole === 'BROKER') {
                tradeQuery += ` AND (t.user_id IN (
                    SELECT u.id FROM users u
                    LEFT JOIN client_settings cs ON cs.user_id = u.id
                    WHERE u.role = 'TRADER' AND (
                        u.parent_id = ?
                        OR cs.broker_id = ?
                    )
                ) OR t.user_id = ?)`;
                tradeParams.push(filterUserId, filterUserId, filterUserId);
            } else {
                tradeQuery += ' AND t.user_id = ?';
                tradeParams.push(filterUserId);
            }
        } else if (role === 'BROKER') {
            tradeQuery += ' AND (t.created_by = ? OR t.user_id = ? OR cs.broker_id = ?)';
            tradeParams.push(userId, userId, userId);
        } else {
            tradeQuery += ' AND t.user_id = ?';
            tradeParams.push(userId);
        }

        const [trades] = await db.execute(tradeQuery, tradeParams);

        // --- NEW: Sync prices for all open trades found ---
        await syncPricesForTrades(trades);

        // 2. Fetch Multipliers (Lot Sizes) from scrip_data
        const [lotRows] = await db.execute('SELECT symbol, lot_size FROM scrip_data');
        const lotMap = {};
        lotRows.forEach(r => {
            lotMap[r.symbol.toUpperCase()] = parseFloat(r.lot_size || 1);
        });

        const MCX_LOT_SIZES = {
            'GOLD': 100, 'GOLDM': 10, 'GOLDGUINEA': 8, 'GOLDPETAL': 1,
            'SILVER': 30, 'SILVERM': 5, 'SILVERMIC': 1,
            'CRUDEOIL': 100, 'CRUDEOILM': 10,
            'NATURALGAS': 1250, 'NATURALGASM': 125, 'NATGASMINI': 250,
            'COPPER': 2500, 'COPPERM': 250,
            'ZINC': 5000, 'ZINCMINI': 1000,
            'LEAD': 5000, 'LEADMINI': 1000,
            'NICKEL': 1500, 'NICKELMINI': 100,
            'ALUMINIUM': 5000, 'ALUMINI': 1000, 'ALUMINIUMM': 1000,
            'MENTHAOIL': 360, 'COTTON': 25, 'BULLDEX': 1,
        };

        const getMultiplier = (symbol, marketType, userConfig = null) => {
            const sym = symbol.toUpperCase();
            const mType = (marketType || 'MCX').toUpperCase();

            // 1. NSE/Equity/Options/NFO generally use point-to-point (multiplier 1)
            if (mType === 'EQUITY' || mType === 'NSE' || mType === 'NFO' || mType === 'OPTIONS') {
                return 1;
            }

            // 2. Try Hardcoded MCX_LOT_SIZES (Point Values)
            // CRITICAL SYNC: The mobile app uses hardcoded multipliers for P/L.
            // We follow the same logic here to ensure cross-platform consistency.
            const base = getMcxBaseScrip(symbol);
            if (base && MCX_LOT_SIZES[base]) return MCX_LOT_SIZES[base];

            // Try trimmed symbol (e.g. SILVER26MAYFUT -> SILVER)
            const symTrimmed = symbol.split(':').pop().toUpperCase().replace(/\d+.*/, '');
            if (MCX_LOT_SIZES[symTrimmed]) return MCX_LOT_SIZES[symTrimmed];

            // NOTE: mcxLotMargins[scrip].LOT is the per-user position LIMIT (max lots allowed),
            // NOT the exchange lot size. It must never be used as a P&L/turnover multiplier.
            // Skipping that fallback intentionally.

            // 4. Try Scrip Data Table (Fallback)
            const cleanSym = symbol.includes(':') ? symbol.split(':')[1] : symbol;
            if (lotMap[cleanSym.toUpperCase()] && lotMap[cleanSym.toUpperCase()] > 0) return lotMap[cleanSym.toUpperCase()];

            return 1; // Default fallback
        };

        // 3. Map for MarketDataService prefixes
        const PREFIX_MAP = {
            'EQUITY': 'NSE',
            'NFO': 'NFO',
            'MCX': 'MCX',
            'OPTIONS': 'NFO',
            'CRYPTO': 'CRYPTO',
            'FOREX': 'FOREX',
            'COMEX': 'COMEX',
            'COMMODITY': 'FOREX'
        };

        const finalizedStats = {
            buyTurnover: { mcx: '0.00', nse: '0.00', options: '0.00', comex: '0.00', forex: '0.00', crypto: '0.00' },
            sellTurnover: { mcx: '0.00', nse: '0.00', options: '0.00', comex: '0.00', forex: '0.00', crypto: '0.00' },
            totalTurnover: { mcx: '0.00', nse: '0.00', options: '0.00', comex: '0.00', forex: '0.00', crypto: '0.00' },
            profitLoss: { mcx: '0.00', nse: '0.00', options: '0.00', comex: '0.00', forex: '0.00', crypto: '0.00' },
            activeUsers: { mcx: 0, nse: 0, options: 0, comex: 0, forex: 0, crypto: 0 },
            brokerage: { mcx: '0.00', nse: '0.00', options: '0.00', comex: '0.00', forex: '0.00', crypto: '0.00' },
            activeBuy: { mcx: 0, nse: 0, options: 0, comex: 0, forex: 0, crypto: 0 },
            activeSell: { mcx: 0, nse: 0, options: 0, comex: 0, forex: 0, crypto: 0 }
        };

        const stats = {
            buyTurnover: {}, sellTurnover: {}, totalTurnover: {}, activeUsers: {}, profitLoss: {}, brokerage: {},
            activeBuy: { mcx: 0, nse: 0, options: 0, comex: 0, forex: 0, crypto: 0 },
            activeSell: { mcx: 0, nse: 0, options: 0, comex: 0, forex: 0, crypto: 0 }
        };

        const segments = ['mcx', 'nse', 'options', 'comex', 'forex', 'crypto'];
        segments.forEach(s => {
            stats.buyTurnover[s] = 0; stats.sellTurnover[s] = 0; stats.totalTurnover[s] = 0;
            stats.activeUsers[s] = new Set(); stats.profitLoss[s] = 0; stats.brokerage[s] = 0;
        });

        const brokerStatsMap = {};
        const clientParents = {};
        const userParentMap = {};
        const userRoleMap = {};

        if (isBrokerList) {
            brokers.forEach(b => {
                brokerStatsMap[b.id] = {
                    id: b.id,
                    username: b.username,
                    fullName: b.full_name,
                    role: b.role,
                    activePL: 0,
                    activeTrades: 0,
                    closedPL: 0,
                    margin: 0,
                    marginUsed: 0
                };
            });

            // Load hierarchy
            const [allUsers] = await db.execute("SELECT id, role, parent_id FROM users");
            allUsers.forEach(u => {
                userParentMap[u.id] = u.parent_id;
                userRoleMap[u.id] = u.role;
            });

            const [clientBrokerRows] = await db.execute(`
                SELECT u.id as client_id, u.parent_id as client_parent_id, cs.broker_id as assigned_broker_id
                FROM users u
                LEFT JOIN client_settings cs ON u.id = cs.user_id
                WHERE u.role = 'TRADER'
            `);

            clientBrokerRows.forEach(row => {
                let brokerId = row.assigned_broker_id || row.client_parent_id;
                let adminId = null;
                if (brokerId) {
                    if (userRoleMap[brokerId] === 'ADMIN') {
                        adminId = brokerId;
                        brokerId = null;
                    } else if (userRoleMap[brokerId] === 'BROKER') {
                        const parentOfBroker = userParentMap[brokerId];
                        if (parentOfBroker && userRoleMap[parentOfBroker] === 'ADMIN') {
                            adminId = parentOfBroker;
                        }
                    }
                }
                clientParents[row.client_id] = { brokerId, adminId };
            });
        }

        const clientMap = {};

        // Pre-populate clientMap for Broker / Admin / Superadmin so all clients appear even with 0 trades
        if (!isBrokerList) {
            let clientsToFetchQuery = '';
            let clientsToFetchParams = [];

            if (filterUserId && (filterUserRole === 'BROKER' || filterUserRole === 'ADMIN')) {
                clientsToFetchQuery = `
                    SELECT u.id, u.username, u.balance
                    FROM users u
                    LEFT JOIN client_settings cs ON cs.user_id = u.id
                    WHERE u.role = 'TRADER' AND (
                        u.parent_id = ?
                        OR cs.broker_id = ?
                    )
                `;
                clientsToFetchParams = [filterUserId, filterUserId];
            } else if (!filterUserId && role === 'BROKER') {
                clientsToFetchQuery = `
                    SELECT u.id, u.username, u.balance
                    FROM users u
                    LEFT JOIN client_settings cs ON cs.user_id = u.id
                    WHERE u.role = 'TRADER' AND (
                        u.parent_id = ?
                        OR cs.broker_id = ?
                    )
                `;
                clientsToFetchParams = [userId, userId];
            }

            if (clientsToFetchQuery) {
                const [cRows] = await db.execute(clientsToFetchQuery, clientsToFetchParams);
                cRows.forEach(c => {
                    clientMap[c.id] = {
                        id: c.id,
                        username: c.username,
                        activePL: 0,
                        activeTrades: 0,
                        margin: 0,
                        marginUsed: 0,
                        balance: parseFloat(c.balance || 0),
                        positions: {}
                    };
                });
            }
        }

        const isSingleTraderRequest = (role === 'TRADER') || (filterUserId && filterUserRole === 'TRADER');

        trades.forEach(trade => {
            // Exclude demo trades for global aggregations / broker dashboards
            if (trade.is_demo === 1 && !isSingleTraderRequest) {
                return;
            }

            const mType = (trade.market_type || 'MCX').toUpperCase();
            let segment = mType === 'EQUITY' ? 'nse' : mType.toLowerCase();

            if (mType === 'NFO' || mType === 'OPTIONS') {
                const sym = trade.symbol.toUpperCase();
                if (sym.endsWith('CE') || sym.endsWith('PE') || /\d{5,}/.test(sym)) {
                    segment = 'options';
                } else {
                    segment = 'nse';
                }
            }

            // Map commodity to forex stats since frontend dashboard doesn't have commodity tab
            if (segment === 'commodity') {
                segment = 'forex';
            }

            const isBuy = trade.type === 'BUY';
            const qty = Math.abs(trade.qty);
            const entryPrice = parseFloat(trade.entry_price || 0);

            // Parse user config if available
            let userConfig = null;
            if (trade.user_config) {
                try {
                    userConfig = typeof trade.user_config === 'string' ? JSON.parse(trade.user_config) : trade.user_config;
                } catch (e) {
                    console.error('Failed to parse user config for P/L calculation:', e);
                }
            }

            const lotSize = getMultiplier(trade.symbol, mType, userConfig);

            // App Sync logic: 
            // For MCX, totalUnits is ALWAYS qty * multiplier (lotSize)
            // For NSE, qty is already the number of units/shares.
            let totalUnits = qty * lotSize;

            // Fallback to actual_qty only for non-MCX if it exists
            if (mType !== 'MCX' && trade.actual_qty && parseFloat(trade.actual_qty) > 0) {
                totalUnits = parseFloat(trade.actual_qty);
            }

            const tradeValue = entryPrice * totalUnits;

            if (isBuy) stats.buyTurnover[segment] += tradeValue;
            else stats.sellTurnover[segment] += tradeValue;
            stats.totalTurnover[segment] += tradeValue;

            stats.brokerage[segment] += parseFloat(trade.brokerage || 0);



            if (trade.status === 'CLOSED') {
                const rawClosedPnl = parseFloat(trade.pnl || 0);
                const netClosedPnl = (parseFloat(trade.pnl || 0) - parseFloat(trade.brokerage || 0) - parseFloat(trade.swap || 0));
                stats.profitLoss[segment] += netClosedPnl;

                if (isBrokerList) {
                    if (trade.user_role === 'ADMIN' || trade.user_role === 'BROKER') {
                        const uId = trade.user_id;
                        if (brokerStatsMap[uId]) {
                            brokerStatsMap[uId].closedPL += rawClosedPnl;
                        }
                        if (trade.user_role === 'BROKER') {
                            const parentId = userParentMap[uId];
                            if (parentId && brokerStatsMap[parentId]) {
                                brokerStatsMap[parentId].closedPL += rawClosedPnl;
                            }
                        }
                    } else {
                        const parents = clientParents[trade.user_id];
                        if (parents) {
                            const { brokerId, adminId } = parents;
                            if (brokerId && brokerStatsMap[brokerId]) {
                                brokerStatsMap[brokerId].closedPL += rawClosedPnl;
                            }
                            if (adminId && brokerStatsMap[adminId]) {
                                brokerStatsMap[adminId].closedPL += rawClosedPnl;
                            }
                        }
                    }
                } else if (trade.user_role === 'TRADER') {
                    if (!clientMap[trade.user_id]) {
                        clientMap[trade.user_id] = {
                            id: trade.user_id, username: trade.username,
                            activePL: 0, activeTrades: 0, closedPL: 0, margin: 0, marginUsed: 0, balance: parseFloat(trade.balance || 0)
                        };
                    }
                    clientMap[trade.user_id].closedPL += rawClosedPnl;
                }
            }

            if (trade.status === 'OPEN' && !trade.is_pending) {
                stats.activeUsers[segment].add(trade.user_id);
                if (isBuy) stats.activeBuy[segment] += 1;
                else stats.activeSell[segment] += 1;

                const prefix = PREFIX_MAP[mType] || mType;
                const cleanSymbol = trade.symbol.includes(':') ? trade.symbol.split(':')[1] : trade.symbol;

                // 🎯 Try multiple symbol patterns to find the live price in the ticker
                const searchPatterns = [
                    trade.symbol,                                      // 1. Raw symbol (e.g. "NFO:NIFTY26MAYFUT")
                    `${prefix}:${cleanSymbol}`,                        // 2. Mapped prefix + clean symbol (e.g. "NFO:NIFTY26MAYFUT")
                    cleanSymbol,                                       // 3. Just clean symbol (e.g. "NIFTY26MAYFUT")
                    cleanSymbol.replace(/FUT$/i, ''),                  // 4. Normalized (e.g. "NIFTY26MAY")
                    `${prefix}:${cleanSymbol.replace(/FUT$/i, '')}`,    // 5. Prefixed Normalized (e.g. "NFO:NIFTY26MAY")
                    `NSE:${cleanSymbol}`,                              // 6. Force NSE (for EQUITY)
                    `NFO:${cleanSymbol}`,                              // 7. Force NFO (for Futures)
                    `MCX:${cleanSymbol}`                               // 8. Force MCX
                ];

                let liveData = null;
                for (const pattern of searchPatterns) {
                    liveData = marketDataService.getPrice(pattern);
                    if (liveData) break;
                }

                // 🔍 Fuzzy match fallback: if exact lookup fails, try matching by base symbol prefix in cache
                if (!liveData) {
                    const baseSym = cleanSymbol.toUpperCase().replace(/\d+.*/, ''); // E.g., get "GOLD" from "GOLD26JUNFUT" or "GOLD"
                    if (baseSym) {
                        const allPrices = marketDataService.prices;
                        // Try matching with same prefix first (e.g. MCX to MCX)
                        for (const key of Object.keys(allPrices)) {
                            const cleanKey = key.includes(':') ? key.split(':')[1] : key;
                            const keyPrefix = key.includes(':') ? key.split(':')[0] : '';
                            if (cleanKey.toUpperCase().startsWith(baseSym) && (!prefix || keyPrefix.toUpperCase() === prefix.toUpperCase())) {
                                liveData = allPrices[key];
                                break;
                            }
                        }
                        // If still not found, try matching any available prefix (e.g. COMMODITY:GOLD as fallback for MCX)
                        if (!liveData) {
                            for (const key of Object.keys(allPrices)) {
                                const cleanKey = key.includes(':') ? key.split(':')[1] : key;
                                if (cleanKey.toUpperCase().startsWith(baseSym)) {
                                    liveData = allPrices[key];
                                    break;
                                }
                            }
                        }
                    }
                }

                // Use BID for BUY trades (exit by selling) and ASK for SELL trades (exit by buying)
                const exitPrice = isBuy
                    ? (liveData?.bid || liveData?.ltp || entryPrice)
                    : (liveData?.ask || liveData?.ltp || entryPrice);

                // Diagnostic Log
                if (mType === 'MCX' || trade.symbol.includes('GOLD')) {
                    const source = liveData ? 'LIVE' : 'FALLBACK';
                    console.log(`📊 [Realtime P/L] ${trade.symbol} | mType: ${mType} | Exit: ${exitPrice} (${source})`);
                }

                let unrealizedPnl = 0;
                const commodityLotService = require('../services/CommodityLotService');
                if (commodityLotService.isCommodityScrip(trade.symbol, mType)) {
                    const calc = commodityLotService.calculatePnL(trade.symbol, trade.type, entryPrice, exitPrice, qty);
                    unrealizedPnl = calc.pnlInr;
                } else {
                    unrealizedPnl = isBuy
                        ? (exitPrice - entryPrice) * totalUnits
                        : (entryPrice - exitPrice) * totalUnits;
                }

                if (isBrokerList) {
                    if (trade.user_role === 'ADMIN' || trade.user_role === 'BROKER') {
                        const uId = trade.user_id;
                        if (brokerStatsMap[uId]) {
                            brokerStatsMap[uId].activePL += unrealizedPnl;
                            brokerStatsMap[uId].activeTrades += 1;
                        }
                        if (trade.user_role === 'BROKER') {
                            const parentId = userParentMap[uId];
                            if (parentId && brokerStatsMap[parentId]) {
                                brokerStatsMap[parentId].activePL += unrealizedPnl;
                                brokerStatsMap[parentId].activeTrades += 1;
                            }
                        }
                    } else {
                        const parents = clientParents[trade.user_id];
                        if (parents) {
                            const { brokerId, adminId } = parents;
                            if (brokerId && brokerStatsMap[brokerId]) {
                                brokerStatsMap[brokerId].activePL += unrealizedPnl;
                                brokerStatsMap[brokerId].activeTrades += 1;
                            }
                            if (adminId && brokerStatsMap[adminId]) {
                                brokerStatsMap[adminId].activePL += unrealizedPnl;
                                brokerStatsMap[adminId].activeTrades += 1;
                            }
                        }
                    }
                }

                // --- Dynamic Margin Calculation (matching Mobile App Portfolio) ---
                const MarginUtils = require('../utils/MarginUtils');
                trade.lot_size = lotSize;
                const dynamicMargin = MarginUtils.calculateTotalRequiredHoldingMargin([trade], userConfig);

                if (isBrokerList) {
                    if (trade.user_role === 'ADMIN' || trade.user_role === 'BROKER') {
                        const uId = trade.user_id;
                        if (brokerStatsMap[uId]) {
                            brokerStatsMap[uId].margin += dynamicMargin;
                            brokerStatsMap[uId].marginUsed += parseFloat(trade.margin_used || 0);
                        }
                        if (trade.user_role === 'BROKER') {
                            const parentId = userParentMap[uId];
                            if (parentId && brokerStatsMap[parentId]) {
                                brokerStatsMap[parentId].margin += dynamicMargin;
                                brokerStatsMap[parentId].marginUsed += parseFloat(trade.margin_used || 0);
                            }
                        }
                    } else {
                        const parents = clientParents[trade.user_id];
                        if (parents) {
                            const { brokerId, adminId } = parents;
                            if (brokerId && brokerStatsMap[brokerId]) {
                                brokerStatsMap[brokerId].margin += dynamicMargin;
                                brokerStatsMap[brokerId].marginUsed += parseFloat(trade.margin_used || 0);
                            }
                            if (adminId && brokerStatsMap[adminId]) {
                                brokerStatsMap[adminId].margin += dynamicMargin;
                                brokerStatsMap[adminId].marginUsed += parseFloat(trade.margin_used || 0);
                            }
                        }
                    }
                } else if (trade.user_role === 'TRADER') {
                    if (!clientMap[trade.user_id]) {
                        clientMap[trade.user_id] = {
                            id: trade.user_id, username: trade.username,
                            activePL: 0, activeTrades: 0, closedPL: 0, margin: 0, marginUsed: 0, balance: parseFloat(trade.balance || 0)
                        };
                    }
                    clientMap[trade.user_id].activePL += unrealizedPnl;
                    clientMap[trade.user_id].activeTrades += 1;

                    // --- Individual Position Tracking (for detail view) ---
                    if (filterUserId) {
                        if (!clientMap[trade.user_id].positions) clientMap[trade.user_id].positions = {};
                        const sym = trade.symbol;
                        if (!clientMap[trade.user_id].positions[sym]) {
                            clientMap[trade.user_id].positions[sym] = {
                                symbol: sym,
                                buyQty: 0, sellQty: 0, buyTotal: 0, sellTotal: 0,
                                actualBuyQty: 0, actualSellQty: 0,
                                pnl: 0, margin: 0, marginUsed: 0, cmp: exitPrice,
                                type: trade.type, avgPrice: 0
                            };
                        }
                        const p = clientMap[trade.user_id].positions[sym];
                        if (isBuy) { 
                            p.buyQty += qty; 
                            p.buyTotal += entryPrice * qty;
                            p.actualBuyQty += parseFloat(trade.actual_qty || 0);
                        }
                        else { 
                            p.sellQty += qty; 
                            p.sellTotal += entryPrice * qty;
                            p.actualSellQty += parseFloat(trade.actual_qty || 0);
                        }
                        p.pnl += unrealizedPnl;
                        p.margin += dynamicMargin;
                        p.marginUsed += parseFloat(trade.margin_used || 0);
                        p.cmp = exitPrice;
                    }

                    clientMap[trade.user_id].margin += dynamicMargin;
                    clientMap[trade.user_id].marginUsed += parseFloat(trade.margin_used || 0);
                }
            }
        });

        // 5. Finalize Stats Structure
        const formatValue = (val) => `${(val / 100000).toFixed(2)} Lakhs`;
        const formatValOnly = (val) => val.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        segments.forEach(s => {
            finalizedStats.buyTurnover[s] = formatValue(stats.buyTurnover[s]);
            finalizedStats.sellTurnover[s] = formatValue(stats.sellTurnover[s]);
            finalizedStats.totalTurnover[s] = formatValue(stats.totalTurnover[s]);
            finalizedStats.profitLoss[s] = formatValOnly(stats.profitLoss[s]);
            finalizedStats.brokerage[s] = formatValOnly(stats.brokerage[s]);
            finalizedStats.activeUsers[s] = stats.activeUsers[s].size.toString();
            finalizedStats.activeBuy[s] = stats.activeBuy[s].toString();
            finalizedStats.activeSell[s] = stats.activeSell[s].toString();
        });

        const formattedClients = Object.values(clientMap).map(c => {
            const netCapital = c.balance + c.activePL;
            let shortfall = 0;
            if (c.margin > netCapital && netCapital > 0) {
                shortfall = c.margin - netCapital;
            }

            // Finalize positions array if exists
            let positions = [];
            if (c.positions) {
                positions = Object.values(c.positions).map(p => {
                    const netQty = p.buyQty - p.sellQty;
                    const avgPrice = netQty > 0 ? (p.buyTotal / p.buyQty) : (netQty < 0 ? (p.sellTotal / p.sellQty) : 0);
                    const isCryptoForex = p.symbol.startsWith('CRYPTO:') || p.symbol.startsWith('FOREX:');
                    const decimals = isCryptoForex ? 4 : 2;
                    return {
                        ...p,
                        netQty,
                        avgPrice: avgPrice.toFixed(decimals),
                        pnl: p.pnl.toFixed(decimals),
                        margin: p.margin.toFixed(2),
                        marginUsed: p.marginUsed.toFixed(2)
                    };
                });
            }

            return {
                ...c,
                ledger: c.balance.toFixed(2),
                m2m: netCapital.toFixed(2),
                activePL: c.activePL.toFixed(2),
                closedPL: (c.closedPL || 0).toFixed(2),
                margin: c.margin.toFixed(2),
                marginUsed: (c.marginUsed || 0).toFixed(2),
                marginShortfall: shortfall.toFixed(2),
                positions
            };
        });

        if (isBrokerList) {
            const formattedBrokers = Object.values(brokerStatsMap)
                .filter(b => b.activeTrades > 0)
                .map(b => {
                    return {
                        ...b,
                        activePL: b.activePL.toFixed(2),
                        closedPL: b.closedPL.toFixed(2),
                        margin: b.margin.toFixed(2),
                        marginUsed: b.marginUsed.toFixed(2)
                    };
                });
            return res.json({
                isBrokerList: true,
                isBroker: true,
                clients: formattedBrokers,
                stats: finalizedStats
            });
        }

        let resultClients = formattedClients;
        if (filterUserRole === 'BROKER' || filterUserRole === 'ADMIN' || (!filterUserId && role === 'BROKER')) {
            resultClients = formattedClients.filter(c => (c.activeTrades || 0) > 0);
        }

        res.json({
            isBroker: (filterUserRole === 'BROKER' || filterUserRole === 'ADMIN'),
            clients: resultClients,
            stats: finalizedStats
        });

    } catch (err) {
        console.error('getClientLiveM2M Error:', err);
        res.status(500).send('Server Error');
    }
};

const getMarketWatch = async (req, res) => {
    try {
        const [scrips] = await db.execute('SELECT * FROM scrip_data WHERE status = "OPEN"');
        res.json(scrips);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const getIndices = async (req, res) => {
    try {
        const kiteService = require('../utils/kiteService');

        // Step 1: Try WebSocket prices (live, when market open)
        let nifty = marketDataService.getPrice('NSE:NIFTY 50') || {};
        let banknifty = marketDataService.getPrice('NSE:NIFTY BANK') || {};
        let finnifty = marketDataService.getPrice('NSE:NIFTY FIN SERVICE') || {};

        console.log('📊 Getting Indices - Kite Auth:', kiteService.isAuthenticated());
        console.log('📊 WebSocket Data:', { nifty: nifty.ltp, banknifty: banknifty.ltp, finnifty: finnifty.ltp });

        // Step 2: Always fetch from Kite REST API for full quote data (not just LTP)
        if (kiteService.isAuthenticated()) {
            try {
                const instruments = ['NSE:NIFTY 50', 'NSE:NIFTY BANK', 'NSE:NIFTY FIN SERVICE'];
                console.log('🔄 Fetching quotes from Zerodha Kite:', instruments);

                const quotes = await kiteService.getQuote(instruments);
                console.log('✅ Kite quotes received:', Object.keys(quotes || {}));

                if (quotes && typeof quotes === 'object') {
                    if (quotes['NSE:NIFTY 50']) {
                        const q = quotes['NSE:NIFTY 50'];
                        console.log('📈 NIFTY 50 Quote:', { ltp: q.last_price, bid: q.depth?.buy?.[0]?.price, ask: q.depth?.sell?.[0]?.price });
                        nifty = {
                            ltp: q.last_price || q.ohlc?.close || 0,
                            bid: q.depth?.buy?.[0]?.price || q.last_price || 0,
                            ask: q.depth?.sell?.[0]?.price || q.last_price || 0,
                            change: q.last_price && q.ohlc?.close ? q.last_price - q.ohlc.close : 0,
                            chg_pct: q.last_price && q.ohlc?.close ? (((q.last_price - q.ohlc.close) / q.ohlc.close) * 100).toFixed(2) : 0,
                            ohlc: q.ohlc || {}
                        };
                    }
                    if (quotes['NSE:NIFTY BANK']) {
                        const q = quotes['NSE:NIFTY BANK'];
                        banknifty = {
                            ltp: q.last_price || q.ohlc?.close || 0,
                            bid: q.depth?.buy?.[0]?.price || q.last_price || 0,
                            ask: q.depth?.sell?.[0]?.price || q.last_price || 0,
                            change: q.last_price && q.ohlc?.close ? q.last_price - q.ohlc.close : 0,
                            chg_pct: q.last_price && q.ohlc?.close ? (((q.last_price - q.ohlc.close) / q.ohlc.close) * 100).toFixed(2) : 0,
                            ohlc: q.ohlc || {}
                        };
                    }
                    if (quotes['NSE:NIFTY FIN SERVICE']) {
                        const q = quotes['NSE:NIFTY FIN SERVICE'];
                        finnifty = {
                            ltp: q.last_price || q.ohlc?.close || 0,
                            bid: q.depth?.buy?.[0]?.price || q.last_price || 0,
                            ask: q.depth?.sell?.[0]?.price || q.last_price || 0,
                            change: q.last_price && q.ohlc?.close ? q.last_price - q.ohlc.close : 0,
                            chg_pct: q.last_price && q.ohlc?.close ? (((q.last_price - q.ohlc.close) / q.ohlc.close) * 100).toFixed(2) : 0,
                            ohlc: q.ohlc || {}
                        };
                    }
                }
            } catch (restErr) {
                console.error('🔴 Kite API Error:', restErr.message);
            }
        } else {
            console.warn('⚠️  Kite NOT authenticated. Check /api/kite/status');
        }

        const toIndex = (raw, name) => {
            const ltp = raw.ltp || 0;
            return {
                name,
                ltp,
                bid: raw.bid || ltp,
                ask: raw.ask || ltp,
                change: raw.change || 0,
                chg_pct: raw.chg_pct || 0,
                high: raw.ohlc?.high || 0,
                low: raw.ohlc?.low || 0,
                open: raw.ohlc?.open || 0,
                close: raw.ohlc?.close || 0,
            };
        };

        const result = [
            toIndex(nifty, 'NIFTY 50'),
            toIndex(banknifty, 'NIFTY BANK'),
            toIndex(finnifty, 'NIFTY FIN SERVICE'),
        ];

        console.log('📊 Final Indices Response:', result.map(r => ({ name: r.name, ltp: r.ltp })));
        res.json(result);
    } catch (err) {
        console.error('🔴 getIndices Error:', err.message, err.stack);
        res.status(500).json({ error: err.message });
    }
};

const getWatchlist = async (req, res) => {
    try {
        const [lotRows] = await db.execute('SELECT symbol, lot_size FROM scrip_data');
        const lotMap = {};
        lotRows.forEach(r => {
            lotMap[r.symbol.toUpperCase()] = parseFloat(r.lot_size || 1);
        });

        const prices = marketDataService.prices;
        const filteredKeys = Object.keys(prices).filter(symbol => {
            if (symbol.startsWith('CRYPTO:') || symbol.startsWith('FOREX:') || symbol.startsWith('COMMODITY:')) {
                return symbol.includes('/');
            }
            return true;
        });

        const watchlist = filteredKeys.map((symbol, index) => {
            const data = prices[symbol];
            const symOnly = symbol.split(':')[1] || symbol;
            return {
                id: (index + 1).toString(),
                symbol: symbol,
                name: symOnly,
                category: data.type || 'NSE',
                ltp: data.ltp,
                bid: data.bid,
                ask: data.ask,
                change: data.chg_pct || 0,
                lotSize: lotMap[symOnly.toUpperCase()] || 1
            };
        });
        res.json(watchlist);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

module.exports = {
    getLiveMarket,
    getClientLiveM2M,
    getMarketWatch,
    getIndices,
    getWatchlist,
    getBrokerM2M: async (req, res) => {
        try {
            const brokerId = req.user.id;
            const db = require('../config/db');
            const mockEngine = require('../utils/mockEngine');
            const { getMcxBaseScrip } = require('../utils/symbolHelper');

            // 1. Get all traders under this broker (excluding demo accounts)
            const [traders] = await db.execute(
                'SELECT id, username, balance FROM users WHERE parent_id = ? AND role = "TRADER" AND is_demo = 0',
                [brokerId]
            );

            if (!traders.length) {
                return res.json([]);
            }

            const traderIds = traders.map(t => t.id);

            // 2. Get all open trades for these traders
            const [trades] = await db.execute(
                `SELECT t.id, t.user_id, t.symbol, t.type, t.qty, t.entry_price, t.market_type,
                        u.username
                 FROM trades t
                 JOIN users u ON t.user_id = u.id
                 WHERE t.status = 'OPEN' AND t.user_id IN (${traderIds.join(',')})`,
                []
            );

            // 3. Calculate M2M for each trader
            const INSTRUMENT_META = {
                'CRUDEOIL': 100, 'NATURALGAS': 1250, 'GOLD': 100, 'GOLDM': 10,
                'SILVER': 30, 'SILVERM': 5, 'COPPER': 2500, 'ZINC': 5000,
                'NICKEL': 1500, 'LEAD': 5000, 'ALUMINIUM': 5000, 'MENTHAOIL': 360,
                'COTTON': 25, 'BULLDEX': 1, 'GOLDGUINEA': 8, 'GOLDPETAL': 1
            };

            const traderM2M = {};
            traders.forEach(t => {
                traderM2M[t.id] = {
                    user_id: t.id,
                    username: t.username,
                    live_pnl: 0,
                    active_trades: 0,
                    margin_used: 0
                };
            });

            // 4. Calculate P/L for each open trade
            for (const trade of trades) {
                let currentPrice = trade.entry_price;
                try {
                    const cleanSymbol = trade.symbol.includes(':') ? trade.symbol.split(':')[1] : trade.symbol;
                    const marketType = (trade.market_type || 'MCX').toUpperCase();
                    const prefix = marketType === 'EQUITY' ? 'NSE' : (marketType === 'OPTIONS' ? 'NFO' : marketType);

                    const possibleSymbols = [trade.symbol, `${prefix}:${cleanSymbol}`, cleanSymbol];
                    let liveData = null;
                    for (const s of possibleSymbols) {
                        liveData = marketDataService.getPrice(s);
                        if (liveData) break;
                    }

                    if (liveData && liveData.ltp) {
                        currentPrice = liveData.ltp;
                    }
                } catch (_) { }

                let pnl = 0;
                const commodityLotService = require('../services/CommodityLotService');
                if (commodityLotService.isCommodityScrip(trade.symbol, trade.market_type)) {
                    const calc = commodityLotService.calculatePnL(trade.symbol, trade.type, trade.entry_price, currentPrice, trade.qty);
                    pnl = calc.pnlInr;
                } else {
                    const baseSymbol = Object.keys(INSTRUMENT_META).find(key =>
                        trade.symbol.toUpperCase().includes(key)
                    );
                    const multiplier = baseSymbol ? INSTRUMENT_META[baseSymbol] : 1;

                    pnl = trade.type === 'BUY'
                        ? (currentPrice - trade.entry_price) * trade.qty * multiplier
                        : (trade.entry_price - currentPrice) * trade.qty * multiplier;
                }

                if (traderM2M[trade.user_id]) {
                    traderM2M[trade.user_id].live_pnl += pnl;
                    traderM2M[trade.user_id].active_trades += 1;
                }
            }

            // 5. Return as array
            const result = Object.values(traderM2M);
            res.json(result);
        } catch (err) {
            console.error('getBrokerM2M error:', err);
            res.status(500).json({ error: err.message });
        }
    }
};

