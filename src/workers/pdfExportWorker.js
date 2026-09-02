const fs = require('fs');
const path = require('path');
const axios = require('axios');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const db = require('../config/db');

// IST Timestamp formatter
const formatISTTimestamp = (val) => {
    if (!val) return '';
    if (typeof val === 'string' && val.length >= 19 && !val.includes('Z') && !val.includes('+')) {
        return val.replace('T', ' ').slice(0, 19);
    }
    const d = new Date(val);
    if (isNaN(d.getTime())) return String(val).slice(0, 19);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

async function runWorker() {
    console.log('[pdfExportWorker] 🚀 Background Worker started in separate Node OS process...');
    
    let args = {};
    try {
        const rawArg = process.argv.slice(2).join(' ');
        if (rawArg) {
            args = JSON.parse(rawArg);
        }
    } catch (e) {
        if (process.argv.some(a => a.includes('forceAll'))) {
            args.forceAll = true;
        }
    }

    const forceAll = args.forceAll || false;
    const daysBefore = args.daysBefore || 7;

    try {
        // 1. Get export target email from DB
        const [settingsRows] = await db.execute('SELECT export_email FROM scrip_export_settings WHERE id = 1');
        const targetEmail = settingsRows[0]?.export_email || 'superadmin@trading.com';

        // 2. Fetch ALL matching tick records (No row limit!)
        let query = forceAll
            ? 'SELECT id, scrip_id, exchange_time, system_time, bid, ask, high, low, ltp FROM scrip_ticks_history ORDER BY id DESC LIMIT 20000'
            : `SELECT id, scrip_id, exchange_time, system_time, bid, ask, high, low, ltp FROM scrip_ticks_history WHERE created_at < NOW() - INTERVAL ${parseInt(daysBefore, 10)} DAY ORDER BY id DESC LIMIT 20000`;

        console.log(`[pdfExportWorker] 🔍 Fetching tick records for export (forceAll=${forceAll})...`);
        const [rows] = await db.execute(query);
        console.log(`[pdfExportWorker] 📊 Total records fetched: ${rows.length}`);

        if (rows.length === 0) {
            console.log('[pdfExportWorker] ℹ️ No tick records found. Exiting worker.');
            process.exit(0);
        }

        // 3. Ensure reports directory exists
        const reportsDir = path.join(__dirname, '../../uploads/reports');
        if (!fs.existsSync(reportsDir)) {
            fs.mkdirSync(reportsDir, { recursive: true });
        }

        const pdfPath = path.join(reportsDir, `ScriptData_Report_${Date.now()}.pdf`);
        const writeStream = fs.createWriteStream(pdfPath);

        // 4. Generate PDF Document
        console.log(`[pdfExportWorker] 📄 Generating PDF report for ${rows.length} records...`);
        const doc = new PDFDocument({ margin: 25, size: 'A4', bufferPages: false });
        doc.pipe(writeStream);

        doc.fontSize(16).text('SUPERADMIN - SCRIPT TICK DATA REPORT', { align: 'center' });
        doc.fontSize(9).text(`Generated On: ${formatISTTimestamp(new Date())} | Total Records: ${rows.length}`, { align: 'center' });
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
        rows.forEach((t) => {
            if (doc.y > 760) {
                doc.addPage();
                doc.moveTo(25, 25).lineTo(565, 25).stroke();
                doc.y = 30;
            }
            const y = doc.y;
            doc.text(String(t.id), 25, y, { width: 45 });
            doc.text(String(t.scrip_id || t.scripId || ''), 72, y, { width: 110 });
            doc.text(formatISTTimestamp(t.exchange_time || t.exchangeTime), 185, y, { width: 105 });
            doc.text(formatISTTimestamp(t.system_time || t.systemTime), 293, y, { width: 105 });
            doc.text(Number(t.bid || 0).toFixed(2), 400, y, { width: 50, align: 'right' });
            doc.text(Number(t.ask || 0).toFixed(2), 452, y, { width: 50, align: 'right' });
            doc.text(Number(t.ltp || 0).toFixed(2), 505, y, { width: 55, align: 'right' });
            doc.moveDown(0.2);
        });

        doc.end();

        await new Promise((resolve, reject) => {
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });
        console.log(`[pdfExportWorker] ✅ PDF successfully created: ${pdfPath}`);

        // 5. Send Email via Brevo API Key v3 or SMTP
        const brevoApiKey = process.env.BREVO_API_KEY;
        const senderEmail = process.env.SMTP_FROM_EMAIL || process.env.BREVO_SENDER_EMAIL || process.env.SMTP_USER || 'info@kiaantechnology.com';
        const senderName = process.env.SMTP_FROM_NAME || 'Kiaan Technology Pvt Ltd';

        if (brevoApiKey) {
            console.log(`[pdfExportWorker] ✉️ Sending email via Brevo API v3 to ${targetEmail}...`);
            const pdfBase64 = fs.readFileSync(pdfPath).toString('base64');
            await axios.post(
                'https://api.brevo.com/v3/smtp/email',
                {
                    sender: { name: senderName, email: senderEmail },
                    to: [{ email: targetEmail }],
                    subject: `📊 Script Data Export & Purge Report (${rows.length} records)`,
                    htmlContent: `<p>Hello Superadmin,</p><p>Please find attached the exported Script Data tick report containing <b>${rows.length}</b> records.</p><p>The database has been cleaned to prevent lag.</p><p>Best regards,<br/>${senderName}</p>`,
                    attachment: [
                        {
                            name: `ScriptData_Report_${new Date().toISOString().slice(0, 10)}.pdf`,
                            content: pdfBase64
                        }
                    ]
                },
                {
                    headers: {
                        'api-key': brevoApiKey,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    }
                }
            );
            console.log(`[pdfExportWorker] ✅ Email successfully sent via Brevo API v3 to ${targetEmail}`);
        } else if (process.env.SMTP_USER && process.env.SMTP_PASS) {
            console.log(`[pdfExportWorker] ✉️ Sending email via SMTP to ${targetEmail}...`);
            const transporter = nodemailer.createTransport({
                host: process.env.SMTP_HOST || 'smtp.gmail.com',
                port: parseInt(process.env.SMTP_PORT || '587', 10),
                secure: process.env.SMTP_PORT === '465',
                auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
            });
            await transporter.sendMail({
                from: `"${senderName}" <${process.env.SMTP_USER}>`,
                to: targetEmail,
                subject: `📊 Script Data Export & Purge Report (${rows.length} records)`,
                text: `Hello Superadmin,\n\nPlease find attached the exported Script Data tick report containing ${rows.length} records.\n\nBest regards,\n${senderName}`,
                attachments: [{ filename: `ScriptData_Report.pdf`, path: pdfPath }]
            });
            console.log(`[pdfExportWorker] ✅ Email sent via SMTP to ${targetEmail}`);
        }

        // 6. Purge Database (Uses Primary Key index to avoid MySQL Metadata Table Lock freezes)
        const maxExportedId = rows[0]?.id;
        if (maxExportedId) {
            const [delRes] = await db.execute('DELETE FROM scrip_ticks_history WHERE id <= ?', [maxExportedId]);
            console.log(`[pdfExportWorker] 🗑️ Purged ${delRes.affectedRows} exported records (ID <= ${maxExportedId}) from scrip_ticks_history`);
        }

        // 7. Cleanup PDF file
        if (fs.existsSync(pdfPath)) {
            fs.unlinkSync(pdfPath);
        }

        console.log('[pdfExportWorker] 🎉 Worker completed successfully!');
        process.exit(0);
    } catch (err) {
        console.error('[pdfExportWorker] ❌ Worker Error:', err.response?.data || err.message);
        process.exit(1);
    }
}

runWorker();
