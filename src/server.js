require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

// Prevent server crash on unhandled network or rejection errors (e.g. during internet drop)
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ [Global] Unhandled Rejection:', reason?.message || reason);
});

process.on('uncaughtException', (err) => {
    console.error('⚠️ [Global] Uncaught Exception:', err.message);
});

// Clean exit handlers to prevent orphaned processes holding DB connections on Windows/nodemon
const gracefulShutdown = async (signal) => {
    console.log(`🔌 [Global] Received ${signal}. Shutting down gracefully...`);
    try {
        const db = require('./config/db');
        if (db && typeof db.end === 'function') {
            await db.end();
            console.log('✅ Database pool closed.');
        }
    } catch (err) {
        console.error('⚠️ Error closing DB pool during shutdown:', err.message);
    }
    process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

const express = require('express');
const http = require('http');
const cors = require('cors');
const compression = require('compression');
const { initializeCache } = require('./utils/cacheManager');
const socketManager = require('./websocket/SocketManager');
const marketDataService = require('./services/MarketDataService');
const mockEngine = require('./utils/mockEngine');
const paperTradingEngine = require('./trading-engine/PaperTradingEngine');
const { setIo } = require('./config/socket');
const runMigrations = require('./config/migrate');



const app = express();
app.set('trust proxy', true);
const server = http.createServer(app);

const ALLOWED_ORIGINS = [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:8081',
    'https://traderss.kiaantechnology.com',
    'https://trading-software112.netlify.app',
    process.env.FRONTEND_URL
].filter(Boolean);

const io = socketManager.init(server, ALLOWED_ORIGINS);
setIo(io);

// Start Paper Trading Engine moved inside migration callback

const authRoutes = require('./routes/authRoutes');
const tradeRoutes = require('./routes/tradeRoutes');
const userRoutes = require('./routes/userRoutes');
const fundRoutes = require('./routes/fundRoutes');
const securityRoutes = require('./routes/securityRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const signalRoutes = require('./routes/signalRoutes');
const systemRoutes = require('./routes/systemRoutes');
const requestRoutes = require('./routes/requestRoutes');
const accountRoutes = require('./routes/accountRoutes');
const portfolioRoutes = require('./routes/portfolioRoutes');
const supportRoutes = require('./routes/supportRoutes');
const aiRoutes = require('./routes/aiRoutes');
const { aiParse, executeVoiceCommand, smartCommand, masterCommand } = require('./controllers/aiController');
const kiteRoutes = require('./routes/kiteRoutes');
const contractRoutes = require('./routes/contractRoutes');
const bankRoutes = require('./routes/bankRoutes');
const newClientBankRoutes = require('./routes/newClientBankRoutes');
const adminRoutes = require('./routes/adminRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const alertRoutes = require('./routes/alertRoutes');
const marginRoutes = require('./routes/marginRoutes');
const { logIp } = require('./middleware/logger');

// Middleware
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(compression({
    level: 6,  // Compression level (0-9, 6 is good balance)
    threshold: 1024  // Only compress responses > 1KB
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(logIp); // Log IP for every authenticated request

// Serve uploaded files statically
const path = require('path');
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

const paperRoutes = require('./routes/paperRoutes');

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/trades', tradeRoutes);
app.use('/api/users', userRoutes);
app.use('/api/funds', fundRoutes);
app.use('/api/security', securityRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/signals', signalRoutes);
app.use('/api/system', systemRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/kite', kiteRoutes);
app.use('/api/contracts', contractRoutes);
app.use('/api/bank', bankRoutes);
app.use('/api/new-client-bank', newClientBankRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/margin', marginRoutes);
app.use('/api/paper-trading', paperRoutes);

const scripTickRoutes = require('./routes/scripTickRoutes');
app.use('/api/scrip-ticks', scripTickRoutes);

const marketDataRoutes = require('./routes/marketDataRoutes');
app.use('/api/market-data', marketDataRoutes);

// ── Root-level voice AI routes (no /api prefix, no auth required for direct access)
app.post('/ai-parse', aiParse);
app.post('/execute-command', executeVoiceCommand);
app.post('/smart-command', smartCommand);
app.post('/master-command', masterCommand);

// Routes Placeholder
app.get('/', (req, res) => {
    res.send('Traders API is running...');
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// ── Socket Logic handled in SocketManager.js ──
// NOTE: Internal socket event listeners (join, subscribe_market) are 
// managed in src/websocket/SocketManager.js to allow modular integration 
// with PaperTradingEngine and MarketDataService.

// ── Market Data Initialization ──
// Handled inside migration callback

const PORT = process.env.PORT || 5000;

// Share io instance with controllers (before migrations)
setIo(io);

// Auto-sync Kite instruments into database
async function syncKiteInstrumentsOnStartup() {
    try {
        const kiteService = require('./utils/kiteService');
        // Ensure session is loaded from database first
        await kiteService.loadSessionFromDb();

        const instrumentSyncService = require('./services/InstrumentSyncService');
        await instrumentSyncService.sync();
        instrumentSyncService.startSyncJob();
    } catch (err) {
        // Sync failed but system continues - real data available from Zerodha
        console.error('[Sync Startup] Error during startup sync:', err.message);
    }
}

// Start server immediately so port 5000 binds instantly (prevents connection drops during nodemon restarts)
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT} (0.0.0.0)`);
});

// Run DB migrations asynchronously in background
runMigrations()
    .then(async () => {
        // Run background initializations without blocking server startup
        initializeCache().catch(e => console.error('[Cache] Init failed:', e.message));
        syncKiteInstrumentsOnStartup().catch(e => console.error('[Sync] Init failed:', e.message));
        const commodityLotService = require('./services/CommodityLotService');
        commodityLotService.load().catch(e => console.error('[CommodityLot] Init failed:', e.message));

        // Initialize Paper Trading Engine after DB is ready (if applicable)
        paperTradingEngine.start();

        // Start Expiry Square-off, RMS, Target/SL, and Alert Monitoring services
        const { startExpirySquareOffJob } = require('./services/expirySquareOffService');
        const rmsService = require('./services/RMSService');
        const { startTargetSLMonitoring } = require('./services/targetSLService');
        const { startAlertMonitoring } = require('./services/alertMonitoringService');
        const { startPendingOrderMonitoring } = require('./services/PendingOrderService');

        startExpirySquareOffJob();
        rmsService.start(10000); // Check risk every 10 seconds
        startTargetSLMonitoring(); // Monitor target/SL every 5 seconds
        startAlertMonitoring(); // Monitor price alerts every 3 seconds
        startPendingOrderMonitoring(); // Monitor pending orders every 3 seconds
        
        // Start weekly closing/settlement auto-cron job
        const { startWeeklySettlementJob } = require('./services/WeeklySettlementService');
        startWeeklySettlementJob();

        // Start weekly script tick data export & purge cron job
        const { initScripCleanupCron } = require('./services/scripCleanupCron');
        initScripCleanupCron();

        // Schedule Zerodha Auto-Login (Mon-Fri at 8:30 AM IST / 3:00 AM UTC before market open)
        try {
            const cron = require('node-cron');
            const kiteAutoLoginService = require('./services/KiteAutoLoginService');

            const runAutoLoginWithRetry = async () => {
                console.log('⏰ [Cron] Triggering daily automated Zerodha login (8:30 AM IST / 3:00 AM UTC)...');
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        console.log(`[AutoLogin Cron] Attempt ${attempt}/3...`);
                        await kiteAutoLoginService.autoLogin();
                        console.log('✅ [Cron] Daily Zerodha auto-login successful!');
                        return;
                    } catch (err) {
                        console.error(`❌ [Cron] Auto-login attempt ${attempt} failed:`, err.message);
                        if (attempt < 3) await new Promise(r => setTimeout(r, 15000));
                    }
                }
            };

            // 1. Cron for IST Servers (8:30 AM IST)
            cron.schedule('30 8 * * 1-5', runAutoLoginWithRetry, {
                scheduled: true,
                timezone: "Asia/Kolkata"
            });

            // 2. Cron for AWS UTC Servers (3:00 AM UTC = 8:30 AM IST)
            cron.schedule('0 3 * * 1-5', runAutoLoginWithRetry, {
                scheduled: true,
                timezone: "UTC"
            });

            console.log('📅 Zerodha Auto-Login Cron scheduled for 8:30 AM IST (3:00 AM UTC) Mon-Fri with 3x retry.');

            // On server startup: attempt auto-login if credentials present & not connected
            if (process.env.ZERODHA_USER_ID && process.env.ZERODHA_PASSWORD && process.env.ZERODHA_TOTP_SECRET) {
                setTimeout(async () => {
                    const kiteService = require('./utils/kiteService');
                    if (!kiteService.isAuthenticated()) {
                        console.log('ℹ️ Zerodha not connected on startup. Attempting automated login...');
                        try {
                            await kiteAutoLoginService.autoLogin();
                            console.log('✅ Automated startup login successful!');
                        } catch (e) {
                            console.warn('⚠️ Automated startup login skipped/failed:', e.message);
                        }
                    }
                }, 10000);
            }
        } catch (cronErr) {
            console.warn('Could not initialize Zerodha auto-login cron:', cronErr.message);
        }

        // Initialize Market Data (Real Data Only - No Mock Fallback)
        try {
            const db = require('./config/db');
            const [users] = await db.execute('SELECT id FROM user_kite_sessions LIMIT 1');
            const userId = users.length > 0 ? users[0].id : null;
            try {
                await marketDataService.init(userId);
            } catch (tickerErr) {
                // Market data initialization failed - using real API data only
            }
        } catch (err) {
            // Market initialization error - continuing with real data
        }

        // Start Crypto + Forex feeds (AllTick) — independent of Kite
        try {
            marketDataService.startCryptoForex();
        } catch (cfErr) {
            // Crypto/Forex feeds unavailable
        }
    })
    .catch((err) => {
        console.error('❌ Migration or background startup failed:', err.message);
    });

// Trigger nodemon restart - Robust Non-Blocking Margin Service active

module.exports = { app, io };
