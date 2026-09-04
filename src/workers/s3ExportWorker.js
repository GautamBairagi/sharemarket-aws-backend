const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { ZipArchive } = require('archiver');
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

        // 4. Batch query tick records and split into 1,000,000-row CSV parts for Excel compatibility
        console.log(`[s3ExportWorker] 📝 Writing tick records to CSV parts (max 1,000,000 rows/part for Excel) (forceAll=${forceAll})...`);
        const csvHeader = 'ID,Scrip ID,Exchange Time,System Time,Bid,Ask,LTP\n';
        const MAX_ROWS_PER_FILE = 1000000;

        let partIndex = 1;
        let currentFileRows = 0;
        let rowCount = 0;
        let lastId = 0;
        let maxExportedId = 0;
        let hasMore = true;

        let currentCsvFileName = `ScriptData_${dateStr}_Part_${partIndex}.csv`;
        let currentCsvFilePath = path.join(tempDir, currentCsvFileName);
        let createdCsvFiles = [{ fileName: currentCsvFileName, filePath: currentCsvFilePath }];

        let currentCsvStream = fs.createWriteStream(currentCsvFilePath, { flags: 'w' });
        currentCsvStream.write(csvHeader);

        while (hasMore) {
            let batchQuery = forceAll
                ? 'SELECT id, scrip_id, exchange_time, system_time, bid, ask, high, low, ltp FROM scrip_ticks_history WHERE id > ? ORDER BY id ASC LIMIT 10000'
                : `SELECT id, scrip_id, exchange_time, system_time, bid, ask, high, low, ltp FROM scrip_ticks_history WHERE id > ? AND created_at < NOW() - INTERVAL ${parseInt(daysBefore, 10)} DAY ORDER BY id ASC LIMIT 10000`;

            const [batchRows] = await db.execute(batchQuery, [lastId]);

            if (!batchRows || batchRows.length === 0) {
                hasMore = false;
                break;
            }

            for (const r of batchRows) {
                rowCount++;
                currentFileRows++;
                if (r.id > maxExportedId) maxExportedId = r.id;
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

            if (batchRows.length < 10000) {
                hasMore = false;
            }
        }

        currentCsvStream.end();
        await new Promise((res, rej) => {
            currentCsvStream.on('finish', res);
            currentCsvStream.on('error', rej);
        });

        console.log(`[s3ExportWorker] 📊 Finished writing ${rowCount.toLocaleString()} total records across ${createdCsvFiles.length} CSV part file(s).`);

        if (rowCount === 0) {
            console.log('[s3ExportWorker] ℹ️ No tick records found for export. Exiting worker.');
            createdCsvFiles.forEach(f => { if (fs.existsSync(f.filePath)) fs.unlinkSync(f.filePath); });
            process.exit(0);
        }

        // 5. Compress CSV Parts into .ZIP Archive using archiver
        console.log(`[s3ExportWorker] 📦 Compressing ${createdCsvFiles.length} CSV part(s) into ZIP archive...`);
        const zipOutputStream = fs.createWriteStream(zipFilePath);
        const archive = new ZipArchive({ zlib: { level: 9 } });

        archive.pipe(zipOutputStream);
        createdCsvFiles.forEach(f => {
            archive.file(f.filePath, { name: f.fileName });
        });
        await archive.finalize();

        await new Promise((res, rej) => {
            zipOutputStream.on('finish', res);
            zipOutputStream.on('error', rej);
        });

        // Clean up temporary CSV files after zip creation
        createdCsvFiles.forEach(f => { if (fs.existsSync(f.filePath)) fs.unlinkSync(f.filePath); });

        const zipStats = fs.statSync(zipFilePath);
        const zipMb = (zipStats.size / (1024 * 1024)).toFixed(2);
        console.log(`[s3ExportWorker] ✅ ZIP archive created successfully: ${zipFileName} (${zipMb} MB) with ${createdCsvFiles.length} Excel-compatible CSV part(s)`);


        // 6. Upload .ZIP to Amazon S3 Bucket
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

        // 7. Generate AWS S3 Pre-signed Download URL (Valid for 7 Days / 604,800 seconds)
        const getCmd = new GetObjectCommand({ Bucket: s3Bucket, Key: s3ObjectKey });
        const presignedUrl = await getSignedUrl(s3Client, getCmd, { expiresIn: 604800 });
        console.log(`[s3ExportWorker] 🔗 Generated S3 Pre-signed Download URL (Expires in 7 Days)`);

        // 8. Send Email via Brevo API Key (or SMTP) with S3 Download Button
        const brevoApiKey = process.env.BREVO_API_KEY;
        const senderEmail = process.env.SMTP_FROM_EMAIL || process.env.BREVO_SENDER_EMAIL || process.env.SMTP_USER || 'info@kiaantechnology.com';
        const senderName = process.env.SMTP_FROM_NAME || 'Kiaan Technology Pvt Ltd';

        const emailSubject = `📊 Amazon S3 Tick Data Export Report (${rowCount.toLocaleString()} records)`;
        const emailHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 10px;">
                <h2 style="color: #0f172a; text-align: center;">📊 Script Data Export Report</h2>
                <p>Hello Superadmin,</p>
                <p>Your exported market tick data containing <b>${rowCount.toLocaleString()}</b> records has been securely archived and uploaded to Amazon S3.</p>
                
                <div style="background-color: #f8fafc; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <p style="margin: 5px 0;"><b>Total Records:</b> ${rowCount.toLocaleString()}</p>
                    <p style="margin: 5px 0;"><b>Archive Format:</b> ZIP Compressed CSV (.zip)</p>
                    <p style="margin: 5px 0;"><b>Archive Size:</b> ${zipMb} MB</p>
                    <p style="margin: 5px 0;"><b>Link Validity:</b> 7 Days (Secure AWS S3 Presigned URL)</p>
                </div>

                <div style="text-align: center; margin: 30px 0;">
                    <a href="${presignedUrl}" style="background-color: #0284c7; color: #ffffff; padding: 14px 28px; font-size: 15px; font-weight: bold; text-decoration: none; border-radius: 6px; display: inline-block;">
                        📥 Download ${rowCount.toLocaleString()} Records (.zip)
                    </a>
                </div>

                <p style="font-size: 12px; color: #64748b; text-align: center;">The database has been cleaned to ensure high performance.<br/>Best regards,<br/><b>${senderName}</b></p>
            </div>
        `;

        if (brevoApiKey) {
            console.log(`[s3ExportWorker] ✉️ Sending email with S3 Download Link via Brevo API v3 to ${targetEmail}...`);
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

        // 9. Purge Database in fast 5,000-row batches with retry logic (prevents InnoDB Lock Wait Timeout)
        if (maxExportedId > 0) {
            console.log(`[s3ExportWorker] 🗑️ Purging exported records up to ID ${maxExportedId} in fast 5,000-row chunks...`);
            let currentId = 1;
            const chunkSize = 5000;
            let deletedTotal = 0;

            while (currentId <= maxExportedId) {
                const nextId = Math.min(currentId + chunkSize, maxExportedId + 1);
                let retries = 3;
                while (retries > 0) {
                    try {
                        const [delRes] = await db.execute('DELETE FROM scrip_ticks_history WHERE id >= ? AND id < ?', [currentId, nextId]);
                        deletedTotal += (delRes.affectedRows || 0);
                        break;
                    } catch (err) {
                        retries--;
                        if (retries === 0) {
                            console.error(`[s3ExportWorker] ⚠️ Skipping range ${currentId}-${nextId} due to temporary DB lock:`, err.message);
                        } else {
                            await new Promise(r => setTimeout(r, 200));
                        }
                    }
                }
                currentId = nextId;
                if (currentId % 1000000 < chunkSize || currentId > maxExportedId) {
                    console.log(`[s3ExportWorker] 🗑️ Purged ${deletedTotal.toLocaleString()} exported records so far...`);
                }
            }
            console.log(`[s3ExportWorker] ✅ Purge completed! Total deleted records: ${deletedTotal.toLocaleString()}`);
        }



        // 10. Cleanup local temporary ZIP file after upload
        if (fs.existsSync(zipFilePath)) fs.unlinkSync(zipFilePath);


        console.log('[s3ExportWorker] 🎉 AWS S3 ZIP Export Worker completed successfully!');
        process.exit(0);
    } catch (err) {
        console.error('[s3ExportWorker] ❌ Worker Error:', err.response?.data || err.message);
        process.exit(1);
    }
}

runWorker();
