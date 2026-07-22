const kiteAuthService = require('../services/KiteAuthService');
const kiteService = require('../utils/kiteService');

const MCX_LOT_SIZES = {
    'GOLD': 100, 'GOLDM': 10, 'GOLDPETAL': 1, 'GOLDGUINEA': 8,
    'SILVER': 30, 'SILVERM': 5, 'SILVERMIC': 1,
    'CRUDEOIL': 100, 'CRUDEOILM': 10,
    'NATURALGAS': 1250, 'NATGASMINI': 250,
    'COPPER': 2500, 'COPPERM': 500,
    'ZINC': 5000, 'ZINCMINI': 1000,
    'LEAD': 5000, 'LEADMINI': 1000,
    'NICKEL': 1500, 'NICKELMINI': 100,
    'ALUMINIUM': 5000, 'ALUMINI': 1000,
    'MENTHAOIL': 360, 'COTTON': 25, 'COTTONCNDY': 20, 'BULLDEX': 1
};

const NFO_LOT_SIZES = {
    'NIFTY': 50, 'BANKNIFTY': 50, 'FINNIFTY': 50, 'MIDCPNIFTY': 50, 'SENSEX': 10
};

/**
 * Controller to handle Kite authentication requests.
 */
class KiteController {
    
    login = async (req, res) => {
        try {
            const userId = req.user.id;
            const url = `${kiteAuthService.getLoginURL()}&state=${userId}`;
            res.json({ login_url: url });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    callback = async (req, res) => {
        const { request_token, state: userId, status } = req.query;
        // Detect local vs production for redirect
        const isLocal = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
        const FRONTEND_URL = isLocal ? 'http://localhost:5173' : (process.env.FRONTEND_URL || 'http://localhost:5173');

        if (status === 'cancelled') {
            return res.send(`<html><body style="background:#1a1a2e;color:#fff;text-align:center;padding:50px;font-family:sans-serif;">
                <h1 style="color:#e74c3c">Login Cancelled</h1>
                <p style="color:#ccc">Redirecting back...</p>
                <script>setTimeout(()=>{ window.location.href='${FRONTEND_URL}/kite-dashboard'; },2000)</script>
            </body></html>`);
        }

        if (!request_token) {
            return res.status(400).send(`<html><body style="background:#1a1a2e;color:#fff;text-align:center;padding:50px;font-family:sans-serif;">
                <h1 style="color:#e74c3c">Error</h1>
                <p style="color:#ccc">No request token received from Zerodha.</p>
                <script>setTimeout(()=>{ window.location.href='${FRONTEND_URL}/kite-dashboard'; },3000)</script>
            </body></html>`);
        }

        try {
            // Generate session using global kiteService (works without userId)
            const session = await kiteService.handleCallback(request_token);
            const accessToken = session.access_token || '';

            // Save the already-obtained session to per-user DB
            // (request_token is already consumed above; don't call generateSession again)
            if (userId) {
                try {
                    await kiteAuthService.saveTokenToDB(userId, accessToken, session);
                } catch (dbErr) {
                    console.error('[Kite Callback] DB session save failed:', dbErr.message);
                }
            }

            // Trigger instruments sync in background (don't block response)
            setImmediate(async () => {
                try {
                    const db = require('../config/db');
                    const instruments = await kiteService.getInstruments();

                    if (!Array.isArray(instruments) || instruments.length === 0) {
                        return;
                    }
                    const seen = new Set();
                    let syncCount = 0;

                    for (const i of instruments) {
                        if (i.exchange === 'NSE' && i.instrument_type === 'EQ') {
                            const symbol = i.tradingsymbol;
                            const key = `NSE:${symbol}`;
                            if (seen.has(key)) continue;
                            seen.add(key);

                            const lotSize = parseInt(i.lot_size) || 1;
                            try {
                                await db.execute(
                                    `INSERT INTO scrip_data (symbol, lot_size, margin_req, market_type)
                                     VALUES (?, ?, ?, ?)
                                     ON DUPLICATE KEY UPDATE lot_size = VALUES(lot_size), market_type = VALUES(market_type)`,
                                    [symbol, lotSize, 50, 'EQUITY']
                                );
                                syncCount++;
                            } catch (_) {}
                        } else if ((i.exchange === 'MCX' || i.exchange === 'NFO') && i.instrument_type === 'FUT') {
                            const symbol = i.name || i.tradingsymbol;
                            const key = `${i.exchange}:${symbol}`;
                            if (seen.has(key)) continue;
                            seen.add(key);

                            const lotSize = parseInt(i.lot_size) || 1;
                            const marketType = i.exchange === 'MCX' ? 'MCX' : 'NFO';
                            try {
                                await db.execute(
                                    `INSERT INTO scrip_data (symbol, lot_size, margin_req, market_type)
                                     VALUES (?, ?, ?, ?)
                                     ON DUPLICATE KEY UPDATE lot_size = VALUES(lot_size), market_type = VALUES(market_type)`,
                                    [symbol, lotSize, 50, marketType]
                                );
                                syncCount++;
                            } catch (_) {}
                        }
                    }

                } catch (syncErr) {
                }
            });

            // Detect redirect: use request origin or fallback to localhost for local dev
            const redirectURL = `${FRONTEND_URL}/kite-dashboard`;

            // Immediately re-initialize real-time market data socket feeds
            const marketDataService = require('../services/MarketDataService');
            marketDataService.init(userId).catch(() => {});

            res.send(`
                <html><body style="background:#1a1a2e;color:#fff;text-align:center;padding:50px;font-family:sans-serif;">
                    <h1 style="color:#2ecc71">Kite Connected!</h1>
                    <p style="color:#ccc">User: <strong>${session.user_name || session.user_id || 'N/A'}</strong></p>
                    <div style="background:#0f1729;border:1px solid #2ecc71;border-radius:8px;padding:15px;margin:20px auto;max-width:500px;text-align:left;">
                        <p style="color:#888;font-size:11px;margin:0 0 5px;">ACCESS TOKEN (copy if needed):</p>
                        <textarea id="tokenText" readonly style="width:100%;height:60px;background:#1a1a2e;color:#2ecc71;border:1px solid #333;font-family:monospace;font-size:13px;padding:5px;box-sizing:border-box;resize:none;">${accessToken}</textarea>
                        <button onclick="copyToken()" style="margin-top:10px;background:#2ecc71;color:#fff;border:none;padding:6px 12px;border-radius:4px;cursor:pointer;font-weight:bold;">Copy Token</button>
                        <span id="copyMsg" style="color:#2ecc71;font-size:12px;margin-left:10px;display:none;">Copied!</span>
                    </div>
                    <p style="color:#888;font-size:13px;">Redirecting to dashboard in <span id="timer">20</span>s...</p>
                    <button onclick="window.location.href='${redirectURL}'" style="background:#34495e;color:#fff;border:none;padding:10px 20px;border-radius:6px;cursor:pointer;font-weight:bold;">Go to Dashboard Now</button>
                    <script>
                        function copyToken() {
                            const copyText = document.getElementById("tokenText");
                            copyText.select();
                            copyText.setSelectionRange(0, 99999);
                            navigator.clipboard.writeText(copyText.value);
                            const msg = document.getElementById("copyMsg");
                            msg.style.display = "inline";
                            setTimeout(() => { msg.style.display = "none"; }, 2000);
                        }
                        let timeLeft = 20;
                        const interval = setInterval(() => {
                            timeLeft--;
                            document.getElementById("timer").innerText = timeLeft;
                            if (timeLeft <= 0) {
                                clearInterval(interval);
                                window.location.href = '${redirectURL}';
                            }
                        }, 1000);
                    </script>
                </body></html>
            `);
        } catch (err) {
            console.error('Kite callback error:', err.message);
            res.status(500).send(`<html><body style="background:#1a1a2e;color:#fff;text-align:center;padding:50px;font-family:sans-serif;">
                <h1 style="color:#e74c3c">Auth Failed</h1>
                <p style="color:#ccc">${err.message}</p>
                <p style="color:#888">Redirecting back...</p>
                <script>setTimeout(()=>{ window.location.href='${FRONTEND_URL}/kite-dashboard'; },3000)</script>
            </body></html>`);
        }
    }

    status = async (req, res) => {
        try {
            const userId = req.user.id;
            // Check per-user DB session first
            const dbStatus = await kiteAuthService.getStatus(userId);
            if (dbStatus.connected) {
                return res.json(dbStatus);
            }
            // Fallback: check global kiteService (set by Zerodha callback or .env)
            if (kiteService.isAuthenticated()) {
                const globalStatus = kiteService.getStatus();
                return res.json(globalStatus);
            }
            res.json({ connected: false });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    disconnect = async (req, res) => {
        try {
            const userId = req.user.id;
            await kiteAuthService.disconnect(userId);
            // Clear global kiteService too
            kiteService.clearSession();
            res.json({ success: true, message: 'Kite disconnected' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    getMargins = async (req, res) => {
        try {
            const userId = req.user.id;
            const kite = await kiteAuthService.getKiteInstance(userId);
            const margins = await kite.getMargins();
            res.json(margins);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    getProfile = async (req, res) => {
        try {
            const userId = req.user.id;
            const kite = await kiteAuthService.getKiteInstance(userId);
            const profile = await kite.getProfile();
            res.json(profile);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    setToken = async (req, res) => {
        try {
            const userId = req.user.id;
            const { access_token } = req.body;

            if (!access_token) {
                return res.status(400).json({ error: 'access_token is required' });
            }

            // Validate token with Kite API BEFORE saving
            let profile;
            try {
                profile = await kiteService.setAccessToken(access_token);
            } catch (validationErr) {
                // Show actual Kite rejection reason, not a generic message
                const reason = validationErr.message || 'Token rejected by Zerodha';
                return res.status(400).json({ error: `Invalid access token: ${reason}` });
            }

            // Token is valid — save to per-user DB (DB failure must not block the response)
            try {
                await kiteAuthService.saveTokenToDB(userId, access_token, profile);
            } catch (dbErr) {
                console.error('[setToken] DB save failed:', dbErr.message);
            }

            // Trigger instruments sync in background (don't block response)
            setImmediate(async () => {
                try {
                    const db = require('../config/db');
                    const instruments = await kiteService.getInstruments();

                    if (!Array.isArray(instruments) || instruments.length === 0) {
                        return;
                    }
                    const seen = new Set();
                    let syncCount = 0;

                    for (const i of instruments) {
                        if (i.exchange === 'NSE' && i.instrument_type === 'EQ') {
                            const symbol = i.tradingsymbol;
                            const key = `NSE:${symbol}`;
                            if (seen.has(key)) continue;
                            seen.add(key);

                            const lotSize = parseInt(i.lot_size) || 1;
                            try {
                                await db.execute(
                                    `INSERT INTO scrip_data (symbol, lot_size, margin_req, market_type)
                                     VALUES (?, ?, ?, ?)
                                     ON DUPLICATE KEY UPDATE lot_size = VALUES(lot_size), market_type = VALUES(market_type)`,
                                    [symbol, lotSize, 50, 'EQUITY']
                                );
                                syncCount++;
                            } catch (_) {}
                        } else if ((i.exchange === 'MCX' || i.exchange === 'NFO') && i.instrument_type === 'FUT') {
                            const symbol = i.name || i.tradingsymbol;
                            const key = `${i.exchange}:${symbol}`;
                            if (seen.has(key)) continue;
                            seen.add(key);

                            const lotSize = parseInt(i.lot_size) || 1;
                            const marketType = i.exchange === 'MCX' ? 'MCX' : 'NFO';
                            try {
                                await db.execute(
                                    `INSERT INTO scrip_data (symbol, lot_size, margin_req, market_type)
                                     VALUES (?, ?, ?, ?)
                                     ON DUPLICATE KEY UPDATE lot_size = VALUES(lot_size), market_type = VALUES(market_type)`,
                                    [symbol, lotSize, 50, marketType]
                                );
                                syncCount++;
                            } catch (_) {}
                        }
                    }

                } catch (syncErr) {
                }
            });

            // Immediately re-initialize real-time market data socket feeds
            const marketDataService = require('../services/MarketDataService');
            marketDataService.init(userId).catch(() => {});

            res.json({ success: true, message: 'Access token set successfully', user: profile?.user_name || null });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }
}

module.exports = new KiteController();
