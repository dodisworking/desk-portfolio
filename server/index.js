// Tiny production server for Railway.
// Serves the Vite-built SPA from /dist and exposes a small JSON store
// API so build mode (localhost) can push the canonical "frozen scene"
// to the live site without a redeploy.
//
//   GET  /api/health           → liveness check
//   GET  /api/frozen-scene     → returns the latest pushed scene JSON
//   POST /api/frozen-scene     → writes a new scene JSON (Bearer-token gated)
//   GET  /*                    → serves index.html (SPA fallback)
//
// Environment variables expected on Railway:
//   PORT                 → injected by Railway
//   PUSH_SECRET          → required Bearer token for POST /api/frozen-scene
//   DATA_DIR (optional)  → where to store frozen-scene.json (defaults to /tmp)
import express from 'express';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST = join(ROOT, 'dist');
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
const FROZEN_PATH = join(DATA_DIR, 'frozen-scene.json');

// Make sure DATA_DIR exists (Railway volumes mount empty).
try { mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// If no frozen scene yet, seed with the on-disk baseline if it exists
// (we ship a known-good `data/baselines/2026-05-11-0112am-room-complete.json`
// in the repo so the very first visitor gets a real scene).
if (!existsSync(FROZEN_PATH)) {
  const baseline = join(ROOT, 'data', 'baselines', '2026-05-11-0112am-room-complete.json');
  if (existsSync(baseline)) {
    try {
      writeFileSync(FROZEN_PATH, readFileSync(baseline));
      console.log('[server] seeded frozen-scene.json from baseline');
    } catch (err) { console.warn('[server] baseline seed failed', err); }
  }
}

const app = express();
app.use(express.json({ limit: '5mb' }));

// CORS for /api/* — needed so the build-mode "📤 Push to LIVE" button
// in main.jsx can fetch from localhost:3001 → railway.app without
// being blocked by same-origin policy. Restricted to /api/* so static
// asset serving isn't affected.
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.get('/api/health', (_req, res) => res.json({ ok: true, t: Date.now() }));

app.get('/api/frozen-scene', (_req, res) => {
  try {
    if (!existsSync(FROZEN_PATH)) return res.status(404).json({ error: 'no frozen scene yet' });
    res.type('application/json').send(readFileSync(FROZEN_PATH));
  } catch (err) {
    console.error('[server] read failed', err);
    res.status(500).json({ error: 'read failed' });
  }
});

app.post('/api/frozen-scene', (req, res) => {
  const auth = req.headers.authorization || '';
  const expected = process.env.PUSH_SECRET;
  if (!expected) return res.status(500).json({ error: 'server not configured (no PUSH_SECRET)' });
  if (auth !== `Bearer ${expected}`) return res.status(401).json({ error: 'unauthorized' });
  try {
    writeFileSync(FROZEN_PATH, JSON.stringify(req.body));
    console.log(`[server] frozen scene updated, ${JSON.stringify(req.body).length} bytes`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[server] write failed', err);
    res.status(500).json({ error: 'write failed' });
  }
});

// ───────────────────────────────────────────────────────────────────
// /api/hyperbeam-session  — create a pixel-streamed Chrome session
//
// Visitor clicks "▶ Enter the room" → frontend POSTs here → we call
// Hyperbeam with our server-side API key (env: HYPERBEAM_API_KEY) →
// Hyperbeam spins up a cloud Chrome on a GPU server and returns an
// embed URL → we forward that URL back to the visitor → frontend
// loads it in a fullscreen iframe → visitor sees a streamed Chrome
// already pointing at the portfolio scene, rendered at full quality
// regardless of the visitor's actual device.
//
// Hyperbeam billing: pay-per-session-minute (~$0.40-1.00/hr on free
// plan, 10,000 free minutes/month). Session auto-closes after idle.
// ───────────────────────────────────────────────────────────────────
app.post('/api/hyperbeam-session', async (_req, res) => {
  const key = process.env.HYPERBEAM_API_KEY;
  if (!key) return res.status(500).json({ error: 'server not configured (no HYPERBEAM_API_KEY)' });
  try {
    // The streamed Chrome opens the live portfolio URL on launch.
    const startURL = 'https://desk-portfolio-production.up.railway.app/?stream=1';
    const r = await fetch('https://engine.hyperbeam.com/v0/vm', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        start_url: startURL,
        // Auto-close session after 5 min of inactivity to keep cost down.
        timeout: { absolute: 1800, inactive: 300, offline: 60 },
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      console.error('[hyperbeam] session create failed', r.status, body);
      return res.status(502).json({ error: 'hyperbeam error', status: r.status, body });
    }
    const json = await r.json();
    res.json({ embed_url: json.embed_url, session_id: json.session_id });
  } catch (err) {
    console.error('[hyperbeam] exception', err);
    res.status(500).json({ error: 'hyperbeam fetch failed', message: String(err) });
  }
});

// Static SPA — must come AFTER /api routes so they don't get swallowed.
// index.html is served NO-CACHE so the streaming-gate script and other
// top-level changes show up immediately on visitor refresh. The hashed
// JS/CSS bundles + assets still cache for 1 hour (they're
// content-hashed so any change rotates the URL anyway).
app.use(express.static(DIST, {
  maxAge: '1h',
  etag: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

// SPA fallback — returns index.html ONLY for navigation requests
// (no file extension, accepts HTML). Asset requests (.glb / .png /
// .mp4 / .hdr / .json etc.) that miss the static dir return a real
// 404 so the client's GLTFLoader / fetch / video element fails
// gracefully instead of choking on "<!doctype …>" JSON-parsing.
app.get('*', (req, res) => {
  // If the path looks like an asset (has a non-.html extension), 404.
  const path = req.path;
  const looksLikeAsset = /\.(glb|gltf|bin|png|jpg|jpeg|webp|hdr|mp4|webm|json|wasm|js\.map)$/i.test(path);
  if (looksLikeAsset) {
    return res.status(404).type('text/plain').send('Not found: ' + path);
  }
  // Only return HTML when the client actually wants HTML.
  if (req.accepts('html')) {
    return res.sendFile(join(DIST, 'index.html'));
  }
  res.status(404).type('text/plain').send('Not found');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
  console.log(`[server] DIST=${DIST} DATA_DIR=${DATA_DIR}`);
});
