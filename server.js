/* SubSlash backend — Express server.
 * Modes:
 *   - AI mode:  GEMINI_API_KEY set. POST /api/scan extracts subscriptions via Gemini.
 *   - Keyless:  no key configured. POST /api/scan returns 503 with an honest
 *               message (NEVER hardcoded/fake subscriptions). The client's
 *               "Try sample data" button covers the keyless demo.
 * Stateless: scans are not persisted (no DB). Documented in README.
 */
'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const net = require('net');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');

const APP_DIR = __dirname;
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const AI_MODE = Boolean(GEMINI_KEY);

const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:3012')
  .split(',').map((s) => s.trim()).filter(Boolean);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// --- Security middleware -------------------------------------------------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin / curl / non-browser
    if (CORS_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('CORS origin not allowed'));
  },
}));
app.use(express.json({ limit: '256kb' }));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: 'draft-7' }));

// Sensitive-file guard: never expose secrets or server internals.
// Matches basenames anywhere in the path (req.path starts with '/').
const SENSITIVE = /(\.env(\.|$)|package(-lock)?\.json|\.db$|\.sqlite3?$|(^|\/)server\.js$|\.map$)/i;
app.use((req, res, next) => {
  if (SENSITIVE.test(req.path)) return res.status(404).json({ error: 'Not found' });
  next();
});
app.use(express.static(APP_DIR, { dotfiles: 'deny', index: 'index.html' }));

// --- Cancel guides (served from JSON file, not hardcoded in client) -------
let GUIDES = {};
try {
  GUIDES = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'guides.json'), 'utf8'));
} catch (e) {
  console.error('[subslash] failed to load guides.json:', e.message);
  GUIDES = {};
}

app.get('/api/guides', (_req, res) => {
  res.json({ guides: GUIDES, simulated: false });
});

// --- Upload handling: PDF / CSV / TXT, <= 5MB ------------------------------
const MAX_BYTES = 5 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const name = (file.originalname || '').toLowerCase();
    const okExt = /\.(pdf|csv|txt)$/.test(name);
    const okMime = /^(application\/pdf|text\/(plain|csv)|application\/(vnd\.ms-excel|csv|x-csv))$/.test(file.mimetype || '');
    if (okExt || okMime) return cb(null, true);
    cb(new Error('Only PDF, CSV, or TXT files are accepted.'));
  },
});

async function extractTextFromFile(file) {
  const name = (file.originalname || '').toLowerCase();
  if (/\.pdf$/.test(name) || file.mimetype === 'application/pdf') {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(file.buffer);
    return String(data.text || '');
  }
  // CSV / TXT: direct UTF-8 decode.
  return file.buffer.toString('utf8');
}

// --- Gemini ----------------------------------------------------------------
const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite'];

const SCAN_PROMPT = (statement) => (
  'You are a financial forensic auditor. Identify recurring subscriptions and memberships '
  + 'in the bank/card statement text below.\n'
  + 'Return ONLY a JSON object (no markdown, no prose) with exactly this shape:\n'
  + '{"subscriptions": [{"name": "merchant name", "amount": 12.99, "currency": "USD", '
  + '"cycle": "monthly", "category": "Entertainment", "confidence": "High"}], '
  + '"total_monthly": 12.99}\n'
  + 'Rules: "cycle" must be one of monthly, yearly, weekly, quarterly. '
  + '"confidence" must be one of High, Medium, Low. "currency" is a 3-letter ISO code. '
  + '"total_monthly" is the sum of monthly-equivalent amounts (yearly / 12, weekly * 4.33, '
  + 'quarterly / 3). If no recurring charges are found, return {"subscriptions": [], "total_monthly": 0}.\n\n'
  + 'STATEMENT:\n' + statement
);

function sanitizeScan(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const raw = Array.isArray(obj.subscriptions) ? obj.subscriptions : null;
  if (!raw) return null;
  const cycles = new Set(['monthly', 'yearly', 'weekly', 'quarterly']);
  const confs = new Set(['High', 'Medium', 'Low']);
  const subs = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const name = String(it.name || '').trim().slice(0, 80);
    const amount = Number(it.amount);
    if (!name || !Number.isFinite(amount) || amount < 0) continue;
    subs.push({
      name,
      amount: Math.round(amount * 100) / 100,
      currency: /^[A-Za-z]{3}$/.test(String(it.currency || '')) ? String(it.currency).toUpperCase() : 'USD',
      cycle: cycles.has(String(it.cycle || '').toLowerCase()) ? String(it.cycle).toLowerCase() : 'monthly',
      category: String(it.category || 'Other').trim().slice(0, 30) || 'Other',
      confidence: confs.has(it.confidence) ? it.confidence : 'Medium',
    });
  }
  const toMonthly = (s) => s.cycle === 'yearly' ? s.amount / 12
    : s.cycle === 'quarterly' ? s.amount / 3
    : s.cycle === 'weekly' ? s.amount * 4.33 : s.amount;
  const total = Math.round(subs.reduce((sum, s) => sum + toMonthly(s), 0) * 100) / 100;
  return { subscriptions: subs, total_monthly: total };
}

