const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const BASE_URL = 'https://api.kite.trade';
const API_KEY = process.env.KITE_API_KEY;
const API_SECRET = process.env.KITE_API_SECRET;
class KiteService {
    constructor() {
        this.accessToken = null;
        this.sessionData = null;

        // Load existing session if available from DB
        this.loadSession();

        // Token is now managed via Zerodha login or manual paste — no .env fallback needed
    }

    // ─── SESSION MANAGEMENT ───────────────────────────────

    async loadSessionFromDb() {
        try {
            const db = require('../config/db');
            const [rows] = await db.execute(
                'SELECT * FROM user_kite_sessions ORDER BY saved_at DESC LIMIT 1'
            );
            if (rows && rows.length > 0) {
                const data = rows[0];
                if (data.access_token) {
                    // Check if session is from today (Kite tokens expire at ~6 AM next day)
                    const savedDate = new Date(data.saved_at || 0).toDateString();
                    const today = new Date().toDateString();

                    if (savedDate === today) {
                        this.accessToken = data.access_token;
                        this.sessionData = {
                            access_token: data.access_token,
                            user_name: data.user_name,
                            user_id: data.kite_user_id,
                            email: data.email,
                            saved_at: data.saved_at
                        };
                        console.log('📂 Kite session loaded from DB (today\'s token)');
                        return true;
                    } else {
                        console.log('⚠️  Kite session expired in DB (old date). Need fresh login.');
                        this.accessToken = null;
                        this.sessionData = null;
                    }
                }
            } else {
                console.log('ℹ️  No Kite session found in DB.');
            }
        } catch (err) {
            console.error('Error loading Kite session from DB:', err.message);
        }
        return false;
    }

    loadSession() {
        // Trigger async load from DB
        this.loadSessionFromDb().catch(err => {
            console.error('Error in loadSession trigger:', err.message);
        });
    }

    saveSession(data) {
        try {
            this.accessToken = data.access_token;
            this.sessionData = {
                ...data,
                saved_at: new Date().toISOString(),
            };
            console.log('💾 Kite session updated in memory.');
        } catch (err) {
            console.error('Error saving Kite session:', err.message);
        }
    }

    clearSession() {
        this.accessToken = null;
        this.sessionData = null;
        console.log('🗑️  Kite session cleared from memory.');
    }

    // ─── SET ACCESS TOKEN DIRECTLY ─────────────────────────

    async setAccessToken(token) {
        this.accessToken = token;
        this.sessionData = { access_token: token };

        // Validate by fetching profile
        try {
            const profile = await this.makeRequest('/user/profile');
            this.sessionData = {
                access_token: token,
                user_name: profile.user_name,
                user_id: profile.user_id,
                email: profile.email,
                broker: profile.broker,
                login_time: profile.login_time,
            };
            this.saveSession(this.sessionData);
            console.log('✅ Kite access token set manually. User:', profile.user_name || profile.user_id);
            return this.sessionData;
        } catch (err) {
            this.accessToken = null;
            this.sessionData = null;
            throw new Error('Invalid access token: ' + err.message);
        }
    }

    // ─── AUTH FLOW ────────────────────────────────────────

    // Step 1: Get Zerodha login URL
    getLoginURL() {
        if (!API_KEY) throw new Error('KITE_API_KEY not set in .env');
        return `https://kite.trade/connect/login?api_key=${API_KEY}&v=3`;
    }

