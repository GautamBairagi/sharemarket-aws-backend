const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../config/db');

// ─────────────────────────────────────────────────────────────────────────────
// MULTER SETUP — Audio file storage
// ─────────────────────────────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../uploads/recordings');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const name = `recording_${Date.now()}_${Math.random().toString(36).slice(2)}.webm`;
    cb(null, name);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files allowed'));
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SAVE RECORDING — Upload + DB insert
// ─────────────────────────────────────────────────────────────────────────────

exports.saveRecording = [
  upload.single('audio'),
  async (req, res) => {
    try {
      const {
        transcript,
        parsed_command,
        action_taken,
        action_result,
        status,
        user_id,
        admin_id,
        language,
        audio_duration
      } = req.body;

      const audioFilename = req.file ? req.file.filename : null;

      const sql = `
        INSERT INTO voice_recordings
          (user_id, admin_id, audio_filename, audio_duration, transcript,
           parsed_command, action_taken, action_result, status, language)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const params = [
        user_id || null,
        admin_id || null,
        audioFilename,
        audio_duration || null,
        transcript || null,
        parsed_command ? JSON.stringify(parsed_command) : null,
        action_taken || null,
        action_result ? JSON.stringify(action_result) : null,
        status || 'saved',
        language || 'hi-IN'
      ];

      const [result] = await db.execute(sql, params);

      console.log(`[saveRecording] ✅ Saved recording ID ${result.insertId}`);
      res.json({
        success: true,
        id: result.insertId,
        message: 'Recording saved'
      });
    } catch (err) {
      console.error('[saveRecording] ❌ Error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  }
];

// ─────────────────────────────────────────────────────────────────────────────
// GET RECORDINGS — List with filters + pagination
// ─────────────────────────────────────────────────────────────────────────────

exports.getRecordings = async (req, res) => {
  try {
    const {
      user_id,
      admin_id,
      status,
      search,
      from_date,
      to_date,
      page = 1,
      limit = 20
    } = req.query;

    const currentUser = req.user || {};
    const currentRole = currentUser.role || '';
    const currentId = currentUser.id;

    let where = 'WHERE 1=1';
    const params = [];

    // ── Scope recordings to the logged-in user's own trading clients ──
    // SuperAdmin sees only recordings for clients whose parent_id = superadmin's id
    // Admin sees only recordings for clients whose parent_id = admin's id
    if (currentId && (currentRole === 'SUPERADMIN' || currentRole === 'ADMIN')) {
      where += ' AND (vr.user_id IN (SELECT id FROM users WHERE parent_id = ?) OR vr.admin_id = ?)';
      params.push(currentId, currentId);
    }

    if (user_id) {
      // Match: exact user_id stored | parsed_command.userId | parsed_command.username | transcript contains username
      // Covers all cases: ID-based commands, username-based commands (new format), and old recordings
      const [uRows] = await db.execute(
        'SELECT id, username, full_name FROM users WHERE id = ? LIMIT 1', [user_id]
      );
      if (uRows.length) {
        const uname = uRows[0].username;
        where += ` AND (
          vr.user_id = ?
          OR (vr.user_id IS NULL AND JSON_UNQUOTE(JSON_EXTRACT(vr.parsed_command, '$.userId')) = ?)
          OR (vr.user_id IS NULL AND LOWER(JSON_UNQUOTE(JSON_EXTRACT(vr.parsed_command, '$.username'))) = LOWER(?))
          OR (vr.user_id IS NULL AND LOWER(vr.transcript) LIKE LOWER(?))
        )`;
        params.push(user_id, String(user_id), uname, `%${uname}%`);
      } else {
        where += ' AND vr.user_id = ?';
        params.push(user_id);
      }
    }
    if (admin_id) {
      where += ' AND vr.admin_id = ?';
      params.push(admin_id);
    }
    if (status) {
      where += ' AND vr.status = ?';
      params.push(status);
    }
    if (from_date) {
      where += ' AND vr.created_at >= ?';
      params.push(from_date);
    }
    if (to_date) {
      where += ' AND vr.created_at <= ?';
      params.push(to_date + ' 23:59:59');
    }
    if (search) {
      where += ' AND vr.transcript LIKE ?';
      params.push(`%${search}%`);
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);

    const sql = `
      SELECT
        vr.*,
        u.username AS target_username,
        u.full_name AS target_user_name,
        u.email AS target_user_email,
        a.username AS admin_username,
        a.full_name AS admin_name
      FROM voice_recordings vr
      LEFT JOIN users u ON vr.user_id = u.id
      LEFT JOIN users a ON vr.admin_id = a.id
      ${where}
      ORDER BY vr.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const countSql = `
      SELECT COUNT(*) as total
      FROM voice_recordings vr
      ${where}
    `;

    const [rows] = await db.query(sql, [...params, parseInt(limit), offset]);
    const [countRow] = await db.query(countSql, params);

    console.log(`[getRecordings] ✅ Found ${rows.length} recordings, total: ${countRow[0].total}`);

    res.json({
      success: true,
      data: rows,
      total: countRow[0].total,
      page: parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(countRow[0].total / parseInt(limit))
    });
  } catch (err) {
    console.error('[getRecordings] ❌ Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET AUDIO — Serve audio file
// ─────────────────────────────────────────────────────────────────────────────

exports.getAudio = (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, '../uploads/recordings', filename);

    if (!fs.existsSync(filePath)) {
      console.warn(`[getAudio] ⚠️  File not found: ${filename}`);
      return res.status(404).json({ success: false, error: 'Audio file not found' });
    }

    res.setHeader('Content-Type', 'audio/webm');
    res.setHeader('Accept-Ranges', 'bytes');
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error('[getAudio] ❌ Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE RECORDING — Delete file + DB row
// ─────────────────────────────────────────────────────────────────────────────

exports.deleteRecording = async (req, res) => {
  try {
    const { id } = req.params;

    // Get filename before delete
    const [[rec]] = await db.execute(
      'SELECT audio_filename FROM voice_recordings WHERE id = ?',
      [id]
    );

    if (rec?.audio_filename) {
      const filePath = path.join(__dirname, '../uploads/recordings', rec.audio_filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[deleteRecording] Deleted file: ${rec.audio_filename}`);
      }
    }

    // Delete from DB
    await db.execute('DELETE FROM voice_recordings WHERE id = ?', [id]);

    console.log(`[deleteRecording] ✅ Deleted recording ID ${id}`);
    res.json({ success: true, message: 'Recording deleted' });
  } catch (err) {
    console.error('[deleteRecording] ❌ Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};
