const db = require('../config/db');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

/**
 * 1. Fetch All Active / Registered Scrip Symbols Across Segments
 */
const isContractActive = (sym) => {
    if (!sym) return false;
    const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
    const match = sym.match(/(\d{2})([A-Z]{3})/);
    if (!match) return true; // Base symbols like BANKNIFTY, NIFTY, GOLD, etc.
    
    const year = 2000 + parseInt(match[1], 10);
    const monthStr = match[2];
    const month = months[monthStr];
    if (month === undefined) return true;
    
    // Contract expires on the last day of the contract month at 23:59:59
    const expiryDate = new Date(year, month + 1, 0, 23, 59, 59);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    return expiryDate >= today;
};

/**
 * 1. Get Scrip List for Dropdown (Matching Active Trading / Rollover Contracts)
 */
const getScripList = async (req, res) => {
    try {
        const symbolSet = new Set();

        // 1. Load active contracts from manually enabled & selected files (matching Live Quotes & Rollover)
        const dataDir = path.join(__dirname, '../data');
        const manFile = path.join(dataDir, 'manually_enabled_contracts.json');
        const selFile = path.join(dataDir, 'selected_contracts.json');
        const excFile = path.join(dataDir, 'excluded_contracts.json');

        let excluded = new Set();
        if (fs.existsSync(excFile)) {
            try {
                const arr = JSON.parse(fs.readFileSync(excFile, 'utf8'));
                if (Array.isArray(arr)) arr.forEach(s => excluded.add(s));
            } catch (_) {}
        }

        [manFile, selFile].forEach(f => {
            if (fs.existsSync(f)) {
                try {
                    const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
                    if (Array.isArray(arr)) {
                        arr.forEach(sym => {
                            if (!excluded.has(sym)) {
                                const clean = sym.includes(':') ? sym.split(':')[1] : sym;
                                if (isContractActive(clean)) {
                                    symbolSet.add(clean);
                                }
                            }
                        });
                    }
                } catch (_) {}
            }
        });

        // 2. Load active Market Group Items
        const [mgiRows] = await db.execute(`
            SELECT mgi.symbol 
            FROM market_group_items mgi 
            JOIN market_groups mg ON mgi.group_id = mg.id
            WHERE mg.name IN ('COMMODITY', 'MCX FUTURES', 'CRYPTO', 'FOREX', 'NFO INDICES')
               OR mgi.symbol LIKE '%FUT%' 
               OR mgi.symbol LIKE '%CE%' 
               OR mgi.symbol LIKE '%PE%'
        `);
        mgiRows.forEach(r => r.symbol && isContractActive(r.symbol) && symbolSet.add(r.symbol));

        // 3. Load logged tick history scrip IDs (only non-expired)
        const [historyRows] = await db.execute(`
            SELECT DISTINCT scrip_id as symbol FROM scrip_ticks_history
        `);
        historyRows.forEach(r => r.symbol && isContractActive(r.symbol) && symbolSet.add(r.symbol));

        const scrips = Array.from(symbolSet).sort();
        return res.json({ success: true, count: scrips.length, data: scrips });
    } catch (err) {
        console.error('[scripTickController] Error fetching scrip list:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * 2. Get Filtered Tick History Data (Matching attached UI filter)
 */
const getTickHistory = async (req, res) => {
    try {
        const { date, hour, minute, scripId, limit = 500, page = 1 } = req.query;

        let whereClauses = [];
        let params = [];

        if (scripId && scripId !== 'ALL' && scripId !== 'Select Scrip') {
            whereClauses.push('scrip_id = ?');
            params.push(scripId);
        }

        if (date) {
            let dateStr = date;
            if (date.includes('/')) {
                const parts = date.split('/');
                if (parts.length === 3) {
                    dateStr = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
                }
            }

            const isHourValid = hour !== undefined && hour !== '' && hour !== 'ALL';
            const isMinuteValid = minute !== undefined && minute !== '' && minute !== 'ALL';

            const isUtcServer = new Date().getTimezoneOffset() === 0 || process.env.TZ === 'UTC';

            if (isUtcServer) {
                const hStart = isHourValid ? String(hour).padStart(2, '0') : '00';
                const hEnd = isHourValid ? String(hour).padStart(2, '0') : '23';
                const mStart = isMinuteValid ? String(minute).padStart(2, '0') : '00';
                const mEnd = isMinuteValid ? String(minute).padStart(2, '0') : '59';

                const dStart = new Date(`${dateStr}T${hStart}:${mStart}:00+05:30`);
                const dEnd = new Date(`${dateStr}T${hEnd}:${mEnd}:59+05:30`);

                whereClauses.push('system_time BETWEEN ? AND ?');
                params.push(
                    dStart.toISOString().replace('T', ' ').slice(0, 19),
                    dEnd.toISOString().replace('T', ' ').slice(0, 19)
                );
            } else {
                if (isHourValid && isMinuteValid) {
                    const hStr = String(hour).padStart(2, '0');
                    const mStr = String(minute).padStart(2, '0');
                    whereClauses.push('system_time BETWEEN ? AND ?');
                    params.push(`${dateStr} ${hStr}:${mStr}:00`, `${dateStr} ${hStr}:${mStr}:59`);
                } else if (isHourValid) {
                    const hStr = String(hour).padStart(2, '0');
                    whereClauses.push('system_time BETWEEN ? AND ?');
                    params.push(`${dateStr} ${hStr}:00:00`, `${dateStr} ${hStr}:59:59`);
                } else {
                    whereClauses.push('system_time BETWEEN ? AND ?');
                    params.push(`${dateStr} 00:00:00`, `${dateStr} 23:59:59`);
                }
            }
        }

        const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

        const [countRows] = await db.execute(
            `SELECT COUNT(*) as total FROM scrip_ticks_history ${whereSql}`,
            params
        );
        const total = countRows[0]?.total || 0;

        const parsedLimit = parseInt(limit, 10) || 500;
        const parsedPage = parseInt(page, 10) || 1;
        const offset = (parsedPage - 1) * parsedLimit;

        const [rows] = await db.execute(
            `SELECT id, scrip_id, exchange_time, system_time, bid, ask, high, low, ltp 
             FROM scrip_ticks_history 
             ${whereSql} 
             ORDER BY id DESC 
             LIMIT ${parsedLimit} OFFSET ${offset}`,
            params
        );

        const formattedRows = rows.map(r => ({
            id: r.id,
            scripId: r.scrip_id,
            exchangeTime: formatISTTimestamp(r.exchange_time),
            systemTime: formatISTTimestamp(r.system_time),
            bid: r.bid,
            ask: r.ask,
            high: r.high,
            low: r.low,
            ltp: r.ltp
        }));

        return res.json({
            success: true,
            total,
            page: parsedPage,
            limit: parsedLimit,
            items: formattedRows
        });
    } catch (err) {
        console.error('[scripTickController] Error fetching tick history:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * 3. Get Export Settings
 */
const getExportSettings = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM scrip_export_settings WHERE id = 1');
        let settings = rows[0];

        if (!settings) {
            const [adminRows] = await db.execute(`SELECT email FROM users WHERE role = 'SUPERADMIN' AND email IS NOT NULL LIMIT 1`);
            const defaultEmail = adminRows[0]?.email || 'admin@trading.com';
            settings = {
                export_email: defaultEmail,
                export_destination: 'EMAIL',
                google_drive_folder_id: '',
                auto_clean_days: 7
            };
        }

        return res.json({ success: true, settings });
    } catch (err) {
        console.error('[scripTickController] Error fetching export settings:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * 4. Update Export Settings
 */
const updateExportSettings = async (req, res) => {
    try {
        const { export_email, export_destination, google_drive_folder_id, auto_clean_days } = req.body;

        await db.execute(`
            INSERT INTO scrip_export_settings (id, export_email, export_destination, google_drive_folder_id, auto_clean_days)
            VALUES (1, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                export_email = VALUES(export_email),
                export_destination = VALUES(export_destination),
                google_drive_folder_id = VALUES(google_drive_folder_id),
                auto_clean_days = VALUES(auto_clean_days)
        `, [
            export_email || null,
            export_destination || 'EMAIL',
            google_drive_folder_id || null,
            parseInt(auto_clean_days, 10) || 7
        ]);

        return res.json({ success: true, message: 'Settings saved successfully' });
    } catch (err) {
        console.error('[scripTickController] Error updating settings:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const formatISTTimestamp = (val) => {
    if (!val) return '';
    const isUtcServer = new Date().getTimezoneOffset() === 0 || process.env.TZ === 'UTC';

    if (!isUtcServer && typeof val === 'string' && val.length >= 19 && !val.includes('Z') && !val.includes('+')) {
        return val.replace('T', ' ').slice(0, 19);
    }
    const d = new Date(val);
    if (isNaN(d.getTime())) return String(val).slice(0, 19);

    if (isUtcServer) {
        // Convert UTC to IST (+5:30) for AWS EC2 server
        const istOffset = 5.5 * 60 * 60 * 1000;
        const istDate = new Date(d.getTime() + (d.getTimezoneOffset() * 60000) + istOffset);
        const pad = (n) => String(n).padStart(2, '0');
        return `${istDate.getFullYear()}-${pad(istDate.getMonth() + 1)}-${pad(istDate.getDate())} ${pad(istDate.getHours())}:${pad(istDate.getMinutes())}:${pad(istDate.getSeconds())}`;
    }

    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const formatPdfTimestamp = (val) => formatISTTimestamp(val);

/**
 * Helper: Generate PDF File Stream
 */
const createPdfStream = (ticks, titleSub = '') => {
    const doc = new PDFDocument({ margin: 25, size: 'A4' });

    doc.fontSize(16).text('SUPERADMIN - SCRIPT TICK DATA REPORT', { align: 'center' });
    doc.fontSize(9).text(`Generated On: ${formatPdfTimestamp(new Date())} ${titleSub ? ' | ' + titleSub : ''}`, { align: 'center' });
    doc.moveDown(1.2);

    const startY = doc.y;
    doc.fontSize(8).font('Helvetica-Bold');
    doc.text('ID', 25, startY, { width: 45 });
    doc.text('Scrip ID', 72, startY, { width: 110 });
    doc.text('Exchange Time', 185, startY, { width: 105 });
    doc.text('System Time', 293, startY, { width: 105 });
    doc.text('Bid', 400, startY, { width: 50, align: 'right' });
    doc.text('Ask', 452, startY, { width: 50, align: 'right' });
    doc.text('LTP', 505, startY, { width: 55, align: 'right' });
    doc.moveDown(0.5);

    doc.moveTo(25, doc.y).lineTo(565, doc.y).stroke();
    doc.moveDown(0.3);

    doc.font('Helvetica').fontSize(7);
    ticks.forEach((t) => {
        if (doc.y > 760) {
            doc.addPage();
            doc.moveTo(25, 25).lineTo(565, 25).stroke();
            doc.y = 30;
        }

        const y = doc.y;
        doc.text(String(t.id), 25, y, { width: 45 });
        doc.text(String(t.scrip_id || t.scripId || ''), 72, y, { width: 110 });
        doc.text(formatPdfTimestamp(t.exchange_time || t.exchangeTime), 185, y, { width: 105 });
        doc.text(formatPdfTimestamp(t.system_time || t.systemTime), 293, y, { width: 105 });
        doc.text(Number(t.bid || 0).toFixed(2), 400, y, { width: 50, align: 'right' });
        doc.text(Number(t.ask || 0).toFixed(2), 452, y, { width: 50, align: 'right' });
        doc.text(Number(t.ltp || 0).toFixed(2), 505, y, { width: 55, align: 'right' });
        doc.moveDown(0.2);
    });

    return doc;
};

/**
 * 5. Download PDF directly from UI
 */
const downloadPdf = async (req, res) => {
    try {
        const { date, scripId } = req.query;
        let whereClauses = [];
        let params = [];

        if (scripId && scripId !== 'ALL' && scripId !== 'Select Scrip') {
            whereClauses.push('scrip_id = ?');
            params.push(scripId);
        }

        const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
        const [rows] = await db.execute(
            `SELECT id, scrip_id, exchange_time, system_time, bid, ask, high, low, ltp 
             FROM scrip_ticks_history ${whereSql} ORDER BY id DESC LIMIT 2000`,
            params
        );

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=script_data_${Date.now()}.pdf`);

        const doc = createPdfStream(rows, `Scrip: ${scripId || 'All'}`);
        doc.pipe(res);
        doc.end();
    } catch (err) {
        console.error('[scripTickController] Error downloading PDF:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * 6. Send Email with PDF Attachment & Purge Database
 */
const sendPdfReportAndPurge = async ({ forceAll = false, daysBefore = 7 } = {}) => {
    const [settingsRows] = await db.execute('SELECT * FROM scrip_export_settings WHERE id = 1');
    const settings = settingsRows[0] || {};
    const targetEmail = settings.export_email;

    if (!targetEmail) {
        throw new Error('Export email address is not configured in Settings.');
    }

    let query = forceAll
        ? 'SELECT id, scrip_id, exchange_time, system_time, bid, ask, high, low, ltp FROM scrip_ticks_history ORDER BY id DESC LIMIT 5000'
        : `SELECT id, scrip_id, exchange_time, system_time, bid, ask, high, low, ltp FROM scrip_ticks_history WHERE created_at < NOW() - INTERVAL ${parseInt(daysBefore, 10)} DAY ORDER BY id DESC LIMIT 5000`;

    const [rows] = await db.execute(query);

    if (rows.length === 0) {
        console.log('[scripTickController] ℹ️ No tick records found for cleanup export.');
        return { count: 0, message: 'No records to purge' };
    }

    const reportsDir = path.join(__dirname, '../../uploads/reports');
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
    }

    const pdfPath = path.join(reportsDir, `script_data_export_${Date.now()}.pdf`);
    const writeStream = fs.createWriteStream(pdfPath);
    const doc = createPdfStream(rows, `Total Records: ${rows.length}`);

    doc.pipe(writeStream);
    doc.end();

    await new Promise((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
    });

    const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com';
    const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10);
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;

    if (!smtpUser || !smtpPass) {
        console.warn('[scripTickController] ⚠️ SMTP credentials not set in ENV. Skipping email send but PDF report generated.');
    } else {
        const transporter = nodemailer.createTransport({
            host: smtpHost,
            port: smtpPort,
            secure: smtpPort === 465,
            auth: { user: smtpUser, pass: smtpPass }
        });

        await transporter.sendMail({
            from: `"Trading App" <${smtpUser}>`,
            to: targetEmail,
            subject: `📊 Script Data Export & Purge Report (${rows.length} records)`,
            text: `Hello Superadmin,\n\nPlease find attached the exported Script Data tick report containing ${rows.length} records.\n\nThe database has been cleaned to prevent lag.\n\nBest regards,\nTrading System`,
            attachments: [
                {
                    filename: `ScriptData_Report_${new Date().toISOString().slice(0, 10)}.pdf`,
                    path: pdfPath
                }
            ]
        });
        console.log(`[scripTickController] ✅ Email sent successfully to ${targetEmail}`);
    }

    let deleteQuery = forceAll
        ? 'DELETE FROM scrip_ticks_history'
        : `DELETE FROM scrip_ticks_history WHERE created_at < NOW() - INTERVAL ${parseInt(daysBefore, 10)} DAY`;

    const [deleteResult] = await db.execute(deleteQuery);
    console.log(`[scripTickController] 🗑️ Purged ${deleteResult.affectedRows} records from scrip_ticks_history`);

    if (fs.existsSync(pdfPath)) {
        fs.unlinkSync(pdfPath);
    }

    return { count: deleteResult.affectedRows, emailSentTo: targetEmail };
};

/**
 * 7. Manual Trigger Endpoint for Export & Purge
 */
const triggerCleanup = async (req, res) => {
    try {
        const { forceAll = false, daysBefore = 7 } = req.body;
        const result = await sendPdfReportAndPurge({ forceAll, daysBefore });
        return res.json({
            success: true,
            message: `Successfully exported and cleared ${result.count} records. Sent to ${result.emailSentTo || 'configured email'}.`,
            count: result.count
        });
    } catch (err) {
        console.error('[scripTickController] Manual cleanup error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

module.exports = {
    getScripList,
    getTickHistory,
    getExportSettings,
    updateExportSettings,
    downloadPdf,
    triggerCleanup,
    sendPdfReportAndPurge
};