    // Step 2: Callback handler — Zerodha redirects here with request_token
    async handleCallback(requestToken) {
        if (!requestToken) throw new Error('request_token is required');
        if (!API_KEY || !API_SECRET) throw new Error('KITE_API_KEY or KITE_API_SECRET not set');

        const checksum = this.generateChecksum(requestToken);

        const params = new URLSearchParams();
        params.append('api_key', API_KEY);
        params.append('request_token', requestToken);
        params.append('checksum', checksum);

        const response = await fetch(`${BASE_URL}/session/token`, {
            method: 'POST',
            headers: {
                'X-Kite-Version': '3',
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params
        });

        const data = await response.json();

        if (data.status === 'success') {
            this.accessToken = data.data.access_token;
            this.sessionData = data.data;
            this.saveSession(data.data);
            console.log('✅ Kite session created successfully');
            return data.data;
        } else {
            throw new Error(data.message || 'Kite authentication failed');
        }
    }

    generateChecksum(requestToken) {
        const hash = crypto.createHash('sha256');
        hash.update(API_KEY + requestToken + API_SECRET);
        return hash.digest('hex');
    }

    // ─── STATUS ───────────────────────────────────────────

    isAuthenticated() {
        return !!this.accessToken;
    }

    getStatus() {
        return {
            connected: !!this.accessToken,
            api_key: API_KEY ? `${API_KEY.substring(0, 4)}...` : null,
            user: this.sessionData?.user_name || null,
            user_id: this.sessionData?.user_id || null,
            email: this.sessionData?.email || null,
            broker: this.sessionData?.broker || null,
            login_time: this.sessionData?.login_time || null,
            saved_at: this.sessionData?.saved_at || null,
        };
    }

    // ─── API HEADERS ──────────────────────────────────────

    createHeaders() {
        if (!this.accessToken) {
            throw new Error('Kite not connected. Please login first via /api/kite/login');
        }
        return {
            'X-Kite-Version': '3',
            'Authorization': `token ${API_KEY}:${this.accessToken}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        };
    }

    // ─── API METHODS ──────────────────────────────────────

    async getProfile() { return this.makeRequest('/user/profile'); }
    async getMargins() { return this.makeRequest('/user/margins'); }
    async getHoldings() { return this.makeRequest('/portfolio/holdings'); }
    async getPositions() { return this.makeRequest('/portfolio/positions'); }
    async getOrders() { return this.makeRequest('/orders'); }
    async getTrades() { return this.makeRequest('/trades'); }

    _mapVirtualToMega(instrument) {
        if (!instrument.startsWith('MCX:M')) return instrument;
        const cleanSym = instrument.replace('MCX:', '').trim();
        if (this.nearestMegaMap && this.nearestMegaMap[cleanSym]) {
            return `MCX:${this.nearestMegaMap[cleanSym]}`;
        }
        const VIRTUAL_MAP = {
            'MGOLD': 'GOLD',
            'MCRUDEOIL': 'CRUDEOIL',
            'MSILVER': 'SILVER',
            'MNATURALGAS': 'NATURALGAS',
            'MCOPPER': 'COPPER',
            'MLEAD': 'LEAD',
            'MZINC': 'ZINC',
            'MALUMINIUM': 'ALUMINIUM'
        };
        let mapped = instrument;
        for (const [virt, mega] of Object.entries(VIRTUAL_MAP)) {
            if (instrument.includes(`MCX:${virt}`)) {
                mapped = instrument.replace(`MCX:${virt}`, `MCX:${mega}`);
                break;
            }
        }
        return mapped;
    }

    async getQuote(instruments) {
        const arr = Array.isArray(instruments) ? instruments : instruments.split(',');
        const queryMap = {};
        const kiteQuery = [];
        
        arr.forEach(i => {
            const mapped = this._mapVirtualToMega(i);
            if (!queryMap[mapped]) queryMap[mapped] = [];
            queryMap[mapped].push(i);
            kiteQuery.push(`i=${encodeURIComponent(mapped.trim())}`);
        });

        const uniqueQuery = [...new Set(kiteQuery)].join('&');
        const data = await this.makeRequest(`/quote?${uniqueQuery}`);
        
        const result = {};
        for (const [mappedSym, val] of Object.entries(data)) {
            if (queryMap[mappedSym]) {
                queryMap[mappedSym].forEach(originalSym => {
                    result[originalSym] = { ...val };
                });
            } else {
                result[mappedSym] = val;
            }
        }
        return result;
    }

    async getLTP(instruments) {
        const arr = Array.isArray(instruments) ? instruments : instruments.split(',');
        const queryMap = {};
        const kiteQuery = [];
        
        arr.forEach(i => {
            const mapped = this._mapVirtualToMega(i);
            if (!queryMap[mapped]) queryMap[mapped] = [];
            queryMap[mapped].push(i);
            kiteQuery.push(`i=${encodeURIComponent(mapped.trim())}`);
        });

        const uniqueQuery = [...new Set(kiteQuery)].join('&');
        const data = await this.makeRequest(`/quote/ltp?${uniqueQuery}`);
        
        const result = {};
        for (const [mappedSym, val] of Object.entries(data)) {
            if (queryMap[mappedSym]) {
                queryMap[mappedSym].forEach(originalSym => {
                    result[originalSym] = { ...val };
                });
            } else {
                result[mappedSym] = val;
            }
        }
        return result;
    }


    async getInstruments() {
        // The /instruments endpoint returns CSV, not JSON
        const headers = this.createHeaders();
        const response = await fetch(`${BASE_URL}/instruments`, { method: 'GET', headers });

        if (response.status === 403) {
            throw new Error('Kite session expired (403). Please set a new access token.');
        }

        const csv = await response.text();
        const lines = csv.trim().split('\n');
        const headers_arr = lines[0].split(',');

        const instruments = [];
        const clonedInstruments = [];
        const CUSTOM_BASES = {
            'GOLD': 'MGOLD',
            'CRUDEOIL': 'MCRUDEOIL',
            'SILVER': 'MSILVER',
            'NATURALGAS': 'MNATURALGAS',
            'COPPER': 'MCOPPER',
            'LEAD': 'MLEAD',
            'ZINC': 'MZINC',
            'ALUMINIUM': 'MALUMINIUM'
        };

        for (let i = 1; i < lines.length; i++) {
            const values = lines[i].split(',');
            const instrument = {};
            headers_arr.forEach((h, idx) => {
                let val = values[idx]?.trim() || '';
                // Strip surrounding quotes from CSV fields
                if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
                instrument[h.trim()] = val;
            });
            instruments.push(instrument);
        }

        const now = new Date();
        this.nearestMegaMap = {};
        for (const [mega, custom] of Object.entries(CUSTOM_BASES)) {
            const futs = instruments
                .filter(i => i.exchange === 'MCX' && i.instrument_type === 'FUT' && i.name === mega)
                .filter(i => new Date(i.expiry || 0) >= now)
                .sort((a, b) => new Date(a.expiry || 0) - new Date(b.expiry || 0));

            if (futs.length > 0) {
                const nearest = futs[0];
                this.nearestMegaMap[custom] = nearest.tradingsymbol;
                clonedInstruments.push({
                    ...nearest,
                    name: custom,
                    tradingsymbol: custom
                });
            }
        }

        return [...instruments, ...clonedInstruments];
    }

    async getHistoricalData(instrumentToken, interval, from, to) {
        return this.makeRequest(`/instruments/historical/${instrumentToken}/${interval}?from=${from}&to=${to}`);
    }

    // ─── GENERIC REQUEST ──────────────────────────────────

    async makeRequest(endpoint, method = 'GET', body = null) {
        const headers = this.createHeaders();

        const response = await fetch(`${BASE_URL}${endpoint}`, {
            method,
            headers,
            body: body ? JSON.stringify(body) : null
        });

        // Token expired
        if (response.status === 403) {
            throw new Error('Kite session expired (403). Please set a new access token.');
        }

        const data = await response.json();

        if (data.status === 'success') {
            return data.data;
        } else {
            throw new Error(data.message || 'Kite API request failed');
        }
    }
}

module.exports = new KiteService();
