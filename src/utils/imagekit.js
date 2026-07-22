const ImageKit = require('imagekit');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════
// CHECK IF IMAGEKIT CREDENTIALS ARE PRESENT
// ═══════════════════════════════════════════════════════════════════════════

const credentialsPresent =
    process.env.IMAGEKIT_PUBLIC_KEY &&
    process.env.IMAGEKIT_PRIVATE_KEY &&
    process.env.IMAGEKIT_URL_ENDPOINT;

let imagekit = null;

if (credentialsPresent) {
    imagekit = new ImageKit({
        publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
        privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
        urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT
    });
    console.log('✅ ImageKit initialized successfully');
} else {
    console.warn('⚠️ ImageKit credentials missing in .env. Falling back to local storage.');
}

/**
 * Upload a file (to ImageKit or Local Storage fallback)
 */
const uploadFile = async (fileBuffer, fileName, folder = '/traders/documents') => {
    console.log(`\n[uploadFile] START - fileName: ${fileName}, folder: ${folder}, bufferSize: ${fileBuffer?.length || 0}`);

    // ─── OPTION 1: IMAGEKIT (if configured) ─────────────────
    if (imagekit) {
        try {
            console.log(`[ImageKit] Uploading ${fileName} to ${folder}...`);
            const response = await imagekit.upload({
                file: fileBuffer.toString('base64'),
                fileName: fileName,
                folder: folder,
                useUniqueFileName: true
            });

            console.log('[ImageKit] ✅ Upload Success:', {
                url: response.url,
                fileId: response.fileId,
                name: response.name
            });

            const result = {
                url: response.url,
                fileId: response.fileId,
                name: response.name,
                thumbnailUrl: response.thumbnailUrl
            };
            console.log('[uploadFile] RETURNING ImageKit result:', result);
            return result;
        } catch (err) {
            console.error('❌ ImageKit Upload Error:', {
                message: err.message,
                code: err.code,
                response: err.response?.data
            });
            console.log('[ImageKit] Falling back to local storage...');
        }
    } else {
        console.warn('[ImageKit] ⚠️ ImageKit NOT initialized - using local fallback');
    }

    // ─── OPTION 2: LOCAL FALLBACK (if ImageKit missing or fails) ──
    try {
        console.log('[Local Fallback] Starting local file upload...');
        const uploadDir = path.join(__dirname, '../../uploads', folder);
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }

        const uniqueName = Date.now() + '-' + fileName;
        const filePath = path.join(uploadDir, uniqueName);
        fs.writeFileSync(filePath, fileBuffer);

        const baseUrl = process.env.BASE_URL || 'http://localhost:5000';
        const publicUrl = `${baseUrl}/uploads${folder}/${uniqueName}`;

        console.log(`[Local Fallback] ✅ File saved: ${publicUrl}`);

        const result = {
            url: publicUrl,
            fileId: 'local-' + uniqueName,
            name: uniqueName,
            thumbnailUrl: publicUrl
        };
        console.log('[uploadFile] RETURNING Local result:', result);
        return result;
    } catch (err) {
        console.error('❌ Local Upload Error:', err.message);
        console.log('[uploadFile] RETURNING null due to error');
        return null;
    }
};

/**
 * Delete a file (ImageKit or Local)
 */
const deleteFile = async (fileId) => {
    if (!fileId) return;

    if (imagekit && !fileId.startsWith('local-')) {
        try {
            await imagekit.deleteFile(fileId);
        } catch (err) {
            console.error('ImageKit delete error:', err.message);
        }
    } else if (fileId.startsWith('local-')) {
        // Optional: Implement local deletion if needed
        console.log('Local file deletion not implemented, but skipped safely.');
    }
};

module.exports = { imagekit, uploadFile, deleteFile };

