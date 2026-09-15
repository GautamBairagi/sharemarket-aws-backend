const fs = require('fs');
const path = require('path');
const axios = require('axios');
const nodemailer = require('nodemailer');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
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
    console.log('[s3ExportWorker] 🚀 AWS S3 ZIP Export Worker started in separate Node OS process...');

    // Dynamic import for ESM package 'archiver'
    let archiver = null;
    try {
        const archiverModule = await import('archiver');
        archiver = archiverModule.default || archiverModule;
    } catch (importErr) {
        console.warn('[s3ExportWorker] ⚠️ Could not load archiver module:', importErr.message);
    }

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
        // 1. Check AWS S3 Credentials in ENV
        const s3AccessKey = process.env.AWS_ACCESS_KEY_ID;
        const s3SecretKey = process.env.AWS_SECRET_ACCESS_KEY;
        const s3Region = process.env.AWS_REGION || 'ap-south-1';
        const s3Bucket = process.env.AWS_S3_BUCKET_NAME;

        console.log(`[s3ExportWorker] 🔑 AWS Config - Bucket: "${s3Bucket}", Region: "${s3Region}", AccessKey: "${s3AccessKey ? (s3AccessKey.slice(0, 5) + '...') : 'MISSING'}"`);

        // 2. Fetch target email from DB settings
        const [settingsRows] = await db.execute('SELECT export_email FROM scrip_export_settings WHERE id = 1');
        const targetEmail = settingsRows[0]?.export_email || 'superadmin@trading.com';

        // 3. Ensure temporary exports folder exists
        const tempDir = path.join(__dirname, '../../uploads/reports');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        const dateStr = new Date().toISOString().slice(0, 10);
        const timestamp = Date.now();
        const zipFileName = `ScriptData_Report_${dateStr}_${timestamp}.zip`;
        const zipFilePath = path.join(tempDir, zipFileName);

        // 4. Check total count before exporting
        const [cntRows] = await db.execute('SELECT COUNT(id) as total FROM scrip_ticks_history');
        const totalRowsInDb = cntRows[0]?.total || 0;
        console.log(`[s3ExportWorker] 📊 Total tick rows in DB before purge: ${totalRowsInDb.toLocaleString()}`);

        if (totalRowsInDb === 0) {
            console.log('[s3ExportWorker] ℹ️ No tick records found for export. Truncating table to reset auto-increment.');
            await db.execute('TRUNCATE TABLE scrip_ticks_history');
            await db.execute('ANALYZE TABLE scrip_ticks_history');
            console.log('[s3ExportWorker] ✅ Table truncated. Worker exiting.');
            process.exit(0);
        }

        // Cap single export to 500,000 rows to prevent heap OOM / PM2 kill
        const MAX_EXPORT_ROWS = 500000;
        console.log(`[s3ExportWorker] 📝 Writing up to ${MAX_EXPORT_ROWS.toLocaleString()} tick records to CSV/ZIP (forceAll=${forceAll})...`);
        const csvHeader = 'ID,Scrip ID,Exchange Time,System Time,Bid,Ask,LTP\n';
        const MAX_ROWS_PER_FILE = 1000000;

        let partIndex = 1;
        let currentFileRows = 0;
        let rowCount = 0;
        let lastId = 0;
        let hasMore = true;

        let currentCsvFileName = `ScriptData_${dateStr}_Part_${partIndex}.csv`;
        let currentCsvFilePath = path.join(tempDir, currentCsvFileName);
        let createdCsvFiles = [{ fileName: currentCsvFileName, filePath: currentCsvFilePath }];

        let currentCsvStream = fs.createWriteStream(currentCsvFilePath, { flags: 'w' });
        currentCsvStream.write(csvHeader);

        while (hasMore && rowCount < MAX_EXPORT_ROWS) {
            const fetchLimit = Math.min(10000, MAX_EXPORT_ROWS - rowCount);
            let batchQuery = forceAll
                ? `SELECT id, scrip_id, exchange_time, system_time, bid, ask, high, low, ltp FROM scrip_ticks_history WHERE id > ? ORDER BY id ASC LIMIT ${fetchLimit}`
                : `SELECT id, scrip_id, exchange_time, system_time, bid, ask, high, low, ltp FROM scrip_ticks_history WHERE id > ? AND created_at < NOW() - INTERVAL ${parseInt(daysBefore, 10)} DAY ORDER BY id ASC LIMIT ${fetchLimit}`;

            const [batchRows] = await db.execute(batchQuery, [lastId]);

            if (!batchRows || batchRows.length === 0) {
                hasMore = false;
                break;
            }

            for (const r of batchRows) {
                rowCount++;
                currentFileRows++;
                lastId = r.id;

                const line = `${r.id},"${r.scrip_id || ''}","${formatISTTimestamp(r.exchange_time)}","${formatISTTimestamp(r.system_time)}",${r.bid || 0},${r.ask || 0},${r.ltp || 0}\n`;
                currentCsvStream.write(line);

                if (currentFileRows >= MAX_ROWS_PER_FILE) {
                    currentCsvStream.end();
                    partIndex++;
                    currentFileRows = 0;

                    currentCsvFileName = `ScriptData_${dateStr}_Part_${partIndex}.csv`;
                    currentCsvFilePath = path.join(tempDir, currentCsvFileName);
                    createdCsvFiles.push({ fileName: currentCsvFileName, filePath: currentCsvFilePath });

                    currentCsvStream = fs.createWriteStream(currentCsvFilePath, { flags: 'w' });
                    currentCsvStream.write(csvHeader);
                }
            }

            console.log(`[s3ExportWorker] 🔄 Batched ${rowCount.toLocaleString()} records (Part ${partIndex})...`);

            if (batchRows.length < fetchLimit) {
                hasMore = false;
            }
        }

        currentCsvStream.end();
        await new Promise((res, rej) => {
            currentCsvStream.on('finish', res);
            currentCsvStream.on('error', rej);
        });

        console.log(`[s3ExportWorker] 📊 Finished writing ${rowCount.toLocaleString()} total records across ${createdCsvFiles.length} CSV part file(s).`);

        // 5. Compress CSV Parts into .ZIP Archive using archiver
        let zipMb = '0.00';
        if (archiver) {
            try {
                console.log(`[s3ExportWorker] 📦 Compressing ${createdCsvFiles.length} CSV part(s) into ZIP archive...`);
                const zipOutputStream = fs.createWriteStream(zipFilePath);
                const archive = archiver('zip', { zlib: { level: 9 } });

                archive.pipe(zipOutputStream);
                createdCsvFiles.forEach(f => {
                    archive.file(f.filePath, { name: f.fileName });
                });
                await archive.finalize();

                await new Promise((res, rej) => {
                    zipOutputStream.on('finish', res);
                    zipOutputStream.on('error', rej);
                });

                if (fs.existsSync(zipFilePath)) {
                    const zipStats = fs.statSync(zipFilePath);
                    zipMb = (zipStats.size / (1024 * 1024)).toFixed(2);
                    console.log(`[s3ExportWorker] ✅ ZIP archive created successfully: ${zipFileName} (${zipMb} MB) with ${createdCsvFiles.length} CSV part(s)`);
                }
            } catch (zipErr) {
                console.error('[s3ExportWorker] ⚠️ ZIP archiving error (continuing purge):', zipErr.message);
            }
        }

        // Clean up temporary CSV files after zip creation
        createdCsvFiles.forEach(f => { if (fs.existsSync(f.filePath)) fs.unlinkSync(f.filePath); });


        // 6. Upload .ZIP to Amazon S3 Bucket if credentials present
        let presignedUrl = null;
        if (s3Bucket && s3AccessKey && s3SecretKey) {
            try {
                console.log(`[s3ExportWorker] ☁️ Uploading ${zipFileName} to Amazon S3 Bucket (${s3Bucket})...`);
                const s3Client = new S3Client({
                    region: s3Region,
                    credentials: {
                        accessKeyId: s3AccessKey,
                        secretAccessKey: s3SecretKey
                    }
                });

                const s3ObjectKey = `exports/${zipFileName}`;
                const fileBuffer = fs.readFileSync(zipFilePath);

                await s3Client.send(new PutObjectCommand({
                    Bucket: s3Bucket,
                    Key: s3ObjectKey,
                    Body: fileBuffer,
                    ContentType: 'application/zip'
                }));
                console.log(`[s3ExportWorker] ✅ Uploaded to S3 key: ${s3ObjectKey}`);

                const getCmd = new GetObjectCommand({ Bucket: s3Bucket, Key: s3ObjectKey });
                presignedUrl = await getSignedUrl(s3Client, getCmd, { expiresIn: 604800 });
                console.log(`[s3ExportWorker] 🔗 Generated S3 Pre-signed Download URL (Expires in 7 Days)`);
            } catch (s3Err) {
                console.error('[s3ExportWorker] ⚠️ S3 Upload warning (continuing purge):', s3Err.message);
            }
        }

        // 7. Send Email via Brevo API Key (or SMTP) with S3 Download Button
        const brevoApiKey = process.env.BREVO_API_KEY;
        const senderEmail = process.env.SMTP_FROM_EMAIL || process.env.BREVO_SENDER_EMAIL || process.env.SMTP_USER || 'info@kiaantechnology.com';
        const senderName = process.env.SMTP_FROM_NAME || 'Kiaan Technology Pvt Ltd';

        const emailSubject = `📊 Script Tick Data Export & Clear Report (${rowCount.toLocaleString()} records)`;
        const downloadBtnHtml = presignedUrl
            ? `<div style="text-align: center; margin: 30px 0;">
                <a href="${presignedUrl}" style="background-color: #0284c7; color: #ffffff; padding: 14px 28px; font-size: 15px; font-weight: bold; text-decoration: none; border-radius: 6px; display: inline-block;">
                    📥 Download ${rowCount.toLocaleString()} Records (.zip)
                </a>
               </div>`
            : `<p style="color: #64748b;">(Local archive prepared: ${zipFileName})</p>`;

        const emailHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 10px;">
                <h2 style="color: #0f172a; text-align: center;">📊 Script Data Export & Database Clear Report</h2>
                <p>Hello Superadmin,</p>
                <p>Your market tick data (Total in DB: <b>${totalRowsInDb.toLocaleString()}</b>) has been exported and the database table has been purged successfully.</p>
                
                <div style="background-color: #f8fafc; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <p style="margin: 5px 0;"><b>Total Records in DB Before Purge:</b> ${totalRowsInDb.toLocaleString()}</p>
                    <p style="margin: 5px 0;"><b>Exported Sample:</b> ${rowCount.toLocaleString()}</p>
                    <p style="margin: 5px 0;"><b>Archive Format:</b> ZIP Compressed CSV (.zip)</p>
                    <p style="margin: 5px 0;"><b>Archive Size:</b> ${zipMb} MB</p>
                    ${presignedUrl ? `<p style="margin: 5px 0;"><b>Link Validity:</b> 7 Days (AWS S3 Presigned URL)</p>` : ''}
                </div>

                ${downloadBtnHtml}

                <p style="font-size: 12px; color: #64748b; text-align: center;">The database table scrip_ticks_history has been cleared to maintain optimal performance.<br/>Best regards,<br/><b>${senderName}</b></p>
            </div>
        `;

        try {
            if (brevoApiKey) {
                console.log(`[s3ExportWorker] ✉️ Sending email via Brevo API v3 to ${targetEmail}...`);
                await axios.post(
                    'https://api.brevo.com/v3/smtp/email',
                    {
                        sender: { name: senderName, email: senderEmail },
                        to: [{ email: targetEmail }],
                        subject: emailSubject,
                        htmlContent: emailHtml
                    },
                    {
                        headers: {
                            'api-key': brevoApiKey,
                            'Content-Type': 'application/json',
                            'Accept': 'application/json'
                        }
                    }
                );
                console.log(`[s3ExportWorker] ✅ Email successfully sent via Brevo API v3 to ${targetEmail}`);
            } else if (process.env.SMTP_USER && process.env.SMTP_PASS) {
                const transporter = nodemailer.createTransport({
                    host: process.env.SMTP_HOST || 'smtp.gmail.com',
                    port: parseInt(process.env.SMTP_PORT || '587', 10),
                    secure: process.env.SMTP_PORT === '465',
                    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
                });
                await transporter.sendMail({
                    from: `"${senderName}" <${process.env.SMTP_USER}>`,
                    to: targetEmail,
                    subject: emailSubject,
                    html: emailHtml
                });
                console.log(`[s3ExportWorker] ✅ Email sent via SMTP to ${targetEmail}`);
            }
        } catch (emailErr) {
            console.error('[s3ExportWorker] ⚠️ Email send error (continuing DB purge):', emailErr.message);
        }

        // 8. INSTANT DB PURGE USING TRUNCATE TABLE
        console.log(`[s3ExportWorker] 🗑️ Instant Purging scrip_ticks_history using TRUNCATE TABLE...`);
        try {
            await db.execute('TRUNCATE TABLE scrip_ticks_history');
            await db.execute('ANALYZE TABLE scrip_ticks_history');
            console.log(`[s3ExportWorker] ✅ Instant purge completed! Table scrip_ticks_history truncated and stats updated.`);
        } catch (truncErr) {
            console.error(`[s3ExportWorker] ⚠️ Truncate error, falling back to DELETE:`, truncErr.message);
            await db.execute('DELETE FROM scrip_ticks_history');
            await db.execute('ANALYZE TABLE scrip_ticks_history');
        }

        // 9. Cleanup local temporary ZIP file after upload
        if (fs.existsSync(zipFilePath)) fs.unlinkSync(zipFilePath);

        console.log('[s3ExportWorker] 🎉 AWS S3 ZIP Export Worker completed successfully!');
        process.exit(0);
    } catch (err) {
        console.error('[s3ExportWorker] ❌ Worker Error:', err.response?.data || err.message);
        process.exit(1);
    }
}

runWorker();
