const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

/**
 * Socket Manager
 * Handles socket.io initialization and provides a getter for the io instance.
//  */
//  test
class SocketManager {
    constructor() {
        this.io = null;
    }

    init(server, allowedOrigins) {
        this.io = new Server(server, {
            cors: {
                origin: allowedOrigins,
                methods: ["GET", "POST"]
            },
            // ✅ Keep connection alive with ping/pong
            pingInterval: 25000,
            pingTimeout: 60000,
            transports: ['websocket', 'polling']  // Enable both
        });

        this.io.use((socket, next) => {
            try {
                const token = socket.handshake.auth?.token || socket.handshake.query?.token;
                if (!token) {
                    socket.user = null;
                    return next();
                }
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                socket.user = decoded;
                next();
            } catch (e) {
                socket.user = null;
                next();
            }
        });

        this.io.on('connection', (socket) => {
            // console.log('User connected:', socket.id);

            socket.on('join', ({ userId, role }) => {
                if (userId) socket.join(`user:${userId}`);
                if (role) socket.join(`role:${role}`);
            });

            socket.on('request_market_snapshot', async (query) => {
                const kiteRoutes = require('../routes/kiteRoutes');
                const marketDataService = require('../services/MarketDataService');

                if (!socket.user?.id) {
                    socket.emit('market_snapshot', {
                        error: 'Unauthorized',
                        kite_connected: false,
                        kite_disconnected: true,
                        watchlist: [],
                        crypto: [],
                        forex: []
                    });
                    return;
                }

                try {
                    const userId = socket.user.id;
                    const role = socket.user.role;
                    const q = query && typeof query === 'object' ? query : {};
                    const kiteResult = await kiteRoutes.fetchUnifiedWatchlistForSocket(userId, q);

                    const { getClientAllowedSegments } = require('../utils/segmentPermissionHelper');
                    const { getUserBannedScripsStatus, checkSymbolHidden, checkSymbolMarked } = require('../utils/bannedHelper');

                    const allowed = await getClientAllowedSegments(userId, role);
                    const { hideSet, markSet } = await getUserBannedScripsStatus(userId, role);

                    const filterAndMark = (items) => {
                        if (!items || !items.length) return [];
                        return items
                            .filter(item => {
                                const sym = item.symbol || '';
                                const name = item.name || '';
                                return !checkSymbolHidden(sym, hideSet) && !checkSymbolHidden(name, hideSet);
                            })
                            .map(item => {
                                const sym = item.symbol || '';
                                const name = item.name || '';
                                if (checkSymbolMarked(sym, markSet) || checkSymbolMarked(name, markSet)) {
                                    return { ...item, isBanned: true };
                                }
                                return item;
                            });
                    };

                    const rawCrypto = allowed.CRYPTO ? marketDataService.getCryptoPrices() : [];
                    const rawForex = allowed.FOREX ? marketDataService.getForexPrices() : [];
                    const rawCommodity = allowed.COMMODITY ? marketDataService.getCommodityPrices() : [];

                    const crypto = filterAndMark(rawCrypto);
                    const forex = filterAndMark(rawForex);
                    const commodity = filterAndMark(rawCommodity);

                    const kite_connected = Boolean(kiteResult.ok && !kiteResult.kite_disconnected);

                    let dashboard = null;
                    try {
                        if (kite_connected) {
                            dashboard = await kiteRoutes.buildKiteDashboardPayload(userId);
                        }
                    } catch (dashErr) {
                        // Dashboard build failed, skip it silently
                    }

                    socket.emit('market_snapshot', {
                        kite_connected,
                        kite_disconnected: !!kiteResult.kite_disconnected,
                        watchlist: Array.isArray(kiteResult.data) ? kiteResult.data : [],
                        crypto,
                        forex,
                        commodity,
                        binance_error: marketDataService.getBinanceError(),
                        dashboard,
                        excludedContracts: global.EXCLUDED_CONTRACTS || [],
                        error: kiteResult.error || null
                    });
                } catch (e) {
                    console.error('request_market_snapshot:', e.message);
                    socket.emit('market_snapshot', {
                        error: e.message,
                        kite_connected: false,
                        kite_disconnected: true,
                        watchlist: [],
                        crypto: [],
                        forex: [],
                        commodity: []
                    });
                }
            });

            socket.on('subscribe_market', (scrips) => {
                const marketDataService = require('../services/MarketDataService');
                const instrumentService = require('../services/InstrumentService');

                if (Array.isArray(scrips)) {
                    const normalizedSymbols = Array.from(
                        new Set(
                            scrips
                                .map((symbol) => String(symbol || '').trim().toUpperCase())
                                .filter(Boolean)
                        )
                    );

                    instrumentService.getInstrumentsBySymbols(normalizedSymbols)
                        .then((instrumentsBySymbol) => {
                            normalizedSymbols.forEach((symbol) => {
                                const instrument = instrumentsBySymbol.get(symbol);
                                marketDataService.subscribe(symbol, instrument?.instrument_token);
                            });
                        })
                        .catch((e) => {
                            // Subscription batch failed, service will retry
                        });
                }
            });

            socket.on('disconnect', () => {
                // console.log('User disconnected');
            });
        });

        return this.io;
    }

    getIo() {
        return this.io;
    }

    /**
     * Broadcasts a message to all connected clients to re-request their market snapshot.
     * This is useful when global config like excluded contracts changes.
     */
    broadcastMarketSnapshotRefresh() {
        if (this.io) {
            this.io.emit('market_snapshot_needed');
        }
    }
}

module.exports = new SocketManager();
