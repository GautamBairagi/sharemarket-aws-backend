const express = require('express');
const router = express.Router();
const {
    smartCommand,
    masterCommand,
    mediatorCommand,
    parseOnly,
    getSchema,
    aiCommand,
    processVoiceCommand,
    aiParse,
    smartSearch,
    executeVoiceCommand,
    voiceExecute,
    chatWithAI,
    transcribeVoice,
    tutorChat,
    getTutorTopics,
} = require('../controllers/aiController');
const voiceRecCtrl = require('../controllers/voiceRecordingController');
const { authMiddleware } = require('../middleware/auth');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

// ─────────────────────────────────────────────────────────────────────────────
// NEW SMART AI ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/ai/smart-command — Main AI endpoint (parse + generate + execute)
router.post('/smart-command', authMiddleware, smartCommand);

// POST /api/ai/master-command — Advanced: Master AI brain (single OpenAI call)
router.post('/master-command', authMiddleware, masterCommand);

// POST /api/ai/mediate — Universal AI Mediator (function calling with agentic loop)
router.post('/mediate', authMiddleware, mediatorCommand);

// POST /api/ai/parse-only — Parse without executing (for preview/confirmation)
router.post('/parse-only', authMiddleware, parseOnly);

// POST /api/ai/smart-search — Smart search with AI parsing
router.post('/smart-search', authMiddleware, smartSearch);

// GET /api/ai/schema — Get database schema summary
router.get('/schema', authMiddleware, getSchema);

// Debug: return latest action ledger rows (admin only)
const { debugLatestActionLedger } = require('../controllers/systemController');
router.get('/debug/action-ledger', authMiddleware, debugLatestActionLedger);

// ─────────────────────────────────────────────────────────────────────────────
// VOICE RECORDING ENDPOINTS — Auto-save + history
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/ai/voice/save-recording — Upload + save recording to DB
router.post('/voice/save-recording', authMiddleware, ...voiceRecCtrl.saveRecording);

// GET /api/ai/voice/recordings — List recordings with filters
router.get('/voice/recordings', authMiddleware, voiceRecCtrl.getRecordings);

// GET /api/ai/voice/audio/:filename — Serve audio file
router.get('/voice/audio/:filename', authMiddleware, voiceRecCtrl.getAudio);

// DELETE /api/ai/voice/recordings/:id — Delete recording
router.delete('/voice/recordings/:id', authMiddleware, voiceRecCtrl.deleteRecording);

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY ENDPOINTS (backward compatibility — all still work)
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/ai/ai-command — Now routes through smart system with legacy fallback
router.post('/ai-command', authMiddleware, aiCommand);

router.post('/voice-command',   authMiddleware, processVoiceCommand);
router.post('/ai-parse',        authMiddleware, aiParse);
router.post('/execute-command',  authMiddleware, executeVoiceCommand);
router.post('/voice-execute',    authMiddleware, voiceExecute);

// POST /api/ai/transcribe-voice — Whisper transcription
router.post('/transcribe-voice', authMiddleware, upload.single('audio'), transcribeVoice);

// POST /api/ai/chat — AI Chat (general conversation)
router.post('/chat', authMiddleware, chatWithAI);

// ─────────────────────────────────────────────────────────────────────────────
// EDUCATIONAL AI TUTOR ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/ai/tutor — Educational tutor chat (contextual, experience-aware)
router.post('/tutor', authMiddleware, tutorChat);

// GET /api/ai/tutor/topics — Get available tutor topic categories
router.get('/tutor/topics', authMiddleware, getTutorTopics);

module.exports = router;