function extractJsonObject(raw) {
  const s = String(raw || '').replace(/```json|```/g, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

async function callGemini(statementText) {
  const prompt = SCAN_PROMPT(statementText);
  let lastErr = null;
  let geminiJson;
  for (const model of GEMINI_MODELS) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 2000 },
        }),
      }
    );
    if (r.ok) {
      geminiJson = await r.json();
      lastErr = null;
      break;
    }
    lastErr = new Error(`Gemini ${model} HTTP ${r.status}`);
    if (r.status === 400) break; // bad request/key — retrying another model won't help
  }
  if (lastErr) throw lastErr;
  const j = geminiJson;
  const text = j && j.candidates && j.candidates[0] && j.candidates[0].content
    && j.candidates[0].content.parts && j.candidates[0].content.parts.map((p) => p.text || '').join('');
  const parsed = sanitizeScan(extractJsonObject(text));
  if (!parsed) throw new Error('Gemini returned unparseable JSON');
  return parsed;
}

// --- API -------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, mode: AI_MODE ? 'ai' : 'keyless', ai: AI_MODE, simulated: false });
});

app.post('/api/scan', upload.single('file'), async (req, res) => {
  try {
    let statementText = '';
    if (req.file) {
      try {
        statementText = await extractTextFromFile(req.file);
      } catch (e) {
        return res.status(422).json({ error: `Could not extract text from uploaded file: ${e.message}` });
      }
    } else if (req.body && typeof req.body.text === 'string') {
      statementText = req.body.text;
    } else {
      return res.status(400).json({ error: 'Provide statement text as JSON {"text": "..."} or upload a file field named "file" (PDF/CSV/TXT, max 5MB).' });
    }

    statementText = statementText.trim();
    if (!statementText) {
      return res.status(400).json({ error: 'Empty statement: no text found in the uploaded file or "text" field.' });
    }
    if (statementText.length > 60000) {
      return res.status(400).json({ error: 'Statement text exceeds 60000 characters. Upload a shorter excerpt.' });
    }
    // Cap prompt size for the LLM call.
    const capped = statementText.length > 15000
      ? statementText.slice(0, 15000) + '\n…(truncated)'
      : statementText;

    if (!AI_MODE) {
      return res.status(503).json({
        error: 'AI scanning is not configured: set GEMINI_API_KEY on the server to enable real statement analysis. No subscriptions were detected or invented — use "Try sample data" in the UI for a keyless demo.',
        keyless: true,
        ai: false,
        simulated: false,
      });
    }

    try {
      const result = await callGemini(capped);
      return res.json({ ...result, ai: true, simulated: false });
    } catch (e) {
      return res.status(502).json({ error: `AI scan failed (${(e && e.message) || e}). No subscriptions were invented — try again or use sample data.` });
    }
  } catch (e) {
    return res.status(500).json({ error: `Scan failed: ${(e && e.message) || e}` });
  }
});

// Multer / fileFilter / JSON-parse errors -> clean 4xx JSON.
app.use((err, _req, res, _next) => {
  if (err && (err instanceof multer.MulterError || /Only PDF, CSV/i.test(err.message))) {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? 'File exceeds the 5MB limit.'
      : err.message || 'File upload rejected.';
    return res.status(400).json({ error: msg });
  }
  if (err && (err.type === 'entity.parse.failed' || err.status === 400)) {
    return res.status(400).json({ error: 'Malformed JSON body. Send {"text": "..."} or multipart form data.' });
  }
  return res.status(500).json({ error: 'Internal server error.' });
});

// --- Boot: PORT or first free 30xx ----------------------------------------
function listenOn(port) {
  if (port > 3099) { console.error('No free port in 3012-3099.'); process.exit(1); }
  const server = net.createServer();
  server.once('error', () => listenOn(port + 1));
  server.once('listening', () => {
    server.close(() => {
      app.listen(port, () => {
        console.log(`[subslash] listening on http://localhost:${port}`);
        console.log(`[subslash] mode: ${AI_MODE ? 'AI (provider: gemini)' : 'KEYLESS (no GEMINI_API_KEY set — /api/scan returns 503; use sample data for demo)'}`);
        console.log(`[subslash] CORS origins: ${CORS_ORIGINS.join(', ')}`);
      });
    });
  });
  server.listen(port);
}
module.exports = app;

// Guarded so `require('./server')` (e.g. serverless) does not start a listener.
// Direct `node server.js` behavior is unchanged.
if (require.main === module) {
  listenOn(Number(process.env.PORT) || 3012);
}
