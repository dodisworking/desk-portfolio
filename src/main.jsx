// Vanilla Three.js scene: walnut desk + Mac Plus + bookshelf + window with
// Rio sunset parallax backdrop. "Use computer" mode pushes the camera
// inches from the screen and applies cinematic depth-of-field.
//
// URL flags for diagnostics:
//   ?lite  — skip the heaviest assets (foliage_study, grass, strip lights).
//            Use this to find out if a black screen is a perf issue.
const LITE = new URLSearchParams(location.search).has('lite');

// ---------- BUILD vs WEBSITE mode detection -----------------------------
// Localhost = build mode (editor UI, sliders, snapshots, recovery).
// Anywhere else (Railway production URL) = website mode (visitor-facing,
// editor UI hidden, scene comes from /api/frozen-scene).
//
// URL override:  ?mode=build  or  ?mode=website  forces a specific mode
// for testing prod URL with editor UI or vice versa.
const APP_MODE = (() => {
  const override = new URLSearchParams(location.search).get('mode');
  if (override === 'build' || override === 'website') return override;
  const host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' ||
      host.startsWith('192.168.') || host.startsWith('10.') ||
      host.endsWith('.local')) return 'build';
  return 'website';
})();
const IS_BUILD_MODE   = APP_MODE === 'build';
const IS_WEBSITE_MODE = APP_MODE === 'website';
window.__APP_MODE = APP_MODE;
console.log(`%c[mode] ${APP_MODE.toUpperCase()}`, 'color:#7fff7f;font-weight:bold;font-size:14px;', `host=${location.hostname}`);

// ═════════════════════════════════════════════════════════════════════════
//   VISITOR-SIDE EARLY ABORT
//
// If we're on the live Railway URL WITHOUT ?stream=1, the visitor is on
// their own device (Safari, iPhone, etc.) and we MUST NOT initialize the
// Three.js scene — index.html's stream-gate is showing them a "▶ ENTER
// THE ROOM" button instead, and clicking it loads a Hyperbeam iframe
// where the cloud Chrome (with ?stream=1) is what actually runs the
// scene.
//
// Without this abort, both the gate AND the heavy WebGL scene load on
// the visitor's device, which is what was OOM-ing Safari before the
// gate could intervene.
// ═════════════════════════════════════════════════════════════════════════
{
  const _isStream  = new URLSearchParams(window.location.search).has('stream');
  // Don't abort on localhost — we WANT the visitor-mode scene to run there
  // for the dual-localhost preview ("recruiter mode" at ?mode=website lets
  // us see exactly what a visitor sees without deploying to Railway).
  const _hostname = window.location.hostname;
  const _isLocal  = _hostname === 'localhost' || _hostname === '127.0.0.1' ||
                    _hostname.startsWith('192.168.') || _hostname.endsWith('.local');
  if (IS_WEBSITE_MODE && !_isStream && !_isLocal) {
    console.log('[boot] visitor mode — scene skipped, gate handles streaming');
    // Hard-stop module execution. Nothing below this point runs.
    throw new Error('[boot] aborting main.jsx in visitor mode (gate active)');
  }
}

// ---------- 32-bit boot-overlay controller ------------------------------
// The #__boot-overlay div is rendered immediately by index.html. We
// drive its progress bar + status text as assets load, then fade it
// out when the room is ready. In BUILD mode we hide it instantly
// (developer doesn't need a hand-holding load screen).
const _boot = {
  overlay: document.getElementById('__boot-overlay'),
  bar:     document.getElementById('__boot-bar'),
  status:  document.getElementById('__boot-status'),
  progress: 0,         // 0..1
  done: false,
};
function _bootStep(label, frac) {
  if (!_boot.overlay || _boot.done) return;
  if (typeof frac === 'number') {
    _boot.progress = Math.max(_boot.progress, Math.min(1, frac));
    if (_boot.bar) _boot.bar.style.width = (_boot.progress * 100).toFixed(1) + '%';
  }
  if (label && _boot.status) _boot.status.textContent = label;
}
function _bootDone() {
  if (!_boot.overlay || _boot.done) return;
  _boot.done = true;
  _bootStep('READY', 1);
  setTimeout(() => {
    _boot.overlay.classList.add('fade-out');
    setTimeout(() => { try { _boot.overlay.remove(); } catch {} }, 900);
  }, 350);
}
window.__bootStep = _bootStep;
window.__bootDone = _bootDone;
// Build mode used to call _bootDone() instantly, which removed the boot
// overlay before room.glb + bank items finished loading. The user saw
// the room "build itself" — props popped in at Blender-authored positions
// then snapped to their persisted positions. We now keep the overlay
// alive in build mode too, just fade it on the natural room-load path
// (triggered from the room.glb callback). The overlay is brief (~800ms
// from scene.add) and hides the snap entirely.
//
// Safety fallback: if for any reason the room callback never fires, kill
// the overlay after 8s so we don't leave the user staring at "WARMING UP".
if (IS_BUILD_MODE) {
  setTimeout(() => { if (!_boot.done) _bootDone(); }, 8000);
}

// ---------- WEBSITE-mode: fetch frozen scene before scene init ---------
// Production visitors need to see WHATEVER the latest pushed state is —
// not the per-browser localStorage, not the shipped baseline JSON. We
// synchronously fetch `/api/frozen-scene` BEFORE anything in main.jsx
// builds the scene, then write each field into localStorage. The rest
// of the app reads localStorage as usual — no other code needs to know
// about website mode.
if (IS_WEBSITE_MODE) {
  _bootStep('FETCHING THE ROOM', 0.05);
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/frozen-scene?v=' + Date.now(), false);
    xhr.send(null);
    if (xhr.status === 200 && xhr.responseText.length > 100) {
      const payload = JSON.parse(xhr.responseText);
      function _w(k, v) {
        if (v == null) return;
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        try { localStorage.setItem(k, s); } catch {}
      }
      _w('desk-portfolio:positions:v1', payload.positions);
      _w('pairLocks.v1',                payload.pairLocks);
      _w('bank.spawned.v2',             payload.bankSpawned);
      _w('extraFrames.v1',              payload.extraFrames);
      _w('hidden.props.v1',             payload.hidden);
      _w('shelfLights.extra.v1',        payload.shelfLightsExtra);
      _w('clonedItems.v1',              payload.clonedItems);
      console.log('%c[website] applied frozen scene from /api/frozen-scene', 'color:#7fff7f;font-weight:bold;');
      _bootStep('SCENE BLUEPRINT READY', 0.15);
    } else {
      console.warn('[website] /api/frozen-scene returned status', xhr.status, '— scene will use shipped defaults.');
    }
  } catch (err) {
    console.warn('[website] frozen-scene fetch failed', err);
  }
}

// ---------- Pinned baseline seeding (idempotent, runs every boot) -------
// Ensures the "May 11 1:12 AM complete room" baseline is always present
// in localStorage under `desk-portfolio:baselines:*`. Pulled from the
// committed file `/recovered-best.json` (also durably stored in
// `data/baselines/`). The snapshot pruner is patched elsewhere to never
// touch keys with the `baselines:` prefix. Runs on every boot so even
// if localStorage gets cleared, the baseline reappears as long as the
// JSON file is still on disk.
(function _seedBaseline() {
  const BASELINE_KEY = 'desk-portfolio:baselines:2026-05-11-0112am-room-complete';
  if (localStorage.getItem(BASELINE_KEY)) return;   // already present
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/recovered-best.json?v=' + Date.now(), false);
    xhr.send(null);
    if (xhr.status === 200 && xhr.responseText.length > 1000) {
      localStorage.setItem(BASELINE_KEY, xhr.responseText);
      console.log('%c[baseline] seeded 2026-05-11-0112am-room-complete (' + xhr.responseText.length + ' bytes)', 'color:#ffb060;font-weight:bold;');
    }
  } catch {}
})();

// ---------- One-shot localStorage RECOVERY ------------------------------
// Chrome force-shutdown wiped the user's live state on 2026-05-11; the
// pre-crash snapshots were on disk so I extracted the newest one (May 11
// 01:12:32 AM) into public/recovered-best.json. This block runs ONCE on
// the first reload after the recovery file appears, applies it to
// localStorage, then drops a flag so it never runs again. After it's
// done, you can safely delete public/recovered-best.json — the data
// lives in localStorage from then on.
(function _oneShotRecovery() {
  const APPLIED_KEY = 'desk-portfolio:recoveryApplied.v3';
  // Clear earlier flags so this retry (with shelf-lights restore) runs.
  try {
    localStorage.removeItem('desk-portfolio:recoveryApplied.v1');
    localStorage.removeItem('desk-portfolio:recoveryApplied.v2');
  } catch {}
  if (localStorage.getItem(APPLIED_KEY)) return;        // already restored

  // CRITICAL: mark the recovery as applied IMMEDIATELY (before doing any
  // of the heavy writes). Otherwise a QuotaExceededError mid-write
  // throws an uncaught exception, halting ALL of main.jsx — which means
  // no setters, no panels, no scene. The user gets a stuck black tab.
  // Setting the flag first means at worst we skip a one-time backfill;
  // the scene still boots.
  try { localStorage.setItem(APPLIED_KEY, String(Date.now())); }
  catch (e) { console.warn('[recovery] could not mark APPLIED_KEY — bailing', e); return; }

  // Synchronous XHR — must complete before the rest of main.jsx runs,
  // otherwise the scene reads pre-recovery (empty) localStorage.
  const xhr = new XMLHttpRequest();
  try {
    xhr.open('GET', '/recovered-best.json?v=' + Date.now(), false);
    xhr.send(null);
  } catch { return; }
  if (xhr.status !== 200) return;                       // no recovery file present
  let payload;
  try { payload = JSON.parse(xhr.responseText); } catch { return; }

  // Defensive setItem — if storage is full, log and continue rather than
  // throw. The recovery is "best effort" — partial recovery is still better
  // than a broken boot.
  const _safeSet = (key, val) => {
    try { localStorage.setItem(key, val); return true; }
    catch (err) {
      console.warn(`[recovery] localStorage.setItem(${key}) failed (${err.name}); skipping`);
      return false;
    }
  };

  // Save what we have NOW first, in case the recovery is somehow worse.
  // (Skipped silently if quota is exceeded.)
  const preBackup = {};
  ['desk-portfolio:positions:v1','pairLocks.v1','bank.spawned.v2','extraFrames.v1','hidden.props.v1']
    .forEach((k) => { preBackup[k] = localStorage.getItem(k); });
  _safeSet('desk-portfolio:preRecovery.v1', JSON.stringify(preBackup));

  // Apply recovered fields. `positions` is stored as an OBJECT in the
  // snapshot payload (per takeSnapshot in this file), the others are
  // already stringified — handle both shapes safely.
  function _writeMaybeStringified(key, val) {
    if (val == null) return;
    const s = typeof val === 'string' ? val : JSON.stringify(val);
    _safeSet(key, s);
  }
  _writeMaybeStringified('desk-portfolio:positions:v1', payload.positions);
  _writeMaybeStringified('pairLocks.v1',                payload.pairLocks);
  _writeMaybeStringified('bank.spawned.v2',             payload.bankSpawned);
  _writeMaybeStringified('extraFrames.v1',              payload.extraFrames);
  _writeMaybeStringified('hidden.props.v1',             payload.hidden);
  _writeMaybeStringified('shelfLights.extra.v1',        payload.shelfLightsExtra);
  _writeMaybeStringified('clonedItems.v1',              payload.clonedItems);
  // Stash a PROTECTED copy of the snapshot under a `baselines:` key —
  // the auto-pruner is patched below to skip anything matching this
  // prefix, so this baseline survives indefinitely (no 24h expiry).
  _safeSet(
    'desk-portfolio:baselines:2026-05-11-0112am-room-complete',
    JSON.stringify(payload),
  );

  console.log('%c[recovery] Restored from May 11 01:12 AM snapshot. Reloading once to apply…', 'color:#7fff7f;font-weight:bold;');
  // Hard reload so the just-written localStorage is read at scene-init time
  // (we're already inside main.jsx eval — the safest path is a fresh start).
  location.reload();
})();
import * as THREE from 'three';
// SELECTABLE list — populated by makeSelectable() throughout the file.
// Declared here at the top so early callers (e.g. the Mac screen surface)
// don't hit a TDZ ReferenceError.
const SELECTABLE = [];

// Single configured GLTFLoader shared across the app — required because the
// optimization pipeline ships Draco + Meshopt + KTX2/BasisU GLBs. KTX2
// is GPU-compressed textures: stays compressed in VRAM, ~6× smaller GPU
// memory than uncompressed RGBA. The cornerstone of fitting under
// Safari's WebGL memory ceiling.
const _dracoLoader = new DRACOLoader().setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
let _ktx2Loader = null; // lazy: needs renderer.capabilities, renderer is created below
function makeGLTFLoader() {
  const l = new GLTFLoader();
  l.setDRACOLoader(_dracoLoader);
  l.setMeshoptDecoder(MeshoptDecoder);
  // Lazy-init KTX2 the first time a GLTFLoader is requested AFTER the
  // renderer exists. Tries from the global window.__renderer pointer so
  // we don't break the strict top-to-bottom load order.
  if (!_ktx2Loader && typeof window !== 'undefined' && window.__renderer) {
    _ktx2Loader = new KTX2Loader()
      .setTranscoderPath('https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/libs/basis/')
      .detectSupport(window.__renderer);
  }
  if (_ktx2Loader) l.setKTX2Loader(_ktx2Loader);
  return l;
}
// Hoisted so async load callbacks + IIFEs that fire before the matching
// section runs don't hit Temporal Dead Zone errors. Values are set here;
// the original sections later in the file just MUTATE these instead of
// re-declaring.
const falconCrop = {
  xMin: -10.00, xMax:  10.00,
  yMin: -10.00, yMax:  10.00,
  zMin: -10.00, zMax:   3.02,
};
const falconCropPlanes = [
  new THREE.Plane(new THREE.Vector3( 1, 0, 0), -falconCrop.xMin),
  new THREE.Plane(new THREE.Vector3(-1, 0, 0),  falconCrop.xMax),
  new THREE.Plane(new THREE.Vector3( 0, 1, 0), -falconCrop.yMin),
  new THREE.Plane(new THREE.Vector3( 0,-1, 0),  falconCrop.yMax),
  new THREE.Plane(new THREE.Vector3( 0, 0, 1), -falconCrop.zMin),
  new THREE.Plane(new THREE.Vector3( 0, 0,-1),  falconCrop.zMax),
];
const flyState = {
  active: false,
  prevPos:    new THREE.Vector3(),
  prevTarget: new THREE.Vector3(),
  speed: 0.04,
  onChange: () => {},
};
import { OrbitControls }       from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls }   from 'three/examples/jsm/controls/TransformControls.js';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { GLTFLoader }        from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader }       from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader }        from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder }    from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { OBJLoader }         from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader }         from 'three/examples/jsm/loaders/MTLLoader.js';
import { RGBELoader }        from 'three/examples/jsm/loaders/RGBELoader.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { RectAreaLightHelper }      from 'three/examples/jsm/helpers/RectAreaLightHelper.js';
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  DepthOfFieldEffect,
  BloomEffect,
  VignetteEffect,
  KernelSize,
} from 'postprocessing';
import { mountUI, setActiveSceneryId, mountControls } from './ui.js';
import { SCENERY } from './scenery.js';
import { createLeafTool } from './leafTool.js';
import { enterPortfolio } from './portfolioOverlay.js';

// ---------- renderer ------------------------------------------------------
const root = document.getElementById('root');
// Renderer config diverges by mode:
//   • build mode (you, plugged in, discrete-GPU desk machine): MSAA on,
//     'high-performance' so macOS picks the dGPU and the editor stays
//     snappy.
//   • website mode (random visitor, often integrated-only laptop):
//     antialias OFF (saves a 2-4× framebuffer allocation — the single
//     biggest GPU-RAM win after texture size), powerPreference 'default'
//     so the OS doesn't force the high-power GPU (which on some Macs
//     literally OOMs the tab), and `failIfMajorPerformanceCaveat` left
//     unset so it still works on truly weak hardware.
const renderer = IS_WEBSITE_MODE
  ? new THREE.WebGLRenderer({ antialias: false, powerPreference: 'default', stencil: false, depth: true })
  : new THREE.WebGLRenderer({ antialias: true,  powerPreference: 'high-performance' });
// Cap DPR at 1.5 (was 2): quartet of pixels on retina drops by ~30% with
// minimal visible loss thanks to MSAA antialias still being on. Website
// mode starts at 0.75 (Turbo will drop further to 0.5) so the very first
// frame's framebuffer never overshoots and trips Chrome's memory monitor
// before our tier code has a chance to set it.
renderer.setPixelRatio(IS_WEBSITE_MODE ? 0.75 : Math.min(1.5, window.devicePixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.75;
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Shadow maps allocate a depth render target the moment they're enabled,
// even before any light casts. Safari on macOS hard-caps WebGL texture
// memory around ~384 MB on Intel iGPUs — disabling shadows entirely in
// website mode reclaims a 1k×1k depth RT (~4 MB) and, more importantly,
// kills the per-light shadow-pass overhead during scene loading. Build
// mode keeps full soft shadows for the editing experience.
renderer.shadowMap.enabled = !IS_WEBSITE_MODE;
// PCFSoftShadowMap is ~3-4× cheaper than VSMShadowMap. We keep soft edges
// but lose VSM's perfect light-bleed control — acceptable trade-off given
// the scene's lights are warm fixtures, not hard sun directionals.
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.useLegacyLights = false;
renderer.localClippingEnabled = true;
window.__renderer = renderer;   // expose for live perf diagnostics

// Adaptive DPR: if FPS stays below 45 for several frames, drop to 1.0;
// if it climbs above 55, restore. Cheap overhead, big visual smoothness
// gain on heavier scenes. Skipped when the user has Max Resolution ON —
// in that mode we honor full devicePixelRatio regardless of FPS so
// final-look renders stay crisp.
const MAX_RES_KEY = 'perf.maxResolution.v1';
window.__maxResolution = (() => {
  try { return localStorage.getItem(MAX_RES_KEY) === 'true'; } catch { return false; }
})();
window.__setMaxResolution = (on) => {
  window.__maxResolution = !!on;
  try { localStorage.setItem(MAX_RES_KEY, on ? 'true' : 'false'); } catch {}
  if (on) {
    // Crisp mode: full DPR, larger spotlight shadow map, VSM shadows.
    renderer.setPixelRatio(window.devicePixelRatio);
    if (window.__luxoSpot) {
      window.__luxoSpot.shadow.mapSize.set(2048, 2048);
      // Force shadow map to rebuild at the new resolution.
      if (window.__luxoSpot.shadow.map) { window.__luxoSpot.shadow.map.dispose(); window.__luxoSpot.shadow.map = null; }
    }
    renderer.shadowMap.needsUpdate = true;
    console.log('[perf] Max Resolution ON — DPR=' + window.devicePixelRatio + ', shadow=2048²');
  } else {
    // Smooth mode: adaptive DPR takes over (initial cap 1.5, drops to 1.0).
    renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio));
    if (window.__luxoSpot) {
      window.__luxoSpot.shadow.mapSize.set(1024, 1024);
      if (window.__luxoSpot.shadow.map) { window.__luxoSpot.shadow.map.dispose(); window.__luxoSpot.shadow.map = null; }
    }
    renderer.shadowMap.needsUpdate = true;
    console.log('[perf] Max Resolution OFF — adaptive DPR active, shadow=1024²');
  }
};
// Re-apply on boot so a persisted preference takes effect.
queueMicrotask(() => window.__setMaxResolution(window.__maxResolution));

// ---------- Performance Mode (3 presets) -------------------------------
// One-click "tier" picker so you can drop GPU cost while editing and
// crank it back for showcase. Each preset bundles DPR + shadow map size
// + shadow filter type into a single button. Persisted under
// `perf.tier.v1` so reload remembers your choice. Auto-detects a
// sensible default on first boot based on the user's hardware.
const PERF_TIER_KEY = 'perf.tier.v1';
// Each tier bundles: DPR + shadow map size + filter + transmission render
// scale + a "bypass post-FX" flag. Transmission is the biggest hidden cost
// — every glass case forces a full-resolution render every frame, halving
// `transmissionResolutionScale` cuts that buffer by 4×. Bypassing the
// composer (no bloom / DoF / vignette) shaves another ~5-8ms / frame.
const PERF_TIERS = {
  turbo:    { dpr: 0.5,  shadowMap: 256,  shadowType: THREE.BasicShadowMap,    transmission: 0.35, bypassFX: true,  label: '🚀 Turbo (raw speed)' },
  smooth:   { dpr: 0.75, shadowMap: 512,  shadowType: THREE.BasicShadowMap,    transmission: 0.5,  bypassFX: true,  label: '🌬 Smooth (fast, blurrier)' },
  balanced: { dpr: 1.0,  shadowMap: 1024, shadowType: THREE.PCFSoftShadowMap,  transmission: 0.75, bypassFX: false, label: '⚖ Balanced (default)' },
  crisp:    { dpr: Math.min(2, window.devicePixelRatio || 2), shadowMap: 2048, shadowType: THREE.PCFSoftShadowMap, transmission: 1.0, bypassFX: false, label: '✨ Crisp (max look)' },
};
// Bypass flag read by the render loop — when true we call renderer.render
// directly (no EffectComposer chain). Bloom + DoF + vignette together
// can take ~5-8ms on integrated GPUs.
window.__bypassPostFX = false;
function _detectDefaultPerfTier() {
  const cores = navigator.hardwareConcurrency || 4;
  const mem   = navigator.deviceMemory     || 4;
  // Beefy machine? start at balanced. Anything weaker → smooth.
  if (cores >= 8 && mem >= 8) return 'balanced';
  return 'smooth';
}
window.__perfTier = (() => {
  // Website mode (visitors / recruiters) — always force Turbo. This is the
  // single biggest lever for memory: 0.5× DPR halves every framebuffer,
  // 256² shadows + BasicShadowMap kills the shadow pass, bypassFX skips
  // the EffectComposer chain (bloom/DoF/vignette = ~3 extra full-screen
  // RTs). Without this, Chrome shows "this page was reloaded because it
  // was using significant memory" on integrated-GPU laptops.
  if (IS_WEBSITE_MODE) return 'turbo';
  // Build mode (you, editing): honor whatever the user picked last time.
  // Previously this wiped the saved tier + manual DPR on every boot and
  // forced 'crisp' — but the user wants their performance/resolution
  // slider choice to persist across reloads. If nothing is stored yet
  // we still default to Crisp so a fresh editor boot is highest-quality.
  try {
    const saved = localStorage.getItem(PERF_TIER_KEY);
    if (saved && PERF_TIERS[saved]) return saved;
  } catch {}
  if (IS_BUILD_MODE) return 'crisp';
  return _detectDefaultPerfTier();
})();
window.__setPerfTier = (tier) => {
  // Website mode: pin to turbo regardless of what was requested. Any
  // hydrated localStorage from a build-mode push would otherwise blow up
  // visitor memory.
  if (IS_WEBSITE_MODE) tier = 'turbo';
  if (!PERF_TIERS[tier]) tier = 'balanced';
  const preset = PERF_TIERS[tier];
  window.__perfTier = tier;
  try { localStorage.setItem(PERF_TIER_KEY, tier); } catch {}
  // Skip DPR change if user has a manual override (manualDPR slider).
  if (window.__manualDPR == null && !window.__maxResolution) {
    renderer.setPixelRatio(preset.dpr);
  }
  // Shadow map + filter rebuild (drop the old maps so they re-render at
  // the new resolution).
  if (window.__luxoSpot) {
    window.__luxoSpot.shadow.mapSize.set(preset.shadowMap, preset.shadowMap);
    if (window.__luxoSpot.shadow.map) {
      try { window.__luxoSpot.shadow.map.dispose(); } catch {}
      window.__luxoSpot.shadow.map = null;
    }
  }
  renderer.shadowMap.type = preset.shadowType;
  renderer.shadowMap.needsUpdate = true;
  // Three.js r163+: scale the transmission/refraction render buffer. The
  // default 1.0 means a full-res scene render every frame for every
  // transmissive material; 0.5 cuts that buffer cost by 4×, 0.35 by ~8×.
  // Visible cost: glass refraction looks slightly softer.
  if ('transmissionResolutionScale' in renderer) {
    renderer.transmissionResolutionScale = preset.transmission;
  }
  // Composer bypass — skipping bloom + DoF + vignette can save 5-8 ms
  // per frame on weak GPUs. Render loop reads `window.__bypassPostFX`.
  window.__bypassPostFX = !!preset.bypassFX;
  console.log(`[perf] tier=${tier} → DPR=${preset.dpr.toFixed(2)} shadow=${preset.shadowMap}² type=${preset.shadowType} transmission=${preset.transmission}× postFX=${preset.bypassFX ? 'OFF' : 'ON'}`);
};
window.__getPerfTier = () => window.__perfTier;
// Apply current tier once the renderer + luxoSpot are wired.
queueMicrotask(() => window.__setPerfTier(window.__perfTier));

// Manual DPR override: a slider in the Sliders menu lets the user dial
// the render resolution directly (e.g. drop to 0.5× while placing things
// for a buttery dragging feel). Setting it disables both Max Resolution
// AND the adaptive auto-drop until the user explicitly resets to "Auto".
const MANUAL_DPR_KEY = 'perf.manualDPR.v1';
window.__manualDPR = (() => {
  try {
    const v = parseFloat(localStorage.getItem(MANUAL_DPR_KEY));
    return (Number.isFinite(v) && v > 0) ? v : null;
  } catch { return null; }
})();
window.__setManualDPR = (v) => {
  if (v == null || !Number.isFinite(v) || v <= 0) {
    window.__manualDPR = null;
    try { localStorage.removeItem(MANUAL_DPR_KEY); } catch {}
    // Hand control back to Max Resolution / adaptive system.
    window.__setMaxResolution(window.__maxResolution);
    console.log('[perf] manual DPR cleared — adaptive/auto resumes');
    return;
  }
  v = Math.max(0.25, Math.min(v, window.devicePixelRatio || 2));
  window.__manualDPR = v;
  try { localStorage.setItem(MANUAL_DPR_KEY, String(v)); } catch {}
  renderer.setPixelRatio(v);
  console.log(`[perf] manual DPR set to ${v.toFixed(2)}`);
};
// Apply persisted manual DPR on boot AFTER the max-res setter ran.
queueMicrotask(() => {
  if (window.__manualDPR != null) renderer.setPixelRatio(window.__manualDPR);
});

(function adaptiveDPR() {
  let last = performance.now();
  let acc = 0, frames = 0;
  let lowStreak = 0, highStreak = 0;
  const HIGH = Math.min(1.5, window.devicePixelRatio);
  const LOW  = 1.0;
  function tick() {
    const now = performance.now();
    const dt = now - last; last = now;
    acc += dt; frames++;
    if (acc >= 500) {                       // sample every 500ms
      const fps = (frames * 1000) / acc;
      acc = 0; frames = 0;
      // Honor user overrides — never auto-drop when Max Resolution is on
      // OR a manual DPR has been dialed in via the slider.
      if (window.__maxResolution || window.__manualDPR != null) { lowStreak = 0; highStreak = 0; }
      else {
        if (fps < 45) { lowStreak++; highStreak = 0; }
        else if (fps > 55) { highStreak++; lowStreak = 0; }
        const currentDPR = renderer.getPixelRatio();
        if (lowStreak >= 3 && currentDPR > LOW) {
          renderer.setPixelRatio(LOW);
          console.log(`[perf] FPS=${fps.toFixed(0)} → drop DPR to ${LOW}`);
        } else if (highStreak >= 6 && currentDPR < HIGH) {
          renderer.setPixelRatio(HIGH);
          console.log(`[perf] FPS=${fps.toFixed(0)} → restore DPR to ${HIGH}`);
        }
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
RectAreaLightUniformsLib.init();

// Clipping planes that cap the left-wall slide so wall geometry never extends
// past the window (back) or front-wall planes when the bookshelf is shifted.
// Points kept: those where (point · normal) + constant >= 0.
//   keep z <= +2.5  →  normal=(0,0,-1), constant=+2.5
//   keep z >= -2.5  →  normal=(0,0, 1), constant=+2.5
const LEFT_WALL_CLIP_PLANES = [
  new THREE.Plane(new THREE.Vector3(0, 0, -1), 2.5),
  new THREE.Plane(new THREE.Vector3(0, 0,  1), 2.5),
];
renderer.domElement.style.display = 'block';
root.appendChild(renderer.domElement);

// ---------- scene + camera ------------------------------------------------
const scene = new THREE.Scene();

// Three camera positions:
//   HERO     = wide chair-eye-height, cinematic
//   SIT      = a touch closer to the desk
//   COMPUTER = right in front of the Mac Plus screen, with strong DOF behind
const HERO_POS    = new THREE.Vector3( 0.0, 1.40, -1.0);
const HERO_TARGET = new THREE.Vector3( 0.0, 1.05,  1.85);
const SIT_POS     = new THREE.Vector3( 0,   1.40, -0.1);
const SIT_TARGET  = new THREE.Vector3( 0,   1.00,  1.6);
// Mac Plus (after 1.3x enlarge): X=-0.27..0.27, Y=0.75..1.16, Z=1.70..2.20
// Screen face center: X=0, Y≈1.00 (upper bias — screen is in top half of case), Z=1.70.
// Camera sits 45cm in front of the screen, dead-centered.
const SCREEN_CENTER = new THREE.Vector3(0.0, 1.00, 1.70);
const COMPUTER_POS    = new THREE.Vector3(SCREEN_CENTER.x, SCREEN_CENTER.y, SCREEN_CENTER.z - 0.45);
const COMPUTER_TARGET = SCREEN_CENTER.clone();

const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.copy(HERO_POS);

// ---------- controls ------------------------------------------------------
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(HERO_TARGET);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.3;
controls.maxDistance = 8;
controls.update();
window.__controls = controls;

// ---------- post-processing: smooth DepthOfFieldEffect from `postprocessing`
// (much smoother / cinema-grade compared to three.js's built-in BokehPass)
//
// 🛡 WEBSITE MODE: skip the entire EffectComposer pipeline. Even bypassed
// (window.__bypassPostFX = true → renderer.render()), the composer still
// pre-allocates a full-screen RenderPass framebuffer + DoF near/far/CoC
// targets + Bloom's 6-level mip pyramid + vignette RT. That stack is
// ~80-150 MB of GPU memory we never touch in turbo tier. Safari on Intel
// iGPUs hits its WebGL ceiling at ~384 MB, so we have to never allocate.
let composer = null;
let dof = null;
const focusTarget = new THREE.Vector3(0, 0.93, 1.76);  // Mac Plus screen
window.__camera = camera;
if (!IS_WEBSITE_MODE) {
  composer = new EffectComposer(renderer);
  composer.setSize(window.innerWidth, window.innerHeight);
  composer.addPass(new RenderPass(scene, camera));

  dof = new DepthOfFieldEffect(camera, {
    focusDistance: 0.0,
    focalLength: 0.06,
    bokehScale: 0.0,
    focusRange: 0.012,       // ~2.4m world — Mac Plus fully covered, fall-off after that
    height: 480,
  });
  // Auto-focus by world-space target — far more reliable than fiddling with focusDistance.
  // We rebind this Vector3 when the user picks a mode.
  dof.target = focusTarget;
  window.__dof = dof;

  const bloom = new BloomEffect({
    intensity: 0.55,
    luminanceThreshold: 0.6,
    luminanceSmoothing: 0.35,
    kernelSize: KernelSize.LARGE,
  });

  const vignette = new VignetteEffect({ offset: 0.30, darkness: 0.65 });

  composer.addPass(new EffectPass(camera, dof, bloom, vignette));
} else {
  // Stand-in stub so the rest of the codebase's `dof.bokehScale = ...`
  // assignments don't NPE. The render loop never reads it when composer
  // is null (we route straight to renderer.render).
  dof = { bokehScale: 0, target: focusTarget };
  window.__bypassPostFX = true;
}

// Mode-driven target for DOF blur amount; eased over time in the render loop.
let dofBokehTarget = 0.0;
// World-space focus point per mode (kept in sync with the larger Mac Plus)
const FOCUS_SCREEN = new THREE.Vector3(0, 1.00, 1.70);   // Mac Plus screen
const FOCUS_DESK   = new THREE.Vector3(0, 0.74, 1.85);   // desk surface
const FOCUS_HERO   = new THREE.Vector3(0, 1.05, 1.85);   // wide framing

// "Use computer" mode background-blur config. The Mac Plus screen stays
// crisp (it's at focusTarget); everything farther than the in-focus band
// gets progressively bokeh-blurred.
//
// Defaults (May 13 2026, after first user feedback that the Mac itself
// was blurring): focusRange is WIDE so the entire Mac Plus body stays
// sharp, and bokehScale is mild so only the Luca backdrop + far walls
// dial up the dreamy bokeh. User can crank it from the top-of-screen
// builder panel.
// LOCKED-IN values (user-confirmed May 13, 2026). Slider panel below is
// disabled — these defaults are the final look.
const computerBlur = {
  bokehScale:  6.0,    // dreamy cinematic backdrop bokeh
  focusRange:  5.7,    // wide sharp band: whole desk cluster crisp
};
// Bump the reset flag whenever we re-lock defaults so any stale
// localStorage values get wiped on next boot.
const _BLUR_RESET_FLAG = 'desk-portfolio:computer-blur:v2026-05-13-locked';
try {
  const _hasFlag = !!localStorage.getItem(_BLUR_RESET_FLAG);
  if (_hasFlag) {
    const _v = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    if (typeof _v['computer.blur.bokehScale'] === 'number') computerBlur.bokehScale = _v['computer.blur.bokehScale'];
    if (typeof _v['computer.blur.focusRange'] === 'number') computerBlur.focusRange = _v['computer.blur.focusRange'];
  } else {
    // First boot after defaults changed — wipe any stale stored values
    const _stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    delete _stored['computer.blur.bokehScale'];
    delete _stored['computer.blur.focusRange'];
    localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(_stored));
    localStorage.setItem(_BLUR_RESET_FLAG, '1');
  }
} catch {}
// Pull the DoF focus point INTO the middle of the Mac Plus body (camera
// sits at z=1.25, screen face is around z=1.70 — focusing on z=1.55 puts
// the focal slab right through the Mac's chassis so the whole computer
// stays sharp at any reasonable focusRange).
FOCUS_SCREEN.set(0, 1.00, 1.55);
// Push focusRange to the DoF effect immediately. NOTE: `focusRange` lives
// on the inner `cocMaterial`, NOT directly on the effect — setting
// dof.focusRange would silently no-op. (Same gotcha as dof.focalLength.)
if (dof && dof.cocMaterial) dof.cocMaterial.focusRange = computerBlur.focusRange;
window.__computerBlur = computerBlur;

// ---------- lights — ONLY the lamp + outside window ----------------------
// Two physically-motivated sources, nothing else. No ambient, no hemisphere,
// no rim — those were lifting the under-desk area and making the whole room
// look uniformly lit. We rely on the HDRI for tiny specular detail only.

// === SOURCE 1: Warm Luxo lamp =========================================
// Real lamp mechanics: the metal shade blocks light from escaping behind, so
// we use ONLY a SpotLight (forward cone) — no PointLight radiating 360°. A
// very tiny in-shade glow point is kept just for the bulb interior, with a
// distance that never reaches outside the shade.
//
// Bulb position is the world-space center of LuxoImport_Object_7 probed
// from Blender after cumulative 1.85x scale: Blender (0.51, -1.85, 1.17) →
// Three.js (0.51, 1.17, 1.85).
const BULB_POS = new THREE.Vector3(0.51, 1.17, 1.85);
const luxoBulb = new THREE.PointLight(0xffb070, 0.35, 0.06, 2.0);
luxoBulb.position.copy(BULB_POS);

// Visible glowing bulb so the source actually reads as a light. Bloom
// picks up the bright emissive and gives it a soft warm halo.
const bulbMesh = new THREE.Mesh(
  new THREE.SphereGeometry(0.022, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0xffd9a8, toneMapped: false })
);
bulbMesh.position.copy(BULB_POS);
scene.add(bulbMesh);
window.__luxoBulbMesh = bulbMesh;
// Bulb shadow disabled — the spot light below already casts the lamp's
// dominant shadow over the desk; the bulb's 0.06m-range point shadow
// added a 1024² shadow pass (6 cubemap faces = 6× 1024² writes per
// frame) for almost no visual gain.
luxoBulb.castShadow = false;
scene.add(luxoBulb);
window.__luxoBulb = luxoBulb;

// Spot adds the directional desk pool + soft shadow penumbra under the Mac.
const luxoSpot = new THREE.SpotLight(0xffc090, 4.0, 2.6, Math.PI * 0.42, 0.85, 1.5);
luxoSpot.position.copy(BULB_POS);
// Aim toward Mac Plus on desk surface — angled inboard from the larger
// lamp head so the pool lands in front of the lamp's mouth.
luxoSpot.target.position.set(-0.05, 0.74, 1.90);
luxoSpot.castShadow = true;
// 1024² instead of 2048² — 4× cheaper to render the shadow pass per
// frame, with PCFSoft filtering the visual difference is small at this
// camera distance.
luxoSpot.shadow.mapSize.set(1024, 1024);
luxoSpot.shadow.radius = 14;
luxoSpot.shadow.blurSamples = 16;
luxoSpot.shadow.bias = -0.0002;
luxoSpot.shadow.camera.near = 0.05;
luxoSpot.shadow.camera.far  = 4.0;
scene.add(luxoSpot);
scene.add(luxoSpot.target);
window.__luxoSpot = luxoSpot;   // expose so Max Resolution toggle can resize shadow map

// === SOURCE 2: Outside (sunset through the window) ====================
// ONE light only — a big, dim RectAreaLight that mimics the window pane.
// No directional/spot — those were creating harsh hotspots on the desk.
// Pulled back further so the falloff onto the desk is smooth and the
// specular highlight reads as a soft streak rather than a sharp glint.
const windowLight = new THREE.RectAreaLight(0xff8a4a, 0.85, 4.0, 2.6);
windowLight.position.set(3.4, 1.7, 4.8);
windowLight.lookAt(0, 1.0, 1.0);
scene.add(windowLight);
window.__windowLight = windowLight;

// ---------- HDRI environment (drives indirect light) --------------------
const pmremGenerator = new THREE.PMREMGenerator(renderer);
pmremGenerator.compileEquirectangularShader();

let envTexture = null;
function loadHDRI(url) {
  new RGBELoader().load(url, (hdr) => {
    if (envTexture) envTexture.dispose();
    envTexture = pmremGenerator.fromEquirectangular(hdr).texture;
    scene.environment = envTexture;
    // We DO NOT set scene.background = envTexture here because we want the
    // Rio sunset image plane to be the visible sky through the window.
    hdr.dispose();
  });
}

// ---------- Rio sunset PARALLAX BACKDROP ---------------------------------
// A big plane positioned behind the window. Because it's at finite distance,
// the perspective shift is real — move the camera and the view through the
// window changes, just like a real window.
// Build the backdrop plane immediately with a default 16:9 aspect — the
// material starts with no texture, the chosen scenery's `swapBackdrop()` fills
// it in. This eliminates the rio.jpg → video race that was leaving Rio on top.
let rioPlane = null;
let rioPlaneAspect = 16 / 9;
const _rioReadyQueue = [];
function _flushRioReady() {
  while (_rioReadyQueue.length) _rioReadyQueue.shift()();
}
function whenRioReady(fn) {
  if (rioPlane) fn(); else _rioReadyQueue.push(fn);
}

(function buildBackdropPlane() {
  // LOCKED user values: x=2.400 y=3.050 z=21.450 w=26.000
  const initialW = 26, initialZ = 21.450, initialY = 3.050, initialX = 2.400;
  const geo = new THREE.PlaneGeometry(initialW, initialW / rioPlaneAspect);
  const mat = new THREE.MeshBasicMaterial({
    map: null,
    color: 0x000000,
    toneMapped: false,
    fog: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  rioPlane = new THREE.Mesh(geo, mat);
  rioPlane.position.set(initialX, initialY, initialZ);
  scene.add(rioPlane);
  // Click-to-edit: register the backdrop plane so clicking it (Rio image
  // OR Luca video) opens the contextual editor with the Backdrop sliders.
  // makeSelectable is defined later in the file but hoisted onto SELECTABLE
  // by name — wait until next tick so the function exists.
  queueMicrotask(() => {
    if (typeof makeSelectable === 'function') makeSelectable(rioPlane, 'Backdrop');
  });
  window.__rio = rioPlane;
  scene.background = new THREE.Color('#0a0508');
  if (window.__updateRioSliders) window.__updateRioSliders({ x: initialX, z: initialZ, y: initialY, w: initialW });
  console.log('[scene] backdrop plane ready (no texture yet)');
  _flushRioReady();
})();

// Helper exposed to the UI panel — rebuilds the geometry on width change
// (cheap because it's just one quad).
window.__setRioPlane = ({ x, z, y, w }) => {
  if (!rioPlane) return;
  if (typeof x === 'number') rioPlane.position.x = x;
  if (typeof z === 'number') rioPlane.position.z = z;
  if (typeof y === 'number') rioPlane.position.y = y;
  if (typeof w === 'number') {
    rioPlane.geometry.dispose();
    rioPlane.geometry = new THREE.PlaneGeometry(w, w / rioPlaneAspect);
  }
};

// ---------- load room GLB ------------------------------------------------
// Both modes load `room.glb`. Website mode will additionally try to
// apply a baked lightmap on top if room-lightmap.png + UV1 are present
// (graceful no-op if not — the cubemap backdrop fallback already
// handles those visuals).
let roomRoot = null;
makeGLTFLoader().load(
  `/models/room.glb?v=${Date.now()}`,
  (gltf) => {
    roomRoot = gltf.scene;
    window.__roomRoot = roomRoot;
    roomRoot.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      const mat = o.material;
      if (!mat) return;
      mat.side = THREE.DoubleSide;
      const name = (mat.name || '').toLowerCase();
      if (name.includes('walnut') || name.includes('desk')) {
        mat.envMapIntensity = 0.25;
        // Knock down specular so the window doesn't streak across the wood
        if (typeof mat.roughness === 'number') {
          mat.roughness = Math.min(1.0, mat.roughness + 0.25);
        }
      } else if (name.includes('wall') || name.includes('ceiling') || name.includes('floor')) {
        mat.envMapIntensity = 0.15;
      } else if (name.includes('trim') || name.includes('frame')) {
        mat.envMapIntensity = 0.4;
        mat.metalness = 0.1;
        mat.roughness = 0.25;
      } else {
        mat.envMapIntensity = 0.35;
      }
      // VSM shadow maps need shadowSide set to avoid acne on thin geo
      if (mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial) {
        mat.shadowSide = THREE.FrontSide;
      }
      // The window glass should be transparent so we see the Rio plane through it
      if (name.includes('glass')) {
        mat.transparent = true;
        mat.opacity = 0.05;
        mat.metalness = 0.0;
        mat.roughness = 0.0;
      }
    });

    // ════════════════════════════════════════════════════════════════════
    // Option B — "fake bake" — website mode only
    //
    // The room is the biggest single contributor to per-pixel fragment
    // shader cost: ~50+ materials × 13+ dynamic lights × every screen
    // pixel × full PBR (BRDF eval + env-map irradiance sample). On Safari
    // / iGPU laptops this alone is enough to trip the WebGL ceiling.
    //
    // Trick: swap the room's MeshStandardMaterial → MeshLambertMaterial.
    // Lambert is vertex-lit + much cheaper per-pixel (no PBR BRDF, no
    // irradiance sample, just a single env-map reflection lookup). The
    // room still responds to the existing lights (Luxo + window + shelf
    // strips), keeping the warm/cool variation that makes it feel "lit",
    // but at ~5-10× the fragment-shader speed. Items keep their full
    // PBR so they still look 3D.
    //
    // This is the "no-Blender" shortcut to validate that Option B
    // unlocks Safari. If quality isn't enough, the next pass is the
    // real Cycles bake → MeshBasicMaterial × lightmap texture, which
    // drops per-pixel cost even further (literally a single texture
    // sample, no lighting math at all).
    // ════════════════════════════════════════════════════════════════════
    if (IS_WEBSITE_MODE) {
      let swappedCount = 0;
      roomRoot.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const out = mats.map((mat) => {
          if (!mat || !mat.isMeshStandardMaterial) return mat;
          // Skip glass — it's transmissive, Lambert can't represent it.
          const nameLc = (mat.name || '').toLowerCase();
          if (nameLc.includes('glass')) return mat;
          // Skip emissive surfaces (Mac screen etc.) — Lambert's emissive
          // handling is fine, but we don't want to break those callers.
          if (mat.emissiveIntensity > 0 && mat.emissiveMap) return mat;
          const l = new THREE.MeshLambertMaterial({
            map:               mat.map || null,
            color:             mat.color ? mat.color.clone() : new THREE.Color(0xffffff),
            emissive:          mat.emissive ? mat.emissive.clone() : new THREE.Color(0x000000),
            emissiveIntensity: mat.emissiveIntensity || 0,
            emissiveMap:       mat.emissiveMap || null,
            // Single env-map sample (reflection only) — much cheaper than
            // Standard's irradiance + reflection. envMapIntensity scales
            // the reflection so we can keep the room from looking too shiny.
            envMap:             scene.environment || null,
            reflectivity:       Math.min(0.3, (mat.envMapIntensity ?? 0.25) * 0.6),
            combine:            THREE.MultiplyOperation,
            transparent:        mat.transparent,
            opacity:            mat.opacity,
            alphaTest:          mat.alphaTest,
            side:               mat.side,
            // Keep tone-mapping so the room blends with the rest of the scene.
            toneMapped:         true,
          });
          l.name = (mat.name || 'mat') + '_bake';
          // Dispose the original so we don't double-track GPU memory.
          try { mat.dispose(); } catch {}
          swappedCount += 1;
          return l;
        });
        o.material = out.length === 1 ? out[0] : out;
      });
      console.log(`[fake-bake] website mode: swapped ${swappedCount} room materials Standard → Lambert`);
    }

    scene.add(roomRoot);
    console.log('[scene] room.glb loaded — meshes:', roomRoot.children.length);

    // ════════════════════════════════════════════════════════════════════
    //   Option B — Per-mode 360° cube backdrops (website mode)
    //
    // Loads four cube atlases (hero / sit / computer / shelf / rightShelf),
    // splits each into 6 cube faces, swaps scene.background on every
    // setMode() call. The Lambert "fake bake" above keeps the room
    // geometry rendering cheap so camera motion still shows specular /
    // shadow play on the visible walls. The cubemap handles everything
    // behind the visible walls + far framing.
    //
    // Optionally upgrades to MeshBasicMaterial × lightMap if
    // room-lightmap.png + UV1 channel are present (currently neither —
    // gracefully falls back to Lambert + cubemap which is what's live).
    // ════════════════════════════════════════════════════════════════════
    if (IS_WEBSITE_MODE) {
      const MODE_ATLASES = {
        hero:       '/baked/cube-atlas-hero-1024.png',
        sit:        '/baked/cube-atlas-sit-1024.png',
        computer:   '/baked/cube-atlas-computer-1024.png',
        shelf:      '/baked/cube-atlas-shelf-1024.png',
        rightShelf: '/baked/cube-atlas-rightShelf-1024.png',
      };
      const FALLBACK_LEGACY = '/baked/cube-atlas-1024.png';
      const cubeBackdrops = {};

      function atlasURLToCube(url) {
        return new Promise((resolve) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            const FACE = img.height / 2;
            const ATLAS = [
              { col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 },
              { col: 0, row: 1 }, { col: 1, row: 1 }, { col: 2, row: 1 },
            ];
            const faces = ATLAS.map((f) => {
              const c = document.createElement('canvas');
              c.width = c.height = FACE;
              c.getContext('2d').drawImage(
                img, f.col * FACE, f.row * FACE, FACE, FACE, 0, 0, FACE, FACE
              );
              return c;
            });
            const cubeTex = new THREE.CubeTexture(faces);
            cubeTex.colorSpace = THREE.SRGBColorSpace;
            cubeTex.needsUpdate = true;
            resolve(cubeTex);
          };
          img.onerror = () => resolve(null);
          img.src = url;
        });
      }

      (async () => {
        const entries = await Promise.all(
          Object.entries(MODE_ATLASES).map(async ([mode, url]) => [mode, await atlasURLToCube(url)])
        );
        for (const [m, t] of entries) cubeBackdrops[m] = t;
        const have = entries.filter(([, t]) => t).map(([m]) => m);
        console.log(`[backdrop] loaded per-mode atlases:`, have.join(', ') || '(none)');

        // Pick initial atlas
        const initialMode = (typeof _currentMode !== 'undefined') ? _currentMode : 'hero';
        let initialTex = cubeBackdrops[initialMode] || cubeBackdrops['sit'] || cubeBackdrops['hero'];
        if (!initialTex) {
          // No per-mode found — try legacy single atlas
          initialTex = await atlasURLToCube(FALLBACK_LEGACY);
          if (initialTex) cubeBackdrops['__legacy'] = initialTex;
        }
        if (initialTex) {
          scene.background  = initialTex;
          scene.environment = initialTex;
        }
        // Mode-change handler
        if (Array.isArray(_modeChangeHandlers)) {
          _modeChangeHandlers.push((newMode) => {
            const tex = cubeBackdrops[newMode] || cubeBackdrops['sit'] || cubeBackdrops['hero'] || cubeBackdrops['__legacy'];
            if (tex && scene.background !== tex) {
              scene.background  = tex;
              scene.environment = tex;
              console.log(`[backdrop] mode → ${newMode}`);
            }
          });
        }
      })();
    }
    if (window.__leafToolSetPickables) window.__leafToolSetPickables(roomRoot);
    window.__bootStep?.('FURNISHING THE ROOM', 0.85);
    // The room is the biggest single asset. Once it's in the scene, the
    // visitor-facing experience is "good enough" — items + textures
    // continue streaming in but the world is built. Reveal the scene
    // after a short settle delay so a couple frames render first.
    setTimeout(() => window.__bootDone?.(), 800);

    // ---- Extract the cherry-blossom leaves into a selectable group --
    // Verified by inspecting room.glb: the pink leaves are mesh
    // `Object_0.013` whose material is `Leaf_Pink_A.008`, parented
    // directly under the room root (the GLB node is unnamed). We wrap
    // that mesh in a fresh group whose pivot sits at the leaves'
    // geometric centroid so the rotation gizmo feels natural, then
    // register it as a SELECTABLE. From now on: click the leaves in
    // the 3D scene → standard contextual editor opens → drag the
    // gizmo to move/rotate/scale them however you want. Transform
    // persists under `item.Bonsai_leaves.*` like every other item.
    (function _extractBonsaiLeaves() {
      let leafMesh = null;
      roomRoot.traverse((o) => {
        if (leafMesh || !o.isMesh) return;
        const mat = Array.isArray(o.material) ? o.material[0] : o.material;
        const matName = (mat?.name || '').toString();
        if (/leaf/i.test(matName)) leafMesh = o;
      });
      if (!leafMesh) {
        console.warn('[bonsai-leaves] no mesh with /leaf/i material found in room.glb — extraction skipped');
        return;
      }
      roomRoot.updateMatrixWorld(true);
      // Geometric centroid of the leaf mesh in world space — used as the
      // group's pivot so the gizmo rotation/scale axes feel natural.
      const box = new THREE.Box3().setFromObject(leafMesh);
      const cx = (box.min.x + box.max.x) / 2;
      const cy = (box.min.y + box.max.y) / 2;
      const cz = (box.min.z + box.max.z) / 2;
      const grp = new THREE.Group();
      grp.name = '__prop_bonsaiLeaves';
      grp.position.set(cx, cy, cz);
      scene.add(grp);
      // attach() reparents while preserving the leaf's world transform,
      // so the mesh stays exactly where it visually appears.
      grp.attach(leafMesh);
      // Persisted transform (if the user has moved them in a prior session).
      try {
        const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
        const k = 'item.Bonsai_leaves';
        if (typeof stored[`${k}.x`]    === 'number') grp.position.x = stored[`${k}.x`];
        if (typeof stored[`${k}.y`]    === 'number') grp.position.y = stored[`${k}.y`];
        if (typeof stored[`${k}.z`]    === 'number') grp.position.z = stored[`${k}.z`];
        if (typeof stored[`${k}.rotX`] === 'number') grp.rotation.x = stored[`${k}.rotX`];
        if (typeof stored[`${k}.rotY`] === 'number') grp.rotation.y = stored[`${k}.rotY`];
        if (typeof stored[`${k}.rotZ`] === 'number') grp.rotation.z = stored[`${k}.rotZ`];
        if (typeof stored[`${k}.scale`] === 'number' && stored[`${k}.scale`] > 0.01) {
          grp.scale.setScalar(stored[`${k}.scale`]);
        }
        const hidden = JSON.parse(localStorage.getItem('hidden.props.v1') || '[]');
        if (Array.isArray(hidden) && hidden.includes('Bonsai leaves')) grp.visible = false;
      } catch {}
      window.__bonsaiLeavesGroup = grp;
      window.__bonsaiLeavesMesh = leafMesh;
      // Stash the ORIGINAL centroid so a "reset position" can snap back
      // without having to re-extract from room.glb.
      grp.userData.__originalCentroid = { x: cx, y: cy, z: cz };
      makeSelectable(grp, 'Bonsai leaves');

      // ---- Cleanup of leftover red-line debris from older leaf code --
      // Earlier iterations created `__prop_bonsaiLeaf_*` per-leaf groups
      // + `__bonsaiLeafHalo` invisible click-halos. Some are showing up
      // as red lines/squares in the scene. Remove them all.
      const toNuke = [];
      scene.traverse((o) => {
        if (!o.name) return;
        if (o.name.startsWith('__prop_bonsaiLeaf_') ||
            o.name === '__bonsaiLeafHalo' ||
            o.name === '__leavesContainer') {
          toNuke.push(o);
        }
      });
      toNuke.forEach((o) => {
        try { o.parent?.remove(o); } catch {}
        try {
          o.traverse((c) => {
            if (c.geometry) c.geometry.dispose();
            if (c.material) {
              const mats = Array.isArray(c.material) ? c.material : [c.material];
              mats.forEach((m) => { try { m.dispose(); } catch {} });
            }
          });
        } catch {}
      });
      if (toNuke.length) console.log(`[bonsai-leaves] nuked ${toNuke.length} leftover helper(s) from previous code`);

      // ---- Red MARKER BOX (drag onto whatever you want as "leaves") --
      // User drags this translucent red box on top of the actual leaf
      // mesh they see in the scene. Click "Lock leaves to marker" in
      // the bonsai editor and every mesh whose world centroid is
      // inside the marker volume gets attached to a container group —
      // moving the container then moves those meshes.
      const markerGeo = new THREE.BoxGeometry(0.30, 0.30, 0.30);
      const markerMat = new THREE.MeshBasicMaterial({
        color: 0xff3344, transparent: true, opacity: 0.22,
        depthWrite: false, side: THREE.DoubleSide,
      });
      const markerBox = new THREE.Mesh(markerGeo, markerMat);
      markerBox.renderOrder = 998;
      const markerGroup = new THREE.Group();
      markerGroup.name = '__prop_leavesMarker';
      // Default: place near the bonsai leaf centroid so the user can
      // see it immediately. They can drag to refine.
      markerGroup.position.set(cx, cy + 0.15, cz);
      markerGroup.add(markerBox);
      scene.add(markerGroup);
      // Apply persisted transform if any.
      try {
        const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
        const kk = 'item.Leaves_marker';
        if (typeof stored[`${kk}.x`]    === 'number') markerGroup.position.x = stored[`${kk}.x`];
        if (typeof stored[`${kk}.y`]    === 'number') markerGroup.position.y = stored[`${kk}.y`];
        if (typeof stored[`${kk}.z`]    === 'number') markerGroup.position.z = stored[`${kk}.z`];
        if (typeof stored[`${kk}.scale`] === 'number' && stored[`${kk}.scale`] > 0.01) markerGroup.scale.setScalar(stored[`${kk}.scale`]);
        const hidden = JSON.parse(localStorage.getItem('hidden.props.v1') || '[]');
        if (Array.isArray(hidden) && hidden.includes('Leaves marker')) markerGroup.visible = false;
      } catch {}
      window.__leavesMarkerGroup = markerGroup;
      makeSelectable(markerGroup, 'Leaves marker');
      console.log('[leaves-marker] red translucent marker added at (' + cx.toFixed(2) + ', ' + (cy+0.15).toFixed(2) + ', ' + cz.toFixed(2) + '). Click it in the scene + drag to position over the leaves you want to control.');
      console.log(`[bonsai-leaves] extracted leaf mesh "${leafMesh.name}" (material "${(Array.isArray(leafMesh.material) ? leafMesh.material[0] : leafMesh.material)?.name}") → centroid (${cx.toFixed(3)}, ${cy.toFixed(3)}, ${cz.toFixed(3)}). Click the pink leaves in the scene to move them.`);

      // Programmatic selection — attaches the gizmo to the leaves group
      // and frames the camera on them. Verbose logging so we can see
      // what's failing if a click does nothing.
      window.__selectBonsaiLeaves = function () {
        console.log('[bonsai-leaves] __selectBonsaiLeaves called');
        const g = window.__bonsaiLeavesGroup;
        if (!g) { console.warn('  → group missing (room.glb not done loading?)'); return; }
        console.log('  → group:', g.name, 'pos=', g.position.toArray().map(v=>v.toFixed(3)));
        // Find the SELECTABLE entry. The SELECTABLE list is at module
        // scope; it's populated synchronously when makeSelectable runs.
        let sel = null;
        try { sel = SELECTABLE.find((s) => s.group === g); } catch (err) {
          console.warn('  → SELECTABLE lookup threw:', err);
        }
        if (!sel) { console.warn('  → not in SELECTABLE registry'); return; }
        console.log('  → found SELECTABLE entry, label:', sel.label);
        // Attach gizmo
        try {
          tControls.attach(g);
          selectedItem = sel;
          if (typeof refreshHud === 'function') refreshHud();
          if (typeof window.__onSelectionChange === 'function') window.__onSelectionChange(sel, true);
          console.log('  → gizmo attached');
        } catch (err) { console.warn('  → attach failed:', err); }
        // Frame the camera so the gizmo is on-screen
        try {
          const wp = new THREE.Vector3();
          g.getWorldPosition(wp);
          controls.target.copy(wp);
          camera.position.set(wp.x + 0.7, wp.y + 0.4, wp.z + 0.7);
          controls.update();
          console.log('  → camera framed at world', wp.toArray().map(v=>v.toFixed(3)));
        } catch (err) { console.warn('  → camera frame failed:', err); }
      };
      // One-line diagnostic. Run `window.__diagnoseLeaves()` in console.
      window.__diagnoseLeaves = function () {
        const g = window.__bonsaiLeavesGroup;
        console.log('=== LEAVES DIAGNOSTIC ===');
        console.log('group:', g ? g.name : '(missing)');
        if (g) {
          console.log('  position:', g.position.toArray().map(v => v.toFixed(3)));
          console.log('  rotation:', g.rotation.toArray().slice(0,3).map(v => v.toFixed(3)));
          console.log('  scale:   ', g.scale.x.toFixed(3));
          console.log('  visible: ', g.visible);
          console.log('  children:', g.children.length);
          console.log('  parent:  ', g.parent ? (g.parent.name || '(scene)') : '(orphan)');
          console.log('  original centroid:', g.userData.__originalCentroid);
        }
        console.log('selectBonsaiLeaves:', typeof window.__selectBonsaiLeaves);
        console.log('resetBonsaiLeavesPosition:', typeof window.__resetBonsaiLeavesPosition);
        console.log('leaves mesh:', window.__bonsaiLeavesMesh ? window.__bonsaiLeavesMesh.name : '(missing)');
        let sel = null;
        try { sel = SELECTABLE.find((s) => s.group === g); } catch {}
        console.log('SELECTABLE entry:', sel ? sel.label : '(NOT registered)');
        try {
          const s = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          const keys = Object.keys(s).filter(k => k.startsWith('item.Bonsai_leaves'));
          console.log('persisted item.Bonsai_leaves.* keys:', keys.length);
          keys.forEach(k => console.log('  ', k, '=', s[k]));
        } catch {}
        console.log('=== END ===');
      };
      // Capture every mesh inside the red marker's world AABB and
      // attach them DIRECTLY to the marker group. From then on,
      // dragging the marker (gizmo) or using the bonsai-leaves sliders
      // moves the captured meshes too. The visible red cube child is
      // hidden after lock so it doesn't clutter — but the marker
      // group stays selectable so you can still grab + drag it.
      const ORIG_PARENTS_KEY = '__capturedOrigParents';
      window.__lockLeavesToMarker = function () {
        const m = window.__leavesMarkerGroup;
        if (!m) { console.warn('[leaves-marker] marker missing'); return; }
        // If already locked, unlock first so we don't double-attach.
        if (m.userData[ORIG_PARENTS_KEY]) window.__unlockLeavesFromMarker();
        m.updateMatrixWorld(true);
        // Use ONLY the visible red cube child for the volume test —
        // not the whole group (which would balloon if we add captures).
        const visibleCube = m.children.find((c) => c.isMesh && c.material?.color?.getHex?.() === 0xff3344);
        const markerBox = new THREE.Box3().setFromObject(visibleCube || m);
        const _wp = new THREE.Vector3();
        const captured = [];
        const origParents = [];
        const sampleNames = [];
        scene.traverse((o) => {
          if (!o.isMesh) return;
          // Skip the marker itself and its descendants.
          let p = o; let skip = false;
          while (p) {
            if (p === m) { skip = true; break; }
            p = p.parent;
          }
          if (skip) return;
          o.getWorldPosition(_wp);
          if (markerBox.containsPoint(_wp)) {
            captured.push(o);
            origParents.push(o.parent);
            if (sampleNames.length < 8) sampleNames.push(o.name || '(unnamed)');
          }
        });
        if (captured.length === 0) {
          alert('No meshes found inside the red marker box. Drag the marker on top of the leaves first, then try again.');
          return;
        }
        // Re-parent each into the marker group (preserves world transform).
        captured.forEach((mesh) => m.attach(mesh));
        // Stash original parents on the marker so unlock can restore them.
        m.userData[ORIG_PARENTS_KEY] = captured.map((c, i) => ({ mesh: c, parent: origParents[i] }));
        // Hide the red cube fully (opacity 0 AND visible false — covers
        // both pipelines so nothing remains visible).
        if (visibleCube) {
          visibleCube.visible = false;
          if (visibleCube.material) {
            visibleCube.material.opacity = 0;
            visibleCube.material.transparent = true;
          }
        }
        // Promote the marker to the canonical "Bonsai leaves" item so
        // clicking any captured leaf in the scene opens the standard
        // contextual editor labeled "Bonsai leaves" (drag X/Y/Z, rotate,
        // scale — same controls every other item has).
        try {
          const oldEntry = SELECTABLE.find((s) => s.group === window.__bonsaiLeavesGroup);
          if (oldEntry) {
            // Remove the now-empty original Bonsai leaves entry.
            const idx = SELECTABLE.indexOf(oldEntry);
            if (idx >= 0) SELECTABLE.splice(idx, 1);
          }
          const myEntry = SELECTABLE.find((s) => s.group === m);
          if (myEntry) myEntry.label = 'Bonsai leaves';
        } catch {}
        console.log(`[leaves-marker] locked ${captured.length} mesh(es) — marker is now "Bonsai leaves":`, sampleNames);
        alert(`✅ Locked ${captured.length} mesh(es) as "Bonsai leaves".\n\nThe red box is hidden (0 opacity). Click any captured leaf in the scene to select + drag the whole group.`);
      };
      window.__unlockLeavesFromMarker = function () {
        const m = window.__leavesMarkerGroup;
        if (!m) return;
        const stash = m.userData[ORIG_PARENTS_KEY];
        if (Array.isArray(stash)) {
          stash.forEach(({ mesh, parent }) => {
            try { (parent || scene).attach(mesh); } catch {}
          });
          m.userData[ORIG_PARENTS_KEY] = null;
        }
        // Restore the red cube
        const visibleCube = m.children.find((c) => c.isMesh && c.material?.color?.getHex?.() === 0xff3344);
        if (visibleCube) {
          visibleCube.visible = true;
          if (visibleCube.material) visibleCube.material.opacity = 0.22;
        }
        // Restore the SELECTABLE labels — old "Bonsai leaves" entry
        // comes back, marker becomes "Leaves marker" again.
        try {
          const myEntry = SELECTABLE.find((s) => s.group === m);
          if (myEntry) myEntry.label = 'Leaves marker';
          if (window.__bonsaiLeavesGroup && !SELECTABLE.find((s) => s.group === window.__bonsaiLeavesGroup)) {
            SELECTABLE.push({ group: window.__bonsaiLeavesGroup, label: 'Bonsai leaves' });
          }
        } catch {}
        console.log('[leaves-marker] unlocked — captures returned to original parents, marker shown again');
      };

      // ONE-TIME AUTO-FIX (May 13, 2026): user reported the leaves were
      // out of place + red marker box visible after recent edits. We
      // snap leaves back to their original centroid and force the red
      // marker hidden — but only ONCE so we don't fight future drags.
      // The flag key bumps if we ever need to re-trigger.
      const _BONSAI_FIX_FLAG = 'desk-portfolio:bonsai-fix:v2026-05-13';
      try {
        if (IS_BUILD_MODE && !localStorage.getItem(_BONSAI_FIX_FLAG)) {
          // Reset leaves to original
          grp.position.set(cx, cy, cz);
          grp.rotation.set(0, 0, 0);
          grp.scale.set(1, 1, 1);
          const _stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          ['x','y','z','rotX','rotY','rotZ','scale'].forEach((k) => {
            delete _stored[`item.Bonsai_leaves.${k}`];
          });
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(_stored));
          // Hide the red leaves marker (both persistent + this session)
          const _hidden = JSON.parse(localStorage.getItem('hidden.props.v1') || '[]');
          if (!_hidden.includes('Leaves marker')) _hidden.push('Leaves marker');
          localStorage.setItem('hidden.props.v1', JSON.stringify(_hidden));
          if (window.__leavesMarkerGroup) window.__leavesMarkerGroup.visible = false;
          localStorage.setItem(_BONSAI_FIX_FLAG, '1');
          console.log('[bonsai-leaves] ✅ one-time auto-fix applied — leaves reset, red marker hidden');
        }
      } catch (err) { console.warn('[bonsai-leaves] auto-fix skipped:', err); }

      // Snap the group back to its ORIGINAL centroid (extracted from
      // room.glb) and clear all persisted item.Bonsai_leaves.* keys
      // so a reload doesn't re-apply the old offset.
      window.__resetBonsaiLeavesPosition = function () {
        const g = window.__bonsaiLeavesGroup;
        if (!g) return;
        const orig = g.userData.__originalCentroid;
        if (orig) g.position.set(orig.x, orig.y, orig.z);
        g.rotation.set(0, 0, 0);
        g.scale.set(1, 1, 1);
        try {
          const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          ['x','y','z','rotX','rotY','rotZ','scale'].forEach((k) => {
            delete stored[`item.Bonsai_leaves.${k}`];
          });
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(stored));
        } catch {}
        console.log('[bonsai-leaves] reset to original centroid', orig);
      };
    })();
  },
  (xhr) => {
    const pct = xhr.total ? xhr.loaded / xhr.total : 0;
    console.log('[scene] room.glb', Math.round(pct * 100) + '%');
    // Room load fills 15→80% of the boot bar. The remaining 20% is
    // for initial scene composition (lights, props, first frame).
    window.__bootStep?.(
      pct < 1 ? 'STREAMING THE ROOM (' + Math.round(pct * 100) + '%)' : 'PLACING THE PROPS',
      0.15 + pct * 0.65,
    );
  },
  (err) => {
    console.error('[scene] room.glb FAILED', err);
    window.__bootStep?.('ROOM FAILED — PROCEEDING ANYWAY', 0.95);
    setTimeout(() => window.__bootDone?.(), 600);
  }
);

// ---------- camera + DOF mode functions ----------------------------------
function moveCamera(pos, target) {
  const startPos = camera.position.clone();
  const startTarget = controls.target.clone();
  const t0 = performance.now();
  const dur = 900;
  function step() {
    const t = Math.min(1, (performance.now() - t0) / dur);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    camera.position.lerpVectors(startPos, pos, e);
    controls.target.lerpVectors(startTarget, target, e);
    controls.update();
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

let _currentMode = 'hero';
// Listeners notified after every setMode call. Used by the "Edit"
// affordance to reveal/hide its slide-in panel.
const _modeChangeHandlers = [];
const _shelfViewTmpBox = new THREE.Box3();
const _shelfViewTmpSize = new THREE.Vector3();
const _shelfViewTmpCenter = new THREE.Vector3();
function setMode(mode) {
  const _prevMode = _currentMode;
  _currentMode = mode;
  for (const h of _modeChangeHandlers) {
    try { h(mode); } catch (err) { console.warn('[mode] handler failed', err); }
  }
  // Snap blur off the INSTANT we leave computer mode (any other mode).
  // The render loop's slow lerp would otherwise let bokeh linger ~1 second
  // on the way out, which feels sluggish.
  if (_prevMode === 'computer' && mode !== 'computer') {
    if (dof) dof.bokehScale = 0;
    dofBokehTarget = 0.0;
  }
  // Re-arm OrbitControls so the user can drag-to-orbit in every mode.
  // Anything earlier in the session (transform-gizmo drag-end, fly toggle,
  // panel drag) could leave controls.enabled=false or enableRotate=false.
  // We aggressively re-enable on every mode change.
  if (controls) {
    controls.enabled = true;
    controls.enableRotate = true;
    controls.enableZoom = true;
    controls.enablePan = true;
  }
  if (mode === 'computer') {
    const dC = _modePanDelta(COMPUTER_POS, COMPUTER_TARGET, _modePan.computer);
    moveCamera(COMPUTER_POS.clone().add(dC), COMPUTER_TARGET.clone().add(dC));
    focusTarget.copy(FOCUS_SCREEN).add(dC);
    // Background blur: pull everything past the Mac screen into bokeh haze
    // so the Luca backdrop + desk edges go dreamy while the CRT stays crisp.
    dofBokehTarget = computerBlur.bokehScale;
    // focusRange is on cocMaterial (not directly on dof) — see notes above.
    if (dof && dof.cocMaterial) dof.cocMaterial.focusRange = computerBlur.focusRange;
    showComputerScreen();
  } else if (mode === 'sit') {
    // Snap blur off the instant we leave computer mode — the gentle lerp
    // in the render loop would otherwise let bokeh linger ~1 second on
    // the way out. Instant feel is the right move here.
    if (dof) dof.bokehScale = 0;
    dofBokehTarget = 0.0;
    const dS = _modePanDelta(SIT_POS, SIT_TARGET, _modePan.sit);
    moveCamera(SIT_POS.clone().add(dS), SIT_TARGET.clone().add(dS));
    focusTarget.copy(FOCUS_DESK).add(dS);
    dofBokehTarget = 0.0;
    hideComputerScreen();
  } else if (mode === 'shelf' || mode === 'rightShelf') {
    // Head-on shelf view — works for either the LEFT bookshelf
    // (`propGroups.bookshelf.group`) or the RIGHT mirror
    // (`window._mirroredBookshelf` / accessed via build helper). The
    // camera sits on the room-facing side of whichever shelf was
    // requested, framed tighter so the shelf fills the view instead
    // of getting cut off at the edges.
    let target = null;
    if (mode === 'shelf') target = propGroups.bookshelf?.group;
    else if (mode === 'rightShelf') {
      target = (typeof window !== 'undefined' && typeof window.__buildMirroredBookshelf === 'function')
        ? window.__buildMirroredBookshelf() : null;
    }
    if (target) {
      // Compute bbox using ONLY the alcove's structural walls
      // (BackPanel / Side_Front / Side_Back / TopCap). Those exist on
      // both shelves identically (the right is a clone of the left),
      // so the resulting centers are perfect mirrors — the framing
      // is guaranteed to line up between Left and Right shelf views.
      // If we used setFromObject(target) instead, user-attached props
      // (chest, sword, leaves, etc.) shift the bbox differently on
      // each side and the views drift apart.
      _shelfViewTmpBox.makeEmpty();
      target.updateMatrixWorld(true);
      let foundStructural = false;
      target.traverse((o) => {
        if (!o.isMesh) return;
        if (SHELF_RECESS_MESH_NAMES.has(o.name)) {
          _shelfViewTmpBox.expandByObject(o);
          foundStructural = true;
        }
      });
      // Fallback: if no structural walls found (shouldn't happen but be
      // safe), use the full target bbox.
      if (!foundStructural) _shelfViewTmpBox.setFromObject(target);
      if (isFinite(_shelfViewTmpBox.min.x)) {
        _shelfViewTmpBox.getCenter(_shelfViewTmpCenter);
        _shelfViewTmpBox.getSize(_shelfViewTmpSize);
        // FOV-aware fit: compute the distance that makes the whole
        // shelf fit in the viewport regardless of aspect ratio. For a
        // head-on view at ±X looking along ±X, the camera sees Y
        // (vertical) and Z (horizontal). Distance must satisfy:
        //   tan(vFov/2) ≥ (sizeY/2) / dist          (vertical fit)
        //   tan(hFov/2) ≥ (sizeZ/2) / dist          (horizontal fit)
        // with hFov = 2·atan(tan(vFov/2) · aspectRatio). We solve for
        // dist on both axes and take the LARGER so neither dimension
        // gets clipped. Multiply by 1.18 for a comfortable margin
        // around the shelf.
        const vFov = camera.fov * Math.PI / 180;
        const aspect = camera.aspect;
        const halfH = _shelfViewTmpSize.y / 2;
        const halfW = _shelfViewTmpSize.z / 2;
        const distForHeight = halfH / Math.tan(vFov / 2);
        const distForWidth  = halfW / (Math.tan(vFov / 2) * aspect);
        const dist = Math.max(distForHeight, distForWidth, 1.4) * 1.18;
        // Base camera position (centered on bbox, FOV-fit distance).
        // LEFT shelf: camera at min.x - dist, looking +X.
        // RIGHT shelf: camera at max.x + dist, looking -X.
        const baseCamX = (mode === 'rightShelf')
          ? _shelfViewTmpBox.max.x + dist
          : _shelfViewTmpBox.min.x - dist;
        const baseCam = new THREE.Vector3(baseCamX, _shelfViewTmpCenter.y, _shelfViewTmpCenter.z);
        const baseTarget = new THREE.Vector3(
          _shelfViewTmpCenter.x, _shelfViewTmpCenter.y, _shelfViewTmpCenter.z
        );
        // Camera-local frame so offsets behave the same on BOTH shelves
        // regardless of camera direction:
        //   shelfViewX → zoom along the look axis (positive = closer)
        //   shelfViewY → vertical pan (positive = up)
        //
        // The HORIZONTAL pan is now hardcoded PER SHELF — the user
        // tuned each side independently because the bookshelf's
        // content distribution is slightly asymmetric (the left has
        // attached props, the right is a clean mirror), and the
        // visually-centered framing differs between them. Locked
        // values:
        //   LEFT  = +0.715 (camera-local right-of-view, pushes left
        //                   shelf's framing leftward in the frame)
        //   RIGHT = -0.550 (camera-local right-of-view)
        // To re-tune, change SHELF_VIEW_PAN_H below.
        const SHELF_VIEW_PAN_H = {
          shelf:      0.715,
          rightShelf: -0.550,
        };
        const lockedPanH = SHELF_VIEW_PAN_H[mode] ?? 0;
        const forward = new THREE.Vector3().subVectors(baseTarget, baseCam).normalize();
        const right   = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
        const up      = new THREE.Vector3().crossVectors(right, forward).normalize();
        const camOffset = new THREE.Vector3()
          .addScaledVector(forward, shelfViewX)
          .addScaledVector(up,      shelfViewY)
          .addScaledVector(right,   lockedPanH);
        const camPos    = baseCam.clone().add(camOffset);
        const camTarget = baseTarget.clone().add(camOffset);
        moveCamera(camPos, camTarget);
        focusTarget.copy(camTarget);
        dofBokehTarget = 0.0;
        hideComputerScreen();
        console.log(`[shelf-view] ${mode} — bbox size (${_shelfViewTmpSize.x.toFixed(2)}, ${_shelfViewTmpSize.y.toFixed(2)}, ${_shelfViewTmpSize.z.toFixed(2)}); dist=${dist.toFixed(2)}; aspect=${aspect.toFixed(2)}`);
      }
    }
  } else {
    const dH = _modePanDelta(HERO_POS, HERO_TARGET, _modePan.hero);
    moveCamera(HERO_POS.clone().add(dH), HERO_TARGET.clone().add(dH));
    focusTarget.copy(FOCUS_HERO).add(dH);
    dofBokehTarget = 0.0;
    hideComputerScreen();
  }
}

// ---------- Mac screen surface (3D mesh living on the CRT face) ---------
// A textured plane positioned over the Mac's CRT. The material is glass-like
// (low roughness, picks up HDRI reflection) with an EMISSIVE map driven by
// a 2D canvas. When the computer is "off" emissiveIntensity is 0 — you see
// only the reflective black glass. Booting ramps emissiveIntensity 0→1 so
// the screen appears to "warm up" as the content fades in.
const SCREEN_CANVAS_W = 1024;
const SCREEN_CANVAS_H = 768;
const screenCanvas = document.createElement('canvas');
screenCanvas.width = SCREEN_CANVAS_W;
screenCanvas.height = SCREEN_CANVAS_H;
const screenCtx = screenCanvas.getContext('2d');
const screenTexture = new THREE.CanvasTexture(screenCanvas);
screenTexture.colorSpace = THREE.SRGBColorSpace;
screenTexture.minFilter = THREE.LinearFilter;
screenTexture.magFilter = THREE.LinearFilter;

// Screen state machine: 'off' | 'booting' | 'on'.
// Default boots when "Use computer" is clicked, fades in animated boot
// sequence, then settles on the menu. Returns to 'off' on any other mode.
let screenState = 'off';
let screenStateStart = 0;
const BOOT_DURATION = 2400;

function paintScanlinesAndVignette() {
  const c = screenCtx, W = SCREEN_CANVAS_W, H = SCREEN_CANVAS_H;
  c.fillStyle = 'rgba(0,0,0,0.18)';
  for (let y = 0; y < H; y += 3) c.fillRect(0, y, W, 1);
  const vig = c.createRadialGradient(W/2, H/2, W*0.4, W/2, H/2, W*0.85);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.55)');
  c.fillStyle = vig;
  c.fillRect(0, 0, W, H);
}

function drawScreenOff() {
  const c = screenCtx, W = SCREEN_CANVAS_W, H = SCREEN_CANVAS_H;
  c.fillStyle = '#020403';
  c.fillRect(0, 0, W, H);
  // Faint static ghost so the CRT doesn't look pure-black-flat
  const grad = c.createRadialGradient(W/2, H/2, 0, W/2, H/2, W*0.55);
  grad.addColorStop(0, 'rgba(125,255,160,0.04)');
  grad.addColorStop(1, 'rgba(0,0,0,0.85)');
  c.fillStyle = grad;
  c.fillRect(0, 0, W, H);
  paintScanlinesAndVignette();
  screenTexture.needsUpdate = true;
}

function drawScreenBooting(t) {
  const c = screenCtx, W = SCREEN_CANVAS_W, H = SCREEN_CANVAS_H;
  c.fillStyle = '#04100a';
  c.fillRect(0, 0, W, H);
  const grad = c.createRadialGradient(W/2, H/2, W*0.15, W/2, H/2, W*0.7);
  grad.addColorStop(0, 'rgba(125,255,160,0.05)');
  grad.addColorStop(1, 'rgba(0,0,0,0.6)');
  c.fillStyle = grad;
  c.fillRect(0, 0, W, H);

  c.fillStyle = '#7dffa0';
  c.font = '32px ui-monospace, "SFMono-Regular", Menlo, monospace';
  const lines = [
    '> MARC OS bootloader v1.0',
    '> initializing memory ........ ok',
    '> mounting /portfolio ........ ok',
    '> loading kernel ............. ok',
    '> starting marc os ........... ok',
  ];
  const visibleLines = Math.min(lines.length, Math.floor(t * (lines.length + 0.4)));
  for (let i = 0; i < visibleLines; i++) c.fillText(lines[i], 60, 100 + i * 50);
  // Blinking cursor on the next-to-be-drawn line
  if (visibleLines < lines.length && Math.floor(t * 12) % 2 === 0) {
    c.fillRect(60, 100 + visibleLines * 50 - 24, 16, 32);
  }
  // Progress bar
  const barX = 60, barY = 100 + lines.length * 50 + 30;
  const barW = W - 120, barH = 18;
  c.strokeStyle = 'rgba(125,255,160,0.45)';
  c.lineWidth = 2;
  c.strokeRect(barX, barY, barW, barH);
  c.fillStyle = '#7dffa0';
  c.fillRect(barX + 3, barY + 3, (barW - 6) * t, barH - 6);
  c.fillStyle = '#bdffce';
  c.font = '24px ui-monospace, Menlo, monospace';
  c.fillText(`${Math.round(t * 100)}%`, barX, barY + barH + 38);
  paintScanlinesAndVignette();
  screenTexture.needsUpdate = true;
}

function drawScreenMenu() {
  const c = screenCtx, W = SCREEN_CANVAS_W, H = SCREEN_CANVAS_H;
  c.fillStyle = '#06120a';
  c.fillRect(0, 0, W, H);
  const grad = c.createRadialGradient(W/2, H/2, W*0.2, W/2, H/2, W*0.7);
  grad.addColorStop(0, 'rgba(125,255,160,0.05)');
  grad.addColorStop(1, 'rgba(0,0,0,0.5)');
  c.fillStyle = grad;
  c.fillRect(0, 0, W, H);
  c.fillStyle = '#bdffce';
  c.font = '700 92px ui-monospace, "SFMono-Regular", Menlo, monospace';
  c.fillText('marc', 60, 130);
  c.fillStyle = 'rgba(125,255,160,0.7)';
  c.font = '32px ui-monospace, Menlo, monospace';
  c.fillText('portfolio · commercials · misc', 64, 175);
  c.fillStyle = '#7dffa0';
  c.font = '28px ui-monospace, Menlo, monospace';
  c.fillText('// commercials', 60, 260);
  c.font = '24px ui-monospace, Menlo, monospace';
  c.fillStyle = 'rgba(189,255,206,0.85)';
  ['commercial #1', 'commercial #2', 'commercial #3'].forEach((t, i) => {
    c.fillText('•  ' + t, 90, 310 + i * 40);
  });
  c.fillStyle = '#7dffa0';
  c.font = '28px ui-monospace, Menlo, monospace';
  c.fillText('// about', 60, 490);
  c.fillStyle = 'rgba(189,255,206,0.85)';
  c.font = '22px ui-monospace, Menlo, monospace';
  c.fillText("hi, i'm marc.", 90, 530);
  c.fillText('drop the real bio here.', 90, 558);
  paintScanlinesAndVignette();
  screenTexture.needsUpdate = true;
}

// ---- PORTFOLIO IN-SCREEN INTRO ----
// After the basic boot finishes, the Mac screen continues into a 3-phase
// portfolio intro that LIVES ON THE 3D SCREEN (not a full-page overlay):
//   1) 'real-magic'      — black, big "NOW IT'S TIME FOR THE REAL MAGIC."
//   2) 'awaiting-scroll' — black, flashing "SCROLL TO ENTER"
//   3) 'diving'          — fades to pure black; camera dollies into the
//                          screen plane. When this beat ends we hand off
//                          to portfolioOverlay (space + Earth + pins).
const LOADING_DURATION    = 2200;   // "loading portfolio..." bar fills
const REAL_MAGIC_DURATION = 1800;
const DIVE_DURATION       = 1100;   // snappy WHOOSH into the screen — long enough to FEEL the dive

function drawScreenLoading(t) {
  const c = screenCtx, W = SCREEN_CANVAS_W, H = SCREEN_CANVAS_H;
  c.fillStyle = '#04100a';
  c.fillRect(0, 0, W, H);
  // Title
  c.fillStyle = '#7dffa0';
  c.font = '700 44px ui-monospace, "SFMono-Regular", Menlo, monospace';
  c.textAlign = 'center';
  c.fillText('LOADING PORTFOLIO', W / 2, 200);
  // Animated subtitle (rotating dots)
  const dots = '.'.repeat(((Math.floor(performance.now() / 280)) % 4));
  c.font = '28px ui-monospace, Menlo, monospace';
  c.fillStyle = 'rgba(189,255,206,0.7)';
  c.fillText('mounting marc.os' + dots, W / 2, 260);
  // Big progress bar
  const barX = 80, barY = H / 2 + 30;
  const barW = W - 160, barH = 26;
  c.strokeStyle = 'rgba(125,255,160,0.5)';
  c.lineWidth = 2;
  c.strokeRect(barX, barY, barW, barH);
  c.fillStyle = '#7dffa0';
  c.fillRect(barX + 4, barY + 4, (barW - 8) * t, barH - 8);
  c.fillStyle = '#bdffce';
  c.font = '24px ui-monospace, Menlo, monospace';
  c.fillText(Math.round(t * 100) + '%', W / 2, barY + barH + 44);
  // Below-bar log lines that progressively appear
  const logs = [
    '> initializing renderer',
    '> loading 3d earth assets',
    '> mounting pin database',
    '> charging warp drive',
    '> ready.',
  ];
  const shown = Math.min(logs.length, Math.floor(t * (logs.length + 0.3)));
  c.textAlign = 'left';
  c.font = '20px ui-monospace, Menlo, monospace';
  c.fillStyle = 'rgba(125,255,160,0.85)';
  for (let i = 0; i < shown; i++) c.fillText(logs[i], 90, barY + barH + 86 + i * 26);
  c.textAlign = 'left';
  paintScanlinesAndVignette();
  screenTexture.needsUpdate = true;
}

function drawScreenPressEnter(now) {
  const c = screenCtx, W = SCREEN_CANVAS_W, H = SCREEN_CANVAS_H;
  c.fillStyle = '#04100a';
  c.fillRect(0, 0, W, H);
  // Header
  c.fillStyle = '#7dffa0';
  c.font = '700 36px ui-monospace, Menlo, monospace';
  c.textAlign = 'center';
  c.fillText('PORTFOLIO READY', W / 2, H / 2 - 110);
  // Body
  c.fillStyle = 'rgba(189,255,206,0.8)';
  c.font = '24px ui-monospace, Menlo, monospace';
  c.fillText('the world is waiting on the other side.', W / 2, H / 2 - 50);
  // Flashing CTA
  const blink = ((now % 1100) < 660) ? 1 : 0.18;
  c.fillStyle = `rgba(255, 214, 107, ${blink})`;
  c.font = '700 44px ui-monospace, Menlo, monospace';
  c.fillText('▸ PRESS ENTER ◂', W / 2, H / 2 + 60);
  c.font = '18px ui-monospace, Menlo, monospace';
  c.fillStyle = 'rgba(255,255,255,0.45)';
  c.fillText('(or click the screen)', W / 2, H / 2 + 110);
  c.textAlign = 'left';
  paintScanlinesAndVignette();
  screenTexture.needsUpdate = true;
}

function drawScreenRealMagic(t) {
  const c = screenCtx, W = SCREEN_CANVAS_W, H = SCREEN_CANVAS_H;
  c.fillStyle = '#000';
  c.fillRect(0, 0, W, H);
  // Text fades in then settles
  const alpha = Math.min(1, t * 2);
  c.fillStyle = `rgba(189, 255, 206, ${alpha})`;
  c.font = '700 56px ui-monospace, "SFMono-Regular", Menlo, monospace';
  c.textAlign = 'center';
  c.fillText('NOW IT\'S TIME', W / 2, H / 2 - 30);
  c.fillText('FOR THE REAL', W / 2, H / 2 + 40);
  c.fillStyle = `rgba(255, 214, 107, ${alpha})`;
  c.font = '700 64px ui-monospace, "SFMono-Regular", Menlo, monospace';
  c.fillText('MAGIC.', W / 2, H / 2 + 120);
  c.textAlign = 'left';
  paintScanlinesAndVignette();
  screenTexture.needsUpdate = true;
}

function drawScreenAwaitingScroll(now) {
  const c = screenCtx, W = SCREEN_CANVAS_W, H = SCREEN_CANVAS_H;
  c.fillStyle = '#000';
  c.fillRect(0, 0, W, H);
  // Blink at ~1.2s rate
  const blink = ((now % 1200) < 720) ? 1 : 0.18;
  c.fillStyle = `rgba(255, 255, 255, ${blink})`;
  c.font = '700 42px ui-monospace, "SFMono-Regular", Menlo, monospace';
  c.textAlign = 'center';
  c.fillText('SCROLL TO ENTER', W / 2, H / 2);
  // Bouncing arrows below
  const bounce = Math.sin(now / 300) * 6;
  c.font = '36px ui-monospace, Menlo, monospace';
  c.fillStyle = `rgba(255, 255, 255, ${0.5 + blink * 0.3})`;
  c.fillText('↓  ↓  ↓', W / 2, H / 2 + 90 + bounce);
  c.textAlign = 'left';
  paintScanlinesAndVignette();
  screenTexture.needsUpdate = true;
}

function drawScreenDiving(_t) {
  // Pure black during the dive. NO stars, no streaks, no glow — the
  // screen is just a black rectangle that grows in the viewport as
  // the camera dollies in. Stars + Earth fade in AFTER the camera has
  // passed through the screen and the overlay has taken over.
  const c = screenCtx, W = SCREEN_CANVAS_W, H = SCREEN_CANVAS_H;
  c.fillStyle = '#000';
  c.fillRect(0, 0, W, H);
  screenTexture.needsUpdate = true;
}

function updateMacScreen() {
  const now = performance.now();
  if (screenState === 'booting') {
    const t = Math.min(1, (now - screenStateStart) / BOOT_DURATION);
    drawScreenBooting(t);
    // Fade emissive in over the boot — the glass "warms up" as content appears.
    macScreenMat.emissiveIntensity = t * t;
    if (t >= 1) {
      // After bootloader: portfolio flow goes through LOADING →
      // PRESS-ENTER → REAL-MAGIC → SCROLL-PROMPT → DIVE.
      // (Plain computer mode without the flow active falls through to
      // the legacy menu so nothing breaks for old screens.)
      if (_portfolioFlowActive) {
        screenState = 'loading';
        screenStateStart = now;
      } else {
        screenState = 'on';
        drawScreenMenu();
      }
      macScreenMat.emissiveIntensity = 1;
    }
  } else if (screenState === 'loading') {
    const t = Math.min(1, (now - screenStateStart) / LOADING_DURATION);
    drawScreenLoading(t);
    if (t >= 1) {
      screenState = 'press-enter';
      screenStateStart = now;
      _armPressEnter();
    }
  } else if (screenState === 'press-enter') {
    drawScreenPressEnter(now);
  } else if (screenState === 'real-magic') {
    const t = Math.min(1, (now - screenStateStart) / REAL_MAGIC_DURATION);
    drawScreenRealMagic(t);
    if (t >= 1) {
      screenState = 'awaiting-scroll';
      screenStateStart = now;
      _armScrollDive();
    }
  } else if (screenState === 'awaiting-scroll') {
    drawScreenAwaitingScroll(now);
  } else if (screenState === 'diving') {
    const t = (typeof _scrollDiveSmooth === 'number') ? _scrollDiveSmooth : 0;
    drawScreenDiving(t);
  }
}

// Initial paint — screen is OFF until "Use computer" is clicked
drawScreenOff();
window.__redrawScreen = drawScreenMenu;

const macScreen = new THREE.Group();
macScreen.name = '__macScreen';
// Locked from user's gizmo placement
macScreen.position.set(-0.169, 1.029, 1.898);
macScreen.rotation.set(0.104, 0.000, 0.000);
macScreen.scale.setScalar(1.265);
scene.add(macScreen);

// CRT geometry — a subtly curved (concave from front) plane like the old
// Macintosh tube. The bow uses a pillow function (1-x²)(1-y²) so the curve
// covers the WHOLE surface uniformly — including the corners. Previously
// we used radial distance clamped to 1 which left corners flat.
const macScreenGeo = (() => {
  const W = 0.20, H = 0.15;
  const SX = 28, SY = 22;            // dense enough to keep the curve smooth
  const CURVE = 0.014;               // depth of bow at center (1.4 cm)
  const g = new THREE.PlaneGeometry(W, H, SX, SY);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) / (W / 2);   // -1..+1
    const y = pos.getY(i) / (H / 2);   // -1..+1
    // Pillow bow — equals CURVE at the center and gracefully tapers to 0
    // along ALL edges (including corners) so the curvature is continuous.
    const bow = (1 - x * x) * (1 - y * y);
    pos.setZ(i, bow * CURVE);
  }
  g.computeVertexNormals();
  return g;
})();

// Glass-like material:
//   - Black diffuse so the screen is dark when "off"
//   - emissiveMap = canvas → the content shows ONLY when emissiveIntensity > 0
//   - low roughness + envMapIntensity so HDRI reflects off the glass
const macScreenMat = new THREE.MeshStandardMaterial({
  color: 0x000000,
  emissive: 0xffffff,
  emissiveMap: screenTexture,
  emissiveIntensity: 0,
  roughness: 0.18,
  metalness: 0.0,
  envMapIntensity: 1.4,
  side: THREE.FrontSide,
});
const macScreenMesh = new THREE.Mesh(macScreenGeo, macScreenMat);
macScreenMesh.rotation.y = Math.PI;
macScreen.add(macScreenMesh);
makeSelectable(macScreen, 'Mac screen surface');
window.__macScreen = macScreen;
window.__redrawScreen = drawScreenMenu;


// HTML overlay removed — the 3D textured plane IS the screen now.
// We keep stub show/hide functions so setMode doesn't blow up.
const screenHtml = document.createElement('div');
screenHtml.style.display = 'none';
screenHtml.id = '__macScreenHtml';
screenHtml.style.cssText = `
  position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
  width: 56vh; height: 42vh;
  pointer-events: auto;
  background: #0a1208; color: #7dffa0;
  font: 13px/1.55 ui-monospace, "SFMono-Regular", Menlo, monospace;
  border: 1px solid rgba(125,255,160,0.18);
  box-shadow: 0 0 30px rgba(125,255,160,0.18) inset;
  padding: 14px 18px; overflow: hidden;
  opacity: 0; transition: opacity 0.55s ease;
  z-index: 6;
  box-sizing: border-box;
  display: none;
`;
screenHtml.innerHTML = `
  <div style="display:flex;align-items:center;gap:8px;font-size:11px;opacity:0.7;letter-spacing:0.5px;text-transform:uppercase;border-bottom:1px solid rgba(125,255,160,0.18);padding-bottom:6px;margin-bottom:12px;">
    <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#7dffa0;box-shadow:0 0 8px #7dffa0;"></span>
    Marc OS v1.0 <span style="margin-left:auto;opacity:0.55;">esc to exit</span>
  </div>
  <h1 style="font-size:24px;margin:4px 0 2px 0;font-weight:700;letter-spacing:-0.5px;color:#bdffce;">marc</h1>
  <div style="opacity:0.7;font-size:11px;margin-bottom:14px;">portfolio · commercials · misc</div>
  <div style="opacity:0.8;font-size:10px;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">// commercials</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:14px;">
    <div style="aspect-ratio:16/9;border:1px solid rgba(125,255,160,0.22);border-radius:4px;padding:6px;display:flex;flex-direction:column;justify-content:flex-end;font-size:11px;background:linear-gradient(180deg,rgba(255,255,255,0.02),rgba(125,255,160,0.06));">
      <div style="font-weight:600;">commercial #1</div>
      <div style="opacity:0.6;font-size:10px;">— placeholder —</div>
    </div>
    <div style="aspect-ratio:16/9;border:1px solid rgba(125,255,160,0.22);border-radius:4px;padding:6px;display:flex;flex-direction:column;justify-content:flex-end;font-size:11px;background:linear-gradient(180deg,rgba(255,255,255,0.02),rgba(125,255,160,0.06));">
      <div style="font-weight:600;">commercial #2</div>
      <div style="opacity:0.6;font-size:10px;">— placeholder —</div>
    </div>
  </div>
  <div style="opacity:0.8;font-size:10px;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">// about</div>
  <div style="opacity:0.85;line-height:1.5;font-size:11px;">hi, i'm marc. drop the real bio here.</div>
`;
document.body.appendChild(screenHtml);

let _compShown = false;
function showComputerScreen() {
  _compShown = true;
  // Boot the screen — animation runs in the render loop via updateMacScreen.
  screenState = 'booting';
  screenStateStart = performance.now();
}
function hideComputerScreen() {
  _compShown = false;
  screenState = 'off';
  drawScreenOff();
  macScreenMat.emissiveIntensity = 0;
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && _currentMode === 'computer') setMode('hero');
});
// Expose setMode + read current mode for build-mode bake automation.
window.__setMode = setMode;
window.__getCurrentMode = () => _currentMode;
function updateScreenHtmlPosition() { /* no-op for now */ }

function setScenery(s) {
  loadHDRI(s.hdri);
  setActiveSceneryId(s.id);
  if (s.backdrop) swapBackdrop(s.backdrop);
}

// Swap the backdrop plane's material between an image (rio.jpg) or a
// looping video (luca.mp4). Geometry/position are reused.
let _bgVideoEl = null;
function swapBackdrop(b) {
  if (!rioPlane) { whenRioReady(() => swapBackdrop(b)); return; }
  console.log('[backdrop] swapping to', b);
  // The plane was created with color=0x000000 to hide the empty texture
  // before a backdrop is set; switch to white so the texture renders unmodulated.
  rioPlane.material.color.setHex(0xffffff);
  const mat = rioPlane.material;
  if (b.type === 'video') {
    if (!_bgVideoEl || _bgVideoEl.dataset.src !== b.src) {
      if (_bgVideoEl) _bgVideoEl.remove();
      _bgVideoEl = document.createElement('video');
      _bgVideoEl.dataset.src = b.src;
      _bgVideoEl.src = b.src;
      _bgVideoEl.loop = true; _bgVideoEl.muted = true; _bgVideoEl.playsInline = true;
      // Website mode: don't preload the 22 MB H.264. Safari on iGPU
      // reserves a hardware decoder slot (~80 MB) the moment the video
      // element has src + preload=auto, even before play. We let it
      // load only when the visitor's actually watching.
      _bgVideoEl.autoplay = !IS_WEBSITE_MODE;
      _bgVideoEl.preload  = IS_WEBSITE_MODE ? 'metadata' : 'auto';
      // NO crossOrigin attribute — same-origin video served by our
      // Railway Express. Setting `crossOrigin='anonymous'` would
      // force the browser into CORS-mode requests and the server
      // doesn't return CORS headers, so the request stalls forever
      // with readyState=0. Without it, the same-origin video loads
      // normally and Three.js VideoTexture can still sample it.
      _bgVideoEl.style.display = 'none';
      _bgVideoEl.addEventListener('loadeddata', () => console.log('[backdrop] video loadeddata'));
      _bgVideoEl.addEventListener('canplay',    () => console.log('[backdrop] video canplay'));
      _bgVideoEl.addEventListener('playing',    () => console.log('[backdrop] video playing'));
      _bgVideoEl.addEventListener('error', (e) => console.error('[backdrop] video error', _bgVideoEl.error));
      document.body.appendChild(_bgVideoEl);
      _bgVideoEl.load();
      _bgVideoEl.play().then(() => console.log('[backdrop] play() resolved'))
                       .catch((err) => {
                         console.warn('[backdrop] autoplay blocked, will retry on first user click', err?.message);
                         // Chrome's autoplay policy blocks the first
                         // .play() call until the user gesture-interacts.
                         // Install a one-shot fallback that retries on
                         // any click/touch/key, then removes itself.
                         function _retry() {
                           if (!_bgVideoEl) return;
                           _bgVideoEl.play()
                             .then(() => console.log('[backdrop] play() resolved after user gesture'))
                             .catch((e) => console.warn('[backdrop] retry play() failed', e));
                           window.removeEventListener('pointerdown', _retry);
                           window.removeEventListener('keydown', _retry);
                           window.removeEventListener('touchstart', _retry);
                         }
                         window.addEventListener('pointerdown', _retry, { once: true });
                         window.addEventListener('keydown',     _retry, { once: true });
                         window.addEventListener('touchstart',  _retry, { once: true });
                       });
    }
    const tex = new THREE.VideoTexture(_bgVideoEl);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.center.set(0.5, 0.5);
    tex.repeat.set(1, 1);
    if (mat.map) mat.map.dispose();
    mat.map = tex;
    mat.needsUpdate = true;
    console.log('[backdrop] VideoTexture assigned, video readyState=', _bgVideoEl.readyState);
  } else {
    new THREE.TextureLoader().load(b.src, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.center.set(0.5, 0.5);
      tex.repeat.set(b.mirror ? -1 : 1, 1);
      tex.needsUpdate = true;
      if (mat.map) mat.map.dispose();
      mat.map = tex;
      mat.needsUpdate = true;
      console.log('[backdrop] image assigned:', b.src);
    });
  }
}

// ---- Portfolio flow ----
//
// The whole experience the user clicks into:
//   1) click "Use computer" → camera flies to Mac (existing computer mode)
//   2) Mac SCREEN shows boot text ("MARC OS bootloader v1.0...")
//   3) "NOW IT'S TIME FOR THE REAL MAGIC." big text on the screen
//   4) Black screen + flashing "SCROLL TO ENTER" with bouncing arrows
//   5) On scroll/wheel/touch: camera DIVES INTO the Mac screen (dollies
//      forward + FOV zoom + screen turns to pure black with streaking
//      stars — feels like flying through the CRT into hyperspace)
//   6) Overlay mounts: Earth scene + pins. Room renderer pauses.
//   7) "leave computer" reverses everything: overlay reverse-zooms,
//      room re-renders, camera reverse-dollies back from the screen.
let _portfolioHandle    = null;
let _portfolioFlowActive = false;
let _diveHandoffFired   = false;
let _diveTweenInFlight  = false;
let _scrollListenerAttached = false;
let _scrollDiveCleanup  = null;
// Cached camera state so reverse-dive can return EXACTLY where we started.
let _diveStartCamPos    = null;
let _diveStartCtrlsTarget = null;
let _diveStartFov       = null;

function enterPortfolioFlow() {
  if (_portfolioFlowActive) return;
  _portfolioFlowActive = true;
  _diveHandoffFired   = false;
  // Drive the camera to the Mac. setMode → showComputerScreen sets
  // screenState='booting'. Because _portfolioFlowActive is true,
  // updateMacScreen() will then transition booting → real-magic →
  // awaiting-scroll instead of jumping to the legacy menu.
  setMode('computer');
}

let _pressEnterCleanup = null;
function _armPressEnter() {
  if (_pressEnterCleanup) return;
  const advance = (e) => {
    if (screenState !== 'press-enter') return;
    e?.preventDefault?.();
    // Advance to the "real magic" beat
    screenState = 'real-magic';
    screenStateStart = performance.now();
    _pressEnterCleanup?.();
  };
  const onKey = (e) => {
    if (screenState !== 'press-enter') return;
    if (e.key === 'Enter' || e.key === ' ') advance(e);
    else if (e.key === 'Escape') exitPortfolioFlow();
  };
  const onClick = (e) => {
    // Only count clicks on the canvas (the 3D scene area) so UI buttons
    // don't accidentally advance the flow.
    if (e.target !== renderer.domElement) return;
    advance(e);
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('pointerdown', onClick);
  _pressEnterCleanup = () => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('pointerdown', onClick);
    _pressEnterCleanup = null;
  };
}

// Scroll-driven dive: each wheel event nudges a target value 0→1. A smoothing
// loop eases the actual camera/FOV interpolation toward that target every
// frame — so the dive PHYSICALLY REACTS to scrolling. The faster the user
// scrolls, the faster they get sucked into the Mac.
let _scrollDiveTarget = 0;
let _scrollDiveSmooth = 0;
let _scrollDiveLoopRunning = false;
function _armScrollDive() {
  if (_scrollListenerAttached) return;
  _scrollListenerAttached = true;
  _scrollDiveTarget = 0;
  _scrollDiveSmooth = 0;

  // Snapshot starting state so the per-frame loop can lerp from it
  _diveStartCamPos      = camera.position.clone();
  _diveStartCtrlsTarget = controls.target.clone();
  _diveStartFov         = camera.fov;
  // Kill DoF immediately so nothing softens during the dive
  if (dof) dof.bokehScale = 0;
  dofBokehTarget = 0.0;

  // Cache the dive target geometry (computed once — same every frame)
  const screenWorld = new THREE.Vector3();
  macScreen.getWorldPosition(screenWorld);
  const endTarget = screenWorld.clone();
  endTarget.z -= 0.03;
  const endFov = 9;

  // Move state forward — flip screenState into 'diving' so the screen
  // canvas paints the streaking-stars effect for the duration.
  function ensureDivingState() {
    if (screenState !== 'diving') {
      screenState = 'diving';
      screenStateStart = performance.now();
    }
  }

  // Slower, more deliberate. Roughly 12-14 wheel ticks to fully arrive,
  // so the user really FEELS each scroll pulling them deeper into the
  // computer. Combined with the gentle smoothing below, every tick is
  // a soft, weighted push — not a punch.
  const STEP_WHEEL = 0.075;   // each wheel tick ≈ 7.5% closer
  const STEP_KEY   = 0.090;
  const onWheel = (e) => {
    if (screenState !== 'awaiting-scroll' && screenState !== 'diving') return;
    e.preventDefault();
    ensureDivingState();
    const dir = Math.sign(e.deltaY) || 1;
    _scrollDiveTarget = Math.min(1, _scrollDiveTarget + STEP_WHEEL * dir);
  };
  const onKey = (e) => {
    if (screenState !== 'awaiting-scroll' && screenState !== 'diving') return;
    if (['ArrowDown', 'PageDown', ' '].includes(e.key)) {
      e.preventDefault();
      ensureDivingState();
      _scrollDiveTarget = Math.min(1, _scrollDiveTarget + STEP_KEY);
    } else if (e.key === 'Escape') {
      exitPortfolioFlow();
    }
  };
  let lastTouchY = null;
  const onTouchStart = (e) => { lastTouchY = e.touches[0]?.clientY ?? null; };
  const onTouchMove = (e) => {
    if (lastTouchY == null) return;
    if (screenState !== 'awaiting-scroll' && screenState !== 'diving') return;
    e.preventDefault();
    ensureDivingState();
    const y = e.touches[0]?.clientY ?? lastTouchY;
    const dy = lastTouchY - y;   // swipe up = positive (diving in)
    lastTouchY = y;
    // Touch: slower mapping too — needs a few swipes to fully arrive.
    _scrollDiveTarget = Math.max(0, Math.min(1, _scrollDiveTarget + dy / 1400));
  };
  window.addEventListener('wheel',      onWheel,      { passive: false });
  window.addEventListener('keydown',    onKey);
  window.addEventListener('touchstart', onTouchStart, { passive: true });
  window.addEventListener('touchmove',  onTouchMove,  { passive: false });

  // Per-frame smoothing + camera apply. Stops the moment progress crosses
  // 1.0 (handoff fires) OR cleanup is called.
  if (!_scrollDiveLoopRunning) {
    _scrollDiveLoopRunning = true;
    let veilFired = false;
    const tick = () => {
      if (!_scrollListenerAttached) {
        _scrollDiveLoopRunning = false;
        return;
      }
      // Slow easing per frame — each scroll glides in over ~25-30 frames
      // (about half a second). Feels like the camera has weight; the
      // user can SEE each scroll carry them a little deeper before the
      // next one lands. Higher = snappier; lower = floatier.
      _scrollDiveSmooth += (_scrollDiveTarget - _scrollDiveSmooth) * 0.045;
      const e = _scrollDiveSmooth * _scrollDiveSmooth * _scrollDiveSmooth;
      camera.position.lerpVectors(_diveStartCamPos, endTarget, e);
      controls.target.lerpVectors(_diveStartCtrlsTarget, screenWorld, e);
      camera.fov = _diveStartFov + (endFov - _diveStartFov) * e;
      camera.updateProjectionMatrix();
      // When the smoothed value is past ~0.93 fire the safety veil + handoff
      if (_scrollDiveSmooth > 0.93 && !veilFired) {
        veilFired = true;
        const v = _ensureDiveVeil();
        v.style.transition = 'opacity 120ms linear';
        requestAnimationFrame(() => { v.style.opacity = '1'; });
        setTimeout(() => {
          if (!_diveHandoffFired) {
            _diveHandoffFired = true;
            _finishDiveHandoff();
          }
        }, 140);
      }
      if (_scrollListenerAttached) requestAnimationFrame(tick);
      else _scrollDiveLoopRunning = false;
    };
    requestAnimationFrame(tick);
  }

  _scrollDiveCleanup = () => {
    _scrollListenerAttached = false;
    window.removeEventListener('wheel',      onWheel);
    window.removeEventListener('keydown',    onKey);
    window.removeEventListener('touchstart', onTouchStart);
    window.removeEventListener('touchmove',  onTouchMove);
  };
}

// A fullscreen black veil that fades in OVER the canvas during the dive.
// Same #000 as the screen content, so as the veil grows opaque the world
// "extends" from the Mac screen content into the whole viewport — no
// visible swap when the overlay mounts (both are black). Reversed on exit.
let _diveVeil = null;
function _ensureDiveVeil() {
  if (_diveVeil) return _diveVeil;
  const v = document.createElement('div');
  v.id = '__dive-veil';
  v.style.cssText = `
    position: fixed; inset: 0; z-index: 4500;
    background: #000; opacity: 0; pointer-events: none;
    transition: opacity 0.18s linear;
  `;
  document.body.appendChild(v);
  _diveVeil = v;
  return v;
}

// (Old auto-tween dive removed — the scroll-driven loop in _armScrollDive
// now owns every aspect of the dive. Kept here as a stub for any stale
// call sites; safe to delete once nothing references it.)
function _startCameraDive() { /* no-op — handled by scroll-driven dive */ }

// Hand off from "looking at the Mac" to "inside the Mac".
function _finishDiveHandoff() {
  if (_portfolioHandle) return;
  _portfolioHandle = enterPortfolio({
    skipIntro: true,   // boot + prompt + dive already played on the 3D screen
    onSpaceArrived: () => { window.__roomRenderPaused = true; },
    onLeaveStart:   () => {
      // Resume room renderer + restore the black veil under the overlay
      // immediately so when the overlay fades, we don't see the live
      // room snap in — we see solid black, which then fades down to
      // reveal the room synced with the reverse-dive.
      window.__roomRenderPaused = false;
      const v = _ensureDiveVeil();
      v.style.transition = 'none';
      v.style.opacity = '1';
      // Start the camera reverse-dive
      _reverseCameraDive();
      // After ~150ms (overlay near-faded), fade the veil OUT in sync
      // with the reverse-dive duration so we see the room emerge as
      // the camera pulls back.
      setTimeout(() => {
        v.style.transition = 'opacity 1100ms ease-out';
        v.style.opacity = '0';
      }, 200);
    },
    onExit: () => {
      _portfolioHandle = null;
      _portfolioFlowActive = false;
      _diveHandoffFired = false;
      window.__roomRenderPaused = false;
      screenState = 'on';
      try { drawScreenMenu(); } catch {}
      if (_diveVeil) {
        const v = _diveVeil;
        setTimeout(() => { try { v.remove(); } catch {} _diveVeil = null; }, 1400);
      }
    },
  });
  // The overlay is now mounting on top of our opaque veil — both are
  // pure black, so the veil can stay where it is. We let the overlay's
  // own fade-in animation do the rest. (No need to remove the veil now
  // — it just sits beneath the overlay until exit.)
}

function _reverseCameraDive() {
  if (!_diveStartCamPos) return;
  const startPos = camera.position.clone();
  const startTgt = controls.target.clone();
  const startFov = camera.fov;
  const endPos = _diveStartCamPos.clone();
  const endTgt = _diveStartCtrlsTarget.clone();
  const endFov = _diveStartFov;
  const REV_MS = 1200;
  const t0 = performance.now();
  function step() {
    const t = Math.min(1, (performance.now() - t0) / REV_MS);
    const e = t * t;   // ease-in (matches overlay's reverse curve)
    camera.position.lerpVectors(startPos, endPos, e);
    controls.target.lerpVectors(startTgt, endTgt, e);
    camera.fov = startFov + (endFov - startFov) * e;
    camera.updateProjectionMatrix();
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// Builder-only shortcut: skip the entire intro and jump straight into
// the menu scene. Lets you iterate on item layout/rotation/scale
// without sitting through boot + scroll-dive every refresh.
function enterPortfolioInstantly() {
  if (_portfolioHandle) return;
  _portfolioFlowActive = true;
  _diveHandoffFired = true;   // pretend the dive already happened
  // Pause the room renderer immediately since we're not viewing it
  window.__roomRenderPaused = true;
  _portfolioHandle = enterPortfolio({
    skipIntro: true,
    instant: true,
    onSpaceArrived: () => { window.__roomRenderPaused = true; },
    onLeaveStart: () => {
      window.__roomRenderPaused = false;
    },
    onExit: () => {
      _portfolioHandle = null;
      _portfolioFlowActive = false;
      _diveHandoffFired = false;
      window.__roomRenderPaused = false;
      // No reverse-dive needed since we never did the forward dive
      try { drawScreenMenu(); } catch {}
    },
  });
}

function exitPortfolioFlow() {
  if (_scrollDiveCleanup)  { _scrollDiveCleanup();  _scrollDiveCleanup = null; }
  if (_pressEnterCleanup)  { _pressEnterCleanup(); }
  if (_portfolioHandle) {
    try { _portfolioHandle.dispose(); } catch {}
    _portfolioHandle = null;
  }
  _portfolioFlowActive = false;
  _diveHandoffFired = false;
  _diveTweenInFlight = false;
  window.__roomRenderPaused = false;
  // Bail BEFORE the dive started (clicking "Use computer" again during
  // boot/real-magic/scroll-prompt): just snap screen back to its menu
  // and return to hero framing — no camera reverse-dive needed because
  // we never moved the camera off COMPUTER_POS.
  if (screenState === 'diving' && _diveStartCamPos) {
    _reverseCameraDive();
  }
  if (screenState !== 'on') {
    screenState = 'on';
    try { drawScreenMenu(); } catch {}
  }
  // Tear down veil if it's still hanging around (defensive)
  if (_diveVeil) {
    try { _diveVeil.remove(); } catch {}
    _diveVeil = null;
  }
  setMode('hero');
}

mountUI({
  onPickScenery: setScenery,
  onSitDown: () => setMode('sit'),
  onLookAround: () => setMode('hero'),
  // Toggle: if overlay is open OR camera is in computer mode, exit cleanly.
  // Otherwise: enter the full portfolio flow (boot lines → scroll prompt →
  // dive into space → Earth + pins).
  onUseComputer: () => {
    if (_portfolioHandle || _currentMode === 'computer') exitPortfolioFlow();
    else enterPortfolioFlow();
  },
  getCurrentMode: () => _currentMode,
  // Head-on view of the bookshelf for easier editing. Camera sits 2 m in
  // front of the alcove face on the -X side, looking at the alcove
  // center. Position is computed from the live bookshelf bbox so it
  // tracks the shelf's current transform (sink slider, Y nudge, etc.).
  onShelfView: () => setMode('shelf'),
  onRightShelfView: () => setMode('rightShelf'),
  // Fly mode toggle now lives in the bottom bar (not the side panel).
  // Recruiter (website) mode: hide Fly button — visitors only click camera
  // presets and orbit, no free-fly editing affordance.
  onFlyToggle: IS_BUILD_MODE
    ? (() => { if (flyState.active) exitFly(); else enterFly(); })
    : undefined,
  getFlyActive: IS_BUILD_MODE ? (() => flyState.active) : undefined,
});

// ---------- Builder shortcut: instant-mount the menu ----------
// One-click jump straight to the portfolio menu (3 items floating in
// space, post-dive state). Skips boot/loading/scroll-prompt/dive. Use
// this while iterating on item layout, rotation, scale, image overlay,
// etc. Disappears in website/recruiter mode.
if (IS_BUILD_MODE) (function mountMenuShortcut() {
  const btn = document.createElement('button');
  btn.id = '__menu-shortcut-btn';
  btn.textContent = '⏩ Jump to menu';
  btn.style.cssText = `
    position: fixed; top: 14px; right: 14px;
    background: rgba(125, 255, 160, 0.18);
    border: 1px solid rgba(125, 255, 160, 0.5);
    color: #fff; cursor: pointer;
    padding: 8px 14px; border-radius: 999px;
    font: 12px system-ui, sans-serif; font-weight: 600;
    letter-spacing: 0.05em; z-index: 50;
    backdrop-filter: blur(8px);
  `;
  btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(125, 255, 160, 0.32)'; });
  btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(125, 255, 160, 0.18)'; });
  btn.addEventListener('click', () => {
    if (_portfolioHandle) {
      // Already in menu — toggle: close it
      exitPortfolioFlow();
    } else {
      enterPortfolioInstantly();
    }
  });
  document.body.appendChild(btn);
})();

// ---------- Use-computer BLUR panel (DISABLED — values locked above) ---
// User dialed in bokehScale=6.0, focusRange=5.7 and asked to remove the
// sliders. Wrapped in `if (false)` so the code is still here if we ever
// want to re-enable for further tweaking.
if (false) (function mountComputerBlurPanel() {
  const wrap = document.createElement('div');
  wrap.style.cssText = `
    position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
    background: rgba(0,0,0,0.65);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 12px;
    padding: 10px 14px; backdrop-filter: blur(12px);
    color: #fff; font: 12px system-ui, sans-serif; z-index: 12;
    display: none; flex-direction: column; gap: 6px;
    min-width: 320px;
  `;
  const t = document.createElement('div');
  t.textContent = '📷 Use-computer blur';
  t.style.cssText = 'font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;opacity:0.9;';
  wrap.appendChild(t);

  function persistBlur() {
    try {
      const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
      stored['computer.blur.bokehScale'] = computerBlur.bokehScale;
      stored['computer.blur.focusRange'] = computerBlur.focusRange;
      localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(stored));
    } catch {}
  }
  function addBlurSlider(key, label, min, max, step) {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;flex-direction:column;gap:1px;font-size:11px;';
    const top = document.createElement('div');
    top.style.cssText = 'display:flex;justify-content:space-between;opacity:0.85;';
    const lab = document.createElement('span'); lab.textContent = label;
    const val = document.createElement('span'); val.textContent = computerBlur[key].toFixed(3);
    top.appendChild(lab); top.appendChild(val);
    row.appendChild(top);
    const sliderRow = document.createElement('div');
    sliderRow.style.cssText = 'display:flex;align-items:center;gap:4px;';
    const sl = document.createElement('input');
    sl.type = 'range'; sl.min = min; sl.max = max; sl.step = step;
    sl.value = computerBlur[key];
    sl.style.cssText = 'flex:1;height:18px;';
    function applyBlur() {
      // bokehScale flows through dofBokehTarget (eased in render loop).
      // focusRange lives on cocMaterial — `dof.focusRange = ...` silently
      // no-ops because that property doesn't exist on DepthOfFieldEffect.
      if (key === 'bokehScale') dofBokehTarget = computerBlur.bokehScale;
      if (key === 'focusRange' && dof && dof.cocMaterial) {
        dof.cocMaterial.focusRange = computerBlur.focusRange;
      }
    }
    function setVal(v) {
      computerBlur[key] = Math.max(min, Math.min(max, v));
      sl.value = computerBlur[key];
      val.textContent = computerBlur[key].toFixed(3);
      applyBlur();
      persistBlur();
    }
    sl.addEventListener('input', (e) => setVal(parseFloat(e.target.value)));
    function mkBtn(txt, delta) {
      const b = document.createElement('button');
      b.textContent = txt;
      b.style.cssText = 'width:22px;height:22px;border-radius:4px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:#fff;cursor:pointer;font-size:10px;line-height:1;padding:0;';
      b.addEventListener('click', () => setVal(computerBlur[key] + delta));
      return b;
    }
    const fine = step;
    const coarse = step * 10;
    sliderRow.appendChild(mkBtn('⏪', -coarse));
    sliderRow.appendChild(mkBtn('◀',  -fine));
    sliderRow.appendChild(sl);
    sliderRow.appendChild(mkBtn('▶',   fine));
    sliderRow.appendChild(mkBtn('⏩',  coarse));
    row.appendChild(sliderRow);
    wrap.appendChild(row);
  }
  addBlurSlider('bokehScale', 'Background blur',     0,  12, 0.1);
  // focusRange is in METERS. 0.1m = razor-thin slab; 6m = nearly whole room sharp.
  addBlurSlider('focusRange', 'Sharp zone (meters)', 0.1, 6.0, 0.05);

  const hint = document.createElement('div');
  hint.textContent = 'Higher blur = dreamier backdrop. Lower sharp-zone = only the screen is crisp.';
  hint.style.cssText = 'font-size:10px;opacity:0.55;margin-top:4px;';
  wrap.appendChild(hint);

  document.body.appendChild(wrap);
  // Visibility tracker — only show while in computer mode
  setInterval(() => {
    wrap.style.display = (_currentMode === 'computer') ? 'flex' : 'none';
  }, 200);
})();

// Locked default backdrop: the Luca video. setScenery would normally apply
// the Rio image (since SCENERY[0].backdrop is rio.jpg), so we force-swap
// to Luca after a short tick to win the race against the image-load
// callback inside swapBackdrop.
setScenery(SCENERY[0]);
const LUCA_SPEC = { type: 'video', src: '/videos/luca.mp4' };
setTimeout(() => {
  if (typeof swapBackdrop === 'function') swapBackdrop(LUCA_SPEC);
}, 250);

// ---------- runtime desk-wood swap ---------------------------------------
// Each entry packs the three Polyhaven maps and a UV repeat. Maps live at
// /textures/wood/<id>/{diff,rough,nor}.jpg.
// =========================================================================
// LOCKED-IN DARK MAHOGANY DESK + LEFT-WALL TEXTURE PICKER + PROP SLIDERS
// =========================================================================
const texLoader = new THREE.TextureLoader();

// ---------- Desk wood: locked-in dark mahogany ---------------------------
// Top is the warm red mahogany the user dialed in; legs/sides use the same
// HD set but with a near-black tint and rougher matte for stained pedestal.
const DESK_WOOD = {
  id: 'dark_wood',
  topTint:   0xff5123, topRough:  0.76, topEnv:  1.50, topRepeat:  [2, 1],
  sideTint:  0x2a1208, sideRough: 0.95, sideEnv: 0.20, sideRepeat: [1.5, 2.5],
};

function loadPbrSet(baseUrl) {
  const load = (url, srgb) => new Promise((resolve, reject) => {
    texLoader.load(url, (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = renderer.capabilities.getMaxAnisotropy();
      resolve(t);
    }, undefined, reject);
  });
  return Promise.all([
    load(`${baseUrl}/diff.jpg`,  true),
    load(`${baseUrl}/rough.jpg`, false),
    load(`${baseUrl}/nor.jpg`,   false),
  ]).then(([diff, rough, nor]) => ({ diff, rough, nor }));
}

function repeatTex(t, [u, v]) {
  const c = t.clone();
  c.wrapS = c.wrapT = THREE.RepeatWrapping;
  c.repeat.set(u, v);
  c.colorSpace = t.colorSpace;
  c.anisotropy = t.anisotropy;
  c.needsUpdate = true;
  return c;
}

function applyLockedDesk() {
  loadPbrSet(`/textures/wood/${DESK_WOOD.id}`).then(({ diff, rough, nor }) => {
    if (!roomRoot) return;
    roomRoot.traverse((o) => {
      if (!o.isMesh) return;
      const mat = o.material;
      if (!mat) return;
      const matName = (mat.name || '').toLowerCase();
      if (!(matName.includes('walnut') || matName.includes('oak'))) return;
      const isTop = matName.includes('top');
      const cfg = isTop
        ? { tint: DESK_WOOD.topTint,  rough: DESK_WOOD.topRough,
            env:  DESK_WOOD.topEnv,   repeat: DESK_WOOD.topRepeat }
        : { tint: DESK_WOOD.sideTint, rough: DESK_WOOD.sideRough,
            env:  DESK_WOOD.sideEnv,  repeat: DESK_WOOD.sideRepeat };
      mat.map          = repeatTex(diff,  cfg.repeat);
      mat.roughnessMap = repeatTex(rough, cfg.repeat);
      mat.normalMap    = repeatTex(nor,   cfg.repeat);
      mat.color.setHex(cfg.tint);
      mat.roughness     = cfg.rough;
      mat.metalness     = 0.0;
      mat.envMapIntensity = cfg.env;
      mat.needsUpdate = true;
    });
  });
}

// ---------- Left wall: HD texture options --------------------------------
// Each entry corresponds to a folder under /textures/wall/<id>/
const WALL_OPTIONS = [
  { id: 'concrete_wall_005', label: 'Smooth concrete',  repeat: [1.5, 1.5], tint: 0xffffff, roughness: 0.9 },
  { id: 'concrete_wall_008', label: 'Concrete (cast)',  repeat: [1.5, 1.5], tint: 0xf5f5f5, roughness: 0.85 },
  { id: 'grey_plaster',      label: 'Grey plaster',     repeat: [1.5, 1.5], tint: 0xffffff, roughness: 0.95 },
  { id: 'concrete_floor_02', label: 'Polished concrete',repeat: [1.5, 1.5], tint: 0xffffff, roughness: 0.55 },
];

// Names of meshes that form the recessed bookshelf alcove shells. They
// share the Wall_Stone material with the rest of the left wall, but we
// give them a CLONE with much lower envMapIntensity so the recess reads
// as darker — light from outside the wall plane doesn't realistically
// reach all the way back into the alcove.
const SHELF_RECESS_MESH_NAMES = new Set([
  'Shelf_BackPanel',
  'Shelf_Side_Front', 'Shelf_Side_Back',
  'Shelf_TopCap',
]);

function applyLeftWall(id) {
  const opt = WALL_OPTIONS.find((w) => w.id === id) || WALL_OPTIONS[0];
  loadPbrSet(`/textures/wall/${opt.id}`).then(({ diff, rough, nor }) => {
    if (!roomRoot) return;
    roomRoot.traverse((o) => {
      if (!o.isMesh) return;
      const mat = o.material;
      if (!mat) return;
      const matName = (mat.name || '').toLowerCase();
      if (!(matName.includes('stone') || matName.includes('wall_left'))) return;
      mat.map          = repeatTex(diff,  opt.repeat);
      mat.roughnessMap = repeatTex(rough, opt.repeat);
      mat.normalMap    = repeatTex(nor,   opt.repeat);
      mat.color.setHex(opt.tint);
      mat.roughness    = opt.roughness;
      mat.metalness    = 0.0;
      mat.envMapIntensity = 0.5;
      mat.clippingPlanes = LEFT_WALL_CLIP_PLANES;
      mat.clipShadows    = true;
      mat.needsUpdate  = true;
    });
    // After the shared Wall_Stone is configured, give each alcove shell its
    // own darkened clone so the recess reads as deeper than the open wall.
    roomRoot.traverse((o) => {
      if (!o.isMesh || !SHELF_RECESS_MESH_NAMES.has(o.name)) return;
      const clone = o.material.clone();
      clone.envMapIntensity = 0.05;
      clone.color = o.material.color.clone().multiplyScalar(0.55);
      clone.needsUpdate = true;
      o.material = clone;
    });
    // Also dim the wooden plank shelves that sit in the recess
    roomRoot.traverse((o) => {
      if (!o.isMesh) return;
      const matName = (o.material?.name || '').toLowerCase();
      if (!matName.includes('redwood')) return;
      o.material.envMapIntensity = 0.08;
      o.material.color.multiplyScalar(0.7);
      o.material.needsUpdate = true;
    });
  });
}

// ---------- Prop position/scale/rotation -------------------------
// Most props have LOCKED transforms (no UI). The user-driven knob is the
// "desk slide" which translates the desk + Mac + lamp + bonsai together.
const PROP_LOCKED = {
  lamp:      { x: 0.38, z: 0.13, scale: 0.84, rotY: -0.43 },
  bonsai:    { x: -0.07, z: 0.05, scale: 1.00, rotY: -0.49 - Math.PI / 2 },
  bookshelf: { z: 0.34 },
};

const propGroups = {
  lamp:      { group: null, baseLocal: null },
  bonsai:    { group: null, baseLocal: null },
  bookshelf: { group: null, baseLocal: null },
};

// Desk + Mac don't get a group — we just track originals and apply offsets.
const deskMeshOrigins = new Map();   // mesh → original position (desk + Mac)
// Mac body meshes specifically — subset of deskMeshOrigins. The computer
// offset (X/Y/Z applied only to the Mac body + screen + camera) operates
// on this set so the user can recenter the computer on the desk surface
// without dragging the desk/lamp/bonsai/monstera along.
const macMeshSet = new Set();
let   deskOffsetX = 0;

function indexProps() {
  if (!roomRoot) return;
  roomRoot.updateWorldMatrix(true, true);

  const buckets = { lamp: [], bonsai: [], bookshelf: [] };
  roomRoot.traverse((o) => {
    if (!o.isMesh) return;
    const n = o.name;
    if (n.startsWith('LuxoImport_'))                                 buckets.lamp.push(o);
    else if (n.startsWith('AutoLeaf_') || n.startsWith('0_10_') ||
             n.startsWith('BonsaiImport_'))                          buckets.bonsai.push(o);
    else if (n.startsWith('Shelf_') || n.startsWith('ShelfBorder_') ||
             n.startsWith('Decor_') || n.startsWith('Wall_Left_'))   buckets.bookshelf.push(o);
  });

  function buildGroup(key, meshes, extras = []) {
    if (!meshes.length) return;
    const box = new THREE.Box3();
    meshes.forEach((m) => box.expandByObject(m));
    const cx = (box.min.x + box.max.x) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    const baseY = box.min.y;
    const group = new THREE.Group();
    group.name = `__propGroup_${key}`;
    group.position.set(cx, baseY, cz);
    roomRoot.add(group);
    // Re-parent each mesh while preserving its world transform
    meshes.forEach((m) => group.attach(m));
    extras.forEach((e) => group.attach(e));
    propGroups[key].group = group;
    propGroups[key].baseLocal = { x: cx, y: baseY, z: cz };
  }

  buildGroup('lamp', buckets.lamp,
             [luxoBulb, luxoSpot, luxoSpot.target, bulbMesh]);
  buildGroup('bonsai', buckets.bonsai);
  buildGroup('bookshelf', buckets.bookshelf);
  // Click-to-edit: registering the bookshelf group as selectable means a
  // raycast against any shelf child opens the contextual editor panel.
  if (propGroups.bookshelf?.group) {
    makeSelectable(propGroups.bookshelf.group, 'Bookshelf');
  }
  // Same treatment for the desk lamp — clicking any LuxoImport mesh now
  // opens the contextual editor with full transform + material sliders
  // (Brightness / Shininess / Reflection / Glow). Bulb + spot are
  // children of the group so they ride along when the user drags it.
  if (propGroups.lamp?.group) {
    makeSelectable(propGroups.lamp.group, 'Luxo lamp');
  }
  // Bonsai trunk — clicking the tree in the 3D scene now opens the
  // contextual editor with transform sliders. The leaves can be
  // extracted into their own group via "🌿 Detach bonsai leaves" in
  // the Sliders menu (then they become a separate selectable too).
  if (propGroups.bonsai?.group) {
    makeSelectable(propGroups.bonsai.group, 'Bonsai');
  }

  // Index desk + mac meshes for the desk-slide
  deskMeshOrigins.clear();
  macMeshSet.clear();
  roomRoot.traverse((o) => {
    if (!o.isMesh) return;
    const n = o.name;
    const isDesk = n.startsWith('Desk_');
    // Mac Plus meshes are bare "Object_4"/"Object_5" — Luxo's "LuxoImport_Object_*"
    // doesn't match startsWith('Object_') because of the prefix.
    const isMac  = n.startsWith('Object_') || n.startsWith('2000_') || n.includes('Macintosh');
    if (isDesk || isMac) {
      deskMeshOrigins.set(o, o.position.clone());
      // Tag Mac meshes so applyDeskOffset can apply the additional
      // computer-only offset to them.
      if (isMac) macMeshSet.add(o);
      // Register every desk/Mac mesh as a "Desk" selectable. Click any of
      // them and the contextual editor opens the desk-system sliders.
      // The click handler suppresses the gizmo for label === 'Desk' since
      // the desk has no single parent group — sliders are the right tool.
      makeSelectable(o, 'Desk');
    }
  });
}

function applyDeskSlide(x) { applyDeskOffset(x, deskOffsetY, deskOffsetZ); }

// Live offsets for the whole desk unit (desk + Mac + lamp + bonsai + camera).
// These are accumulated displacements applied on top of the meshes' frozen
// origins / props' locked values, so a slider can dial each axis freely.
let deskOffsetY = 0;
let deskOffsetZ = 0;
// Computer-only offset: ADDITIONAL displacement applied on top of the desk
// offset, to the Mac body meshes + macScreen + camera framing only. Used to
// re-center the computer on the desk surface without dragging the desk,
// lamp, bonsai, or monstera with it.
let computerOffsetX = 0, computerOffsetY = 0, computerOffsetZ = 0;
// Set to true after the first applyDeskOffset call. Gates the macScreen +
// monstera "follower" translations so the initial bootstrap slide doesn't
// double-count their pre-positioned visual offsets.
let _deskFollowersArmed = false;

function applyDeskOffset(x, y, z) {
  const dx = x - deskOffsetX;
  const dy = y - deskOffsetY;
  const dz = z - deskOffsetZ;
  deskOffsetX = x; deskOffsetY = y; deskOffsetZ = z;

  // Move desk + Mac meshes by raw offset (their parents are stationary).
  // Mac meshes get an ADDITIONAL computerOffset applied on top so the
  // "Computer + view" sliders survive a desk-slide call.
  deskMeshOrigins.forEach((orig, m) => {
    if (macMeshSet.has(m)) {
      m.position.set(
        orig.x + x + computerOffsetX,
        orig.y + y + computerOffsetY,
        orig.z + z + computerOffsetZ,
      );
    } else {
      m.position.set(orig.x + x, orig.y + y, orig.z + z);
    }
  });
  // Lamp + bonsai groups follow the desk in all three axes.
  const l = PROP_LOCKED.lamp;
  updateProp('lamp',   { ...l, x: l.x + x, z: (l.z ?? 0) + z, y: (l.y ?? 0) + y });
  const b = PROP_LOCKED.bonsai;
  updateProp('bonsai', { ...b, x: b.x + x, z: (b.z ?? 0) + z, y: (b.y ?? 0) + y });
  // Bookshelf stays put (it's on the wall, not the desk)

  // ---- Lock-on followers ------------------------------------------------
  // The Mac SCREEN surface (canvas-textured plane) lives in its own
  // top-level group, NOT as a child of the Mac GLB meshes — so without an
  // explicit translate it would stay behind when the desk slides. Same for
  // the monstera plant sitting next to the desk: it's a top-level prop
  // group, not parented to the desk. We shift both by the per-frame delta
  // so they stay glued to the workspace.
  //
  // CAVEAT: macScreen and monsteraGroup were already PRE-POSITIONED at the
  // visually-correct (slid) location by their literal `position.set(...)`
  // calls — so the initial bootstrap applyDeskSlide(-0.220) inside
  // applyAllLocked must NOT translate them, or we'd double-count. We skip
  // them on the very first invocation, then start tracking deltas.
  if (_deskFollowersArmed) {
    if (typeof macScreen !== 'undefined' && macScreen) {
      macScreen.position.x += dx;
      macScreen.position.y += dy;
      macScreen.position.z += dz;
    }
    if (typeof monsteraGroup !== 'undefined' && monsteraGroup) {
      monsteraGroup.position.x += dx;
      monsteraGroup.position.y += dy;
      monsteraGroup.position.z += dz;
    }
  } else {
    _deskFollowersArmed = true;   // skip exactly the bootstrap call
  }

  // Camera framing follows the desk — every camera-mode pos/target and the
  // DOF focus points shift by the same delta on each axis, plus the live
  // camera and controls target move so the desk stays framed.
  HERO_POS.x      += dx;  HERO_POS.y      += dy;  HERO_POS.z      += dz;
  HERO_TARGET.x   += dx;  HERO_TARGET.y   += dy;  HERO_TARGET.z   += dz;
  SIT_POS.x       += dx;  SIT_POS.y       += dy;  SIT_POS.z       += dz;
  SIT_TARGET.x    += dx;  SIT_TARGET.y    += dy;  SIT_TARGET.z    += dz;
  COMPUTER_POS.x  += dx;  COMPUTER_POS.y  += dy;  COMPUTER_POS.z  += dz;
  COMPUTER_TARGET.x += dx; COMPUTER_TARGET.y += dy; COMPUTER_TARGET.z += dz;
  SCREEN_CENTER.x += dx;  SCREEN_CENTER.y += dy;  SCREEN_CENTER.z += dz;
  FOCUS_SCREEN.x  += dx;  FOCUS_SCREEN.y  += dy;  FOCUS_SCREEN.z  += dz;
  FOCUS_DESK.x    += dx;  FOCUS_DESK.y    += dy;  FOCUS_DESK.z    += dz;
  FOCUS_HERO.x    += dx;  FOCUS_HERO.y    += dy;  FOCUS_HERO.z    += dz;
  camera.position.x += dx; camera.position.y += dy; camera.position.z += dz;
  controls.target.x += dx; controls.target.y += dy; controls.target.z += dz;
  controls.update();
}

// Left-Shelf view offset — adjusts the shelf-mode camera framing. Unlike
// the desk/computer offsets, the shelf POS and TARGET are RECOMPUTED
// every time setMode('shelf') runs (from the live bookshelf bbox), so
// these offsets are applied AT THAT MOMENT and ALSO live-shifted while
// the user is currently in shelf mode. Pulled from localStorage directly
// (the PERSISTED cache lives further down the file and would TDZ here).
let shelfViewX = 0, shelfViewY = 0, shelfViewZ = 0;
try {
  const _raw = localStorage.getItem('desk-portfolio:positions:v1');
  if (_raw) {
    const _p = JSON.parse(_raw) || {};
    if (typeof _p['shelfView.x'] === 'number') shelfViewX = _p['shelfView.x'];
    if (typeof _p['shelfView.y'] === 'number') shelfViewY = _p['shelfView.y'];
    if (typeof _p['shelfView.z'] === 'number') shelfViewZ = _p['shelfView.z'];
  }
} catch {}

// ---------- Position-history snapshots --------------------------------
// Auto-saves the entire `desk-portfolio:positions:v1` blob (plus the
// pair-locks + bank-spawned + extraFrames sidecars) to a separate
// timestamped key every 5 minutes. Keeps the most recent N snapshots
// so the user can always roll back if a session goes sideways.
//
// Storage shape:
//   desk-portfolio:snapshots:index    → JSON array of {key, t, itemCount, kind}
//   desk-portfolio:snapshots:<id>     → JSON {positions, pairLocks, bankSpawned, extraFrames, hidden}
// ---------- Shadow-caster trim ----------------------------------------
// 356 castShadow meshes was making every shadow-light's shadow pass push
// hundreds of draws per frame. Most of those are tiny decorative bits
// (figurine accessories, screws, mug handles, etc.) whose shadows are
// indistinguishable from no shadow at this camera distance. Run a few
// seconds after boot so all GLBs have streamed in, then turn off
// castShadow on any mesh whose bbox diagonal is under 8cm.
setTimeout(function trimShadowCasters() {
  let trimmed = 0, kept = 0;
  scene.traverse((o) => {
    if (!o.isMesh || !o.castShadow) return;
    const g = o.geometry;
    if (!g) return;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox;
    if (!bb) return;
    const dx = bb.max.x - bb.min.x;
    const dy = bb.max.y - bb.min.y;
    const dz = bb.max.z - bb.min.z;
    // Apply mesh world scale so we measure the rendered size, not the raw
    // GLB bind-pose size (which can be in any unit).
    o.updateMatrixWorld(true);
    const sx = Math.abs(o.scale.x), sy = Math.abs(o.scale.y), sz = Math.abs(o.scale.z);
    // Walk parents to combine accumulated scale.
    let p = o.parent;
    let accSx = sx, accSy = sy, accSz = sz;
    while (p) { accSx *= Math.abs(p.scale.x); accSy *= Math.abs(p.scale.y); accSz *= Math.abs(p.scale.z); p = p.parent; }
    const wDx = dx * accSx, wDy = dy * accSy, wDz = dz * accSz;
    const diag = Math.sqrt(wDx*wDx + wDy*wDy + wDz*wDz);
    if (diag < 0.08) { o.castShadow = false; trimmed++; }
    else kept++;
  });
  console.log(`[perf] shadow-caster trim: ${trimmed} disabled, ${kept} kept`);
}, 4000);

(function installSnapshotEngine() {
  const INDEX_KEY = 'desk-portfolio:snapshots:index';
  const PREFIX    = 'desk-portfolio:snapshots:';
  // Protected pinned-baseline prefix — entries are NEVER auto-pruned and
  // are listed in the Sliders menu so the user can restore them with a
  // single click. The 2026-05-11 0112am-room-complete baseline (recovered
  // from disk after a Chrome force-shutdown) is seeded by the one-shot
  // recovery block at the top of this file.
  const BASELINE_PREFIX = 'desk-portfolio:baselines:';
  const MAX_SNAPS = 288;           // ~24 hours at 5-min cadence (cap so storage can't grow unbounded)
  const MAX_AGE_MS = 24 * 60 * 60_000;  // 24 hours — anything older gets purged
  const INTERVAL_MS = 5 * 60_000;  // 5 minutes
  const MIN_GAP_MS = 30_000;       // never write two snapshots within 30s

  function readIndex() {
    try { return JSON.parse(localStorage.getItem(INDEX_KEY) || '[]'); }
    catch { return []; }
  }
  function writeIndex(arr) {
    try { localStorage.setItem(INDEX_KEY, JSON.stringify(arr)); } catch {}
  }
  // Drop every snapshot older than MAX_AGE_MS (24h). Returns the
  // surviving entries in chronological order. Caller persists the
  // pruned index. Removes the per-snapshot localStorage payloads too
  // so storage doesn't grow unbounded.
  function pruneOldSnapshots() {
    const cutoff = Date.now() - MAX_AGE_MS;
    const idx = readIndex();
    const fresh = [];
    let pruned = 0;
    for (const e of idx) {
      if (typeof e?.t !== 'number' || e.t < cutoff) {
        if (e?.key) try { localStorage.removeItem(e.key); } catch {}
        pruned++;
      } else {
        fresh.push(e);
      }
    }
    if (pruned > 0) {
      writeIndex(fresh);
      console.log(`[snapshot] pruned ${pruned} entries older than 24h`);
    }
    return fresh;
  }
  function countItems(positions) {
    if (!positions) return 0;
    const seen = new Set();
    for (const k of Object.keys(positions)) {
      const m = k.match(/^item\.(.+?)\.(x|y|z|rotX|rotY|rotZ|scale)$/);
      if (m) seen.add(m[1]);
    }
    return seen.size;
  }
  function takeSnapshot(kind = 'auto') {
    let positions = {};
    try { positions = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}'); } catch {}
    const itemCount = countItems(positions);
    // Skip empty snapshots — happens during boot before anything's loaded.
    if (itemCount === 0 && kind === 'auto') return null;
    // Prune anything older than 24h before writing — keeps storage tight.
    const idx = pruneOldSnapshots();
    const last = idx[idx.length - 1];
    if (kind === 'auto' && last && (Date.now() - last.t) < MIN_GAP_MS) return null;
    const id = `${Date.now()}-${Math.floor(Math.random()*1e6).toString(36)}`;
    const key = PREFIX + id;
    const payload = {
      positions,
      pairLocks:        safeRead('pairLocks.v1'),
      bankSpawned:      safeRead('bank.spawned.v2'),
      extraFrames:      safeRead('extraFrames.v1'),
      hidden:           safeRead('hidden.props.v1'),
      // Custom shelf lights — these were being dropped from the
      // payload before, which is why force-shutdown wiped them.
      shelfLightsExtra: safeRead('shelfLights.extra.v1'),
      // Cmd+V pasted clones — `[{ sourceLabel, newLabel, t }]`. On
      // restore, the boot-time clone-restorer re-materializes each.
      clonedItems:      safeRead('clonedItems.v1'),
    };
    try { localStorage.setItem(key, JSON.stringify(payload)); }
    catch (err) {
      console.warn('[snapshot] localStorage full, dropping oldest', err);
      // Drop oldest to make room, then retry once.
      while (idx.length > 0) {
        const drop = idx.shift();
        try { localStorage.removeItem(drop.key); } catch {}
        try { localStorage.setItem(key, JSON.stringify(payload)); break; }
        catch {}
      }
    }
    idx.push({ key, t: Date.now(), itemCount, kind });
    while (idx.length > MAX_SNAPS) {
      const drop = idx.shift();
      try { localStorage.removeItem(drop.key); } catch {}
    }
    writeIndex(idx);
    return { key, t: Date.now(), itemCount, kind };
  }
  function safeRead(k) {
    try { return localStorage.getItem(k); } catch { return null; }
  }
  function restoreSnapshot(snapKey) {
    let payload = null;
    try { payload = JSON.parse(localStorage.getItem(snapKey) || 'null'); } catch {}
    if (!payload) { alert('Snapshot data missing — index out of sync.'); return false; }
    // Snapshot the CURRENT state first (kind=preRestore) so the user can
    // undo a bad restore.
    takeSnapshot('preRestore');
    try {
      if (payload.positions)              localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(payload.positions));
      if (payload.pairLocks        != null) localStorage.setItem('pairLocks.v1',         payload.pairLocks);
      if (payload.bankSpawned      != null) localStorage.setItem('bank.spawned.v2',      payload.bankSpawned);
      if (payload.extraFrames      != null) localStorage.setItem('extraFrames.v1',       payload.extraFrames);
      if (payload.hidden           != null) localStorage.setItem('hidden.props.v1',      payload.hidden);
      if (payload.shelfLightsExtra != null) localStorage.setItem('shelfLights.extra.v1', payload.shelfLightsExtra);
      if (payload.clonedItems      != null) localStorage.setItem('clonedItems.v1',       payload.clonedItems);
    } catch (err) { console.error('[snapshot] restore write failed', err); return false; }
    location.reload();
    return true;
  }
  function listSnapshots() {
    // Prune stale entries every time the menu reads the list — keeps
    // the visible list capped at the most recent 24h of activity.
    const idx = pruneOldSnapshots();
    return idx.slice().reverse(); // newest first
  }
  // Take one snapshot 30s after boot to capture the just-loaded state,
  // then every 5 minutes after that.
  setTimeout(() => takeSnapshot('boot'), 30_000);
  setInterval(() => takeSnapshot('auto'), INTERVAL_MS);
  // Also snapshot on tab close (best-effort) so the very latest edits
  // survive an abrupt shutdown.
  window.addEventListener('beforeunload', () => { try { takeSnapshot('beforeunload'); } catch {} });
  window.__takeSnapshot    = takeSnapshot;
  window.__listSnapshots   = listSnapshots;
  window.__restoreSnapshot = restoreSnapshot;

  // ---------- Pinned baselines (survive 24h pruning) ----------------
  function listBaselines() {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(BASELINE_PREFIX)) continue;
      const id = k.slice(BASELINE_PREFIX.length);
      const bytes = (localStorage.getItem(k) || '').length;
      out.push({ id, key: k, bytes });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }
  function restoreBaseline(baselineKey) {
    const raw = localStorage.getItem(baselineKey);
    if (!raw) { alert('Baseline missing from storage.'); return false; }
    let payload;
    try { payload = JSON.parse(raw); } catch (err) {
      console.error('[baseline] parse failed', err); return false;
    }
    // Snapshot CURRENT state first so a bad restore can itself be undone.
    takeSnapshot('preBaselineRestore');
    try {
      const w = (k, v) => {
        if (v == null) return;
        localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
      };
      w('desk-portfolio:positions:v1', payload.positions);
      w('pairLocks.v1',                payload.pairLocks);
      w('bank.spawned.v2',             payload.bankSpawned);
      w('extraFrames.v1',              payload.extraFrames);
      w('hidden.props.v1',             payload.hidden);
      w('shelfLights.extra.v1',        payload.shelfLightsExtra);
      w('clonedItems.v1',              payload.clonedItems);
    } catch (err) {
      console.error('[baseline] restore write failed', err);
      return false;
    }
    console.log('[baseline] restored:', baselineKey);
    location.reload();
    return true;
  }
  window.__listBaselines   = listBaselines;
  window.__restoreBaseline = restoreBaseline;
  // One-shot prune on boot to clear any stale entries from earlier sessions.
  pruneOldSnapshots();
  console.log('[snapshot] engine installed — auto-save every 5 min, 24h rolling window, max', MAX_SNAPS);
})();
// ---------- Per-mode horizontal/vertical PAN (hero / sit / computer) --
// The Mac asset's bbox is biased to the right (the mouse sits beside
// it), so the default centered camera framing leaves the Mac body
// offset in the frame. These per-mode pan offsets shift the camera +
// target along the camera's local right/up axes so the Mac body lands
// where you want. Persisted under `view.<mode>.h/v`.
// LOCKED defaults — all three Mac-facing views share the same
// horizontal pan because the Mac asset's bbox is offset by the mouse
// on the right. User tuned 0.056 on Look Around and confirmed it's
// the correct centering for the Mac body across every Mac view.
const _modePan = {
  hero:     { h: 0.056, v: 0 },
  sit:      { h: 0.056, v: 0 },
  computer: { h: 0.056, v: 0 },
};
// Hydrate from localStorage IF saved values exist (overrides the
// locked defaults — useful if you tune again later).
(function _hydrateModePan() {
  try {
    const p = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    for (const m of ['hero', 'sit', 'computer']) {
      if (typeof p[`view.${m}.h`] === 'number') _modePan[m].h = p[`view.${m}.h`];
      if (typeof p[`view.${m}.v`] === 'number') _modePan[m].v = p[`view.${m}.v`];
    }
  } catch {}
})();
// Compute the camera-local pan delta for a (basePos, baseTarget) pair.
// right = up × forward (so positive H = right of view in standard
// right-handed orientation).
function _modePanDelta(basePos, baseTarget, pan) {
  const forward = new THREE.Vector3().subVectors(baseTarget, basePos).normalize();
  const worldUp = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(worldUp, forward).normalize();
  const up = new THREE.Vector3().crossVectors(forward, right).normalize();
  return new THREE.Vector3()
    .addScaledVector(right, pan.h)
    .addScaledVector(up,    pan.v);
}
function applyModePan(mode, h, v) {
  const pan = _modePan[mode];
  if (!pan) return;
  const dh = h - pan.h;
  const dv = v - pan.v;
  pan.h = h; pan.v = v;
  // Persist immediately
  try {
    const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    cur[`view.${mode}.h`] = pan.h;
    cur[`view.${mode}.v`] = pan.v;
    localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
  } catch {}
  // Live-update if this is the mode the camera is currently in.
  if (_currentMode === mode) {
    const forward = new THREE.Vector3().subVectors(controls.target, camera.position).normalize();
    const worldUp = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(worldUp, forward).normalize();
    const up = new THREE.Vector3().crossVectors(forward, right).normalize();
    const delta = new THREE.Vector3()
      .addScaledVector(right, dh)
      .addScaledVector(up,    dv);
    camera.position.add(delta);
    controls.target.add(delta);
    controls.update();
  }
}

function applyShelfView(x, y, z) {
  const dx = x - shelfViewX;
  const dy = y - shelfViewY;
  const dz = z - shelfViewZ;
  shelfViewX = x; shelfViewY = y; shelfViewZ = z;
  // While in either shelf view (LEFT or RIGHT), shift the live
  // camera+target by the delta so the user sees the framing change as
  // they drag the slider. The offsets are CAMERA-LOCAL (zoom / up /
  // right-of-view), so we convert them to world-space using the
  // camera's actual look frame — this makes positive Z = "shelf
  // appears LEFT in frame" work the same way on both shelves.
  if (_currentMode === 'shelf' || _currentMode === 'rightShelf') {
    const forward = new THREE.Vector3()
      .subVectors(controls.target, camera.position).normalize();
    const right = new THREE.Vector3()
      .crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3()
      .crossVectors(right, forward).normalize();
    const delta = new THREE.Vector3()
      .addScaledVector(forward, dx)
      .addScaledVector(up,      dy)
      .addScaledVector(right,   dz);
    camera.position.add(delta);
    controls.target.add(delta);
    controls.update();
  }
}

// Use-Computer view offset — adjusts COMPUTER_POS / COMPUTER_TARGET only,
// so the camera framing in "Use computer" mode can be nudged left/right/
// up/down/forward/back independent of every other view (Hero, Sit) and
// independent of the desk + computer offsets above. If the camera is
// currently in computer mode, the live camera + controls.target also
// shift so the user sees the change as they slide.
let useComputerViewX = 0, useComputerViewY = 0, useComputerViewZ = 0;
function applyUseComputerView(x, y, z) {
  const dx = x - useComputerViewX;
  const dy = y - useComputerViewY;
  const dz = z - useComputerViewZ;
  useComputerViewX = x; useComputerViewY = y; useComputerViewZ = z;
  COMPUTER_POS.x    += dx; COMPUTER_POS.y    += dy; COMPUTER_POS.z    += dz;
  COMPUTER_TARGET.x += dx; COMPUTER_TARGET.y += dy; COMPUTER_TARGET.z += dz;
  if (_currentMode === 'computer') {
    camera.position.x += dx; camera.position.y += dy; camera.position.z += dz;
    controls.target.x += dx; controls.target.y += dy; controls.target.z += dz;
    controls.update();
  }
}

// Move ONLY the computer (Mac body + Mac screen surface + camera framing)
// by an additional offset on top of whatever the desk offset is. Lets the
// user re-center the computer on the desk without dragging the desk
// itself, the lamp, the bonsai, or the monstera.
function applyComputerOffset(x, y, z) {
  const dx = x - computerOffsetX;
  const dy = y - computerOffsetY;
  const dz = z - computerOffsetZ;
  computerOffsetX = x; computerOffsetY = y; computerOffsetZ = z;

  // Mac body meshes — their absolute positions already include the desk
  // offset, so an incremental delta is enough.
  deskMeshOrigins.forEach((orig, m) => {
    if (!macMeshSet.has(m)) return;
    m.position.x += dx;
    m.position.y += dy;
    m.position.z += dz;
  });
  // Mac screen surface (top-level group, follower-style)
  if (typeof macScreen !== 'undefined' && macScreen) {
    macScreen.position.x += dx;
    macScreen.position.y += dy;
    macScreen.position.z += dz;
  }
  // Camera framing — every mode + DOF focus + live position so the view
  // tracks the computer.
  HERO_POS.x      += dx;  HERO_POS.y      += dy;  HERO_POS.z      += dz;
  HERO_TARGET.x   += dx;  HERO_TARGET.y   += dy;  HERO_TARGET.z   += dz;
  SIT_POS.x       += dx;  SIT_POS.y       += dy;  SIT_POS.z       += dz;
  SIT_TARGET.x    += dx;  SIT_TARGET.y    += dy;  SIT_TARGET.z    += dz;
  COMPUTER_POS.x  += dx;  COMPUTER_POS.y  += dy;  COMPUTER_POS.z  += dz;
  COMPUTER_TARGET.x += dx; COMPUTER_TARGET.y += dy; COMPUTER_TARGET.z += dz;
  SCREEN_CENTER.x += dx;  SCREEN_CENTER.y += dy;  SCREEN_CENTER.z += dz;
  FOCUS_SCREEN.x  += dx;  FOCUS_SCREEN.y  += dy;  FOCUS_SCREEN.z  += dz;
  FOCUS_DESK.x    += dx;  FOCUS_DESK.y    += dy;  FOCUS_DESK.z    += dz;
  FOCUS_HERO.x    += dx;  FOCUS_HERO.y    += dy;  FOCUS_HERO.z    += dz;
  camera.position.x += dx; camera.position.y += dy; camera.position.z += dz;
  controls.target.x += dx; controls.target.y += dy; controls.target.z += dz;
  controls.update();
}

function updateProp(key, { x = 0, y = 0, z = 0, scale = 1, rotY = 0 } = {}) {
  const g = propGroups[key];
  if (!g || !g.group) return;
  g.group.position.set(g.baseLocal.x + x, g.baseLocal.y + y, g.baseLocal.z + z);
  g.group.scale.setScalar(scale);
  g.group.rotation.y = rotY;
}
window.__updateProp = updateProp;
window.__applyLeftWall = applyLeftWall;
window.__applyDeskSlide = applyDeskSlide;

// ---------- Lights API for the control panel ---------------------------
// Direct lights + the HDRI environment (which drives all PBR indirect
// illumination via scene.environment).
const LIGHTS = {
  bulbPoint:   { obj: luxoBulb,   base: luxoBulb.intensity,   enabled: true },
  bulbSpot:    { obj: luxoSpot,   base: luxoSpot.intensity,   enabled: true },
  window:      { obj: windowLight,base: windowLight.intensity,enabled: true },
};
let envEnabled = true;
function setLightEnabled(key, enabled) {
  if (key === 'env') {
    envEnabled = enabled;
    scene.environment = enabled ? envTexture : null;
    return;
  }
  const l = LIGHTS[key];
  if (!l) return;
  l.enabled = enabled;
  l.obj.intensity = enabled ? l.base : 0;
}
let luxoBrightnessMult = 1.0;
function applyLuxoLightTuning() {
  // Combined: brightness * enabled. Color set separately via warmth.
  if (LIGHTS.bulbSpot.enabled) LIGHTS.bulbSpot.obj.intensity  = LIGHTS.bulbSpot.base  * luxoBrightnessMult;
  if (LIGHTS.bulbPoint.enabled) LIGHTS.bulbPoint.obj.intensity = LIGHTS.bulbPoint.base * luxoBrightnessMult;
}
function setLuxoBrightness(mult) {
  luxoBrightnessMult = mult;
  applyLuxoLightTuning();
}

// Warmth: 0=cool/neutral white-warm, 1=saturated tungsten orange. We lerp
// the lamp color between the two endpoints and apply to spot + glow + bulb mesh.
const WARMTH_COOL = new THREE.Color(0xffeacc);
const WARMTH_WARM = new THREE.Color(0xff7d3c);
function setLuxoWarmth(t) {
  const c = WARMTH_COOL.clone().lerp(WARMTH_WARM, Math.max(0, Math.min(1, t)));
  luxoSpot.color.copy(c);
  luxoBulb.color.copy(c);
  if (bulbMesh && bulbMesh.material) {
    bulbMesh.material.color.copy(c).lerp(new THREE.Color(0xffffff), 0.4);
    bulbMesh.material.needsUpdate = true;
  }
}

// HDRI warmth — Three.js can't directly tint a PMREM env map, so we add
// a warm-tinted HemisphereLight that biases indirect illumination toward
// orange. Intensity 0 = pure HDRI, higher = more orange wrap-light.
const envWarmFill = new THREE.HemisphereLight(0xff8a40, 0x180a04, 0);
scene.add(envWarmFill);
function setEnvWarmth(t) {
  envWarmFill.intensity = t;
}

// HDRI brightness — global multiplier for the indirect HDRI contribution.
// Three.js r155+ scene.environmentIntensity scales it cleanly.
function setEnvBrightness(v) {
  scene.environmentIntensity = v;
}

// Per-mesh envMap kill — toggle the HDRI off ONLY for the desk + Mac + lamp
// + bonsai materials, leaving walls/wider scene unaffected. Used to A/B
// the env's contribution to the focal cluster.
const _envSavedIntensity = new Map();        // material → original envMapIntensity
function isDeskCluster(name) {
  return name.startsWith('Desk_') ||
         name.startsWith('Object_') ||
         name.startsWith('2000_') || name.includes('Macintosh') ||
         name.startsWith('LuxoImport_') ||
         name.startsWith('BonsaiImport_') || name.startsWith('AutoLeaf_') ||
         name.startsWith('0_10_');
}
function setHdrAffectsCluster(enabled) {
  if (!roomRoot) return;
  roomRoot.traverse((o) => {
    if (!o.isMesh || !isDeskCluster(o.name)) return;
    const mat = o.material;
    if (!mat || typeof mat.envMapIntensity !== 'number') return;
    if (!enabled) {
      if (!_envSavedIntensity.has(mat)) _envSavedIntensity.set(mat, mat.envMapIntensity);
      mat.envMapIntensity = 0;
    } else {
      if (_envSavedIntensity.has(mat)) mat.envMapIntensity = _envSavedIntensity.get(mat);
    }
    mat.needsUpdate = true;
  });
}

window.__setLightEnabled = setLightEnabled;
window.__setLuxoBrightness = setLuxoBrightness;
window.__setLuxoWarmth = setLuxoWarmth;
window.__setEnvWarmth = setEnvWarmth;
window.__setEnvBrightness = setEnvBrightness;
window.__setHdrAffectsCluster = setHdrAffectsCluster;

// Apply the locked desk + index props once the room GLB loads. The loader
// callback already fires when the GLB is ready — we hook in via a tiny
// poll because the load is async (cheaper than refactoring the loader).
const _propIndexInterval = setInterval(() => {
  if (!roomRoot) return;
  clearInterval(_propIndexInterval);
  applyLockedDesk();
  applyLeftWall('concrete_wall_005');
  indexProps();
  // Push the locked-in transforms into each prop group
  updateProp('lamp',      PROP_LOCKED.lamp);
  updateProp('bonsai',    PROP_LOCKED.bonsai);
  updateProp('bookshelf', PROP_LOCKED.bookshelf);
  // Locked desk slide
  applyDeskSlide(-0.220);

  // Auto-detach DISABLED at boot — the leaf-detection heuristic is
  // imprecise enough that auto-running on every load risks grabbing
  // desk wood / other warm-toned meshes as "leaves" and yanking them
  // into a fake leaf group. The user has to click the Sliders →
  // 🌿 Detach bonsai leaves button explicitly each session. We also
  // proactively clear any stale flag so a reload always starts clean.
  try { localStorage.removeItem(BONSAI_LEAVES_FLAG_KEY); } catch {}

  // Hide ONLY the wall around the alcove. Shelf interior + strip lights stay.
  roomRoot.traverse((o) => {
    if (!o.isMesh) return;
    if (/^Wall_Left_/.test(o.name)) o.visible = false;
  });
  // Locked light tuning
  setLuxoBrightness(1.00);
  setLuxoWarmth(1.00);
  setEnvWarmth(1.75);
  setEnvBrightness(0.51);
  // Locked bookshelf slide + strip-light placement + warmth/brightness.
  // Bookshelf reaches its FINAL world position here.
  setBookshelfSlide(0.430);
  // Apply per-side persisted offsets if the user has saved any (Left
  // shelf card writes `leftStripOffset.*`, Right shelf card writes
  // `rightStripOffset.*`). Falls back to legacy `stripOffset.*` keys
  // and finally to the locked defaults (0.110 / 0 / 0.060).
  {
    const _ls0 = (() => { try { return JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}'); } catch { return {}; } })();
    const _pick = (perSideKey, legacyKey, def) =>
      typeof _ls0[perSideKey] === 'number' ? _ls0[perSideKey]
      : typeof _ls0[legacyKey]  === 'number' ? _ls0[legacyKey]
      : def;
    setLeftStripOffsetX(_pick('leftStripOffset.x',  'stripOffset.x', 0.110));
    setLeftStripOffsetY(_pick('leftStripOffset.y',  'stripOffset.y', 0));
    setLeftStripOffsetZ(_pick('leftStripOffset.z',  'stripOffset.z', 0.060));
    setRightStripOffsetX(_pick('rightStripOffset.x', 'stripOffset.x', 0.110));
    setRightStripOffsetY(_pick('rightStripOffset.y', 'stripOffset.y', 0));
    setRightStripOffsetZ(_pick('rightStripOffset.z', 'stripOffset.z', 0.060));
    setLeftStripWarmth (typeof _ls0['leftStrip.warmth']     === 'number' ? _ls0['leftStrip.warmth']     : 1.000);
    setRightStripWarmth(typeof _ls0['rightStrip.warmth']    === 'number' ? _ls0['rightStrip.warmth']    : 1.000);
    setLeftStripBrightness (typeof _ls0['leftStrip.brightness']  === 'number' ? _ls0['leftStrip.brightness']  : 0.930);
    setRightStripBrightness(typeof _ls0['rightStrip.brightness'] === 'number' ? _ls0['rightStrip.brightness'] : 0.930);
  }

  // ---------- Bundle the bookshelf "office unit" ------------------------
  // Re-parent shelf-resident props AFTER setBookshelfSlide so the bookshelf
  // is at its final position when attach() captures world coords. Otherwise
  // the props get yanked an extra 0.43m when setBookshelfSlide moves the
  // bookshelf afterward.
  const _shelfChildren = [
    typeof grootGroup   !== 'undefined' ? grootGroup   : null,
    typeof booksGroup   !== 'undefined' ? booksGroup   : null,
    typeof chestGroup   !== 'undefined' ? chestGroup   : null,
    typeof pothosGroup  !== 'undefined' ? pothosGroup  : null,
    typeof foliageGroup !== 'undefined' ? foliageGroup : null,
    typeof swordGroup   !== 'undefined' ? swordGroup   : null,
    typeof stand1       !== 'undefined' ? stand1       : null,
    typeof stand2       !== 'undefined' ? stand2       : null,
    typeof stand3       !== 'undefined' ? stand3       : null,
  ];
  if (propGroups.bookshelf?.group) {
    // Persist a parent flag for each bookshelf-attached prop so loadProp
    // re-parents BEFORE applying persisted coords on the NEXT reload.
    // Without this, drag-end saves bookshelf-LOCAL coords (group.position
    // is local once a prop is bookshelf-attached) but reload applies them
    // to a scene-rooted group as scene-space — chest ends up off the
    // shelf.
    let _persistedSnapshot;
    try { _persistedSnapshot = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}'); }
    catch { _persistedSnapshot = {}; }
    let _parentsMap = _persistedSnapshot['shelfSpacing.parents'];
    if (!_parentsMap || typeof _parentsMap !== 'object') _parentsMap = {};
    let _parentsChanged = false;
    _shelfChildren.forEach((g) => {
      if (!g) return;
      const sel = SELECTABLE.find((s) => s.group === g);
      // Respect user-driven unparenting: if the parents map explicitly
      // says 'scene' for this label, leave it scene-rooted. Otherwise the
      // hardcoded shelf-bundle attach would yank the user's unparented
      // item back onto the shelf on every reload.
      if (sel?.label && _parentsMap[sel.label] === 'scene') return;
      propGroups.bookshelf.group.attach(g);
      if (sel?.label && _parentsMap[sel.label] !== 'bookshelf') {
        _parentsMap[sel.label] = 'bookshelf';
        _parentsChanged = true;
      }
    });
    if (_parentsChanged) {
      _persistedSnapshot['shelfSpacing.parents'] = _parentsMap;
      try { localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(_persistedSnapshot)); } catch {}
    }
    if (typeof stripLights !== 'undefined') {
      stripLights.forEach((l) => propGroups.bookshelf.group.attach(l));
      // attach() preserved world positions and converted them to
      // bookshelf-local coords. Now re-run updateStripPositions() so
      // the lights use the LIVE per-side offsets in the bookshelf's
      // coord space — otherwise the local positions captured by
      // attach() (which baked in the bookshelf's transform) make the
      // X/Y/Z sliders look like they're doing nothing.
      if (typeof updateStripPositions === 'function') updateStripPositions();
    }
    // Build user-added extra shelf lights now that the left bookshelf
    // group exists (right shelf builds later when the user views it).
    if (typeof window.__rebuildAllExtraLights === 'function') {
      window.__rebuildAllExtraLights();
    }
  }
  // Re-parent boot under the bookshelf BEFORE applyBoot, so applyBoot's
  // values are interpreted as LOCAL coords relative to the bookshelf — the
  // gizmo HUD was reading local coords when you captured the values.
  if (propGroups.bookshelf?.group && bootGroup) {
    propGroups.bookshelf.group.attach(bootGroup);
  }
  applyBoot();

  // ---------- LOCKED-IN user-confirmed final placements -----------------
  // Override the legacy slide/base values with the position the user dialed
  // in via the live sliders. These run LAST so any earlier setup (children
  // attached to bookshelf, prop locked transforms, etc.) is captured before
  // we move the units to their final spots.
  // Shelf assembly: x=3.481 y=0 z=-1.620 rotY=0
  updateProp('bookshelf', { x: 3.481, y: 0, z: -1.620 });
  if (propGroups.bookshelf?.group) propGroups.bookshelf.group.rotation.y = 0;
  // Mirror the bookshelf to the right side of the room (mirrored about
  // the X = 0 plane). Clones the wood + strip-light geometry, strips out
  // user-attached props, flips X via scale.x = -1, sets material side =
  // DoubleSide so the inverted winding renders correctly. Runs once.
  buildMirroredBookshelf();
  // Re-apply per-side warmth + brightness AFTER the mirror exists. The
  // initial setLeftStripWarmth / setRightStripWarmth calls above ran
  // before `_mirroredBookshelf` was built, so the right-side lights
  // never received their persisted values. Re-running per-side here uses
  // the cached values straight from each side's own cache, never the
  // shared `_stripWarmthCache`, so left and right keep independent state.
  setLeftStripWarmth (_leftStripWarmthCache);
  setRightStripWarmth(_rightStripWarmthCache);
  setLeftStripBrightness (_leftStripBrightnessCache);
  setRightStripBrightness(_rightStripBrightnessCache);
  console.log(`[strips] post-mirror sync — L warmth=${_leftStripWarmthCache.toFixed(2)} brightness=${_leftStripBrightnessCache.toFixed(2)} | R warmth=${_rightStripWarmthCache.toFixed(2)} brightness=${_rightStripBrightnessCache.toFixed(2)}`);
  // Re-apply persisted per-shelf vertical crop (top/bottom thresholds).
  // Both shelves now exist, so we can safely traverse and crop them.
  if (typeof window.__applyShelfCropAll === 'function') window.__applyShelfCropAll();
  // Desk + view: x=0.487 y=-0.001 z=-4.885 — second call after the bootstrap
  // applyDeskSlide so the macScreen + monstera followers (now armed) move
  // by the delta into their final slid position.
  applyDeskOffset(0.487, -0.001, -4.885);

  // ---------- AUTO-PERSISTED OVERRIDES ---------------------------------
  // Anything saved to localStorage wins over the hardcoded locked values.
  // Module-level appliers (these run independent of any UI panel — that
  // was what broke when the side panels were stripped) re-apply persisted
  // shelf / desk / computer / use-computer-view state. Then we run any
  // panel-registered appliers (currently just the Venator look one).
  setTimeout(() => {
    // Shelf — only override if user has saved values; otherwise keep the
    // applyAllLocked default (3.481, 0, -1.620, rotY=0).
    const _stored = loadPersisted();
    const bg = propGroups.bookshelf?.group;
    if (bg) {
      let overrode = false;
      if (typeof _stored['shelf.x'] === 'number') { bg.position.x = _stored['shelf.x']; overrode = true; }
      if (typeof _stored['shelf.y'] === 'number') { bg.position.y = _stored['shelf.y']; overrode = true; }
      if (typeof _stored['shelf.z'] === 'number') { bg.position.z = _stored['shelf.z']; overrode = true; }
      if (typeof _stored['shelf.rotY'] === 'number') { bg.rotation.y = _stored['shelf.rotY']; overrode = true; }
      if (overrode) console.log('[persist] applied shelf override', bg.position);
    }
    // Desk — applyDeskOffset accumulators
    {
      const dx = _stored['desk.x'], dy = _stored['desk.y'], dz = _stored['desk.z'];
      if (typeof dx === 'number' || typeof dy === 'number' || typeof dz === 'number') {
        applyDeskOffset(
          typeof dx === 'number' ? dx : deskOffsetX,
          typeof dy === 'number' ? dy : deskOffsetY,
          typeof dz === 'number' ? dz : deskOffsetZ,
        );
        console.log('[persist] applied desk override');
      }
    }
    // Computer offset
    {
      const cx = _stored['computer.x'], cy = _stored['computer.y'], cz = _stored['computer.z'];
      if ((typeof cx === 'number' || typeof cy === 'number' || typeof cz === 'number') && typeof applyComputerOffset === 'function') {
        applyComputerOffset(
          typeof cx === 'number' ? cx : computerOffsetX,
          typeof cy === 'number' ? cy : computerOffsetY,
          typeof cz === 'number' ? cz : computerOffsetZ,
        );
      }
    }
    // Use-Computer view offset (camera framing only)
    {
      const ux = _stored['ucv.x'], uy = _stored['ucv.y'], uz = _stored['ucv.z'];
      if (typeof ux === 'number' || typeof uy === 'number' || typeof uz === 'number') {
        applyUseComputerView(
          typeof ux === 'number' ? ux : useComputerViewX,
          typeof uy === 'number' ? uy : useComputerViewY,
          typeof uz === 'number' ? uz : useComputerViewZ,
        );
      }
    }
    // Run any other appliers panels registered (Venator look, etc.)
    for (const fn of PERSISTED_APPLIERS) {
      try { fn(); } catch (err) { console.warn('[persist] applier failed', err); }
    }
    console.log(`[persist] init complete, ${PERSISTED_APPLIERS.length} extra appliers ran`);
  }, 0);
}, 120);

// ---------- Shelf strip lights ------------------------------------------
// One small warm point light just below each upper shelf divider, positioned
// at the FRONT-underside of the shelf so it washes the alcove back panel
// (Blender x=+1.30..+1.60 alcove; Three.js x same). Compartment Y center in
// world Z = -1.04 + bookshelf-shift 0.34 = 1.38.
//
// Y heights are the shelf TOPS (Blender z, same in Three.js). The light
// sits ~12mm below each so it lights the compartment below.
const SHELF_STRIPS = [
  { name: 'top',     y: 2.78 - 0.012 },  // illuminates Small 4
  { name: 'small_3', y: 2.42 - 0.012 },  // illuminates Small 3
  { name: 'small_2', y: 2.07 - 0.012 },  // illuminates Small 2
  { name: 'small_1', y: 1.71 - 0.012 },  // illuminates Small 1
  { name: 'big_top', y: 1.35 - 0.012 },  // illuminates Big bottom
];
const STRIP_BACK_X = 1.34;     // just inside the alcove room-face
const STRIP_Z      = 1.38;     // alcove center in world Z

const stripLights = SHELF_STRIPS.map((s) => {
  const pl = new THREE.PointLight(0xffb070, 1.2, 0.6, 2.0);
  pl.userData.baseY = s.y;
  pl.position.set(STRIP_BACK_X, s.y, STRIP_Z);
  pl.castShadow = false;
  scene.add(pl);
  return pl;
});

// Track shelf-pos offset + strip-XY offset so the strips can follow the
// bookshelf slide AND be nudged independently along the horizontal plane.
const BOOKSHELF_BASE_Z = 0.34;
let bookshelfDelta  = 0;          // current Z shift on top of base
// PER-SIDE offsets — each shelf has its own independent X/Y/Z nudge so
// the Left card only affects LEFT lights and Right card only affects
// RIGHT lights. Legacy `stripOffset.*` keys map onto leftStripOffset on
// boot so existing persistence doesn't get lost.
let leftStripOffsetX  = 0, leftStripOffsetY  = 0, leftStripOffsetZ  = 0;
let rightStripOffsetX = 0, rightStripOffsetY = 0, rightStripOffsetZ = 0;
function updateStripPositions() {
  // Left shelf — the 5 main `stripLights` are children of __propGroup_bookshelf.
  stripLights.forEach((l) => {
    l.position.set(
      STRIP_BACK_X + leftStripOffsetX,
      l.userData.baseY + leftStripOffsetY,
      STRIP_Z + bookshelfDelta + leftStripOffsetZ
    );
  });
  // Right shelf mirror lights — each has a captured base position in
  // its userData; apply the RIGHT side's independent offsets.
  try {
    const m = (typeof _mirroredBookshelf !== 'undefined') ? _mirroredBookshelf : null;
    const list = m?.userData?.__rightShelfLights;
    if (Array.isArray(list)) {
      for (const l of list) {
        const bx = l.userData?._mirrorBaseX;
        const by = l.userData?._mirrorBaseY;
        const bz = l.userData?._mirrorBaseZ;
        if (typeof bx !== 'number') continue;
        l.position.set(bx + rightStripOffsetX, by + rightStripOffsetY, bz + rightStripOffsetZ);
      }
    }
  } catch {}
}

function setBookshelfSlide(v) {
  bookshelfDelta = v;
  updateProp('bookshelf', { z: BOOKSHELF_BASE_Z + v });
  updateStripPositions();
}
// Per-side offset setters.
function setLeftStripOffsetX(v)  { leftStripOffsetX  = v; updateStripPositions(); }
function setLeftStripOffsetY(v)  { leftStripOffsetY  = v; updateStripPositions(); }
function setLeftStripOffsetZ(v)  { leftStripOffsetZ  = v; updateStripPositions(); }
function setRightStripOffsetX(v) { rightStripOffsetX = v; updateStripPositions(); }
function setRightStripOffsetY(v) { rightStripOffsetY = v; updateStripPositions(); }
function setRightStripOffsetZ(v) { rightStripOffsetZ = v; updateStripPositions(); }
// Back-compat: legacy combined setters bump BOTH sides at once.
function setStripOffsetX(v) { leftStripOffsetX = v; rightStripOffsetX = v; updateStripPositions(); }
function setStripOffsetY(v) { leftStripOffsetY = v; rightStripOffsetY = v; updateStripPositions(); }
function setStripOffsetZ(v) { leftStripOffsetZ = v; rightStripOffsetZ = v; updateStripPositions(); }

const STRIP_COOL = new THREE.Color(0xffeacc);
const STRIP_WARM = new THREE.Color(0xff7d3c);
// Per-side warmth + brightness caches.
let _leftStripWarmthCache  = 0.0, _leftStripBrightnessCache  = 1.0;
let _rightStripWarmthCache = 0.0, _rightStripBrightnessCache = 1.0;
// Back-compat fields kept so existing readers don't crash.
let _stripWarmthCache = 0.0, _stripBrightnessCache = 1.0;
function _leftShelfLights() {
  const out = stripLights.slice();
  // Include extra LEFT lights too.
  try {
    if (typeof _extraShelfLights !== 'undefined') {
      for (const e of _extraShelfLights) {
        if (e.entry?.side === 'left' && e.light) out.push(e.light);
      }
    }
  } catch {}
  return out;
}
function _rightShelfLights() {
  const out = [];
  try {
    if (_mirroredBookshelf?.userData?.__rightShelfLights) {
      out.push(..._mirroredBookshelf.userData.__rightShelfLights);
    }
    if (typeof _extraShelfLights !== 'undefined') {
      for (const e of _extraShelfLights) {
        if (e.entry?.side === 'right' && e.light) out.push(e.light);
      }
    }
  } catch {}
  return out;
}
function _allShelfLights() {
  // Back-compat aggregate.
  return [..._leftShelfLights(), ..._rightShelfLights()];
}
function setLeftStripWarmth(t) {
  _leftStripWarmthCache = t;
  _stripWarmthCache = t;   // keep legacy cache in sync (used by mirror sync)
  const c = STRIP_COOL.clone().lerp(STRIP_WARM, Math.max(0, Math.min(1, t)));
  _leftShelfLights().forEach((l) => l.color.copy(c));
}
function setRightStripWarmth(t) {
  _rightStripWarmthCache = t;
  // Mirror-sync inside buildMirroredBookshelf reads `_stripWarmthCache` —
  // if we don't also bump it here, that sync overwrites whatever the
  // user persisted for the right side with the left side's value.
  _stripWarmthCache = t;
  const c = STRIP_COOL.clone().lerp(STRIP_WARM, Math.max(0, Math.min(1, t)));
  _rightShelfLights().forEach((l) => l.color.copy(c));
}
function setLeftStripBrightness(v) {
  _leftStripBrightnessCache = v;
  _stripBrightnessCache = v;
  _leftShelfLights().forEach((l) => { l.intensity = v; });
}
function setRightStripBrightness(v) {
  _rightStripBrightnessCache = v;
  _stripBrightnessCache = v;
  _rightShelfLights().forEach((l) => { l.intensity = v; });
}
// Legacy combined setters (still used by boot) — bump both sides.
function setStripWarmth(t) {
  setLeftStripWarmth(t);
  setRightStripWarmth(t);
}
function setStripBrightness(v) {
  setLeftStripBrightness(v);
  setRightStripBrightness(v);
}
window.__getStripWarmthCache = () => _stripWarmthCache;
window.__getStripBrightnessCache = () => _stripBrightnessCache;
window.__setStripWarmth     = setStripWarmth;
window.__setStripBrightness = setStripBrightness;
// Per-side getters + setters (the per-shelf cards use these so each
// card affects only its own shelf's lights — left controls don't bleed
// into the right and vice versa).
window.__setLeftStripWarmth     = setLeftStripWarmth;
window.__setLeftStripBrightness = setLeftStripBrightness;
window.__setRightStripWarmth    = setRightStripWarmth;
window.__setRightStripBrightness = setRightStripBrightness;
window.__getLeftStripWarmth     = () => _leftStripWarmthCache;
window.__getLeftStripBrightness = () => _leftStripBrightnessCache;
window.__getRightStripWarmth    = () => _rightStripWarmthCache;
window.__getRightStripBrightness = () => _rightStripBrightnessCache;
window.__setLeftStripOffsetX  = setLeftStripOffsetX;
window.__setLeftStripOffsetY  = setLeftStripOffsetY;
window.__setLeftStripOffsetZ  = setLeftStripOffsetZ;
window.__setRightStripOffsetX = setRightStripOffsetX;
window.__setRightStripOffsetY = setRightStripOffsetY;
window.__setRightStripOffsetZ = setRightStripOffsetZ;
window.__getLeftStripOffsetX  = () => leftStripOffsetX;
window.__getLeftStripOffsetY  = () => leftStripOffsetY;
window.__getLeftStripOffsetZ  = () => leftStripOffsetZ;
window.__getRightStripOffsetX = () => rightStripOffsetX;
window.__getRightStripOffsetY = () => rightStripOffsetY;
window.__getRightStripOffsetZ = () => rightStripOffsetZ;
// Legacy combined offset setters/getters (still used elsewhere).
window.__setStripOffsetX    = setStripOffsetX;
window.__setStripOffsetY    = setStripOffsetY;
window.__setStripOffsetZ    = setStripOffsetZ;
window.__getStripOffsetX    = () => leftStripOffsetX;   // alias
window.__getStripOffsetY    = () => leftStripOffsetY;
window.__getStripOffsetZ    = () => leftStripOffsetZ;
window.__setBookshelfSlide  = setBookshelfSlide;
// Expose the recompute fn so external panels can force a refresh after
// poking the offsets (belt-and-suspenders if the setter's internal call
// short-circuited for any reason — e.g. before the mirror was built).
window.__updateStripPositions = updateStripPositions;
// Direct light-array accessors — used by the standalone shelf-light
// panel to manipulate positions without going through the legacy
// stripOffset / mirror update plumbing.
//
// IMPORTANT: these route through the existing _leftShelfLights() and
// _rightShelfLights() helpers, which include BOTH the 5 main strip
// lights AND any user-added extra lights. (Earlier `stripLights`-only
// accessor was missing the extras, so the panel only nudged half of
// the lights on each shelf.) Right-side list is built lazily when the
// mirrored bookshelf is constructed.
window.__getLeftShelfLightsArr  = () => (typeof _leftShelfLights  === 'function') ? _leftShelfLights()  : [];
window.__getRightShelfLightsArr = () => (typeof _rightShelfLights === 'function') ? _rightShelfLights() : [];

// Load per-side offsets + warmth/brightness from persisted state on boot.
try {
  const _ls = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
  if (typeof _ls['leftStripOffset.x'] === 'number')  leftStripOffsetX  = _ls['leftStripOffset.x'];
  else if (typeof _ls['stripOffset.x'] === 'number') leftStripOffsetX  = _ls['stripOffset.x'];
  if (typeof _ls['leftStripOffset.y'] === 'number')  leftStripOffsetY  = _ls['leftStripOffset.y'];
  else if (typeof _ls['stripOffset.y'] === 'number') leftStripOffsetY  = _ls['stripOffset.y'];
  if (typeof _ls['leftStripOffset.z'] === 'number')  leftStripOffsetZ  = _ls['leftStripOffset.z'];
  else if (typeof _ls['stripOffset.z'] === 'number') leftStripOffsetZ  = _ls['stripOffset.z'];
  if (typeof _ls['rightStripOffset.x'] === 'number') rightStripOffsetX = _ls['rightStripOffset.x'];
  else if (typeof _ls['stripOffset.x'] === 'number') rightStripOffsetX = _ls['stripOffset.x'];
  if (typeof _ls['rightStripOffset.y'] === 'number') rightStripOffsetY = _ls['rightStripOffset.y'];
  else if (typeof _ls['stripOffset.y'] === 'number') rightStripOffsetY = _ls['stripOffset.y'];
  if (typeof _ls['rightStripOffset.z'] === 'number') rightStripOffsetZ = _ls['rightStripOffset.z'];
  else if (typeof _ls['stripOffset.z'] === 'number') rightStripOffsetZ = _ls['stripOffset.z'];
} catch {}

// ---------- Extra shelf lights (user-added, per-shelf) ------------------
// Lets the user add as many extra warm point lights as they want to
// either bookshelf (left = original `__propGroup_bookshelf`, right =
// `__bookshelfMirror`). Each entry is stored in localStorage and
// rebuilt on every boot so positions, intensity, range, and color all
// survive reloads. Driven by the Right Shelf editor card UI below.
const EXTRA_LIGHTS_KEY = 'shelfLights.extra.v1';
function _readExtraShelfLights() {
  try { return JSON.parse(localStorage.getItem(EXTRA_LIGHTS_KEY) || '[]') || []; }
  catch { return []; }
}
function _writeExtraShelfLights(list) {
  try { localStorage.setItem(EXTRA_LIGHTS_KEY, JSON.stringify(list)); } catch {}
}
const _extraShelfLights = [];   // {entry, light, parentGroup}
function _findShelfParent(side) {
  if (side === 'right') return _mirroredBookshelf || null;
  return propGroups.bookshelf?.group || null;
}
function _buildExtraLight(entry) {
  const parent = _findShelfParent(entry.side);
  if (!parent) return null;
  const c = new THREE.Color(entry.r ?? 1.0, entry.g ?? 0.7, entry.b ?? 0.4);
  const light = new THREE.PointLight(c, entry.intensity ?? 0.9, entry.distance ?? 0.6, 2.0);
  light.castShadow = false;
  light.position.set(entry.x ?? 0, entry.y ?? 1.4, entry.z ?? 0);
  light.userData._extraId = entry.id;
  parent.add(light);
  _extraShelfLights.push({ entry, light, parent });
  return light;
}
function _rebuildAllExtraLights() {
  // Tear down existing extra lights from the scene + cache.
  for (const e of _extraShelfLights.splice(0)) {
    e.light.parent?.remove(e.light);
  }
  for (const entry of _readExtraShelfLights()) _buildExtraLight(entry);
}
function _addExtraShelfLight(side) {
  const list = _readExtraShelfLights();
  const id = `extra-${Date.now()}-${Math.floor(Math.random()*1e6).toString(36)}`;
  const entry = {
    id, side,
    x: 0, y: 1.4, z: side === 'right' ? -0.5 : 0.5,
    intensity: 0.9, distance: 0.6,
    r: 1.0, g: 0.7, b: 0.35,
  };
  list.push(entry);
  _writeExtraShelfLights(list);
  _buildExtraLight(entry);
  return entry;
}
function _removeExtraShelfLight(id) {
  const list = _readExtraShelfLights().filter(e => e.id !== id);
  _writeExtraShelfLights(list);
  // Strip the live light from scene.
  const i = _extraShelfLights.findIndex(e => e.entry.id === id);
  if (i >= 0) {
    const e = _extraShelfLights[i];
    e.light.parent?.remove(e.light);
    _extraShelfLights.splice(i, 1);
  }
}
function _updateExtraShelfLight(id, patch) {
  const list = _readExtraShelfLights();
  const idx = list.findIndex(e => e.id === id);
  if (idx < 0) return;
  Object.assign(list[idx], patch);
  _writeExtraShelfLights(list);
  // Update live light if present.
  const live = _extraShelfLights.find(e => e.entry.id === id);
  if (live) {
    if ('x' in patch || 'y' in patch || 'z' in patch) {
      live.light.position.set(list[idx].x, list[idx].y, list[idx].z);
    }
    if ('intensity' in patch) live.light.intensity = list[idx].intensity;
    if ('distance' in patch)  live.light.distance  = list[idx].distance;
    if ('r' in patch || 'g' in patch || 'b' in patch) {
      live.light.color.setRGB(list[idx].r, list[idx].g, list[idx].b);
    }
    live.entry = list[idx];
  }
}
window.__readExtraShelfLights   = _readExtraShelfLights;
window.__addExtraShelfLight     = _addExtraShelfLight;
window.__removeExtraShelfLight  = _removeExtraShelfLight;
window.__updateExtraShelfLight  = _updateExtraShelfLight;
window.__rebuildAllExtraLights  = _rebuildAllExtraLights;
setStripWarmth(0.85);
setStripBrightness(1.2);

// ---------- Shelf spacing + swap state ---------------------------------
// Each item attached to the bookshelf "lives on" a shelf (A=bottom big,
// E=top). The Sliders → Shelf spacing card lets you (a) nudge a shelf's
// items up/down and (b) swap two shelves' worth of items wholesale. The
// shelf wood is baked into room.glb so it doesn't move — only the items.
const SHELF_LETTERS = ['A', 'B', 'C', 'D', 'E'];
// centerY = the resting Y (top of the divider/floor below). yMin/yMax are
// the band an item must sit in to be auto-assigned to that shelf.
const SHELF_BANDS = {
  A: { yMin: 0.00, yMax: 1.35,  centerY: 0.825 },
  B: { yMin: 1.35, yMax: 1.71,  centerY: 1.350 },
  C: { yMin: 1.71, yMax: 2.07,  centerY: 1.710 },
  D: { yMin: 2.07, yMax: 2.42,  centerY: 2.070 },
  E: { yMin: 2.42, yMax: 6.00,  centerY: 2.420 },
};
function detectShelfFromY(y) {
  for (const k of SHELF_LETTERS) {
    const b = SHELF_BANDS[k];
    if (y >= b.yMin && y < b.yMax) return k;
  }
  return null;
}
// World-space alcove bounds (X/Z). An "invisible box hovering above each
// shelf" is the slab `[xMin..xMax] × [SHELF_BANDS[k].yMin..yMax] × [zMin..zMax]`.
// Any SELECTABLE item whose world center falls inside one of those slabs
// is auto-registered as a member of that shelf.
//
// These bounds are DERIVED at runtime from the world positions of the
// existing bookshelf-attached props (groot, chest, masks, …). The
// bookshelf assembly slides to a final position late in the boot
// sequence, so any hardcoded bounds drift out of sync. The dynamic
// derivation is the only thing that stays correct.
const SHELF_ALCOVE = { xMin: 1.05, xMax: 1.95, zMin: 0.30, zMax: 2.80 };
const _shelfAlcoveDeriveWP = new THREE.Vector3();
function deriveShelfAlcove() {
  const bg = propGroups.bookshelf?.group;
  if (!bg) return false;
  bg.updateMatrixWorld(true);
  let xMin = Infinity, xMax = -Infinity, zMin = Infinity, zMax = -Infinity;
  let count = 0;
  for (const child of bg.children) {
    const sel = SELECTABLE.find((s) => s.group === child);
    if (!sel || !sel.label) continue;
    if (SHELF_EXCLUDE_LABELS.has(sel.label)) continue;
    child.updateMatrixWorld(true);
    child.getWorldPosition(_shelfAlcoveDeriveWP);
    const y = _shelfAlcoveDeriveWP.y;
    if (y < SHELF_BANDS.A.yMin - 0.2 || y > SHELF_BANDS.E.yMax + 0.5) continue;
    xMin = Math.min(xMin, _shelfAlcoveDeriveWP.x);
    xMax = Math.max(xMax, _shelfAlcoveDeriveWP.x);
    zMin = Math.min(zMin, _shelfAlcoveDeriveWP.z);
    zMax = Math.max(zMax, _shelfAlcoveDeriveWP.z);
    count++;
  }
  if (count < 1) return false;
  // Pad generously so newly-dropped items land inside.
  SHELF_ALCOVE.xMin = xMin - 0.45;
  SHELF_ALCOVE.xMax = xMax + 0.45;
  SHELF_ALCOVE.zMin = zMin - 0.55;
  SHELF_ALCOVE.zMax = zMax + 0.55;
  return true;
}
// Some bookshelf-attached props decorate the wood without "belonging" to
// a shelf — Finn's sword, for example, hangs off the side. They stay
// where they are but never count as shelf members.
const SHELF_EXCLUDE_LABELS = new Set(["Finn's sword"]);
// uuid -> { group, label, delta, shelf }
const _shelfMembers = new Map();
let _shelfRegistered = false;
const _shelfWP = new THREE.Vector3();
function registerShelfMembers() {
  // Recompute alcove world bounds from current bookshelf children, then
  // rebuild the wireframes so they stay aligned with the actual shelf
  // wood (the bookshelf slides into place late in the boot sequence).
  if (deriveShelfAlcove()) rebuildShelfBoxHelperGeometry();
  _shelfMembers.clear();
  let assignments = {};
  try {
    const raw = (loadPersisted() || {})['shelfSpacing.assignments'];
    if (raw && typeof raw === 'object') assignments = raw;
  } catch {}
  const offsets = loadShelfOffsets();
  // Build a Set of selectable groups so we can skip items whose parent
  // is another selectable. Example: when a Nike Air Mag is locked under
  // the Display case, the case is the carrier — Nike rides via the
  // parent chain, so registering Nike directly would double-apply Y
  // moves on swap.
  const selectableGroups = new Set();
  for (const s of SELECTABLE) if (s?.group) selectableGroups.add(s.group);
  for (const sel of SELECTABLE) {
    if (!sel?.group || !sel.label) continue;
    if (SHELF_EXCLUDE_LABELS.has(sel.label)) continue;
    if (sel.group.parent && selectableGroups.has(sel.group.parent)) continue;
    sel.group.updateMatrixWorld(true);
    sel.group.getWorldPosition(_shelfWP);
    // Volume test — must be inside the alcove X/Z slab.
    if (_shelfWP.x < SHELF_ALCOVE.xMin || _shelfWP.x > SHELF_ALCOVE.xMax) continue;
    if (_shelfWP.z < SHELF_ALCOVE.zMin || _shelfWP.z > SHELF_ALCOVE.zMax) continue;
    // Y band — picks the shelf this item is sitting in.
    const detected = detectShelfFromY(_shelfWP.y);
    if (!detected) continue;
    const shelf = SHELF_LETTERS.includes(assignments[sel.label]) ? assignments[sel.label] : detected;
    const offset = offsets[shelf] || 0;
    // Delta = within-shelf offset, ignoring the shelf's global Y nudge.
    // World-Y = centerY + delta + offset; we invert that here so the
    // offset doesn't double-apply on the next applyShelfSpacing.
    const delta = _shelfWP.y - SHELF_BANDS[shelf].centerY - offset;
    _shelfMembers.set(sel.group.uuid, { group: sel.group, label: sel.label, delta, shelf });
  }
  _shelfRegistered = true;
}
// Wireframe boxes drawn at each shelf's slab — toggled visible while the
// shelf-spacing card is open so the user can SEE the zones being used
// for membership detection. Rebuilt whenever SHELF_ALCOVE changes.
const _shelfBoxHelpers = [];
const SHELF_BOX_PALETTE = { A: 0xff8a3d, B: 0xffd166, C: 0x6aa9ff, D: 0xa6e3a1, E: 0xc792ea };
function ensureShelfBoxHelpers() {
  if (_shelfBoxHelpers.length > 0 || typeof scene === 'undefined') return;
  for (const k of SHELF_LETTERS) {
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: SHELF_BOX_PALETTE[k], transparent: true, opacity: 0.55, depthTest: false }),
    );
    edges.userData.shelf = k;
    edges.renderOrder = 999;
    edges.visible = false;
    edges.raycast = function () {};
    scene.add(edges);
    _shelfBoxHelpers.push(edges);
  }
  rebuildShelfBoxHelperGeometry();
}
function rebuildShelfBoxHelperGeometry() {
  if (_shelfBoxHelpers.length === 0) return;
  const w = SHELF_ALCOVE.xMax - SHELF_ALCOVE.xMin;
  const d = SHELF_ALCOVE.zMax - SHELF_ALCOVE.zMin;
  const cx = (SHELF_ALCOVE.xMin + SHELF_ALCOVE.xMax) / 2;
  const cz = (SHELF_ALCOVE.zMin + SHELF_ALCOVE.zMax) / 2;
  for (let i = 0; i < SHELF_LETTERS.length; i++) {
    const k = SHELF_LETTERS[i];
    const b = SHELF_BANDS[k];
    const yMin = Math.max(b.yMin, 0.0);
    const yMax = Math.min(b.yMax, 3.0);
    const h = Math.max(0.05, yMax - yMin);
    const helper = _shelfBoxHelpers[i];
    helper.geometry.dispose();
    const boxGeo = new THREE.BoxGeometry(w, h, d);
    helper.geometry = new THREE.EdgesGeometry(boxGeo);
    boxGeo.dispose();
    helper.position.set(cx, (yMin + yMax) / 2, cz);
  }
}
function setShelfBoxHelpersVisible(v) {
  ensureShelfBoxHelpers();
  if (v) {
    if (deriveShelfAlcove()) rebuildShelfBoxHelperGeometry();
  }
  for (const h of _shelfBoxHelpers) h.visible = v;
}
window.__setShelfBoxHelpersVisible = setShelfBoxHelpersVisible;
// Move a scene item into the bookshelf (or out of it) and update its
// persisted local-position keys atomically so a reload doesn't corrupt
// the placement (the same trap that broke the Nike pair earlier).
function assignItemToShelf(group, label, shelfLetter) {
  const bg = propGroups.bookshelf?.group;
  if (!bg) return;
  if (shelfLetter === null || shelfLetter === 'none') {
    // Detach back to scene root.
    if (group.parent !== scene) scene.attach(group);
  } else {
    if (group.parent !== bg) bg.attach(group);
  }
  // Persist the NEW local coords under item.<label>.{x,y,z} so loadProp
  // restores it under the right parent next reload.
  try {
    const cur = loadPersisted();
    const storeKey = `item.${(label || '').replace(/\s+/g, '_')}`;
    cur[`${storeKey}.x`] = group.position.x;
    cur[`${storeKey}.y`] = group.position.y;
    cur[`${storeKey}.z`] = group.position.z;
    // Update assignments map.
    let assignments = cur['shelfSpacing.assignments'];
    if (!assignments || typeof assignments !== 'object') assignments = {};
    if (shelfLetter && shelfLetter !== 'none') assignments[label] = shelfLetter;
    else delete assignments[label];
    cur['shelfSpacing.assignments'] = assignments;
    // Remember which prop is bookshelf-parented so loadProp can re-attach
    // on reload (otherwise loadProp creates the group under `scene` and
    // the local coords get re-applied as world coords — same bug as Nike).
    let parents = cur['shelfSpacing.parents'];
    if (!parents || typeof parents !== 'object') parents = {};
    if (shelfLetter && shelfLetter !== 'none') parents[label] = 'bookshelf';
    else delete parents[label];
    cur['shelfSpacing.parents'] = parents;
    localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
  } catch (err) {
    console.warn('[shelf] assign persistence failed', err);
  }
  registerShelfMembers();
  applyShelfSpacing(loadShelfOffsets());
}
window.__assignItemToShelf = assignItemToShelf;
// Pair the Nike Air Mag (any bank-spawned item whose label matches
// /nike|air ?mag/i) with the standalone "Display case" — attach Nike
// under the case so they move as one. Idempotent + safe to retry.
function tryPairNikeWithDisplayCase() {
  const caseSel = SELECTABLE.find((s) => s.label === 'Display case');
  if (!caseSel || !caseSel.group) return false;
  const nikeSel = SELECTABLE.find((s) => /nike|air ?mag/i.test(s.label || ''));
  if (!nikeSel || !nikeSel.group) return false;
  if (nikeSel.group.parent === caseSel.group) return true; // already paired
  caseSel.group.attach(nikeSel.group);
  console.log('[shelf] paired Nike Air Mag → Display case (moves as one)');
  return true;
}
window.__pairNikeWithDisplayCase = tryPairNikeWithDisplayCase;
function applyShelfSpacing(offsets) {
  // Move each member to its target WORLD-Y by applying the dy on its
  // local position. Works for items at scene root (parent has no rotation
  // / scale on Y) AND for bookshelf-attached items (bookshelf y=0,
  // rotation=0). Avoids needing to know the parent chain in advance.
  for (const m of _shelfMembers.values()) {
    if (!m.group.parent) continue;
    m.group.updateMatrixWorld(true);
    m.group.getWorldPosition(_shelfWP);
    const targetWorldY = SHELF_BANDS[m.shelf].centerY + m.delta + (offsets[m.shelf] || 0);
    const dy = targetWorldY - _shelfWP.y;
    if (Math.abs(dy) > 1e-6) m.group.position.y += dy;
  }
}
function saveShelfState(offsets) {
  const assignments = {};
  for (const m of _shelfMembers.values()) assignments[m.label] = m.shelf;
  const patch = {
    'shelfSpacing.A.offset': offsets.A,
    'shelfSpacing.B.offset': offsets.B,
    'shelfSpacing.C.offset': offsets.C,
    'shelfSpacing.D.offset': offsets.D,
    'shelfSpacing.E.offset': offsets.E,
    'shelfSpacing.assignments': assignments,
  };
  // Persist each member's CURRENT position so a swap (which moves items
  // by setting group.position.y) survives reload. Without this, loadProp
  // restores the OLD persisted position and the swap effectively undoes
  // itself when the page reopens.
  for (const m of _shelfMembers.values()) {
    const sk = `item.${(m.label || '').replace(/\s+/g, '_')}`;
    patch[`${sk}.x`] = m.group.position.x;
    patch[`${sk}.y`] = m.group.position.y;
    patch[`${sk}.z`] = m.group.position.z;
  }
  savePersisted(patch);
}
function swapShelves(a, b) {
  if (a === b) return;
  for (const m of _shelfMembers.values()) {
    if (m.shelf === a) m.shelf = b;
    else if (m.shelf === b) m.shelf = a;
  }
}
function loadShelfOffsets() {
  const stored = loadPersisted();
  return {
    A: typeof stored['shelfSpacing.A.offset'] === 'number' ? stored['shelfSpacing.A.offset'] : 0,
    B: typeof stored['shelfSpacing.B.offset'] === 'number' ? stored['shelfSpacing.B.offset'] : 0,
    C: typeof stored['shelfSpacing.C.offset'] === 'number' ? stored['shelfSpacing.C.offset'] : 0,
    D: typeof stored['shelfSpacing.D.offset'] === 'number' ? stored['shelfSpacing.D.offset'] : 0,
    E: typeof stored['shelfSpacing.E.offset'] === 'number' ? stored['shelfSpacing.E.offset'] : 0,
  };
}
// On boot, once GLBs have settled into the bookshelf, apply persisted
// spacing + swaps so the layout sticks across reloads. Then auto-assign
// the Display case + Nike Air Mag(s) to Shelf B so swaps that include
// shelf B carry them along with the rest of B's items.
//
// Bookshelf has a hardcoded resting position (3.481, 0, -1.620) — see
// `updateProp('bookshelf', …)` later in this file. We use that to detect
// + repair persisted positions that were saved as bookshelf-LOCAL coords
// in a session where Nike/Case were re-parented but the user later opened
// the file at a stage where the parent flag had been cleared (the Display
// case would otherwise spawn at scene-X ≈ -2 — off to the side, looking
// like it disappeared).
const BOOKSHELF_REST_POS = { x: 3.481, y: 0, z: -1.620 };
(function hardRestoreNikeAndCaseToShelfB() {
  try {
    // Unhide Display case if a previous "🗑 Remove item" tagged it.
    try {
      const hidden = JSON.parse(localStorage.getItem('hidden.props.v1') || '[]');
      if (Array.isArray(hidden) && hidden.includes('Display case')) {
        const filtered = hidden.filter((l) => l !== 'Display case');
        localStorage.setItem('hidden.props.v1', JSON.stringify(filtered));
        console.log('[recover] unhid Display case (was in hidden.props.v1).');
      }
    } catch {}
    const SENTINEL = 'recover.nikecase.v6';
    const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    if (stored[SENTINEL]) return; // one-shot
    // Hard-pin to scene-root WORLD coords sitting on shelf B, near where
    // the Minecraft chest already sits one shelf below. The chest's
    // final-world is ~ (4.89, 0.82, -0.88) (target (1.41, 0.82, 1.50)
    // attached when bookshelf was at (0,0,0.77), then bookshelf moved to
    // (3.481, 0, -1.620)). Putting the case at the same X/Z but shelf-B
    // Y guarantees it lands inside the visible alcove.
    const CASE_WORLD = { x: 4.89, y: 1.40, z: -0.88 };
    const NIKE_WORLD = { x: 4.89, y: 1.43, z: -0.88 };
    function setItemWorld(labelKey, world) {
      const sk = `item.${labelKey}`;
      stored[`${sk}.x`] = world.x;
      stored[`${sk}.y`] = world.y;
      stored[`${sk}.z`] = world.z;
    }
    setItemWorld('Display_case', CASE_WORLD);
    let nikeLabels = ['Nike Air Mag'];
    try {
      const list = JSON.parse(localStorage.getItem('bank.spawned.v2') || '[]');
      if (Array.isArray(list)) {
        const found = list
          .filter((e) => e && /nike|air ?mag/i.test(e.label || ''))
          .map((e) => e.label);
        if (found.length) nikeLabels = found;
      }
    } catch {}
    for (const lbl of nikeLabels) {
      setItemWorld(lbl.replace(/\s+/g, '_'), NIKE_WORLD);
    }
    // CLEAR parent flags — items spawn at scene root with the world
    // coords applied verbatim. (Previous versions wrote bookshelf-local
    // coords + a parent flag, which kept blowing up the placement when
    // some recovery path cleared one half but not the other.)
    let parents = stored['shelfSpacing.parents'];
    if (parents && typeof parents === 'object') {
      delete parents['Display case'];
      for (const lbl of nikeLabels) delete parents[lbl];
      stored['shelfSpacing.parents'] = parents;
    }
    // Mark both as assigned to shelf B so swap moves them.
    let assignments = stored['shelfSpacing.assignments'];
    if (!assignments || typeof assignments !== 'object') assignments = {};
    assignments['Display case'] = 'B';
    for (const lbl of nikeLabels) assignments[lbl] = 'B';
    stored['shelfSpacing.assignments'] = assignments;
    // Clear pair-locks involving Nike/Case.
    try {
      const pairs = JSON.parse(localStorage.getItem('pairLocks.v1') || '[]');
      if (Array.isArray(pairs)) {
        const involves = (l) => l === 'Display case' || /nike|air ?mag/i.test(l);
        const filtered = pairs.filter((e) => !(involves(e?.anchor || '') || involves(e?.follower || '')));
        if (filtered.length !== pairs.length) {
          localStorage.setItem('pairLocks.v1', JSON.stringify(filtered));
        }
      }
    } catch {}
    stored[SENTINEL] = true;
    localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(stored));
    console.log(`[recover] hard-pinned Display case + ${nikeLabels.length} Nike(s) at scene root, world (${CASE_WORLD.x}, ${CASE_WORLD.y}/${NIKE_WORLD.y}, ${CASE_WORLD.z}).`);
  } catch (err) { console.warn('[recover] hard restore failed', err); }
})();
// One-shot wipe of stale shelf state from earlier experiments — clears
// the assignments map + per-shelf offsets so the volume detector starts
// from a clean slate. Item POSITIONS + parent flags are intentionally
// kept (so visible placements survive) — this only resets the swap /
// nudge state. Sentinel-gated so it runs once.
(function resetStaleShelfState() {
  try {
    const SENTINEL = 'shelfSpacing.reset.v1';
    const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    if (cur[SENTINEL]) return;
    delete cur['shelfSpacing.assignments'];
    for (const k of ['A','B','C','D','E']) delete cur[`shelfSpacing.${k}.offset`];
    cur[SENTINEL] = true;
    localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
    console.log('[shelf] reset stale assignments + offsets — volume detector will re-derive from current positions.');
  } catch {}
})();
// One-shot "morning reset" — restore the BUILT-IN shelf residents to
// their hardcoded loadProp targets. Wipes persisted positions, parent
// flags, and pair-locks for these labels only; Display case, Nike Air
// Mag(s), and the McQueen wheel are intentionally left alone (those are
// user-added shelf items).
(function morningResetShelfPositions() {
  try {
    const SENTINEL = 'shelfSpacing.morningreset.v1';
    const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    if (cur[SENTINEL]) return;
    const LABELS = [
      'Childhood books', "Finn's sword", 'Groot pot', 'Succulent',
      'Minecraft chest', 'Symbiote mask', 'Spider-Man mask',
      'Pothos plant', 'Foliage study', 'Wall-E boot',
    ];
    const labelKey = (l) => l.replace(/\s+/g, '_');
    let cleared = 0;
    for (const lbl of LABELS) {
      const sk = `item.${labelKey(lbl)}`;
      for (const suffix of ['x', 'y', 'z', 'rotX', 'rotY', 'rotZ', 'scale']) {
        if (cur[`${sk}.${suffix}`] !== undefined) {
          delete cur[`${sk}.${suffix}`];
          cleared++;
        }
      }
      const parents = cur['shelfSpacing.parents'];
      if (parents && parents[lbl]) { delete parents[lbl]; cleared++; }
      const assignments = cur['shelfSpacing.assignments'];
      if (assignments && assignments[lbl]) { delete assignments[lbl]; cleared++; }
    }
    // Strip pair-locks naming any of the reset labels.
    try {
      const pairs = JSON.parse(localStorage.getItem('pairLocks.v1') || '[]');
      if (Array.isArray(pairs)) {
        const set = new Set(LABELS);
        const filtered = pairs.filter((e) => !(set.has(e?.anchor) || set.has(e?.follower)));
        if (filtered.length !== pairs.length) {
          localStorage.setItem('pairLocks.v1', JSON.stringify(filtered));
        }
      }
    } catch {}
    cur[SENTINEL] = true;
    localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
    if (cleared > 0) console.log(`[recover] morning reset — cleared ${cleared} persisted key(s); built-in shelf props will spawn at their hardcoded targets.`);
  } catch {}
})();
setTimeout(() => {
  registerShelfMembers();
  applyShelfSpacing(loadShelfOffsets());
  autoAssignDisplayCaseAndNikeToB();
}, 3500);
// =====================================================================
// FRESH START — Nike Air Mag + Glass case
// =====================================================================
// Wipes every persisted state related to these two props and re-creates
// them as bookshelf children on shelf B. Sentinel-gated so it only runs
// once. After this fires the user can drag them with the gizmo and the
// new positions will save normally.
(function freshStartNikeAndCase() {
  try {
    const SENTINEL = 'freshStart.nikecase.v2';
    const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    if (cur[SENTINEL]) return;
    // Wipe item.<Display_case|Nike_*> position / rotation / scale keys.
    for (const k of Object.keys(cur)) {
      const m = k.match(/^item\.(.+)\.(x|y|z|rotX|rotY|rotZ|scale)$/);
      if (!m) continue;
      const lbl = m[1];
      if (lbl === 'Display_case' || /^Nike_/i.test(lbl) || /Air[_ ]?Mag/i.test(lbl)) {
        delete cur[k];
      }
    }
    // Wipe parents + assignments + pair-locks involving these labels.
    const isTargetLabel = (l) => l === 'Display case' || /nike|air ?mag/i.test(l || '');
    for (const mapKey of ['shelfSpacing.parents', 'shelfSpacing.assignments']) {
      const m = cur[mapKey];
      if (m && typeof m === 'object') {
        for (const lbl of Object.keys(m)) if (isTargetLabel(lbl)) delete m[lbl];
      }
    }
    try {
      const pairs = JSON.parse(localStorage.getItem('pairLocks.v1') || '[]');
      if (Array.isArray(pairs)) {
        const filtered = pairs.filter((e) => !(isTargetLabel(e?.anchor) || isTargetLabel(e?.follower)));
        if (filtered.length !== pairs.length) localStorage.setItem('pairLocks.v1', JSON.stringify(filtered));
      }
    } catch {}
    // Unhide Display case if it was hidden.
    try {
      const hidden = JSON.parse(localStorage.getItem('hidden.props.v1') || '[]');
      if (Array.isArray(hidden) && hidden.includes('Display case')) {
        localStorage.setItem('hidden.props.v1', JSON.stringify(hidden.filter((l) => l !== 'Display case')));
      }
    } catch {}
    cur[SENTINEL] = true;
    localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
    console.log('[freshStart] wiped Nike + Glass case state — clean placement on next setTimeout.');
  } catch (err) { console.warn('[freshStart] wipe failed', err); }
})();
// Make sure a Nike Air Mag exists in the bank-spawn registry so the
// restorer at +1.5 s loads its GLB. Sync init.
(function ensureNikeInBankRegistry() {
  try {
    const list = JSON.parse(localStorage.getItem('bank.spawned.v2') || '[]');
    if (Array.isArray(list) && list.some((e) => /nike|air ?mag/i.test(e?.label || ''))) return;
    const entry = {
      id: `bank-nike_air_mags-recover-${Date.now().toString(36)}`,
      file: 'nike_air_mags.glb',
      label: 'Nike Air Mag',
      target: { x: 1.45, y: 1.40, z: 1.85 }, // pre-attach world coords near alcove items
      scaleTarget: 0.45,
    };
    list.push(entry);
    localStorage.setItem('bank.spawned.v2', JSON.stringify(list));
    console.log('[freshStart] added Nike Air Mag to bank.spawned.v2.');
  } catch {}
})();
// After items have loaded, find the Nike's current world position and
// place the Display case at the same spot — base lined up with the
// shelf wood so the Nike sits inside. Nike itself stays where it is.
// Display case keeps its dimension + glass-material settings (those
// persist under `displayCase.*` and `caseGlass.*` keys, which we
// intentionally don't touch).
function freshStartPlaceOnShelfB() {
  const bg = propGroups.bookshelf?.group;
  if (!bg) return false;
  const nikeSel = SELECTABLE.find((s) => /nike|air ?mag/i.test(s.label || ''));
  if (!nikeSel?.group) {
    console.warn('[freshStart] no Nike in SELECTABLE — skipping case placement.');
    return false;
  }
  // Locate Nike in world space.
  nikeSel.group.updateMatrixWorld(true);
  const nikeWP = new THREE.Vector3();
  nikeSel.group.getWorldPosition(nikeWP);
  // Display case base sits on shelf B's wood (Y ≈ 1.395). If Nike is on
  // a different shelf, drop the case onto the shelf B level just below
  // it — but if Nike is already on shelf B, line them up so Nike sits
  // INSIDE the case.
  const SHELF_B_WOOD_Y = 1.395;
  const caseTargetWorld = new THREE.Vector3(
    nikeWP.x,
    SHELF_B_WOOD_Y,
    nikeWP.z,
  );
  // Convert world → bookshelf-local for both items so they save as
  // bookshelf-attached props (survives bookshelf moves).
  bg.updateMatrixWorld(true);
  const _bw = new THREE.Vector3();
  bg.getWorldPosition(_bw);
  const caseLocal = caseTargetWorld.clone().sub(_bw);
  // Nike: keep its current world position; just compute its local
  // for the bookshelf parent so persistence is consistent.
  const nikeLocal = nikeWP.clone().sub(_bw);
  const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
  function place(group, label, local) {
    if (!group) return;
    if (group.parent !== bg) bg.add(group);
    group.position.set(local.x, local.y, local.z);
    group.visible = true;
    const sk = `item.${label.replace(/\s+/g, '_')}`;
    cur[`${sk}.x`] = local.x;
    cur[`${sk}.y`] = local.y;
    cur[`${sk}.z`] = local.z;
    let parents = cur['shelfSpacing.parents'];
    if (!parents || typeof parents !== 'object') parents = {};
    parents[label] = 'bookshelf';
    cur['shelfSpacing.parents'] = parents;
    let assignments = cur['shelfSpacing.assignments'];
    if (!assignments || typeof assignments !== 'object') assignments = {};
    assignments[label] = 'B';
    cur['shelfSpacing.assignments'] = assignments;
  }
  const caseSel = SELECTABLE.find((s) => s.label === 'Display case');
  if (caseSel?.group) place(caseSel.group, 'Display case', caseLocal);
  place(nikeSel.group, nikeSel.label, nikeLocal);
  // Place every OTHER Nike at the same spot too.
  for (const ns of SELECTABLE) {
    if (ns === nikeSel) continue;
    if (ns?.group && /nike|air ?mag/i.test(ns.label || '')) {
      place(ns.group, ns.label, nikeLocal);
    }
  }
  localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
  console.log(`[freshStart] case placed at Nike's world (${nikeWP.x.toFixed(3)}, ${SHELF_B_WOOD_Y.toFixed(3)}, ${nikeWP.z.toFixed(3)}). Click the case to access dimension + glass-material sliders.`);
  registerShelfMembers();
  applyShelfSpacing(loadShelfOffsets());
  return true;
}
// Poll for items to load (Nike GLB is async) — try every 600ms for ~9s.
// ---------- Spawnable frame instances ---------------------------------
// Lets any item editor's "🖼 Frame match" section drop a fresh
// horizontal frame underneath the selected prop. Each spawned frame is
// its own SELECTABLE (`Frame N`), pair-locked to the item that
// requested it, and registered in `extraFrames.v1` so reload
// reconstructs the same set automatically.
let _extraFrameCount = 0;
function _readExtraFrames() {
  try { return JSON.parse(localStorage.getItem('extraFrames.v1') || '[]') || []; }
  catch { return []; }
}
function _saveExtraFrames(list) {
  try { localStorage.setItem('extraFrames.v1', JSON.stringify(list)); } catch {}
}
function buildFrameInstance(label) {
  const group = new THREE.Group();
  group.name = `__prop_extraframe_${label.replace(/\s+/g, '_')}`;
  scene.add(group);
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x1f1408, roughness: 0.6, metalness: 0.05 });
  const canvasMat = new THREE.MeshStandardMaterial({ color: 0xf5f1e8, roughness: 0.92, metalness: 0.0 });
  const W = 0.45, H = 0.65, B = 0.025, D = 0.018;
  const innerH = H - B * 2;
  const innerW = W - B * 2;
  const top    = new THREE.Mesh(new THREE.BoxGeometry(W, B, D), woodMat); top.position.set(0,  H/2 - B/2, 0);
  const bot    = new THREE.Mesh(new THREE.BoxGeometry(W, B, D), woodMat); bot.position.set(0, -H/2 + B/2, 0);
  const lft    = new THREE.Mesh(new THREE.BoxGeometry(B, innerH, D), woodMat); lft.position.set(-W/2 + B/2, 0, 0);
  const rgt    = new THREE.Mesh(new THREE.BoxGeometry(B, innerH, D), woodMat); rgt.position.set( W/2 - B/2, 0, 0);
  const face   = new THREE.Mesh(new THREE.BoxGeometry(innerW, innerH, D * 0.4), canvasMat); face.position.set(0, 0, -D * 0.05);
  [top, bot, lft, rgt, face].forEach((m) => { m.castShadow = true; m.receiveShadow = true; });
  group.add(top, bot, lft, rgt, face);
  // Apply persisted transform if any.
  try {
    const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    const sk = `item.${label.replace(/\s+/g, '_')}`;
    if (typeof stored[`${sk}.x`]    === 'number') group.position.x = stored[`${sk}.x`];
    if (typeof stored[`${sk}.y`]    === 'number') group.position.y = stored[`${sk}.y`];
    if (typeof stored[`${sk}.z`]    === 'number') group.position.z = stored[`${sk}.z`];
    if (typeof stored[`${sk}.rotX`] === 'number') group.rotation.x = stored[`${sk}.rotX`];
    if (typeof stored[`${sk}.rotY`] === 'number') group.rotation.y = stored[`${sk}.rotY`];
    if (typeof stored[`${sk}.rotZ`] === 'number') group.rotation.z = stored[`${sk}.rotZ`];
    if (typeof stored[`${sk}.scale`] === 'number' && stored[`${sk}.scale`] > 0.01) group.scale.setScalar(stored[`${sk}.scale`]);
  } catch {}
  makeSelectable(group, label);
  return group;
}
function spawnFrameForItem(itemGroup, itemLabel) {
  const existing = _readExtraFrames();
  _extraFrameCount = Math.max(_extraFrameCount, existing.length);
  _extraFrameCount++;
  const label = `Frame ${_extraFrameCount}`;
  const group = buildFrameInstance(label);
  // Place it 0.4 m below the item, lying flat (horizontal — face up).
  itemGroup.updateMatrixWorld(true);
  const wp = new THREE.Vector3();
  itemGroup.getWorldPosition(wp);
  group.position.set(wp.x, wp.y - 0.4, wp.z);
  group.rotation.set(-Math.PI / 2, 0, 0);
  // Persist new transform immediately.
  try {
    const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    const sk = `item.${label.replace(/\s+/g, '_')}`;
    cur[`${sk}.x`] = group.position.x;
    cur[`${sk}.y`] = group.position.y;
    cur[`${sk}.z`] = group.position.z;
    cur[`${sk}.rotX`] = group.rotation.x;
    cur[`${sk}.rotY`] = group.rotation.y;
    cur[`${sk}.rotZ`] = group.rotation.z;
    localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
  } catch {}
  // Pair-lock the new frame as a follower of the item (offset (0, -0.4, 0)).
  if (typeof window.__pairLock === 'function') {
    window.__pairLock(itemGroup, group);
    if (typeof persistPair === 'function') {
      persistPair(itemLabel, label, { x: 0, y: -0.4, z: 0 });
    }
  }
  // Register so reload rebuilds it.
  existing.push({ label, anchorLabel: itemLabel });
  _saveExtraFrames(existing);
  // Refresh the Sliders menu so the new frame shows up there immediately.
  if (typeof window.__refreshSlidersFrameList === 'function') window.__refreshSlidersFrameList();
  console.log(`[frame] spawned "${label}" under "${itemLabel}".`);
  return group;
}
window.__spawnFrameForItem = spawnFrameForItem;
// On boot, restore any extra frames that were spawned previously. The
// pair-lock entries in pairLocks.v1 are restored separately by the
// existing +4.5 s setTimeout — they'll re-attach the frame to its anchor.
setTimeout(() => {
  const list = _readExtraFrames();
  for (const entry of list) {
    if (!entry?.label) continue;
    if (SELECTABLE.find((s) => s.label === entry.label)) continue;
    buildFrameInstance(entry.label);
  }
  if (list.length) console.log(`[frame] restored ${list.length} spawned frame(s).`);
}, 1200);

// One-shot Speed-frame recovery + flip the pair so the car sits ON the
// frame (frame = anchor, car = follower at +Y offset). Wipes any stale
// pair entries / offsets that may have pushed the frame off-screen.
(function recoverSpeedFrameAndPair() {
  try {
    const SENTINEL = 'recover.speedFrameOnTop.v1';
    const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    if (cur[SENTINEL]) return;
    // Reset the Speed frame to a sane visible position on the back wall.
    cur['item.Speed_frame.x'] = -1.0;
    cur['item.Speed_frame.y'] = 1.6;
    cur['item.Speed_frame.z'] = -3.5;
    delete cur['item.Speed_frame.rotX'];
    delete cur['item.Speed_frame.rotY'];
    delete cur['item.Speed_frame.rotZ'];
    // Clear ALL pair-lock entries that reference Speed frame OR a
    // Speed Racer Mach 6 — we'll re-pair fresh in the boot setTimeout.
    try {
      const pairs = JSON.parse(localStorage.getItem('pairLocks.v1') || '[]');
      if (Array.isArray(pairs)) {
        const involves = (l) => l === 'Speed frame' || /speed.?racer|mach.?6/i.test(l || '');
        const filtered = pairs.filter((e) => !(involves(e?.anchor) || involves(e?.follower)));
        if (filtered.length !== pairs.length) {
          localStorage.setItem('pairLocks.v1', JSON.stringify(filtered));
        }
      }
    } catch {}
    // Wipe any per-item frame offset overrides — fresh start.
    for (const k of Object.keys(cur)) {
      if (/\.frameOffset$|\.speedFrameOffset$/.test(k)) delete cur[k];
    }
    cur[SENTINEL] = true;
    localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
    console.log('[recover] Speed frame reset to default position; pair-locks involving frame/car wiped — boot will re-pair with frame as anchor.');
  } catch {}
})();
// One-shot rename: migrate old `Art frame` persisted state → `Speed frame`.
// Frame is staying the same prop (same geometry, same code), just relabeled
// per user request and paired with the Speed Racer Mach 6 model.
(function migrateArtFrameToSpeedFrame() {
  try {
    const SENTINEL = 'migrate.artFrame.speedFrame.v1';
    const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    if (cur[SENTINEL]) return;
    const oldPrefix = 'item.Art_frame.';
    const newPrefix = 'item.Speed_frame.';
    let moved = 0;
    for (const k of Object.keys(cur)) {
      if (k.startsWith(oldPrefix)) {
        const newKey = newPrefix + k.slice(oldPrefix.length);
        if (cur[newKey] === undefined) cur[newKey] = cur[k];
        delete cur[k];
        moved++;
      }
    }
    // shelfSpacing.assignments / .parents — rename label keys.
    for (const map of ['shelfSpacing.assignments', 'shelfSpacing.parents']) {
      const m = cur[map];
      if (m && typeof m === 'object' && m['Art frame'] !== undefined) {
        m['Speed frame'] = m['Art frame'];
        delete m['Art frame'];
        moved++;
      }
    }
    cur[SENTINEL] = true;
    localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
    if (moved) console.log(`[migrate] ${moved} key(s) renamed Art frame → Speed frame.`);
  } catch {}
})();
// One-shot wipe of the bad Woody hip-pose state from the previous attempt.
(function recoverWoodyV1() {
  try {
    const SENTINEL = 'recover.woody.v1';
    const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    if (cur[SENTINEL]) return;
    let cleared = 0;
    for (const k of Object.keys(cur)) {
      if (/^item\.woody.+\.woody\.hip$/i.test(k)) { delete cur[k]; cleared++; }
    }
    cur[SENTINEL] = true;
    localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
    if (cleared) console.log(`[recover] wiped ${cleared} Woody hip-angle key(s) from prior pose attempt.`);
  } catch {}
})();
// (Auto-place + auto-pull removed — they were stomping on the user's
// manual adjustments every reload. The fresh-start wipe already ran in a
// prior session, and the user has since dialled the Nike + case to where
// they want them. Use the Display case editor's "🔗 Merge" button or the
// Nike's "🔓 Lock" button to merge / separate on demand.)
// One-shot AT-AT removal — strips it from the bank-spawn registry +
// wipes its persisted item state + flags the orbit animation off.
(function removeAtAt() {
  try {
    const SENTINEL = 'remove.atAt.v1';
    const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    if (cur[SENTINEL]) return;
    const list = JSON.parse(localStorage.getItem('bank.spawned.v2') || '[]');
    if (Array.isArray(list)) {
      const filtered = list.filter((e) => !/at.?at|at[ -]?attm/i.test(e?.label || ''));
      if (filtered.length !== list.length) {
        localStorage.setItem('bank.spawned.v2', JSON.stringify(filtered));
        console.log('[remove] AT-AT removed from bank registry.');
      }
    }
    for (const k of Object.keys(cur)) {
      const m = k.match(/^item\.(.+)\./);
      if (m && /at.?at|at[ -]?attm/i.test(m[1].replace(/_/g, ' '))) {
        delete cur[k];
      }
    }
    cur[SENTINEL] = true;
    localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
  } catch {}
})();
// Even if a stray AT-AT slipped through, keep the orbit animation off
// going forward (the user removed it on purpose).
window.__atAtCircle = false;
// Lock the Minecraft chest's CURRENT position. Once on this reload,
// after the chest has loaded, we read its live transform and persist
// every component (position + rotation + scale) so it stays put.
setTimeout(() => {
  try {
    const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    const SENTINEL = 'lock.minecraftChest.v1';
    if (cur[SENTINEL]) return;
    const sel = SELECTABLE.find((s) => s.label === 'Minecraft chest');
    if (!sel?.group) return; // try again on next reload
    const g = sel.group;
    const sk = 'item.Minecraft_chest';
    cur[`${sk}.x`]    = g.position.x;
    cur[`${sk}.y`]    = g.position.y;
    cur[`${sk}.z`]    = g.position.z;
    cur[`${sk}.rotX`] = g.rotation.x;
    cur[`${sk}.rotY`] = g.rotation.y;
    cur[`${sk}.rotZ`] = g.rotation.z;
    cur[`${sk}.scale`] = g.scale.x;
    cur[SENTINEL] = true;
    localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
    console.log(`[lock] Minecraft chest position locked: local (${g.position.x.toFixed(3)}, ${g.position.y.toFixed(3)}, ${g.position.z.toFixed(3)}).`);
  } catch {}
}, 6000);
// One-shot Wall-E boot recovery: wipe both the persisted item-position
// keys AND the bootCrop.* keys (a tight crop from a previous session
// would clip the entire visible boot). Sentinel-gated.
(function recoverBootV2() {
  try {
    const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    const SENTINEL = 'recover.boot.v2';
    if (cur[SENTINEL]) return;
    let cleared = 0;
    for (const k of ['x','y','z','rotX','rotY','rotZ','scale']) {
      if (cur[`item.Wall-E_boot.${k}`] !== undefined) { delete cur[`item.Wall-E_boot.${k}`]; cleared++; }
    }
    for (const k of ['bottom','top','left','right','front','back']) {
      if (cur[`bootCrop.${k}`] !== undefined) { delete cur[`bootCrop.${k}`]; cleared++; }
    }
    try {
      const hidden = JSON.parse(localStorage.getItem('hidden.props.v1') || '[]');
      if (Array.isArray(hidden) && hidden.includes('Wall-E boot')) {
        localStorage.setItem('hidden.props.v1', JSON.stringify(hidden.filter((l) => l !== 'Wall-E boot')));
        cleared++;
      }
    } catch {}
    cur[SENTINEL] = true;
    localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
    if (cleared > 0) console.log('[recover] Wall-E boot defaults restored (position + crop wiped, unhidden).');
  } catch {}
})();
function snapNikeAndCaseIntoActualAlcove() {
  // Sentinel-gated so it only runs on the next reload after this fix.
  let stored;
  try {
    stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
  } catch { return; }
  const SENTINEL = 'snap.nikecase.intoAlcove.v1';
  if (stored[SENTINEL]) return;
  // Need a derived alcove to know where to put them.
  if (!deriveShelfAlcove()) return;
  const cx = (SHELF_ALCOVE.xMin + SHELF_ALCOVE.xMax) / 2;
  const cz = (SHELF_ALCOVE.zMin + SHELF_ALCOVE.zMax) / 2;
  const bY = SHELF_BANDS.B.centerY;          // 1.350
  const _wp = new THREE.Vector3();
  function moveToAlcove(group, label, yOffset) {
    if (!group?.parent) return;
    group.updateMatrixWorld(true);
    group.getWorldPosition(_wp);
    const targetX = cx, targetY = bY + (yOffset || 0), targetZ = cz;
    // Compute delta in world, apply via local position (no parent rotation
    // assumed, which holds for scene/bookshelf parents here).
    group.position.x += targetX - _wp.x;
    group.position.y += targetY - _wp.y;
    group.position.z += targetZ - _wp.z;
    // Persist new local coords.
    const sk = `item.${label.replace(/\s+/g, '_')}`;
    stored[`${sk}.x`] = group.position.x;
    stored[`${sk}.y`] = group.position.y;
    stored[`${sk}.z`] = group.position.z;
  }
  const caseSel = SELECTABLE.find((s) => s.label === 'Display case');
  if (caseSel?.group) moveToAlcove(caseSel.group, 'Display case', 0.03);
  for (const sel of SELECTABLE) {
    if (sel?.group && /nike|air ?mag/i.test(sel.label || '')) {
      moveToAlcove(sel.group, sel.label, 0.07);
    }
  }
  stored[SENTINEL] = true;
  try { localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(stored)); } catch {}
  registerShelfMembers();
  applyShelfSpacing(loadShelfOffsets());
  console.log(`[snap] moved Display case + Nike(s) into actual alcove at world (${cx.toFixed(3)}, ${bY.toFixed(3)}, ${cz.toFixed(3)}).`);
}
// One-shot SEPARATION on this reload — undoes the previous auto-pair so
// the user can fine-tune both items independently.
setTimeout(() => {
  try {
    const SENTINEL = 'unpair.nikecase.v1';
    const flag = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}')[SENTINEL];
    if (flag) return;
    const did = unpairNikeFromCase();
    const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    cur[SENTINEL] = true;
    localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
    if (did > 0) console.log(`[recover] separated ${did} Nike(s) from Display case — nudge each to taste, then run window.__pairNikeUnderCase() to merge.`);
  } catch {}
}, 4500);
function autoAssignDisplayCaseAndNikeToB() {
  let assignments = {};
  try {
    const stored = loadPersisted();
    if (stored['shelfSpacing.assignments'] && typeof stored['shelfSpacing.assignments'] === 'object') {
      assignments = stored['shelfSpacing.assignments'];
    }
  } catch {}
  // Each rule: matcher → target shelf. autoAssign skips items that
  // already have a saved assignment, so the user's manual picks always
  // win.
  const RULES = [
    { match: (lbl) => lbl === 'Display case', shelf: 'B' },
    { match: (lbl) => /nike|air ?mag/i.test(lbl),                     shelf: 'B' },
    { match: (lbl) => /(lightning|mcqueen|mc.?queen|mac.?queen)/i.test(lbl), shelf: 'A' },
  ];
  let didAny = false;
  for (const sel of SELECTABLE) {
    if (!sel?.label || !sel.group) continue;
    const rule = RULES.find((r) => r.match(sel.label));
    if (!rule) continue;
    if (assignments[sel.label]) continue;
    assignItemToShelf(sel.group, sel.label, rule.shelf);
    console.log(`[shelf] auto-assigned "${sel.label}" → Shelf ${rule.shelf}`);
    didAny = true;
  }
  if (didAny) applyShelfSpacing(loadShelfOffsets());
}
// Re-parent every Nike Air Mag under the Display case so dragging the
// case (or any swap that moves the case) carries the Nikes along via the
// Three.js parent chain. Persists the new case-local coords + a
// shelfSpacing.parents['Nike *'] = 'Display case' flag so loadProp
// re-creates the parent chain on reload.
function pairNikeUnderCase() {
  const caseSel = SELECTABLE.find((s) => s.label === 'Display case');
  if (!caseSel?.group) return;
  const nikeSels = SELECTABLE.filter((s) => /nike|air ?mag/i.test(s.label || ''));
  let count = 0;
  for (const ns of nikeSels) {
    if (!ns.group) continue;
    if (ns.group.parent === caseSel.group) continue; // already paired
    caseSel.group.attach(ns.group); // preserves world position
    // Snap Nike to a case-local resting spot just above the case base
    // (case origin Y is at the case base bottom). This guarantees the
    // Nike actually sits INSIDE the glass box even if it had drifted
    // away in world space.
    const baseH = (typeof DISPLAY_CASE_DIMS !== 'undefined') ? DISPLAY_CASE_DIMS.base : 0.025;
    ns.group.position.set(0, baseH + 0.005, 0);
    try {
      const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
      const sk = `item.${ns.label.replace(/\s+/g, '_')}`;
      cur[`${sk}.x`] = ns.group.position.x;
      cur[`${sk}.y`] = ns.group.position.y;
      cur[`${sk}.z`] = ns.group.position.z;
      let parents = cur['shelfSpacing.parents'];
      if (!parents || typeof parents !== 'object') parents = {};
      parents[ns.label] = 'Display case';
      cur['shelfSpacing.parents'] = parents;
      // Drop the Nike's individual shelf assignment — the Case carries it
      // now, and the Nike isn't a direct bookshelf child anymore so
      // registerShelfMembers wouldn't pick it up anyway.
      let assignments = cur['shelfSpacing.assignments'];
      if (assignments && assignments[ns.label]) {
        delete assignments[ns.label];
        cur['shelfSpacing.assignments'] = assignments;
      }
      localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
    } catch {}
    count++;
  }
  if (count > 0) {
    console.log(`[pair] re-parented ${count} Nike(s) under Display case (move case → both move).`);
    registerShelfMembers();
    applyShelfSpacing(loadShelfOffsets());
  }
}
window.__pairNikeUnderCase = pairNikeUnderCase;
// Inverse of pairNikeUnderCase: detach every Nike that's currently a
// child of the Display case, re-parent it under the bookshelf (preserving
// world position), and persist the new bookshelf-local coords + restore
// the 'B' shelf assignment.
function unpairNikeFromCase() {
  const caseSel = SELECTABLE.find((s) => s.label === 'Display case');
  if (!caseSel?.group) return 0;
  const bg = propGroups.bookshelf?.group;
  if (!bg) return 0;
  // Collect from BOTH the SELECTABLE list (in case Nike is a Case child)
  // AND from caseGroup.children (in case the SELECTABLE entry is stale).
  const candidates = new Set();
  for (const s of SELECTABLE) {
    if (s?.group && /nike|air ?mag/i.test(s.label || '') && s.group.parent === caseSel.group) {
      candidates.add(s);
    }
  }
  let count = 0;
  for (const ns of candidates) {
    bg.attach(ns.group); // preserves world position
    try {
      const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
      const sk = `item.${ns.label.replace(/\s+/g, '_')}`;
      cur[`${sk}.x`] = ns.group.position.x;
      cur[`${sk}.y`] = ns.group.position.y;
      cur[`${sk}.z`] = ns.group.position.z;
      let parents = cur['shelfSpacing.parents'];
      if (!parents || typeof parents !== 'object') parents = {};
      parents[ns.label] = 'bookshelf';
      cur['shelfSpacing.parents'] = parents;
      let assignments = cur['shelfSpacing.assignments'];
      if (!assignments || typeof assignments !== 'object') assignments = {};
      assignments[ns.label] = 'B';
      cur['shelfSpacing.assignments'] = assignments;
      localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
    } catch {}
    count++;
  }
  if (count > 0) {
    registerShelfMembers();
    applyShelfSpacing(loadShelfOffsets());
  }
  return count;
}
window.__unpairNikeFromCase = unpairNikeFromCase;
// One-shot recovery: if a previous build of this file auto-attached the
// Nike to the Display case and the editor persisted local-as-world coords,
// the Nike will spawn at the wrong place (often well below the desk). When
// we detect that pattern (label matches Nike + persisted Y < 0), wipe just
// the position keys for that item so loadProp falls back to the original
// bank-spawn target.
(function recoverNikePositionIfCorrupted() {
  try {
    const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    let changed = false;
    for (const k of Object.keys(stored)) {
      const m = k.match(/^item\.(.+)\.y$/);
      if (!m) continue;
      const label = m[1].replace(/_/g, ' ');
      if (!/nike|air ?mag/i.test(label)) continue;
      if (typeof stored[k] === 'number' && stored[k] < -0.2) {
        delete stored[`item.${m[1]}.x`];
        delete stored[`item.${m[1]}.y`];
        delete stored[`item.${m[1]}.z`];
        changed = true;
        console.warn(`[recover] cleared corrupted position for "${label}" — it will spawn at its original drop target.`);
      }
    }
    if (changed) localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(stored));
  } catch {}
})();

// Tuning panel removed — all values locked above. Helpers live on
// `window.__*` for ad-hoc tweaks from the browser console.
const __NO_TUNING_PANEL = true; if (false) { (function mountTuningPanel() {
  const wrap = document.createElement('div');
  wrap.style.cssText = `
    position: absolute; top: 16px; left: 16px;
    background: rgba(0,0,0,0.6);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 12px;
    padding: 12px 14px; backdrop-filter: blur(12px);
    color: #fff; font: 12px system-ui, sans-serif; z-index: 10;
    display: flex; flex-direction: column; gap: 14px;
    min-width: 240px;
  `;
  function addSection(title) {
    const sec = document.createElement('div');
    sec.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    const t = document.createElement('div');
    t.textContent = title;
    t.style.cssText = 'font-weight:600;opacity:0.9;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;';
    sec.appendChild(t);
    wrap.appendChild(sec);
    return sec;
  }
  function addSlider(parent, label, min, max, step, initial, onChange) {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;flex-direction:column;gap:2px;font-size:11px;';
    const top = document.createElement('div');
    top.style.cssText = 'display:flex;justify-content:space-between;opacity:0.85;';
    const lab = document.createElement('span'); lab.textContent = label;
    const val = document.createElement('span'); val.textContent = initial.toFixed(3);
    top.appendChild(lab); top.appendChild(val);
    row.appendChild(top);
    const sl = document.createElement('input');
    sl.type = 'range'; sl.min = min; sl.max = max; sl.step = step; sl.value = initial;
    sl.style.cssText = 'width:100%;height:22px;';
    sl.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      val.textContent = v.toFixed(3);
      onChange(v);
    });
    row.appendChild(sl);
    parent.appendChild(row);
  }

  const deskSec = addSection('Desk');
  addSlider(deskSec, 'Slide right', -0.6, 0.6, 0.005, -0.355, applyDeskSlide);

  const shelfSec = addSection('Bookshelf');
  addSlider(shelfSec, 'Slide right', -1.5, 1.5, 0.005, 0, setBookshelfSlide);

  const stripSec = addSection('Shelf strip lights');
  addSlider(stripSec, 'Strips X (depth)', -0.3, 0.3, 0.005, 0, setStripOffsetX);
  addSlider(stripSec, 'Strips Z (along)', -0.5, 0.5, 0.005, 0, setStripOffsetZ);
  addSlider(stripSec, 'Warmth',           0,    1,   0.005, 0.85, setStripWarmth);
  addSlider(stripSec, 'Brightness',       0,    4,   0.01,  1.20, setStripBrightness);

  document.body.appendChild(wrap);
})(); }

// ---------- Wall-E boot plant: load + place on a bookshelf compartment ---
// Free-floating prop wrapped in a Three.js Group so we can move/scale/rotate
// it from a small UI panel without touching the GLB.
const bootGroup = new THREE.Group();
bootGroup.name = '__bootPlant';
scene.add(bootGroup);

// Mask plane: clips the sand plate off the bottom of the boot. Locked at
// 0.028 m above the boot's base (set in applyBoot() — no slider).
// Six axis-aligned clipping planes around the boot — give the user a
// "crop box" so they can carve the sand off cleanly. Each plane is in
// WORLD space; updateBootMask() recenters them on the boot's live world
// position every frame. Defaults: tight bottom crop (0.028 m above the
// boot's base) and very generous box on the other sides (1 m, basically
// no clip) until the user dials them in.
const bootMaskPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);    // bottom (kept name for back-compat)
const bootClipTop    = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
const bootClipLeft   = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
const bootClipRight  = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
const bootClipBack   = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const bootClipFront  = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
const BOOT_CLIP_PLANES = [bootMaskPlane, bootClipTop, bootClipLeft, bootClipRight, bootClipBack, bootClipFront];
// Each entry is the OFFSET from the boot's world origin to that plane.
// Bottom = 0.028 (clip 28mm of sand). Others default to 1.0 m (no crop).
// Persisted under bootCrop.bottom/top/left/right/front/back.
const BOOT_CROP = { bottom: 0.028, top: 1.0, left: 1.0, right: 1.0, front: 1.0, back: 1.0 };
try {
  const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
  for (const k of ['bottom', 'top', 'left', 'right', 'front', 'back']) {
    const v = stored[`bootCrop.${k}`];
    if (typeof v === 'number') BOOT_CROP[k] = v;
  }
} catch {}
const BOOT_BOTTOM_LOCK = 0.028;     // legacy const, no longer used directly

makeGLTFLoader().load('/models/walle_boot.glb', (gltf) => {
  // Auto-fit + center using ALL meshes (no aggressive hiding this time —
  // the mask slider will let the user crop the sand off cleanly).
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = box.getSize(new THREE.Vector3());
  const targetH = 0.25;
  const s = targetH / Math.max(size.y, 0.0001);
  gltf.scene.scale.setScalar(s);

  gltf.scene.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(gltf.scene);
  const c = box2.getCenter(new THREE.Vector3());
  gltf.scene.position.set(-c.x, -box2.min.y, -c.z);

  // Attach the mask clipping plane to every material + force opaque so the
  // GLB's alphaMode=BLEND / MASK doesn't render the boot leather as see-through.
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    if (!o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    o.material = mats.map((m) => {
      const mat = m.clone();
      // Bottom mask: crops the messy sand/base at the bottom of the GLB.
      // The plane is in WORLD space; updateBootMask() (called every frame)
      // tracks the boot's actual world Y so the crop follows wherever the
      // user moves the boot.
      mat.clippingPlanes = BOOT_CLIP_PLANES;
      mat.clipShadows    = true;
      mat.transparent    = false;
      mat.opacity        = 1.0;
      mat.alphaTest      = 0.0;
      mat.alphaMap       = null;
      mat.depthWrite     = true;
      mat.side           = THREE.FrontSide;
      mat.needsUpdate    = true;
      return mat;
    });
    if (o.material.length === 1) o.material = o.material[0];
  });
  bootGroup.add(gltf.scene);
});

// Per-frame: update all six boot-crop planes from the boot's live world
// position + the BOOT_CROP offsets. The planes are in world space, so
// any boot/bookshelf movement requires this recompute.
const _bootMaskTmp = new THREE.Vector3();
const _bootMaskScale = new THREE.Vector3();
function updateBootMask() {
  if (!bootGroup || bootGroup.children.length === 0) return;   // GLB still loading
  bootGroup.updateMatrixWorld(true);
  bootGroup.getWorldPosition(_bootMaskTmp);
  bootGroup.getWorldScale(_bootMaskScale);
  const bx = _bootMaskTmp.x, by = _bootMaskTmp.y, bz = _bootMaskTmp.z;
  const sx = _bootMaskScale.x, sy = _bootMaskScale.y, sz = _bootMaskScale.z;
  // Crop offsets are stored in BOOT-LOCAL units, so we multiply by the
  // boot's current world scale before adding to the world position. This
  // keeps the crop window the same RELATIVE size when the boot is
  // resized (without this, a scaled-up boot kept its small crop window
  // and clipped through the visible mesh).
  bootMaskPlane.constant = -(by + BOOT_CROP.bottom * sy);
  bootClipTop.constant   =  (by + BOOT_CROP.top    * sy);
  bootClipLeft.constant  = -(bx - BOOT_CROP.left   * sx);
  bootClipRight.constant =  (bx + BOOT_CROP.right  * sx);
  bootClipBack.constant  = -(bz - BOOT_CROP.back   * sz);
  bootClipFront.constant =  (bz + BOOT_CROP.front  * sz);
  // Bank-spawned cropped boots — each follows its own world position
  // AND its own world scale, with the same BOOT_CROP offsets.
  if (_croppedBootClones.length === 0) return;
  for (const inst of _croppedBootClones) {
    if (!inst.group?.parent) continue;
    inst.group.updateMatrixWorld(true);
    inst.group.getWorldPosition(_bootMaskTmp);
    inst.group.getWorldScale(_bootMaskScale);
    const ix = _bootMaskTmp.x, iy = _bootMaskTmp.y, iz = _bootMaskTmp.z;
    const isx = _bootMaskScale.x, isy = _bootMaskScale.y, isz = _bootMaskScale.z;
    inst.planes[0].constant = -(iy + BOOT_CROP.bottom * isy);
    inst.planes[1].constant =  (iy + BOOT_CROP.top    * isy);
    inst.planes[2].constant = -(ix - BOOT_CROP.left   * isx);
    inst.planes[3].constant =  (ix + BOOT_CROP.right  * isx);
    inst.planes[4].constant = -(iz - BOOT_CROP.back   * isz);
    inst.planes[5].constant =  (iz + BOOT_CROP.front  * isz);
  }
}
const _croppedBootClones = [];     // [{ group, planes: [b,t,l,r,bk,fr] }]
function applyBootCropToGroup(group) {
  const planes = [
    new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
    new THREE.Plane(new THREE.Vector3(0, -1, 0), 0),
    new THREE.Plane(new THREE.Vector3(1, 0, 0), 0),
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
    new THREE.Plane(new THREE.Vector3(0, 0, -1), 0),
  ];
  group.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((m) => {
      m.clippingPlanes = planes;
      m.clipShadows = true;
      m.needsUpdate = true;
    });
  });
  _croppedBootClones.push({ group, planes });
  console.log(`[boot] crop applied to bank-spawned boot — ${_croppedBootClones.length} cropped boot(s) total.`);
}
window.__applyBootCropToGroup = applyBootCropToGroup;

// World-space anchor positions for each shelf compartment.
// Coord conversion notes:
//   Blender → Three.js : (x, y, z) → (x, z, -y).
//   Bookshelf wall is at Blender x=+1.30, recess depth 0.30, so center of
//   the recess in world X = +1.45.
//   Compartment Y spans (Blender y) -1.51 to -0.56, center -1.04 → Three.js
//   Z = +1.04. The bookshelf prop group is locked at z=+0.34, so total
//   world Z for compartment center = +1.04 + 0.34 = +1.38.
//   Heights (Blender z = Three.js Y): floor of each compartment is the top
//   of the divider below it (divider thickness 0.025 m).
const SHELF_BOOKSHELF_Z = 0.34;
const SHELF_X = 1.45;
const SHELF_Z = 1.04 + SHELF_BOOKSHELF_Z;     // +1.38
const BOOT_PRESETS = {
  big:    { x: SHELF_X, y: 0.825, z: SHELF_Z, label: 'Big bottom' },
  small1: { x: SHELF_X, y: 1.380, z: SHELF_Z, label: 'Small 1' },
  small2: { x: SHELF_X, y: 1.735, z: SHELF_Z, label: 'Small 2' },
  small3: { x: SHELF_X, y: 2.095, z: SHELF_Z, label: 'Small 3' },
  small4: { x: SHELF_X, y: 2.445, z: SHELF_Z, label: 'Small 4' },
  desk:   { x: 0.0,     y: 0.75,  z: 1.85,    label: 'On desk' },
};

// Default boot pose — sits in the big-bottom shelf compartment of the
// bookshelf alcove. Local to the bookshelf group (depth-center, width-
// center, just above the big-bottom shelf top at y=0.825).
// Wall-E boot default — bookshelf-LOCAL coords inside the alcove on
// shelf A. Mirrors the Minecraft chest's local Y (0.82) so the boot's
// base sits on the wood; X/Z place it forward of the chest in the
// alcove. Without these defaults (or a persisted override), the boot
// would sit at world (3.481, 0.83, -1.620) — outside the visible alcove
// — and look like it had disappeared.
const bootState = { x: 1.45, y: 0.825, z: 1.38, scale: 1.160, rotY: 0 };
// Pull persisted edits in case the user has dragged the boot via gizmo
// or the item editor in a previous session — those writes go to the
// `item.Wall-E_boot.*` keys, same as any other selectable prop.
try {
  const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
  if (typeof stored['item.Wall-E_boot.x']     === 'number') bootState.x     = stored['item.Wall-E_boot.x'];
  if (typeof stored['item.Wall-E_boot.y']     === 'number') bootState.y     = stored['item.Wall-E_boot.y'];
  if (typeof stored['item.Wall-E_boot.z']     === 'number') bootState.z     = stored['item.Wall-E_boot.z'];
  if (typeof stored['item.Wall-E_boot.scale'] === 'number' && stored['item.Wall-E_boot.scale'] > 0.01) bootState.scale = stored['item.Wall-E_boot.scale'];
  if (typeof stored['item.Wall-E_boot.rotY']  === 'number') bootState.rotY  = stored['item.Wall-E_boot.rotY'];
} catch {}
function applyBoot() {
  bootGroup.position.set(bootState.x, bootState.y, bootState.z);
  bootGroup.scale.setScalar(bootState.scale);
  bootGroup.rotation.y = bootState.rotY;
  // Bottom mask plane disabled (materials no longer reference it). Kept
  // the variable definition so any legacy code paths don't TDZ.
}
function setBootPreset(key) {
  const p = BOOT_PRESETS[key];
  if (!p) return;
  bootState.x = p.x; bootState.y = p.y; bootState.z = p.z;
  applyBoot();
  if (window.__bootPanelSync) window.__bootPanelSync(bootState);
}
function setBootField(key, v) {
  bootState[key] = v;
  applyBoot();
}
window.__setBootPreset = setBootPreset;
window.__setBootField  = setBootField;

// Default placement: big bottom, slid right
applyBoot();

// ---- Boot control panel (top-right) -----------------------------------
// ---------- Direct-manipulation system (Blender-style gizmo) -------------
// Click a prop in the scene to attach the gizmo, drag the handles to
// translate/rotate/scale. Hot keys: T = move, R = rotate, S = scale,
// Esc = deselect. The HUD on screen shows live values + a Copy button so
// you can paste them back to lock things in.
// (SELECTABLE declared near the top of the file — see ABOVE for the array;
// makeSelectable is defined here as the consumer)
function makeSelectable(group, label) { SELECTABLE.push({ group, label }); }

// ---------- Bonsai leaves detach (extract as own selectable) -----------
// One-shot operation: pulls every `AutoLeaf_*` mesh out of the bonsai
// group and re-parents them into a fresh selectable group called
// "Bonsai leaves". Once detached, the leaves move/rotate/scale
// independently of the trunk — the user clicks on the leaves and gets
// the standard contextual editor with full transform sliders. The
// detach state is persisted under `bonsaiLeavesDetached.v1` so a
// reload re-detaches automatically. Idempotent — calling twice is a
// no-op.
// Detach EACH leaf into its own selectable group so the user can click
// a single pink leaf and drag/rotate/scale it independently of the
// other leaves and the trunk. Each leaf becomes "Bonsai leaf 1",
// "Bonsai leaf 2", etc. State + per-leaf transforms persist across
// reloads (flag `bonsaiLeavesDetached.v1`, transforms under
// `item.Bonsai_leaf_<N>.*`).
const BONSAI_LEAVES_FLAG_KEY = 'bonsaiLeavesDetached.v1';
let _bonsaiLeafGroups = [];   // array of per-leaf groups, in order
window.__detachBonsaiLeaves = function () {
  console.log('[bonsai] __detachBonsaiLeaves() called');
  if (_bonsaiLeafGroups.length > 0) {
    console.log('[bonsai] already detached — returning existing groups');
    return _bonsaiLeafGroups;
  }
  // -----------------------------------------------------------------
  // Find the leaf objects WHEREVER they actually live:
  // (a) live placements from `leafTool` — each is a clone of leaf.glb
  //     added directly to scene by the leaf placement tool
  // (b) baked-in leaves named `LeafPlaced_*` / `Leaf_*` / `PinkLeaf_*`
  //     that the Blender export script embeds into room.glb
  // (c) fallback: AutoLeaf_* / 0_10_* / pinkish meshes still nested
  //     inside `__propGroup_bonsai`
  // -----------------------------------------------------------------
  const leaves = [];
  const seen = new Set();
  const push = (o) => { if (o && !seen.has(o.uuid)) { seen.add(o.uuid); leaves.push(o); } };

  // (a) leafTool-placed leaves
  try {
    const live = window.__leafTool?.getLeafObjects?.() || [];
    live.forEach(push);
    if (live.length) console.log(`[bonsai] leafTool placements: ${live.length}`);
  } catch {}

  // (b) baked Leaf-named objects anywhere in the scene
  let bakedCount = 0;
  scene.traverse((o) => {
    if (!o || !o.name) return;
    if (o.name.startsWith('LeafPlaced_') || o.name.startsWith('Leaf_') ||
        o.name.startsWith('PinkLeaf_')   || o.name.startsWith('CherryBlossom_')) {
      push(o); bakedCount++;
    }
  });
  if (bakedCount) console.log(`[bonsai] baked Leaf-named objects: ${bakedCount}`);

  // (b2) SCENE-WIDE pink material scan — no distance filter. The
  // user's leaves can float WELL away from the bonsai trunk (e.g. a
  // pink cloud cluster placed to the side). We catch every pink-tinted
  // mesh in the scene; the only skip is meshes already inside a
  // non-bonsai user prop (Stitch case, masks, etc.). The pink color
  // threshold is loose so even a desaturated rose is caught.
  function _isPinkish(c) {
    if (!c || typeof c.r !== 'number') return false;
    // STRICT pink: red strongly dominant, green/blue depressed but
    // close to each other (so we don't catch wood, which has red >
    // green > blue with green clearly above blue). Cherry-blossom
    // pink is ~ (0.9, 0.55, 0.65) — green ≈ blue, both < 0.7 of red.
    // Wood is ~ (0.55, 0.35, 0.20) — green clearly above blue.
    if (c.r < 0.55) return false;
    if (c.g > c.r * 0.85) return false;          // red must dominate
    if (c.b > c.r * 0.85) return false;          // blue also damped
    // Reject wood-like browns: green should be close to OR below blue.
    if (c.g > c.b + 0.15) return false;
    return true;
  }
  // Bonsai center is logged for diagnostics but no longer used to
  // gate the search.
  const bonsaiCenter = new THREE.Vector3();
  if (propGroups.bonsai?.group) {
    propGroups.bonsai.group.updateMatrixWorld(true);
    propGroups.bonsai.group.getWorldPosition(bonsaiCenter);
    console.log(`[bonsai] bonsai world center: (${bonsaiCenter.x.toFixed(2)}, ${bonsaiCenter.y.toFixed(2)}, ${bonsaiCenter.z.toFixed(2)})`);
  }
  const _pos = new THREE.Vector3();
  let pinkCount = 0, pinkInventory = [];
  const SKIP_PROP_PREFIXES = [
    '__prop_hudsonCase', '__prop_treasureCase', '__prop_stitchCase',
    '__prop_displayCase', '__prop_nikeCase', '__prop_hoverboardCase',
    '__prop_vhsStand', '__prop_artFrame', '__prop_extraframe_',
    '__prop_journal_', '__prop_extraLight_', '__bookshelfMirror',
  ];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    if (seen.has(o.uuid)) return;
    let p = o; let skip = false;
    while (p) {
      const n = p.name || '';
      if (n.startsWith('__bonsaiLeafHalo')) { skip = true; break; }
      for (const pre of SKIP_PROP_PREFIXES) {
        if (n.startsWith(pre)) { skip = true; break; }
      }
      if (skip) break;
      p = p.parent;
    }
    if (skip) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!_isPinkish(mat?.color)) return;
    o.getWorldPosition(_pos);
    push(o);
    pinkCount++;
    if (pinkInventory.length < 12) {
      pinkInventory.push(`${o.name || '(unnamed)'} pos=(${_pos.x.toFixed(2)}, ${_pos.y.toFixed(2)}, ${_pos.z.toFixed(2)}) color=(${mat.color.r.toFixed(2)}, ${mat.color.g.toFixed(2)}, ${mat.color.b.toFixed(2)})`);
    }
  });
  console.log(`[bonsai] pink material scan: found ${pinkCount} pink mesh(es) in scene`, pinkInventory);

  // (c) fallback — leaves still inside the bonsai propGroup
  const bonsai = propGroups.bonsai?.group;
  if (bonsai) {
    const inventory = [];
    bonsai.traverse((o) => {
      if (!o.isMesh) return;
      const matName = Array.isArray(o.material) ? o.material[0]?.name : o.material?.name;
      inventory.push({ name: o.name || '(unnamed)', mat: matName || '?' });
    });
    console.log(`[bonsai] inventory of __propGroup_bonsai (${inventory.length} meshes):`, inventory);
    const leafRe = /leaf/i;
    const matLeafRe = /(leaf|foliage|green|moss|pink|cherry|blossom|sakura|petal)/i;
    function _isPinkish(c) {
      if (!c || typeof c.r !== 'number') return false;
      return c.r > 0.5 && c.g < c.r * 0.9 && c.b < c.r;
    }
    bonsai.traverse((o) => {
      if (!o.isMesh) return;
      const n = o.name || '';
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      const matName = (mat?.name || '').toString();
      const byName = n.startsWith('AutoLeaf_') || n.startsWith('0_10_') || leafRe.test(n);
      const byMatName = matLeafRe.test(matName);
      const byColor = _isPinkish(mat?.color);
      if (byName || byMatName || byColor) push(o);
    });
    bonsai.updateMatrixWorld(true);
  }

  if (leaves.length === 0) {
    console.warn('[bonsai] no leaves found anywhere — neither leafTool placements, baked Leaf-named objects, nor leaf-pattern meshes inside the bonsai. Try the leaf placement tool first, or paste the inventory log so I can target the right meshes.');
    alert('No leaves found yet. Open DevTools Console — if you see an inventory line, paste it back to me and I\'ll target those mesh names exactly.');
    return null;
  }
  console.log(`[bonsai] total leaves to detach: ${leaves.length}`);
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}'); } catch {}
  let hidden = [];
  try { hidden = JSON.parse(localStorage.getItem('hidden.props.v1') || '[]') || []; } catch {}
  const _wp = new THREE.Vector3();
  leaves.forEach((leaf, i) => {
    const idx = i + 1;
    // Pivot the per-leaf group at the leaf's world-space centroid so
    // the rotation gizmo feels natural around each individual leaf.
    leaf.getWorldPosition(_wp);
    const box = new THREE.Box3().setFromObject(leaf);
    const cx = (box.min.x + box.max.x) / 2;
    const cy = (box.min.y + box.max.y) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    const sizeVec = new THREE.Vector3();
    box.getSize(sizeVec);
    const grp = new THREE.Group();
    grp.name = `__prop_bonsaiLeaf_${idx}`;
    grp.position.set(cx, cy, cz);
    scene.add(grp);
    // Remember each leaf's ORIGINAL parent so reattach can put the
    // mesh back exactly where it came from — critical if a false-
    // positive (e.g. a desk plank) gets caught: reattach should
    // restore the desk, NOT shove it into the bonsai group.
    leaf.userData.__leafOrigParent = leaf.parent;
    // attach() converts the leaf's world transform into local — no jump.
    grp.attach(leaf);
    // --- Click-friendly improvements ---
    // 1) Force the leaf's material(s) to render double-sided so the
    //    raycaster catches flat leaf planes from either side (default
    //    FrontSide makes the backside invisible to raycasts).
    // 2) Make sure each leaf has a bounding sphere computed so raycast
    //    doesn't silently skip it.
    leaf.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        if (!m) return;
        m.side = THREE.DoubleSide;
        m.needsUpdate = true;
      });
      if (o.geometry) {
        if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
        if (!o.geometry.boundingBox)    o.geometry.computeBoundingBox();
      }
    });
    // 3) Invisible click "halo" — a transparent sphere ~1.6× the leaf's
    //    longest axis. Raycaster hits it just like the leaf, but it
    //    doesn't render visibly (opacity 0 + depthWrite off). Makes
    //    small leaves dramatically easier to click without changing
    //    their visual appearance.
    const halo = Math.max(sizeVec.x, sizeVec.y, sizeVec.z) * 0.8 + 0.005;
    const haloMesh = new THREE.Mesh(
      new THREE.SphereGeometry(halo, 8, 6),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
    );
    haloMesh.name = '__bonsaiLeafHalo';
    haloMesh.renderOrder = -1;          // render before everything (negligible cost since opacity=0)
    grp.add(haloMesh);
    const label = `Bonsai leaf ${idx}`;
    const safe = label.replace(/ /g, '_');
    const k = `item.${safe}`;
    if (typeof stored[`${k}.x`]    === 'number') grp.position.x = stored[`${k}.x`];
    if (typeof stored[`${k}.y`]    === 'number') grp.position.y = stored[`${k}.y`];
    if (typeof stored[`${k}.z`]    === 'number') grp.position.z = stored[`${k}.z`];
    if (typeof stored[`${k}.rotX`] === 'number') grp.rotation.x = stored[`${k}.rotX`];
    if (typeof stored[`${k}.rotY`] === 'number') grp.rotation.y = stored[`${k}.rotY`];
    if (typeof stored[`${k}.rotZ`] === 'number') grp.rotation.z = stored[`${k}.rotZ`];
    if (typeof stored[`${k}.scale`] === 'number' && stored[`${k}.scale`] > 0.01) grp.scale.setScalar(stored[`${k}.scale`]);
    if (Array.isArray(hidden) && hidden.includes(label)) grp.visible = false;
    makeSelectable(grp, label);
    _bonsaiLeafGroups.push(grp);
  });
  window.__bonsaiLeafGroups = _bonsaiLeafGroups;
  try { localStorage.setItem(BONSAI_LEAVES_FLAG_KEY, 'true'); } catch {}
  console.log(`[bonsai] detached ${_bonsaiLeafGroups.length} leaves into individual selectables — click any pink leaf to move it on its own.`);
  return _bonsaiLeafGroups;
};
window.__reattachBonsaiLeaves = function () {
  if (_bonsaiLeafGroups.length === 0) return;
  for (const grp of _bonsaiLeafGroups) {
    // For every mesh in this leaf group, restore it to its ORIGINAL
    // parent (stored on userData at detach time). If we somehow lost
    // the origParent (very old detach state), fall back to scene root
    // — preserves world position so nothing visually jumps.
    const leafMeshes = [];
    grp.traverse((o) => { if (o.isMesh && !o.name?.startsWith('__bonsaiLeafHalo')) leafMeshes.push(o); });
    leafMeshes.forEach((m) => {
      const orig = m.userData.__leafOrigParent;
      const target = orig && orig.parent !== null ? orig : scene;
      target.attach(m);   // preserves world transform
      delete m.userData.__leafOrigParent;
    });
    const idx = SELECTABLE.findIndex((s) => s.group === grp);
    if (idx >= 0) SELECTABLE.splice(idx, 1);
    scene.remove(grp);
  }
  _bonsaiLeafGroups = [];
  window.__bonsaiLeafGroups = _bonsaiLeafGroups;
  try { localStorage.removeItem(BONSAI_LEAVES_FLAG_KEY); } catch {}
  console.log('[bonsai] all leaves restored to original parents.');
};
window.__isBonsaiLeavesDetached = () => _bonsaiLeafGroups.length > 0;

// ---------- Simple pink-leaves OFFSET container ------------------------
// User-facing flow: open the bonsai's contextual editor → use the
// "Leaves X/Y/Z" sliders to translate the pink cherry-blossom geometry.
// Internally, the first time a slider is touched (or boot finds a
// persisted offset), every pink-saturated mesh in the scene is wrapped
// into one invisible container group at the origin; sliders then drive
// that group's position. Re-parenting preserves world transforms so
// nothing visually jumps.
let _leavesContainer = null;
let _leavesOffsetX = 0, _leavesOffsetY = 0, _leavesOffsetZ = 0;
(function _hydrateLeavesOffset() {
  try {
    const p = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    if (typeof p['bonsaiLeaves.offset.x'] === 'number') _leavesOffsetX = p['bonsaiLeaves.offset.x'];
    if (typeof p['bonsaiLeaves.offset.y'] === 'number') _leavesOffsetY = p['bonsaiLeaves.offset.y'];
    if (typeof p['bonsaiLeaves.offset.z'] === 'number') _leavesOffsetZ = p['bonsaiLeaves.offset.z'];
  } catch {}
})();
function _ensureLeavesContainer() {
  if (_leavesContainer) return _leavesContainer;
  // PRIMARY signal: material name. The room.glb's leaves use the
  // material `Leaf_Pink_A.008` (verified by inspecting the GLB).
  // Anything whose material name contains "leaf" is a leaf, full stop.
  function _isLeafByMaterialName(mat) {
    if (!mat || typeof mat.name !== 'string') return false;
    return /leaf/i.test(mat.name);
  }
  // FALLBACK signal: saturated pink color, for leaves placed at runtime
  // via the leaf placement tool (whose material clones get generic names).
  function _isPinkish(c) {
    if (!c || typeof c.r !== 'number') return false;
    if (c.r < 0.55) return false;
    if (c.g > c.r * 0.85) return false;
    if (c.b > c.r * 0.85) return false;
    if (c.g > c.b + 0.15) return false;
    return true;
  }
  // Narrow skip — only meshes that we're CERTAIN aren't leaves. We
  // deliberately do NOT skip `__propGroup_bonsai` contents or
  // `Object_*` / `BonsaiImport_*` names, since the leaves themselves
  // can live under those parents/names. The user's two complaints
  // (desk top + lamp light) are covered by `Desk_*`, `LuxoImport_*`,
  // `__propGroup_lamp`, and the luxo bulb-mesh reference.
  const NON_LEAF_PREFIXES = [
    'Desk_',             // desk parts (the desk top)
    'Mac', 'Macintosh',  // Macintosh body parts
    '2000_',             // Mac internal meshes
    'LuxoImport_',       // Luxo lamp body
    'Wall_', 'Floor_',   // room shell
    'Shelf_', 'ShelfBorder_', 'Decor_',  // bookshelf alcove
  ];
  // Specific containers to skip (NOT __propGroup_bonsai — leaves may
  // live inside the bonsai's own propGroup). User-created props
  // (anything named `__prop_<thing>` that ISN'T a propGroup) are also
  // skipped.
  const NON_LEAF_EXACT = new Set([
    '__bookshelfMirror', '__leavesContainer',
    '__propGroup_lamp', '__propGroup_bookshelf',
  ]);
  function _underProp(o) {
    if (o === window.__luxoBulbMesh) return true;
    let p = o;
    while (p) {
      const n = p.name || '';
      if (NON_LEAF_EXACT.has(n)) return true;
      // Specific user props (cases, frames, stands) — they start with
      // `__prop_` but NOT `__propGroup_`. Carefully phrased so the
      // bonsai's own propGroup (`__propGroup_bonsai`) is allowed.
      if (n.startsWith('__prop_') && !n.startsWith('__propGroup_')) return true;
      for (const pre of NON_LEAF_PREFIXES) {
        if (n.startsWith(pre)) return true;
      }
      p = p.parent;
    }
    return false;
  }
  // Diagnostic — log every pink mesh we find, grouped by whether it
  // passed each filter. Helps you see exactly what's matching.
  const _wp = new THREE.Vector3();
  const accepted = [];    // pink + not under a prop
  const rejectedProp = []; // pink BUT inside a prop group (skipped)
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    // Match if EITHER the material is named like a leaf OR the color
    // passes the strict pink test.
    const isLeaf = _isLeafByMaterialName(mat) || _isPinkish(mat?.color);
    if (!isLeaf) return;
    o.getWorldPosition(_wp);
    const entry = `${o.name || '(unnamed)'} mat=${mat?.name || '?'} pos=(${_wp.x.toFixed(2)}, ${_wp.y.toFixed(2)}, ${_wp.z.toFixed(2)}) color=(${mat?.color?.r.toFixed(2) ?? '?'}, ${mat?.color?.g.toFixed(2) ?? '?'}, ${mat?.color?.b.toFixed(2) ?? '?'})`;
    if (_underProp(o)) {
      rejectedProp.push(entry);
    } else {
      accepted.push({ obj: o, entry });
    }
  });
  console.log(`[bonsai-leaves] scan complete — ${accepted.length} pink mesh(es) accepted, ${rejectedProp.length} pink mesh(es) skipped (inside __prop_*)`);
  if (accepted.length > 0) console.log('[bonsai-leaves] accepted:', accepted.map((a) => a.entry));
  if (rejectedProp.length > 0) console.log('[bonsai-leaves] skipped (inside a prop):', rejectedProp);
  if (accepted.length === 0) {
    console.warn('[bonsai-leaves] no pink meshes accepted. If you see pink in the scene, the material may not pass the strict pink test (need r≥0.55, g and b both ≤ 0.85·r, g ≤ b+0.15). Tell me what got rejected and I\'ll loosen.');
    return null;
  }
  const grp = new THREE.Group();
  grp.name = '__leavesContainer';
  grp.position.set(0, 0, 0);
  scene.add(grp);
  accepted.forEach((a) => grp.attach(a.obj));
  _leavesContainer = grp;
  grp.position.set(_leavesOffsetX, _leavesOffsetY, _leavesOffsetZ);
  console.log(`[bonsai-leaves] wrapped ${accepted.length} mesh(es) into __leavesContainer — sliders now move them.`);
  return grp;
}
function _persistLeavesOffset() {
  try {
    const p = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    p['bonsaiLeaves.offset.x'] = _leavesOffsetX;
    p['bonsaiLeaves.offset.y'] = _leavesOffsetY;
    p['bonsaiLeaves.offset.z'] = _leavesOffsetZ;
    localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(p));
  } catch {}
}
window.__setLeavesOffsetX = (v) => {
  _leavesOffsetX = v;
  const g = _ensureLeavesContainer();
  if (g) {
    g.position.x = v;
    console.log(`[leaves] setX(${v.toFixed(3)}) → container at (${g.position.x.toFixed(3)}, ${g.position.y.toFixed(3)}, ${g.position.z.toFixed(3)}), children=${g.children.length}`);
  } else {
    console.warn(`[leaves] setX(${v.toFixed(3)}) — NO container (scan found 0 leaves). Drag is a no-op.`);
  }
  _persistLeavesOffset();
};
window.__setLeavesOffsetY = (v) => {
  _leavesOffsetY = v;
  const g = _ensureLeavesContainer();
  if (g) { g.position.y = v; }
  else { console.warn(`[leaves] setY(${v.toFixed(3)}) — NO container, drag is a no-op.`); }
  _persistLeavesOffset();
};
window.__setLeavesOffsetZ = (v) => {
  _leavesOffsetZ = v;
  const g = _ensureLeavesContainer();
  if (g) { g.position.z = v; }
  else { console.warn(`[leaves] setZ(${v.toFixed(3)}) — NO container, drag is a no-op.`); }
  _persistLeavesOffset();
};
window.__getLeavesOffsetX = () => _leavesOffsetX;
window.__getLeavesOffsetY = () => _leavesOffsetY;
window.__getLeavesOffsetZ = () => _leavesOffsetZ;

// ---------- Placed-leaf persistence -----------------------------------
// User-placed leaves (added via "Place leaf mode" in the bonsai
// editor) live inside `__leavesContainer`. We snapshot each one's
// local-to-container transform + color into localStorage so they
// survive reload. The container's own offset is persisted separately
// via `bonsaiLeaves.offset.*`.
const PLACED_LEAVES_KEY = 'bonsaiLeaves.placed.v1';
window.__persistPlacedLeaves = function () {
  if (!_leavesContainer) return;
  const list = [];
  _leavesContainer.children.forEach((child) => {
    if (!child.userData?.__placedLeaf) return;
    list.push({
      px: +child.position.x.toFixed(4),
      py: +child.position.y.toFixed(4),
      pz: +child.position.z.toFixed(4),
      qx: +child.quaternion.x.toFixed(4),
      qy: +child.quaternion.y.toFixed(4),
      qz: +child.quaternion.z.toFixed(4),
      qw: +child.quaternion.w.toFixed(4),
      sx: +child.scale.x.toFixed(4),
      sy: +child.scale.y.toFixed(4),
      sz: +child.scale.z.toFixed(4),
      color: child.userData.__color || '#e23a8e',
    });
  });
  try {
    localStorage.setItem(PLACED_LEAVES_KEY, JSON.stringify(list));
    console.log(`[leaves] persisted ${list.length} placed leaf(ves)`);
  } catch (err) { console.warn('[leaves] persist failed', err); }
};
window.__restorePlacedLeaves = function () {
  if (!_leavesContainer) return 0;
  if (!window.__leafTool?.spawnFromData) return 0;
  let list = [];
  try { list = JSON.parse(localStorage.getItem(PLACED_LEAVES_KEY) || '[]'); }
  catch { list = []; }
  // Avoid double-restore: if any placed leaves already exist in the
  // container, skip (we don't want to duplicate on a second call).
  const alreadyPlaced = _leavesContainer.children.some((c) => c.userData?.__placedLeaf);
  if (alreadyPlaced) return 0;
  let added = 0;
  for (const data of list) {
    const leaf = window.__leafTool.spawnFromData(data);
    if (!leaf) continue;
    leaf.userData.__placedLeaf = true;
    leaf.userData.__color = data.color;
    _leavesContainer.add(leaf);
    added++;
  }
  if (added > 0) console.log(`[leaves] restored ${added} placed leaf(ves) from localStorage`);
  return added;
};

// On boot — once the leaf template loads, if there are any persisted
// placed leaves OR a non-zero container offset, build the container
// and restore them. The leaf template can finish loading BEFORE
// room.glb (leaf.glb is tiny, room.glb is multi-MB), so we retry
// up to ~4 seconds if the first scan finds zero leaves.
window.__onLeafTemplateReady = function () {
  let savedList = [];
  try { savedList = JSON.parse(localStorage.getItem(PLACED_LEAVES_KEY) || '[]'); } catch {}
  const hasOffset = (_leavesOffsetX !== 0 || _leavesOffsetY !== 0 || _leavesOffsetZ !== 0);
  if (savedList.length === 0 && !hasOffset) return;
  let tries = 0;
  function tryBuild() {
    const c = _ensureLeavesContainer();
    if (c) {
      window.__restorePlacedLeaves();
      console.log('[leaves] boot auto-restore complete.');
      return;
    }
    if (++tries < 10) {
      setTimeout(tryBuild, 500);
    } else {
      console.warn('[leaves] boot auto-restore gave up after 10 tries — open the bonsai editor to trigger a manual build.');
    }
  }
  setTimeout(tryBuild, 300);
};

const tControls = new TransformControls(camera, renderer.domElement);
tControls.size = 0.8;
// r167+ API: TransformControls is no longer an Object3D — add its helper
// (which IS an Object3D) to the scene so the gizmo actually renders.
// In WEBSITE mode the gizmo is created but never shown (no item gets
// `.attach()`-ed because the click-to-select handler early-returns).
scene.add(tControls.getHelper());
let tDragging = false;
const undoStack = [];
const UNDO_MAX = 60;
function pushUndoSnapshot(group) {
  if (!group) return;
  // Push a transform-restore entry into the GLOBAL undo stack so Cmd+Z
  // anywhere in the app can roll back this gizmo move.
  const snap = {
    pos: group.position.clone(),
    quat: group.quaternion.clone(),
    scl: group.scale.clone(),
  };
  pushGlobalUndo((s) => {
    group.position.copy(s.pos);
    group.quaternion.copy(s.quat);
    group.scale.copy(s.scl);
    if (selectedItem && selectedItem.group === group) refreshHud();
  }, snap);
}
function undoLast() { popGlobalUndo(); }
window.__undo = undoLast;

// Persist the selected item's full transform (position, rotation, scale)
// to localStorage under `item.<label>.*`. Used after a gizmo drag ends so
// the new placement sticks across reloads. Skips items without a label
// (shouldn't happen) or with empty groups.
function persistSelectedItemTransform(sel) {
  if (!sel?.group || !sel.label) return;
  try {
    const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    const sk = `item.${sel.label.replace(/\s+/g, '_')}`;
    const g = sel.group;
    cur[`${sk}.x`]    = g.position.x;
    cur[`${sk}.y`]    = g.position.y;
    cur[`${sk}.z`]    = g.position.z;
    cur[`${sk}.rotX`] = g.rotation.x;
    cur[`${sk}.rotY`] = g.rotation.y;
    cur[`${sk}.rotZ`] = g.rotation.z;
    cur[`${sk}.scale`] = g.scale.x;
    localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
  } catch (err) {
    console.warn('[persist] gizmo save failed', err);
  }
}
tControls.addEventListener('dragging-changed', (e) => {
  tDragging = e.value;
  controls.enabled = !e.value;
  if (e.value && selectedItem) {
    // Snapshot pre-drag state so Undo can restore it.
    pushUndoSnapshot(selectedItem.group);
  } else if (!e.value && selectedItem) {
    // Drag ended — persist the new transform so reload picks it up.
    persistSelectedItemTransform(selectedItem);
    // If this group is a paired follower, update the pair-lock's offset
    // so its NEW position becomes the locked relationship. Without this
    // the next frame would yank it back to the old offset.
    if (typeof recomputeAllPairOffsetsForGroup === 'function') {
      recomputeAllPairOffsetsForGroup(selectedItem.group);
    }
    // Persist the new pair offset (for the follower or for any
    // followers anchored on this group) so reload restores it.
    if (typeof persistPairOffset === 'function') {
      // If the just-dragged group is itself a follower, save its offset.
      if (selectedItem.label) persistPairOffset(selectedItem.label);
      // If it's an anchor, walk all followers anchored on it and save
      // their offsets too (they didn't change but we still want them
      // serialized after any prior in-memory tweaks).
      _pairLocked.forEach((info, follower) => {
        if (info.anchorGroup === selectedItem.group) {
          const sel = SELECTABLE.find((s) => s.group === follower);
          if (sel?.label) persistPairOffset(sel.label);
        }
      });
    }
  }
});

// HUD --------------------------------------------------------------------
const hud = document.createElement('div');
hud.style.cssText = `
  position: absolute; top: 16px; right: 16px;
  background: rgba(0,0,0,0.7);
  border: 1px solid rgba(255,255,255,0.10);
  border-radius: 12px;
  padding: 12px 14px; backdrop-filter: blur(12px);
  color: #fff; font: 12px system-ui, sans-serif; z-index: 10;
  min-width: 240px; display: none;
`;
hud.innerHTML = `
  <div style="font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">
    <span id="__hudName">—</span>
  </div>
  <div style="display:flex;gap:6px;margin-bottom:10px;">
    <button id="__modeT" style="flex:1;padding:5px 8px;border-radius:6px;border:1px solid rgba(255,200,80,0.5);background:rgba(255,200,80,0.18);color:#fff;cursor:pointer;font-size:11px;">Move (T)</button>
    <button id="__modeR" style="flex:1;padding:5px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:#fff;cursor:pointer;font-size:11px;">Rotate (R)</button>
    <button id="__modeS" style="flex:1;padding:5px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:#fff;cursor:pointer;font-size:11px;">Scale (S)</button>
  </div>
  <div id="__hudVals" style="font:11px ui-monospace, Menlo, monospace; opacity:0.92; line-height:1.55;"></div>
  <div id="__hudSliders" style="margin-top:10px;display:flex;flex-direction:column;gap:5px;"></div>
  <div style="display:flex;gap:6px;margin-top:10px;">
    <button id="__hudCopy" style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid rgba(120,200,255,0.5);background:rgba(120,200,255,0.15);color:#fff;cursor:pointer;font-size:11px;font-weight:600;">📋 Copy</button>
    <button id="__hudClose" style="padding:6px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:#fff;cursor:pointer;font-size:11px;">✕</button>
  </div>
`;
// 🚫 BUILD-ONLY — gizmo HUD (Move/Rotate/Scale buttons + Copy + ✕)
// stays out of the DOM in website mode. Element still exists so the
// rest of the file's hud.style.display / hud.querySelector calls
// don't throw, they just no-op.
if (IS_BUILD_MODE) document.body.appendChild(hud);
const hudName  = hud.querySelector('#__hudName');
const hudVals  = hud.querySelector('#__hudVals');
const modeBtns = { translate: hud.querySelector('#__modeT'), rotate: hud.querySelector('#__modeR'), scale: hud.querySelector('#__modeS') };
function setGizmoMode(m) {
  tControls.setMode(m);
  Object.entries(modeBtns).forEach(([k, b]) => {
    const on = k === m;
    b.style.background = on ? 'rgba(255,200,80,0.18)' : 'transparent';
    b.style.borderColor = on ? 'rgba(255,200,80,0.5)' : 'rgba(255,255,255,0.18)';
  });
}
modeBtns.translate.addEventListener('click', () => setGizmoMode('translate'));
modeBtns.rotate.addEventListener('click',    () => setGizmoMode('rotate'));
modeBtns.scale.addEventListener('click',     () => setGizmoMode('scale'));
hud.querySelector('#__hudClose').addEventListener('click', () => {
  tControls.detach(); selectedItem = null; hud.style.display = 'none';
});

// Build precision sliders inside the HUD: 7 sliders (x, y, z, rotX/Y/Z, scale)
const hudSliderHost = hud.querySelector('#__hudSliders');
const SLIDER_DEFS = [
  { key: 'px', label: 'X',     min: -25, max: 25, step: 0.001, valueFmt: 3 },
  { key: 'py', label: 'Y',     min: -10, max: 25, step: 0.001, valueFmt: 3 },
  { key: 'pz', label: 'Z',     min: -25, max: 25, step: 0.001, valueFmt: 3 },
  { key: 'rx', label: 'rot X', min: -Math.PI, max: Math.PI, step: 0.005, valueFmt: 3 },
  { key: 'ry', label: 'rot Y', min: -Math.PI, max: Math.PI, step: 0.005, valueFmt: 3 },
  { key: 'rz', label: 'rot Z', min: -Math.PI, max: Math.PI, step: 0.005, valueFmt: 3 },
  { key: 's',  label: 'scale', min: 0.05, max: 20, step: 0.005, valueFmt: 3 },
];
const sliderInputs = {};
const sliderValEls = {};
let _suppressSliderEvents = false;
SLIDER_DEFS.forEach((d) => {
  const row = document.createElement('label');
  row.style.cssText = 'display:flex;align-items:center;gap:6px;font:11px system-ui;';
  const lab = document.createElement('span'); lab.textContent = d.label; lab.style.cssText = 'width:34px;opacity:0.85;';
  const sl = document.createElement('input');
  sl.type = 'range'; sl.min = d.min; sl.max = d.max; sl.step = d.step; sl.value = 0;
  sl.style.cssText = 'flex:1;height:18px;';
  const val = document.createElement('span'); val.textContent = '0.000';
  val.style.cssText = 'width:54px;text-align:right;font:11px ui-monospace, Menlo, monospace;';
  row.appendChild(lab); row.appendChild(sl); row.appendChild(val);
  hudSliderHost.appendChild(row);
  sliderInputs[d.key] = sl;
  sliderValEls[d.key] = val;
  // Snapshot pre-drag state on pointerdown so the Undo button reverts the
  // entire slider interaction in one click (matches the gizmo behaviour).
  sl.addEventListener('pointerdown', () => {
    if (selectedItem) pushUndoSnapshot(selectedItem.group);
  });
  sl.addEventListener('input', (e) => {
    if (_suppressSliderEvents || !selectedItem) return;
    const v = parseFloat(e.target.value);
    val.textContent = v.toFixed(d.valueFmt);
    const g = selectedItem.group;
    if (d.key === 'px') g.position.x = v;
    else if (d.key === 'py') g.position.y = v;
    else if (d.key === 'pz') g.position.z = v;
    else if (d.key === 'rx') g.rotation.x = v;
    else if (d.key === 'ry') g.rotation.y = v;
    else if (d.key === 'rz') g.rotation.z = v;
    else if (d.key === 's')  g.scale.setScalar(v);
    refreshHudText();
  });
});

let selectedItem = null;
const _hudWorldPos = new THREE.Vector3();
const _hudWorldQuat = new THREE.Quaternion();
const _hudWorldScale = new THREE.Vector3();
const _hudWorldEuler = new THREE.Euler();
function refreshHudText() {
  if (!selectedItem) return;
  const g = selectedItem.group;
  // Show WORLD-space transform (groups parented to other groups would
  // otherwise display local coords, which is confusing when copy-pasting).
  g.updateWorldMatrix(true, false);
  g.getWorldPosition(_hudWorldPos);
  g.getWorldQuaternion(_hudWorldQuat);
  g.getWorldScale(_hudWorldScale);
  _hudWorldEuler.setFromQuaternion(_hudWorldQuat, g.rotation.order);
  const p = _hudWorldPos, r = _hudWorldEuler, s = _hudWorldScale;
  const fmt = (v) => v.toFixed(3);
  hudVals.innerHTML = `
    <div>pos x = <b>${fmt(p.x)}</b>   y = <b>${fmt(p.y)}</b>   z = <b>${fmt(p.z)}</b></div>
    <div>rot x = <b>${fmt(r.x)}</b>   y = <b>${fmt(r.y)}</b>   z = <b>${fmt(r.z)}</b></div>
    <div>scale = <b>${fmt(s.x)}</b></div>
  `;
}
function refreshHud() {
  if (!selectedItem) { hud.style.display = 'none'; return; }
  hud.style.display = 'block';
  hudName.textContent = selectedItem.label;
  refreshHudText();
  // Sync slider positions/values with the live group transform
  _suppressSliderEvents = true;
  const g = selectedItem.group;
  const setSlider = (k, v) => {
    const sl = sliderInputs[k];
    sl.value = v;
    sliderValEls[k].textContent = v.toFixed(3);
  };
  setSlider('px', g.position.x);
  setSlider('py', g.position.y);
  setSlider('pz', g.position.z);
  setSlider('rx', g.rotation.x);
  setSlider('ry', g.rotation.y);
  setSlider('rz', g.rotation.z);
  setSlider('s',  g.scale.x);
  _suppressSliderEvents = false;
}
tControls.addEventListener('objectChange', refreshHud);
// Also fan out to every registered control panel so its slider thumbs (and
// the underlying state, which Copy reads) stay in sync with the gizmo.
tControls.addEventListener('objectChange', () => {
  for (const fn of PANEL_SYNCS) fn();
});

hud.querySelector('#__hudCopy').addEventListener('click', async () => {
  if (!selectedItem) return;
  const g = selectedItem.group;
  const txt = `${selectedItem.label}: ` +
              `pos=(${g.position.x.toFixed(3)}, ${g.position.y.toFixed(3)}, ${g.position.z.toFixed(3)}) ` +
              `rot=(${g.rotation.x.toFixed(3)}, ${g.rotation.y.toFixed(3)}, ${g.rotation.z.toFixed(3)}) ` +
              `scale=${g.scale.x.toFixed(3)}`;
  try {
    await navigator.clipboard.writeText(txt);
    hud.querySelector('#__hudCopy').textContent = '✓ Copied';
    setTimeout(() => { hud.querySelector('#__hudCopy').textContent = '📋 Copy values'; }, 1400);
  } catch {
    console.log(txt);
  }
});

// Click-to-select via raycaster ------------------------------------------
const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
let _dragJustEnded = false;
tControls.addEventListener('mouseUp', () => {
  _dragJustEnded = true;
  setTimeout(() => { _dragJustEnded = false; }, 120);
  // Drag-end persist: write the current transform of whatever the gizmo
  // is attached to, into `item.<safeLabel>.{x,y,z,rotX,rotY,rotZ,scale}`.
  // Without this, dragging via the gizmo updates the in-memory position
  // but never saves — so any drag was lost on reload (mask stands and
  // similar that don't auto-fan-out via slider applyAll).
  try {
    if (!selectedItem || !selectedItem.group || !selectedItem.label) return;
    const g = selectedItem.group;
    const safe = selectedItem.label.replace(/\s+/g, '_');
    const KEY = 'desk-portfolio:positions:v1';
    const cur = JSON.parse(localStorage.getItem(KEY) || '{}');
    cur[`item.${safe}.x`] = +g.position.x.toFixed(4);
    cur[`item.${safe}.y`] = +g.position.y.toFixed(4);
    cur[`item.${safe}.z`] = +g.position.z.toFixed(4);
    cur[`item.${safe}.rotX`] = +g.rotation.x.toFixed(4);
    cur[`item.${safe}.rotY`] = +g.rotation.y.toFixed(4);
    cur[`item.${safe}.rotZ`] = +g.rotation.z.toFixed(4);
    cur[`item.${safe}.scale`] = +g.scale.x.toFixed(4);
    localStorage.setItem(KEY, JSON.stringify(cur));
  } catch (err) { console.warn('[gizmo] drag-end persist failed', err); }
});
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (tDragging || _dragJustEnded) return;
  // Visitor / WEBSITE mode — no item selection / gizmo. Clicks are
  // reserved for camera mode pills and (eventually) the inner
  // portfolio screen.
  if (IS_WEBSITE_MODE) return;
  // Leaf placement mode owns clicks while it's active — the leafTool
  // handles the click separately to drop a new leaf. We early-return
  // so this select-via-raycaster doesn't ALSO fire and yank focus to
  // whatever is under the cursor.
  if (window.__leafTool?.isPlacementActive?.()) return;
  _ndc.x = (e.clientX / window.innerWidth) * 2 - 1;
  _ndc.y = -(e.clientY / window.innerHeight) * 2 + 1;
  _ray.setFromCamera(_ndc, camera);
  // Vespa mesh-picker: when set by the editor, the next click on the
  // canvas raycasts INSIDE the Vespa group and assigns the hit mesh to
  // the chosen role (front wheel / handlebar / kickstand).
  if (window.__meshPickMode && window.__meshPickMode.group) {
    const pm = window.__meshPickMode;
    const hits = _ray.intersectObject(pm.group, true);
    const meshHit = hits.find((h) => h.object && h.object.isMesh);
    if (meshHit) {
      try { pm.assign(meshHit.object); } catch (err) { console.warn('[mesh-pick] assign failed', err); }
    }
    window.__meshPickMode = null;
    e.stopPropagation();
    e.preventDefault();
    return;
  }
  // Pick the SELECTABLE that OWNS the closest mesh the ray actually hit.
  // The previous logic raycasted each SELECTABLE separately and picked
  // the smallest first-hit distance, but `intersectObject(group, true)`
  // recurses through everything under that group. That meant a
  // SELECTABLE registered for the room (e.g. the Mac screen surface
  // whose inner GLB scene shares a "Scene" group with walls/floor)
  // could swallow clicks on smaller items that were closer to the user
  // — the wall in the SAME subtree was hit at a closer distance than
  // the visible item the user was actually clicking.
  //
  // New approach: do ONE world-space raycast against the full scene
  // graph, then for the nearest hit walk up parents to find the first
  // ancestor that's registered in SELECTABLE.
  const groupToItem = new Map();
  for (const item of SELECTABLE) groupToItem.set(item.group, item);
  let hit = null;
  let hitDist = Infinity;
  const allHits = _ray.intersectObjects(scene.children, true);
  for (const h of allHits) {
    let p = h.object;
    while (p && !groupToItem.has(p)) p = p.parent;
    if (p && groupToItem.has(p)) {
      hit = groupToItem.get(p);
      hitDist = h.distance;
      break;   // closest hit wins; ordered by distance ascending
    }
  }
  if (hit) {
    selectedItem = hit;
    // Desk selection has no single group — never attach the gizmo, just
    // open the contextual panel. All other selections drive the gizmo.
    if (hit.label === 'Desk') {
      tControls.detach();
    } else {
      tControls.attach(hit.group);
    }
    refreshHud();
    if (typeof window.__onSelectionChange === 'function') window.__onSelectionChange(hit);
  } else {
    tControls.detach();
    selectedItem = null;
    hud.style.display = 'none';
    if (typeof window.__onSelectionChange === 'function') window.__onSelectionChange(null);
  }
});

// Hot keys
window.addEventListener('keydown', (e) => {
  if (e.key === 't' || e.key === 'T') setGizmoMode('translate');
  else if (e.key === 'r' || e.key === 'R') setGizmoMode('rotate');
  else if (e.key === 's' || e.key === 'S') setGizmoMode('scale');
  else if (e.key === 'Escape') { tControls.detach(); selectedItem = null; hud.style.display = 'none'; }
  else if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undoLast(); }
});
// Expose a manual deselect so the Sliders menu button + console can call it.
window.__deselectAll = () => {
  try {
    tControls.detach();
    selectedItem = null;
    if (hud) hud.style.display = 'none';
  } catch {}
};

// ---------- Cmd+C / Cmd+V item duplication ----------------------------
// Copy: snapshot the currently selected group (kept by reference until
// next copy). Paste: deep-clone that group, register as a new
// SELECTABLE, and PERSIST the clone in `clonedItems.v1` so it
// re-spawns on every reload. The clone inherits drag-end persistence
// automatically — moving via the gizmo saves under `item.<NewLabel>.*`.
const CLONED_ITEMS_KEY = 'clonedItems.v1';
function _readClonedItems() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CLONED_ITEMS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
function _writeClonedItems(list) {
  try { localStorage.setItem(CLONED_ITEMS_KEY, JSON.stringify(list)); } catch {}
}
// Build a fresh clone from a source SELECTABLE — shared by Cmd+V and
// the boot-time restore so behavior stays identical.
function _materializeClone(sourceGroup, newLabel, offsetXZ = 0.05) {
  const clone = sourceGroup.clone(true);
  clone.position.x += offsetXZ;
  clone.position.z += offsetXZ;
  clone.name = `__prop_paste_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`;
  scene.add(clone);
  // Apply any persisted transform for this newLabel (in case the user
  // dragged it in a previous session).
  try {
    const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    const safe = newLabel.replace(/ /g, '_');
    const k = `item.${safe}`;
    if (typeof stored[`${k}.x`]    === 'number') clone.position.x = stored[`${k}.x`];
    if (typeof stored[`${k}.y`]    === 'number') clone.position.y = stored[`${k}.y`];
    if (typeof stored[`${k}.z`]    === 'number') clone.position.z = stored[`${k}.z`];
    if (typeof stored[`${k}.rotX`] === 'number') clone.rotation.x = stored[`${k}.rotX`];
    if (typeof stored[`${k}.rotY`] === 'number') clone.rotation.y = stored[`${k}.rotY`];
    if (typeof stored[`${k}.rotZ`] === 'number') clone.rotation.z = stored[`${k}.rotZ`];
    if (typeof stored[`${k}.scale`] === 'number' && stored[`${k}.scale`] > 0.01) clone.scale.setScalar(stored[`${k}.scale`]);
    const hidden = JSON.parse(localStorage.getItem('hidden.props.v1') || '[]');
    if (Array.isArray(hidden) && hidden.includes(newLabel)) clone.visible = false;
  } catch {}
  makeSelectable(clone, newLabel);
  return clone;
}
let _itemClipboard = null;
// Pure copy/paste functions — used by both the keyboard shortcuts AND
// the Sliders-menu buttons so a single bug fix covers both paths.
window.__copySelectedItem = function () {
  if (!selectedItem || !selectedItem.group) {
    console.warn('[clipboard] nothing selected to copy. Click an item in the scene first.');
    return false;
  }
  _itemClipboard = { group: selectedItem.group, label: selectedItem.label };
  console.log('[clipboard] copied:', selectedItem.label, '(group:', selectedItem.group.name + ')');
  return true;
};
window.__pasteItem = function () {
  if (!_itemClipboard) {
    console.warn('[clipboard] nothing to paste — copy something first.');
    return null;
  }
  console.log('[clipboard] pasting from:', _itemClipboard.label);
  return _doPasteFromClipboard();
};
window.addEventListener('keydown', (e) => {
  // Skip while typing in a text input — we don't want Cmd+C of slider
  // values to also clone the selected item.
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
  const isCmd = e.metaKey || e.ctrlKey;
  if (!isCmd) return;
  if (e.key === 'c' || e.key === 'C') {
    if (window.__copySelectedItem()) e.preventDefault();
  } else if (e.key === 'v' || e.key === 'V') {
    if (!_itemClipboard) {
      console.log('[clipboard] nothing to paste — Cmd+C something first');
      return;
    }
    e.preventDefault();
    _doPasteFromClipboard();
  }
});
function _doPasteFromClipboard() {
  if (!_itemClipboard) return null;
  const original = _itemClipboard.group;
  const baseLabel = _itemClipboard.label;
  // Unique label across SELECTABLE + saved clone list.
  const existingLabels = new Set();
  SELECTABLE.forEach((s) => existingLabels.add(s.label));
  _readClonedItems().forEach((c) => existingLabels.add(c.newLabel));
  let n = 2;
  let newLabel = `${baseLabel} (copy)`;
  while (existingLabels.has(newLabel)) newLabel = `${baseLabel} (copy ${n++})`;

  const clone = _materializeClone(original, newLabel, 0.05);
  let meshCount = 0, lightCount = 0;
  clone.traverse((o) => {
    if (o.isMesh) meshCount++;
    else if (o.isLight) lightCount++;
  });
  console.log(`[clipboard] cloned ${meshCount} mesh(es), ${lightCount} light(s); world position (${clone.position.x.toFixed(3)}, ${clone.position.y.toFixed(3)}, ${clone.position.z.toFixed(3)}); children=${clone.children.length}`);

  // Persist so reload re-spawns.
  const list = _readClonedItems();
  list.push({ sourceLabel: baseLabel, newLabel, t: Date.now() });
  _writeClonedItems(list);

  // Persist the clone's spawn transform immediately.
  try {
    const safe = newLabel.replace(/\s+/g, '_');
    const KEY = 'desk-portfolio:positions:v1';
    const cur = JSON.parse(localStorage.getItem(KEY) || '{}');
    cur[`item.${safe}.x`]     = +clone.position.x.toFixed(4);
    cur[`item.${safe}.y`]     = +clone.position.y.toFixed(4);
    cur[`item.${safe}.z`]     = +clone.position.z.toFixed(4);
    cur[`item.${safe}.rotX`]  = +clone.rotation.x.toFixed(4);
    cur[`item.${safe}.rotY`]  = +clone.rotation.y.toFixed(4);
    cur[`item.${safe}.rotZ`]  = +clone.rotation.z.toFixed(4);
    cur[`item.${safe}.scale`] = +clone.scale.x.toFixed(4);
    localStorage.setItem(KEY, JSON.stringify(cur));
  } catch (err) { console.warn('[clipboard] initial-position persist failed', err); }
  try { if (typeof window.__takeSnapshot === 'function') window.__takeSnapshot('paste'); } catch {}

  // Auto-select the clone.
  try {
    const newSel = SELECTABLE.find((s) => s.group === clone);
    if (newSel) {
      selectedItem = newSel;
      tControls.attach(clone);
      refreshHud();
      if (typeof window.__onSelectionChange === 'function') window.__onSelectionChange(newSel, true);
    }
  } catch (err) { console.warn('[clipboard] auto-select after paste failed', err); }
  console.log('[clipboard] pasted as:', newLabel, '— SAVED to clonedItems.v1.');
  return clone;
}
setGizmoMode('translate');

// ---------- Boot-time RESTORE of persisted cloned items ---------------
// Every Cmd+V paste appends `{ sourceLabel, newLabel }` to
// `clonedItems.v1`. On boot, after the scene + all originals are
// loaded, walk that list and re-materialize each clone from its source.
// Polls every 500ms for up to 6 seconds — handles lazily-loaded
// sources (bank items, etc.) registering after the first attempt.
(function _restoreClonedItemsOnBoot() {
  const MAX_TRIES = 12;
  let tries = 0;
  function attempt() {
    tries++;
    const list = _readClonedItems();
    if (list.length === 0) return;
    let materialized = 0;
    const stillMissing = [];
    const survivors = [];
    for (const entry of list) {
      // Already restored?
      if (SELECTABLE.some((s) => s.label === entry.newLabel)) {
        survivors.push(entry); continue;
      }
      const source = SELECTABLE.find((s) => s.label === entry.sourceLabel);
      if (!source) { stillMissing.push(entry); survivors.push(entry); continue; }
      try {
        _materializeClone(source.group, entry.newLabel, 0);
        materialized++;
        survivors.push(entry);
      } catch (err) {
        console.warn('[clones] materialize failed for', entry.newLabel, err);
        survivors.push(entry);
      }
    }
    _writeClonedItems(survivors);
    if (materialized > 0) console.log(`[clones] boot-restored ${materialized} clone(s); ${stillMissing.length} still missing source`);
    if (stillMissing.length > 0 && tries < MAX_TRIES) setTimeout(attempt, 500);
    else if (stillMissing.length > 0)
      console.warn('[clones] gave up after ' + MAX_TRIES + ' tries — sources never loaded:',
                   stillMissing.map((m) => m.sourceLabel));
  }
  setTimeout(attempt, 1000);
})();

// ---------- Load childhood books + Finn's sword + register selectability -
function loadProp({ id, label, glbPath, target, scaleTarget, parent = scene }) {
  const group = new THREE.Group();
  group.name = `__prop_${id}`;
  group.position.set(target.x, target.y, target.z);
  // 🛡 Apply persisted transform BEFORE adding to scene. Otherwise the
  // prop renders briefly at its Blender-authored `target` position, then
  // jumps to the saved localStorage position on the next contextual-editor
  // pass — which the user sees as a visible "snap." Reading localStorage
  // once here and seeding the group transform fixes that without breaking
  // the contextual-editor's two-way binding (it just overwrites these
  // values whenever the user drags the gizmo).
  try {
    const _persistedAll = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    const _sk = `item.${(label || '').toString().replace(/\s+/g, '_')}`;
    if (typeof _persistedAll[`${_sk}.x`]     === 'number') group.position.x = _persistedAll[`${_sk}.x`];
    if (typeof _persistedAll[`${_sk}.y`]     === 'number') group.position.y = _persistedAll[`${_sk}.y`];
    if (typeof _persistedAll[`${_sk}.z`]     === 'number') group.position.z = _persistedAll[`${_sk}.z`];
    if (typeof _persistedAll[`${_sk}.rotX`]  === 'number') group.rotation.x = _persistedAll[`${_sk}.rotX`];
    if (typeof _persistedAll[`${_sk}.rotY`]  === 'number') group.rotation.y = _persistedAll[`${_sk}.rotY`];
    if (typeof _persistedAll[`${_sk}.rotZ`]  === 'number') group.rotation.z = _persistedAll[`${_sk}.rotZ`];
    const _sScale = _persistedAll[`${_sk}.scale`];
    if (typeof _sScale === 'number' && _sScale > 0.01) group.scale.setScalar(_sScale);
  } catch {}
  parent.add(group);
  makeGLTFLoader().load(glbPath, (gltf) => {
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = box.getSize(new THREE.Vector3());
    const s = scaleTarget / Math.max(Math.max(size.x, size.y, size.z), 0.0001);
    gltf.scene.scale.setScalar(s);
    gltf.scene.updateMatrixWorld(true);
    const box2 = new THREE.Box3().setFromObject(gltf.scene);
    const c = box2.getCenter(new THREE.Vector3());
    gltf.scene.position.set(-c.x, -box2.min.y, -c.z);
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true; o.receiveShadow = true;
      if (!o.material) return;
      // Force OPAQUE on all materials. Many GLBs ship with alphaMode=BLEND
      // baked in, which Three.js translates to transparent=true, making
      // pieces of the model render see-through. We disable that here while
      // keeping alphaTest so MASK-mode cutouts (leaf cards, fur cards) still
      // work correctly.
      const hasVertexColors = !!(o.geometry && o.geometry.attributes && o.geometry.attributes.color);
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      o.material = mats.map((m) => {
        // Preserve genuine translucency — only force opaque if the source
        // material wasn't doing real glass/transmission work (those have
        // transmission > 0 OR ior set explicitly). This keeps texture-based
        // alphaMaps + decals + Lego transparent bricks rendering correctly.
        const looksLikeRealTranslucency = (
          (typeof m.transmission === 'number' && m.transmission > 0.001) ||
          (m.alphaMap != null) ||
          (typeof m.alphaTest === 'number' && m.alphaTest > 0)
        );
        if (!looksLikeRealTranslucency) {
          m.transparent = false;
          m.opacity = 1.0;
        }
        m.depthWrite = true;
        // Lego models commonly ship per-mesh COLOR_0 vertex attributes
        // (the brick colors). Without `vertexColors = true`, the renderer
        // ignores them and the whole model reads as flat white/grey. This
        // is the most common cause of "I don't see the colors" on Lego
        // GLBs (Lightning McQueen, AT-ATs, …). Safe to enable for any
        // mesh that has the attribute — non-Lego meshes won't have it.
        if (hasVertexColors) m.vertexColors = true;
        m.needsUpdate = true;
        return m;
      });
      if (o.material.length === 1) o.material = o.material[0];
    });
    group.add(gltf.scene);
    // If the GLB shipped with embedded animation clips (e.g. the Pixar
    // lamp's "Jump"), wire an AnimationMixer that loops every clip. The
    // mixer is tracked in window.__animMixers and ticked from the render
    // loop. Stored on group.userData so a subsequent remove cleans up.
    //
    // Special case: the Pixar lamp's "Jump" clip starts with a wind-up
    // (the front half) and ends with the actual hop. The user wants
    // only the second half — so we use AnimationUtils.subclip to trim
    // the first 50% off the original clip before playing.
    // Some GLBs ship with an animation we don't actually want to play
    // (e.g. the Minecraft chest opens/closes its lid in a 1-channel clip
    // — looks weird as an idle loop). Allow individual labels to opt
    // out of auto-play.
    const ANIM_AUTOPLAY_BLOCKLIST = /minecraft.?chest|chest$|woody/i;
    const animBlocked = ANIM_AUTOPLAY_BLOCKLIST.test(`${label || ''} ${glbPath || ''}`);
    if (gltf.animations && gltf.animations.length > 0 && !animBlocked) {
      try {
        const isPixarLamp = /pixar.?lamp|luxo/i.test(`${label || ''} ${glbPath || ''}`);
        const mixer = new THREE.AnimationMixer(gltf.scene);
        // For the Pixar lamp we track the ORIGINAL clip + its current
        // trim state on the group so the contextual editor can
        // dynamically rebuild the action when the user moves the trim
        // sliders. Default trim = front half (was the prior behavior).
        let lampState = null;
        if (isPixarLamp) {
          const orig = gltf.animations[0];
          let stored = {};
          try { stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}'); } catch {}
          lampState = {
            originalClip: orig,
            duration: orig.duration,
            trimStart: typeof stored['pixarLamp.trimStart'] === 'number' ? stored['pixarLamp.trimStart'] : orig.duration * 0.5,
            trimEnd:   typeof stored['pixarLamp.trimEnd']   === 'number' ? stored['pixarLamp.trimEnd']   : 0,
            speed:     typeof stored['pixarLamp.speed']     === 'number' ? stored['pixarLamp.speed']     : 1.0,
            paused:    !!stored['pixarLamp.paused'],
            currentAction: null,
            mixer,
          };
          group.userData.__pixarLampState = lampState;
        }
        gltf.animations.forEach((clip) => {
          let useClip = clip;
          if (isPixarLamp && clip === gltf.animations[0]) {
            useClip = makeLampSubclip(clip, lampState.trimStart, lampState.trimEnd) || clip;
          }
          const action = mixer.clipAction(useClip);
          action.setLoop(THREE.LoopRepeat, Infinity);
          action.clampWhenFinished = false;
          action.enabled = true;
          if (isPixarLamp && lampState) {
            action.timeScale = lampState.speed;
            action.paused = lampState.paused;
            lampState.currentAction = action;
          }
          action.play();
        });
        group.userData.__animMixer = mixer;
        group.userData.__animClips = gltf.animations.map((c) => c.name || '(unnamed)');
        if (!window.__animMixers) window.__animMixers = [];
        window.__animMixers.push(mixer);
        console.log(`[anim] "${label}" — playing ${gltf.animations.length} clip(s): ${group.userData.__animClips.join(', ')}`);
        // Pixar lamp: cache bones + spawn the bulb light rig so it
        // matches the older Luxo's lighting.
        if (isPixarLamp) {
          attachPixarLampRig(group);
          if (!window.__pixarLamps) window.__pixarLamps = [];
          window.__pixarLamps.push(group);
        }
      } catch (err) { console.warn(`[anim] failed to set up mixer for "${label}"`, err); }
    }
    // If this is a bank-spawned "Walle boot cropped" (or any boot from
    // the items bank), wire per-instance clip planes that follow this
    // group's world position. Same BOOT_CROP values, applied to a fresh
    // set of planes — so the bank-dropped boot crops its own sand exactly
    // like the original.
    if (group !== bootGroup &&
        /(walle.?boot|wall.?e.?boot|boot.?cropped)/i.test(`${label || ''} ${glbPath || ''}`)) {
      try { applyBootCropToGroup(group); } catch (err) { console.warn('[boot] crop apply failed', err); }
    }
    // Death Star — the GLB ships with its OWN emissive texture (the
    // creator's hand-painted window-light map on the "Death_Star"
    // material) plus a green laser emissive on the equatorial dish. We
    // preserve those and just dial up emissiveIntensity so the windows
    // pop in shadow + ensure colorSpace is correct on the emissive map.
    // The Glow slider in the editor multiplies the intensity further;
    // the Shininess slider scales roughness.
    // Woody (Toy Story) — handles the new RIGGED variant
    // (woody_toy_story_rig_free_download.glb). GLTFLoader brings in a
    // full Mixamo skeleton; we find each bone by its mixamorig:* name
    // and pose it directly. The animation auto-play block (further up)
    // already excludes Woody so the embedded "mixamo.com" idle clip
    // doesn't override our pose.
    if (/woody/i.test(`${label || ''} ${glbPath || ''}`)) {
      try {
        function matches(name, suffix) {
          if (!name) return false;
          return new RegExp(`${suffix}(?:[_\\d]|$)`, 'i').test(name);
        }
        function findBone(suffix) {
          let found = null;
          gltf.scene.traverse((o) => {
            if (found) return;
            if (o.isSkinnedMesh && o.skeleton && o.skeleton.bones) {
              const m = o.skeleton.bones.find((b) => b && matches(b.name, suffix));
              if (m) found = m;
            }
          });
          if (found) return found;
          gltf.scene.traverse((o) => { if (!found && matches(o.name, suffix)) found = o; });
          return found;
        }
        gltf.scene.traverse((o) => {
          if (!o.isSkinnedMesh || !o.skeleton?.bones) return;
          if (o.userData.__woodyDumped) return;
          o.userData.__woodyDumped = true;
          console.log(`[woody] skeleton has ${o.skeleton.bones.length} bones (first 12):`,
            o.skeleton.bones.slice(0, 12).map((b) => b?.name).join(', '));
        });
        // FULL hinge map — every joint the editor lets the user pick.
        // Suffix ↔ key mapping kept consistent with Mixamo naming.
        const HINGE_KEYS = [
          'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
          'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
          'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
          'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
          'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
        ];
        const bones = {};
        for (const k of HINGE_KEYS) bones[k] = findBone(k);
        group.userData.__woodyBones = bones;
        group.userData.__woodyHingeKeys = HINGE_KEYS;
        // Snapshot bind-pose rotations — used to reset to "straight".
        const restPose = {};
        for (const [k, b] of Object.entries(bones)) {
          if (b) restPose[k] = { x: b.rotation.x, y: b.rotation.y, z: b.rotation.z };
        }
        group.userData.__woodyRestPose = restPose;
        // Apply persisted full-pose if any. Default pose = straight
        // (just keep the bind-pose rotations — no extra rotation).
        let stored = {};
        try { stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}'); } catch {}
        const sk = `item.${(label || '').replace(/\s+/g, '_')}`;
        const persisted = stored[`${sk}.woody.fullPose`];
        if (persisted && typeof persisted === 'object') {
          for (const [k, rot] of Object.entries(persisted)) {
            const b = bones[k];
            if (!b || !rot) continue;
            if (typeof rot.x === 'number') b.rotation.x = rot.x;
            if (typeof rot.y === 'number') b.rotation.y = rot.y;
            if (typeof rot.z === 'number') b.rotation.z = rot.z;
          }
        }
        const found = Object.values(bones).filter(Boolean).length;
        console.log(`[woody] rigged — ${found}/${HINGE_KEYS.length} hinges located, applied ${persisted ? 'persisted' : 'standing (bind)'} pose.`);
      } catch (err) { console.warn('[woody] pose setup failed', err); }
    }
    // Vespa scooter — meshes are generic-named, so auto-detection often
    // misses. The editor lets the user MANUALLY pick which mesh is the
    // front wheel / handlebar / kickstand by clicking it. Persisted
    // assignments live under `vespa.pick.<role>` (mesh names). On load,
    // we honor those picks if present; otherwise we fall back to a
    // heuristic best-guess.
    if (/vespa|scooter/i.test(`${label || ''} ${glbPath || ''}`)) {
      try {
        gltf.scene.updateMatrixWorld(true);
        group.userData.__vespaSceneRoot = gltf.scene;
        rebuildVespaRig(group, label);
      } catch (err) { console.warn('[vespa] control setup failed', err); }
    }
    // Thor hammer — the GLB ships with every material at metallic=0,
    // roughness=0.95, which reads as matte plastic. Promote the metal
    // pieces to polished chrome (metalness ≈ 1, roughness ≈ 0.12) and
    // leave the leather wrap (lather + grip) mostly matte. The user
    // wants the TOP 25% of the model untouched — that's the leather
    // hand strap, which should stay matte regardless of material name.
    if (/thor.?hammer|mjolnir/i.test(`${label || ''} ${glbPath || ''}`)) {
      try {
        // Compute the full hammer bbox once so we can skip meshes that
        // sit in the top 25% (the strap).
        gltf.scene.updateMatrixWorld(true);
        const hbb = new THREE.Box3().setFromObject(gltf.scene);
        const ymin = hbb.min.y, ymax = hbb.max.y;
        const topThreshold = ymin + (ymax - ymin) * 0.75; // anything ABOVE this is in the top 25%
        const _meshBox = new THREE.Box3();
        let metals = 0, leathers = 0, topSkipped = 0;
        group.traverse((o) => {
          if (!o.isMesh || !o.material) return;
          // Per-mesh bbox center test — meshes whose center sits above
          // the threshold get the matte/leather treatment regardless of
          // their material name.
          _meshBox.setFromObject(o);
          const meshCenterY = (_meshBox.min.y + _meshBox.max.y) / 2;
          const inTopBand = meshCenterY > topThreshold;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach((m) => {
            if (typeof m.metalness !== 'number') return;
            const isLeatherName = /lather|leather|grip/i.test(m.name || '');
            if (inTopBand || isLeatherName) {
              m.metalness = 0.0;
              m.roughness = 0.65;
              m.envMapIntensity = 0.6;
              if (inTopBand && !isLeatherName) topSkipped++;
              else leathers++;
            } else {
              m.metalness = 0.95;
              m.roughness = 0.12;
              m.envMapIntensity = 1.6;
              metals++;
            }
            if (m.color) m.color.multiplyScalar(1.05);
            m.needsUpdate = true;
          });
        });
        console.log(`[thor-hammer] upgraded ${metals} metal + ${leathers} leather material(s); ${topSkipped} mesh(es) in top 25% kept matte.`);
      } catch (err) { console.warn('[thor-hammer] material upgrade failed', err); }
    }
    // Hoverboard — add a glossy clearcoat layer so the Shininess +
    // Reflection sliders have a visible deck to scrub against. The
    // shipped material is a matte PBR (metallicRoughness texture skews
    // it dark/diffuse), so reflection sliders alone barely move the
    // needle. We upgrade to MeshPhysicalMaterial with a clearcoat layer
    // that the editor's Shininess/Reflection AND a new "Clearcoat" slider
    // can drive directly.
    if (/hover.?board/i.test(`${label || ''} ${glbPath || ''}`)) {
      try {
        let upgraded = 0;
        group.traverse((o) => {
          if (!o.isMesh || !o.material) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          const upgradedMats = mats.map((m) => {
            if (m.isMeshPhysicalMaterial) return m; // already Physical
            if (!m.isMeshStandardMaterial) return m; // unsupported source
            const np = new THREE.MeshPhysicalMaterial({
              map: m.map,
              normalMap: m.normalMap,
              metalnessMap: m.metalnessMap,
              roughnessMap: m.roughnessMap,
              aoMap: m.aoMap,
              emissiveMap: m.emissiveMap,
              color: m.color.clone(),
              emissive: m.emissive ? m.emissive.clone() : new THREE.Color(0x000000),
              metalness: 0.85,
              roughness: 0.30,
              envMapIntensity: 1.4,
              clearcoat: 1.0,
              clearcoatRoughness: 0.05,
              transparent: m.transparent,
              opacity: m.opacity,
              side: m.side,
            });
            np.needsUpdate = true;
            upgraded++;
            return np;
          });
          o.material = upgradedMats.length === 1 ? upgradedMats[0] : upgradedMats;
        });
        console.log(`[hoverboard] upgraded ${upgraded} material(s) to MeshPhysicalMaterial with clearcoat — Shininess + Reflection + Clearcoat sliders now have effect.`);
      } catch (err) { console.warn('[hoverboard] upgrade failed', err); }
    }
    if (/death.?star/i.test(`${label || ''} ${glbPath || ''}`)) {
      try {
        let emissiveCount = 0;
        let mapCount = 0;
        group.traverse((o) => {
          if (!o.isMesh || !o.material) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach((m) => {
            if (!('emissive' in m)) return;
            emissiveCount++;
            if (m.emissiveMap) {
              mapCount++;
              m.emissiveMap.colorSpace = THREE.SRGBColorSpace;
              m.emissiveMap.needsUpdate = true;
              // Force emissive color to white so the textured windows
              // don't get tinted dim by the GLB's emissiveFactor (0.7).
              m.emissive = new THREE.Color(0xffffff);
              // Crank intensity hard — ACES tonemapping + bloom-threshold
              // (0.6) eat a lot of the linear value before pixels survive
              // to the screen. Numbers around 5–8 are needed for the
              // windows to actually bloom against the dark side.
              m.emissiveIntensity = 7.0;
            } else if (m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) > 0.05) {
              m.emissiveIntensity = 3.0; // green laser
            }
            if (typeof m.roughness === 'number') m.roughness = Math.min(m.roughness, 0.45);
            m.needsUpdate = true;
          });
        });
        console.log(`[death-star] processed ${emissiveCount} emissive material(s), ${mapCount} with emissive map.`);
        if (mapCount === 0) {
          console.warn('[death-star] NO emissive map found on any material — texture didn\'t survive GLTFLoader. Check that the GLB still has its embedded emissive PNG (image#3 in the inspection dump).');
        }
        if (!window.__deathStarLight) {
          const pl = new THREE.PointLight(0xffc977, 0.6, 2.0, 1.8);
          pl.position.set(0, 0, 0);
          pl.castShadow = false;
          group.add(pl);
          window.__deathStarLight = pl;
        }
      } catch (err) { console.warn('[death-star] glow setup failed', err); }
    }
    // After the GLB is loaded, apply any persisted item-editor state for
    // this label so the prop spawns at its saved position instead of
    // jumping the moment the user clicks it to edit.
    try {
      const storeKey = `item.${(label || '').replace(/\s+/g, '_')}`;
      const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
      const sx  = stored[`${storeKey}.x`];
      const sy  = stored[`${storeKey}.y`];
      const sz  = stored[`${storeKey}.z`];
      const srx = stored[`${storeKey}.rotX`];
      const sry = stored[`${storeKey}.rotY`];
      const srz = stored[`${storeKey}.rotZ`];
      const ss  = stored[`${storeKey}.scale`];
      // If this prop was re-parented under another prop in a previous
      // session, re-parent BEFORE applying the persisted position keys
      // (which were saved as PARENT-LOCAL coords). Without this the local
      // coords would be re-applied as scene-space and the prop would
      // teleport off-screen.
      //   parents[label] === 'bookshelf'    → child of the bookshelf group
      //   parents[label] === 'Display case' → child of __prop_displaycase
      // (Display case may itself be a bookshelf child via its own
      //  parent-flag handler — that's fine, the chain just propagates.)
      const parents = stored['shelfSpacing.parents'];
      // `'scene'` is the explicit-unparent sentinel set when a user moves
      // an item OFF a previously-locked parent (e.g. the bookshelf). Treat
      // it like having no parent flag — apply persisted scene-root coords
      // directly, don't poll for a non-existent parent.
      const rawWantsParent = parents && parents[label];
      const wantsParent = rawWantsParent === 'scene' ? null : rawWantsParent;
      function applyPersistedCoords() {
        if (typeof sx  === 'number') group.position.x = sx;
        if (typeof sy  === 'number') group.position.y = sy;
        if (typeof sz  === 'number') group.position.z = sz;
        if (typeof srx === 'number') group.rotation.x = srx;
        if (typeof sry === 'number') group.rotation.y = sry;
        if (typeof srz === 'number') group.rotation.z = srz;
        if (typeof ss  === 'number' && ss > 0.001) group.scale.setScalar(ss);
      }
      function findIntendedParent() {
        if (wantsParent === 'bookshelf') return propGroups.bookshelf?.group || null;
        if (wantsParent === 'Display case') return scene.getObjectByName('__prop_displaycase') || null;
        return null;
      }
      if (wantsParent) {
        // Persisted coords are PARENT-local. The intended parent might
        // not exist yet (room.glb is async). Poll up to ~10 s, re-parent
        // when ready, THEN apply coords. Without this defer, coords get
        // applied to a still-scene-rooted group as scene-space and the
        // prop ends up off-screen — which is the chest-keeps-resetting
        // symptom.
        let attempts = 0;
        const tryReparent = () => {
          const target = findIntendedParent();
          if (target) {
            if (group.parent !== target) target.add(group);
            applyPersistedCoords();
            return;
          }
          if (attempts > 100) { applyPersistedCoords(); return; }
          attempts++;
          setTimeout(tryReparent, 100);
        };
        tryReparent();
      } else {
        applyPersistedCoords();
      }
      // Apply persisted material multipliers (brightness / shininess /
      // reflection / glow) — without this they'd only take effect when
      // the user opens the contextual editor. We snapshot each material's
      // base values into userData so the editor can do its own delta math
      // without compounding our pre-multiplication.
      const sBri = stored[`${storeKey}.brightness`];
      const sShi = stored[`${storeKey}.shininess`];
      const sRef = stored[`${storeKey}.reflection`];
      const sGlo = stored[`${storeKey}.glow`];
      if (typeof sBri === 'number' || typeof sShi === 'number' ||
          typeof sRef === 'number' || typeof sGlo === 'number') {
        const bri = typeof sBri === 'number' ? sBri : 1;
        const shi = typeof sShi === 'number' ? sShi : 0;
        const ref = typeof sRef === 'number' ? sRef : 1;
        const glo = typeof sGlo === 'number' ? sGlo : 1;
        group.traverse((o) => {
          if (!o.isMesh || !o.material) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach((m) => {
            if (!m.userData) m.userData = {};
            if (m.userData._editorBaseSnapped !== true) {
              m.userData._baseRough = typeof m.roughness === 'number' ? m.roughness : 1;
              m.userData._baseEnv   = typeof m.envMapIntensity === 'number' ? m.envMapIntensity : 1;
              m.userData._baseColor = m.color ? m.color.clone() : new THREE.Color(0xffffff);
              m.userData._baseEmissiveI = typeof m.emissiveIntensity === 'number' ? m.emissiveIntensity : 1;
              m.userData._editorBaseSnapped = true;
            }
            if (typeof m.roughness === 'number') {
              m.roughness = Math.max(0.02, m.userData._baseRough * (1 - shi));
            }
            if (typeof m.envMapIntensity === 'number') {
              m.envMapIntensity = m.userData._baseEnv * ref;
            }
            if (m.color && m.userData._baseColor) {
              m.color.copy(m.userData._baseColor).multiplyScalar(bri);
            }
            if (typeof m.emissiveIntensity === 'number') {
              m.emissiveIntensity = m.userData._baseEmissiveI * glo;
            }
            m.needsUpdate = true;
          });
        });
      }
      try {
        const hidden = JSON.parse(localStorage.getItem('hidden.props.v1') || '[]');
        if (Array.isArray(hidden) && hidden.includes(label)) {
          group.visible = false;
        } else {
          group.visible = true;
        }
      } catch { group.visible = true; }
      if (stored[`${storeKey}.visible`] !== undefined) {
        delete stored[`${storeKey}.visible`];
        localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(stored));
      }
      // Restore the glass display case if the user toggled it on in a
      // previous session. Builds the same Box + edges geometry the
      // contextual editor's `buildDisplayCase` produces.
      if (stored[`${storeKey}.displayCase`] === true && !group.getObjectByName('__display_case')) {
        const savedQ = group.quaternion.clone();
        const savedP = group.position.clone();
        const savedSc = group.scale.clone();
        group.position.set(0, 0, 0);
        group.quaternion.set(0, 0, 0, 1);
        group.scale.set(1, 1, 1);
        group.updateMatrixWorld(true);
        const bb = new THREE.Box3().setFromObject(group);
        group.position.copy(savedP);
        group.quaternion.copy(savedQ);
        group.scale.copy(savedSc);
        group.updateMatrixWorld(true);
        if (isFinite(bb.min.x) && bb.max.x - bb.min.x > 0.001) {
          const size = bb.getSize(new THREE.Vector3());
          const center = bb.getCenter(new THREE.Vector3());
          const pad = 0.04;
          const geo = new THREE.BoxGeometry(size.x + pad * 2, size.y + pad * 2, size.z + pad * 2);
          const mat = new THREE.MeshPhysicalMaterial({
            color: 0xffffff, transparent: true, opacity: 0.10,
            roughness: 0.04, metalness: 0.0, transmission: 0.9,
            ior: 1.5, thickness: 0.5, envMapIntensity: 1.0,
            side: THREE.DoubleSide, depthWrite: false,
          });
          const caseMesh = new THREE.Mesh(geo, mat);
          caseMesh.name = '__display_case';
          caseMesh.position.copy(center);
          const edges = new THREE.LineSegments(
            new THREE.EdgesGeometry(geo),
            new THREE.LineBasicMaterial({ color: 0xa6c8ff, transparent: true, opacity: 0.35 }),
          );
          edges.name = '__display_case_edges';
          caseMesh.add(edges);
          group.add(caseMesh);
        }
      }
    } catch {}
  });
  makeSelectable(group, label);
  return group;
}

// New bonsai (v2). The original bonsai (trunk + pot inside room.glb +
// the extracted leaves group) STAYS VISIBLE. We just stack the new
// bonsai_v2 on top of the original so the user can compare / replace
// at their leisure.
const bonsaiV2Group = loadProp({
  id: 'bonsai_v2', label: 'Bonsai (v2)',
  glbPath: '/models/bonsai_v2.glb',
  target: { x: -0.85, y: 0.84, z: 1.20 },   // fallback — gets snapped below
  scaleTarget: 0.35,
});
// Brighten the new bonsai. The raw GLB materials read dark in this scene
// (low envMapIntensity vs. the warm desk lighting). We boost env-map
// reflection + drop roughness slightly + nudge color brightness once
// the GLB has finished streaming in.
{
  const _polish = setInterval(() => {
    if (!bonsaiV2Group.children.length) return;
    let touched = 0;
    bonsaiV2Group.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        if (typeof m.envMapIntensity === 'number') m.envMapIntensity = 1.6;
        if (typeof m.roughness === 'number') m.roughness = Math.max(0.35, m.roughness * 0.85);
        if (m.color && typeof m.color.multiplyScalar === 'function' && !m.userData.__brightened) {
          // Bump color value ~20% (clamped indirectly by the lighting pipeline)
          m.color.multiplyScalar(1.25);
          m.userData.__brightened = true;
        }
        m.needsUpdate = true;
        touched++;
      });
    });
    if (touched) {
      clearInterval(_polish);
      console.log(`[bonsai-v2] brightened ${touched} material(s)`);
    }
  }, 100);
  setTimeout(() => clearInterval(_polish), 12000);
}
// SNAP bonsai_v2 to the original bonsai's world position as soon as
// _extractBonsaiLeaves finishes (which happens after room.glb loads).
// `window.__bonsaiLeavesGroup` is the canonical pivot point for the
// existing bonsai cluster. We poll for it then snap once.
{
  const _BONSAI_V2_SNAP_FLAG = 'desk-portfolio:bonsai-v2-snap:v2026-05-14b';
  // LEAVES STAY VISIBLE. We only want to hunt down the remaining bonsai
  // trunk + pot meshes inside room.glb (the ones that AREN'T part of
  // the extracted leaves group). Logs everything found so we can tune
  // the search heuristic from the console.
  try {
    // First make sure leaves are NOT in the persisted hidden list
    const hidden = JSON.parse(localStorage.getItem('hidden.props.v1') || '[]');
    const filtered = hidden.filter((n) => n !== 'Bonsai leaves');
    if (filtered.length !== hidden.length) {
      localStorage.setItem('hidden.props.v1', JSON.stringify(filtered));
      console.log('[bonsai] restored Bonsai leaves visibility');
    }
    // And force the live leaves group visible whenever it appears.
    const _showLeaves = setInterval(() => {
      const g = window.__bonsaiLeavesGroup;
      if (g && !g.visible) {
        g.visible = true;
        console.log('[bonsai] forced leaves visible');
      }
    }, 250);
    setTimeout(() => clearInterval(_showLeaves), 30000);

    // Now find + hide trunk/pot. WIDER search than before + no size
    // cap. Logs every candidate so we can see what's matching.
    const _trunkPoll = setInterval(() => {
      const g = window.__bonsaiLeavesGroup;
      const root = window.__roomRoot;
      if (!g || !root) return;
      const lp = new THREE.Vector3();
      g.getWorldPosition(lp);
      let leafBottomY = lp.y - 0.05;
      try {
        const lb = new THREE.Box3().setFromObject(g);
        if (isFinite(lb.min.y)) leafBottomY = lb.min.y;
      } catch {}
      const RADIUS = 0.45;     // wider horizontal cone (covers wide pot)
      const Y_BELOW = 0.90;    // search further down
      const found = [];
      root.traverse((o) => {
        if (!o.isMesh) return;
        if (o === window.__bonsaiLeavesMesh) return;
        const bb = new THREE.Box3().setFromObject(o);
        if (!isFinite(bb.min.x)) return;
        const cx = (bb.min.x + bb.max.x) / 2;
        const cy = (bb.min.y + bb.max.y) / 2;
        const cz = (bb.min.z + bb.max.z) / 2;
        const sz = bb.getSize(new THREE.Vector3());
        const dx = cx - lp.x;
        const dz = cz - lp.z;
        const horiz = Math.sqrt(dx * dx + dz * dz);
        if (
          horiz < RADIUS &&
          cy < leafBottomY + 0.08 &&
          cy > leafBottomY - Y_BELOW &&
          // Reject anything bigger than 1m on its longest side
          // (eliminates desk, walls, floor) but allow normal pot+trunk
          Math.max(sz.x, sz.y, sz.z) < 1.0
        ) {
          found.push({ mesh: o, name: o.name, matName: (o.material?.name || ''), horiz, cy: cy - leafBottomY, dim: sz.length() });
        }
      });
      if (found.length) {
        console.log(`[bonsai] candidate meshes near leaves (horiz<${RADIUS}m, y in [${(-Y_BELOW).toFixed(2)},+0.08m] of leaf bottom):`);
        found.forEach((f, i) => console.log(`  [${i}] name="${f.name}" mat="${f.matName}" horiz=${f.horiz.toFixed(3)} dy=${f.cy.toFixed(3)} dim=${f.dim.toFixed(3)}`));
        found.forEach((f) => { f.mesh.visible = false; });
        console.log(`[bonsai] hid ${found.length} trunk/pot mesh(es)`);
        clearInterval(_trunkPoll);
      }
    }, 400);
    setTimeout(() => clearInterval(_trunkPoll), 30000);
  } catch (err) { console.warn('[bonsai] trunk hide setup failed', err); }
  // Snap-once: when the original bonsai is extracted, copy its world
  // position to bonsaiV2Group (unless the user has already dragged the
  // new bonsai — we check the persisted item.Bonsai_(v2).* keys).
  try {
    if (!localStorage.getItem(_BONSAI_V2_SNAP_FLAG)) {
      const _snapPoll = setInterval(() => {
        const orig = window.__bonsaiLeavesGroup;
        if (!orig) return;
        try {
          const wp = new THREE.Vector3();
          orig.getWorldPosition(wp);
          bonsaiV2Group.position.copy(wp);
          // Persist this snapped position so future loads use it (until
          // the user drags the v2 to a different spot, which overrides).
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur['item.Bonsai_(v2).x'] = wp.x;
          cur['item.Bonsai_(v2).y'] = wp.y;
          cur['item.Bonsai_(v2).z'] = wp.z;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
          localStorage.setItem(_BONSAI_V2_SNAP_FLAG, '1');
          console.log(`[bonsai-v2] snapped to original bonsai pos (${wp.x.toFixed(3)}, ${wp.y.toFixed(3)}, ${wp.z.toFixed(3)})`);
        } catch (err) { console.warn('[bonsai-v2] snap failed', err); }
        clearInterval(_snapPoll);
      }, 250);
      setTimeout(() => clearInterval(_snapPoll), 10000);
    }
  } catch {}
}

const booksGroup = loadProp({
  id: 'books', label: 'Childhood books',
  glbPath: '/models/childhood_books/scene.gltf',
  target: { x: 1.444, y: 0.915, z: 2.047 },
  scaleTarget: 0.18,
});
booksGroup.rotation.set(-1.621, 0.999, 0);
booksGroup.scale.setScalar(1.375);
const swordGroup = loadProp({
  id: 'sword', label: "Finn's sword",
  glbPath: '/models/finns_sword/scene.gltf',
  target: { x: 1.016, y: 1.198, z: 1.045 },
  scaleTarget: 0.65,
});
swordGroup.rotation.set(1.583, 0.518, -1.571);

// Monstera potted plant — to the screen-RIGHT of the desk (Three.js -X).
// Desk's -X edge is at x=-1.3; floor at y=0; place it on the floor a bit
// past the desk so it reads as next to the workspace.
const monsteraGroup = loadProp({
  id: 'monstera', label: 'Monstera plant',
  glbPath: '/models/monstera/scene.gltf',
  target: { x: -1.85, y: 0.0, z: 1.6 },
  scaleTarget: 1.10,
});

// Gromit mug — sits on the desk to the right of the Mac, after the desk
// has been slid by ~(0.49, 0, -4.89). Mac body ends up around world
// (0.49, ~0.78, -3.19), so the mug at (0.85, 0.78, -3.0) lands on the
// desk top, slightly forward and to the right of the Mac. Click the mug
// to edit; persistence keeps any tweaks.
//
// (Leftover one-time cleanup of `item.Gromit_mug.*` keys removed —
// it was running on EVERY reload and wiping any saved mug position
// the user had set, making it look like the mug "didn't remember"
// where they put it. Persistence now flows through `loadProp`'s
// load-time restore as intended.)
const gromitMugGroup = loadProp({
  id: 'gromit-mug-v2',                     // new id so any leftover SELECTABLE entries don't dup
  label: 'Gromit mug',
  glbPath: '/models/gromit_mug.glb',
  target: { x: 0.85, y: 0.78, z: -3.0 },
  scaleTarget: 0.14,
});

// ---------- Glass display case (atop the Mac) ---------------------------
// A small museum-style display: 5-sided glass box (open bottom) + a thin
// black base. Drop a Nike Air Mag, a figurine, anything inside via the
// scene gizmo or the contextual editor. Built from primitives so it's
// always available without an asset download. Live-resizable via sliders
// in the editor (DISPLAY_CASE_DIMS drives geometry rebuilds).
const DISPLAY_CASE_DIMS = {
  width:  0.30,   // X (along the Mac's left/right axis)
  depth:  0.22,   // Z
  base:   0.025,  // black base height
  glass:  0.36,   // glass case height
};
try {
  const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
  for (const k of ['width', 'depth', 'base', 'glass']) {
    const v = stored[`displayCase.${k}`];
    if (typeof v === 'number' && v > 0.005) DISPLAY_CASE_DIMS[k] = v;
  }
} catch {}
let _rebuildDisplayCase = () => {};   // populated below; called when dims change
window.__rebuildDisplayCase = () => _rebuildDisplayCase();
(function buildDisplayCase() {
  const group = new THREE.Group();
  group.name = '__prop_displaycase';
  scene.add(group);

  const wallT = 0.004;
  // Materials are stable — only geometries get disposed/rebuilt.
  const baseMat = new THREE.MeshStandardMaterial({
    color: 0x0d0d0d, roughness: 0.45, metalness: 0.25,
  });
  // Glass material — exposed via window.__caseGlassMat so the contextual
  // editor's "Glass material" sliders can mutate it live (transmission,
  // opacity, roughness, reflectivity, IOR, tint).
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 1.0,
    transmission: 0.95,
    thickness: 0.30,
    roughness: 0.02,
    metalness: 0.0,
    ior: 1.52,
    side: THREE.DoubleSide,
    envMapIntensity: 1.5,
    clearcoat: 1.0,
    clearcoatRoughness: 0.02,
    reflectivity: 0.5,
  });
  // Apply persisted glass-material settings on init.
  try {
    const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    if (typeof stored['caseGlass.opacity']      === 'number') glassMat.opacity      = stored['caseGlass.opacity'];
    if (typeof stored['caseGlass.transmission'] === 'number') glassMat.transmission = stored['caseGlass.transmission'];
    if (typeof stored['caseGlass.roughness']    === 'number') glassMat.roughness    = stored['caseGlass.roughness'];
    if (typeof stored['caseGlass.envMap']       === 'number') glassMat.envMapIntensity = stored['caseGlass.envMap'];
    if (typeof stored['caseGlass.thickness']    === 'number') glassMat.thickness    = stored['caseGlass.thickness'];
    if (typeof stored['caseGlass.ior']          === 'number') glassMat.ior          = stored['caseGlass.ior'];
    if (typeof stored['caseGlass.tintR']        === 'number' &&
        typeof stored['caseGlass.tintG']        === 'number' &&
        typeof stored['caseGlass.tintB']        === 'number') {
      glassMat.color.setRGB(stored['caseGlass.tintR'], stored['caseGlass.tintG'], stored['caseGlass.tintB']);
    }
    glassMat.needsUpdate = true;
  } catch {}
  window.__caseGlassMat = glassMat;

  // Persistent meshes — we swap out their geometry on resize instead of
  // rebuilding the whole tree. (White edge outline removed per user
  // preference — they want the case to read as glass alone, no painted
  // edges.)
  const base   = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), baseMat);
  const top    = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const front  = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const back   = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const left   = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const right  = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  base.castShadow = true; base.receiveShadow = true;
  // Click-through glass: the four side walls + top ignore raycasts so the
  // user can click models DISPLAYED INSIDE the case (e.g. a Nike air mag)
  // and the click hits THEM instead of the glass. The black base remains
  // clickable — that's the handle for selecting the case itself.
  const NO_RAYCAST = function () {};
  top.raycast = NO_RAYCAST;
  front.raycast = NO_RAYCAST;
  back.raycast = NO_RAYCAST;
  left.raycast = NO_RAYCAST;
  right.raycast = NO_RAYCAST;
  group.add(base, top, front, back, left, right);

  function rebuild() {
    const baseW = DISPLAY_CASE_DIMS.width;
    const baseD = DISPLAY_CASE_DIMS.depth;
    const baseH = DISPLAY_CASE_DIMS.base;
    const glassH = DISPLAY_CASE_DIMS.glass;
    const innerInset = 0.005;
    const glassW = Math.max(wallT * 4, baseW - innerInset * 2);
    const glassD = Math.max(wallT * 4, baseD - innerInset * 2);

    base.geometry.dispose();   base.geometry  = new THREE.BoxGeometry(baseW, baseH, baseD);
    base.position.set(0, baseH / 2, 0);

    top.geometry.dispose();    top.geometry   = new THREE.BoxGeometry(glassW, wallT, glassD);
    top.position.set(0, baseH + glassH - wallT / 2, 0);

    front.geometry.dispose();  front.geometry = new THREE.BoxGeometry(glassW, glassH, wallT);
    front.position.set(0, baseH + glassH / 2, glassD / 2 - wallT / 2);

    back.geometry.dispose();   back.geometry  = new THREE.BoxGeometry(glassW, glassH, wallT);
    back.position.set(0, baseH + glassH / 2, -glassD / 2 + wallT / 2);

    left.geometry.dispose();   left.geometry  = new THREE.BoxGeometry(wallT, glassH, glassD);
    left.position.set(-glassW / 2 + wallT / 2, baseH + glassH / 2, 0);

    right.geometry.dispose();  right.geometry = new THREE.BoxGeometry(wallT, glassH, glassD);
    right.position.set(glassW / 2 - wallT / 2, baseH + glassH / 2, 0);
  }
  rebuild();
  _rebuildDisplayCase = rebuild;

  // Default position: roughly on the Mac body (above the desk slide).
  group.position.set(0.487, 1.18, -3.19);

  // Honor persisted item state (so it stays where the user puts it).
  // If shelfSpacing.parents['Display case'] === 'bookshelf', we have to
  // re-parent the case to the bookshelf BEFORE applying the persisted
  // coords (which were saved as bookshelf-local). Otherwise local coords
  // applied as scene-space drop the case off-screen at scene-X ≈ -2.
  // The bookshelf might not exist yet (room.glb loads async), so we
  // poll for it and re-apply once the parent is available.
  try {
    const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    const k = 'item.Display_case';
    const parents = stored['shelfSpacing.parents'] || {};
    const wantsBookshelf = parents['Display case'] === 'bookshelf';
    function applyPersisted() {
      if (typeof stored[`${k}.x`]    === 'number') group.position.x = stored[`${k}.x`];
      if (typeof stored[`${k}.y`]    === 'number') group.position.y = stored[`${k}.y`];
      if (typeof stored[`${k}.z`]    === 'number') group.position.z = stored[`${k}.z`];
      if (typeof stored[`${k}.rotX`] === 'number') group.rotation.x = stored[`${k}.rotX`];
      if (typeof stored[`${k}.rotY`] === 'number') group.rotation.y = stored[`${k}.rotY`];
      if (typeof stored[`${k}.rotZ`] === 'number') group.rotation.z = stored[`${k}.rotZ`];
      if (typeof stored[`${k}.scale`] === 'number' && stored[`${k}.scale`] > 0.01) group.scale.setScalar(stored[`${k}.scale`]);
    }
    if (wantsBookshelf) {
      const tryReparent = (attempts = 0) => {
        const bg = propGroups.bookshelf?.group;
        if (bg && group.parent !== bg) {
          bg.add(group);  // raw add — coords are already bookshelf-local
          applyPersisted();
          return;
        }
        if (attempts > 60) { applyPersisted(); return; } // give up; apply as scene
        setTimeout(() => tryReparent(attempts + 1), 100);
      };
      tryReparent();
    } else {
      applyPersisted();
    }
    const hidden = JSON.parse(localStorage.getItem('hidden.props.v1') || '[]');
    if (Array.isArray(hidden) && hidden.includes('Display case')) group.visible = false;
  } catch {}

  makeSelectable(group, 'Display case');
})();

// ---------- Lightsaber display case (DISABLED) -------------------------
// Re-enabled per user request — same display logic as before, just
// without the auto-pair that previously clashed with other items. The
// case spawns at its persisted position (or a sane default on the desk)
// and stays put unless the user explicitly drags it.
const LIGHTSABER_CASE_ENABLED = true;
const LIGHTSABER_CASE_DIMS = {
  width: 0.65, depth: 0.18, base: 0.025, glass: 0.16,
  postSpacing: 0.42, postHeight: 0.08, postRadius: 0.013,
};
// Apply persisted dim overrides (set by the editor sliders) before the
// case builds, so the rebuild() runs with the user's values from the start.
try {
  const _stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
  for (const k of ['width','depth','base','glass','postSpacing','postHeight','postRadius']) {
    const v = _stored[`saberCase.${k}`];
    if (typeof v === 'number' && v > 0) LIGHTSABER_CASE_DIMS[k] = v;
  }
} catch {}
let _rebuildSaberCase = () => {};
window.__rebuildSaberCase = () => _rebuildSaberCase();
if (LIGHTSABER_CASE_ENABLED) (function buildLightsaberCase() {
  const group = new THREE.Group();
  group.name = '__prop_saberCase';
  scene.add(group);
  const wallT = 0.004;
  // Materials.
  const baseMat = new THREE.MeshStandardMaterial({
    color: 0x3a2616, roughness: 0.62, metalness: 0.05, // dark walnut
  });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, transparent: true, opacity: 1.0,
    transmission: 0.95, thickness: 0.30, roughness: 0.02,
    metalness: 0.0, ior: 1.52, side: THREE.DoubleSide,
    envMapIntensity: 1.5, clearcoat: 1.0, clearcoatRoughness: 0.02,
    reflectivity: 0.5,
  });
  const postMat = new THREE.MeshStandardMaterial({
    color: 0xc8c8c8, roughness: 0.18, metalness: 0.95,
  });
  // Apply persisted glass-material settings if any (shared key prefix).
  try {
    const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    if (typeof stored['saberCaseGlass.opacity']      === 'number') glassMat.opacity      = stored['saberCaseGlass.opacity'];
    if (typeof stored['saberCaseGlass.transmission'] === 'number') glassMat.transmission = stored['saberCaseGlass.transmission'];
    if (typeof stored['saberCaseGlass.roughness']    === 'number') glassMat.roughness    = stored['saberCaseGlass.roughness'];
    if (typeof stored['saberCaseGlass.envMap']       === 'number') glassMat.envMapIntensity = stored['saberCaseGlass.envMap'];
    if (typeof stored['saberCaseGlass.thickness']    === 'number') glassMat.thickness    = stored['saberCaseGlass.thickness'];
    if (typeof stored['saberCaseGlass.ior']          === 'number') glassMat.ior          = stored['saberCaseGlass.ior'];
    if (typeof stored['saberCaseGlass.tintR']        === 'number' &&
        typeof stored['saberCaseGlass.tintG']        === 'number' &&
        typeof stored['saberCaseGlass.tintB']        === 'number') {
      glassMat.color.setRGB(stored['saberCaseGlass.tintR'], stored['saberCaseGlass.tintG'], stored['saberCaseGlass.tintB']);
    }
    glassMat.needsUpdate = true;
  } catch {}
  window.__saberCaseGlassMat = glassMat;
  // Persistent meshes — geometry swaps on dim changes.
  const base   = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), baseMat);
  const top    = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const front  = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const back   = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const lftWall= new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const rgtWall= new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const postL  = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.014, 1, 16), postMat);
  const postR  = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.014, 1, 16), postMat);
  base.castShadow = true; base.receiveShadow = true;
  postL.castShadow = true; postR.castShadow = true;
  // Click-through glass walls + top so the saber on the posts can be
  // selected by clicking through. Base + posts remain clickable as
  // selection handles for the case itself.
  const NO_RAYCAST = function () {};
  top.raycast = NO_RAYCAST;
  front.raycast = NO_RAYCAST;
  back.raycast = NO_RAYCAST;
  lftWall.raycast = NO_RAYCAST;
  rgtWall.raycast = NO_RAYCAST;
  // Subtle interior accent light — picks up the glass + chrome posts so
  // the case reads as illuminated even when the room is dim. Editable
  // intensity + color via the contextual editor's lighting sliders.
  const interiorLight = new THREE.PointLight(0xffd9a8, 0.0, 0.8, 2.0);
  interiorLight.castShadow = false;
  group.add(base, top, front, back, lftWall, rgtWall, postL, postR, interiorLight);
  window.__saberCaseLight = interiorLight;
  function rebuild() {
    const W = LIGHTSABER_CASE_DIMS.width;
    const D = LIGHTSABER_CASE_DIMS.depth;
    const Bh = LIGHTSABER_CASE_DIMS.base;
    const Gh = LIGHTSABER_CASE_DIMS.glass;
    const inset = 0.005;
    const gW = Math.max(wallT * 4, W - inset * 2);
    const gD = Math.max(wallT * 4, D - inset * 2);
    base.geometry.dispose();   base.geometry  = new THREE.BoxGeometry(W, Bh, D);
    base.position.set(0, Bh / 2, 0);
    top.geometry.dispose();    top.geometry   = new THREE.BoxGeometry(gW, wallT, gD);
    top.position.set(0, Bh + Gh - wallT / 2, 0);
    front.geometry.dispose();  front.geometry = new THREE.BoxGeometry(gW, Gh, wallT);
    front.position.set(0, Bh + Gh / 2, gD / 2 - wallT / 2);
    back.geometry.dispose();   back.geometry  = new THREE.BoxGeometry(gW, Gh, wallT);
    back.position.set(0, Bh + Gh / 2, -gD / 2 + wallT / 2);
    lftWall.geometry.dispose();lftWall.geometry  = new THREE.BoxGeometry(wallT, Gh, gD);
    lftWall.position.set(-gW / 2 + wallT / 2, Bh + Gh / 2, 0);
    rgtWall.geometry.dispose();rgtWall.geometry  = new THREE.BoxGeometry(wallT, Gh, gD);
    rgtWall.position.set(gW / 2 - wallT / 2, Bh + Gh / 2, 0);
    // Posts: rise from the base, spaced symmetrically along X (longest axis).
    const ph = LIGHTSABER_CASE_DIMS.postHeight;
    const pSpace = LIGHTSABER_CASE_DIMS.postSpacing;
    // Slight bottom-flare keeps the chrome look (top/bottom radii differ
    // by 15%); both scale with the user's `postRadius` slider.
    const pR = LIGHTSABER_CASE_DIMS.postRadius;
    const pRTop = pR;
    const pRBot = pR * 1.15;
    postL.geometry.dispose();  postL.geometry = new THREE.CylinderGeometry(pRTop, pRBot, ph, 16);
    postL.position.set(-pSpace / 2, Bh + ph / 2, 0);
    postR.geometry.dispose();  postR.geometry = new THREE.CylinderGeometry(pRTop, pRBot, ph, 16);
    postR.position.set( pSpace / 2, Bh + ph / 2, 0);
    // Interior light positioned mid-case, slightly above the base so it
    // bathes the saber + posts from below.
    interiorLight.position.set(0, Bh + Gh * 0.45, 0);
  }
  rebuild();
  _rebuildSaberCase = rebuild;
  // Default: front of desk, visible from the seated camera. User can
  // drag with the gizmo afterwards.
  group.position.set(1.20, 0.78, -3.20);
  // Honor persisted item state.
  try {
    const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    const k = 'item.Lightsaber_case';
    if (typeof stored[`${k}.x`]    === 'number') group.position.x = stored[`${k}.x`];
    if (typeof stored[`${k}.y`]    === 'number') group.position.y = stored[`${k}.y`];
    if (typeof stored[`${k}.z`]    === 'number') group.position.z = stored[`${k}.z`];
    if (typeof stored[`${k}.rotX`] === 'number') group.rotation.x = stored[`${k}.rotX`];
    if (typeof stored[`${k}.rotY`] === 'number') group.rotation.y = stored[`${k}.rotY`];
    if (typeof stored[`${k}.rotZ`] === 'number') group.rotation.z = stored[`${k}.rotZ`];
    if (typeof stored[`${k}.scale`] === 'number' && stored[`${k}.scale`] > 0.01) group.scale.setScalar(stored[`${k}.scale`]);
    const hidden = JSON.parse(localStorage.getItem('hidden.props.v1') || '[]');
    if (Array.isArray(hidden) && hidden.includes('Lightsaber case')) group.visible = false;
    // Apply persisted interior-light settings.
    if (typeof stored['saberCaseLight.intensity'] === 'number') interiorLight.intensity = stored['saberCaseLight.intensity'];
    if (typeof stored['saberCaseLight.distance']  === 'number') interiorLight.distance  = stored['saberCaseLight.distance'];
    if (typeof stored['saberCaseLight.tintR'] === 'number' &&
        typeof stored['saberCaseLight.tintG'] === 'number' &&
        typeof stored['saberCaseLight.tintB'] === 'number') {
      interiorLight.color.setRGB(stored['saberCaseLight.tintR'], stored['saberCaseLight.tintG'], stored['saberCaseLight.tintB']);
    }
  } catch {}
  window.__lightsaberCaseGroup = group;
  makeSelectable(group, 'Lightsaber case');
})();

// ---------- Ogre display case ------------------------------------------
// A square-ish glass vitrine with a WARM WALNUT WOODEN BASE (not the
// black plinth used by the Nike Air Mag case) plus a tiny spotlight
// mounted at one top corner of the glass shell, aimed inward at the
// center to put a hot rim-light on whatever's inside (the Beware Ogre
// figurine the user dropped in from the bank).
// Editable dims + glass material + corner-light controls live in the
// "Ogre case" contextual editor.
const OGRE_CASE_DIMS = {
  width: 0.42, depth: 0.42, base: 0.030, glass: 0.55,
};
try {
  const _stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
  for (const k of ['width','depth','base','glass']) {
    const v = _stored[`ogreCase.${k}`];
    if (typeof v === 'number' && v > 0) OGRE_CASE_DIMS[k] = v;
  }
} catch {}
let _rebuildOgreCase = () => {};
window.__rebuildOgreCase = () => _rebuildOgreCase();
(function buildOgreCase() {
  const group = new THREE.Group();
  group.name = '__prop_ogreCase';
  scene.add(group);
  const wallT = 0.004;
  // Warm walnut for the base — matches a museum-pedestal feel rather
  // than the matte black of the Nike case. Uses the dark_wood PBR set
  // (diff + nor + rough) shipped under public/textures/wood/dark_wood
  // so the grain reads up close instead of being a flat solid color.
  const baseMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.65, metalness: 0.05,
  });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, transparent: true, opacity: 1.0,
    transmission: 0.95, thickness: 0.30, roughness: 0.02,
    metalness: 0.0, ior: 1.52, side: THREE.DoubleSide,
    envMapIntensity: 1.5, clearcoat: 1.0, clearcoatRoughness: 0.02,
    reflectivity: 0.5,
  });
  // Apply persisted glass-material overrides if any.
  try {
    const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    if (typeof stored['ogreCaseGlass.opacity']      === 'number') glassMat.opacity      = stored['ogreCaseGlass.opacity'];
    if (typeof stored['ogreCaseGlass.transmission'] === 'number') glassMat.transmission = stored['ogreCaseGlass.transmission'];
    if (typeof stored['ogreCaseGlass.roughness']    === 'number') glassMat.roughness    = stored['ogreCaseGlass.roughness'];
    if (typeof stored['ogreCaseGlass.envMap']       === 'number') glassMat.envMapIntensity = stored['ogreCaseGlass.envMap'];
    if (typeof stored['ogreCaseGlass.thickness']    === 'number') glassMat.thickness    = stored['ogreCaseGlass.thickness'];
    if (typeof stored['ogreCaseGlass.ior']          === 'number') glassMat.ior          = stored['ogreCaseGlass.ior'];
    if (typeof stored['ogreCaseGlass.tintR']        === 'number' &&
        typeof stored['ogreCaseGlass.tintG']        === 'number' &&
        typeof stored['ogreCaseGlass.tintB']        === 'number') {
      glassMat.color.setRGB(stored['ogreCaseGlass.tintR'], stored['ogreCaseGlass.tintG'], stored['ogreCaseGlass.tintB']);
    }
    glassMat.needsUpdate = true;
  } catch {}
  window.__ogreCaseGlassMat = glassMat;
  // Persistent meshes — geometry swaps on dim changes.
  const base   = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), baseMat);
  const top    = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const front  = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const back   = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const lftWall= new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const rgtWall= new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  base.castShadow = true; base.receiveShadow = true;
  // Click-through glass walls + top so the figurine inside stays
  // selectable. The wood base is the click handle for the case itself.
  const NO_RAYCAST = function () {};
  top.raycast = NO_RAYCAST;
  front.raycast = NO_RAYCAST;
  back.raycast = NO_RAYCAST;
  lftWall.raycast = NO_RAYCAST;
  rgtWall.raycast = NO_RAYCAST;
  // Corner spotlight — sits inside the case at one top corner pointing
  // inward at the case center. Warm white by default. Intensity, color,
  // and which-corner are editable live.
  const cornerLight = new THREE.SpotLight(0xfff0d0, 1.4, 1.2, Math.PI * 0.32, 0.55, 1.6);
  cornerLight.castShadow = false;
  const cornerTarget = new THREE.Object3D();
  group.add(cornerLight, cornerTarget);
  cornerLight.target = cornerTarget;
  // Tiny emissive bead so the user sees WHERE the light is mounted.
  const beadMat = new THREE.MeshStandardMaterial({
    color: 0xfff2d0, emissive: 0xffe0a0, emissiveIntensity: 1.6,
    roughness: 0.35, metalness: 0.0,
  });
  const lightBead = new THREE.Mesh(new THREE.SphereGeometry(0.008, 16, 12), beadMat);
  lightBead.castShadow = false;
  // Hidden by default — user wants the light effect WITHOUT the visible
  // emissive ball marking its position. Stays in the group so the corner
  // picker can still reposition it; just doesn't render.
  lightBead.visible = false;
  group.add(lightBead);
  group.add(base, top, front, back, lftWall, rgtWall);
  window.__ogreCaseLight = cornerLight;
  window.__ogreCaseLightBead = lightBead;
  // Which corner the light sits at: 0=front-right, 1=front-left,
  // 2=back-right, 3=back-left. Default front-right.
  let _lightCornerIdx = 0;
  try {
    const v = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}')['ogreCase.lightCorner'];
    if (typeof v === 'number' && v >= 0 && v < 4) _lightCornerIdx = Math.floor(v);
  } catch {}
  window.__setOgreCaseLightCorner = (idx) => {
    _lightCornerIdx = ((idx | 0) + 4) % 4;
    try {
      const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
      cur['ogreCase.lightCorner'] = _lightCornerIdx;
      localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
    } catch {}
    rebuild();
  };
  window.__getOgreCaseLightCorner = () => _lightCornerIdx;
  function rebuild() {
    const W = OGRE_CASE_DIMS.width;
    const D = OGRE_CASE_DIMS.depth;
    const Bh = OGRE_CASE_DIMS.base;
    const Gh = OGRE_CASE_DIMS.glass;
    const inset = 0.005;
    const gW = Math.max(wallT * 4, W - inset * 2);
    const gD = Math.max(wallT * 4, D - inset * 2);
    base.geometry.dispose();   base.geometry  = new THREE.BoxGeometry(W, Bh, D);
    base.position.set(0, Bh / 2, 0);
    top.geometry.dispose();    top.geometry   = new THREE.BoxGeometry(gW, wallT, gD);
    top.position.set(0, Bh + Gh - wallT / 2, 0);
    front.geometry.dispose();  front.geometry = new THREE.BoxGeometry(gW, Gh, wallT);
    front.position.set(0, Bh + Gh / 2, gD / 2 - wallT / 2);
    back.geometry.dispose();   back.geometry  = new THREE.BoxGeometry(gW, Gh, wallT);
    back.position.set(0, Bh + Gh / 2, -gD / 2 + wallT / 2);
    lftWall.geometry.dispose();lftWall.geometry  = new THREE.BoxGeometry(wallT, Gh, gD);
    lftWall.position.set(-gW / 2 + wallT / 2, Bh + Gh / 2, 0);
    rgtWall.geometry.dispose();rgtWall.geometry  = new THREE.BoxGeometry(wallT, Gh, gD);
    rgtWall.position.set(gW / 2 - wallT / 2, Bh + Gh / 2, 0);
    // Corner light: inset 1 cm from each glass wall at the chosen top
    // corner, target pointed at the case center (just above the base).
    const ix = (_lightCornerIdx === 0 || _lightCornerIdx === 2) ?  gW / 2 - 0.01 : -gW / 2 + 0.01;
    const iz = (_lightCornerIdx === 0 || _lightCornerIdx === 1) ?  gD / 2 - 0.01 : -gD / 2 + 0.01;
    const iy = Bh + Gh - 0.012;
    cornerLight.position.set(ix, iy, iz);
    cornerTarget.position.set(0, Bh + Gh * 0.30, 0);
    lightBead.position.set(ix, iy, iz);
  }
  rebuild();
  _rebuildOgreCase = rebuild;
  // Wood-grain textures for the base. Async; we just attach maps to the
  // existing baseMat as each one resolves so the geometry doesn't have
  // to wait. dark_wood PBR set lives under public/textures/wood/dark_wood.
  {
    const _tl = new THREE.TextureLoader();
    const _setTex = (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(2, 2);
      return t;
    };
    _tl.load('/textures/wood/dark_wood/diff.jpg',  (t) => { t.colorSpace = THREE.SRGBColorSpace; baseMat.map        = _setTex(t); baseMat.needsUpdate = true; });
    _tl.load('/textures/wood/dark_wood/nor.jpg',   (t) => {                                       baseMat.normalMap = _setTex(t); baseMat.needsUpdate = true; });
    _tl.load('/textures/wood/dark_wood/rough.jpg', (t) => {                                       baseMat.roughnessMap = _setTex(t); baseMat.needsUpdate = true; });
  }
  // Default position: front-right of desk, visible from seated camera.
  group.position.set(0.45, 0.78, -3.20);
  // Honor persisted item state.
  try {
    const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    const k = 'item.Ogre_case';
    if (typeof stored[`${k}.x`]    === 'number') group.position.x = stored[`${k}.x`];
    if (typeof stored[`${k}.y`]    === 'number') group.position.y = stored[`${k}.y`];
    if (typeof stored[`${k}.z`]    === 'number') group.position.z = stored[`${k}.z`];
    if (typeof stored[`${k}.rotX`] === 'number') group.rotation.x = stored[`${k}.rotX`];
    if (typeof stored[`${k}.rotY`] === 'number') group.rotation.y = stored[`${k}.rotY`];
    if (typeof stored[`${k}.rotZ`] === 'number') group.rotation.z = stored[`${k}.rotZ`];
    if (typeof stored[`${k}.scale`] === 'number' && stored[`${k}.scale`] > 0.01) group.scale.setScalar(stored[`${k}.scale`]);
    const hidden = JSON.parse(localStorage.getItem('hidden.props.v1') || '[]');
    if (Array.isArray(hidden) && hidden.includes('Ogre case')) group.visible = false;
    if (typeof stored['ogreCaseLight.intensity'] === 'number') cornerLight.intensity = stored['ogreCaseLight.intensity'];
    if (typeof stored['ogreCaseLight.distance']  === 'number') cornerLight.distance  = stored['ogreCaseLight.distance'];
    if (typeof stored['ogreCaseLight.tintR'] === 'number' &&
        typeof stored['ogreCaseLight.tintG'] === 'number' &&
        typeof stored['ogreCaseLight.tintB'] === 'number') {
      cornerLight.color.setRGB(stored['ogreCaseLight.tintR'], stored['ogreCaseLight.tintG'], stored['ogreCaseLight.tintB']);
      beadMat.color.setRGB(stored['ogreCaseLight.tintR'], stored['ogreCaseLight.tintG'], stored['ogreCaseLight.tintB']);
      beadMat.emissive.setRGB(stored['ogreCaseLight.tintR'], stored['ogreCaseLight.tintG'], stored['ogreCaseLight.tintB']);
    }
  } catch {}
  window.__ogreCaseGroup = group;
  makeSelectable(group, 'Ogre case');
})();

// ---------- Stitch display case ----------------------------------------
// Identical recipe to the Ogre case: warm walnut wood base + glass shell
// + corner spotlight. Built as a separate prop so the Stitch's Great
// Escape sign can ride along with its own merged display.
const STITCH_CASE_DIMS = {
  width: 0.42, depth: 0.42, base: 0.030, glass: 0.55,
};
try {
  const _stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
  for (const k of ['width','depth','base','glass']) {
    const v = _stored[`stitchCase.${k}`];
    if (typeof v === 'number' && v > 0) STITCH_CASE_DIMS[k] = v;
  }
} catch {}
let _rebuildStitchCase = () => {};
window.__rebuildStitchCase = () => _rebuildStitchCase();
(function buildStitchCase() {
  const group = new THREE.Group();
  group.name = '__prop_stitchCase';
  scene.add(group);
  const wallT = 0.004;
  const baseMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.65, metalness: 0.05,
  });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, transparent: true, opacity: 1.0,
    transmission: 0.95, thickness: 0.30, roughness: 0.02,
    metalness: 0.0, ior: 1.52, side: THREE.DoubleSide,
    envMapIntensity: 1.5, clearcoat: 1.0, clearcoatRoughness: 0.02,
    reflectivity: 0.5,
  });
  try {
    const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    if (typeof stored['stitchCaseGlass.opacity']      === 'number') glassMat.opacity      = stored['stitchCaseGlass.opacity'];
    if (typeof stored['stitchCaseGlass.transmission'] === 'number') glassMat.transmission = stored['stitchCaseGlass.transmission'];
    if (typeof stored['stitchCaseGlass.roughness']    === 'number') glassMat.roughness    = stored['stitchCaseGlass.roughness'];
    if (typeof stored['stitchCaseGlass.envMap']       === 'number') glassMat.envMapIntensity = stored['stitchCaseGlass.envMap'];
    if (typeof stored['stitchCaseGlass.thickness']    === 'number') glassMat.thickness    = stored['stitchCaseGlass.thickness'];
    if (typeof stored['stitchCaseGlass.ior']          === 'number') glassMat.ior          = stored['stitchCaseGlass.ior'];
    if (typeof stored['stitchCaseGlass.tintR']        === 'number' &&
        typeof stored['stitchCaseGlass.tintG']        === 'number' &&
        typeof stored['stitchCaseGlass.tintB']        === 'number') {
      glassMat.color.setRGB(stored['stitchCaseGlass.tintR'], stored['stitchCaseGlass.tintG'], stored['stitchCaseGlass.tintB']);
    }
    glassMat.needsUpdate = true;
  } catch {}
  window.__stitchCaseGlassMat = glassMat;
  const base   = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), baseMat);
  const top    = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const front  = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const back   = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const lftWall= new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const rgtWall= new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  base.castShadow = true; base.receiveShadow = true;
  const NO_RAYCAST = function () {};
  top.raycast = NO_RAYCAST;
  front.raycast = NO_RAYCAST;
  back.raycast = NO_RAYCAST;
  lftWall.raycast = NO_RAYCAST;
  rgtWall.raycast = NO_RAYCAST;
  const cornerLight = new THREE.SpotLight(0xfff0d0, 1.4, 1.2, Math.PI * 0.32, 0.55, 1.6);
  cornerLight.castShadow = false;
  const cornerTarget = new THREE.Object3D();
  group.add(cornerLight, cornerTarget);
  cornerLight.target = cornerTarget;
  const beadMat = new THREE.MeshStandardMaterial({
    color: 0xfff2d0, emissive: 0xffe0a0, emissiveIntensity: 1.6,
    roughness: 0.35, metalness: 0.0,
  });
  const lightBead = new THREE.Mesh(new THREE.SphereGeometry(0.008, 16, 12), beadMat);
  lightBead.castShadow = false;
  lightBead.visible = false;   // hidden by default — light effect only
  group.add(lightBead);
  group.add(base, top, front, back, lftWall, rgtWall);
  window.__stitchCaseLight = cornerLight;
  window.__stitchCaseLightBead = lightBead;
  let _lightCornerIdx = 0;
  try {
    const v = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}')['stitchCase.lightCorner'];
    if (typeof v === 'number' && v >= 0 && v < 4) _lightCornerIdx = Math.floor(v);
  } catch {}
  window.__setStitchCaseLightCorner = (idx) => {
    _lightCornerIdx = ((idx | 0) + 4) % 4;
    try {
      const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
      cur['stitchCase.lightCorner'] = _lightCornerIdx;
      localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
    } catch {}
    rebuild();
  };
  window.__getStitchCaseLightCorner = () => _lightCornerIdx;
  function rebuild() {
    const W = STITCH_CASE_DIMS.width;
    const D = STITCH_CASE_DIMS.depth;
    const Bh = STITCH_CASE_DIMS.base;
    const Gh = STITCH_CASE_DIMS.glass;
    const inset = 0.005;
    const gW = Math.max(wallT * 4, W - inset * 2);
    const gD = Math.max(wallT * 4, D - inset * 2);
    base.geometry.dispose();   base.geometry  = new THREE.BoxGeometry(W, Bh, D);
    base.position.set(0, Bh / 2, 0);
    top.geometry.dispose();    top.geometry   = new THREE.BoxGeometry(gW, wallT, gD);
    top.position.set(0, Bh + Gh - wallT / 2, 0);
    front.geometry.dispose();  front.geometry = new THREE.BoxGeometry(gW, Gh, wallT);
    front.position.set(0, Bh + Gh / 2, gD / 2 - wallT / 2);
    back.geometry.dispose();   back.geometry  = new THREE.BoxGeometry(gW, Gh, wallT);
    back.position.set(0, Bh + Gh / 2, -gD / 2 + wallT / 2);
    lftWall.geometry.dispose();lftWall.geometry  = new THREE.BoxGeometry(wallT, Gh, gD);
    lftWall.position.set(-gW / 2 + wallT / 2, Bh + Gh / 2, 0);
    rgtWall.geometry.dispose();rgtWall.geometry  = new THREE.BoxGeometry(wallT, Gh, gD);
    rgtWall.position.set(gW / 2 - wallT / 2, Bh + Gh / 2, 0);
    const ix = (_lightCornerIdx === 0 || _lightCornerIdx === 2) ?  gW / 2 - 0.01 : -gW / 2 + 0.01;
    const iz = (_lightCornerIdx === 0 || _lightCornerIdx === 1) ?  gD / 2 - 0.01 : -gD / 2 + 0.01;
    const iy = Bh + Gh - 0.012;
    cornerLight.position.set(ix, iy, iz);
    cornerTarget.position.set(0, Bh + Gh * 0.30, 0);
    lightBead.position.set(ix, iy, iz);
  }
  rebuild();
  _rebuildStitchCase = rebuild;
  // Wood-grain textures for the base — same dark_wood PBR set.
  {
    const _tl = new THREE.TextureLoader();
    const _setTex = (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(2, 2);
      return t;
    };
    _tl.load('/textures/wood/dark_wood/diff.jpg',  (t) => { t.colorSpace = THREE.SRGBColorSpace; baseMat.map        = _setTex(t); baseMat.needsUpdate = true; });
    _tl.load('/textures/wood/dark_wood/nor.jpg',   (t) => {                                       baseMat.normalMap = _setTex(t); baseMat.needsUpdate = true; });
    _tl.load('/textures/wood/dark_wood/rough.jpg', (t) => {                                       baseMat.roughnessMap = _setTex(t); baseMat.needsUpdate = true; });
  }
  // Default position: a bit further along the desk than the ogre case.
  group.position.set(-0.30, 0.78, -3.20);
  try {
    const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    const k = 'item.Stitch_case';
    if (typeof stored[`${k}.x`]    === 'number') group.position.x = stored[`${k}.x`];
    if (typeof stored[`${k}.y`]    === 'number') group.position.y = stored[`${k}.y`];
    if (typeof stored[`${k}.z`]    === 'number') group.position.z = stored[`${k}.z`];
    if (typeof stored[`${k}.rotX`] === 'number') group.rotation.x = stored[`${k}.rotX`];
    if (typeof stored[`${k}.rotY`] === 'number') group.rotation.y = stored[`${k}.rotY`];
    if (typeof stored[`${k}.rotZ`] === 'number') group.rotation.z = stored[`${k}.rotZ`];
    if (typeof stored[`${k}.scale`] === 'number' && stored[`${k}.scale`] > 0.01) group.scale.setScalar(stored[`${k}.scale`]);
    const hidden = JSON.parse(localStorage.getItem('hidden.props.v1') || '[]');
    if (Array.isArray(hidden) && hidden.includes('Stitch case')) group.visible = false;
    if (typeof stored['stitchCaseLight.intensity'] === 'number') cornerLight.intensity = stored['stitchCaseLight.intensity'];
    if (typeof stored['stitchCaseLight.distance']  === 'number') cornerLight.distance  = stored['stitchCaseLight.distance'];
    if (typeof stored['stitchCaseLight.tintR'] === 'number' &&
        typeof stored['stitchCaseLight.tintG'] === 'number' &&
        typeof stored['stitchCaseLight.tintB'] === 'number') {
      cornerLight.color.setRGB(stored['stitchCaseLight.tintR'], stored['stitchCaseLight.tintG'], stored['stitchCaseLight.tintB']);
      beadMat.color.setRGB(stored['stitchCaseLight.tintR'], stored['stitchCaseLight.tintG'], stored['stitchCaseLight.tintB']);
      beadMat.emissive.setRGB(stored['stitchCaseLight.tintR'], stored['stitchCaseLight.tintG'], stored['stitchCaseLight.tintB']);
    }
  } catch {}
  window.__stitchCaseGroup = group;
  makeSelectable(group, 'Stitch case');

  // (Reflection probe removed — wrapping renderer.render and then
  // calling cubeCamera.update inside that wrapper caused infinite
  // re-entrancy: cubeCamera.update calls renderer.render 6 times, each
  // of those re-entered our wrapper, which scheduled another probe…
  // turning the entire scene black during the loop. The glass falls
  // back to scene.environment for reflections — works for the HDRI
  // but won't pick up the Stitch sign specifically. If we want true
  // local reflections later, we need to add re-entrancy guards AND
  // call the probe from outside renderer.render.)
})();

// ---------- Scream canister display case -------------------------------
// Identical recipe to the Ogre / Stitch cases: wood base + glass shell
// + corner spotlight. Built as a third independent prop so the Monsters
// Inc scream canister can ride along with its own merged display.
const SCREAM_CASE_DIMS = {
  width: 0.42, depth: 0.42, base: 0.030, glass: 0.55,
};
try {
  const _stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
  for (const k of ['width','depth','base','glass']) {
    const v = _stored[`screamCase.${k}`];
    if (typeof v === 'number' && v > 0) SCREAM_CASE_DIMS[k] = v;
  }
} catch {}
let _rebuildScreamCase = () => {};
window.__rebuildScreamCase = () => _rebuildScreamCase();
(function buildScreamCase() {
  const group = new THREE.Group();
  group.name = '__prop_screamCase';
  scene.add(group);
  const wallT = 0.004;
  const baseMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.65, metalness: 0.05,
  });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, transparent: true, opacity: 1.0,
    transmission: 0.95, thickness: 0.30, roughness: 0.02,
    metalness: 0.0, ior: 1.52, side: THREE.DoubleSide,
    envMapIntensity: 1.5, clearcoat: 1.0, clearcoatRoughness: 0.02,
    reflectivity: 0.5,
  });
  try {
    const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    if (typeof stored['screamCaseGlass.opacity']      === 'number') glassMat.opacity      = stored['screamCaseGlass.opacity'];
    if (typeof stored['screamCaseGlass.transmission'] === 'number') glassMat.transmission = stored['screamCaseGlass.transmission'];
    if (typeof stored['screamCaseGlass.roughness']    === 'number') glassMat.roughness    = stored['screamCaseGlass.roughness'];
    if (typeof stored['screamCaseGlass.envMap']       === 'number') glassMat.envMapIntensity = stored['screamCaseGlass.envMap'];
    if (typeof stored['screamCaseGlass.thickness']    === 'number') glassMat.thickness    = stored['screamCaseGlass.thickness'];
    if (typeof stored['screamCaseGlass.ior']          === 'number') glassMat.ior          = stored['screamCaseGlass.ior'];
    if (typeof stored['screamCaseGlass.tintR']        === 'number' &&
        typeof stored['screamCaseGlass.tintG']        === 'number' &&
        typeof stored['screamCaseGlass.tintB']        === 'number') {
      glassMat.color.setRGB(stored['screamCaseGlass.tintR'], stored['screamCaseGlass.tintG'], stored['screamCaseGlass.tintB']);
    }
    glassMat.needsUpdate = true;
  } catch {}
  window.__screamCaseGlassMat = glassMat;
  const base   = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), baseMat);
  const top    = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const front  = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const back   = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const lftWall= new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const rgtWall= new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  base.castShadow = true; base.receiveShadow = true;
  const NO_RAYCAST = function () {};
  top.raycast = NO_RAYCAST;
  front.raycast = NO_RAYCAST;
  back.raycast = NO_RAYCAST;
  lftWall.raycast = NO_RAYCAST;
  rgtWall.raycast = NO_RAYCAST;
  const cornerLight = new THREE.SpotLight(0xfff0d0, 1.4, 1.2, Math.PI * 0.32, 0.55, 1.6);
  cornerLight.castShadow = false;
  const cornerTarget = new THREE.Object3D();
  group.add(cornerLight, cornerTarget);
  cornerLight.target = cornerTarget;
  const beadMat = new THREE.MeshStandardMaterial({
    color: 0xfff2d0, emissive: 0xffe0a0, emissiveIntensity: 1.6,
    roughness: 0.35, metalness: 0.0,
  });
  const lightBead = new THREE.Mesh(new THREE.SphereGeometry(0.008, 16, 12), beadMat);
  lightBead.castShadow = false;
  lightBead.visible = false;
  group.add(lightBead);
  group.add(base, top, front, back, lftWall, rgtWall);
  window.__screamCaseLight = cornerLight;
  window.__screamCaseLightBead = lightBead;
  let _lightCornerIdx = 0;
  try {
    const v = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}')['screamCase.lightCorner'];
    if (typeof v === 'number' && v >= 0 && v < 4) _lightCornerIdx = Math.floor(v);
  } catch {}
  window.__setScreamCaseLightCorner = (idx) => {
    _lightCornerIdx = ((idx | 0) + 4) % 4;
    try {
      const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
      cur['screamCase.lightCorner'] = _lightCornerIdx;
      localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
    } catch {}
    rebuild();
  };
  window.__getScreamCaseLightCorner = () => _lightCornerIdx;
  function rebuild() {
    const W = SCREAM_CASE_DIMS.width;
    const D = SCREAM_CASE_DIMS.depth;
    const Bh = SCREAM_CASE_DIMS.base;
    const Gh = SCREAM_CASE_DIMS.glass;
    const inset = 0.005;
    const gW = Math.max(wallT * 4, W - inset * 2);
    const gD = Math.max(wallT * 4, D - inset * 2);
    base.geometry.dispose();   base.geometry  = new THREE.BoxGeometry(W, Bh, D);
    base.position.set(0, Bh / 2, 0);
    top.geometry.dispose();    top.geometry   = new THREE.BoxGeometry(gW, wallT, gD);
    top.position.set(0, Bh + Gh - wallT / 2, 0);
    front.geometry.dispose();  front.geometry = new THREE.BoxGeometry(gW, Gh, wallT);
    front.position.set(0, Bh + Gh / 2, gD / 2 - wallT / 2);
    back.geometry.dispose();   back.geometry  = new THREE.BoxGeometry(gW, Gh, wallT);
    back.position.set(0, Bh + Gh / 2, -gD / 2 + wallT / 2);
    lftWall.geometry.dispose();lftWall.geometry  = new THREE.BoxGeometry(wallT, Gh, gD);
    lftWall.position.set(-gW / 2 + wallT / 2, Bh + Gh / 2, 0);
    rgtWall.geometry.dispose();rgtWall.geometry  = new THREE.BoxGeometry(wallT, Gh, gD);
    rgtWall.position.set(gW / 2 - wallT / 2, Bh + Gh / 2, 0);
    const ix = (_lightCornerIdx === 0 || _lightCornerIdx === 2) ?  gW / 2 - 0.01 : -gW / 2 + 0.01;
    const iz = (_lightCornerIdx === 0 || _lightCornerIdx === 1) ?  gD / 2 - 0.01 : -gD / 2 + 0.01;
    const iy = Bh + Gh - 0.012;
    cornerLight.position.set(ix, iy, iz);
    cornerTarget.position.set(0, Bh + Gh * 0.30, 0);
    lightBead.position.set(ix, iy, iz);
  }
  rebuild();
  _rebuildScreamCase = rebuild;
  // Wood-grain textures for the base — same dark_wood PBR set.
  {
    const _tl = new THREE.TextureLoader();
    const _setTex = (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(2, 2);
      return t;
    };
    _tl.load('/textures/wood/dark_wood/diff.jpg',  (t) => { t.colorSpace = THREE.SRGBColorSpace; baseMat.map        = _setTex(t); baseMat.needsUpdate = true; });
    _tl.load('/textures/wood/dark_wood/nor.jpg',   (t) => {                                       baseMat.normalMap = _setTex(t); baseMat.needsUpdate = true; });
    _tl.load('/textures/wood/dark_wood/rough.jpg', (t) => {                                       baseMat.roughnessMap = _setTex(t); baseMat.needsUpdate = true; });
  }
  // Default position: a bit further along the desk than the other cases.
  group.position.set(-1.10, 0.78, -3.20);
  try {
    const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    const k = 'item.Scream_case';
    if (typeof stored[`${k}.x`]    === 'number') group.position.x = stored[`${k}.x`];
    if (typeof stored[`${k}.y`]    === 'number') group.position.y = stored[`${k}.y`];
    if (typeof stored[`${k}.z`]    === 'number') group.position.z = stored[`${k}.z`];
    if (typeof stored[`${k}.rotX`] === 'number') group.rotation.x = stored[`${k}.rotX`];
    if (typeof stored[`${k}.rotY`] === 'number') group.rotation.y = stored[`${k}.rotY`];
    if (typeof stored[`${k}.rotZ`] === 'number') group.rotation.z = stored[`${k}.rotZ`];
    if (typeof stored[`${k}.scale`] === 'number' && stored[`${k}.scale`] > 0.01) group.scale.setScalar(stored[`${k}.scale`]);
    const hidden = JSON.parse(localStorage.getItem('hidden.props.v1') || '[]');
    if (Array.isArray(hidden) && hidden.includes('Scream case')) group.visible = false;
    if (typeof stored['screamCaseLight.intensity'] === 'number') cornerLight.intensity = stored['screamCaseLight.intensity'];
    if (typeof stored['screamCaseLight.distance']  === 'number') cornerLight.distance  = stored['screamCaseLight.distance'];
    if (typeof stored['screamCaseLight.tintR'] === 'number' &&
        typeof stored['screamCaseLight.tintG'] === 'number' &&
        typeof stored['screamCaseLight.tintB'] === 'number') {
      cornerLight.color.setRGB(stored['screamCaseLight.tintR'], stored['screamCaseLight.tintG'], stored['screamCaseLight.tintB']);
      beadMat.color.setRGB(stored['screamCaseLight.tintR'], stored['screamCaseLight.tintG'], stored['screamCaseLight.tintB']);
      beadMat.emissive.setRGB(stored['screamCaseLight.tintR'], stored['screamCaseLight.tintG'], stored['screamCaseLight.tintB']);
    }
  } catch {}
  window.__screamCaseGroup = group;
  makeSelectable(group, 'Scream case');
})();

// ---------- Ice Age Nut display case -----------------------------------
// Square glass vitrine with a LIGHTER OAK wood base + a single CENTER
// POLE that holds the Ice Age Nut at the top. The pole's thickness and
// length are user-tunable so the nut can sit at any height inside the
// case. Glass material has the same upgraded recipe as the other cases.
const NUT_CASE_DIMS = {
  width: 0.32, depth: 0.32, base: 0.030, glass: 0.42,
  poleRadius: 0.012, poleLength: 0.18,   // central support pole
  // Hollow-base controls: a thin wood floor + 4 wood walls on the
  // perimeter going UP to the glass shell. Glass walls then sit on top
  // of the wood walls. User can dial each wall's height individually so
  // the base can have e.g. a low front wall + tall back wall like a
  // shadow-box.
  wallThickness: 0.012,
  wallLeft:  0.040,   // left wall height (Y)
  wallRight: 0.040,
  wallFront: 0.040,
  wallBack:  0.040,
};
try {
  const _stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
  for (const k of Object.keys(NUT_CASE_DIMS)) {
    const v = _stored[`nutCase.${k}`];
    if (typeof v === 'number' && v > 0) NUT_CASE_DIMS[k] = v;
  }
} catch {}
let _rebuildNutCase = () => {};
window.__rebuildNutCase = () => _rebuildNutCase();
(function buildNutCase() {
  const group = new THREE.Group();
  group.name = '__prop_nutCase';
  scene.add(group);
  const wallT = 0.004;
  // Lighter oak base — uses oak_veneer_01 textures.
  const baseMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.55, metalness: 0.05,
  });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, transparent: true, opacity: 1.0,
    transmission: 0.95, thickness: 0.30, roughness: 0.02,
    metalness: 0.0, ior: 1.52, side: THREE.DoubleSide,
    envMapIntensity: 1.5, clearcoat: 1.0, clearcoatRoughness: 0.02,
    reflectivity: 0.5,
  });
  const poleMat = new THREE.MeshStandardMaterial({
    color: 0xc8c8c8, roughness: 0.18, metalness: 0.95,
  });
  // Apply persisted glass material overrides if any.
  try {
    const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    if (typeof stored['nutCaseGlass.opacity']      === 'number') glassMat.opacity      = stored['nutCaseGlass.opacity'];
    if (typeof stored['nutCaseGlass.transmission'] === 'number') glassMat.transmission = stored['nutCaseGlass.transmission'];
    if (typeof stored['nutCaseGlass.roughness']    === 'number') glassMat.roughness    = stored['nutCaseGlass.roughness'];
    if (typeof stored['nutCaseGlass.envMap']       === 'number') glassMat.envMapIntensity = stored['nutCaseGlass.envMap'];
    if (typeof stored['nutCaseGlass.thickness']    === 'number') glassMat.thickness    = stored['nutCaseGlass.thickness'];
    if (typeof stored['nutCaseGlass.ior']          === 'number') glassMat.ior          = stored['nutCaseGlass.ior'];
    if (typeof stored['nutCaseGlass.tintR']        === 'number' &&
        typeof stored['nutCaseGlass.tintG']        === 'number' &&
        typeof stored['nutCaseGlass.tintB']        === 'number') {
      glassMat.color.setRGB(stored['nutCaseGlass.tintR'], stored['nutCaseGlass.tintG'], stored['nutCaseGlass.tintB']);
    }
    glassMat.needsUpdate = true;
  } catch {}
  window.__nutCaseGlassMat = glassMat;
  // Persistent meshes — geometry swaps on dim changes.
  // The wood "base" is now hollow: a thin floor plate + 4 perimeter
  // walls (left/right/front/back), each with its own height. The
  // glass shell sits on top of the tallest wall.
  const baseFloor = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), baseMat);
  const wallL     = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), baseMat);
  const wallR     = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), baseMat);
  const wallF     = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), baseMat);
  const wallBk    = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), baseMat);
  const top       = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const front     = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const back      = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const lftWall   = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const rgtWall   = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const pole      = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.012, 1, 16), poleMat);
  [baseFloor, wallL, wallR, wallF, wallBk, pole].forEach((m) => {
    m.castShadow = true; m.receiveShadow = true;
  });
  // Every part raycastable so user can grab the case from any side.
  group.add(baseFloor, wallL, wallR, wallF, wallBk, top, front, back, lftWall, rgtWall, pole);
  function rebuild() {
    const W = NUT_CASE_DIMS.width;
    const D = NUT_CASE_DIMS.depth;
    const Bh = NUT_CASE_DIMS.base;
    const Gh = NUT_CASE_DIMS.glass;
    const wT = NUT_CASE_DIMS.wallThickness;
    const wL = Math.max(0, NUT_CASE_DIMS.wallLeft);
    const wR = Math.max(0, NUT_CASE_DIMS.wallRight);
    const wF = Math.max(0, NUT_CASE_DIMS.wallFront);
    const wB = Math.max(0, NUT_CASE_DIMS.wallBack);
    const wallTopY = Bh + Math.max(wL, wR, wF, wB);   // glass starts at tallest wall's top
    const inset = 0.005;
    const gW = Math.max(wallT * 4, W - inset * 2);
    const gD = Math.max(wallT * 4, D - inset * 2);
    // Wood floor (thin plate, full footprint).
    baseFloor.geometry.dispose();
    baseFloor.geometry = new THREE.BoxGeometry(W, Bh, D);
    baseFloor.position.set(0, Bh / 2, 0);
    // Wood walls — each runs along the perimeter, height = its own dim.
    // Left wall (along Z, at -X edge)
    wallL.geometry.dispose();
    wallL.geometry = new THREE.BoxGeometry(wT, Math.max(0.0001, wL), D);
    wallL.position.set(-W / 2 + wT / 2, Bh + wL / 2, 0);
    wallL.visible = wL > 0.0001;
    // Right wall (along Z, at +X edge)
    wallR.geometry.dispose();
    wallR.geometry = new THREE.BoxGeometry(wT, Math.max(0.0001, wR), D);
    wallR.position.set(W / 2 - wT / 2, Bh + wR / 2, 0);
    wallR.visible = wR > 0.0001;
    // Front wall (along X, at +Z edge)
    wallF.geometry.dispose();
    wallF.geometry = new THREE.BoxGeometry(W, Math.max(0.0001, wF), wT);
    wallF.position.set(0, Bh + wF / 2, D / 2 - wT / 2);
    wallF.visible = wF > 0.0001;
    // Back wall (along X, at -Z edge)
    wallBk.geometry.dispose();
    wallBk.geometry = new THREE.BoxGeometry(W, Math.max(0.0001, wB), wT);
    wallBk.position.set(0, Bh + wB / 2, -D / 2 + wT / 2);
    wallBk.visible = wB > 0.0001;
    // Glass shell — sits ON TOP of the tallest wall, NOT on the floor.
    top.geometry.dispose();    top.geometry   = new THREE.BoxGeometry(gW, wallT, gD);
    top.position.set(0, wallTopY + Gh - wallT / 2, 0);
    front.geometry.dispose();  front.geometry = new THREE.BoxGeometry(gW, Gh, wallT);
    front.position.set(0, wallTopY + Gh / 2, gD / 2 - wallT / 2);
    back.geometry.dispose();   back.geometry  = new THREE.BoxGeometry(gW, Gh, wallT);
    back.position.set(0, wallTopY + Gh / 2, -gD / 2 + wallT / 2);
    lftWall.geometry.dispose();lftWall.geometry  = new THREE.BoxGeometry(wallT, Gh, gD);
    lftWall.position.set(-gW / 2 + wallT / 2, wallTopY + Gh / 2, 0);
    rgtWall.geometry.dispose();rgtWall.geometry  = new THREE.BoxGeometry(wallT, Gh, gD);
    rgtWall.position.set(gW / 2 - wallT / 2, wallTopY + Gh / 2, 0);
    // Center pole — rises from the wood floor (Bh) up by poleLength.
    const pR = NUT_CASE_DIMS.poleRadius;
    const pH = NUT_CASE_DIMS.poleLength;
    pole.geometry.dispose();
    pole.geometry = new THREE.CylinderGeometry(pR, pR * 1.15, pH, 24);
    pole.position.set(0, Bh + pH / 2, 0);
  }
  rebuild();
  _rebuildNutCase = rebuild;
  // Lighter oak wood textures for the base.
  {
    const _tl = new THREE.TextureLoader();
    const _setTex = (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(2, 2);
      return t;
    };
    _tl.load('/textures/wood/oak_veneer_01/diff.jpg',  (t) => { t.colorSpace = THREE.SRGBColorSpace; baseMat.map        = _setTex(t); baseMat.needsUpdate = true; });
    _tl.load('/textures/wood/oak_veneer_01/nor.jpg',   (t) => {                                       baseMat.normalMap = _setTex(t); baseMat.needsUpdate = true; });
    _tl.load('/textures/wood/oak_veneer_01/rough.jpg', (t) => {                                       baseMat.roughnessMap = _setTex(t); baseMat.needsUpdate = true; });
  }
  // Default position: front of desk near other cases.
  group.position.set(-1.80, 0.78, -3.20);
  // Honor persisted item state.
  try {
    const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    const k = 'item.Nut_case';
    if (typeof stored[`${k}.x`]    === 'number') group.position.x = stored[`${k}.x`];
    if (typeof stored[`${k}.y`]    === 'number') group.position.y = stored[`${k}.y`];
    if (typeof stored[`${k}.z`]    === 'number') group.position.z = stored[`${k}.z`];
    if (typeof stored[`${k}.rotX`] === 'number') group.rotation.x = stored[`${k}.rotX`];
    if (typeof stored[`${k}.rotY`] === 'number') group.rotation.y = stored[`${k}.rotY`];
    if (typeof stored[`${k}.rotZ`] === 'number') group.rotation.z = stored[`${k}.rotZ`];
    if (typeof stored[`${k}.scale`] === 'number' && stored[`${k}.scale`] > 0.01) group.scale.setScalar(stored[`${k}.scale`]);
    const hidden = JSON.parse(localStorage.getItem('hidden.props.v1') || '[]');
    if (Array.isArray(hidden) && hidden.includes('Nut case')) group.visible = false;
  } catch {}
  window.__nutCaseGroup = group;
  makeSelectable(group, 'Nut case');
})();

// ---------- Treasure Planet (Solar Surfer) display case ---------------
// Glass case for the Treasure Planet Jim Hawkins Solar Surfer ship,
// with TWO independently-positioned chrome poles that hold the ship
// horizontally — same idea as the Lightsaber case, but the two poles
// are user-positionable (each has its own X + Z + the pair shares a
// girth/radius + height slider).
// Glass material = same upgraded recipe as the Nike Display case.
const TREASURE_CASE_DIMS = {
  width: 0.60, depth: 0.30, base: 0.030, glass: 0.32,
  poleRadius: 0.012, poleHeight: 0.07,
  // Per-pole anchor: poles run along Y, base-mounted at (X, Z).
  pole1X: -0.18, pole1Z: 0.00,
  pole2X:  0.18, pole2Z: 0.00,
};
try {
  const _stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
  for (const k of Object.keys(TREASURE_CASE_DIMS)) {
    const v = _stored[`treasureCase.${k}`];
    if (typeof v === 'number') TREASURE_CASE_DIMS[k] = v;
  }
} catch {}
let _rebuildTreasureCase = () => {};
window.__rebuildTreasureCase = () => _rebuildTreasureCase();
(function buildTreasureCase() {
  const group = new THREE.Group();
  group.name = '__prop_treasureCase';
  scene.add(group);
  const wallT = 0.004;
  // Lighter oak wood base — uses the same dark_wood textures as the
  // other cases (will be loaded async below; color/material defaults
  // are tuned so the wood reads warm even before textures arrive).
  const baseMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.60, metalness: 0.05,
  });
  // Glass material — IDENTICAL recipe to the Display case (Nike air
  // mags) so the look matches.
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, transparent: true, opacity: 1.0,
    transmission: 0.95, thickness: 0.30, roughness: 0.02,
    metalness: 0.0, ior: 1.52, side: THREE.DoubleSide,
    envMapIntensity: 1.5, clearcoat: 1.0, clearcoatRoughness: 0.02,
    reflectivity: 0.5,
  });
  const poleMat = new THREE.MeshStandardMaterial({
    color: 0xc8c8c8, roughness: 0.18, metalness: 0.95,
  });
  // Apply persisted glass material overrides if any.
  try {
    const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    if (typeof stored['treasureCaseGlass.opacity']      === 'number') glassMat.opacity      = stored['treasureCaseGlass.opacity'];
    if (typeof stored['treasureCaseGlass.transmission'] === 'number') glassMat.transmission = stored['treasureCaseGlass.transmission'];
    if (typeof stored['treasureCaseGlass.roughness']    === 'number') glassMat.roughness    = stored['treasureCaseGlass.roughness'];
    if (typeof stored['treasureCaseGlass.envMap']       === 'number') glassMat.envMapIntensity = stored['treasureCaseGlass.envMap'];
    if (typeof stored['treasureCaseGlass.thickness']    === 'number') glassMat.thickness    = stored['treasureCaseGlass.thickness'];
    if (typeof stored['treasureCaseGlass.ior']          === 'number') glassMat.ior          = stored['treasureCaseGlass.ior'];
    if (typeof stored['treasureCaseGlass.tintR']        === 'number' &&
        typeof stored['treasureCaseGlass.tintG']        === 'number' &&
        typeof stored['treasureCaseGlass.tintB']        === 'number') {
      glassMat.color.setRGB(stored['treasureCaseGlass.tintR'], stored['treasureCaseGlass.tintG'], stored['treasureCaseGlass.tintB']);
    }
    glassMat.needsUpdate = true;
  } catch {}
  window.__treasureCaseGlassMat = glassMat;
  // Persistent meshes.
  const base    = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), baseMat);
  const top     = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const front   = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const back    = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const lftWall = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const rgtWall = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const pole1   = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.014, 1, 16), poleMat);
  const pole2   = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.014, 1, 16), poleMat);
  base.castShadow = true; base.receiveShadow = true;
  pole1.castShadow = true; pole2.castShadow = true;
  group.add(base, top, front, back, lftWall, rgtWall, pole1, pole2);
  function rebuild() {
    const W = TREASURE_CASE_DIMS.width;
    const D = TREASURE_CASE_DIMS.depth;
    const Bh = TREASURE_CASE_DIMS.base;
    const Gh = TREASURE_CASE_DIMS.glass;
    const inset = 0.005;
    const gW = Math.max(wallT * 4, W - inset * 2);
    const gD = Math.max(wallT * 4, D - inset * 2);
    base.geometry.dispose();   base.geometry  = new THREE.BoxGeometry(W, Bh, D);
    base.position.set(0, Bh / 2, 0);
    top.geometry.dispose();    top.geometry   = new THREE.BoxGeometry(gW, wallT, gD);
    top.position.set(0, Bh + Gh - wallT / 2, 0);
    front.geometry.dispose();  front.geometry = new THREE.BoxGeometry(gW, Gh, wallT);
    front.position.set(0, Bh + Gh / 2, gD / 2 - wallT / 2);
    back.geometry.dispose();   back.geometry  = new THREE.BoxGeometry(gW, Gh, wallT);
    back.position.set(0, Bh + Gh / 2, -gD / 2 + wallT / 2);
    lftWall.geometry.dispose();lftWall.geometry  = new THREE.BoxGeometry(wallT, Gh, gD);
    lftWall.position.set(-gW / 2 + wallT / 2, Bh + Gh / 2, 0);
    rgtWall.geometry.dispose();rgtWall.geometry  = new THREE.BoxGeometry(wallT, Gh, gD);
    rgtWall.position.set(gW / 2 - wallT / 2, Bh + Gh / 2, 0);
    // Two chrome poles, vertical cylinders rising from the base. The
    // ship will rest horizontally across their tops (user positions the
    // ship via its own item editor — these poles just define where the
    // cradle points are).
    const pR = TREASURE_CASE_DIMS.poleRadius;
    const pH = TREASURE_CASE_DIMS.poleHeight;
    const pRTop = pR;
    const pRBot = pR * 1.15;
    pole1.geometry.dispose();
    pole1.geometry = new THREE.CylinderGeometry(pRTop, pRBot, pH, 24);
    pole1.position.set(TREASURE_CASE_DIMS.pole1X, Bh + pH / 2, TREASURE_CASE_DIMS.pole1Z);
    pole2.geometry.dispose();
    pole2.geometry = new THREE.CylinderGeometry(pRTop, pRBot, pH, 24);
    pole2.position.set(TREASURE_CASE_DIMS.pole2X, Bh + pH / 2, TREASURE_CASE_DIMS.pole2Z);
  }
  rebuild();
  _rebuildTreasureCase = rebuild;
  // Wood textures.
  {
    const _tl = new THREE.TextureLoader();
    const _setTex = (t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(2, 2); return t; };
    _tl.load('/textures/wood/oak_veneer_01/diff.jpg',  (t) => { t.colorSpace = THREE.SRGBColorSpace; baseMat.map        = _setTex(t); baseMat.needsUpdate = true; });
    _tl.load('/textures/wood/oak_veneer_01/nor.jpg',   (t) => {                                       baseMat.normalMap = _setTex(t); baseMat.needsUpdate = true; });
    _tl.load('/textures/wood/oak_veneer_01/rough.jpg', (t) => {                                       baseMat.roughnessMap = _setTex(t); baseMat.needsUpdate = true; });
  }
  // Default position — front of desk near other cases.
  group.position.set(1.30, 0.78, -3.20);
  try {
    const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    const k = 'item.Treasure_case';
    if (typeof stored[`${k}.x`]    === 'number') group.position.x = stored[`${k}.x`];
    if (typeof stored[`${k}.y`]    === 'number') group.position.y = stored[`${k}.y`];
    if (typeof stored[`${k}.z`]    === 'number') group.position.z = stored[`${k}.z`];
    if (typeof stored[`${k}.rotX`] === 'number') group.rotation.x = stored[`${k}.rotX`];
    if (typeof stored[`${k}.rotY`] === 'number') group.rotation.y = stored[`${k}.rotY`];
    if (typeof stored[`${k}.rotZ`] === 'number') group.rotation.z = stored[`${k}.rotZ`];
    if (typeof stored[`${k}.scale`] === 'number' && stored[`${k}.scale`] > 0.01) group.scale.setScalar(stored[`${k}.scale`]);
    const hidden = JSON.parse(localStorage.getItem('hidden.props.v1') || '[]');
    if (Array.isArray(hidden) && hidden.includes('Treasure case')) group.visible = false;
  } catch {}
  window.__treasureCaseGroup = group;
  makeSelectable(group, 'Treasure case');
})();

// ---------- Hudson Hornet display case (no poles) ----------------------
// Wood base + glass shell, NO poles inside — the car sits directly on
// the wood floor. Wider footprint than the other cases to fit the car.
// Glass material = same Nike Display case recipe.
const HUDSON_CASE_DIMS = {
  width: 0.55, depth: 0.28, base: 0.030, glass: 0.22,
};
try {
  const _stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
  for (const k of Object.keys(HUDSON_CASE_DIMS)) {
    const v = _stored[`hudsonCase.${k}`];
    if (typeof v === 'number' && v > 0) HUDSON_CASE_DIMS[k] = v;
  }
} catch {}
let _rebuildHudsonCase = () => {};
window.__rebuildHudsonCase = () => _rebuildHudsonCase();
(function buildHudsonCase() {
  const group = new THREE.Group();
  group.name = '__prop_hudsonCase';
  scene.add(group);
  const wallT = 0.004;
  const baseMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.60, metalness: 0.05,
  });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, transparent: true, opacity: 1.0,
    transmission: 0.95, thickness: 0.30, roughness: 0.02,
    metalness: 0.0, ior: 1.52, side: THREE.DoubleSide,
    envMapIntensity: 1.5, clearcoat: 1.0, clearcoatRoughness: 0.02,
    reflectivity: 0.5,
  });
  try {
    const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    if (typeof stored['hudsonCaseGlass.opacity']      === 'number') glassMat.opacity      = stored['hudsonCaseGlass.opacity'];
    if (typeof stored['hudsonCaseGlass.transmission'] === 'number') glassMat.transmission = stored['hudsonCaseGlass.transmission'];
    if (typeof stored['hudsonCaseGlass.roughness']    === 'number') glassMat.roughness    = stored['hudsonCaseGlass.roughness'];
    if (typeof stored['hudsonCaseGlass.envMap']       === 'number') glassMat.envMapIntensity = stored['hudsonCaseGlass.envMap'];
    if (typeof stored['hudsonCaseGlass.thickness']    === 'number') glassMat.thickness    = stored['hudsonCaseGlass.thickness'];
    if (typeof stored['hudsonCaseGlass.ior']          === 'number') glassMat.ior          = stored['hudsonCaseGlass.ior'];
    if (typeof stored['hudsonCaseGlass.tintR']        === 'number' &&
        typeof stored['hudsonCaseGlass.tintG']        === 'number' &&
        typeof stored['hudsonCaseGlass.tintB']        === 'number') {
      glassMat.color.setRGB(stored['hudsonCaseGlass.tintR'], stored['hudsonCaseGlass.tintG'], stored['hudsonCaseGlass.tintB']);
    }
    glassMat.needsUpdate = true;
  } catch {}
  window.__hudsonCaseGlassMat = glassMat;
  // Expose the wood baseMat so the editor's "Case color" picker + tint
  // sliders can swap textures live (every wood option in
  // public/textures/wood/*).
  window.__hudsonCaseBaseMat = baseMat;
  // Persistent meshes — base + glass shell only. NO poles.
  const base    = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), baseMat);
  const top     = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const front   = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const back    = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const lftWall = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  const rgtWall = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glassMat);
  base.castShadow = true; base.receiveShadow = true;
  group.add(base, top, front, back, lftWall, rgtWall);
  function rebuild() {
    const W = HUDSON_CASE_DIMS.width;
    const D = HUDSON_CASE_DIMS.depth;
    const Bh = HUDSON_CASE_DIMS.base;
    const Gh = HUDSON_CASE_DIMS.glass;
    const inset = 0.005;
    const gW = Math.max(wallT * 4, W - inset * 2);
    const gD = Math.max(wallT * 4, D - inset * 2);
    base.geometry.dispose();   base.geometry  = new THREE.BoxGeometry(W, Bh, D);
    base.position.set(0, Bh / 2, 0);
    top.geometry.dispose();    top.geometry   = new THREE.BoxGeometry(gW, wallT, gD);
    top.position.set(0, Bh + Gh - wallT / 2, 0);
    front.geometry.dispose();  front.geometry = new THREE.BoxGeometry(gW, Gh, wallT);
    front.position.set(0, Bh + Gh / 2, gD / 2 - wallT / 2);
    back.geometry.dispose();   back.geometry  = new THREE.BoxGeometry(gW, Gh, wallT);
    back.position.set(0, Bh + Gh / 2, -gD / 2 + wallT / 2);
    lftWall.geometry.dispose();lftWall.geometry  = new THREE.BoxGeometry(wallT, Gh, gD);
    lftWall.position.set(-gW / 2 + wallT / 2, Bh + Gh / 2, 0);
    rgtWall.geometry.dispose();rgtWall.geometry  = new THREE.BoxGeometry(wallT, Gh, gD);
    rgtWall.position.set(gW / 2 - wallT / 2, Bh + Gh / 2, 0);
  }
  rebuild();
  _rebuildHudsonCase = rebuild;
  // Wood texture loader — swappable. Default is oak_veneer_01; user
  // picks one of the 7 options via the editor's "Case color" picker.
  const HUDSON_WOOD_OPTIONS = [
    'dark_wood', 'dark_wooden_planks', 'fine_grained_wood',
    'kitchen_wood', 'oak_veneer_01', 'rosewood_veneer1', 'stained_pine',
  ];
  window.__hudsonWoodOptions = HUDSON_WOOD_OPTIONS;
  function _loadHudsonWood(name) {
    if (!HUDSON_WOOD_OPTIONS.includes(name)) name = 'oak_veneer_01';
    const tl = new THREE.TextureLoader();
    const setTex = (t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(2, 2); return t; };
    // Dispose previous textures first so we don't leak GPU memory each swap.
    ['map', 'normalMap', 'roughnessMap'].forEach(k => {
      if (baseMat[k]) { try { baseMat[k].dispose(); } catch {} baseMat[k] = null; }
    });
    tl.load(`/textures/wood/${name}/diff.jpg`,  (t) => { t.colorSpace = THREE.SRGBColorSpace; baseMat.map        = setTex(t); baseMat.needsUpdate = true; });
    tl.load(`/textures/wood/${name}/nor.jpg`,   (t) => {                                       baseMat.normalMap = setTex(t); baseMat.needsUpdate = true; });
    tl.load(`/textures/wood/${name}/rough.jpg`, (t) => {                                       baseMat.roughnessMap = setTex(t); baseMat.needsUpdate = true; });
    try {
      const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
      cur['hudsonCase.baseTexture'] = name;
      localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
    } catch {}
  }
  window.__setHudsonWood = _loadHudsonWood;
  window.__getHudsonWood = () => {
    try { return JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}')['hudsonCase.baseTexture'] || 'oak_veneer_01'; }
    catch { return 'oak_veneer_01'; }
  };
  // Initial load from persisted choice (or default oak).
  _loadHudsonWood(window.__getHudsonWood());
  // Apply persisted tint multiplier (color baked over the texture).
  try {
    const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    if (typeof stored['hudsonCase.tintR'] === 'number' &&
        typeof stored['hudsonCase.tintG'] === 'number' &&
        typeof stored['hudsonCase.tintB'] === 'number') {
      baseMat.color.setRGB(stored['hudsonCase.tintR'], stored['hudsonCase.tintG'], stored['hudsonCase.tintB']);
    }
  } catch {}
  // Default position — front of desk, beside other cases.
  group.position.set(1.95, 0.78, -3.20);
  try {
    const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    const k = 'item.Hudson_case';
    if (typeof stored[`${k}.x`]    === 'number') group.position.x = stored[`${k}.x`];
    if (typeof stored[`${k}.y`]    === 'number') group.position.y = stored[`${k}.y`];
    if (typeof stored[`${k}.z`]    === 'number') group.position.z = stored[`${k}.z`];
    if (typeof stored[`${k}.rotX`] === 'number') group.rotation.x = stored[`${k}.rotX`];
    if (typeof stored[`${k}.rotY`] === 'number') group.rotation.y = stored[`${k}.rotY`];
    if (typeof stored[`${k}.rotZ`] === 'number') group.rotation.z = stored[`${k}.rotZ`];
    if (typeof stored[`${k}.scale`] === 'number' && stored[`${k}.scale`] > 0.01) group.scale.setScalar(stored[`${k}.scale`]);
    const hidden = JSON.parse(localStorage.getItem('hidden.props.v1') || '[]');
    if (Array.isArray(hidden) && hidden.includes('Hudson case')) group.visible = false;
  } catch {}
  window.__hudsonCaseGroup = group;
  makeSelectable(group, 'Hudson case');
})();

// ---------- VHS display stand -----------------------------------------
// Wooden base + chrome "tripod"-style metal holder:
//   • 2 vertical posts rising from the base
//   • A tilted back plate connecting them (the VHS leans on this)
//   • 2 horizontal forward sticks at the bottom of the back plate that
//     act as a front lip / cradle to keep the VHS from sliding off.
// Every dim is user-tunable. Wood color/texture pickable like the
// Hudson case.
const VHS_STAND_DIMS = {
  baseW: 0.28, baseD: 0.18, baseH: 0.025,
  postH: 0.20, postT: 0.010, postSpacing: 0.16,
  backW: 0.18, backH: 0.16, backT: 0.008,
  backTilt: 0.22,            // radians (lean angle of the backplate)
  cradleLength: 0.04, cradleT: 0.008, cradleSpacing: 0.13,
  cradleLift: 0.005,         // small Y offset above the base so the lip clears the floor
};
try {
  const _stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
  for (const k of Object.keys(VHS_STAND_DIMS)) {
    const v = _stored[`vhsStand.${k}`];
    if (typeof v === 'number') VHS_STAND_DIMS[k] = v;
  }
} catch {}
let _rebuildVhsStand = () => {};
window.__rebuildVhsStand = () => _rebuildVhsStand();
(function buildVhsStand() {
  const group = new THREE.Group();
  group.name = '__prop_vhsStand';
  scene.add(group);
  const baseMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.60, metalness: 0.05,
  });
  // Polished chrome for the holder structure.
  const metalMat = new THREE.MeshStandardMaterial({
    color: 0xcfd1d4, roughness: 0.22, metalness: 0.95,
  });
  // Apply persisted tint if any.
  try {
    const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    if (typeof stored['vhsStand.tintR'] === 'number' &&
        typeof stored['vhsStand.tintG'] === 'number' &&
        typeof stored['vhsStand.tintB'] === 'number') {
      baseMat.color.setRGB(stored['vhsStand.tintR'], stored['vhsStand.tintG'], stored['vhsStand.tintB']);
    }
    if (typeof stored['vhsStand.metalR'] === 'number' &&
        typeof stored['vhsStand.metalG'] === 'number' &&
        typeof stored['vhsStand.metalB'] === 'number') {
      metalMat.color.setRGB(stored['vhsStand.metalR'], stored['vhsStand.metalG'], stored['vhsStand.metalB']);
    }
    if (typeof stored['vhsStand.metalRoughness'] === 'number') metalMat.roughness = stored['vhsStand.metalRoughness'];
    if (typeof stored['vhsStand.metalMetalness'] === 'number') metalMat.metalness = stored['vhsStand.metalMetalness'];
  } catch {}
  window.__vhsStandBaseMat = baseMat;
  window.__vhsStandMetalMat = metalMat;

  // Persistent meshes — geometry swaps on dim changes.
  const base   = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), baseMat);
  // Vertical posts.
  const postL  = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 20), metalMat);
  const postR  = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 20), metalMat);
  // Tilted backplate (a thin slab rotated around X).
  const backPlate = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), metalMat);
  // Forward cradle sticks (horizontal cylinders).
  const cradleL = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 16), metalMat);
  const cradleR = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 16), metalMat);
  [base, postL, postR, backPlate, cradleL, cradleR].forEach((m) => {
    m.castShadow = true; m.receiveShadow = true;
  });
  group.add(base, postL, postR, backPlate, cradleL, cradleR);

  function rebuild() {
    const D = VHS_STAND_DIMS;
    // ---- Base ----
    base.geometry.dispose();
    base.geometry = new THREE.BoxGeometry(D.baseW, D.baseH, D.baseD);
    base.position.set(0, D.baseH / 2, 0);

    // ---- Vertical posts (sit at the BACK of the base, spaced along X) ----
    postL.geometry.dispose();
    postL.geometry = new THREE.CylinderGeometry(D.postT, D.postT * 1.1, D.postH, 20);
    postL.position.set(-D.postSpacing / 2, D.baseH + D.postH / 2, -D.baseD / 2 + D.postT * 1.5);
    postR.geometry.dispose();
    postR.geometry = new THREE.CylinderGeometry(D.postT, D.postT * 1.1, D.postH, 20);
    postR.position.set( D.postSpacing / 2, D.baseH + D.postH / 2, -D.baseD / 2 + D.postT * 1.5);

    // ---- Tilted backplate (thin slab between/in front of the posts) ----
    backPlate.geometry.dispose();
    backPlate.geometry = new THREE.BoxGeometry(D.backW, D.backH, D.backT);
    // Place at mid-post height; tilt forward (around X axis).
    backPlate.position.set(0, D.baseH + D.postH * 0.55, -D.baseD / 2 + D.postT * 1.5 + D.backT / 2);
    backPlate.rotation.set(D.backTilt, 0, 0);

    // ---- Forward cradle sticks (two horizontal cylinders pointing +Z) ----
    // Sit at the bottom of the backplate, project FORWARD so the VHS
    // bottom edge rests on them.
    cradleL.geometry.dispose();
    cradleL.geometry = new THREE.CylinderGeometry(D.cradleT, D.cradleT, D.cradleLength, 16);
    // Rotate the cylinder so its long axis is +Z (pointing toward room front).
    cradleL.rotation.set(Math.PI / 2, 0, 0);
    cradleL.position.set(
      -D.cradleSpacing / 2,
      D.baseH + D.cradleLift + D.cradleT,
      -D.baseD / 2 + D.postT * 1.5 + D.backT + D.cradleLength / 2,
    );
    cradleR.geometry.dispose();
    cradleR.geometry = new THREE.CylinderGeometry(D.cradleT, D.cradleT, D.cradleLength, 16);
    cradleR.rotation.set(Math.PI / 2, 0, 0);
    cradleR.position.set(
       D.cradleSpacing / 2,
      D.baseH + D.cradleLift + D.cradleT,
      -D.baseD / 2 + D.postT * 1.5 + D.backT + D.cradleLength / 2,
    );
  }
  rebuild();
  _rebuildVhsStand = rebuild;

  // Wood texture loader — same swappable system as the Hudson case.
  const VHS_WOOD_OPTIONS = [
    'dark_wood', 'dark_wooden_planks', 'fine_grained_wood',
    'kitchen_wood', 'oak_veneer_01', 'rosewood_veneer1', 'stained_pine',
  ];
  window.__vhsWoodOptions = VHS_WOOD_OPTIONS;
  function _loadVhsWood(name) {
    if (!VHS_WOOD_OPTIONS.includes(name)) name = 'oak_veneer_01';
    const tl = new THREE.TextureLoader();
    const setTex = (t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(2, 2); return t; };
    ['map', 'normalMap', 'roughnessMap'].forEach(k => {
      if (baseMat[k]) { try { baseMat[k].dispose(); } catch {} baseMat[k] = null; }
    });
    tl.load(`/textures/wood/${name}/diff.jpg`,  (t) => { t.colorSpace = THREE.SRGBColorSpace; baseMat.map        = setTex(t); baseMat.needsUpdate = true; });
    tl.load(`/textures/wood/${name}/nor.jpg`,   (t) => {                                       baseMat.normalMap = setTex(t); baseMat.needsUpdate = true; });
    tl.load(`/textures/wood/${name}/rough.jpg`, (t) => {                                       baseMat.roughnessMap = setTex(t); baseMat.needsUpdate = true; });
    try {
      const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
      cur['vhsStand.wood'] = name;
      localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
    } catch {}
  }
  window.__setVhsWood = _loadVhsWood;
  window.__getVhsWood = () => {
    try { return JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}')['vhsStand.wood'] || 'oak_veneer_01'; }
    catch { return 'oak_veneer_01'; }
  };
  _loadVhsWood(window.__getVhsWood());

  // Default spawn — front of desk, beside the other stands.
  group.position.set(2.50, 0.78, -3.20);
  try {
    const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    const k = 'item.VHS_stand';
    if (typeof stored[`${k}.x`]    === 'number') group.position.x = stored[`${k}.x`];
    if (typeof stored[`${k}.y`]    === 'number') group.position.y = stored[`${k}.y`];
    if (typeof stored[`${k}.z`]    === 'number') group.position.z = stored[`${k}.z`];
    if (typeof stored[`${k}.rotX`] === 'number') group.rotation.x = stored[`${k}.rotX`];
    if (typeof stored[`${k}.rotY`] === 'number') group.rotation.y = stored[`${k}.rotY`];
    if (typeof stored[`${k}.rotZ`] === 'number') group.rotation.z = stored[`${k}.rotZ`];
    if (typeof stored[`${k}.scale`] === 'number' && stored[`${k}.scale`] > 0.01) group.scale.setScalar(stored[`${k}.scale`]);
    const hidden = JSON.parse(localStorage.getItem('hidden.props.v1') || '[]');
    if (Array.isArray(hidden) && hidden.includes('VHS stand')) group.visible = false;
  } catch {}
  window.__vhsStandGroup = group;
  makeSelectable(group, 'VHS stand');
})();

// ---------- Gravity Falls Journals — 4-book splitter -------------------
// The single GLB ships as one file with 4 sub-objects under
// GLTF_SceneRootNode (Cube001_0 .. Cube005_3). The user wants each book
// as its own draggable / selectable prop, so we load the GLB once, then
// detach every direct child of the scene-root node into its own
// `__prop_journal_<n>` group with its own SELECTABLE label. After
// splitting, the original Sketchfab tree is discarded.
(function loadGravityFallsJournals() {
  // Skip rebuild if a previous boot already split + persisted them
  // (we'd see item.Gravity_Falls_Journal_1.x already in storage).
  // If you want to re-split (e.g. after deleting one), clear the
  // `journals.split.v1` sentinel and reload.
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}'); } catch {}
  const SENTINEL = 'journals.split.v1';
  const skipBuild = !!stored[SENTINEL];

  const loader = makeGLTFLoader();
  loader.load('/items-bank/gravity_falls_journals.glb', (gltf) => {
    const root = gltf.scene;
    // Find the inner SceneRootNode that has the 4 cubes as children.
    let host = null;
    root.traverse((o) => {
      if (host) return;
      if (o.children && o.children.length === 4 &&
          o.children.every(c => /^Cube\d{3}_\d/.test(c.name || ''))) host = o;
    });
    if (!host || host.children.length !== 4) {
      console.warn('[journals] GLB shape unexpected — falling back to spawning whole file as one prop');
      return;
    }
    // Put the entire root in a hidden offscreen mount so we can read
    // each child's world transform safely, then transplant each child.
    const mount = new THREE.Group();
    mount.visible = false;
    scene.add(mount);
    mount.add(root);
    root.updateMatrixWorld(true);
    // Default desk-row positions for the 4 books (used only on first
    // build; subsequent reloads use persisted positions).
    const defaults = [
      { x: -1.40, y: 0.78, z: -3.20 },
      { x: -0.80, y: 0.78, z: -3.20 },
      { x: -0.20, y: 0.78, z: -3.20 },
      { x:  0.40, y: 0.78, z: -3.20 },
    ];
    const children = host.children.slice();   // copy — we'll mutate parents
    for (let i = 0; i < 4; i++) {
      const sub = children[i];
      const labelN = i + 1;
      const label = `Gravity Falls Journal ${labelN}`;
      // Compute the sub-object's CURRENT world bbox so we can re-center
      // its origin on its own center (otherwise each book inherits a
      // shared GLB origin and they all stack at the same point).
      sub.updateMatrixWorld(true);
      const subBox = new THREE.Box3().setFromObject(sub);
      const subCenter = new THREE.Vector3(); subBox.getCenter(subCenter);
      const subSize = new THREE.Vector3(); subBox.getSize(subSize);
      // Move sub to a fresh group, re-centered.
      const grp = new THREE.Group();
      grp.name = `__prop_journal_${labelN}`;
      scene.add(grp);
      // Pull the mesh out of the GLB hierarchy preserving world transform.
      scene.attach(sub);
      // Now translate sub so its bbox center sits at the group origin.
      sub.position.sub(subCenter);
      grp.attach(sub);    // attach (not add) preserves world; but sub
                          // is now at group-relative center.
      // Spawn-point: prefer persisted, fall back to defaults row.
      const safe = label.replace(/\s+/g, '_');
      const k = `item.${safe}`;
      const def = defaults[i];
      if (typeof stored[`${k}.x`]    === 'number') grp.position.x = stored[`${k}.x`];
      else                                          grp.position.x = def.x;
      if (typeof stored[`${k}.y`]    === 'number') grp.position.y = stored[`${k}.y`];
      else                                          grp.position.y = def.y;
      if (typeof stored[`${k}.z`]    === 'number') grp.position.z = stored[`${k}.z`];
      else                                          grp.position.z = def.z;
      if (typeof stored[`${k}.rotX`] === 'number') grp.rotation.x = stored[`${k}.rotX`];
      if (typeof stored[`${k}.rotY`] === 'number') grp.rotation.y = stored[`${k}.rotY`];
      if (typeof stored[`${k}.rotZ`] === 'number') grp.rotation.z = stored[`${k}.rotZ`];
      // Scale: GLB native units are usually meters; if the book bbox
      // is too big, normalize to ~0.18m height. Persisted overrides win.
      const target_h = 0.18;
      const native_h = Math.max(subSize.x, subSize.y, subSize.z) || 1;
      const auto_s = target_h / native_h;
      const persisted_s = stored[`${k}.scale`];
      const s = (typeof persisted_s === 'number' && persisted_s > 0.001) ? persisted_s : auto_s;
      grp.scale.setScalar(s);
      // Honor hidden-props flag.
      try {
        const hidden = JSON.parse(localStorage.getItem('hidden.props.v1') || '[]');
        if (Array.isArray(hidden) && hidden.includes(label)) grp.visible = false;
      } catch {}
      // Shadows for the meshes inside.
      sub.traverse((m) => {
        if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
      });
      makeSelectable(grp, label);
    }
    // Discard the original mount + leftover GLB tree.
    scene.remove(mount);
    // Persist sentinel so we don't re-spawn on every reload (each book
    // is now an independent persisted item).
    try {
      const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
      cur[SENTINEL] = true;
      localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
    } catch {}
    console.log('[journals] split into 4 selectable books — Gravity Falls Journal 1..4');
  }, undefined, (err) => {
    console.warn('[journals] failed to load gravity_falls_journals.glb', err);
  });
})();

// ---------- Candle flame system (Lumiere) ------------------------------
// Three animated flame sprites + three warm point lights, anchored to
// Lumiere's three candle wicks. Each flame is a Sprite using a
// procedurally drawn 256² flame canvas (no external texture needed),
// with per-frame scale pulse + light intensity flicker. The editor
// exposes sliders for color, size, pulse speed, light intensity / range,
// and per-flame anchor X/Y/Z offsets so the user can re-align them onto
// the wicks if Lumiere's mesh ever changes.
//
// Defaults are tuned for `Lumiere from Beauty and the Beast` (bank id
// `bank-lumiere_from__beauty_and_the_beast-mp04hs43-33`). The model has
// bbox max-dim ~3.85 in native units; loadProp scales to ~0.6 m, so
// flame anchors are stored in MODEL-LOCAL coords and inherit the
// Lumiere group's scale automatically.
// Defaults discovered via vertex analysis of the actual `Podsv_low_Svecha_0`
// candle mesh — wick tips in lumi-local coords + a small +0.025 m Y
// offset so each flame floats above the tip rather than embedded in it.
// In this GLB the 3 candle arms run along the Z axis (not X), so left
// and right flames differ in Z while X is the depth into the candelabra.
const FLAME_TUNE = {
  enabled: 1,                  // 0 = off
  size: 0.06,                  // GLOBAL size multiplier (candle-scale flames)
  pulseAmp: 0.18,              // ±18% scale wiggle
  pulseSpeed: 6.0,             // Hz-ish
  hueR: 1.0, hueG: 0.65, hueB: 0.20,    // sprite tint (warm orange)
  lightIntensity: 0.55,
  lightDistance: 0.18,
  lightR: 1.0, lightG: 0.62, lightB: 0.25,
  flickerAmp: 0.35,            // ±35% intensity flicker
  // Flame indexes: c1 = LEFT, c0 = CENTER, c2 = RIGHT
  // Each flame has X / scale / brightness controls in the editor.
  // The "X" slider value gets applied as the X anchor, but Y/Z are
  // baked at the wick-tip coords so flames sit ON the candles by default.
  c0x:  0.106, c0scale: 1.0, c0bright: 1.0,   // CENTER wick
  c1x:  0.057, c1scale: 1.0, c1bright: 1.0,   // LEFT wick
  c2x:  0.057, c2scale: 1.0, c2bright: 1.0,   // RIGHT wick
  c0y: 0.609, c0z:  0.000,
  c1y: 0.607, c1z: -0.013,
  c2y: 0.607, c2z:  0.013,
};
try {
  const _stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
  for (const k of Object.keys(FLAME_TUNE)) {
    const v = _stored[`flame.${k}`];
    if (typeof v === 'number') FLAME_TUNE[k] = v;
  }
} catch {}
function _persistFlameTune() {
  try {
    const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    for (const k of Object.keys(FLAME_TUNE)) cur[`flame.${k}`] = FLAME_TUNE[k];
    localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
  } catch {}
}
window.__FLAME_TUNE = FLAME_TUNE;
window.__persistFlameTune = _persistFlameTune;

// High-quality procedural candle flame texture. Drawn at 256×512 so
// the shape stays crisp at sprite scale. Built from THREE alpha layers
// that combine to a realistic candle profile:
//   1. Faint outer red/orange halo (broad teardrop)
//   2. Mid orange-yellow body (narrower teardrop)
//   3. Hot white-yellow core (thin vertical wisp)
//   4. Tiny blue base above the wick (cool blue patch at the bottom)
// The y-axis is "up" (tip at top of canvas). PreMultipliedAlpha keeps
// the additive blend from looking grey when sprites overlap.
function _makeFlameTexture() {
  const W = 256, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  // Helper: vertical-teardrop gradient. cx/cy = "hot center", innerR =
  // hot core size, outerR = falloff distance, stops = list of [t, color].
  function drawTeardrop(cx, cy, hotW, hotH, tipBias, stops, blend = 'lighter') {
    ctx.save();
    ctx.globalCompositeOperation = blend;
    // Pixel-walk a bbox + sample distance via squashed circle (so it's
    // taller than wide → flame shape). tipBias > 0 makes the top half
    // pinch in for a sharper tip.
    const minX = Math.max(0, cx - hotW * 1.5);
    const maxX = Math.min(W, cx + hotW * 1.5);
    const minY = Math.max(0, cy - hotH * 1.6);
    const maxY = Math.min(H, cy + hotH * 0.9);
    const img = ctx.getImageData(minX|0, minY|0, (maxX-minX)|0, (maxY-minY)|0);
    const data = img.data;
    const w = (maxX-minX)|0;
    for (let yy = 0; yy < (maxY-minY)|0; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const px = minX + xx, py = minY + yy;
        const dx = (px - cx) / hotW;
        // Above the hot center, taper x by tipBias factor of vertical distance
        const above = Math.max(0, (cy - py) / hotH);
        const taper = 1 + tipBias * above;
        const dxT = dx * taper;
        const dy = (py - cy) / hotH;
        const r = Math.sqrt(dxT * dxT + dy * dy);
        // Sample stops (linear interp between adjacent stops)
        let cR = 0, cG = 0, cB = 0, cA = 0;
        for (let i = 0; i < stops.length - 1; i++) {
          const a = stops[i], b = stops[i + 1];
          if (r >= a[0] && r <= b[0]) {
            const t = (r - a[0]) / (b[0] - a[0] || 1);
            cR = a[1][0] + (b[1][0] - a[1][0]) * t;
            cG = a[1][1] + (b[1][1] - a[1][1]) * t;
            cB = a[1][2] + (b[1][2] - a[1][2]) * t;
            cA = a[1][3] + (b[1][3] - a[1][3]) * t;
            break;
          }
        }
        if (cA > 0) {
          // Additive blend into existing pixels (max-op gives clean
          // overlap without gray haze that 'screen' produces).
          const idx = (yy * w + xx) * 4;
          data[idx]     = Math.min(255, data[idx]     + cR * cA);
          data[idx + 1] = Math.min(255, data[idx + 1] + cG * cA);
          data[idx + 2] = Math.min(255, data[idx + 2] + cB * cA);
          data[idx + 3] = Math.min(255, data[idx + 3] + cA * 255);
        }
      }
    }
    ctx.putImageData(img, minX|0, minY|0);
    ctx.restore();
  }
  // Layer 1 — faint red-orange halo (broadest teardrop)
  drawTeardrop(W / 2, H * 0.62, W * 0.42, H * 0.34, 0.5, [
    [0.0, [255, 110,  30, 0.55]],
    [0.6, [220,  60,  10, 0.32]],
    [1.0, [120,  20,   0, 0.00]],
  ]);
  // Layer 2 — orange-yellow body (medium teardrop)
  drawTeardrop(W / 2, H * 0.66, W * 0.30, H * 0.30, 0.65, [
    [0.0, [255, 200,  80, 0.85]],
    [0.5, [255, 130,  30, 0.65]],
    [1.0, [180,  40,   0, 0.00]],
  ]);
  // Layer 3 — hot white-yellow core (thin and tall)
  drawTeardrop(W / 2, H * 0.70, W * 0.16, H * 0.27, 0.85, [
    [0.0, [255, 255, 230, 1.00]],
    [0.4, [255, 235, 150, 0.85]],
    [0.8, [255, 180,  60, 0.45]],
    [1.0, [255, 120,  20, 0.00]],
  ]);
  // Layer 4 — small cool blue base just above the wick
  drawTeardrop(W / 2, H * 0.84, W * 0.14, H * 0.06, 0.0, [
    [0.0, [120, 180, 255, 0.85]],
    [0.6, [ 40,  90, 180, 0.45]],
    [1.0, [ 20,  40,  90, 0.00]],
  ]);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.premultiplyAlpha = false;
  tex.needsUpdate = true;
  return tex;
}

const _flameTex = _makeFlameTexture();
const _flameSprites = [];   // {sprite, light, anchorIdx}
let _lumiereAttached = false;

function _attachFlamesToLumiere(group) {
  if (_lumiereAttached) return;
  _lumiereAttached = true;
  const baseScale = 0.65;       // sprite size in MODEL units (Lumiere bbox ~3.85)
  for (let i = 0; i < 3; i++) {
    const mat = new THREE.SpriteMaterial({
      map: _flameTex,
      color: new THREE.Color(FLAME_TUNE.hueR, FLAME_TUNE.hueG, FLAME_TUNE.hueB),
      transparent: true,
      opacity: 1.0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(baseScale, baseScale * 1.6, baseScale);
    sp.userData._baseScale = baseScale;
    group.add(sp);
    const light = new THREE.PointLight(
      new THREE.Color(FLAME_TUNE.lightR, FLAME_TUNE.lightG, FLAME_TUNE.lightB),
      FLAME_TUNE.lightIntensity, FLAME_TUNE.lightDistance, 2.0,
    );
    light.castShadow = false;
    group.add(light);
    _flameSprites.push({ sprite: sp, light, idx: i });
  }
  _applyFlameTune();
  console.log('[flames] attached 3 flames to Lumiere group');
}

function _applyFlameTune() {
  for (const f of _flameSprites) {
    const ax = ['c0x','c1x','c2x'][f.idx];
    const ay = ['c0y','c1y','c2y'][f.idx];
    const az = ['c0z','c1z','c2z'][f.idx];
    const as = ['c0scale','c1scale','c2scale'][f.idx];
    const ab = ['c0bright','c1bright','c2bright'][f.idx];
    f.sprite.position.set(FLAME_TUNE[ax], FLAME_TUNE[ay], FLAME_TUNE[az]);
    f.light.position.set(FLAME_TUNE[ax], FLAME_TUNE[ay], FLAME_TUNE[az]);
    f.sprite.material.color.setRGB(FLAME_TUNE.hueR, FLAME_TUNE.hueG, FLAME_TUNE.hueB);
    f.light.color.setRGB(FLAME_TUNE.lightR, FLAME_TUNE.lightG, FLAME_TUNE.lightB);
    f.sprite.visible = !!FLAME_TUNE.enabled;
    f.light.visible = !!FLAME_TUNE.enabled;
    // Stash per-flame scale + brightness on userData so the per-frame
    // pulse animation uses the latest values without rebuilding the
    // sprite each tick.
    f.sprite.userData._perScale = FLAME_TUNE[as];
    f.sprite.userData._perBright = FLAME_TUNE[ab];
  }
}
window.__applyFlameTune = _applyFlameTune;

// Watch for the Lumiere group to spawn (bank-spawned async), then attach.
(function watchLumiere() {
  let polls = 0;
  const tick = () => {
    if (_lumiereAttached) return;
    const grp = scene.getObjectByName('__prop_bank-lumiere_from__beauty_and_the_beast-mp04hs43-33');
    if (grp && grp.children.length > 0) {
      _attachFlamesToLumiere(grp);
      return;
    }
    polls++;
    if (polls < 300) setTimeout(tick, 250);   // poll for ~75s max
  };
  setTimeout(tick, 1000);
})();

// Per-frame animation: pulse the flame scale + flicker the light.
let _flameClock = 0;
let _flameLast = performance.now();
function _tickFlames() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - _flameLast) / 1000);
  _flameLast = now;
  _flameClock += dt * FLAME_TUNE.pulseSpeed;
  if (!FLAME_TUNE.enabled || _flameSprites.length === 0) return;
  for (const f of _flameSprites) {
    // Each flame uses a different phase so they don't pulse in sync.
    const phase = _flameClock + f.idx * 1.7;
    const pulse = 1 + FLAME_TUNE.pulseAmp * Math.sin(phase) * FLAME_TUNE.size;
    const flick = 1 + FLAME_TUNE.flickerAmp * (Math.sin(phase * 1.7) * 0.5 + Math.sin(phase * 0.9) * 0.5);
    const perScale = f.sprite.userData._perScale ?? 1.0;
    const perBright = f.sprite.userData._perBright ?? 1.0;
    const baseS = f.sprite.userData._baseScale * FLAME_TUNE.size * perScale;
    f.sprite.scale.set(baseS * pulse, baseS * pulse * 1.6, baseS * pulse);
    f.sprite.material.opacity = Math.min(1, perBright);
    f.light.intensity = FLAME_TUNE.lightIntensity * flick * perBright;
  }
}
// Hook into renderer's existing animation loop via a polling onBeforeRender
// callback. Renderer doesn't expose a hook directly; we patch the render
// fn so this runs once per frame without touching the main loop file.
{
  const _origRender = renderer.render.bind(renderer);
  renderer.render = function (s, c) { _tickFlames(); return _origRender(s, c); };
}

// ---------- Ice Age Nut: crop planes + animation pause -----------------
// Same recipe as the Wall-E boot crop, but per-prop and runtime-attached
// so it works for the bank-spawned `ice age nut 34`. Six world-space
// clip planes hug the nut's world bbox; offsets default to "no crop"
// and the user dials in per-side trim from the contextual editor.
// Animation pause sets the GLB mixer's timeScale to 0 (or restores to 1).
const NUT_CROP = { left: 1.0, right: 1.0, front: 1.0, back: 1.0, top: 1.0, bottom: 1.0 };
let NUT_PAUSED = 0;
try {
  const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
  for (const k of Object.keys(NUT_CROP)) {
    const v = stored[`nutCrop.${k}`];
    if (typeof v === 'number') NUT_CROP[k] = v;
  }
  if (typeof stored['nutCrop.paused'] === 'number') NUT_PAUSED = stored['nutCrop.paused'];
} catch {}
window.__NUT_CROP = NUT_CROP;
window.__getNutPaused = () => NUT_PAUSED;
window.__setNutPaused = (v) => {
  NUT_PAUSED = v ? 1 : 0;
  _persistNutCrop();
  _applyNutPause();
};
function _persistNutCrop() {
  try {
    const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    for (const k of Object.keys(NUT_CROP)) cur[`nutCrop.${k}`] = NUT_CROP[k];
    cur['nutCrop.paused'] = NUT_PAUSED;
    localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
  } catch {}
}
window.__persistNutCrop = _persistNutCrop;
// Six world-space planes. Inward-facing normals so a smaller offset
// crops MORE of the mesh on that side.
const NUT_CLIP_PLANES = [
  new THREE.Plane(new THREE.Vector3(0,  1, 0),  0),  // bottom (keep above)
  new THREE.Plane(new THREE.Vector3(0, -1, 0),  0),  // top    (keep below)
  new THREE.Plane(new THREE.Vector3( 1, 0, 0),  0),  // left   (keep right of)
  new THREE.Plane(new THREE.Vector3(-1, 0, 0),  0),  // right  (keep left of)
  new THREE.Plane(new THREE.Vector3(0, 0,  1),  0),  // back   (keep in front)
  new THREE.Plane(new THREE.Vector3(0, 0, -1),  0),  // front  (keep behind)
];
const _nutTmp = new THREE.Vector3();
const _nutScale = new THREE.Vector3();
let _nutGroup = null;
function _findNutGroup() {
  if (_nutGroup && _nutGroup.parent) return _nutGroup;
  _nutGroup = scene.getObjectByName('__prop_bank-ice_age_nut-mp05yot8-34') || null;
  return _nutGroup;
}
function _attachNutClipPlanes(grp) {
  if (!grp || grp.userData?.__nutClipApplied) return;
  grp.userData.__nutClipApplied = true;
  // Mutate the existing materials in place — DON'T clone. The previous
  // approach cloned each material, which forked off the editor's
  // `_baseColor` snapshot in userData and ended up rendering the nut
  // black when applyMaterials ran. Just attach the clipping planes; the
  // material's color, textures, and userData all stay intact.
  grp.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((m) => {
      m.clippingPlanes = NUT_CLIP_PLANES;
      m.clipShadows = true;
      m.needsUpdate = true;
    });
  });
}
function _applyNutPause() {
  const grp = _findNutGroup();
  if (!grp) return;
  const mixer = grp.userData?.__animMixer;
  if (mixer) {
    mixer.timeScale = NUT_PAUSED ? 0 : 1;
  }
}
window.__applyNutPause = _applyNutPause;
function _updateNutClipPlanes() {
  const grp = _findNutGroup();
  if (!grp || !grp.userData?.__nutClipApplied) return;
  grp.updateMatrixWorld(true);
  // Compute the mesh's world bbox so the crop window scales with
  // whatever scale the user has dialed.
  const bbox = new THREE.Box3().setFromObject(grp);
  if (!isFinite(bbox.min.x)) return;
  const cx = (bbox.min.x + bbox.max.x) / 2;
  const cy = (bbox.min.y + bbox.max.y) / 2;
  const cz = (bbox.min.z + bbox.max.z) / 2;
  const ex = Math.max(0.001, (bbox.max.x - bbox.min.x) / 2);   // half-extents
  const ey = Math.max(0.001, (bbox.max.y - bbox.min.y) / 2);
  const ez = Math.max(0.001, (bbox.max.z - bbox.min.z) / 2);
  // Each NUT_CROP key is a 0..1+ multiplier on the corresponding bbox
  // half-extent. 1.0 = no crop (plane sits at the bbox edge); lower =
  // crop inward.
  NUT_CLIP_PLANES[0].constant = -(cy - NUT_CROP.bottom * ey);   // bottom
  NUT_CLIP_PLANES[1].constant =  (cy + NUT_CROP.top    * ey);   // top
  NUT_CLIP_PLANES[2].constant = -(cx - NUT_CROP.left   * ex);   // left
  NUT_CLIP_PLANES[3].constant =  (cx + NUT_CROP.right  * ex);   // right
  NUT_CLIP_PLANES[4].constant = -(cz - NUT_CROP.back   * ez);   // back
  NUT_CLIP_PLANES[5].constant =  (cz + NUT_CROP.front  * ez);   // front
}
// Hook into the renderer's per-frame loop. The flames patcher already
// wrapped renderer.render; we wrap that wrapper so both run per frame.
{
  const _origRender2 = renderer.render.bind(renderer);
  renderer.render = function (s, c) { _updateNutClipPlanes(); return _origRender2(s, c); };
}
// Also wire the renderer to actually clip — without localClippingEnabled
// (set at module init) the planes are ignored.
renderer.localClippingEnabled = true;
// Watcher: as soon as the nut group exists in scene, attach clipping
// + apply persisted pause state.
(function watchNut() {
  let polls = 0;
  const tick = () => {
    const grp = _findNutGroup();
    if (grp && grp.children.length > 0) {
      _attachNutClipPlanes(grp);
      _applyNutPause();
      // If the user merged the nut into the Nut case in a previous
      // session, re-parent it now so they share a transform tree on
      // every reload (move + scale + rotate together).
      try {
        const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
        if (stored['nutCase.merged']) {
          const caseGrp = window.__nutCaseGroup;
          if (caseGrp) {
            caseGrp.attach(grp);
            const yOffset = (typeof stored['nutCase.mergedNutLocalY'] === 'number')
              ? stored['nutCase.mergedNutLocalY']
              : (NUT_CASE_DIMS.base + NUT_CASE_DIMS.poleLength + 0.02);
            grp.position.set(0, yOffset, 0);
            grp.updateMatrixWorld(true);
            console.log('[nut] re-merged under Nut case (sentinel restored).');
          }
        }
      } catch {}
      console.log('[nut] crop planes attached, pause=' + NUT_PAUSED);
      return;
    }
    polls++;
    if (polls < 300) setTimeout(tick, 250);
  };
  setTimeout(tick, 1000);
})();

// EMERGENCY RECOVERY (sentinel `emergency.recover.v1`).
// Runs ONCE on this reload. Surgically fixes the cluster-on-Mac symptom
// without nuking your good work:
//   1. Wipes every entry in `pairLocks.v1` so items stop following each
//      other. Item positions are NOT touched here.
//   2. For each `item.<label>.{x,y,z}` whose absolute coord is > 20 m
//      (clearly off-screen / trash), deletes it so loadProp falls back
//      to that prop's hardcoded target.
//   3. Restores any collapsed editor sections to their default open
//      state (so you can find every section easily).
//   4. Clears any in-memory recovery sentinels for the lightsaber case
//      so the cleanup runs again if needed.
(function emergencyRecover() {
  try {
    const SENTINEL = 'emergency.recover.v1';
    const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    if (cur[SENTINEL]) return;
    let cleared = 0;
    // 1. Wipe every pair-lock so items decouple.
    try {
      const pairs = JSON.parse(localStorage.getItem('pairLocks.v1') || '[]');
      if (Array.isArray(pairs) && pairs.length) {
        localStorage.setItem('pairLocks.v1', '[]');
        cleared += pairs.length;
      }
    } catch {}
    // 2. Sweep item position keys with extreme values back to defaults.
    for (const k of Object.keys(cur)) {
      const m = k.match(/^item\.(.+)\.(x|y|z)$/);
      if (!m) continue;
      const v = cur[k];
      if (typeof v !== 'number') continue;
      // World coords > 20 m or < -20 m on any axis are almost certainly
      // drift / pair-lock damage. Reset to default by deleting.
      if (Math.abs(v) > 20) {
        delete cur[k];
        cleared++;
      }
    }
    // 3. Clear collapse state so every section is reachable.
    for (const k of Object.keys(cur)) {
      if (/\.collapse\./.test(k)) { delete cur[k]; cleared++; }
    }
    // 4. Clear lightsaber-case sentinels so its cleanup re-runs.
    delete cur['cleanup.saberCase.v1'];
    cur[SENTINEL] = true;
    localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
    if (cleared > 0) console.log(`[recover] EMERGENCY — cleared ${cleared} bad pair-lock / position / collapse key(s). Items should be back where they belong.`);
  } catch {}
})();
// (Lightsaber case auto-pair removed.)
// One-shot cleanup: wipe any pair-locks the disabled case introduced
// and remove any "Lightsaber case" rows from persisted item state so
// reload doesn't try to bring back what the user reverted.
(function cleanupLightsaberCase() {
  try {
    const SENTINEL = 'cleanup.saberCase.v1';
    const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    if (cur[SENTINEL]) return;
    let changed = false;
    // Drop item.Lightsaber_case.* + saberCase.* + saberCaseGlass.* +
    // saberCaseLight.* keys.
    for (const k of Object.keys(cur)) {
      if (
        /^item\.Lightsaber_case\./.test(k) ||
        /^saberCase\./.test(k) ||
        /^saberCaseGlass\./.test(k) ||
        /^saberCaseLight\./.test(k)
      ) {
        delete cur[k];
        changed = true;
      }
    }
    cur[SENTINEL] = true;
    localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
    // Strip pair-locks naming the lightsaber case (anchor or follower).
    try {
      const pairs = JSON.parse(localStorage.getItem('pairLocks.v1') || '[]');
      if (Array.isArray(pairs)) {
        const filtered = pairs.filter((e) => e?.anchor !== 'Lightsaber case' && e?.follower !== 'Lightsaber case');
        if (filtered.length !== pairs.length) {
          localStorage.setItem('pairLocks.v1', JSON.stringify(filtered));
          changed = true;
        }
      }
    } catch {}
    if (changed) console.log('[recover] removed lightsaber-case state — items return to pre-case positions.');
  } catch {}
})();

// ---------- Art frame (white canvas + thin dark wooden border) ---------
// A flat picture-frame prop. Center is an off-white "canvas"; the border
// is four dark-wood strips. Selectable, persisted, click-through canvas
// (so you can grab anything inside if you ever overlap something with it).
(function buildArtFrame() {
  const group = new THREE.Group();
  group.name = '__prop_artframe';
  scene.add(group);

  // Dimensions in metres. Default is a slim 0.45 × 0.65 portrait frame.
  const FRAME = { w: 0.45, h: 0.65, border: 0.025, depth: 0.018 };
  try {
    const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    if (typeof stored['artFrame.w']      === 'number' && stored['artFrame.w']      > 0.05) FRAME.w      = stored['artFrame.w'];
    if (typeof stored['artFrame.h']      === 'number' && stored['artFrame.h']      > 0.05) FRAME.h      = stored['artFrame.h'];
    if (typeof stored['artFrame.border'] === 'number' && stored['artFrame.border'] > 0.005) FRAME.border = stored['artFrame.border'];
    if (typeof stored['artFrame.depth']  === 'number' && stored['artFrame.depth']  > 0.005) FRAME.depth  = stored['artFrame.depth'];
  } catch {}

  const woodMat = new THREE.MeshStandardMaterial({
    color: 0x1f1408,        // dark wenge / espresso wood
    roughness: 0.6,
    metalness: 0.05,
  });
  const canvasMat = new THREE.MeshStandardMaterial({
    color: 0xf5f1e8,        // warm off-white "primed canvas"
    roughness: 0.92,
    metalness: 0.0,
  });
  // Persistent meshes — geometries swap on resize.
  const top    = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), woodMat);
  const bottom = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), woodMat);
  const left   = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), woodMat);
  const right  = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), woodMat);
  const canvasFace = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), canvasMat);
  [top, bottom, left, right, canvasFace].forEach((m) => { m.castShadow = true; m.receiveShadow = true; });
  // Both wood border AND canvas are clickable — the user said the frame
  // wasn't easy to grab when only the thin border accepted clicks. Now
  // any pixel of the frame opens its contextual editor with full
  // position / rotation / scale sliders.
  group.add(top, bottom, left, right, canvasFace);
  // Stash the group so the Sliders menu can also reach the editor without
  // requiring the user to click on the wood every time.
  window.__artFrameGroup = group;

  function rebuildFrame() {
    const { w, h, border, depth } = FRAME;
    const innerW = Math.max(0.01, w - border * 2);
    const innerH = Math.max(0.01, h - border * 2);
    // Top & bottom strips: full width
    top.geometry.dispose();    top.geometry    = new THREE.BoxGeometry(w, border, depth);
    top.position.set(0,  h / 2 - border / 2, 0);
    bottom.geometry.dispose(); bottom.geometry = new THREE.BoxGeometry(w, border, depth);
    bottom.position.set(0, -h / 2 + border / 2, 0);
    // Left & right strips: only the inner height (avoid double-thickness corners)
    left.geometry.dispose();   left.geometry   = new THREE.BoxGeometry(border, innerH, depth);
    left.position.set(-w / 2 + border / 2, 0, 0);
    right.geometry.dispose();  right.geometry  = new THREE.BoxGeometry(border, innerH, depth);
    right.position.set(w / 2 - border / 2, 0, 0);
    // Canvas face: slightly recessed behind the wood (z = -depth/4)
    canvasFace.geometry.dispose();
    canvasFace.geometry = new THREE.BoxGeometry(innerW, innerH, depth * 0.4);
    canvasFace.position.set(0, 0, -depth * 0.05);
  }
  rebuildFrame();
  // Expose for the editor sliders.
  window.__rebuildArtFrame = rebuildFrame;
  window.__artFrameDims = FRAME;

  // Default: hung on the back wall, eye-height. User moves via gizmo.
  group.position.set(-1.0, 1.6, -3.5);
  // Honor persisted item position + visibility.
  try {
    const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    const k = 'item.Speed_frame';
    if (typeof stored[`${k}.x`]    === 'number') group.position.x = stored[`${k}.x`];
    if (typeof stored[`${k}.y`]    === 'number') group.position.y = stored[`${k}.y`];
    if (typeof stored[`${k}.z`]    === 'number') group.position.z = stored[`${k}.z`];
    if (typeof stored[`${k}.rotX`] === 'number') group.rotation.x = stored[`${k}.rotX`];
    if (typeof stored[`${k}.rotY`] === 'number') group.rotation.y = stored[`${k}.rotY`];
    if (typeof stored[`${k}.rotZ`] === 'number') group.rotation.z = stored[`${k}.rotZ`];
    if (typeof stored[`${k}.scale`] === 'number' && stored[`${k}.scale`] > 0.01) group.scale.setScalar(stored[`${k}.scale`]);
    const hidden = JSON.parse(localStorage.getItem('hidden.props.v1') || '[]');
    if (Array.isArray(hidden) && (hidden.includes('Art frame') || hidden.includes('Speed frame'))) group.visible = false;
  } catch {}

  makeSelectable(group, 'Speed frame');
})();

// ---------- Fly-mode item lock -----------------------------------------
// While locked, an item's world position tracks the camera at a fixed
// camera-LOCAL offset. So if you've put a Nike at arm's length in front
// of you, locking it makes it hover at that same arm's-length position
// regardless of where you fly. Click "🔓 Unlock from camera" to drop it.
const _flyLocked = new Map();   // group → THREE.Vector3 camera-local offset
window.__lockToCamera = function (group) {
  if (!group) return;
  group.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  const worldPos = new THREE.Vector3();
  group.getWorldPosition(worldPos);
  // Convert to camera-local.
  const cameraLocal = worldPos.clone().applyMatrix4(new THREE.Matrix4().copy(camera.matrixWorld).invert());
  _flyLocked.set(group, cameraLocal);
};
window.__unlockFromCamera = function (group) { _flyLocked.delete(group); };
window.__isLockedToCamera = function (group) { return _flyLocked.has(group); };

const _flyLockTmp = new THREE.Vector3();
function updateFlyLocks() {
  if (_flyLocked.size === 0) return;
  camera.updateMatrixWorld(true);
  _flyLocked.forEach((cameraLocalOffset, group) => {
    if (!group.parent) return;
    _flyLockTmp.copy(cameraLocalOffset).applyMatrix4(camera.matrixWorld);
    group.parent.worldToLocal(_flyLockTmp);
    group.position.copy(_flyLockTmp);
    // Persist position so reload keeps the dragged spot
    const label = (() => {
      const sel = SELECTABLE.find((s) => s.group === group);
      return sel ? sel.label : null;
    })();
    if (label) {
      try {
        const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
        const sk = `item.${label.replace(/\s+/g, '_')}`;
        cur[`${sk}.x`] = group.position.x;
        cur[`${sk}.y`] = group.position.y;
        cur[`${sk}.z`] = group.position.z;
        localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
      } catch {}
    }
  });
}

// ---------- Sibling pair-lock ------------------------------------------
// Lock follower → anchor with a fixed WORLD-space offset captured at
// lock-time. Each frame the follower's world position is rewritten as
// anchor.world + offset, then translated back into the follower's parent
// frame. Unlike a re-parent, this does NOT corrupt the follower's
// persisted local coords (because the follower stays under its original
// parent), and it works across any parent hierarchy.
//
// Persisted under `pairLocks.v1` as [{anchor:label, follower:label}, ...].
// Restored on boot once both endpoints are present in SELECTABLE.
const _pairLocked = new Map();        // followerGroup -> { anchorGroup, offset:THREE.Vector3 }
const _pairTmp = new THREE.Vector3();
const _pairAnchorWP = new THREE.Vector3();
const PAIR_KEY = 'pairLocks.v1';
function _loadPairList() {
  try { return JSON.parse(localStorage.getItem(PAIR_KEY) || '[]') || []; }
  catch { return []; }
}
function _savePairList(list) {
  try { localStorage.setItem(PAIR_KEY, JSON.stringify(list)); } catch {}
}
function pairLock(anchorGroup, followerGroup) {
  if (!anchorGroup || !followerGroup || anchorGroup === followerGroup) return;
  anchorGroup.updateMatrixWorld(true);
  followerGroup.updateMatrixWorld(true);
  const aw = new THREE.Vector3(); anchorGroup.getWorldPosition(aw);
  const fw = new THREE.Vector3(); followerGroup.getWorldPosition(fw);
  // Capture both translation AND rotation deltas. The rotation offset is
  // the quaternion that takes the anchor's world rotation to the
  // follower's world rotation: rotOffset = inverse(aq) * fq.
  const aq = new THREE.Quaternion(); anchorGroup.getWorldQuaternion(aq);
  const fq = new THREE.Quaternion(); followerGroup.getWorldQuaternion(fq);
  const rotOffset = aq.clone().invert().multiply(fq);
  _pairLocked.set(followerGroup, {
    anchorGroup,
    offset: fw.clone().sub(aw),
    rotOffset,
  });
}
function pairUnlock(followerGroup) { _pairLocked.delete(followerGroup); }
function persistPair(anchorLabel, followerLabel, offset) {
  const list = _loadPairList().filter((e) => e.follower !== followerLabel);
  const entry = { anchor: anchorLabel, follower: followerLabel };
  if (offset && (typeof offset.x === 'number' || offset.x !== undefined)) {
    entry.offset = { x: offset.x, y: offset.y, z: offset.z };
  }
  list.push(entry);
  _savePairList(list);
}
function persistUnpair(followerLabel) {
  _savePairList(_loadPairList().filter((e) => e.follower !== followerLabel));
}
// Find a SELECTABLE by label and write the current pair-lock offset
// for `followerLabel` back to localStorage. Called whenever the offset
// changes (drag-end, slider, etc.) so reload restores the exact
// relationship.
function persistPairOffset(followerLabel) {
  let info = null;
  _pairLocked.forEach((v, k) => {
    if (k && SELECTABLE.find((s) => s.group === k && s.label === followerLabel)) info = v;
  });
  if (!info) return;
  const list = _loadPairList();
  const e = list.find((x) => x.follower === followerLabel);
  if (!e) return;
  e.offset = { x: info.offset.x, y: info.offset.y, z: info.offset.z };
  if (info.rotOffset) {
    e.rotOffset = { x: info.rotOffset.x, y: info.rotOffset.y, z: info.rotOffset.z, w: info.rotOffset.w };
  }
  _savePairList(list);
}
window.__persistPairOffset = persistPairOffset;
window.__pairLock = pairLock;
window.__pairUnlock = pairUnlock;
window.__persistPair = persistPair;
window.__persistUnpair = persistUnpair;
const _pairTmpQuat = new THREE.Quaternion();
const _pairAnchorQuat = new THREE.Quaternion();
const _pairParentQuat = new THREE.Quaternion();
function updatePairLocks() {
  if (_pairLocked.size === 0) return;
  _pairLocked.forEach((info, follower) => {
    if (!follower.parent || !info.anchorGroup) return;
    if (tDragging && selectedItem?.group === follower) return;
    info.anchorGroup.updateMatrixWorld(true);
    // Position — only re-apply when the anchor has actually moved
    // beyond floating-point noise. Without this guard, every frame
    // re-multiplies tiny imprecisions and the follower drifts.
    info.anchorGroup.getWorldPosition(_pairAnchorWP);
    if (!info.lastAnchorPos) info.lastAnchorPos = new THREE.Vector3(NaN, NaN, NaN);
    if (
      Number.isNaN(info.lastAnchorPos.x) ||
      Math.abs(_pairAnchorWP.x - info.lastAnchorPos.x) > 1e-5 ||
      Math.abs(_pairAnchorWP.y - info.lastAnchorPos.y) > 1e-5 ||
      Math.abs(_pairAnchorWP.z - info.lastAnchorPos.z) > 1e-5 ||
      info.offsetDirty
    ) {
      _pairTmp.copy(_pairAnchorWP).add(info.offset);
      follower.parent.worldToLocal(_pairTmp);
      follower.position.copy(_pairTmp);
      info.lastAnchorPos.copy(_pairAnchorWP);
      info.offsetDirty = false;
    }
    // Rotation — same change-detection guard.
    if (info.rotOffset) {
      info.anchorGroup.getWorldQuaternion(_pairAnchorQuat);
      if (!info.lastAnchorQuat) info.lastAnchorQuat = new THREE.Quaternion(NaN, NaN, NaN, NaN);
      if (
        Number.isNaN(info.lastAnchorQuat.x) ||
        Math.abs(_pairAnchorQuat.x - info.lastAnchorQuat.x) > 1e-5 ||
        Math.abs(_pairAnchorQuat.y - info.lastAnchorQuat.y) > 1e-5 ||
        Math.abs(_pairAnchorQuat.z - info.lastAnchorQuat.z) > 1e-5 ||
        Math.abs(_pairAnchorQuat.w - info.lastAnchorQuat.w) > 1e-5 ||
        info.rotOffsetDirty
      ) {
        _pairTmpQuat.copy(_pairAnchorQuat).multiply(info.rotOffset);
        follower.parent.getWorldQuaternion(_pairParentQuat);
        _pairParentQuat.invert().multiply(_pairTmpQuat);
        follower.quaternion.copy(_pairParentQuat);
        info.lastAnchorQuat.copy(_pairAnchorQuat);
        info.rotOffsetDirty = false;
      }
    }
  });
}
// Recompute pair-lock offsets after a drag of either the anchor or
// follower. For the follower: offset = follower.world - anchor.world,
// so its current dragged spot becomes the new "locked" relationship.
function recomputeAllPairOffsetsForGroup(group) {
  if (!group || _pairLocked.size === 0) return;
  if (_pairLocked.has(group)) {
    const info = _pairLocked.get(group);
    if (info.anchorGroup) {
      info.anchorGroup.updateMatrixWorld(true);
      group.updateMatrixWorld(true);
      const aw = new THREE.Vector3(); info.anchorGroup.getWorldPosition(aw);
      const fw = new THREE.Vector3(); group.getWorldPosition(fw);
      info.offset.copy(fw.sub(aw));
      const aq = new THREE.Quaternion(); info.anchorGroup.getWorldQuaternion(aq);
      const fq = new THREE.Quaternion(); group.getWorldQuaternion(fq);
      if (!info.rotOffset) info.rotOffset = new THREE.Quaternion();
      info.rotOffset.copy(aq.invert().multiply(fq));
      // Mark dirty so updatePairLocks re-applies on the next frame
      // even if the anchor hasn't moved.
      info.offsetDirty = true;
      info.rotOffsetDirty = true;
    }
  }
}
// ---------- AT-AT walker circular orbit -------------------------------
// Auto-detects any SELECTABLE item whose label looks like an AT-AT
// (matches /at.?at|at attm/i — covers "Lego at attm ucs 75313 1" etc),
// captures its starting world position as the orbit center, and slowly
// rotates it around that center on the X/Z plane each frame. Heading
// (group.rotation.y) is updated so the walker faces the direction of
// motion. Toggle off via window.__atAtCircle = false; tune via
// window.__atAtRadius / __atAtSpeedRadPerSec.
window.__atAtCircle = true;
window.__atAtRadius = 0.40;
window.__atAtSpeedRadPerSec = 0.18;       // ~35 s per revolution
const _atAtState = { group: null, cx: 0, cy: 0, cz: 0, angle: 0 };
const _atAtTmp = new THREE.Vector3();
function _findAtAtAndCapture() {
  if (_atAtState.group) return;
  const sel = SELECTABLE.find((s) => /at.?at|at[ -]?attm/i.test(s.label || ''));
  if (!sel?.group) return;
  sel.group.updateMatrixWorld(true);
  sel.group.getWorldPosition(_atAtTmp);
  _atAtState.group = sel.group;
  _atAtState.cx = _atAtTmp.x;
  _atAtState.cy = _atAtTmp.y;
  _atAtState.cz = _atAtTmp.z;
  console.log(`[at-at] orbit center captured at world (${_atAtTmp.x.toFixed(2)}, ${_atAtTmp.y.toFixed(2)}, ${_atAtTmp.z.toFixed(2)}).`);
}
let _atAtPolls = 0;
const _atAtPollTimer = setInterval(() => {
  _atAtPolls++;
  _findAtAtAndCapture();
  if (_atAtState.group || _atAtPolls > 15) clearInterval(_atAtPollTimer);
}, 1000);
let _atAtLastT = performance.now();
function updateAtAtOrbit() {
  if (!window.__atAtCircle) return;
  if (!_atAtState.group || !_atAtState.group.parent) return;
  const now = performance.now();
  const dt = Math.min(0.1, (now - _atAtLastT) / 1000);
  _atAtLastT = now;
  _atAtState.angle += (window.__atAtSpeedRadPerSec || 0.18) * dt;
  const r = window.__atAtRadius || 0.40;
  const targetWX = _atAtState.cx + Math.cos(_atAtState.angle) * r;
  const targetWZ = _atAtState.cz + Math.sin(_atAtState.angle) * r;
  // Translate to target world X/Z by adding world-delta to local position
  // (parent assumed to have no rotation — true for scene & bookshelf here).
  _atAtState.group.updateMatrixWorld(true);
  _atAtState.group.getWorldPosition(_atAtTmp);
  _atAtState.group.position.x += targetWX - _atAtTmp.x;
  _atAtState.group.position.z += targetWZ - _atAtTmp.z;
  // Heading — face direction of motion. Velocity tangent to circle:
  // (-sin a, 0, cos a). Yaw from +X axis = atan2(cos a, -sin a).
  const yaw = Math.atan2(Math.cos(_atAtState.angle), -Math.sin(_atAtState.angle));
  _atAtState.group.rotation.y = yaw;
}
// ---------- Falcon ↔ TIE chase + red lasers ---------------------------
// Auto-detects the LEGO Millennium Falcon and a TIE Fighter when both
// have been spawned. Falcon flies a slow figure-8 path around its
// starting position; TIE follows the Falcon's path with a delay,
// always pointing at it. Every ~1.4 s the TIE fires a red laser bolt
// from its nose toward the Falcon's CURRENT position. Bolts are short
// emissive cylinders that travel for ~0.8 s then despawn.
//
// All toggleable + tunable from the dev console:
//   window.__falconChase          = true | false
//   window.__falconChaseRadius    = 0.7   (orbit radius)
//   window.__falconChaseSpeed     = 0.4   (rad/s — full lap = ~16 s)
//   window.__falconChaseElevation = 0.18  (vertical wobble amplitude)
//   window.__tieDelaySeconds      = 0.8   (lag behind the Falcon)
//   window.__tieLaserInterval     = 1.4   (seconds between shots)
// Falcon↔TIE chase animation OFF by default per user request — too
// distracting. Toggle on/off via `window.__falconChase = true` from the
// console, or set the `falconChase.enabled` localStorage key.
window.__falconChase = (() => {
  if (typeof window.__falconChase === 'boolean') return window.__falconChase;
  try {
    const v = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}')['falconChase.enabled'];
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number')  return !!v;
  } catch {}
  return false;
})();
window.__falconChaseRadius = window.__falconChaseRadius ?? 0.7;
window.__falconChaseSpeed = window.__falconChaseSpeed ?? 0.4;
window.__falconChaseElevation = window.__falconChaseElevation ?? 0.18;
window.__tieDelaySeconds = window.__tieDelaySeconds ?? 0.8;
window.__tieLaserInterval = window.__tieLaserInterval ?? 1.4;
const _falconChase = {
  falcon: null, tie: null,
  origin: new THREE.Vector3(),
  t: 0,
  history: [],   // [{ t, x, y, z }] — falcon path, sampled every frame for the TIE delay
  lastShot: 0,
  bolts: [],     // [{ mesh, dir, life, lifeMax }]
};
const _falconTmp = new THREE.Vector3();
const _falconTmp2 = new THREE.Vector3();
function _findFalconAndTie() {
  if (!_falconChase.falcon) {
    const sel = SELECTABLE.find((s) => /falcon|millenn/i.test(s.label || ''));
    if (sel?.group) {
      _falconChase.falcon = sel.group;
      sel.group.updateMatrixWorld(true);
      sel.group.getWorldPosition(_falconChase.origin);
    }
  }
  if (!_falconChase.tie) {
    const sel = SELECTABLE.find((s) => /\btie\b|tie.fighter/i.test(s.label || ''));
    if (sel?.group) _falconChase.tie = sel.group;
  }
}
function _spawnRedLaserBolt(originWP, targetWP) {
  // Cylinder oriented along Y by default; we point it from origin → target.
  const dir = new THREE.Vector3().subVectors(targetWP, originWP);
  const distance = Math.max(0.05, dir.length());
  dir.normalize();
  const geo = new THREE.CylinderGeometry(0.012, 0.012, 0.45, 8);
  const mat = new THREE.MeshBasicMaterial({ color: 0xff2030, toneMapped: false, transparent: true, opacity: 0.95 });
  const mesh = new THREE.Mesh(geo, mat);
  // Position at origin + half-length along dir.
  const startPos = originWP.clone().addScaledVector(dir, 0.22);
  mesh.position.copy(startPos);
  // Orient cylinder Y axis to face dir.
  const up = new THREE.Vector3(0, 1, 0);
  mesh.quaternion.setFromUnitVectors(up, dir);
  scene.add(mesh);
  _falconChase.bolts.push({
    mesh, dir, life: 0, lifeMax: 0.85,
    speed: 8.0,
  });
}
let _falconLastT = performance.now();
function updateFalconChase() {
  if (!window.__falconChase) return;
  const now = performance.now();
  const dt = Math.min(0.1, (now - _falconLastT) / 1000);
  _falconLastT = now;
  _findFalconAndTie();
  // Animate Falcon along a figure-8 around its starting origin.
  if (_falconChase.falcon && _falconChase.falcon.parent) {
    _falconChase.t += dt * window.__falconChaseSpeed;
    const r = window.__falconChaseRadius;
    const fx = _falconChase.origin.x + Math.cos(_falconChase.t) * r;
    const fz = _falconChase.origin.z + Math.sin(_falconChase.t * 2) * r * 0.55; // figure-8
    const fy = _falconChase.origin.y + Math.sin(_falconChase.t * 1.2) * window.__falconChaseElevation;
    _falconChase.falcon.updateMatrixWorld(true);
    _falconChase.falcon.getWorldPosition(_falconTmp);
    _falconChase.falcon.position.x += fx - _falconTmp.x;
    _falconChase.falcon.position.y += fy - _falconTmp.y;
    _falconChase.falcon.position.z += fz - _falconTmp.z;
    // Heading — face the velocity direction.
    const dx = -Math.sin(_falconChase.t) * r;
    const dz =  Math.cos(_falconChase.t * 2) * r * 0.55 * 2;
    _falconChase.falcon.rotation.y = Math.atan2(dx, dz);
    // Sample history for the TIE to follow with a delay.
    _falconChase.history.push({ t: now, x: fx, y: fy, z: fz });
    if (_falconChase.history.length > 600) _falconChase.history.shift();
  }
  // TIE follows the Falcon's path delayed by `tieDelaySeconds`, looking
  // at the Falcon's current position so it's always "chasing".
  if (_falconChase.tie && _falconChase.tie.parent && _falconChase.history.length > 1) {
    const targetT = now - window.__tieDelaySeconds * 1000;
    let entry = _falconChase.history[0];
    for (const h of _falconChase.history) { if (h.t <= targetT) entry = h; else break; }
    _falconChase.tie.updateMatrixWorld(true);
    _falconChase.tie.getWorldPosition(_falconTmp);
    _falconChase.tie.position.x += entry.x - _falconTmp.x;
    _falconChase.tie.position.y += entry.y - _falconTmp.y;
    _falconChase.tie.position.z += entry.z - _falconTmp.z;
    if (_falconChase.falcon) {
      _falconChase.falcon.getWorldPosition(_falconTmp2);
      _falconChase.tie.lookAt(_falconTmp2);
    }
    // Fire a laser bolt periodically.
    if ((now - _falconChase.lastShot) / 1000 > window.__tieLaserInterval) {
      _falconChase.lastShot = now;
      _falconChase.tie.getWorldPosition(_falconTmp);
      if (_falconChase.falcon) {
        _falconChase.falcon.getWorldPosition(_falconTmp2);
        _spawnRedLaserBolt(_falconTmp, _falconTmp2);
      }
    }
  }
  // Animate active laser bolts forward + despawn after lifeMax.
  if (_falconChase.bolts.length) {
    const live = [];
    for (const b of _falconChase.bolts) {
      b.life += dt;
      if (b.life >= b.lifeMax) {
        b.mesh.parent?.remove(b.mesh);
        b.mesh.geometry?.dispose();
        b.mesh.material?.dispose();
        continue;
      }
      // Travel along dir.
      b.mesh.position.addScaledVector(b.dir, b.speed * dt);
      // Fade tail at the end.
      if (b.life > b.lifeMax * 0.7) {
        b.mesh.material.opacity = Math.max(0, 0.95 * (1 - (b.life - b.lifeMax * 0.7) / (b.lifeMax * 0.3)));
      }
      live.push(b);
    }
    _falconChase.bolts = live;
  }
}
window.__resetFalconChase = () => {
  _falconChase.falcon = null;
  _falconChase.tie = null;
  _falconChase.history.length = 0;
};
// ---------- Mirrored bookshelf ----------------------------------------
// Duplicates the wooden bookshelf onto the right side of the room
// (mirrored about X = 0). Strips user props out of the mirror so the
// right shelf starts empty + recreates the warm strip lights at
// mirrored positions. Idempotent — calls after the first are no-ops.
let _mirroredBookshelf = null;
function buildMirroredBookshelf() {
  if (_mirroredBookshelf) return _mirroredBookshelf;
  const bg = propGroups.bookshelf?.group;
  if (!bg) return null;
  // Snapshot strip-light local positions on the ORIGINAL bookshelf
  // before we clone — we recreate them on the mirror at the same
  // bookshelf-local coords so they sit dead-center on each shelf
  // regardless of where the mirror is positioned in world.
  const stripLocals = [];
  // ONLY clone the 5 main shelf-strip lights (one per shelf level).
  // The bookshelf group also contains 2 leftover "UnderLight" point
  // lights at intensity 0.2 / distance 0.5 from older code paths —
  // those caused the bottom compartment to look like it had 3 lights
  // stacked. Membership-test against the canonical `stripLights` array
  // so any future strip count change keeps working.
  const stripSet = new Set(typeof stripLights !== 'undefined' ? stripLights : []);
  bg.traverse((o) => {
    if (o.isPointLight && o !== bg && stripSet.has(o)) {
      const lp = o.position.clone();
      let p = o.parent;
      while (p && p !== bg) {
        lp.applyMatrix4(p.matrix);
        p = p.parent;
      }
      stripLocals.push({
        x: lp.x, y: lp.y, z: lp.z,
        color: o.color.getHex(),
        intensity: o.intensity,
        distance: o.distance,
        decay: o.decay,
      });
    }
  });
  const mirror = bg.clone(true);
  mirror.name = '__bookshelfMirror';
  // Strip user-prop subtrees + cloned lights.
  const toRemove = [];
  mirror.traverse((o) => {
    if (o === mirror) return;
    if (o.name && (o.name.startsWith('__prop_') || o.name === '__bootPlant')) toRemove.push(o);
    else if (o.isLight) toRemove.push(o);
  });
  toRemove.forEach((o) => o.parent?.remove(o));
  // Pure DUPLICATE (no negative scale) — same orientation as the
  // original, translated to the mirrored X. Earlier versions used
  // scale.x = -1 to make a true reflection, but the negative scale
  // invalidated point-light positions and required DoubleSide hacks
  // on every cloned material. Cleaner to just duplicate and let the
  // user rotate the duplicate via the right-shelf rotY slider if
  // they want it facing inward.
  mirror.scale.set(1, 1, 1);
  mirror.position.x = -bg.position.x;
  mirror.position.y = bg.position.y;
  mirror.position.z = bg.position.z;
  mirror.rotation.copy(bg.rotation);
  // Track every cloned material for the editor's brightness/reflection.
  const mirrorMats = [];
  mirror.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const cloned = mats.map((m) => {
      const c = m.clone();
      mirrorMats.push(c);
      return c;
    });
    o.material = cloned.length === 1 ? cloned[0] : cloned;
  });
  // Recreate fresh strip lights as CHILDREN of the mirror at the same
  // local positions we sampled from the original. They'll inherit the
  // mirror's transform (including scale.x = -1, which mirrors X
  // automatically), and the editor sliders can drive their intensity
  // + color in lockstep.
  const mirrorLights = [];
  for (const s of stripLocals) {
    const pl = new THREE.PointLight(s.color, s.intensity, s.distance, s.decay);
    pl.position.set(s.x, s.y, s.z);
    pl.castShadow = false;
    // Stash the BASE position so updateStripPositions can re-apply the
    // global X/Y/Z strip offsets to mirror lights too. Without this
    // they were created once and never moved, so the Right shelf X/Y/Z
    // light sliders only affected the left side.
    pl.userData._mirrorBaseX = s.x;
    pl.userData._mirrorBaseY = s.y;
    pl.userData._mirrorBaseZ = s.z;
    mirror.add(pl);
    mirrorLights.push(pl);
  }
  mirror.userData.__rightShelfLights = mirrorLights;
  mirror.userData.__rightShelfMats = mirrorMats;
  scene.add(mirror);
  _mirroredBookshelf = mirror;
  // Sync the new right-shelf lights to the left shelf's CURRENT warmth +
  // brightness so they match exactly. The setters now iterate both sets
  // (see _allShelfLights), but they only ran for the left side before
  // the mirror existed — re-running with the cached values fixes that.
  if (typeof setStripWarmth === 'function') setStripWarmth(_stripWarmthCache);
  if (typeof setStripBrightness === 'function') setStripBrightness(_stripBrightnessCache);
  // Apply persisted right-shelf transform (from the Sliders → Right shelf
  // card) so the user's manual placement survives reload without needing
  // to open the card.
  try {
    const persisted = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    const px = persisted['rightShelf.x'];
    const py = persisted['rightShelf.y'];
    const pz = persisted['rightShelf.z'];
    const pr = persisted['rightShelf.rotY'];
    if (typeof px === 'number') mirror.position.x = px;
    if (typeof py === 'number') mirror.position.y = py;
    if (typeof pz === 'number') mirror.position.z = pz;
    if (typeof pr === 'number') mirror.rotation.y = pr;
  } catch {}
  console.log(`[mirror] right-side bookshelf built — ${mirrorLights.length} fresh strip lights, ${mirrorMats.length} cloned materials, lighting synced to left shelf.`);
  // Right shelf is finally in the scene — rebuild any user-added extra
  // lights so right-side entries materialize alongside left-side ones.
  if (typeof window.__rebuildAllExtraLights === 'function') window.__rebuildAllExtraLights();
  return mirror;
}
window.__buildMirroredBookshelf = buildMirroredBookshelf;
window.__rebuildMirroredBookshelf = function () {
  // Force-rebuild: drop the existing mirror so the next call constructs fresh.
  if (_mirroredBookshelf) {
    _mirroredBookshelf.parent?.remove(_mirroredBookshelf);
    _mirroredBookshelf = null;
  }
  const result = buildMirroredBookshelf();
  // The mirror's UUIDs all changed — invalidate the cached candidate
  // list so the next apply re-gathers fresh meshes from the new mirror.
  if (typeof window.__invalidateShelfCropCache === 'function') window.__invalidateShelfCropCache();
  // Re-apply per-shelf crop on the freshly rebuilt mirror.
  if (typeof window.__applyShelfCropAll === 'function') window.__applyShelfCropAll();
  return result;
};

// ---------- Per-shelf vertical CROP (Left + Right) ---------------------
// User-driven Y-axis crop: anything in the bookshelf group whose world Y
// is OUTSIDE [cropMinY, cropMaxY] gets hidden. Drag cropMaxY down from
// the top → top shelf disappears. Drag cropMinY up from the bottom →
// bottom shelf disappears. State is per-shelf (left/right independent).
// Persisted under `leftShelf.crop.maxY` / `.minY` and mirrored on right.
// `Infinity` defaults mean "no crop".
let _leftShelfCropMaxY  =  Infinity;
let _leftShelfCropMinY  = -Infinity;
let _rightShelfCropMaxY =  Infinity;
let _rightShelfCropMinY = -Infinity;
// Hydrate from localStorage on first read.
(function _hydrateCrop() {
  try {
    const p = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    if (typeof p['leftShelf.crop.maxY']  === 'number') _leftShelfCropMaxY  = p['leftShelf.crop.maxY'];
    if (typeof p['leftShelf.crop.minY']  === 'number') _leftShelfCropMinY  = p['leftShelf.crop.minY'];
    if (typeof p['rightShelf.crop.maxY'] === 'number') _rightShelfCropMaxY = p['rightShelf.crop.maxY'];
    if (typeof p['rightShelf.crop.minY'] === 'number') _rightShelfCropMinY = p['rightShelf.crop.minY'];
  } catch {}
})();
// Vertical alcove walls span every compartment — never hide them or the
// alcove becomes a hole. Everything else is fair game.
const CROP_ALWAYS_KEEP = new Set([
  'Shelf_BackPanel', 'Shelf_Side_Front', 'Shelf_Side_Back',
]);
// Remember every mesh WE cropped (per-side) so a slider release restores
// only the meshes we hid (not unrelated geometry already invisible).
const _croppedLeft  = new Set();
const _croppedRight = new Set();
function _isUserPropDescendant(o, root) {
  let p = o;
  while (p && p !== root) {
    if (p.name && (p.name.startsWith('__prop_') || p.name === '__bootPlant')) return true;
    p = p.parent;
  }
  return false;
}
// Cached lists of crop candidates per side — built ONCE (lazily on first
// crop apply), then re-used. Avoids re-traversing the entire scene on
// every slider input event, which was blocking the main thread and
// making the slider feel like it was "snapping" or stopping midway.
let _cropCandidatesLeft  = null;
let _cropCandidatesRight = null;

function _gatherCropCandidates(side) {
  const isLeft = side === 'left';
  const groupRoot = isLeft ? propGroups.bookshelf?.group : _mirroredBookshelf;
  const xGate = isLeft ? ((x) => x > 1) : ((x) => x < -1);
  const out = [];
  const seen = new Set();
  const _wp = new THREE.Vector3();
  function consider(o, fromGroup) {
    if (!o.isMesh) return;
    if (seen.has(o.uuid)) return;
    if (CROP_ALWAYS_KEEP.has(o.name)) return;
    // Skip user props.
    let p = o;
    while (p) {
      if (p.name && (p.name.startsWith('__prop_') || p.name === '__bootPlant')) return;
      p = p.parent;
    }
    o.getWorldPosition(_wp);
    if (!fromGroup && !xGate(_wp.x)) return;
    seen.add(o.uuid);
    out.push(o);
  }
  if (groupRoot) {
    groupRoot.updateMatrixWorld(true);
    groupRoot.traverse((o) => consider(o, true));
  }
  // Room-root fallback for planks loaded outside the group.
  if (typeof roomRoot !== 'undefined' && roomRoot) {
    roomRoot.updateMatrixWorld(true);
    roomRoot.traverse((o) => {
      if (!o.isMesh) return;
      // Skip anything already inside a __propGroup_ container or mirror.
      let p = o.parent;
      while (p) {
        if (p === groupRoot) return;
        if (p === _mirroredBookshelf) return;
        if (p.name && p.name.startsWith('__propGroup_')) return;
        p = p.parent;
      }
      consider(o, false);
    });
  }
  return out;
}
window.__invalidateShelfCropCache = () => {
  _cropCandidatesLeft = null;
  _cropCandidatesRight = null;
};

function _applyShelfCrop(side) {
  const isLeft = side === 'left';
  const maxY  = isLeft ? _leftShelfCropMaxY  : _rightShelfCropMaxY;
  const minY  = isLeft ? _leftShelfCropMinY  : _rightShelfCropMinY;
  const cropped = isLeft ? _croppedLeft : _croppedRight;
  // Lazy-build candidate list. Subsequent applies are O(N) with no
  // traversal — just a world-position read per known mesh.
  if (isLeft && !_cropCandidatesLeft)  _cropCandidatesLeft  = _gatherCropCandidates('left');
  if (!isLeft && !_cropCandidatesRight) _cropCandidatesRight = _gatherCropCandidates('right');
  const candidates = isLeft ? _cropCandidatesLeft : _cropCandidatesRight;
  const sideLights = isLeft
    ? (Array.isArray(stripLights) ? stripLights : [])
    : (_mirroredBookshelf?.userData?.__rightShelfLights || []);
  const _wp = new THREE.Vector3();
  let hidNow = 0, shownNow = 0;
  candidates.forEach((o) => {
    o.getWorldPosition(_wp);
    const out = (_wp.y > maxY) || (_wp.y < minY);
    if (out) {
      if (o.visible) cropped.add(o.uuid);
      o.visible = false;
      if (cropped.has(o.uuid)) hidNow++;
    } else if (cropped.has(o.uuid)) {
      o.visible = true;
      cropped.delete(o.uuid);
      shownNow++;
    }
  });
  sideLights.forEach((l) => {
    if (!l) return;
    l.getWorldPosition(_wp);
    const out = (_wp.y > maxY) || (_wp.y < minY);
    l.visible = !out;
  });
  const fmtMax = maxY === Infinity ? '∞' : maxY.toFixed(2);
  const fmtMin = minY === -Infinity ? '-∞' : minY.toFixed(2);
  // One throttled log per apply — cheap.
  console.log(`[crop:${side}] maxY=${fmtMax} minY=${fmtMin} | candidates=${candidates.length} | hidden=${cropped.size}`);
}

// Throttle apply to one call per animation frame. Slider input events
// fire ~60×/sec during drag — without this, the apply call blocks the
// main thread and the slider snaps / freezes midway through a drag.
const _cropApplyScheduled = { left: false, right: false };
function _scheduleApplyShelfCrop(side) {
  if (_cropApplyScheduled[side]) return;
  _cropApplyScheduled[side] = true;
  requestAnimationFrame(() => {
    _cropApplyScheduled[side] = false;
    _applyShelfCrop(side);
  });
}
function _persistShelfCrop(side) {
  try {
    const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    if (side === 'left') {
      cur['leftShelf.crop.maxY'] = _leftShelfCropMaxY;
      cur['leftShelf.crop.minY'] = _leftShelfCropMinY;
    } else {
      cur['rightShelf.crop.maxY'] = _rightShelfCropMaxY;
      cur['rightShelf.crop.minY'] = _rightShelfCropMinY;
    }
    localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
  } catch {}
}
// Setters use the throttled scheduler so rapid slider drags don't
// block the main thread. Persistence still runs synchronously so the
// most-recent value is always saved if the drag is interrupted.
window.__setLeftShelfCropMaxY = (v) => { _leftShelfCropMaxY  = Number.isFinite(v) ? v :  Infinity; _scheduleApplyShelfCrop('left');  _persistShelfCrop('left');  };
window.__setLeftShelfCropMinY = (v) => { _leftShelfCropMinY  = Number.isFinite(v) ? v : -Infinity; _scheduleApplyShelfCrop('left');  _persistShelfCrop('left');  };
window.__setRightShelfCropMaxY= (v) => { _rightShelfCropMaxY = Number.isFinite(v) ? v :  Infinity; _scheduleApplyShelfCrop('right'); _persistShelfCrop('right'); };
window.__setRightShelfCropMinY= (v) => { _rightShelfCropMinY = Number.isFinite(v) ? v : -Infinity; _scheduleApplyShelfCrop('right'); _persistShelfCrop('right'); };
window.__getLeftShelfCropMaxY = () => _leftShelfCropMaxY;
window.__getLeftShelfCropMinY = () => _leftShelfCropMinY;
window.__getRightShelfCropMaxY= () => _rightShelfCropMaxY;
window.__getRightShelfCropMinY= () => _rightShelfCropMinY;
window.__applyShelfCropAll = () => { _applyShelfCrop('left'); _applyShelfCrop('right'); };
// ---------- Vespa rig builder ------------------------------------------
// Tears down any existing pivots and rebuilds them from the current
// manual picks (persisted under `vespa.pick.{wheel,handle,kickstand}`).
// Falls back to disk/bar geometric heuristics for any role the user
// hasn't picked yet. Hot-swap: callable any time without re-running
// loadProp.
function rebuildVespaRig(group, label) {
  const gltfScene = group.userData.__vespaSceneRoot;
  if (!gltfScene) return;
  // Tear down existing pivots first — return their children to the scene
  // root (preserving world transform via .attach()).
  for (const key of ['__vespaSteering', '__vespaKickstand']) {
    const piv = group.userData[key];
    if (!piv) continue;
    [...piv.children].forEach((c) => {
      if (c.isObject3D) gltfScene.attach(c);
    });
    piv.parent?.remove(piv);
    group.userData[key] = null;
  }
  gltfScene.updateMatrixWorld(true);
  const fullBox = new THREE.Box3().setFromObject(gltfScene);
  const fullSize = fullBox.getSize(new THREE.Vector3());
  // Forward axis = the longest horizontal dimension. Fall back to X.
  const fwdKey = fullSize.x > fullSize.z ? 'x' : 'z';
  const latKey = fwdKey === 'x' ? 'z' : 'x';
  // Re-collect meshes (some might have been freshly re-parented during
  // the teardown above).
  const meshes = [];
  gltfScene.traverse((o) => {
    if (!o.isMesh) return;
    const bb = new THREE.Box3().setFromObject(o);
    meshes.push({
      mesh: o,
      center: bb.getCenter(new THREE.Vector3()),
      size: bb.getSize(new THREE.Vector3()),
      bb,
    });
  });
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}'); } catch {}
  // Steering pivot: scoop EVERY mesh in the front portion of the bike
  // and attach them all to one pivot. The slider rotates the whole
  // front (wheel + fork + fender + handlebar) as one unit. The forward
  // cutoff is configurable via `vespa.frontCutoff` (0..1, default 0.55
  // — i.e. anything past 55% along the forward axis is "front").
  const fullMin = fullBox.min[fwdKey];
  const fullMax = fullBox.max[fwdKey];
  const cutoff = typeof stored['vespa.frontCutoff'] === 'number' ? stored['vespa.frontCutoff'] : 0.55;
  const fwdThreshold = fullMin + (fullMax - fullMin) * cutoff;
  const frontMeshes = meshes.filter((m) => m.center[fwdKey] >= fwdThreshold);
  const latMid = (fullBox.min[latKey] + fullBox.max[latKey]) / 2;
  const yMin = fullBox.min.y, yMax = fullBox.max.y;
  // Kickstand: smallest off-center bottom mesh.
  const kick = meshes
    .filter((m) => m.center.y < yMin + (yMax - yMin) * 0.35)
    .filter((m) => Math.abs(m.center[latKey] - latMid) > fullSize[latKey] * 0.12)
    .sort((a, b) => (a.size.x * a.size.y * a.size.z) - (b.size.x * b.size.y * b.size.z))[0];
  if (frontMeshes.length > 0) {
    // Pivot anchored at the centroid of the front cluster on the forward
    // axis, vertical axis of the FORK (centroid Y).
    let cx = 0, cy = 0, cz = 0;
    for (const m of frontMeshes) { cx += m.center.x; cy += m.center.y; cz += m.center.z; }
    cx /= frontMeshes.length; cy /= frontMeshes.length; cz /= frontMeshes.length;
    const steerPivot = new THREE.Object3D();
    steerPivot.name = '__vespaSteering';
    steerPivot.position.set(cx, cy, cz);
    gltfScene.add(steerPivot);
    for (const m of frontMeshes) steerPivot.attach(m.mesh);
    group.userData.__vespaSteering = steerPivot;
  }
  if (kick) {
    const kickPivot = new THREE.Object3D();
    kickPivot.name = '__vespaKickstand';
    kickPivot.position.set(kick.center.x, kick.bb.max.y, kick.center.z);
    gltfScene.add(kickPivot);
    kickPivot.attach(kick.mesh);
    group.userData.__vespaKickstand = kickPivot;
    group.userData.__vespaKickstandAxis = latKey;
  }
  group.userData.__vespaForwardKey = fwdKey;
  group.userData.__vespaLatKey = latKey;
  group.userData.__vespaMeshes = meshes;
  group.userData.__vespaFrontCount = frontMeshes.length;
  console.log(`[vespa] forward=${fwdKey} (cutoff ${(cutoff*100).toFixed(0)}%), front cluster=${frontMeshes.length} mesh(es), kickstand=${kick?.mesh?.name || 'none'}.`);
  // Re-apply persisted angles.
  const sk = `item.${(label || group?.userData?.__label || '').replace(/\s+/g, '_')}`;
  try {
    if (group.userData.__vespaSteering && typeof stored[`${sk}.vespa.steering`] === 'number') {
      group.userData.__vespaSteering.rotation.y = stored[`${sk}.vespa.steering`];
    }
    if (group.userData.__vespaKickstand && typeof stored[`${sk}.vespa.kickstand`] === 'number') {
      const ax = group.userData.__vespaKickstandAxis;
      group.userData.__vespaKickstand.rotation[ax] = stored[`${sk}.vespa.kickstand`];
    }
  } catch {}
}
window.__rebuildVespaRig = rebuildVespaRig;
// ---------- GLB animation mixers --------------------------------------
// Every prop loaded with embedded animation clips (Pixar lamp's "Jump",
// any future skinned/keyframed bank items) registers its mixer in
// window.__animMixers. We tick them all here once a frame.
window.__animMixers = window.__animMixers || [];
let _lastAnimMixerT = performance.now();
function updateAnimMixers() {
  if (!window.__animMixers || window.__animMixers.length === 0) return;
  const now = performance.now();
  const dt = Math.min(0.1, (now - _lastAnimMixerT) / 1000);
  _lastAnimMixerT = now;
  for (const mixer of window.__animMixers) {
    if (mixer) mixer.update(dt);
  }
  // Pixar lamp hinge overrides — applied AFTER mixer ticks so the user's
  // resting-pose sliders win over the animation when the lamp is paused.
  if (window.__pixarLamps?.length) {
    for (const lamp of window.__pixarLamps) {
      const ud = lamp.userData;
      if (!ud?.__pixarLampState?.paused) continue;
      if (ud.__neckBone && ud.__neckRot) ud.__neckBone.rotation.set(ud.__neckRot.x, ud.__neckRot.y, ud.__neckRot.z);
      if (ud.__headBone && ud.__headRot) ud.__headBone.rotation.set(ud.__headRot.x, ud.__headRot.y, ud.__headRot.z);
    }
  }
}
// Rebuild a subclip given trim values in SECONDS off each end. Returns
// null if trim leaves no room.
function makeLampSubclip(originalClip, trimStartSec, trimEndSec) {
  if (!THREE.AnimationUtils?.subclip) return null;
  const fps = 30;
  const dur = originalClip.duration;
  const startFrame = Math.max(0, Math.floor(Math.max(0, trimStartSec) * fps));
  const endFrame   = Math.min(Math.ceil(dur * fps), Math.ceil((dur - Math.max(0, trimEndSec)) * fps));
  if (endFrame <= startFrame + 1) return null;
  try {
    return THREE.AnimationUtils.subclip(originalClip, `${originalClip.name}_trim`, startFrame, endFrame, fps);
  } catch { return null; }
}
// Wires the lamp's runtime rig: cache neck/head bones + drop a bulb
// PointLight, SpotLight, and emissive sphere as children of the head's
// END joint so they follow the animation. Persisted intensity / color
// are applied here too.
function attachPixarLampRig(group) {
  let neckBone = null, headBone = null, headEndBone = null;
  // The actual bulb is the mesh authored with Material_26 (warm
  // emissiveFactor 0.73,0.58,0.37). After GLTFLoader the node lives
  // under the head bone with the original GLB name preserved (three.js
  // sanitises spaces, so we match generously).
  let bulbMeshFromGLB = null;
  group.traverse((o) => {
    if (o.name === 'neck_010') neckBone = o;
    else if (o.name === 'head_011') headBone = o;
    else if (o.name === 'head_end_019') headEndBone = o;
    if (!bulbMeshFromGLB && o.isMesh && o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      // Pick whichever sub-mesh material has a meaningful emissive
      // factor — that's the bulb in the source asset.
      for (const m of mats) {
        if (m && m.emissive) {
          const e = m.emissive;
          if ((e.r + e.g + e.b) > 0.05) { bulbMeshFromGLB = o; break; }
        }
      }
    }
    // Fallback by name (Material #26 in the GLB).
    if (!bulbMeshFromGLB && /Material[ _]?#?26/i.test(o.name || '')) bulbMeshFromGLB = o;
  });
  group.userData.__neckBone = neckBone;
  group.userData.__headBone = headBone;
  group.userData.__headEndBone = headEndBone;
  group.userData.__bulbMeshGLB = bulbMeshFromGLB;
  if (neckBone) group.userData.__neckRotInit = { x: neckBone.rotation.x, y: neckBone.rotation.y, z: neckBone.rotation.z };
  if (headBone) group.userData.__headRotInit = { x: headBone.rotation.x, y: headBone.rotation.y, z: headBone.rotation.z };
  // Crank emissive on the source bulb mesh so it actually reads as the
  // light source (warm white-amber, toneMapping off so it stays bright).
  if (bulbMeshFromGLB) {
    const mats = Array.isArray(bulbMeshFromGLB.material) ? bulbMeshFromGLB.material : [bulbMeshFromGLB.material];
    mats.forEach((m) => {
      if (!m) return;
      if (m.emissive) {
        m.emissive = new THREE.Color(0xffd9a8);
        m.emissiveIntensity = 4.0;
      }
      m.toneMapped = false;
      m.needsUpdate = true;
    });
  }
  // Place the light rig as a child of the SOURCE bulb mesh so it follows
  // the animation exactly — not parented to a bone we guessed at. If we
  // couldn't find the bulb, fall back to head_end / head / group root.
  const anchor = bulbMeshFromGLB || headEndBone || headBone || group;
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}'); } catch {}
  const bulbColor = stored['pixarLamp.bulbColor']     || 0xffb070;
  const bulbInt   = typeof stored['pixarLamp.bulbIntensity'] === 'number' ? stored['pixarLamp.bulbIntensity'] : 1.4;
  const spotInt   = typeof stored['pixarLamp.spotIntensity'] === 'number' ? stored['pixarLamp.spotIntensity'] : 4.0;
  const bulb = new THREE.PointLight(bulbColor, bulbInt, 0.5, 2.0);
  bulb.castShadow = false;
  anchor.add(bulb);
  const spot = new THREE.SpotLight(0xffc090, spotInt, 2.6, Math.PI * 0.42, 0.85, 1.5);
  const spotTarget = new THREE.Object3D();
  spotTarget.position.set(0, -0.8, 0);
  anchor.add(spot, spotTarget);
  spot.target = spotTarget;
  group.userData.__bulb = bulb;
  group.userData.__spot = spot;
  group.userData.__bulbMesh = bulbMeshFromGLB; // alias: editor controls boost the GLB mesh, not a placeholder sphere
  console.log(`[pixar-lamp] light rig anchored to "${anchor.name || '(root)'}"${bulbMeshFromGLB ? ' (real bulb mesh from Material_26)' : ' (fallback — bulb mesh not located)'}.`);
}
window.__resetAtAtCenter = () => {
  if (!_atAtState.group) return;
  _atAtState.group.updateMatrixWorld(true);
  _atAtState.group.getWorldPosition(_atAtTmp);
  _atAtState.cx = _atAtTmp.x;
  _atAtState.cy = _atAtTmp.y;
  _atAtState.cz = _atAtTmp.z;
  _atAtState.angle = 0;
  console.log('[at-at] orbit center reset to current position.');
};
// Restore persisted pair-locks once items have loaded. (Auto-pairing Nike
// → Display case removed — capturing the offset at boot was making the
// Nikes drift to weird spots when the Case's position was still settling
// or had been re-parented earlier in the same boot. Pair manually via
// __pairLock(anchorGroup, followerGroup) if needed.)
setTimeout(() => {
  const list = _loadPairList();
  // Skip restoring pair-locks whose follower OR anchor is flagged as
  // explicitly scene-rooted by the user (parents[label] === 'scene').
  // Without this, items the user already detached would get re-yanked
  // back to their old anchor 4.5s after every reload — the "snaps in
  // right position then snaps somewhere else" symptom on the Speed
  // Racer car. Also strip those stale entries from localStorage so they
  // don't keep resurrecting on future boots.
  const _persistedParents = (() => {
    try { return (JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}')['shelfSpacing.parents']) || {}; }
    catch { return {}; }
  })();
  const _isFreed = (lbl) => _persistedParents[lbl] === 'scene';
  const _kept = [];
  let _stripped = 0;
  let restored = 0;
  for (const entry of list) {
    if (_isFreed(entry.follower) || _isFreed(entry.anchor)) {
      _stripped++;
      continue;
    }
    _kept.push(entry);
    const a = SELECTABLE.find((s) => s.label === entry.anchor);
    const f = SELECTABLE.find((s) => s.label === entry.follower);
    if (a?.group && f?.group) {
      pairLock(a.group, f.group);
      if (_pairLocked.has(f.group)) {
        const info = _pairLocked.get(f.group);
        if (entry.offset) {
          info.offset.set(entry.offset.x || 0, entry.offset.y || 0, entry.offset.z || 0);
          info.offsetDirty = true;
        }
        if (entry.rotOffset) {
          if (!info.rotOffset) info.rotOffset = new THREE.Quaternion();
          info.rotOffset.set(entry.rotOffset.x || 0, entry.rotOffset.y || 0, entry.rotOffset.z || 0, entry.rotOffset.w ?? 1);
          info.rotOffsetDirty = true;
        }
      }
      restored++;
    }
  }
  if (_stripped > 0) {
    try { localStorage.setItem('pairLocks.v1', JSON.stringify(_kept)); } catch {}
    console.log(`[pair] dropped ${_stripped} stale pair-lock(s) for scene-tagged items`);
  }
  if (restored) console.log(`[pair] restored ${restored} pair-lock(s)`);
  // Auto-pair: FRAME is the ANCHOR, the Speed Racer car is the
  // FOLLOWER sitting on top of the frame. The car offset starts at
  // (0, 0.5, 0) so it floats slightly above the frame face — user can
  // tune via the editor's "🏁 Car offset on frame" sliders.
  //
  // Skip the auto-pair if the user has explicitly unpaired the car (we
  // tag `parents[label] = 'scene'` when they detach). Without this gate,
  // every reload re-paired the car to the frame and snapped it back to
  // the frame's position — overriding the spot the user placed it in.
  const frameSel2 = SELECTABLE.find((s) => s.label === 'Speed frame');
  if (frameSel2?.group) {
    const existingFollowers = new Set(_loadPairList().map((e) => e.follower));
    const _persistedParents = (() => {
      try { return (JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}')['shelfSpacing.parents']) || {}; }
      catch { return {}; }
    })();
    const carSels = SELECTABLE.filter((s) => /speed.?racer|mach.?6/i.test(s.label || ''));
    let auto = 0;
    for (const cs of carSels) {
      if (!cs.group) continue;
      if (existingFollowers.has(cs.label)) continue;
      // User explicitly detached this car — leave it scene-rooted.
      if (_persistedParents[cs.label] === 'scene') continue;
      pairLock(frameSel2.group, cs.group);    // FRAME = anchor, car = follower
      // Default offset: car sits 0.5 m above + slightly forward of frame.
      if (_pairLocked.has(cs.group)) {
        const info = _pairLocked.get(cs.group);
        info.offset.set(0, 0.5, 0.05);
        info.offsetDirty = true;
      }
      persistPair(frameSel2.label, cs.label, { x: 0, y: 0.5, z: 0.05 });
      auto++;
      break; // first car only
    }
    if (auto) console.log(`[pair] auto-paired Speed Racer car → Speed frame (car sits on frame).`);
  }
}, 4500);

// ---------- Matcha liquid + steam dressing ------------------------------
// Once the mug GLB has rendered we know its real bbox, so we can drop a
// thin matcha-green disc just below the rim and anchor a steam particle
// system on top. Both are children of gromitMugGroup so they follow the
// mug if the user moves it via the gizmo / contextual editor.
// Procedural "city at night" emissive map for the Death Star. Black
// background dotted with thousands of tiny warm windows, plus a few
// brighter clusters that read as super-lit zones (hangars, command
// trenches). Tiles the surface so it doesn't read as a single grid.
function _makeDeathStarCityTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 1024, 1024);
  // Tiny window dots — most warm yellow, some cooler white-blue, sparse
  // tiny-bright pixels to read as window grids.
  const N_WINDOWS = 6500;
  for (let i = 0; i < N_WINDOWS; i++) {
    const x = Math.random() * 1024;
    const y = Math.random() * 1024;
    const sz = Math.random() < 0.92 ? 1 : 2;
    const cool = Math.random() < 0.18;
    if (cool) {
      const l = 65 + Math.random() * 20;
      ctx.fillStyle = `hsl(210, 30%, ${l}%)`;
    } else {
      const h = 28 + Math.random() * 22;
      const l = 55 + Math.random() * 30;
      ctx.fillStyle = `hsl(${h}, 85%, ${l}%)`;
    }
    ctx.fillRect(x, y, sz, sz);
  }
  // A few bright "hangar / open trench" smudges so the model reads as
  // populated rather than uniformly dotted.
  const N_BRIGHT = 18;
  for (let i = 0; i < N_BRIGHT; i++) {
    const x = Math.random() * 1024;
    const y = Math.random() * 1024;
    const r = 5 + Math.random() * 10;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(255, 220, 150, 0.95)');
    grad.addColorStop(1, 'rgba(255, 200, 120, 0.0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 6);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function _makeProceduralSteamTexture() {
  // Soft radial-gradient white blob, 128×128, rendered to a CanvasTexture.
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0,    'rgba(255,255,255,0.95)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.45)');
  g.addColorStop(1,    'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  return t;
}

// Steam-style options. "proc" is the procedural canvas blob; the rest are
// Kenney's CC0 Particle Pack smoke sprites baked into /public/textures/steam.
// Each entry caches a Texture lazily on first use.
const STEAM_STYLES = [
  { id: 'proc',     label: 'Soft glow (procedural)', src: null },
  { id: 'smoke_01', label: 'Wispy 1',                src: '/textures/steam/smoke_01.png' },
  { id: 'smoke_03', label: 'Wispy 2',                src: '/textures/steam/smoke_03.png' },
  { id: 'smoke_07', label: 'Cloud puff',             src: '/textures/steam/smoke_07.png' },
  { id: 'smoke_10', label: 'Dense plume',            src: '/textures/steam/smoke_10.png' },
];
const _steamTexCache = new Map();
function _getSteamTexture(id) {
  if (_steamTexCache.has(id)) return _steamTexCache.get(id);
  const opt = STEAM_STYLES.find((s) => s.id === id) || STEAM_STYLES[0];
  let tex;
  if (!opt.src) {
    tex = _makeProceduralSteamTexture();
  } else {
    tex = new THREE.TextureLoader().load(opt.src);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
  }
  _steamTexCache.set(id, tex);
  return tex;
}
// All sprite materials register here so the Steam-style cycler can hot-swap
// their map without rebuilding the particle system.
const _steamSpriteMats = [];

// Live-tunable steam parameters. The animation loop reads these every frame
// so sliders take effect immediately. Seeded from localStorage on boot so
// settings survive reloads.
//   speed   — how fast each particle climbs through its lifecycle
//   size    — sprite scale multiplier
//   opacity — peak visibility
//   height  — lifecycle cutoff (gradual fade as particles approach this t)
//   width   — horizontal swirl radius (0 = no drift, straight column)
//   x/y/z   — emitter origin offset (mug-local) so the column can be moved
//             over the matcha center without nudging the mug itself
const STEAM_TUNE = { speed: 0.32, size: 1.0, opacity: 0.55, height: 1.0, width: 1.0, x: 0, y: 0, z: 0 };
let _steamGroup = null;
let _steamAnchor = null;   // captured in _setupMugDressing
try {
  const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
  if (typeof cur['mugSteam.speed']   === 'number') STEAM_TUNE.speed   = cur['mugSteam.speed'];
  if (typeof cur['mugSteam.size']    === 'number') STEAM_TUNE.size    = cur['mugSteam.size'];
  if (typeof cur['mugSteam.opacity'] === 'number') STEAM_TUNE.opacity = cur['mugSteam.opacity'];
  if (typeof cur['mugSteam.height']  === 'number') STEAM_TUNE.height  = cur['mugSteam.height'];
  if (typeof cur['mugSteam.width']   === 'number') STEAM_TUNE.width   = cur['mugSteam.width'];
  if (typeof cur['mugSteam.x']       === 'number') STEAM_TUNE.x       = cur['mugSteam.x'];
  if (typeof cur['mugSteam.y']       === 'number') STEAM_TUNE.y       = cur['mugSteam.y'];
  if (typeof cur['mugSteam.z']       === 'number') STEAM_TUNE.z       = cur['mugSteam.z'];
} catch {}
function applySteamPos() {
  if (!_steamGroup || !_steamAnchor) return;
  _steamGroup.position.set(
    _steamAnchor.x + STEAM_TUNE.x,
    _steamAnchor.y + STEAM_TUNE.y,
    _steamAnchor.z + STEAM_TUNE.z,
  );
}
function _persistSteamTune() {
  try {
    const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    cur['mugSteam.speed']   = STEAM_TUNE.speed;
    cur['mugSteam.size']    = STEAM_TUNE.size;
    cur['mugSteam.opacity'] = STEAM_TUNE.opacity;
    cur['mugSteam.height']  = STEAM_TUNE.height;
    cur['mugSteam.width']   = STEAM_TUNE.width;
    cur['mugSteam.x']       = STEAM_TUNE.x;
    cur['mugSteam.y']       = STEAM_TUNE.y;
    cur['mugSteam.z']       = STEAM_TUNE.z;
    localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
  } catch {}
  applySteamPos();
}

// Matcha disc tunables. The disc is built once inside _setupMugDressing,
// then the live values here drive its position offset (X/Y/Z in mug-local
// space) and scale. Anchor point is captured at build time so the offsets
// are RELATIVE — slider 0 = exactly where it was originally placed.
const MATCHA_TUNE = { x: 0, y: 0, z: 0, scale: 1.0 };
let _matchaMesh = null;
let _matchaAnchor = null;   // {x, y, z} captured at build time
try {
  const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
  if (typeof cur['mugMatcha.x']     === 'number') MATCHA_TUNE.x     = cur['mugMatcha.x'];
  if (typeof cur['mugMatcha.y']     === 'number') MATCHA_TUNE.y     = cur['mugMatcha.y'];
  if (typeof cur['mugMatcha.z']     === 'number') MATCHA_TUNE.z     = cur['mugMatcha.z'];
  if (typeof cur['mugMatcha.scale'] === 'number') MATCHA_TUNE.scale = cur['mugMatcha.scale'];
} catch {}
function applyMatchaTune() {
  if (!_matchaMesh || !_matchaAnchor) return;
  _matchaMesh.position.set(
    _matchaAnchor.x + MATCHA_TUNE.x,
    _matchaAnchor.y + MATCHA_TUNE.y,
    _matchaAnchor.z + MATCHA_TUNE.z,
  );
  // X/Z scale only (don't squish the disc vertically).
  _matchaMesh.scale.set(MATCHA_TUNE.scale, 1, MATCHA_TUNE.scale);
}
function _persistMatchaTune() {
  try {
    const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    cur['mugMatcha.x']     = MATCHA_TUNE.x;
    cur['mugMatcha.y']     = MATCHA_TUNE.y;
    cur['mugMatcha.z']     = MATCHA_TUNE.z;
    cur['mugMatcha.scale'] = MATCHA_TUNE.scale;
    localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
  } catch {}
  applyMatchaTune();
}
function _setSteamStyle(id) {
  if (!STEAM_STYLES.some((s) => s.id === id)) id = STEAM_STYLES[0].id;
  const tex = _getSteamTexture(id);
  for (const m of _steamSpriteMats) {
    m.map = tex;
    m.needsUpdate = true;
  }
  try {
    const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    cur['mugSteamStyle'] = id;
    localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
  } catch {}
  if (window.__updateSteamStyleLabel) window.__updateSteamStyleLabel(id);
}
window.__setSteamStyle = _setSteamStyle;

// One-time sanity scrub of localStorage tune values. If a previous session
// left mug-related sliders at "fully invisible" levels (opacity 0, scale 0,
// height ~0), the disc and steam would disappear with no obvious cause.
// Reset just those degenerate values to defaults so the user can see the
// mug again.
(function _sanitizeMugTunes() {
  try {
    const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    let dirty = false;
    function reset(key, def, isBad) {
      if (isBad(cur[key])) { cur[key] = def; dirty = true; }
    }
    const isTinyOrZero = (v) => typeof v === 'number' && v < 0.02;
    reset('mugMatcha.scale', 1.0, isTinyOrZero);
    reset('mugSteam.opacity', 0.55, isTinyOrZero);
    reset('mugSteam.size',    1.0, isTinyOrZero);
    reset('mugSteam.height',  1.0, isTinyOrZero);
    reset('mugSteam.speed',   0.32, isTinyOrZero);
    if (dirty) {
      localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
      // Refresh the in-memory tunes so the running scene picks them up.
      if (typeof MATCHA_TUNE !== 'undefined') {
        if (typeof cur['mugMatcha.scale'] === 'number') MATCHA_TUNE.scale = cur['mugMatcha.scale'];
      }
      if (typeof STEAM_TUNE !== 'undefined') {
        if (typeof cur['mugSteam.opacity'] === 'number') STEAM_TUNE.opacity = cur['mugSteam.opacity'];
        if (typeof cur['mugSteam.size']    === 'number') STEAM_TUNE.size    = cur['mugSteam.size'];
        if (typeof cur['mugSteam.height']  === 'number') STEAM_TUNE.height  = cur['mugSteam.height'];
        if (typeof cur['mugSteam.speed']   === 'number') STEAM_TUNE.speed   = cur['mugSteam.speed'];
      }
      console.log('[mug] auto-reset degenerate tune values to defaults');
    }
  } catch {}
})();

function _setupMugDressing() {
  // Wait for the inner GLB scene to be present + scaled.
  if (gromitMugGroup.children.length === 0) {
    setTimeout(_setupMugDressing, 100);
    return;
  }
  console.log('[mug] dressing: inner GLB ready, attaching liquid + steam');
  // Compute the mug's local bbox. We TEMPORARILY clear the mug group's
  // own matrix to identity so setFromObject(innerScene) returns a bbox in
  // mug-LOCAL coordinates instead of world. Restore afterward.
  const innerScene = gromitMugGroup.children[0];
  const _savedQ = gromitMugGroup.quaternion.clone();
  const _savedP = gromitMugGroup.position.clone();
  const _savedS = gromitMugGroup.scale.clone();
  gromitMugGroup.position.set(0, 0, 0);
  gromitMugGroup.quaternion.set(0, 0, 0, 1);
  gromitMugGroup.scale.set(1, 1, 1);
  gromitMugGroup.updateMatrixWorld(true);
  // Pick the cup-body mesh: this Gromit GLB has a Gromit figurine sticking
  // OUT of the mug (nose extends well above the rim), and using the full
  // bbox makes the steam anchor float above Gromit's head instead of the
  // cup rim. Heuristic: prefer a mesh whose name suggests "ceramic" / cup
  // body; otherwise pick the mesh with the largest XZ footprint × height
  // (the cup is a fat cylinder; nose/eyes are small protrusions).
  const meshes = [];
  innerScene.traverse((o) => { if (o.isMesh && o.geometry) meshes.push(o); });
  function meshLocalBbox(m) {
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    return new THREE.Box3().copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld);
  }
  let cupMesh = null;
  if (meshes.length > 0) {
    const named = meshes.find((m) => /cream|cup|mug|ceramic|body/i.test(m.name || ''));
    if (named) cupMesh = named;
    if (!cupMesh) {
      // Pick the mesh with the largest volume (XZ-area × Y-height).
      let bestVol = -1;
      for (const m of meshes) {
        const b = meshLocalBbox(m);
        const dx = b.max.x - b.min.x;
        const dy = b.max.y - b.min.y;
        const dz = b.max.z - b.min.z;
        const vol = dx * dy * dz;
        if (vol > bestVol) { bestVol = vol; cupMesh = m; }
      }
    }
  }
  const bb = cupMesh ? meshLocalBbox(cupMesh) : new THREE.Box3().setFromObject(innerScene);
  // Restore mug transform.
  gromitMugGroup.position.copy(_savedP);
  gromitMugGroup.quaternion.copy(_savedQ);
  gromitMugGroup.scale.copy(_savedS);
  gromitMugGroup.updateMatrixWorld(true);
  let localMin = bb.min;
  let localMax = bb.max;
  // Defensive fallback: if bbox is empty / degenerate (NaN / inverted /
  // zero-sized), pick a sane mug-shaped default so the disc + steam can
  // still attach in a visible spot.
  if (
    !isFinite(localMin.x) || !isFinite(localMax.x) ||
    localMax.x - localMin.x < 0.001 ||
    localMax.y - localMin.y < 0.001
  ) {
    console.warn('[mug] bbox came back empty — using fallback dimensions');
    localMin = new THREE.Vector3(-0.06, 0,    -0.06);
    localMax = new THREE.Vector3( 0.06, 0.13,  0.06);
  }
  const localSize = new THREE.Vector3().subVectors(localMax, localMin);
  const localCenter = new THREE.Vector3().addVectors(localMin, localMax).multiplyScalar(0.5);

  // ---- Liquid disc (hot chocolate) ------------------------------------
  const liquidR = Math.max(0.01, Math.min(localSize.x, localSize.z) * 0.42);
  const liquid = new THREE.Mesh(
    new THREE.CylinderGeometry(liquidR, liquidR, localSize.y * 0.02, 64),
    new THREE.MeshStandardMaterial({
      color: 0x6b3a1a,        // hot chocolate brown
      roughness: 0.55,        // creamier surface, less sharp specular
      metalness: 0.0,
      envMapIntensity: 0.5,
    }),
  );
  liquid.name = 'hot-chocolate-liquid';
  gromitMugGroup.add(liquid);
  // Anchor + capture for the live X / Y / scale tune sliders.
  _matchaMesh   = liquid;
  _matchaAnchor = {
    x: localCenter.x,
    y: localMax.y - localSize.y * 0.18,   // 18% below rim
    z: localCenter.z,
  };
  applyMatchaTune();

  // ---- Steam particles -------------------------------------------------
  const steamGroup = new THREE.Group();
  steamGroup.name = 'mug-steam';
  steamGroup.position.set(localCenter.x, localMax.y - localSize.y * 0.16, localCenter.z);
  gromitMugGroup.add(steamGroup);
  // Capture for the X/Y/Z position sliders (offsets are RELATIVE to this).
  _steamGroup = steamGroup;
  _steamAnchor = {
    x: localCenter.x,
    y: localMax.y - localSize.y * 0.16,
    z: localCenter.z,
  };
  applySteamPos();

  // Discrete puffs (user preference). Higher counts create a continuous
  // ribbon — keeping COUNT modest so each particle reads as its own puff.
  const COUNT = 22;
  const particles = [];
  // Sprite scale is in WORLD units, so we multiply by the mug group's
  // own scale to keep the steam sized to the mug.
  const baseScale = liquidR * 0.55;
  // Pick the persisted steam style or fall back to the Kenney "Cloud puff"
  // sprite — that's the one the user picked for the cocoa look.
  let initialStyle = 'smoke_07';
  try {
    const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    if (typeof cur['mugSteamStyle'] === 'string') initialStyle = cur['mugSteamStyle'];
  } catch {}
  const initialTex = _getSteamTexture(initialStyle);
  for (let i = 0; i < COUNT; i++) {
    const mat = new THREE.SpriteMaterial({
      map: initialTex,
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    _steamSpriteMats.push(mat);
    const sp = new THREE.Sprite(mat);
    sp.scale.setScalar(baseScale);
    steamGroup.add(sp);
    // Random life so each puff feels independent (gives the discrete-
    // puff look the user prefers).
    particles.push({
      sprite: sp,
      life: Math.random(),                  // staggered start
      seed: Math.random() * Math.PI * 2,    // angle of swirl
    });
  }

  // Per-frame animation: rise, swirl, grow, fade.
  let _last = performance.now();
  // Reusable scratch quat for upright counter-rotation of the steam group.
  const _tmpMugQuat = new THREE.Quaternion();
  const RISE_HEIGHT = liquidR * 8;          // how high steam climbs
  const SWIRL_RADIUS = liquidR * 0.6;       // horizontal drift
  function tick() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - _last) / 1000);
    _last = now;
    if (gromitMugGroup.visible && steamGroup.visible) {
      // Keep the steam group world-upright regardless of mug rotation.
      // `getWorldQuaternion` is scale-safe (mug.scale ≠ 1 wouldn't poison
      // a quaternion extracted via setFromRotationMatrix). Counter-rotate
      // by the inverse so the steam group's world quaternion is identity
      // (column always rises straight up).
      gromitMugGroup.updateMatrixWorld(true);
      gromitMugGroup.getWorldQuaternion(_tmpMugQuat).invert();
      steamGroup.quaternion.copy(_tmpMugQuat);

      // Width is still a swirl-radius multiplier. Height is now a CUTOFF:
      // each particle still travels the full RISE_HEIGHT along its life
      // (no column compression), but its opacity fades to zero as it
      // approaches the configured height fraction. Lower height = steam
      // disappears closer to the mug.
      const liveSwirl = SWIRL_RADIUS * STEAM_TUNE.width;
      const cutoff = Math.max(0.02, STEAM_TUNE.height);   // 0..1 (or higher)
      const cutoffBand = Math.min(0.25, cutoff * 0.5);     // gradual fade band
      for (const p of particles) {
        // Speed multiplier: smaller = slower, more subtle drift.
        p.life += dt * STEAM_TUNE.speed;
        if (p.life > 1) p.life -= 1;
        const t = p.life;
        const angle = p.seed + t * 5;
        p.sprite.position.set(
          Math.sin(angle) * liveSwirl * t,
          t * RISE_HEIGHT,
          Math.cos(angle) * liveSwirl * t,
        );
        // Grow from base to ~2.4× as it rises, scaled by the size tune.
        p.sprite.scale.setScalar(baseScale * (1 + t * 1.4) * STEAM_TUNE.size);
        // Lifecycle fade: in over first 12%, out from 60% onward. Short
        // visible band per particle gives the discrete-puff look (each
        // sprite has its own birth/peak/death feel rather than blending
        // into a continuous ribbon).
        let fade = t < 0.12
          ? t / 0.12
          : t > 0.6
            ? (1 - t) / 0.4
            : 1;
        // Cutoff fade: ramp opacity to 0 as t approaches `cutoff`.
        // Past `cutoff` → fully invisible. Within (cutoff-band, cutoff)
        // → linear ramp. Below that → no extra dimming.
        if (t >= cutoff) {
          fade = 0;
        } else if (t > cutoff - cutoffBand) {
          const cf = (cutoff - t) / cutoffBand;        // 1 → 0
          fade = Math.min(fade, cf);
        }
        p.sprite.material.opacity = Math.max(0, fade) * STEAM_TUNE.opacity;
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  console.log('[mug] matcha + steam dressing attached');
}
_setupMugDressing();

// Bookshelf compartment world coordinates after the locked +0.430 z-slide:
//   Center X = 1.45 (mid-depth of the alcove)
//   Center Z = 1.04 + 0.770 = 1.81
// Floor heights (top of the divider below):
//   Big bottom 0.825, Small 1 1.380, Small 2 1.735, Small 3 2.095, Small 4 2.445
const SHELF_CTR_X = 1.45;
const SHELF_CTR_Z = 1.81;

// Groot flower pot — locked to user-confirmed values.
const grootGroup = loadProp({
  id: 'groot', label: 'Groot pot',
  glbPath: '/models/groot_pot.glb',
  target: { x: 1.453, y: 0.825, z: 2.140 },
  scaleTarget: 0.24,
});

// Succulent that sits inside Groot — locked to user-confirmed values.
const succulentGroup = loadProp({
  id: 'succulent', label: 'Succulent',
  glbPath: '/models/succulent/scene.gltf',
  target: { x: 1.446, y: 0.940, z: 1.784 },
  scaleTarget: 0.18,
});

// Hide the succulent's pot mesh(es) so only leaves remain, AND link the
// succulent to Groot so they select+move as a single unit.
function setupSucculent() {
  if (!grootGroup.children.length || !succulentGroup.children.length) {
    setTimeout(setupSucculent, 80);
    return;
  }
  // Hide pot meshes (bottom 35% of succulent's bbox)
  const meshes = [];
  succulentGroup.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const total = new THREE.Box3().setFromObject(succulentGroup);
  const totalH = total.max.y - total.min.y;
  const cutoff = total.min.y + totalH * 0.35;
  let hidCount = 0;
  meshes.forEach((m) => {
    const box = new THREE.Box3().setFromObject(m);
    if (box.max.y <= cutoff) { m.visible = false; hidCount++; }
  });
  console.log(`[succulent] hid ${hidCount} pot mesh(es)`);

  // Re-parent succulent UNDER grootGroup, then snap its LOCAL offset to a
  // known value so the leaves always sit in Groot's head no matter where
  // Groot is positioned in the room.
  grootGroup.attach(succulentGroup);
  succulentGroup.position.set(-0.004, 0.115, -0.026);

  // Remove succulent from the selectable list — clicks on succulent leaves
  // will hit grootGroup (raycast traverses children) and select Groot.
  const idx = SELECTABLE.findIndex((s) => s.group === succulentGroup);
  if (idx >= 0) SELECTABLE.splice(idx, 1);
  console.log('[succulent] linked to Groot — they now move as one unit');
}
setupSucculent();
function updateSucculentMask() { /* no-op now that we hide the pot mesh */ }

// Minecraft chest — locked to user-confirmed values.
const chestGroup = loadProp({
  id: 'chest', label: 'Minecraft chest',
  glbPath: '/models/minecraft_chest.glb',
  target: { x: 1.410, y: 0.818, z: 1.504 },
  scaleTarget: 0.20,
});
chestGroup.rotation.set(-Math.PI, 0, -Math.PI);

// ---------- Spider-Man mask stands ---------------------------------------
// Each "stand" is a small disc base + a thin metal rod, with a mask GLB
// floating at the top of the rod. The whole rig is wrapped in a Group so
// it's a single selectable prop.
function createMaskStand({ id, label, glbPath, target, maskScale = 0.24, rodHeight = 0.05, defaultRotY = 0 }) {
  const group = new THREE.Group();
  group.name = `__prop_${id}`;
  group.position.set(target.x, target.y, target.z);
  // Apply the default rotation here BEFORE the persisted-read pass at
  // the bottom of this fn — that way any user-saved rotation overrides
  // the hardcoded face-the-room rotation. Previously the caller did
  // `standN.rotation.y = -π/2` AFTER createMaskStand returned, which
  // wiped any persisted rotation read inside.
  group.rotation.y = defaultRotY;
  scene.add(group);

  // Base disc
  const baseR = 0.03, baseH = 0.012;
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.45, metalness: 0.6 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(baseR, baseR * 1.05, baseH, 32), baseMat);
  base.position.y = baseH / 2;
  base.castShadow = true; base.receiveShadow = true;
  group.add(base);

  // Metal rod
  const rodR = 0.0035;
  const rod = new THREE.Mesh(
    new THREE.CylinderGeometry(rodR, rodR, rodHeight, 16),
    new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.25, metalness: 0.95 }),
  );
  rod.position.y = baseH + rodHeight / 2;
  rod.castShadow = true; rod.receiveShadow = true;
  group.add(rod);

  // Mask perched on top of rod
  makeGLTFLoader().load(glbPath, (gltf) => {
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = box.getSize(new THREE.Vector3());
    const s = maskScale / Math.max(Math.max(size.x, size.y, size.z), 0.0001);
    gltf.scene.scale.setScalar(s);
    gltf.scene.updateMatrixWorld(true);
    const box2 = new THREE.Box3().setFromObject(gltf.scene);
    const c = box2.getCenter(new THREE.Vector3());
    // Center XZ at the rod, mask "neck" rests just above the rod top
    gltf.scene.position.set(-c.x, baseH + rodHeight - box2.min.y - 0.01, -c.z);
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true; o.receiveShadow = true;
      if (!o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        m.transparent = false; m.opacity = 1.0; m.depthWrite = true;
        // Matte fabric look — high roughness, low env reflection. The
        // mask is woven cloth, not leather or rubber, so it should read
        // almost flat with just enough detail from the normal map.
        if (typeof m.envMapIntensity === 'number') m.envMapIntensity = 0.5;
        if (typeof m.roughness === 'number') m.roughness = 0.92;
        if (typeof m.metalness === 'number') m.metalness = 0.0;
        if (m.normalScale && m.normalMap) m.normalScale.set(1.3, 1.3);
        m.needsUpdate = true;
      });
    });
    group.add(gltf.scene);
  });

  // Tiny diffuse fill so the mask isn't pitch-dark in the recess; matte
  // material means we don't get a hot specular spot from this.
  const fill = new THREE.PointLight(0xfff0d8, 0.20, 0.5, 2.0);
  fill.position.set(0, baseH + rodHeight + 0.18, 0.05);
  group.add(fill);
  // Stash the light on the group so the contextual editor can find +
  // mutate it (intensity / distance / color sliders per mask stand).
  group.userData.__maskFillLight = fill;
  // Apply persisted light overrides if the user previously dialed them.
  try {
    const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    const safe = label.replace(/ /g, '_');
    if (typeof stored[`maskLight.${safe}.intensity`] === 'number') fill.intensity = stored[`maskLight.${safe}.intensity`];
    if (typeof stored[`maskLight.${safe}.distance`]  === 'number') fill.distance  = stored[`maskLight.${safe}.distance`];
    if (typeof stored[`maskLight.${safe}.tintR`] === 'number' &&
        typeof stored[`maskLight.${safe}.tintG`] === 'number' &&
        typeof stored[`maskLight.${safe}.tintB`] === 'number') {
      fill.color.setRGB(stored[`maskLight.${safe}.tintR`], stored[`maskLight.${safe}.tintG`], stored[`maskLight.${safe}.tintB`]);
    }
  } catch {}

  makeSelectable(group, label);
  // Honor the hidden-props list — same path used by loadProp. If the user
  // removed this mask via the contextual editor in a previous session,
  // its label is in `hidden.props.v1` and we hide the whole stand. Also
  // apply persisted transform keys (item.<safeLabel>.x/y/z/rot/scale) so
  // a user-locked mask stays where they put it across reloads — without
  // this, mask stands always reset to the hardcoded `target` and any
  // drag/lock action got reverted on reload.
  try {
    const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    const safe = label.replace(/ /g, '_');
    const k = `item.${safe}`;
    if (typeof stored[`${k}.x`]    === 'number') group.position.x = stored[`${k}.x`];
    if (typeof stored[`${k}.y`]    === 'number') group.position.y = stored[`${k}.y`];
    if (typeof stored[`${k}.z`]    === 'number') group.position.z = stored[`${k}.z`];
    if (typeof stored[`${k}.rotX`] === 'number') group.rotation.x = stored[`${k}.rotX`];
    if (typeof stored[`${k}.rotY`] === 'number') group.rotation.y = stored[`${k}.rotY`];
    if (typeof stored[`${k}.rotZ`] === 'number') group.rotation.z = stored[`${k}.rotZ`];
    if (typeof stored[`${k}.scale`] === 'number' && stored[`${k}.scale`] > 0.01) group.scale.setScalar(stored[`${k}.scale`]);
    const hidden = JSON.parse(localStorage.getItem('hidden.props.v1') || '[]');
    if (Array.isArray(hidden) && hidden.includes(label)) group.visible = false;
  } catch {}
  return group;
}

// Two mask stands flanking the chest in Small 1. Rotated so the masks face
// the room (-X direction) instead of the bookshelf back wall.
const stand1 = createMaskStand({
  id: 'symbiote', label: 'Symbiote mask',
  glbPath: '/models/spiderman_symbiote.glb',
  target: { x: SHELF_CTR_X, y: 1.395, z: SHELF_CTR_Z - 0.34 },
  defaultRotY: -Math.PI / 2,
});
const stand2 = createMaskStand({
  id: 'spiderman', label: 'Spider-Man mask',
  glbPath: '/models/spiderman.glb',
  target: { x: SHELF_CTR_X, y: 1.395, z: SHELF_CTR_Z + 0.34 },
  defaultRotY: -Math.PI / 2,
});

// Third mask stand: Black Panther helmet from the items-bank, mounted
// the same way as Spider-Man. Sits between the other two on Small 1.
const stand3 = createMaskStand({
  id: 'blackpanther', label: 'Black Panther mask',
  glbPath: '/items-bank/black_panther_helmet.glb',
  target: { x: SHELF_CTR_X, y: 1.395, z: SHELF_CTR_Z },
  maskScale: 0.26,
  defaultRotY: -Math.PI / 2,
});

// Pothos + Foliage in Small 2 — both locked to user-confirmed values.
const pothosGroup = loadProp({
  id: 'pothos', label: 'Pothos plant',
  glbPath: '/models/pothos.glb',
  target: { x: 1.449, y: 1.731, z: 1.585 },
  scaleTarget: 0.30,
});
const foliageGroup = LITE ? null : loadProp({
  id: 'foliage', label: 'Foliage study',
  glbPath: '/models/foliage_study.glb',
  target: { x: 1.410, y: 1.720, z: 2.010 },
  scaleTarget: 0.30,
});
if (foliageGroup) {
  foliageGroup.rotation.set(Math.PI, -Math.PI / 2, Math.PI);
  foliageGroup.scale.setScalar(2.526);
}

// Grass removed — the merged GLB was too glitchy at this density.

// ---------- YT-1300 Falcon HD interior backdrop -------------------------
// HD source ships as OBJ + loose PNG textures (no MTL). We load the OBJ
// directly, then map each material name (preserved by OBJLoader as
// `material.name` from `usemtl` lines) to its corresponding texture file.
const falconBackdrop = new THREE.Group();
falconBackdrop.name = '__prop_falcon';
falconBackdrop.position.set(-4.627, 1.351, 0.667);
falconBackdrop.rotation.set(3.142, -1.555, 3.142);
falconBackdrop.scale.setScalar(2.880);
falconBackdrop.visible = false;            // hidden as a safety net
// NOT added to the scene at all — earlier the Falcon was reachable via
// scene graph but hidden; user reports seeing it, so we cut its scene
// link entirely. The variable is kept so other code paths that reference
// it (clipping plane setup, material conversion polls) don't TDZ.
// (was: scene.add(falconBackdrop);)

// MTL gives us the diffuse maps. After load we convert each material to
// MeshBasicMaterial (unlit) for the BASE pass. Then for materials whose
// usemtl name has a matching `_emiss.png` (cockpit screens, lounge accents),
// we add a sibling mesh with the emissive PNG as a MeshBasicMaterial set to
// AdditiveBlending — this paints the glowing panels on top of the diffuse.
const FALCON_BASE = '/models/yt1300_hd/source/';
const FALCON_OBJ  = 'YT1300 (Inside).obj';
const FALCON_MTL  = 'YT1300 (Inside).mtl';
const FALCON_TEX_DIR = '/models/yt1300_hd/textures';

// Materials that have a SEPARATE emissive map on top of their diffuse.
// Storage / Hallfloor / Cockpit_A2 are emissive-only — their _emiss IS
// already the main diffuse via the MTL, so they don't need an overlay.
const FALCON_EMISSIVE_OVERLAYS = {
  YT1300_Cockpit: 'yt1300_cockpit_emiss.png',
  YT1300_Lounge:  'yt1300_loungeemis.png',
};

const _falconTexLoader = new THREE.TextureLoader();
const _falconTexCache = new Map();
function loadFalconTex(filename) {
  if (_falconTexCache.has(filename)) return _falconTexCache.get(filename);
  const tex = _falconTexLoader.load(`${FALCON_TEX_DIR}/${filename}`);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  _falconTexCache.set(filename, tex);
  return tex;
}

// Live-tunable look state, driven by the slider panel further down.
const falconLook = {
  brightness: 1.00,    // 0..2 — multiplier on base color
  warmth:     0.00,    // -1 cool .. +1 warm
  glow:       1.40,    // 0..3 — multiplier on emissive overlay color
  glowWarmth: 0.40,    // -1 cool .. +1 warm
};
const falconBaseMaterials = [];
const falconGlowMaterials = [];

function applyFalconLook() {
  // Base tint: white shifted toward orange (warm) or blue (cool), then
  // multiplied by brightness.
  const base = new THREE.Color(0xffffff);
  if (falconLook.warmth > 0) base.lerp(new THREE.Color(0xffb070), falconLook.warmth * 0.6);
  else                       base.lerp(new THREE.Color(0x88aaff),-falconLook.warmth * 0.5);
  base.multiplyScalar(falconLook.brightness);
  falconBaseMaterials.forEach((m) => { m.color.copy(base); m.needsUpdate = true; });

  // Glow tint: same shape but more saturated warm endpoint.
  const glow = new THREE.Color(0xffffff);
  if (falconLook.glowWarmth > 0) glow.lerp(new THREE.Color(0xffd28a), falconLook.glowWarmth);
  else                            glow.lerp(new THREE.Color(0x99ccff),-falconLook.glowWarmth);
  glow.multiplyScalar(falconLook.glow);
  falconGlowMaterials.forEach((m) => { m.color.copy(glow); m.needsUpdate = true; });
}

new MTLLoader()
  .setPath(FALCON_BASE)
  .load(FALCON_MTL, (materials) => {
    materials.preload();
    new OBJLoader()
      .setMaterials(materials)
      .setPath(FALCON_BASE)
      .load(FALCON_OBJ, (obj) => {
        // Auto-fit + center
        const box = new THREE.Box3().setFromObject(obj);
        const size = box.getSize(new THREE.Vector3());
        const s = 6.0 / Math.max(size.x, size.y, size.z, 0.0001);
        obj.scale.setScalar(s);
        obj.updateMatrixWorld(true);
        const box2 = new THREE.Box3().setFromObject(obj);
        const c = box2.getCenter(new THREE.Vector3());
        obj.position.set(-c.x, -c.y, -c.z);

        // First pass: convert each material to UNLIT BasicMaterial preserving its diffuse map
        const overlayJobs = [];     // {mesh, emissivePNG}
        obj.traverse((o) => {
          if (!o.isMesh || !o.material) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          const matName = mats[0] ? mats[0].name : '';
          o.material = mats.map((m) => {
            if (m.map) {
              m.map.colorSpace = THREE.SRGBColorSpace;
              m.map.anisotropy = renderer.capabilities.getMaxAnisotropy();
              m.map.minFilter  = THREE.LinearMipmapLinearFilter;
              m.map.magFilter  = THREE.LinearFilter;
              m.map.generateMipmaps = true;
              m.map.needsUpdate = true;
            }
            const nb = new THREE.MeshBasicMaterial({
              map: m.map || null,
              color: 0xffffff,
              side: THREE.DoubleSide,
              toneMapped: false,
              clippingPlanes: null,
              clipShadows: false,
            });
            nb.name = m.name;
            falconBaseMaterials.push(nb);
            return nb;
          });
          if (o.material.length === 1) o.material = o.material[0];
          o.castShadow = false;
          o.receiveShadow = false;
          // Schedule emissive overlay if applicable
          const emissPng = FALCON_EMISSIVE_OVERLAYS[matName];
          if (emissPng) overlayJobs.push({ mesh: o, emissPng });
        });

        // Second pass: add additive emissive overlay meshes (sharing geometry)
        overlayJobs.forEach(({ mesh, emissPng }) => {
          const tex = loadFalconTex(emissPng);
          const glowMat = new THREE.MeshBasicMaterial({
            map: tex,
            color: 0xffffff,
            blending: THREE.AdditiveBlending,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            toneMapped: false,
            clippingPlanes: falconCropPlanes,
          });
          falconGlowMaterials.push(glowMat);
          const overlay = new THREE.Mesh(mesh.geometry, glowMat);
          overlay.renderOrder = (mesh.renderOrder || 0) + 1;
          mesh.parent.add(overlay);
        });

        falconBackdrop.add(obj);
        applyFalconLook();   // push initial tint to all materials
        console.log(`[falcon HD] base materials ${falconBaseMaterials.length}, glow overlays ${falconGlowMaterials.length}`);
      },
      (xhr) => console.log('[falcon HD]', Math.round((xhr.loaded / xhr.total) * 100) + '%'),
      (err) => console.error('[falcon HD] OBJ failed:', err));
  },
  undefined,
  (err) => console.error('[falcon HD] MTL failed:', err));

// Generic per-panel undo stack — pointerdown captures pre-drag value and
// any panel can offer an "Undo" button to revert the last slider drag.
// Each control panel registers a `pull from live scene` callback here on
// mount. The gizmo (TransformControls) calls all of them on every
// objectChange so slider thumbs track the 3D handles in real time. Also
// invoked from each panel's Copy button so the clipboard never reports
// stale values.
const PANEL_SYNCS = [];

// ----- LOCAL PERSISTENCE -----------------------------------------------
// Every slider/gizmo edit gets saved to localStorage under one JSON blob.
// On reload, persisted values OVERRIDE the hardcoded "locked" defaults so
// the user doesn't have to keep copy-pasting numbers back to me — their
// tweaks just stick. The code-baked locked values stay as the FALLBACK
// so a fresh browser (or after a reset) gets the canonical scene.
//
// The "Copy positions" button still copies the current state so the user
// can paste it into chat when they want me to bake values into the repo
// (which is what makes them survive across machines / clear cache / etc.).
const PERSIST_KEY = 'desk-portfolio:positions:v1';
function loadPersisted() {
  try { return JSON.parse(localStorage.getItem(PERSIST_KEY) || '{}') || {}; }
  catch { return {}; }
}
function savePersisted(patch) {
  try {
    const cur = loadPersisted();
    Object.assign(cur, patch);
    localStorage.setItem(PERSIST_KEY, JSON.stringify(cur));
  } catch (err) {
    console.warn('[persist] save failed', err);
  }
}
function clearPersisted() {
  try { localStorage.removeItem(PERSIST_KEY); } catch {}
}
window.__clearPersistedPositions = clearPersisted;
// Cached snapshot at module load for sync reads inside panel mounts.
const PERSISTED = loadPersisted();
// Helpers each panel uses to seed state and to write back on every apply.
function persistedGet(prefix, fallback) {
  const out = { ...fallback };
  for (const k of Object.keys(fallback)) {
    const v = PERSISTED[`${prefix}.${k}`];
    if (typeof v === 'number') out[k] = v;
  }
  return out;
}
function persistedSet(prefix, state) {
  const patch = {};
  for (const [k, v] of Object.entries(state)) {
    patch[`${prefix}.${k}`] = v;
  }
  savePersisted(patch);
}
// Applier registry — panels push a `() => apply current state to scene`
// callback. After the room.glb loads we run them all so persisted edits
// take effect on first frame.
const PERSISTED_APPLIERS = [];

// Build a panel shell with a header (title + minimize button) and a body
// container. New content goes into `body`; clicking the minimize button
// toggles body visibility so the panel collapses to just the header.
function makeCollapsiblePanel({ title, side = 'left', bottomPx = 80, width = 240 }) {
  const outer = document.createElement('div');
  outer.style.cssText = `
    position: absolute; bottom: ${bottomPx}px; ${side}: 16px;
    background: rgba(0,0,0,0.65);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 12px;
    padding: 10px 12px; backdrop-filter: blur(12px);
    color: #fff; font: 12px system-ui, sans-serif; z-index: 12;
    display: flex; flex-direction: column; gap: 7px;
    width: ${width}px;
    max-height: calc(100vh - 110px);
    overflow-y: auto; overflow-x: hidden;
  `;
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.9;cursor:default;user-select:none;position:sticky;top:0;background:rgba(0,0,0,0.65);padding-bottom:4px;z-index:1;flex-shrink:0;';
  const titleEl = document.createElement('span');
  titleEl.textContent = title;
  const minBtn = document.createElement('button');
  minBtn.type = 'button';
  minBtn.textContent = '−';
  minBtn.title = 'Minimize';
  minBtn.style.cssText = 'width:24px;height:22px;border-radius:6px;border:1px solid rgba(255,255,255,0.20);background:rgba(255,255,255,0.06);color:#fff;cursor:pointer;font-size:14px;line-height:1;padding:0;font-weight:700;flex-shrink:0;';
  header.append(titleEl, minBtn);
  // The body is what callers append controls into; we expose it as `wrap`
  // so existing panel code (that already calls `wrap.appendChild(...)`)
  // works unchanged.
  const body = document.createElement('div');
  body.style.cssText = 'display:flex;flex-direction:column;gap:7px;';
  outer.append(header, body);
  let collapsed = false;
  minBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    body.style.display = collapsed ? 'none' : 'flex';
    minBtn.textContent = collapsed ? '+' : '−';
    minBtn.title = collapsed ? 'Expand' : 'Minimize';
    outer.style.maxHeight = collapsed ? 'none' : 'calc(100vh - 110px)';
    outer.style.overflow = collapsed ? 'visible' : 'auto';
  });
  document.body.appendChild(outer);
  return { wrap: body, outer };
}

// ----- GLOBAL UNDO -----------------------------------------------------
// Every panel slider, every gizmo drag, every +/- click pushes onto this
// shared stack. Cmd+Z / Ctrl+Z anywhere on the page pops one entry. Per-
// panel "Undo" buttons aren't needed because the keyboard shortcut and
// the gizmo HUD's own ↶ Undo (which calls __undo) all funnel here.
const GLOBAL_UNDO = [];
const GLOBAL_UNDO_LIMIT = 200;
function pushGlobalUndo(target, prev) {
  GLOBAL_UNDO.push({ target, prev });
  if (GLOBAL_UNDO.length > GLOBAL_UNDO_LIMIT) GLOBAL_UNDO.shift();
}
function popGlobalUndo() {
  const s = GLOBAL_UNDO.pop();
  if (s && typeof s.target === 'function') {
    try { s.target(s.prev); } catch (err) { console.warn('[undo] handler failed', err); }
  }
  return !!s;
}
window.__popGlobalUndo = popGlobalUndo;
// Cmd+Z (macOS) / Ctrl+Z (Win/Linux) → undo. Cmd+Shift+Z and Ctrl+Y are
// browser convention for redo; we don't implement redo so we ignore them.
window.addEventListener('keydown', (e) => {
  const isUndo = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z';
  if (!isUndo) return;
  // Sliders are <input type=range> and shouldn't swallow Cmd+Z; text
  // fields should. Skip ONLY text-style inputs and contentEditable.
  const t = e.target;
  if (t && t.isContentEditable) return;
  if (t && t.tagName === 'TEXTAREA') return;
  if (t && t.tagName === 'INPUT') {
    const type = (t.type || '').toLowerCase();
    if (type === 'text' || type === 'search' || type === 'email' || type === 'url' || type === 'password') return;
  }
  e.preventDefault();
  popGlobalUndo();
});

// makePanelUndo returns an object whose push/pop both proxy into the
// global stack. Existing callers don't need to change — but every Undo
// button now operates on the same global history (including Cmd+Z).
function makePanelUndo() {
  return {
    push(target, prev) { pushGlobalUndo(target, prev); },
    pop() { return popGlobalUndo(); },
  };
}

// Build a Copy / Undo / Reset button row at the bottom of a control panel.
// • Copy → puts a one-line summary on the clipboard so the user can paste
//   the values back to me in chat to lock them in.
// • Undo → pops the last entry from the panel's undo stack.
// • Reset (optional) → snaps every slider back to its baseline.
function makeActionRow(undoStack, getValuesText, onReset) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;margin-top:4px;';
  function btn(label) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = 'flex:1;padding:5px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:#fff;cursor:pointer;font-size:11px;';
    return b;
  }
  const copyBtn = btn('📋 Copy');
  copyBtn.addEventListener('click', () => {
    const text = getValuesText();
    navigator.clipboard?.writeText(text).then(() => {
      const orig = copyBtn.textContent;
      copyBtn.textContent = '✓ Copied';
      setTimeout(() => { copyBtn.textContent = orig; }, 1200);
    });
  });
  row.appendChild(copyBtn);

  // (Per-row Undo button removed — Cmd+Z / Ctrl+Z handles undo globally.)

  if (onReset) {
    const resetBtn = btn('Reset');
    resetBtn.addEventListener('click', onReset);
    row.appendChild(resetBtn);
  }
  return row;
}

// Shared slider-row builder used by every control panel. Produces:
//   ┌──────────────────────────────────────────────┐
//   │ Label                                  value │
//   │ [-] [=============slider===========] [+]     │
//   └──────────────────────────────────────────────┘
// • The slider is a normal <input type=range>; clicking - / + nudges the
//   value by `fineStep` (defaults to the slider step) for tiny tweaks.
// • Each user gesture (slider drag start OR +/- click) snapshots the
//   PRE-change value into `undoStack` so the panel's Undo button rolls back
//   that gesture.
// • `state[key]` is the source of truth; `onApply()` is called after every
//   change so the panel can re-render whatever 3D objects it controls.
// Returns { row, sl, val, set } — `set(v)` programmatically updates without
// pushing to the undo stack (used by Reset / Undo to refresh DOM only).
function buildSliderRow({ state, key, label, min, max, step, fineStep, undoStack, onApply, decimals = 3 }) {
  fineStep = fineStep ?? step;
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;flex-direction:column;gap:2px;font-size:11px;';
  // Top: label on the left, current value on the right.
  const top = document.createElement('div');
  top.style.cssText = 'display:flex;justify-content:space-between;opacity:0.85;';
  const lab = document.createElement('span'); lab.textContent = label;
  const val = document.createElement('span'); val.textContent = state[key].toFixed(decimals);
  top.appendChild(lab); top.appendChild(val);
  row.appendChild(top);
  // Bottom: [-] [slider] [+].
  const sliderRow = document.createElement('div');
  sliderRow.style.cssText = 'display:flex;align-items:center;gap:5px;';
  const stepBtnCss = 'flex:0 0 22px;height:22px;border-radius:6px;border:1px solid rgba(255,255,255,0.20);background:rgba(255,255,255,0.06);color:#fff;cursor:pointer;font-size:14px;line-height:1;padding:0;font-weight:600;';
  const minusBtn = document.createElement('button');
  minusBtn.type = 'button';
  minusBtn.textContent = '−';
  minusBtn.style.cssText = stepBtnCss;
  const sl = document.createElement('input');
  sl.type = 'range'; sl.min = min; sl.max = max; sl.step = step;
  sl.value = state[key];
  sl.style.cssText = 'flex:1 1 auto;min-width:0;height:18px;';
  const plusBtn = document.createElement('button');
  plusBtn.type = 'button';
  plusBtn.textContent = '+';
  plusBtn.style.cssText = stepBtnCss;
  sliderRow.appendChild(minusBtn);
  sliderRow.appendChild(sl);
  sliderRow.appendChild(plusBtn);
  row.appendChild(sliderRow);

  function set(v) {
    v = Math.max(min, Math.min(max, v));
    state[key] = v;
    sl.value = v;
    val.textContent = v.toFixed(decimals);
  }
  function pushUndo() {
    if (!undoStack) return;
    const prev = state[key];
    undoStack.push((v) => { set(v); onApply?.(); }, prev);
  }
  function nudge(dir, mult = 1) {
    set(state[key] + dir * fineStep * mult);
    onApply?.();
  }
  // Hold-to-repeat for +/- buttons. Behaviour:
  //   • pointerdown        → one undo snapshot + immediate nudge (×1)
  //   • after 350 ms hold  → start auto-repeat at ~16/sec, ×1
  //   • after 900 ms hold  → accelerate to ×4 per tick (so you traverse
  //                          the slider's whole range in a few seconds)
  //   • after 1800 ms hold → ×12 per tick (real "big numbers" speed)
  //   • pointerup/leave/   → stop. Cancelled by clipboard popups too.
  //     cancel
  // Wiring "click" alongside hold is risky (browsers fire click after
  // pointerup), so we do everything from pointerdown and explicitly
  // suppress the trailing click.
  function attachHoldRepeat(btn, dir) {
    let initialT = null, repeatT = null, holdStart = 0;
    const stop = () => {
      if (initialT) { clearTimeout(initialT); initialT = null; }
      if (repeatT) { clearInterval(repeatT); repeatT = null; }
      holdStart = 0;
    };
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      btn.setPointerCapture?.(e.pointerId);
      pushUndo();
      nudge(dir, 1);
      holdStart = performance.now();
      initialT = setTimeout(() => {
        repeatT = setInterval(() => {
          const held = performance.now() - holdStart;
          const mult = held > 1800 ? 12 : held > 900 ? 4 : 1;
          nudge(dir, mult);
        }, 60);
      }, 350);
    });
    ['pointerup', 'pointerleave', 'pointercancel', 'blur'].forEach((evt) => {
      btn.addEventListener(evt, stop);
    });
    btn.addEventListener('click', (e) => e.preventDefault());
  }
  attachHoldRepeat(minusBtn, -1);
  attachHoldRepeat(plusBtn,  +1);

  sl.addEventListener('pointerdown', pushUndo);
  sl.addEventListener('input', () => {
    state[key] = parseFloat(sl.value);
    val.textContent = state[key].toFixed(decimals);
    onApply?.();
  });
  return { row, sl, val, set };
}

// ---------- Falcon look panel (bottom-right, stacked) -------------------
// Falcon + Venator look panels disabled (values locked in code)
if (false) (function mountFalconLookPanel() {
  const wrap = document.createElement('div');
  wrap.style.cssText = `
    position: absolute; bottom: 80px; right: 16px;
    background: rgba(0,0,0,0.65);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 12px;
    padding: 12px 14px; backdrop-filter: blur(12px);
    color: #fff; font: 12px system-ui, sans-serif; z-index: 12;
    display: flex; flex-direction: column; gap: 6px;
    min-width: 220px;
  `;
  const title = document.createElement('div');
  title.textContent = 'Falcon look';
  title.style.cssText = 'font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;opacity:0.9;';
  wrap.appendChild(title);
  const undo = makePanelUndo();
  function add(key, label, min, max, step) {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;flex-direction:column;gap:1px;font-size:11px;';
    const top = document.createElement('div');
    top.style.cssText = 'display:flex;justify-content:space-between;opacity:0.85;';
    const lab = document.createElement('span'); lab.textContent = label;
    const val = document.createElement('span'); val.textContent = falconLook[key].toFixed(2);
    top.appendChild(lab); top.appendChild(val);
    row.appendChild(top);
    const sl = document.createElement('input');
    sl.type = 'range'; sl.min = min; sl.max = max; sl.step = step;
    sl.value = falconLook[key];
    sl.style.cssText = 'width:100%;height:18px;';
    sl.addEventListener('pointerdown', () => {
      const prev = falconLook[key];
      undo.push((v) => { falconLook[key] = v; sl.value = v; val.textContent = v.toFixed(2); applyFalconLook(); }, prev);
    });
    sl.addEventListener('input', (e) => {
      falconLook[key] = parseFloat(e.target.value);
      val.textContent = falconLook[key].toFixed(2);
      applyFalconLook();
    });
    row.appendChild(sl);
    wrap.appendChild(row);
  }
  add('brightness', 'Brightness', 0, 2,    0.01);
  add('warmth',     'Warmth',    -1, 1,    0.01);
  add('glow',       'Glow',       0, 3,    0.01);
  add('glowWarmth', 'Glow warmth',-1, 1,    0.01);
  const undoBtn = document.createElement('button');
  undoBtn.textContent = '↶ Undo';
  undoBtn.style.cssText = 'margin-top:6px;padding:5px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:#fff;cursor:pointer;font-size:11px;';
  undoBtn.addEventListener('click', () => undo.pop());
  wrap.appendChild(undoBtn);
  document.body.appendChild(wrap);
})();

// ---------- Venator prefab backdrop -------------------------------------
// Locked transform from user gizmo placement. We KEEP the GLB's original
// PBR (MeshStandardMaterial) materials so it picks up our HDRI sunset for
// crisp specular reflections like the Sketchfab preview. envMapIntensity
// is boosted so the metallic panels really catch the light.
// `scaleTarget` is the BAKE-TIME size used by loadProp to fit the GLB to a
// known longest-dimension at load. NEVER change this value on user lock —
// changing it rescales the inner gltf.scene and compounds with the outer
// group scale (see venatorBackdrop.scale.setScalar(...) below). Going
// forward this stays at 7.240, the historical bake size the user has
// been dialing the OUTER scale against.
const VENATOR_BAKE_SCALE = 7.240;
// LOCKED transform for the Venator (only the OUTER scale should change
// when the user adjusts; pos/rot/crop too via persistence).
const VENATOR_LOCKED = {
  x: 6.318, y: 0.000, z: -5.205,
  s: 5.675,
  zMin: -50, zMax: 4.95,
};
const venatorPersisted = persistedGet('venator', VENATOR_LOCKED);
const venatorBackdrop = loadProp({
  id: 'venator', label: 'Venator backdrop',
  glbPath: '/models/venator_prefab.glb',
  target: { x: venatorPersisted.x, y: venatorPersisted.y, z: venatorPersisted.z },
  scaleTarget: VENATOR_BAKE_SCALE,             // FIXED — do not change
});
venatorBackdrop.rotation.set(0, 0, 0);
venatorBackdrop.scale.setScalar(venatorPersisted.s);
venatorBackdrop.visible = true;
// Register so the post-init applier loop re-asserts the persisted values
// (in case anything between load and now nudged them).
PERSISTED_APPLIERS.push(() => {
  const v = loadPersisted();
  if (typeof v['venator.x'] === 'number') venatorBackdrop.position.x = v['venator.x'];
  if (typeof v['venator.y'] === 'number') venatorBackdrop.position.y = v['venator.y'];
  if (typeof v['venator.z'] === 'number') venatorBackdrop.position.z = v['venator.z'];
  if (typeof v['venator.s'] === 'number') venatorBackdrop.scale.setScalar(v['venator.s']);
  // Read ALL 6 crop sides so a fresh load restores the user's clipped silhouette
  if (typeof v['venator.xMin'] === 'number') venatorCrop.xMin = v['venator.xMin'];
  if (typeof v['venator.xMax'] === 'number') venatorCrop.xMax = v['venator.xMax'];
  if (typeof v['venator.yMin'] === 'number') venatorCrop.yMin = v['venator.yMin'];
  if (typeof v['venator.yMax'] === 'number') venatorCrop.yMax = v['venator.yMax'];
  if (typeof v['venator.zMin'] === 'number') venatorCrop.zMin = v['venator.zMin'];
  if (typeof v['venator.zMax'] === 'number') venatorCrop.zMax = v['venator.zMax'];
  if (typeof updateVenatorCarve === 'function') updateVenatorCarve();
});

// User-driven crop: 6 axis-aligned planes whose normals point INTO the
// keep-region. With the default `clipIntersection: false`, a fragment is
// rendered ONLY when it's in the positive halfspace of every plane —
// effectively limiting the visible Venator to the [xMin..xMax] x [yMin..yMax]
// x [zMin..zMax] box. The sliders below drive these constants live.
//
// Defaults are wide enough that nothing is clipped initially. The user
// dials each side in until the desired silhouette is reached.
// LOCKED-IN crop values (user-confirmed). Panel below is disabled.
const venatorCrop = {
  xMin: -50.00, xMax: 50.00,    // left / right
  yMin: -50.00, yMax: 50.00,    // bottom / top
  zMin: -50.00, zMax:  4.95,    // back / front  (front cropped at +4.95)
};
const venatorCarvePlanes = [
  new THREE.Plane(new THREE.Vector3( 1, 0, 0), -venatorCrop.xMin),  // x >= xMin
  new THREE.Plane(new THREE.Vector3(-1, 0, 0),  venatorCrop.xMax),  // x <= xMax
  new THREE.Plane(new THREE.Vector3( 0, 1, 0), -venatorCrop.yMin),  // y >= yMin
  new THREE.Plane(new THREE.Vector3( 0,-1, 0),  venatorCrop.yMax),  // y <= yMax
  new THREE.Plane(new THREE.Vector3( 0, 0, 1), -venatorCrop.zMin),  // z >= zMin
  new THREE.Plane(new THREE.Vector3( 0, 0,-1),  venatorCrop.zMax),  // z <= zMax
];
function updateVenatorCarve() {
  venatorCarvePlanes[0].constant = -venatorCrop.xMin;
  venatorCarvePlanes[1].constant =  venatorCrop.xMax;
  venatorCarvePlanes[2].constant = -venatorCrop.yMin;
  venatorCarvePlanes[3].constant =  venatorCrop.yMax;
  venatorCarvePlanes[4].constant = -venatorCrop.zMin;
  venatorCarvePlanes[5].constant =  venatorCrop.zMax;
}

// Live PBR tuning for the Venator. Drives envMap reflection, emissive glow,
// shininess (lower roughness), and per-material settings via sliders.
// LOCKED IN — user-confirmed values
const venatorLook = {
  reflection: 0.00,
  glow:       0.73,
  shininess:  0.83,
  brightness: 1.40,
};
const _venatorMatRefs = [];     // collected so the slider can re-apply

function applyVenatorLook() {
  for (const { mat, baseRough, baseColor } of _venatorMatRefs) {
    if (typeof mat.envMapIntensity === 'number') mat.envMapIntensity = venatorLook.reflection;
    if (typeof mat.emissiveIntensity === 'number' && mat.emissiveMap) {
      mat.emissiveIntensity = venatorLook.glow;
    }
    if (typeof mat.roughness === 'number') {
      // Pull roughness toward 0 by `shininess`, never below 0.05.
      mat.roughness = Math.max(0.05, baseRough * (1 - venatorLook.shininess));
    }
    mat.color.copy(baseColor).multiplyScalar(venatorLook.brightness);
    mat.needsUpdate = true;
  }
}

const _venatorPbrInterval = setInterval(() => {
  if (!venatorBackdrop.children.length) return;
  clearInterval(_venatorPbrInterval);
  // Track the largest panel-style mesh so we can borrow its material as the
  // creative lining for the bookshelf alcove (per user request).
  let bestLiningMat = null;
  let bestLiningArea = 0;
  venatorBackdrop.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((m) => {
      m.transparent = false; m.opacity = 1.0; m.depthWrite = true;
      m.clippingPlanes = venatorCarvePlanes;
      m.clipIntersection = false;   // crop = render only INSIDE all 6 planes
      m.clipShadows = true;
      _venatorMatRefs.push({
        mat: m,
        baseRough: typeof m.roughness === 'number' ? m.roughness : 1,
        baseColor: m.color ? m.color.clone() : new THREE.Color(0xffffff),
      });
      // "Best" lining material = a Standard PBR mat with a diffuse map AND
      // no emissive map (we want the metallic panel look, not the glow
      // strips). Score by mesh bbox area as a rough size proxy.
      const isPanel = m.isMeshStandardMaterial && m.map && !m.emissiveMap;
      if (isPanel) {
        const bb = new THREE.Box3().setFromObject(o);
        const sz = bb.getSize(new THREE.Vector3());
        const area = sz.x * sz.y + sz.y * sz.z + sz.x * sz.z;
        if (area > bestLiningArea) {
          bestLiningArea = area;
          bestLiningMat = m;
        }
      }
    });
  });
  applyVenatorLook();
  console.log(`[venator] PBR tuned — ${_venatorMatRefs.length} materials registered`);
  // Lining feature removed per user request — keep `bestLiningMat` ref only
  // for future use (debug). No alcove shells are constructed.
  void bestLiningMat;
}, 80);

// ---------- Venator look panel (disabled — values locked) ---------------
// Look values are baked-in; see venatorLook above.

// ---------- Venator CROP panel (DISABLED — values locked) --------------
// User confirmed the silhouette they want. Persisted values in localStorage
// under venator.{xMin,xMax,yMin,yMax,zMin,zMax} continue to drive the
// clipping planes via the PERSISTED_APPLIERS push above. Toggle back to
// IS_BUILD_MODE to re-enable the sliders for tweaking.
if (false) (function mountVenatorCropPanel() {
  const wrap = document.createElement('div');
  wrap.style.cssText = `
    position: absolute; bottom: 80px; right: 16px;
    background: rgba(0,0,0,0.65);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 12px;
    padding: 12px 14px; backdrop-filter: blur(12px);
    color: #fff; font: 12px system-ui, sans-serif; z-index: 12;
    display: flex; flex-direction: column; gap: 6px;
    min-width: 240px;
  `;
  const t = document.createElement('div');
  t.textContent = 'Venator crop';
  t.style.cssText = 'font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;opacity:0.9;';
  wrap.appendChild(t);

  const cropUndo = makePanelUndo();
  // Write all 6 crop sides back to localStorage under venator.* so a reload
  // restores the exact clipped silhouette.
  function persistVenatorCrop() {
    persistedSet('venator', {
      xMin: venatorCrop.xMin, xMax: venatorCrop.xMax,
      yMin: venatorCrop.yMin, yMax: venatorCrop.yMax,
      zMin: venatorCrop.zMin, zMax: venatorCrop.zMax,
    });
  }
  function addCropSlider(key, label, min, max) {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;flex-direction:column;gap:1px;font-size:11px;';
    const top = document.createElement('div');
    top.style.cssText = 'display:flex;justify-content:space-between;opacity:0.85;';
    const lab = document.createElement('span'); lab.textContent = label;
    const val = document.createElement('span'); val.textContent = venatorCrop[key].toFixed(2);
    top.appendChild(lab); top.appendChild(val);
    row.appendChild(top);
    // Slider + precision-button row (matches the Incredibile crop / shelf-light pattern)
    const sliderRow = document.createElement('div');
    sliderRow.style.cssText = 'display:flex;align-items:center;gap:4px;';
    const sl = document.createElement('input');
    sl.type = 'range'; sl.min = min; sl.max = max; sl.step = 0.05;
    sl.value = venatorCrop[key];
    sl.style.cssText = 'flex:1;height:18px;';
    function setCrop(v) {
      venatorCrop[key] = Math.max(min, Math.min(max, v));
      sl.value = venatorCrop[key];
      val.textContent = venatorCrop[key].toFixed(2);
      updateVenatorCarve();
      persistVenatorCrop();
    }
    sl.addEventListener('pointerdown', () => {
      const prev = venatorCrop[key];
      cropUndo.push((v) => {
        venatorCrop[key] = v; sl.value = v; val.textContent = v.toFixed(2);
        updateVenatorCarve(); persistVenatorCrop();
      }, prev);
    });
    sl.addEventListener('input', (e) => setCrop(parseFloat(e.target.value)));
    // Precision nudge buttons: ⏪◀▶⏩  (±0.10 coarse, ±0.01 fine)
    function mkBtn(txt, delta) {
      const b = document.createElement('button');
      b.textContent = txt;
      b.style.cssText = 'width:22px;height:22px;border-radius:4px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:#fff;cursor:pointer;font-size:10px;line-height:1;padding:0;';
      b.addEventListener('click', () => {
        const prev = venatorCrop[key];
        cropUndo.push((v) => {
          venatorCrop[key] = v; sl.value = v; val.textContent = v.toFixed(2);
          updateVenatorCarve(); persistVenatorCrop();
        }, prev);
        setCrop(venatorCrop[key] + delta);
      });
      return b;
    }
    sliderRow.appendChild(mkBtn('⏪', -0.10));
    sliderRow.appendChild(mkBtn('◀',  -0.01));
    sliderRow.appendChild(sl);
    sliderRow.appendChild(mkBtn('▶',   0.01));
    sliderRow.appendChild(mkBtn('⏩',  0.10));
    row.appendChild(sliderRow);
    wrap.appendChild(row);
  }
  // Range ±50m is way bigger than the Venator's footprint, so the slider
  // covers everything from "full corridor" to "thin sliver" with one drag.
  addCropSlider('xMin', 'Left  (xMin)',  -50, 50);
  addCropSlider('xMax', 'Right (xMax)',  -50, 50);
  addCropSlider('zMax', 'Front (zMax)',  -50, 50);
  addCropSlider('zMin', 'Back  (zMin)',  -50, 50);
  addCropSlider('yMin', 'Bottom (yMin)', -50, 50);
  addCropSlider('yMax', 'Top   (yMax)',  -50, 50);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:6px;margin-top:6px;';
  const undoBtn = document.createElement('button');
  undoBtn.textContent = '↶ Undo';
  undoBtn.style.cssText = 'flex:1;padding:5px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:#fff;cursor:pointer;font-size:11px;';
  undoBtn.addEventListener('click', () => cropUndo.pop());
  btnRow.appendChild(undoBtn);

  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  resetBtn.style.cssText = 'flex:1;padding:5px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:#fff;cursor:pointer;font-size:11px;';
  resetBtn.addEventListener('click', () => {
    venatorCrop.xMin = -50; venatorCrop.xMax = 50;
    venatorCrop.yMin = -50; venatorCrop.yMax = 50;
    venatorCrop.zMin = -50; venatorCrop.zMax = 50;
    updateVenatorCarve();
    persistVenatorCrop();
    // Refresh slider DOM values + their value-readout labels
    const keys = ['xMin','xMax','zMax','zMin','yMin','yMax'];
    wrap.querySelectorAll('input[type=range]').forEach((sl, i) => {
      const k = keys[i];
      sl.value = venatorCrop[k];
      const row = sl.closest('label');
      const readout = row?.querySelector('div > span:last-child');
      if (readout) readout.textContent = venatorCrop[k].toFixed(2);
    });
  });
  btnRow.appendChild(resetBtn);
  wrap.appendChild(btnRow);

  document.body.appendChild(wrap);
})();

// Convert any prop's materials to "unlit + emissive overlay" so the model's
// own diffuse and emissive maps render at full bake regardless of scene
// lights. Reusable for Venator and any future model with emissive maps.
function makePropUnlitWithGlow(rootGroup) {
  if (!rootGroup.children.length) {
    setTimeout(() => makePropUnlitWithGlow(rootGroup), 80);
    return;
  }
  const overlayJobs = [];
  rootGroup.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    o.material = mats.map((m) => {
      const emissiveMap = m.emissiveMap;
      const nb = new THREE.MeshBasicMaterial({
        map: m.map || null,
        color: 0xffffff,
        side: m.side || THREE.FrontSide,
        toneMapped: false,
        transparent: false,
        depthWrite: true,
      });
      nb.name = m.name;
      if (emissiveMap) overlayJobs.push({ mesh: o, emissiveMap });
      return nb;
    });
    if (o.material.length === 1) o.material = o.material[0];
    o.castShadow = false;
    o.receiveShadow = false;
  });
  overlayJobs.forEach(({ mesh, emissiveMap }) => {
    const glowMat = new THREE.MeshBasicMaterial({
      map: emissiveMap,
      color: 0xffffff,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const overlay = new THREE.Mesh(mesh.geometry, glowMat);
    overlay.renderOrder = (mesh.renderOrder || 0) + 1;
    mesh.parent.add(overlay);
  });
  console.log(`[unlit+glow] applied — ${overlayJobs.length} emissive overlays added`);
}
// Venator skips the unlit conversion — we want PBR for proper reflections

// ---------- Visibility + Fly-mode panel (bottom-left) -------------------
// (Bottom-left Backdrops & nav panel removed — replaced by the floating Sliders menu button + bottom-bar Fly mode toggle. Cmd+Z handles undo globally.)

// (Venator transform + crop panels removed — positioning via gizmo only.
// The single floating "Copy positions" button captures Venator state.)

// ---------- Contextual editor panel -----------------------------------
// One panel that swaps content based on what the user clicked in the 3D
// view. Three modes:
//   • "Bookshelf"        → X / Y / Z / rotY sliders (move the whole
//                          shelf assembly + every prop riding on it)
//   • "Desk"             → X / Y / Z sliders (drives applyDeskOffset; moves
//                          desk + Mac + lamp + bonsai + screen + monstera
//                          + camera together)
//   • "Venator backdrop" → X / Y / Z / scale + crop zMin / zMax sliders
// Closed (display:none) when nothing relevant is selected.
(function mountContextualEditor() {
  const { wrap, outer } = makeCollapsiblePanel({
    title: 'Edit selected',
    side: 'right',
    bottomPx: 80,    // bottom-right; was 220 but Backdrop panel is gone now
    width: 280,      // a touch wider so slider thumbs aren't tight
  });
  outer.style.display = 'none';   // hidden until a relevant click
  // We'll rebuild the body each time the selection target changes.
  let currentMode = null;

  function clearBody() {
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
  }
  function pillInfo(text) {
    const d = document.createElement('div');
    d.style.cssText = 'font-size:10px;opacity:0.65;line-height:1.45;padding:2px 0 4px;';
    d.textContent = text;
    return d;
  }

  // --- Bookshelf editor -------------------------------------------------
  function buildShelfEditor() {
    const sas = (() => {
      const g = propGroups.bookshelf?.group;
      return g
        ? { x: g.position.x, y: g.position.y, z: g.position.z, rotY: g.rotation.y }
        : { x: 0, y: 0, z: 0, rotY: 0 };
    })();
    function applySas() {
      const g = propGroups.bookshelf?.group;
      if (!g) return;
      g.position.set(sas.x, sas.y, sas.z);
      g.rotation.y = sas.rotY;
    }
    const undo = makePanelUndo();
    const sliders = {};
    function add(key, label, min, max, step, fineStep) {
      const r = buildSliderRow({ state: sas, key, label, min, max, step, fineStep, undoStack: undo, onApply: applySas });
      wrap.appendChild(r.row);
      sliders[key] = r;
    }
    wrap.appendChild(pillInfo('Drives the shelf assembly + every prop on it (Groot, books, foliage, sword, boot, strip lights).'));
    add('x',    'Shelf X (sink → Venator)', -2,        6,        0.005, 0.001);
    add('y',    'Shelf Y (up/down)',        -5,       10,        0.005, 0.001);
    add('z',    'Shelf Z (depth)',         -10,       10,        0.005, 0.001);
    add('rotY', 'Shelf rotate Y',           -Math.PI,  Math.PI,  0.01,  0.005);
    function syncFromScene() {
      const g = propGroups.bookshelf?.group;
      if (!g) return;
      sliders.x?.set(g.position.x);
      sliders.y?.set(g.position.y);
      sliders.z?.set(g.position.z);
      sliders.rotY?.set(g.rotation.y);
    }
    PANEL_SYNCS.push(syncFromScene);
  }

  // --- Desk editor ------------------------------------------------------
  function buildDeskEditor() {
    const desk = { x: deskOffsetX, y: deskOffsetY, z: deskOffsetZ };
    function apply() { applyDeskOffset(desk.x, desk.y, desk.z); }
    const undo = makePanelUndo();
    const sliders = {};
    function add(key, label, min, max) {
      const r = buildSliderRow({ state: desk, key, label, min, max, step: 0.005, fineStep: 0.001, undoStack: undo, onApply: apply });
      wrap.appendChild(r.row);
      sliders[key] = r;
    }
    wrap.appendChild(pillInfo('Drives the desk, Mac, screen, lamp, bonsai, monstera AND every camera mode + DOF focus together.'));
    add('x', 'Desk X (left/right)', -3,  3);
    add('y', 'Desk Y (up/down)',    -2,  2);
    add('z', 'Desk Z (front/back)', -10, 4);
    function syncFromScene() {
      sliders.x?.set(deskOffsetX);
      sliders.y?.set(deskOffsetY);
      sliders.z?.set(deskOffsetZ);
    }
    PANEL_SYNCS.push(syncFromScene);
  }

  // --- Venator editor ---------------------------------------------------
  function buildVenatorEditor() {
    const VEN_LOCKED = {
      x: venatorBackdrop.position.x,
      y: venatorBackdrop.position.y,
      z: venatorBackdrop.position.z,
      s: venatorBackdrop.scale.x,
      zMin: venatorCrop.zMin,
      zMax: venatorCrop.zMax,
    };
    const ven = persistedGet('venator', VEN_LOCKED);
    function applyTransform() {
      venatorBackdrop.position.set(ven.x, ven.y, ven.z);
      venatorBackdrop.scale.setScalar(ven.s);
      persistedSet('venator', ven);
    }
    function applyCrop() {
      venatorCrop.zMin = ven.zMin;
      venatorCrop.zMax = ven.zMax;
      updateVenatorCarve();
      persistedSet('venator', ven);
    }
    const undo = makePanelUndo();
    const sliders = {};
    function add(key, label, min, max, step, fineStep, onApply) {
      const r = buildSliderRow({ state: ven, key, label, min, max, step, fineStep, undoStack: undo, onApply });
      wrap.appendChild(r.row);
      sliders[key] = r;
    }
    wrap.appendChild(pillInfo('Drives the Venator corridor backdrop position, scale, and front/back crop.'));
    add('x',    'Venator X',       -50,  50, 0.05, 0.01,  applyTransform);
    add('y',    'Venator Y',       -25,  25, 0.05, 0.01,  applyTransform);
    add('z',    'Venator Z',       -50,  50, 0.05, 0.01,  applyTransform);
    add('s',    'Venator scale',   0.5,  30, 0.01, 0.005, applyTransform);
    add('zMax', 'Crop front (zMax)', -50,  50, 0.05, 0.01, applyCrop);
    add('zMin', 'Crop back  (zMin)', -50,  50, 0.05, 0.01, applyCrop);
    function syncFromScene() {
      sliders.x?.set(venatorBackdrop.position.x);
      sliders.y?.set(venatorBackdrop.position.y);
      sliders.z?.set(venatorBackdrop.position.z);
      sliders.s?.set(venatorBackdrop.scale.x);
      sliders.zMin?.set(venatorCrop.zMin);
      sliders.zMax?.set(venatorCrop.zMax);
    }
    PANEL_SYNCS.push(syncFromScene);
  }

  // --- Backdrop editor (Rio / Luca shared plane) ------------------------
  function buildBackdropEditor() {
    if (!window.__rio) {
      wrap.appendChild(pillInfo('Backdrop plane is still loading — try again in a moment.'));
      return;
    }
    const bd = {
      x: window.__rio.position.x,
      y: window.__rio.position.y,
      z: window.__rio.position.z,
      w: window.__rio.geometry.parameters?.width ?? 26,
    };
    function apply() {
      if (typeof window.__setRioPlane === 'function') {
        window.__setRioPlane({ x: bd.x, y: bd.y, z: bd.z, w: bd.w });
      }
    }
    const undo = makePanelUndo();
    const sliders = {};
    function add(key, label, min, max, step, fineStep) {
      const r = buildSliderRow({ state: bd, key, label, min, max, step, fineStep, undoStack: undo, onApply: apply });
      wrap.appendChild(r.row);
      sliders[key] = r;
    }
    wrap.appendChild(pillInfo('Drives the through-window plane that hosts BOTH the Rio image and the Luca video.'));
    add('x', 'Backdrop X',     -30, 30,  0.05, 0.01);
    add('y', 'Backdrop Y',     -10, 30,  0.05, 0.01);
    add('z', 'Backdrop Z',     -30, 30,  0.05, 0.01);
    add('w', 'Backdrop width',   1, 80,  0.10, 0.05);
    function syncFromScene() {
      if (!window.__rio) return;
      sliders.x?.set(window.__rio.position.x);
      sliders.y?.set(window.__rio.position.y);
      sliders.z?.set(window.__rio.position.z);
      sliders.w?.set(window.__rio.geometry.parameters?.width ?? bd.w);
    }
    PANEL_SYNCS.push(syncFromScene);
  }

  // --- Generic item editor (any other selectable) ----------------------
  // Position X/Y/Z + rotation Y + uniform scale + material adjustments
  // (shininess, reflection, brightness, glow). Works for Spider-Man masks,
  // Groot, books, foliage, hanging plant, etc. Persisted per item id.
  function buildItemEditor(item) {
    const g = item.group;
    if (!g) return;
    // Use a stable storage key based on the label (or group name).
    const storeKey = `item.${(item.label || g.name || 'unknown').replace(/\s+/g, '_')}`;
    // Collapsible section helper. Returns the BODY div — append your
    // sliders / buttons there. Header is a clickable button that toggles
    // body visibility. Open/closed state is persisted per-item per-key.
    function wrapSection(title, accent = '#cfe9ff', defaultOpen = false) {
      const stateKey = `${storeKey}.collapse.${title.replace(/[^A-Za-z0-9]+/g, '_')}`;
      let open;
      try { open = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}')[stateKey]; }
      catch {}
      if (typeof open !== 'boolean') open = defaultOpen;
      const sep = document.createElement('div');
      sep.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 0;';
      wrap.appendChild(sep);
      const header = document.createElement('button');
      header.type = 'button';
      header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.10);border-radius:6px;cursor:pointer;font:11px system-ui;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;width:100%;text-align:left;margin-top:4px;';
      header.style.color = accent;
      const body = document.createElement('div');
      body.style.cssText = 'display:flex;flex-direction:column;gap:3px;padding:6px 0 4px 4px;';
      function paint() {
        header.textContent = `${open ? '▼' : '▶'}  ${title}`;
        body.style.display = open ? '' : 'none';
      }
      paint();
      header.addEventListener('click', () => {
        open = !open;
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur[stateKey] = open;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
        paint();
      });
      wrap.appendChild(header);
      wrap.appendChild(body);
      return body;
    }
    // Capture base material values so brightness/reflection multiplications
    // are relative to the material's authored look (not compounding).
    const baseMats = [];
    g.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        baseMats.push({
          mat: m,
          baseColor: m.color ? m.color.clone() : new THREE.Color(0xffffff),
          baseRough: typeof m.roughness === 'number' ? m.roughness : 1,
          baseEnv:   typeof m.envMapIntensity === 'number' ? m.envMapIntensity : 1,
          baseEmissiveI: typeof m.emissiveIntensity === 'number' ? m.emissiveIntensity : 1,
          baseEmissiveColor: m.emissive ? m.emissive.clone() : new THREE.Color(0x000000),
        });
      });
    });

    // Seed the editor's state from the LIVE transform, not from persisted
    // — loadProp already restored persisted transforms when the GLB
    // finished loading, so g.position is the source of truth here. Pulling
    // from a stale persisted blob was making the item teleport on first
    // click. Material multipliers still come from persistence (or default
    // to 1.0 / 0.0 = no-op) since materials aren't applied at load time.
    const state = {
      x: g.position.x, y: g.position.y, z: g.position.z,
      rotX: g.rotation.x, rotY: g.rotation.y, rotZ: g.rotation.z,
      scale: g.scale.x,
      shininess: typeof PERSISTED[`${storeKey}.shininess`]  === 'number' ? PERSISTED[`${storeKey}.shininess`]  : 0,
      reflection: typeof PERSISTED[`${storeKey}.reflection`] === 'number' ? PERSISTED[`${storeKey}.reflection`] : 1,
      brightness: typeof PERSISTED[`${storeKey}.brightness`] === 'number' ? PERSISTED[`${storeKey}.brightness`] : 1,
      glow:       typeof PERSISTED[`${storeKey}.glow`]       === 'number' ? PERSISTED[`${storeKey}.glow`]       : 1,
    };
    function applyTransform() {
      g.position.set(state.x, state.y, state.z);
      g.rotation.set(state.rotX, state.rotY, state.rotZ);
      g.scale.setScalar(state.scale);
    }
    function applyMaterials() {
      // Re-walk LIVE every call — earlier we cached `baseMats` once at
      // editor open, but a few code paths (the Advanced material section,
      // the Hoverboard upgrade, the Vespa rig) replace `mesh.material`
      // with a new MeshPhysicalMaterial. A cached reference would point
      // at the dead material and the slider would silently no-op. The
      // base-value snapshot lives on `material.userData._base*` so it
      // survives material swaps.
      g.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => {
          if (!m) return;
          if (!m.userData) m.userData = {};
          if (m.userData._editorBaseSnapped !== true) {
            m.userData._baseRough = typeof m.roughness === 'number' ? m.roughness : 1;
            m.userData._baseEnv   = typeof m.envMapIntensity === 'number' ? m.envMapIntensity : 1;
            m.userData._baseColor = m.color ? m.color.clone() : new THREE.Color(0xffffff);
            m.userData._baseEmissiveI = typeof m.emissiveIntensity === 'number' ? m.emissiveIntensity : 1;
            m.userData._editorBaseSnapped = true;
          }
          if (typeof m.roughness === 'number') {
            m.roughness = Math.max(0.02, m.userData._baseRough * (1 - state.shininess));
          }
          if (typeof m.envMapIntensity === 'number') {
            m.envMapIntensity = m.userData._baseEnv * state.reflection;
          }
          if (m.color && m.userData._baseColor) {
            m.color.copy(m.userData._baseColor).multiplyScalar(state.brightness);
          }
          if (typeof m.emissiveIntensity === 'number') {
            m.emissiveIntensity = m.userData._baseEmissiveI * state.glow;
          }
          m.needsUpdate = true;
        });
      });
    }
    function applyAll() {
      applyTransform();
      applyMaterials();
      persistedSet(storeKey, state);
    }
    // Material sliders shouldn't write the transform back (would round-
    // trip pos/rot/scale through the state's stored values, possibly
    // drifting them). They DO need to persist material multipliers so
    // reload picks them up. This used to be missing — the brightness /
    // shininess / reflection / glow sliders mutated materials live but
    // their values were never written to localStorage.
    function applyMaterialsAndPersist() {
      applyMaterials();
      persistedSet(storeKey, state);
    }
    // Apply MATERIALS only on first build (transform was already restored
    // by loadProp from persisted state — re-applying state.x/y/z here is
    // a no-op when state was seeded from live, so we skip the call to
    // avoid any rounding drift that could nudge the item).
    applyMaterials();

    wrap.appendChild(pillInfo(`Position, scale, and material look for ${item.label}.`));

    // Remove item — yanks the prop out of the scene + the SELECTABLE list
    // + the persistence blob, then closes the editor. Cmd+Z (or the
    // gizmo HUD's keyboard shortcut) restores it.
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '🗑 Remove item';
    removeBtn.style.cssText = 'padding:7px;border-radius:6px;border:1px solid rgba(255,120,120,0.55);background:rgba(255,120,120,0.12);color:#fff;cursor:pointer;font-size:11px;font-weight:600;';
    // Fly-lock button: pin the item at a camera-relative offset so it
    // hovers in your view as you fly. Toggles on/off; updates label
    // immediately. Available for every selectable.
    const flyLockBtn = document.createElement('button');
    flyLockBtn.type = 'button';
    function paintFlyLock() {
      const locked = window.__isLockedToCamera && window.__isLockedToCamera(g);
      flyLockBtn.textContent = locked ? '🔓 Unlock from camera' : '🔗 Lock to camera (fly)';
      flyLockBtn.style.cssText = `padding:7px;border-radius:6px;border:1px solid ${locked ? 'rgba(255,200,80,0.55)' : 'rgba(125,160,255,0.45)'};background:${locked ? 'rgba(255,200,80,0.15)' : 'rgba(125,160,255,0.08)'};color:#fff;cursor:pointer;font-size:11px;font-weight:600;`;
    }
    paintFlyLock();
    flyLockBtn.addEventListener('click', () => {
      const locked = window.__isLockedToCamera && window.__isLockedToCamera(g);
      if (locked) window.__unlockFromCamera?.(g);
      else        window.__lockToCamera?.(g);
      paintFlyLock();
    });
    wrap.appendChild(flyLockBtn);

    // ---- Assign to shelf -------------------------------------------------
    // Re-parents the prop under the bookshelf so it rides along with shelf
    // spacing nudges + shelf swaps. Picking "(unassigned)" detaches it back
    // to the room. Position is preserved visually because we use .attach().
    {
      const shelfRow = document.createElement('div');
      shelfRow.style.cssText = 'display:flex;gap:6px;align-items:center;margin-top:4px;';
      const shelfLabel = document.createElement('span');
      shelfLabel.textContent = '📚 Shelf:';
      shelfLabel.style.cssText = 'font-size:11px;opacity:0.85;';
      const shelfSel = document.createElement('select');
      shelfSel.style.cssText = 'flex:1;padding:6px 8px;border-radius:6px;background:#111;color:#fff;border:1px solid rgba(255,255,255,0.18);font:11px system-ui;';
      const NONE = '(none)';
      [NONE, 'A', 'B', 'C', 'D', 'E'].forEach((v) => {
        const opt = document.createElement('option');
        opt.value = v; opt.textContent = v === NONE ? '(none — sits in room)' : `Shelf ${v}`;
        shelfSel.appendChild(opt);
      });
      // Initial value: prefer persisted assignment; otherwise infer from the
      // current parent (bookshelf-attached → auto-detect by Y).
      try {
        const stored = loadPersisted();
        const assignments = stored['shelfSpacing.assignments'] || {};
        if (assignments[item.label]) {
          shelfSel.value = assignments[item.label];
        } else if (g.parent === propGroups.bookshelf?.group) {
          const det = detectShelfFromY(g.position.y);
          shelfSel.value = det || NONE;
        } else {
          shelfSel.value = NONE;
        }
      } catch { shelfSel.value = NONE; }
      shelfSel.addEventListener('change', () => {
        const v = shelfSel.value;
        window.__assignItemToShelf?.(g, item.label, v === NONE ? 'none' : v);
      });
      shelfRow.append(shelfLabel, shelfSel);
      wrap.appendChild(shelfRow);
    }

    removeBtn.addEventListener('click', () => {
      const parent = g.parent;
      const sIdx = SELECTABLE.findIndex((s) => s.group === g);
      const savedSelectable = sIdx >= 0 ? SELECTABLE.splice(sIdx, 1)[0] : null;
      // Snapshot the per-item persisted slice so undo can restore it.
      const snapshotPersisted = loadPersisted();
      const persistedKeys = Object.keys(snapshotPersisted).filter((k) => k.startsWith(storeKey + '.'));
      const snapshotItem = {};
      persistedKeys.forEach((k) => { snapshotItem[k] = snapshotPersisted[k]; });
      // Bank-spawned items: strip from the spawn registry (so they don't
      // reappear next reload). Built-in props (mug, boot, lamp, etc.):
      // add the label to the hidden-props list (loadProp checks this on
      // load and sets group.visible = false). Either way the item stays
      // removed across reloads.
      const dropMatch = /^__prop_(bank-.+)$/.exec(g.name || '');
      const bankId = dropMatch ? dropMatch[1] : null;
      // Frame-N extras live in extraFrames.v1 — when the user removes one
      // they want it GONE, not hidden, so it doesn't come back on reload
      // and doesn't keep showing up in the Sliders menu / Frame Match
      // picker. Also true for the Speed frame: stripping its label from
      // hidden.props (which the legacy path would add) and instead
      // removing the group entirely so a reload doesn't resurrect it.
      const isExtraFrame = /^__prop_extraframe_/.test(g.name || '');
      const isSpeedFrame = item.label === 'Speed frame';
      let savedBankEntry = null;
      let addedToHidden = false;
      let savedExtraEntry = null;
      let savedSpeedFrame = false;
      if (isExtraFrame) {
        try {
          const list = JSON.parse(localStorage.getItem('extraFrames.v1') || '[]');
          const idx = list.findIndex((e) => e?.label === item.label);
          if (idx >= 0) {
            savedExtraEntry = list[idx];
            list.splice(idx, 1);
            localStorage.setItem('extraFrames.v1', JSON.stringify(list));
          }
        } catch {}
        // Drop any pair-locks referencing this frame so we don't leave
        // dangling anchor/follower entries in pairLocks.v1.
        if (typeof window.__persistUnpair === 'function') {
          window.__persistUnpair(item.label);
        }
        if (typeof window.__refreshSlidersFrameList === 'function') {
          window.__refreshSlidersFrameList();
        }
      } else if (isSpeedFrame) {
        // True deletion of the Speed frame: drop it from the scene + clear
        // the artFrame globals so the Sliders menu's "Speed frame" entry
        // gracefully no-ops until a future build re-creates it.
        savedSpeedFrame = true;
        try { window.__persistUnpair?.('Speed frame'); } catch {}
        // Also strip from hidden.props if a previous "remove" hid it.
        try {
          const hidden = JSON.parse(localStorage.getItem('hidden.props.v1') || '[]');
          const i = hidden.indexOf('Speed frame');
          if (i >= 0) {
            hidden.splice(i, 1);
            localStorage.setItem('hidden.props.v1', JSON.stringify(hidden));
          }
        } catch {}
      } else if (bankId) {
        try {
          const list = JSON.parse(localStorage.getItem('bank.spawned.v2') || '[]');
          const idx = list.findIndex((e) => e.id === bankId);
          if (idx >= 0) {
            savedBankEntry = list[idx];
            list.splice(idx, 1);
            localStorage.setItem('bank.spawned.v2', JSON.stringify(list));
          }
        } catch {}
      } else {
        try {
          const hidden = JSON.parse(localStorage.getItem('hidden.props.v1') || '[]');
          if (!hidden.includes(item.label)) {
            hidden.push(item.label);
            localStorage.setItem('hidden.props.v1', JSON.stringify(hidden));
            addedToHidden = true;
          }
        } catch {}
      }
      // Remove from scene + per-item persisted slice.
      if (parent) parent.remove(g);
      const cur = loadPersisted();
      persistedKeys.forEach((k) => { delete cur[k]; });
      try { localStorage.setItem(PERSIST_KEY, JSON.stringify(cur)); } catch {}
      // Close the editor + clear selection
      tControls.detach(); selectedItem = null; hud.style.display = 'none';
      window.__onSelectionChange?.(null);
      // Push undo: restore everything we stripped.
      pushGlobalUndo(() => {
        if (parent && !g.parent) parent.add(g);
        g.visible = true;
        if (savedSelectable && !SELECTABLE.includes(savedSelectable)) SELECTABLE.push(savedSelectable);
        try {
          const reCur = loadPersisted();
          Object.assign(reCur, snapshotItem);
          localStorage.setItem(PERSIST_KEY, JSON.stringify(reCur));
        } catch {}
        if (savedBankEntry) {
          try {
            const list = JSON.parse(localStorage.getItem('bank.spawned.v2') || '[]');
            list.push(savedBankEntry);
            localStorage.setItem('bank.spawned.v2', JSON.stringify(list));
          } catch {}
        }
        if (addedToHidden) {
          try {
            const hidden = JSON.parse(localStorage.getItem('hidden.props.v1') || '[]');
            const i = hidden.indexOf(item.label);
            if (i >= 0) hidden.splice(i, 1);
            localStorage.setItem('hidden.props.v1', JSON.stringify(hidden));
          } catch {}
        }
        if (savedExtraEntry) {
          try {
            const list = JSON.parse(localStorage.getItem('extraFrames.v1') || '[]');
            list.push(savedExtraEntry);
            localStorage.setItem('extraFrames.v1', JSON.stringify(list));
          } catch {}
          if (typeof window.__refreshSlidersFrameList === 'function') {
            window.__refreshSlidersFrameList();
          }
        }
        // savedSpeedFrame: nothing extra to write — the parent.add(g)
        // above already puts the original group back in the scene.
      }, null);
    });
    wrap.appendChild(removeBtn);
    const undo = makePanelUndo();
    const sliders = {};
    // `add` appends to whatever `target` is passed (default `wrap`),
    // so the collapsible-section bodies can host their own slider rows.
    function add(key, label, min, max, step, fineStep, onApply, target) {
      const r = buildSliderRow({ state, key, label, min, max, step, fineStep, undoStack: undo, onApply });
      (target || wrap).appendChild(r.row);
      sliders[key] = r;
    }
    // Transform — kept open by default; this is the most-used set.
    const tBody = wrapSection('📐 Transform', '#cfe9ff', true);
    add('x',     'X',          -10, 10, 0.001, 0.001, applyAll, tBody);
    add('y',     'Y',          -10, 10, 0.001, 0.001, applyAll, tBody);
    add('z',     'Z',          -10, 10, 0.001, 0.001, applyAll, tBody);
    add('rotX',  'Rotate X (tilt fwd/back)', -Math.PI, Math.PI, 0.001, 0.001, applyAll, tBody);
    add('rotY',  'Rotate Y (spin)',          -Math.PI, Math.PI, 0.001, 0.001, applyAll, tBody);
    add('rotZ',  'Rotate Z (tilt L/R)',      -Math.PI, Math.PI, 0.001, 0.001, applyAll, tBody);

    // ---- Quick-snap rotation buttons --------------------------------
    // Three rows (Y / X / Z), each with -90°, +90°, and a reset-to-0.
    // Bumps the underlying slider state so the slider readout updates,
    // wraps to keep the value in [-π, π], then applyAll() persists.
    function _wrapAngle(a) {
      // Snap-aware wrap so 90° clicks always land on multiples of π/2.
      while (a > Math.PI + 1e-6) a -= 2 * Math.PI;
      while (a < -Math.PI - 1e-6) a += 2 * Math.PI;
      return a;
    }
    function _bump(axis, delta) {
      state[axis] = _wrapAngle((state[axis] || 0) + delta);
      sliders[axis]?.set(state[axis]);
      applyAll();
    }
    function _reset(axis) {
      state[axis] = 0;
      sliders[axis]?.set(0);
      applyAll();
    }
    const snapWrap = document.createElement('div');
    snapWrap.style.cssText = 'display:flex;flex-direction:column;gap:3px;margin:6px 0 4px 0;padding:6px;border-radius:6px;background:rgba(125,160,255,0.06);border:1px solid rgba(125,160,255,0.18);';
    const snapTitle = document.createElement('div');
    snapTitle.textContent = '⤴ Quick rotate (90° snaps)';
    snapTitle.style.cssText = 'font:11px system-ui;color:#cfe9ff;opacity:0.85;margin-bottom:2px;';
    snapWrap.appendChild(snapTitle);
    function snapRow(label, axis) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:4px;align-items:center;';
      const lbl = document.createElement('span');
      lbl.textContent = label;
      lbl.style.cssText = 'flex:0 0 70px;font:11px system-ui;color:#cfe9ff;';
      row.appendChild(lbl);
      const mkBtn = (txt, fn) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = txt;
        b.style.cssText = 'flex:1;padding:5px 6px;border-radius:5px;border:1px solid rgba(255,255,255,0.15);background:transparent;color:#fff;cursor:pointer;font:11px system-ui;';
        b.addEventListener('click', fn);
        return b;
      };
      row.appendChild(mkBtn('-90°', () => _bump(axis, -Math.PI / 2)));
      row.appendChild(mkBtn('+90°', () => _bump(axis,  Math.PI / 2)));
      row.appendChild(mkBtn('0°',   () => _reset(axis)));
      snapWrap.appendChild(row);
    }
    snapRow('↻ Spin (Y)',    'rotY');
    snapRow('⤵ Tilt fwd (X)', 'rotX');
    snapRow('⤴ Tilt L/R (Z)', 'rotZ');
    tBody.appendChild(snapWrap);

    add('scale', 'Scale',      0.05, 5, 0.001, 0.001, applyAll, tBody);
    // Material — basic 4-slider set.
    const matBody = wrapSection('🌟 Material', '#ffd9a8', false);
    matBody.appendChild(pillInfo('How light catches this object.'));
    add('brightness', 'Brightness', 0, 3,  0.01, 0.005, applyMaterialsAndPersist, matBody);
    add('shininess',  'Shininess',  0, 1,  0.005, 0.001, applyMaterialsAndPersist, matBody);
    add('reflection', 'Reflection', 0, 5,  0.01, 0.005, applyMaterialsAndPersist, matBody);
    add('glow',       'Glow',       0, 5,  0.01, 0.005, applyMaterialsAndPersist, matBody);

    // ---- Advanced material controls ----------------------------------
    const advBody = wrapSection('✨ Advanced material', '#cfe9ff', false);
    advBody.appendChild(pillInfo('Metalness = chrome. Clearcoat = glossy top layer. Transmission + IOR = glass refraction. Iridescence = oil-slick rainbow. Sheen = fabric softness.'));
    function _readPersistedNum(key, fallback) {
      try {
        const v = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}')[`${storeKey}.mat.${key}`];
        return typeof v === 'number' ? v : fallback;
      } catch { return fallback; }
    }
    const adv = {
      metalness:          _readPersistedNum('metalness',         -1),     // -1 = "don't override"
      clearcoat:          _readPersistedNum('clearcoat',          0),
      clearcoatRoughness: _readPersistedNum('clearcoatRoughness', 0.05),
      transmission:       _readPersistedNum('transmission',       0),
      ior:                _readPersistedNum('ior',                1.5),
      iridescence:        _readPersistedNum('iridescence',        0),
      sheen:              _readPersistedNum('sheen',              0),
      specularIntensity:  _readPersistedNum('specularIntensity', -1),     // -1 = don't override
    };
    function _ensurePhysical(mesh) {
      if (!mesh.isMesh || !mesh.material) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const upgraded = mats.map((m) => {
        if (!m || m.isMeshPhysicalMaterial) return m;
        if (!m.isMeshStandardMaterial) return m; // skip Basic / Lambert / Phong
        const np = new THREE.MeshPhysicalMaterial({
          map: m.map, normalMap: m.normalMap, metalnessMap: m.metalnessMap,
          roughnessMap: m.roughnessMap, aoMap: m.aoMap, emissiveMap: m.emissiveMap,
          color: m.color.clone(),
          emissive: m.emissive ? m.emissive.clone() : new THREE.Color(0x000000),
          emissiveIntensity: m.emissiveIntensity || 0,
          metalness: m.metalness, roughness: m.roughness,
          envMapIntensity: m.envMapIntensity || 1,
          transparent: m.transparent, opacity: m.opacity, side: m.side,
        });
        // Carry over the editor's base-snapshot so Brightness/Shininess
        // don't compound after the upgrade.
        if (m.userData && m.userData._editorBaseSnapped) {
          np.userData = { ...m.userData };
        }
        np.needsUpdate = true;
        return np;
      });
      mesh.material = upgraded.length === 1 ? upgraded[0] : upgraded;
    }
    function applyAdvAndPersist() {
      g.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        const anyNonZero = adv.metalness >= 0 || adv.clearcoat > 0 || adv.transmission > 0 ||
          adv.iridescence > 0 || adv.sheen > 0 || adv.specularIntensity >= 0;
        if (anyNonZero) _ensurePhysical(o);
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => {
          if (!m) return;
          if (adv.metalness >= 0 && typeof m.metalness === 'number') m.metalness = adv.metalness;
          if (typeof m.clearcoat === 'number') m.clearcoat = adv.clearcoat;
          if (typeof m.clearcoatRoughness === 'number') m.clearcoatRoughness = adv.clearcoatRoughness;
          if (typeof m.transmission === 'number') m.transmission = adv.transmission;
          if (typeof m.ior === 'number') m.ior = adv.ior;
          if (typeof m.iridescence === 'number') m.iridescence = adv.iridescence;
          if (typeof m.sheen === 'number') m.sheen = adv.sheen;
          if (adv.specularIntensity >= 0 && typeof m.specularIntensity === 'number') m.specularIntensity = adv.specularIntensity;
          // For transmission to render correctly the material needs
          // transparent + thickness. Set sane defaults if user dialed it on.
          if (adv.transmission > 0) {
            m.transparent = true;
            if (typeof m.thickness === 'number' && m.thickness === 0) m.thickness = 0.5;
          }
          m.needsUpdate = true;
        });
      });
      try {
        const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
        for (const k of Object.keys(adv)) cur[`${storeKey}.mat.${k}`] = adv[k];
        localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
      } catch {}
    }
    // Apply once at editor open so persisted values take effect even
    // before the user touches a slider.
    applyAdvAndPersist();
    function addAdv(key, label, min, max, step, fineStep) {
      const r = buildSliderRow({ state: adv, key, label, min, max, step, fineStep, undoStack: undo, onApply: applyAdvAndPersist });
      advBody.appendChild(r.row);
    }
    addAdv('metalness',          'Metalness (-1 = leave alone, 0–1 = override)', -1, 1, 0.01, 0.005);
    addAdv('clearcoat',          'Clearcoat strength',                            0, 1, 0.01, 0.005);
    addAdv('clearcoatRoughness', 'Clearcoat roughness',                           0, 0.6, 0.005, 0.001);
    addAdv('transmission',       'Transmission (glass)',                          0, 1, 0.01, 0.005);
    addAdv('ior',                'IOR (refraction index)',                        1.0, 2.5, 0.01, 0.005);
    addAdv('iridescence',        'Iridescence (rainbow)',                         0, 1, 0.01, 0.005);
    addAdv('sheen',              'Sheen (fabric)',                                0, 1, 0.01, 0.005);
    addAdv('specularIntensity',  'Specular (-1 = leave, 0–1 = override)',         -1, 1, 0.01, 0.005);

    // ---- Mug-specific: Steam style picker ----------------------------
    // Only shown when the selected item is the Gromit mug. Cycles through
    // the procedural blob + 4 Kenney CC0 sprites. Persisted, hot-swaps
    // sprite materials live (no rebuild).
    if (item.label === 'Gromit mug' && Array.isArray(STEAM_STYLES)) {
      const sep2 = document.createElement('div');
      sep2.style.cssText = 'height:1px;background:rgba(255,255,255,0.08);margin:4px 0;';
      wrap.appendChild(sep2);
      wrap.appendChild(pillInfo('💨 Steam style — pick which sprite drives the rising puffs.'));
      const steamBtns = {};
      function paintSteamActive(activeId) {
        Object.entries(steamBtns).forEach(([sid, b]) => {
          const on = sid === activeId;
          b.style.background  = on ? 'rgba(125,255,160,0.16)' : 'transparent';
          b.style.borderColor = on ? 'rgba(125,255,160,0.35)' : 'rgba(255,255,255,0.10)';
        });
      }
      STEAM_STYLES.forEach((s) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = s.label;
        b.style.cssText = 'padding:6px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.10);background:transparent;color:#fff;cursor:pointer;font:11px system-ui;text-align:left;';
        b.addEventListener('click', () => {
          window.__setSteamStyle(s.id);
          paintSteamActive(s.id);
        });
        steamBtns[s.id] = b;
        wrap.appendChild(b);
      });
      // Initial highlight
      let initial = 'smoke_07';
      try {
        const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
        if (typeof cur['mugSteamStyle'] === 'string') initial = cur['mugSteamStyle'];
      } catch {}
      paintSteamActive(initial);

      // ---- Steam tuning: speed / size / opacity ----------------------
      // Each slider mutates STEAM_TUNE directly; the animation loop reads
      // STEAM_TUNE every frame so changes are live. Persisted on each move.
      const sepTune = document.createElement('div');
      sepTune.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepTune);
      const tuneHeader = document.createElement('div');
      tuneHeader.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#cfe9ff;';
      tuneHeader.textContent = '🎚 Tune the puffs';
      wrap.appendChild(tuneHeader);
      wrap.appendChild(pillInfo('Drag to dial speed, size, and dimness. Try 0.18 / 0.55 / 0.28 for small + subtle + dim.'));
      const tuneUndo = makePanelUndo();
      function addTune(key, label, min, max, step, fineStep) {
        const r = buildSliderRow({
          state: STEAM_TUNE, key, label, min, max, step, fineStep,
          undoStack: tuneUndo,
          onApply: _persistSteamTune,
        });
        wrap.appendChild(r.row);
      }
      addTune('speed',   'Steam speed',           0.05, 1.5, 0.005, 0.001);
      addTune('size',    'Steam size',            0.2,  3.0, 0.005, 0.001);
      addTune('opacity', 'Steam opacity',         0.0,  1.0, 0.005, 0.001);
      // Height is a CUTOFF (0..1): particles fade to zero as they approach
      // this fraction of their lifecycle. 1.0 = no cutoff, 0.3 = steam
      // dies off when it's only ~30% of the way up. Particles still
      // travel the full physical column path — only the visibility shrinks.
      addTune('height',  'Steam length (cutoff)', 0.05, 1.0, 0.005, 0.001);
      addTune('width',   'Steam width (swirl)',   0.0,  3.0, 0.005, 0.001);
      // Emitter origin — shifts the whole column relative to the mug.
      addTune('x',       'Steam X',              -0.5, 0.5, 0.001, 0.0005);
      addTune('y',       'Steam Y',              -0.5, 0.5, 0.001, 0.0005);
      addTune('z',       'Steam Z',              -0.5, 0.5, 0.001, 0.0005);

      const resetSteamBtn = document.createElement('button');
      resetSteamBtn.type = 'button';
      resetSteamBtn.textContent = '↺ Reset steam to defaults';
      resetSteamBtn.style.cssText = 'padding:7px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:#fff;cursor:pointer;font-size:11px;margin-top:4px;';
      resetSteamBtn.addEventListener('click', () => {
        STEAM_TUNE.speed = 0.32; STEAM_TUNE.size = 1.0; STEAM_TUNE.opacity = 0.55;
        STEAM_TUNE.height = 1.0; STEAM_TUNE.width = 1.0;
        STEAM_TUNE.x = 0; STEAM_TUNE.y = 0; STEAM_TUNE.z = 0;
        _persistSteamTune();
        // Repaint the editor so the slider thumbs reflect the reset.
        if (typeof window.__onSelectionChange === 'function' && selectedItem) {
          window.__onSelectionChange(selectedItem);
        }
      });
      wrap.appendChild(resetSteamBtn);

      // ---- Matcha disc tunables --------------------------------------
      const sepM = document.createElement('div');
      sepM.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepM);
      const matchaHeader = document.createElement('div');
      matchaHeader.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#cdf0a8;';
      matchaHeader.textContent = '🍵 Matcha disc';
      wrap.appendChild(matchaHeader);
      wrap.appendChild(pillInfo('Nudge the matcha surface inside the mug.'));
      const matchaUndo = makePanelUndo();
      function addMatcha(key, label, min, max, step, fineStep) {
        const r = buildSliderRow({
          state: MATCHA_TUNE, key, label, min, max, step, fineStep,
          undoStack: matchaUndo,
          onApply: _persistMatchaTune,
        });
        wrap.appendChild(r.row);
      }
      addMatcha('x',     'Matcha X',     -0.5, 0.5, 0.001, 0.0005);
      addMatcha('y',     'Matcha Y',     -0.5, 0.5, 0.001, 0.0005);
      addMatcha('z',     'Matcha Z',     -0.5, 0.5, 0.001, 0.0005);
      addMatcha('scale', 'Matcha scale',  0.1,  3.0, 0.005, 0.001);
    }

    // ---- Glass display case toggle (any item) ------------------------
    // Wraps the selected item in a transparent acrylic/glass box so it
    // reads like a museum case (perfect for the Nike Air Mags). Sized
    // automatically from the item's local bbox + a small padding. State
    // is persisted per item under `item.<label>.displayCase`.
    {
      const caseKey = `${storeKey}.displayCase`;
      function findExistingCase() {
        return g.getObjectByName('__display_case');
      }
      function buildDisplayCase() {
        // Compute the inner GLB's bbox in mug-local space — temporarily
        // zero the group transform so setFromObject returns local coords.
        const savedQ = g.quaternion.clone();
        const savedP = g.position.clone();
        const savedS = g.scale.clone();
        g.position.set(0, 0, 0);
        g.quaternion.set(0, 0, 0, 1);
        g.scale.set(1, 1, 1);
        g.updateMatrixWorld(true);
        const bb = new THREE.Box3().setFromObject(g);
        g.position.copy(savedP);
        g.quaternion.copy(savedQ);
        g.scale.copy(savedS);
        g.updateMatrixWorld(true);
        if (!isFinite(bb.min.x) || bb.max.x - bb.min.x < 0.001) return null;
        const size = bb.getSize(new THREE.Vector3());
        const center = bb.getCenter(new THREE.Vector3());
        const pad = 0.04;
        const w = size.x + pad * 2;
        const h = size.y + pad * 2;
        const d = size.z + pad * 2;
        const geo = new THREE.BoxGeometry(w, h, d);
        const mat = new THREE.MeshPhysicalMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.10,
          roughness: 0.04,
          metalness: 0.0,
          transmission: 0.9,
          ior: 1.5,
          thickness: 0.5,
          envMapIntensity: 1.0,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const m = new THREE.Mesh(geo, mat);
        m.name = '__display_case';
        m.position.copy(center);
        // Rest the case bottom on the item's bottom (no padding below).
        m.position.y = center.y;
        // Subtle wireframe edges for that "museum vitrine" feel.
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(geo),
          new THREE.LineBasicMaterial({
            color: 0xa6c8ff, transparent: true, opacity: 0.35,
          }),
        );
        edges.name = '__display_case_edges';
        m.add(edges);
        g.add(m);
        return m;
      }
      function setDisplayCase(on) {
        const existing = findExistingCase();
        if (on && !existing) buildDisplayCase();
        if (!on && existing) {
          existing.parent?.remove(existing);
          // Dispose
          existing.geometry?.dispose();
          if (existing.material) {
            (Array.isArray(existing.material) ? existing.material : [existing.material]).forEach((m) => m.dispose());
          }
        }
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          if (on) cur[caseKey] = true;
          else delete cur[caseKey];
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
      }
      // Honor persisted state on editor open: if `item.<label>.displayCase`
      // is true and there's no case yet, build one.
      const persistedOn = !!(PERSISTED && PERSISTED[caseKey]);
      if (persistedOn && !findExistingCase()) buildDisplayCase();

      const sepDC = document.createElement('div');
      sepDC.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepDC);
      const dcBtn = document.createElement('button');
      dcBtn.type = 'button';
      function paintDc() {
        const has = !!findExistingCase();
        dcBtn.textContent = has ? '🟦 Glass case: ON' : '⬜ Glass case: OFF';
        dcBtn.style.cssText = `padding:7px;border-radius:6px;border:1px solid ${has ? 'rgba(150,200,255,0.55)' : 'rgba(255,255,255,0.18)'};background:${has ? 'rgba(150,200,255,0.15)' : 'transparent'};color:#fff;cursor:pointer;font-size:11px;font-weight:600;`;
      }
      paintDc();
      dcBtn.addEventListener('click', () => {
        setDisplayCase(!findExistingCase());
        paintDc();
      });
      wrap.appendChild(dcBtn);
    }

    // ---- Art-frame-specific: dimension sliders -----------------------
    if ((item.label === 'Art frame' || item.label === 'Speed frame') && window.__artFrameDims) {
      const sepF = document.createElement('div');
      sepF.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepF);
      const fHeader = document.createElement('div');
      fHeader.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#f0e6d2;';
      fHeader.textContent = '🖼 Frame dimensions';
      wrap.appendChild(fHeader);
      wrap.appendChild(pillInfo('Width / height of the canvas + border thickness + frame depth.'));
      const FRAME = window.__artFrameDims;
      const frameUndo = makePanelUndo();
      function _persistFrame() {
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur['artFrame.w']      = FRAME.w;
          cur['artFrame.h']      = FRAME.h;
          cur['artFrame.border'] = FRAME.border;
          cur['artFrame.depth']  = FRAME.depth;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
        if (typeof window.__rebuildArtFrame === 'function') window.__rebuildArtFrame();
      }
      function addF(key, label, min, max) {
        const r = buildSliderRow({
          state: FRAME, key, label, min, max,
          step: 0.001, fineStep: 0.0005,
          undoStack: frameUndo, onApply: _persistFrame,
        });
        wrap.appendChild(r.row);
      }
      addF('w',      'Frame width',    0.05, 2.5);
      addF('h',      'Frame height',   0.05, 2.5);
      addF('border', 'Border thickness', 0.005, 0.10);
      addF('depth',  'Frame depth',    0.005, 0.10);
    }

    // ---- Nike-specific: lock-with-glass-case toggle ------------------
    if (/nike|air ?mag/i.test(item.label || '')) {
      const sepN = document.createElement('div');
      sepN.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepN);
      const nHeader = document.createElement('div');
      nHeader.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#cfe9ff;';
      nHeader.textContent = '🪟 Glass case lock';
      wrap.appendChild(nHeader);
      wrap.appendChild(pillInfo('On: Nike becomes a child of the case — moving the case carries the Nike (and vice-versa via the case\'s gizmo). Off: nudge each independently.'));
      const lockBtn = document.createElement('button');
      lockBtn.type = 'button';
      function paintLock() {
        const caseSel = SELECTABLE.find((s) => s.label === 'Display case');
        const locked = !!(caseSel?.group && item.group.parent === caseSel.group);
        lockBtn.textContent = locked ? '🔒 Locked with Glass case' : '🔓 Lock position with Glass case';
        lockBtn.style.cssText = `padding:8px;border-radius:6px;border:1px solid ${locked ? 'rgba(255,200,80,0.55)' : 'rgba(125,160,255,0.55)'};background:${locked ? 'rgba(255,200,80,0.18)' : 'rgba(125,160,255,0.12)'};color:#fff;cursor:pointer;font-size:11px;font-weight:600;width:100%;`;
      }
      paintLock();
      lockBtn.addEventListener('click', () => {
        const caseSel = SELECTABLE.find((s) => s.label === 'Display case');
        if (!caseSel?.group) {
          alert('No Display case found in the scene.');
          return;
        }
        // Snapshot pre-toggle state so Cmd+Z reverts BOTH the parent AND
        // the local-position values together. Without this, the global
        // undo stack remembers the pre-toggle position numbers and re-
        // applies them in the new (re-parented) frame — which puts the
        // Nike at case-local (1.45, 1.40, 1.04), well off-screen.
        const oldParent = item.group.parent;
        const oldPos = item.group.position.clone();
        const oldQuat = item.group.quaternion.clone();
        const oldPersistedSnapshot = (() => {
          try { return JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}'); }
          catch { return {}; }
        })();
        if (typeof pushGlobalUndo === 'function') {
          pushGlobalUndo((s) => {
            // Re-parent without touching world transform (raw add), then
            // overwrite with the pre-toggle local + rotation values.
            if (s.parent && s.parent !== item.group.parent) s.parent.add(item.group);
            item.group.position.copy(s.pos);
            item.group.quaternion.copy(s.quat);
            // Restore the pre-toggle persisted state for this label.
            try {
              localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(s.persisted));
            } catch {}
            if (typeof registerShelfMembers === 'function') {
              registerShelfMembers();
              applyShelfSpacing(loadShelfOffsets());
            }
            paintLock();
            if (selectedItem?.group === item.group) refreshHud();
          }, { parent: oldParent, pos: oldPos, quat: oldQuat, persisted: oldPersistedSnapshot });
        }
        const locked = item.group.parent === caseSel.group;
        if (locked) {
          // Detach JUST this Nike (not all of them) and re-parent under
          // the bookshelf so it stays on shelf B.
          const bg = propGroups.bookshelf?.group;
          if (bg) bg.attach(item.group); // preserves world position
          try {
            const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
            const sk = `item.${item.label.replace(/\s+/g, '_')}`;
            cur[`${sk}.x`] = item.group.position.x;
            cur[`${sk}.y`] = item.group.position.y;
            cur[`${sk}.z`] = item.group.position.z;
            let parents = cur['shelfSpacing.parents'] || {};
            parents[item.label] = 'bookshelf';
            cur['shelfSpacing.parents'] = parents;
            let assignments = cur['shelfSpacing.assignments'] || {};
            assignments[item.label] = 'B';
            cur['shelfSpacing.assignments'] = assignments;
            localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
          } catch {}
          if (typeof registerShelfMembers === 'function') {
            registerShelfMembers();
            applyShelfSpacing(loadShelfOffsets());
          }
        } else {
          // Lock: attach this Nike to the case (preserves world position).
          caseSel.group.attach(item.group);
          try {
            const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
            const sk = `item.${item.label.replace(/\s+/g, '_')}`;
            cur[`${sk}.x`] = item.group.position.x;
            cur[`${sk}.y`] = item.group.position.y;
            cur[`${sk}.z`] = item.group.position.z;
            let parents = cur['shelfSpacing.parents'] || {};
            parents[item.label] = 'Display case';
            cur['shelfSpacing.parents'] = parents;
            // Drop the Nike's own shelf assignment — case carries it now.
            let assignments = cur['shelfSpacing.assignments'] || {};
            delete assignments[item.label];
            cur['shelfSpacing.assignments'] = assignments;
            localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
          } catch {}
          if (typeof registerShelfMembers === 'function') {
            registerShelfMembers();
            applyShelfSpacing(loadShelfOffsets());
          }
        }
        paintLock();
      });
      wrap.appendChild(lockBtn);
    }

    // ---- Display-case-specific: Nike merge/separate toggle -----------
    if (item.label === 'Display case') {
      const sepM = document.createElement('div');
      sepM.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepM);
      const mHeader = document.createElement('div');
      mHeader.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffd9a6;';
      mHeader.textContent = '👟 Nike Air Mag';
      wrap.appendChild(mHeader);
      wrap.appendChild(pillInfo('Merge: Nike(s) become children of the case — drag the case and they ride along. Separate: nudge each independently.'));
      const mergeBtn = document.createElement('button');
      mergeBtn.type = 'button';
      function paintMerge() {
        const caseG = item.group;
        const merged = SELECTABLE.some((s) => /nike|air ?mag/i.test(s.label || '') && s.group?.parent === caseG);
        mergeBtn.textContent = merged ? '🔓 Separate Nike from case' : '🔗 Merge Nike with case';
        mergeBtn.style.cssText = `padding:8px;border-radius:6px;border:1px solid ${merged ? 'rgba(255,200,80,0.55)' : 'rgba(125,160,255,0.55)'};background:${merged ? 'rgba(255,200,80,0.15)' : 'rgba(125,160,255,0.15)'};color:#fff;cursor:pointer;font-size:11px;font-weight:600;width:100%;`;
      }
      paintMerge();
      mergeBtn.addEventListener('click', () => {
        const caseG = item.group;
        const merged = SELECTABLE.some((s) => /nike|air ?mag/i.test(s.label || '') && s.group?.parent === caseG);
        if (merged) {
          window.__unpairNikeFromCase?.();
        } else {
          window.__pairNikeUnderCase?.();
        }
        paintMerge();
      });
      wrap.appendChild(mergeBtn);
    }

    // ---- Lightsaber-case-specific: dimensions + post controls --------
    if (item.label === 'Lightsaber case' && typeof LIGHTSABER_CASE_DIMS !== 'undefined') {
      const sepLC = document.createElement('div');
      sepLC.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepLC);
      const lcHeader = document.createElement('div');
      lcHeader.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#cfe9ff;';
      lcHeader.textContent = '⚔ Saber case dimensions';
      wrap.appendChild(lcHeader);
      wrap.appendChild(pillInfo('Long horizontal vitrine. Wood base, glass shell, two chrome posts that cradle the saber. Adjust width / depth / glass height + post spacing & height.'));
      const lcUndo = makePanelUndo();
      function _persistLC() {
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          for (const k of ['width','depth','base','glass','postSpacing','postHeight','postRadius']) {
            cur[`saberCase.${k}`] = LIGHTSABER_CASE_DIMS[k];
          }
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
        if (typeof window.__rebuildSaberCase === 'function') window.__rebuildSaberCase();
      }
      function addLC(key, label, min, max) {
        const r = buildSliderRow({
          state: LIGHTSABER_CASE_DIMS, key, label, min, max,
          step: 0.001, fineStep: 0.0005,
          undoStack: lcUndo, onApply: _persistLC,
        });
        wrap.appendChild(r.row);
      }
      addLC('width',       'Width (X — saber length)',  0.30, 2.5);
      addLC('depth',       'Depth (Z)',                 0.10, 1.0);
      addLC('glass',       'Glass height (Y)',          0.05, 1.0);
      addLC('base',        'Base height',               0.005, 0.10);
      addLC('postSpacing', 'Post spacing (between cradles)', 0.05, 1.5);
      addLC('postHeight',  'Post height (cradle lift)', 0.01, 0.30);
      addLC('postRadius',  'Cradle thickness (post radius)', 0.003, 0.05);
      // Glass material sliders — same set as the Display case.
      const sepLG = document.createElement('div');
      sepLG.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepLG);
      const lgHeader = document.createElement('div');
      lgHeader.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#cfe9ff;';
      lgHeader.textContent = '✨ Glass material';
      wrap.appendChild(lgHeader);
      const glassMatRef = window.__saberCaseGlassMat;
      const lgState = {
        opacity:      glassMatRef?.opacity ?? 0.55,
        transmission: glassMatRef?.transmission ?? 0.40,
        roughness:    glassMatRef?.roughness ?? 0.04,
        envMap:       glassMatRef?.envMapIntensity ?? 1.4,
        thickness:    glassMatRef?.thickness ?? 0.05,
        ior:          glassMatRef?.ior ?? 1.5,
        tintR:        glassMatRef?.color?.r ?? 0.87,
        tintG:        glassMatRef?.color?.g ?? 0.93,
        tintB:        glassMatRef?.color?.b ?? 1.0,
      };
      function _applyLG() {
        if (!glassMatRef) return;
        glassMatRef.opacity = lgState.opacity;
        glassMatRef.transmission = lgState.transmission;
        glassMatRef.roughness = lgState.roughness;
        glassMatRef.envMapIntensity = lgState.envMap;
        glassMatRef.thickness = lgState.thickness;
        glassMatRef.ior = lgState.ior;
        glassMatRef.color.setRGB(lgState.tintR, lgState.tintG, lgState.tintB);
        glassMatRef.needsUpdate = true;
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur['saberCaseGlass.opacity']      = lgState.opacity;
          cur['saberCaseGlass.transmission'] = lgState.transmission;
          cur['saberCaseGlass.roughness']    = lgState.roughness;
          cur['saberCaseGlass.envMap']       = lgState.envMap;
          cur['saberCaseGlass.thickness']    = lgState.thickness;
          cur['saberCaseGlass.ior']          = lgState.ior;
          cur['saberCaseGlass.tintR']        = lgState.tintR;
          cur['saberCaseGlass.tintG']        = lgState.tintG;
          cur['saberCaseGlass.tintB']        = lgState.tintB;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
      }
      const lgUndo = makePanelUndo();
      function addLG(key, lbl, min, max) {
        const r = buildSliderRow({ state: lgState, key, label: lbl, min, max, step: 0.005, fineStep: 0.001, undoStack: lgUndo, onApply: _applyLG });
        wrap.appendChild(r.row);
      }
      addLG('opacity',      'Glass opacity',      0, 1);
      addLG('transmission', 'Transmission',       0, 1);
      addLG('roughness',    'Glass roughness (high → frosted)', 0, 0.5);
      addLG('envMap',       'Glass reflection',   0, 8);
      addLG('thickness',    'Glass thickness',    0, 1);
      addLG('ior',          'IOR (refraction)',   1.0, 2.5);
      addLG('tintR',        'Tint R',             0, 1);
      addLG('tintG',        'Tint G',             0, 1);
      addLG('tintB',        'Tint B',             0, 1);
      // ---- Interior light section ------------------------------------
      const sepIL = document.createElement('div');
      sepIL.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepIL);
      const ilHeader = document.createElement('div');
      ilHeader.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffd9a8;';
      ilHeader.textContent = '💡 Interior light';
      wrap.appendChild(ilHeader);
      wrap.appendChild(pillInfo('Soft warm point light inside the case — picks up the glass + the chrome posts. Default off (intensity = 0). Crank it for a museum-night-light look.'));
      const lightRef = window.__saberCaseLight;
      const ilState = {
        intensity: lightRef?.intensity ?? 0,
        distance:  lightRef?.distance  ?? 0.8,
        tintR:     lightRef?.color?.r  ?? 1.0,
        tintG:     lightRef?.color?.g  ?? 0.85,
        tintB:     lightRef?.color?.b  ?? 0.66,
      };
      function _applyIL() {
        if (!lightRef) return;
        lightRef.intensity = ilState.intensity;
        lightRef.distance  = ilState.distance;
        lightRef.color.setRGB(ilState.tintR, ilState.tintG, ilState.tintB);
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur['saberCaseLight.intensity'] = ilState.intensity;
          cur['saberCaseLight.distance']  = ilState.distance;
          cur['saberCaseLight.tintR']     = ilState.tintR;
          cur['saberCaseLight.tintG']     = ilState.tintG;
          cur['saberCaseLight.tintB']     = ilState.tintB;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
      }
      const ilUndo = makePanelUndo();
      function addIL(key, lbl, min, max) {
        const r = buildSliderRow({ state: ilState, key, label: lbl, min, max, step: 0.005, fineStep: 0.001, undoStack: ilUndo, onApply: _applyIL });
        wrap.appendChild(r.row);
      }
      addIL('intensity', 'Light intensity', 0, 6);
      addIL('distance',  'Light distance (falloff)', 0.05, 3);
      addIL('tintR',     'Light tint R',     0, 1);
      addIL('tintG',     'Light tint G',     0, 1);
      addIL('tintB',     'Light tint B',     0, 1);
    }

    // ---- Ogre-case-specific: dimensions + glass + corner-light ------
    if (item.label === 'Ogre case' && typeof OGRE_CASE_DIMS !== 'undefined') {
      const sepOC = document.createElement('div');
      sepOC.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepOC);
      const ocHeader = document.createElement('div');
      ocHeader.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffd9a8;';
      ocHeader.textContent = '🐲 Ogre case dimensions';
      wrap.appendChild(ocHeader);
      wrap.appendChild(pillInfo('Square glass vitrine with a warm-walnut wood base. Adjust width / depth / glass height + base thickness.'));
      const ocUndo = makePanelUndo();
      function _persistOC() {
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          for (const k of ['width','depth','base','glass']) {
            cur[`ogreCase.${k}`] = OGRE_CASE_DIMS[k];
          }
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
        if (typeof window.__rebuildOgreCase === 'function') window.__rebuildOgreCase();
      }
      function addOC(key, label, min, max) {
        const r = buildSliderRow({
          state: OGRE_CASE_DIMS, key, label, min, max,
          step: 0.001, fineStep: 0.0005,
          undoStack: ocUndo, onApply: _persistOC,
        });
        wrap.appendChild(r.row);
      }
      addOC('width',  'Width (X)',         0.10, 1.5);
      addOC('depth',  'Depth (Z)',         0.10, 1.5);
      addOC('glass',  'Glass height (Y)',  0.10, 2.0);
      addOC('base',   'Base height (wood)', 0.005, 0.20);

      // ---- Glass material section ----------------------------------
      const sepOG = document.createElement('div');
      sepOG.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepOG);
      const ogHeader = document.createElement('div');
      ogHeader.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#cfe9ff;';
      ogHeader.textContent = '✨ Glass material';
      wrap.appendChild(ogHeader);
      const ocGlass = window.__ogreCaseGlassMat;
      const ogState = {
        opacity:      ocGlass?.opacity ?? 1.0,
        transmission: ocGlass?.transmission ?? 0.95,
        roughness:    ocGlass?.roughness ?? 0.02,
        envMap:       ocGlass?.envMapIntensity ?? 1.5,
        thickness:    ocGlass?.thickness ?? 0.30,
        ior:          ocGlass?.ior ?? 1.52,
        tintR:        ocGlass?.color?.r ?? 1.0,
        tintG:        ocGlass?.color?.g ?? 1.0,
        tintB:        ocGlass?.color?.b ?? 1.0,
      };
      function _applyOG() {
        if (!ocGlass) return;
        ocGlass.opacity = ogState.opacity;
        ocGlass.transmission = ogState.transmission;
        ocGlass.roughness = ogState.roughness;
        ocGlass.envMapIntensity = ogState.envMap;
        ocGlass.thickness = ogState.thickness;
        ocGlass.ior = ogState.ior;
        ocGlass.color.setRGB(ogState.tintR, ogState.tintG, ogState.tintB);
        ocGlass.needsUpdate = true;
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur['ogreCaseGlass.opacity']      = ogState.opacity;
          cur['ogreCaseGlass.transmission'] = ogState.transmission;
          cur['ogreCaseGlass.roughness']    = ogState.roughness;
          cur['ogreCaseGlass.envMap']       = ogState.envMap;
          cur['ogreCaseGlass.thickness']    = ogState.thickness;
          cur['ogreCaseGlass.ior']          = ogState.ior;
          cur['ogreCaseGlass.tintR']        = ogState.tintR;
          cur['ogreCaseGlass.tintG']        = ogState.tintG;
          cur['ogreCaseGlass.tintB']        = ogState.tintB;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
      }
      const ogUndo = makePanelUndo();
      function addOG(key, lbl, min, max) {
        const r = buildSliderRow({ state: ogState, key, label: lbl, min, max, step: 0.005, fineStep: 0.001, undoStack: ogUndo, onApply: _applyOG });
        wrap.appendChild(r.row);
      }
      addOG('opacity',      'Glass opacity',      0, 1);
      addOG('transmission', 'Transmission',       0, 1);
      addOG('roughness',    'Glass roughness (high → frosted)', 0, 0.5);
      addOG('envMap',       'Glass reflection',   0, 8);
      addOG('thickness',    'Glass thickness',    0, 1);
      addOG('ior',          'IOR (refraction)',   1.0, 2.5);
      addOG('tintR',        'Tint R',             0, 1);
      addOG('tintG',        'Tint G',             0, 1);
      addOG('tintB',        'Tint B',             0, 1);

      // ---- Corner spotlight section --------------------------------
      const sepOL = document.createElement('div');
      sepOL.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepOL);
      const olHeader = document.createElement('div');
      olHeader.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffd9a8;';
      olHeader.textContent = '💡 Corner spotlight';
      wrap.appendChild(olHeader);
      wrap.appendChild(pillInfo('Tiny warm spot mounted at one top corner of the glass shell, aimed at the case interior. Pick the corner, dial intensity / range / color.'));
      // Corner picker
      const cornerRow = document.createElement('div');
      cornerRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';
      const CORNERS = [
        { idx: 0, name: 'Front-Right' },
        { idx: 1, name: 'Front-Left'  },
        { idx: 2, name: 'Back-Right'  },
        { idx: 3, name: 'Back-Left'   },
      ];
      const cornerBtns = [];
      function paintCorner() {
        const cur = (typeof window.__getOgreCaseLightCorner === 'function') ? window.__getOgreCaseLightCorner() : 0;
        cornerBtns.forEach(({ btn, idx }) => {
          const on = idx === cur;
          btn.style.cssText = `flex:1 1 45%;padding:5px 8px;border-radius:6px;border:1px solid ${on ? 'rgba(255,200,80,0.65)' : 'rgba(255,255,255,0.15)'};background:${on ? 'rgba(255,200,80,0.18)' : 'transparent'};color:#fff;cursor:pointer;font:11px system-ui;`;
        });
      }
      for (const c of CORNERS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = c.name;
        b.addEventListener('click', () => {
          if (typeof window.__setOgreCaseLightCorner === 'function') {
            window.__setOgreCaseLightCorner(c.idx);
            paintCorner();
          }
        });
        cornerRow.appendChild(b);
        cornerBtns.push({ btn: b, idx: c.idx });
      }
      wrap.appendChild(cornerRow);
      paintCorner();

      const ocLight = window.__ogreCaseLight;
      const olState = {
        intensity: ocLight?.intensity ?? 1.4,
        distance:  ocLight?.distance  ?? 1.2,
        tintR:     ocLight?.color?.r  ?? 1.0,
        tintG:     ocLight?.color?.g  ?? 0.94,
        tintB:     ocLight?.color?.b  ?? 0.82,
      };
      function _applyOL() {
        if (!ocLight) return;
        ocLight.intensity = olState.intensity;
        ocLight.distance  = olState.distance;
        ocLight.color.setRGB(olState.tintR, olState.tintG, olState.tintB);
        const bead = window.__ogreCaseLightBead;
        if (bead?.material) {
          bead.material.color.setRGB(olState.tintR, olState.tintG, olState.tintB);
          bead.material.emissive.setRGB(olState.tintR, olState.tintG, olState.tintB);
        }
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur['ogreCaseLight.intensity'] = olState.intensity;
          cur['ogreCaseLight.distance']  = olState.distance;
          cur['ogreCaseLight.tintR']     = olState.tintR;
          cur['ogreCaseLight.tintG']     = olState.tintG;
          cur['ogreCaseLight.tintB']     = olState.tintB;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
      }
      const olUndo = makePanelUndo();
      function addOL(key, lbl, min, max) {
        const r = buildSliderRow({ state: olState, key, label: lbl, min, max, step: 0.005, fineStep: 0.001, undoStack: olUndo, onApply: _applyOL });
        wrap.appendChild(r.row);
      }
      addOL('intensity', 'Light intensity', 0, 8);
      addOL('distance',  'Light range (falloff)', 0.1, 3);
      addOL('tintR',     'Light tint R', 0, 1);
      addOL('tintG',     'Light tint G', 0, 1);
      addOL('tintB',     'Light tint B', 0, 1);
    }

    // ---- Stitch-case-specific: dims + glass + corner-light -----------
    // Twin of the Ogre case editor. Drives STITCH_CASE_DIMS / window.__stitchCase*.
    if (item.label === 'Stitch case' && typeof STITCH_CASE_DIMS !== 'undefined') {
      const sepSC = document.createElement('div');
      sepSC.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepSC);
      const scHeader = document.createElement('div');
      scHeader.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffd9a8;';
      scHeader.textContent = '👽 Stitch case dimensions';
      wrap.appendChild(scHeader);
      wrap.appendChild(pillInfo('Square glass vitrine with a warm-walnut wood base. Adjust width / depth / glass height + base thickness.'));
      const scUndo = makePanelUndo();
      function _persistSC() {
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          for (const k of ['width','depth','base','glass']) {
            cur[`stitchCase.${k}`] = STITCH_CASE_DIMS[k];
          }
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
        if (typeof window.__rebuildStitchCase === 'function') window.__rebuildStitchCase();
      }
      function addSC(key, label, min, max) {
        const r = buildSliderRow({
          state: STITCH_CASE_DIMS, key, label, min, max,
          step: 0.001, fineStep: 0.0005,
          undoStack: scUndo, onApply: _persistSC,
        });
        wrap.appendChild(r.row);
      }
      addSC('width',  'Width (X)',         0.10, 1.5);
      addSC('depth',  'Depth (Z)',         0.10, 1.5);
      addSC('glass',  'Glass height (Y)',  0.10, 2.0);
      addSC('base',   'Base height (wood)', 0.005, 0.20);

      const sepSG = document.createElement('div');
      sepSG.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepSG);
      const sgHeader = document.createElement('div');
      sgHeader.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#cfe9ff;';
      sgHeader.textContent = '✨ Glass material';
      wrap.appendChild(sgHeader);
      const scGlass = window.__stitchCaseGlassMat;
      const sgState = {
        opacity:      scGlass?.opacity ?? 1.0,
        transmission: scGlass?.transmission ?? 0.95,
        roughness:    scGlass?.roughness ?? 0.02,
        envMap:       scGlass?.envMapIntensity ?? 1.5,
        thickness:    scGlass?.thickness ?? 0.30,
        ior:          scGlass?.ior ?? 1.52,
        tintR:        scGlass?.color?.r ?? 1.0,
        tintG:        scGlass?.color?.g ?? 1.0,
        tintB:        scGlass?.color?.b ?? 1.0,
      };
      function _applySG() {
        if (!scGlass) return;
        scGlass.opacity = sgState.opacity;
        scGlass.transmission = sgState.transmission;
        scGlass.roughness = sgState.roughness;
        scGlass.envMapIntensity = sgState.envMap;
        scGlass.thickness = sgState.thickness;
        scGlass.ior = sgState.ior;
        scGlass.color.setRGB(sgState.tintR, sgState.tintG, sgState.tintB);
        scGlass.needsUpdate = true;
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur['stitchCaseGlass.opacity']      = sgState.opacity;
          cur['stitchCaseGlass.transmission'] = sgState.transmission;
          cur['stitchCaseGlass.roughness']    = sgState.roughness;
          cur['stitchCaseGlass.envMap']       = sgState.envMap;
          cur['stitchCaseGlass.thickness']    = sgState.thickness;
          cur['stitchCaseGlass.ior']          = sgState.ior;
          cur['stitchCaseGlass.tintR']        = sgState.tintR;
          cur['stitchCaseGlass.tintG']        = sgState.tintG;
          cur['stitchCaseGlass.tintB']        = sgState.tintB;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
      }
      const sgUndo = makePanelUndo();
      function addSG(key, lbl, min, max) {
        const r = buildSliderRow({ state: sgState, key, label: lbl, min, max, step: 0.005, fineStep: 0.001, undoStack: sgUndo, onApply: _applySG });
        wrap.appendChild(r.row);
      }
      addSG('opacity',      'Glass opacity',      0, 1);
      addSG('transmission', 'Transmission',       0, 1);
      addSG('roughness',    'Glass roughness (high → frosted)', 0, 0.5);
      addSG('envMap',       'Glass reflection',   0, 8);
      addSG('thickness',    'Glass thickness',    0, 1);
      addSG('ior',          'IOR (refraction)',   1.0, 2.5);
      addSG('tintR',        'Tint R',             0, 1);
      addSG('tintG',        'Tint G',             0, 1);
      addSG('tintB',        'Tint B',             0, 1);

      const sepSL = document.createElement('div');
      sepSL.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepSL);
      const slHeader = document.createElement('div');
      slHeader.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffd9a8;';
      slHeader.textContent = '💡 Corner spotlight';
      wrap.appendChild(slHeader);
      wrap.appendChild(pillInfo('Tiny warm spot mounted at one top corner of the glass shell, aimed at the case interior. Pick the corner, dial intensity / range / color.'));
      const cornerRow = document.createElement('div');
      cornerRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';
      const CORNERS = [
        { idx: 0, name: 'Front-Right' },
        { idx: 1, name: 'Front-Left'  },
        { idx: 2, name: 'Back-Right'  },
        { idx: 3, name: 'Back-Left'   },
      ];
      const cornerBtns = [];
      function paintCornerS() {
        const cur = (typeof window.__getStitchCaseLightCorner === 'function') ? window.__getStitchCaseLightCorner() : 0;
        cornerBtns.forEach(({ btn, idx }) => {
          const on = idx === cur;
          btn.style.cssText = `flex:1 1 45%;padding:5px 8px;border-radius:6px;border:1px solid ${on ? 'rgba(255,200,80,0.65)' : 'rgba(255,255,255,0.15)'};background:${on ? 'rgba(255,200,80,0.18)' : 'transparent'};color:#fff;cursor:pointer;font:11px system-ui;`;
        });
      }
      for (const c of CORNERS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = c.name;
        b.addEventListener('click', () => {
          if (typeof window.__setStitchCaseLightCorner === 'function') {
            window.__setStitchCaseLightCorner(c.idx);
            paintCornerS();
          }
        });
        cornerRow.appendChild(b);
        cornerBtns.push({ btn: b, idx: c.idx });
      }
      wrap.appendChild(cornerRow);
      paintCornerS();

      const scLight = window.__stitchCaseLight;
      const slState = {
        intensity: scLight?.intensity ?? 1.4,
        distance:  scLight?.distance  ?? 1.2,
        tintR:     scLight?.color?.r  ?? 1.0,
        tintG:     scLight?.color?.g  ?? 0.94,
        tintB:     scLight?.color?.b  ?? 0.82,
      };
      function _applySL() {
        if (!scLight) return;
        scLight.intensity = slState.intensity;
        scLight.distance  = slState.distance;
        scLight.color.setRGB(slState.tintR, slState.tintG, slState.tintB);
        const bead = window.__stitchCaseLightBead;
        if (bead?.material) {
          bead.material.color.setRGB(slState.tintR, slState.tintG, slState.tintB);
          bead.material.emissive.setRGB(slState.tintR, slState.tintG, slState.tintB);
        }
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur['stitchCaseLight.intensity'] = slState.intensity;
          cur['stitchCaseLight.distance']  = slState.distance;
          cur['stitchCaseLight.tintR']     = slState.tintR;
          cur['stitchCaseLight.tintG']     = slState.tintG;
          cur['stitchCaseLight.tintB']     = slState.tintB;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
      }
      const slUndo = makePanelUndo();
      function addSL(key, lbl, min, max) {
        const r = buildSliderRow({ state: slState, key, label: lbl, min, max, step: 0.005, fineStep: 0.001, undoStack: slUndo, onApply: _applySL });
        wrap.appendChild(r.row);
      }
      addSL('intensity', 'Light intensity', 0, 8);
      addSL('distance',  'Light range (falloff)', 0.1, 3);
      addSL('tintR',     'Light tint R', 0, 1);
      addSL('tintG',     'Light tint G', 0, 1);
      addSL('tintB',     'Light tint B', 0, 1);
    }

    // ---- Scream-canister-case-specific: dims + glass + corner-light --
    if (item.label === 'Scream case' && typeof SCREAM_CASE_DIMS !== 'undefined') {
      const sepRC = document.createElement('div');
      sepRC.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepRC);
      const rcHeader = document.createElement('div');
      rcHeader.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffd9a8;';
      rcHeader.textContent = '😱 Scream case dimensions';
      wrap.appendChild(rcHeader);
      wrap.appendChild(pillInfo('Square glass vitrine with a warm-walnut wood base. Adjust width / depth / glass height + base thickness.'));
      const rcUndo = makePanelUndo();
      function _persistRC() {
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          for (const k of ['width','depth','base','glass']) {
            cur[`screamCase.${k}`] = SCREAM_CASE_DIMS[k];
          }
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
        if (typeof window.__rebuildScreamCase === 'function') window.__rebuildScreamCase();
      }
      function addRC(key, label, min, max) {
        const r = buildSliderRow({
          state: SCREAM_CASE_DIMS, key, label, min, max,
          step: 0.001, fineStep: 0.0005,
          undoStack: rcUndo, onApply: _persistRC,
        });
        wrap.appendChild(r.row);
      }
      addRC('width',  'Width (X)',         0.10, 1.5);
      addRC('depth',  'Depth (Z)',         0.10, 1.5);
      addRC('glass',  'Glass height (Y)',  0.10, 2.0);
      addRC('base',   'Base height (wood)', 0.005, 0.20);

      const sepRG = document.createElement('div');
      sepRG.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepRG);
      const rgHeader = document.createElement('div');
      rgHeader.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#cfe9ff;';
      rgHeader.textContent = '✨ Glass material';
      wrap.appendChild(rgHeader);
      const rcGlass = window.__screamCaseGlassMat;
      const rgState = {
        opacity:      rcGlass?.opacity ?? 1.0,
        transmission: rcGlass?.transmission ?? 0.95,
        roughness:    rcGlass?.roughness ?? 0.02,
        envMap:       rcGlass?.envMapIntensity ?? 1.5,
        thickness:    rcGlass?.thickness ?? 0.30,
        ior:          rcGlass?.ior ?? 1.52,
        tintR:        rcGlass?.color?.r ?? 1.0,
        tintG:        rcGlass?.color?.g ?? 1.0,
        tintB:        rcGlass?.color?.b ?? 1.0,
      };
      function _applyRG() {
        if (!rcGlass) return;
        rcGlass.opacity = rgState.opacity;
        rcGlass.transmission = rgState.transmission;
        rcGlass.roughness = rgState.roughness;
        rcGlass.envMapIntensity = rgState.envMap;
        rcGlass.thickness = rgState.thickness;
        rcGlass.ior = rgState.ior;
        rcGlass.color.setRGB(rgState.tintR, rgState.tintG, rgState.tintB);
        rcGlass.needsUpdate = true;
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur['screamCaseGlass.opacity']      = rgState.opacity;
          cur['screamCaseGlass.transmission'] = rgState.transmission;
          cur['screamCaseGlass.roughness']    = rgState.roughness;
          cur['screamCaseGlass.envMap']       = rgState.envMap;
          cur['screamCaseGlass.thickness']    = rgState.thickness;
          cur['screamCaseGlass.ior']          = rgState.ior;
          cur['screamCaseGlass.tintR']        = rgState.tintR;
          cur['screamCaseGlass.tintG']        = rgState.tintG;
          cur['screamCaseGlass.tintB']        = rgState.tintB;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
      }
      const rgUndo = makePanelUndo();
      function addRG(key, lbl, min, max) {
        const r = buildSliderRow({ state: rgState, key, label: lbl, min, max, step: 0.005, fineStep: 0.001, undoStack: rgUndo, onApply: _applyRG });
        wrap.appendChild(r.row);
      }
      addRG('opacity',      'Glass opacity',      0, 1);
      addRG('transmission', 'Transmission',       0, 1);
      addRG('roughness',    'Glass roughness (high → frosted)', 0, 0.5);
      addRG('envMap',       'Glass reflection',   0, 8);
      addRG('thickness',    'Glass thickness',    0, 1);
      addRG('ior',          'IOR (refraction)',   1.0, 2.5);
      addRG('tintR',        'Tint R',             0, 1);
      addRG('tintG',        'Tint G',             0, 1);
      addRG('tintB',        'Tint B',             0, 1);

      const sepRL = document.createElement('div');
      sepRL.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepRL);
      const rlHeader = document.createElement('div');
      rlHeader.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffd9a8;';
      rlHeader.textContent = '💡 Corner spotlight';
      wrap.appendChild(rlHeader);
      wrap.appendChild(pillInfo('Tiny warm spot mounted at one top corner of the glass shell, aimed at the case interior. Pick the corner, dial intensity / range / color.'));
      const cornerRow = document.createElement('div');
      cornerRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';
      const CORNERS = [
        { idx: 0, name: 'Front-Right' },
        { idx: 1, name: 'Front-Left'  },
        { idx: 2, name: 'Back-Right'  },
        { idx: 3, name: 'Back-Left'   },
      ];
      const cornerBtns = [];
      function paintCornerR() {
        const cur = (typeof window.__getScreamCaseLightCorner === 'function') ? window.__getScreamCaseLightCorner() : 0;
        cornerBtns.forEach(({ btn, idx }) => {
          const on = idx === cur;
          btn.style.cssText = `flex:1 1 45%;padding:5px 8px;border-radius:6px;border:1px solid ${on ? 'rgba(255,200,80,0.65)' : 'rgba(255,255,255,0.15)'};background:${on ? 'rgba(255,200,80,0.18)' : 'transparent'};color:#fff;cursor:pointer;font:11px system-ui;`;
        });
      }
      for (const c of CORNERS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = c.name;
        b.addEventListener('click', () => {
          if (typeof window.__setScreamCaseLightCorner === 'function') {
            window.__setScreamCaseLightCorner(c.idx);
            paintCornerR();
          }
        });
        cornerRow.appendChild(b);
        cornerBtns.push({ btn: b, idx: c.idx });
      }
      wrap.appendChild(cornerRow);
      paintCornerR();

      const rcLight = window.__screamCaseLight;
      const rlState = {
        intensity: rcLight?.intensity ?? 1.4,
        distance:  rcLight?.distance  ?? 1.2,
        tintR:     rcLight?.color?.r  ?? 1.0,
        tintG:     rcLight?.color?.g  ?? 0.94,
        tintB:     rcLight?.color?.b  ?? 0.82,
      };
      function _applyRL() {
        if (!rcLight) return;
        rcLight.intensity = rlState.intensity;
        rcLight.distance  = rlState.distance;
        rcLight.color.setRGB(rlState.tintR, rlState.tintG, rlState.tintB);
        const bead = window.__screamCaseLightBead;
        if (bead?.material) {
          bead.material.color.setRGB(rlState.tintR, rlState.tintG, rlState.tintB);
          bead.material.emissive.setRGB(rlState.tintR, rlState.tintG, rlState.tintB);
        }
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur['screamCaseLight.intensity'] = rlState.intensity;
          cur['screamCaseLight.distance']  = rlState.distance;
          cur['screamCaseLight.tintR']     = rlState.tintR;
          cur['screamCaseLight.tintG']     = rlState.tintG;
          cur['screamCaseLight.tintB']     = rlState.tintB;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
      }
      const rlUndo = makePanelUndo();
      function addRL(key, lbl, min, max) {
        const r = buildSliderRow({ state: rlState, key, label: lbl, min, max, step: 0.005, fineStep: 0.001, undoStack: rlUndo, onApply: _applyRL });
        wrap.appendChild(r.row);
      }
      addRL('intensity', 'Light intensity', 0, 8);
      addRL('distance',  'Light range (falloff)', 0.1, 3);
      addRL('tintR',     'Light tint R', 0, 1);
      addRL('tintG',     'Light tint G', 0, 1);
      addRL('tintB',     'Light tint B', 0, 1);
    }

    // ---- Nut-case-specific: dims + glass + center pole + merge -------
    if (item.label === 'Nut case' && typeof NUT_CASE_DIMS !== 'undefined') {
      const sepNC = document.createElement('div');
      sepNC.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepNC);
      const ncH = document.createElement('div');
      ncH.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffd9a8;';
      ncH.textContent = '🌰 Nut case dimensions';
      wrap.appendChild(ncH);
      wrap.appendChild(pillInfo('Lighter oak base + glass shell + a central chrome pole. Adjust width / depth / glass height + base + pole thickness/length so the nut sits at the right height inside the case.'));
      const ncUndo = makePanelUndo();
      function _persistNC() {
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          for (const k of Object.keys(NUT_CASE_DIMS)) {
            cur[`nutCase.${k}`] = NUT_CASE_DIMS[k];
          }
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
        if (typeof window.__rebuildNutCase === 'function') window.__rebuildNutCase();
      }
      function addNCS(key, label, min, max) {
        const r = buildSliderRow({
          state: NUT_CASE_DIMS, key, label, min, max,
          step: 0.001, fineStep: 0.0005,
          undoStack: ncUndo, onApply: _persistNC,
        });
        wrap.appendChild(r.row);
      }
      addNCS('width',         'Width (X)',         0.10, 1.5);
      addNCS('depth',         'Depth (Z)',         0.10, 1.5);
      addNCS('glass',         'Glass height (Y)',  0.10, 2.0);
      addNCS('base',          'Floor depth (oak plate)', 0.005, 0.20);
      addNCS('wallThickness', 'Wall thickness',    0.003, 0.06);
      addNCS('wallLeft',      '⬅ LEFT wall height',   0, 0.6);
      addNCS('wallRight',     'RIGHT wall height ➡',  0, 0.6);
      addNCS('wallFront',     '◯ FRONT wall height',  0, 0.6);
      addNCS('wallBack',      '◯ BACK wall height',   0, 0.6);
      addNCS('poleRadius',    'Pole thickness',    0.003, 0.05);
      addNCS('poleLength',    'Pole length',       0.02, 1.5);

      // Merge button: pair-lock the Ice Age Nut to this case so it
      // rides along, with offset = (0, base + poleLength + tip, 0).
      const mergeBtn = document.createElement('button');
      mergeBtn.type = 'button';
      mergeBtn.textContent = '🔗 Merge Ice Age Nut with this case';
      mergeBtn.style.cssText = 'padding:7px;border-radius:6px;border:1px solid rgba(125,160,255,0.55);background:rgba(125,160,255,0.12);color:#fff;cursor:pointer;font:11px system-ui;font-weight:600;width:100%;margin-top:6px;';
      mergeBtn.addEventListener('click', () => {
        const sceneRoot = window.__macScreen.parent;
        let nut = null;
        sceneRoot.traverse(o => { if (o.name?.startsWith('__prop_bank-ice_age_nut-')) nut = o; });
        if (!nut) { alert('Ice Age Nut isn\'t in the scene yet — drop it from the Items menu first.'); return; }
        // Top-of-pole world position so the nut sits ON the pole, not inside it.
        const caseGrp = window.__nutCaseGroup;
        if (!caseGrp) { alert('Nut case group missing'); return; }
        caseGrp.updateMatrixWorld(true);
        const cM = caseGrp.matrixWorld.elements;
        const topY = cM[13] + NUT_CASE_DIMS.base + NUT_CASE_DIMS.poleLength + 0.02;
        // Place the nut at top-of-pole + persist new pos.
        nut.position.set(cM[12], topY, cM[14]);
        nut.updateMatrixWorld(true);
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur['item.ice_age_nut_34.x'] = nut.position.x;
          cur['item.ice_age_nut_34.y'] = nut.position.y;
          cur['item.ice_age_nut_34.z'] = nut.position.z;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
        // Wipe any prior pair, then create the new lock with case = anchor.
        if (window.__pairUnlock) window.__pairUnlock(nut);
        if (window.__persistUnpair) window.__persistUnpair('ice age nut 34');
        if (window.__pairLock) window.__pairLock(caseGrp, nut);
        if (window.__persistPair) window.__persistPair('Nut case', 'ice age nut 34', { x: 0, y: NUT_CASE_DIMS.base + NUT_CASE_DIMS.poleLength + 0.02, z: 0 });
        alert('🔗 Ice Age Nut merged with the Nut case.');
      });
      wrap.appendChild(mergeBtn);

      // Glass material section
      const sepNG = document.createElement('div');
      sepNG.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepNG);
      const ngH = document.createElement('div');
      ngH.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#cfe9ff;';
      ngH.textContent = '✨ Glass material';
      wrap.appendChild(ngH);
      const ncGlass = window.__nutCaseGlassMat;
      const ngState = {
        opacity:      ncGlass?.opacity ?? 1.0,
        transmission: ncGlass?.transmission ?? 0.95,
        roughness:    ncGlass?.roughness ?? 0.02,
        envMap:       ncGlass?.envMapIntensity ?? 1.5,
        thickness:    ncGlass?.thickness ?? 0.30,
        ior:          ncGlass?.ior ?? 1.52,
        tintR:        ncGlass?.color?.r ?? 1.0,
        tintG:        ncGlass?.color?.g ?? 1.0,
        tintB:        ncGlass?.color?.b ?? 1.0,
      };
      function _applyNG() {
        if (!ncGlass) return;
        ncGlass.opacity = ngState.opacity;
        ncGlass.transmission = ngState.transmission;
        ncGlass.roughness = ngState.roughness;
        ncGlass.envMapIntensity = ngState.envMap;
        ncGlass.thickness = ngState.thickness;
        ncGlass.ior = ngState.ior;
        ncGlass.color.setRGB(ngState.tintR, ngState.tintG, ngState.tintB);
        ncGlass.needsUpdate = true;
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur['nutCaseGlass.opacity']      = ngState.opacity;
          cur['nutCaseGlass.transmission'] = ngState.transmission;
          cur['nutCaseGlass.roughness']    = ngState.roughness;
          cur['nutCaseGlass.envMap']       = ngState.envMap;
          cur['nutCaseGlass.thickness']    = ngState.thickness;
          cur['nutCaseGlass.ior']          = ngState.ior;
          cur['nutCaseGlass.tintR']        = ngState.tintR;
          cur['nutCaseGlass.tintG']        = ngState.tintG;
          cur['nutCaseGlass.tintB']        = ngState.tintB;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
      }
      const ngUndo = makePanelUndo();
      function addNG(key, lbl, min, max) {
        const r = buildSliderRow({ state: ngState, key, label: lbl, min, max, step: 0.005, fineStep: 0.001, undoStack: ngUndo, onApply: _applyNG });
        wrap.appendChild(r.row);
      }
      addNG('opacity',      'Glass opacity',      0, 1);
      addNG('transmission', 'Transmission',       0, 1);
      addNG('roughness',    'Glass roughness (high → frosted)', 0, 0.5);
      addNG('envMap',       'Glass reflection',   0, 8);
      addNG('thickness',    'Glass thickness',    0, 1);
      addNG('ior',          'IOR (refraction)',   1.0, 2.5);
      addNG('tintR',        'Tint R',             0, 1);
      addNG('tintG',        'Tint G',             0, 1);
      addNG('tintB',        'Tint B',             0, 1);
    }

    // ---- Treasure-case-specific: dims + per-pole + glass material -----
    if (item.label === 'Treasure case' && typeof TREASURE_CASE_DIMS !== 'undefined') {
      const sepTC = document.createElement('div');
      sepTC.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepTC);
      const tcH = document.createElement('div');
      tcH.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffd9a8;';
      tcH.textContent = '🚀 Treasure case dimensions';
      wrap.appendChild(tcH);
      wrap.appendChild(pillInfo('Wood base + glass shell + TWO chrome poles that hold the ship horizontally. Each pole has its own X+Z position; both share girth + height.'));
      const tcUndo = makePanelUndo();
      function _persistTC() {
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          for (const k of Object.keys(TREASURE_CASE_DIMS)) {
            cur[`treasureCase.${k}`] = TREASURE_CASE_DIMS[k];
          }
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
        if (typeof window.__rebuildTreasureCase === 'function') window.__rebuildTreasureCase();
      }
      function addTC(key, label, min, max, step = 0.001) {
        const r = buildSliderRow({
          state: TREASURE_CASE_DIMS, key, label, min, max,
          step, fineStep: step / 2,
          undoStack: tcUndo, onApply: _persistTC,
        });
        wrap.appendChild(r.row);
      }
      addTC('width',      'Width (X)',         0.10, 2.0);
      addTC('depth',      'Depth (Z)',         0.10, 1.5);
      addTC('glass',      'Glass height (Y)',  0.10, 2.0);
      addTC('base',       'Base height (wood)', 0.005, 0.20);
      addTC('poleRadius', 'Pole GIRTH (radius)', 0.003, 0.05, 0.0005);
      addTC('poleHeight', 'Pole height (cradle lift)', 0.01, 0.50, 0.002);
      addTC('pole1X',     '⬅ Pole 1 X (left)',  -1, 1, 0.005);
      addTC('pole1Z',     '⬅ Pole 1 Z (depth)', -1, 1, 0.005);
      addTC('pole2X',     'Pole 2 X (right) ➡', -1, 1, 0.005);
      addTC('pole2Z',     'Pole 2 Z (depth) ➡', -1, 1, 0.005);

      // Glass material section (identical recipe to Nike Display case)
      const sepTG = document.createElement('div');
      sepTG.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepTG);
      const tgH = document.createElement('div');
      tgH.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#cfe9ff;';
      tgH.textContent = '✨ Glass material';
      wrap.appendChild(tgH);
      const tcGlass = window.__treasureCaseGlassMat;
      const tgState = {
        opacity:      tcGlass?.opacity ?? 1.0,
        transmission: tcGlass?.transmission ?? 0.95,
        roughness:    tcGlass?.roughness ?? 0.02,
        envMap:       tcGlass?.envMapIntensity ?? 1.5,
        thickness:    tcGlass?.thickness ?? 0.30,
        ior:          tcGlass?.ior ?? 1.52,
        tintR:        tcGlass?.color?.r ?? 1.0,
        tintG:        tcGlass?.color?.g ?? 1.0,
        tintB:        tcGlass?.color?.b ?? 1.0,
      };
      function _applyTG() {
        if (!tcGlass) return;
        tcGlass.opacity = tgState.opacity;
        tcGlass.transmission = tgState.transmission;
        tcGlass.roughness = tgState.roughness;
        tcGlass.envMapIntensity = tgState.envMap;
        tcGlass.thickness = tgState.thickness;
        tcGlass.ior = tgState.ior;
        tcGlass.color.setRGB(tgState.tintR, tgState.tintG, tgState.tintB);
        tcGlass.needsUpdate = true;
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur['treasureCaseGlass.opacity']      = tgState.opacity;
          cur['treasureCaseGlass.transmission'] = tgState.transmission;
          cur['treasureCaseGlass.roughness']    = tgState.roughness;
          cur['treasureCaseGlass.envMap']       = tgState.envMap;
          cur['treasureCaseGlass.thickness']    = tgState.thickness;
          cur['treasureCaseGlass.ior']          = tgState.ior;
          cur['treasureCaseGlass.tintR']        = tgState.tintR;
          cur['treasureCaseGlass.tintG']        = tgState.tintG;
          cur['treasureCaseGlass.tintB']        = tgState.tintB;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
      }
      const tgUndo = makePanelUndo();
      function addTG(key, lbl, min, max) {
        const r = buildSliderRow({ state: tgState, key, label: lbl, min, max, step: 0.005, fineStep: 0.001, undoStack: tgUndo, onApply: _applyTG });
        wrap.appendChild(r.row);
      }
      addTG('opacity',      'Glass opacity',      0, 1);
      addTG('transmission', 'Transmission',       0, 1);
      addTG('roughness',    'Glass roughness (high → frosted)', 0, 0.5);
      addTG('envMap',       'Glass reflection',   0, 8);
      addTG('thickness',    'Glass thickness',    0, 1);
      addTG('ior',          'IOR (refraction)',   1.0, 2.5);
      addTG('tintR',        'Tint R',             0, 1);
      addTG('tintG',        'Tint G',             0, 1);
      addTG('tintB',        'Tint B',             0, 1);
    }

    // ---- Bonsai-specific: leaves X/Y/Z offset ------------------------
    // Move the pink cherry-blossom geometry as one piece without
    // detaching anything. Container is built eagerly when this
    // editor opens (so the slider's first drag is immediate, no
    // first-touch wrap cost). Persisted under `bonsaiLeaves.offset.*`.
    if (item.label === 'Bonsai') {
      // Build (or fetch cached) the leaves container NOW — guarantees
      // the slider has a target to move. By the time the user clicks
      // the bonsai tree, room.glb is definitely loaded, so the scan
      // will find every pink leaf in the scene.
      const _preWrap = _ensureLeavesContainer();
      if (_preWrap) console.log(`[leaves] bonsai editor opened — container ready, ${_preWrap.children.length} child mesh(es).`);
      else console.warn('[leaves] bonsai editor opened, but NO container — scan found 0 pink leaves. Sliders will be a no-op.');
      const sepBL = document.createElement('div');
      sepBL.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepBL);
      const blH = document.createElement('div');
      blH.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffb8d4;';
      blH.textContent = '🌸 Leaves position';
      wrap.appendChild(blH);
      wrap.appendChild(pillInfo('Slides every pink leaf mesh as one piece. The first slider move wraps the leaves in an invisible container — they keep their world position, just become movable together.'));
      const blState = {
        x: window.__getLeavesOffsetX?.() ?? 0,
        y: window.__getLeavesOffsetY?.() ?? 0,
        z: window.__getLeavesOffsetZ?.() ?? 0,
      };
      const blUndo = makePanelUndo();
      function addBL(key, label, min, max) {
        const r = buildSliderRow({
          state: blState, key, label, min, max,
          step: 0.005, fineStep: 0.001,
          undoStack: blUndo,
          onApply: () => {
            if (key === 'x') window.__setLeavesOffsetX(blState.x);
            if (key === 'y') window.__setLeavesOffsetY(blState.y);
            if (key === 'z') window.__setLeavesOffsetZ(blState.z);
          },
        });
        wrap.appendChild(r.row);
      }
      addBL('x', 'Leaves X (left ↔ right)', -3, 3);
      addBL('y', 'Leaves Y (down ↔ up)',    -3, 3);
      addBL('z', 'Leaves Z (back ↔ front)', -3, 3);
      const blReset = document.createElement('button');
      blReset.type = 'button';
      blReset.textContent = '↺ Reset leaves to original spot';
      blReset.style.cssText = 'padding:6px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:#fff;cursor:pointer;font:11px system-ui;margin-top:4px;';
      blReset.addEventListener('click', () => {
        blState.x = 0; blState.y = 0; blState.z = 0;
        window.__setLeavesOffsetX(0);
        window.__setLeavesOffsetY(0);
        window.__setLeavesOffsetZ(0);
        // Rebuild the editor so the slider thumbs visually snap to 0.
        if (typeof window.__onSelectionChange === 'function') window.__onSelectionChange(item, true);
      });
      wrap.appendChild(blReset);

      // ---- Place new leaves (interactive placement mode) -----------
      // Toggles `leafTool` placement mode. A translucent ghost leaf
      // follows the cursor; clicking lands a real leaf on the picked
      // surface with random rotation jitter (twist + small tilts) for
      // natural variation. Newly placed leaves are auto-added to the
      // `__leavesContainer` so the Leaves X/Y/Z sliders above move
      // them with the rest.
      const sepPL = document.createElement('div');
      sepPL.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:8px 0 2px;';
      wrap.appendChild(sepPL);
      const plH = document.createElement('div');
      plH.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffb8d4;';
      plH.textContent = '🌸 Place new leaves';
      wrap.appendChild(plH);
      wrap.appendChild(pillInfo('Toggle ON, then move the mouse over the bonsai branches — a translucent ghost leaf shows where the next leaf will land. Click to drop one. Each leaf gets a random twist + slight tilt for variety. Click the button again to stop placing.'));
      // Size slider — drives leafTool's leafScale (affects both preview and new placements).
      const plSize = { v: 0.06 };
      const plUndo = makePanelUndo();
      const plSizeRow = buildSliderRow({
        state: plSize, key: 'v', label: 'Leaf size (m)',
        min: 0.01, max: 0.20, step: 0.005, fineStep: 0.001,
        undoStack: plUndo,
        onApply: () => { window.__leafTool?.setScale(plSize.v); },
      });
      wrap.appendChild(plSizeRow.row);
      // Color picker — drives the leafTool color (per-placement).
      const plColorRow = document.createElement('div');
      plColorRow.style.cssText = 'display:flex;align-items:center;gap:8px;font:11px system-ui;margin:4px 0;';
      const plColorLbl = document.createElement('span');
      plColorLbl.textContent = 'New leaf color';
      plColorLbl.style.opacity = '0.85';
      const plColorInput = document.createElement('input');
      plColorInput.type = 'color';
      plColorInput.value = '#e23a8e';
      plColorInput.style.cssText = 'width:30px;height:24px;border:1px solid rgba(255,255,255,0.18);border-radius:4px;background:transparent;cursor:pointer;';
      plColorInput.addEventListener('input', () => {
        window.__leafTool?.setColor?.(plColorInput.value);
      });
      plColorRow.appendChild(plColorLbl);
      plColorRow.appendChild(plColorInput);
      wrap.appendChild(plColorRow);
      // Toggle button.
      const placeBtn = document.createElement('button');
      placeBtn.type = 'button';
      let placementOn = false;
      function paintPlaceBtn() {
        placeBtn.textContent = placementOn ? '✋ Click scene to drop a leaf (toggle OFF when done)' : '🌸 Place leaf mode: OFF — click to enable';
        placeBtn.style.cssText = placementOn
          ? 'padding:8px 10px;border-radius:6px;border:1px solid rgba(255,180,255,0.65);background:rgba(255,180,255,0.18);color:#ffd9ff;cursor:pointer;font:11px system-ui;text-align:left;margin-top:4px;font-weight:700;'
          : 'padding:8px 10px;border-radius:6px;border:1px solid rgba(255,180,255,0.35);background:transparent;color:#ffd9ff;cursor:pointer;font:11px system-ui;text-align:left;margin-top:4px;';
      }
      function setPlacement(on) {
        placementOn = !!on;
        if (window.__leafTool) {
          window.__leafTool.setEnabled(placementOn);
          window.__leafTool.setScale(plSize.v);
          window.__leafTool.setColor?.(plColorInput.value);
          // When a new leaf lands, parent it into the leaves container
          // (so the X/Y/Z sliders move it with the rest), mark it as
          // user-placed, and persist the full list immediately so a
          // reload restores it.
          window.__leafTool.setOnLeafAdded((leafObj) => {
            const c = _ensureLeavesContainer();
            if (c && leafObj) {
              c.attach(leafObj);
              leafObj.userData.__placedLeaf = true;
              leafObj.userData.__color = plColorInput.value;
              window.__persistPlacedLeaves();
            }
          });
        }
        paintPlaceBtn();
      }
      placeBtn.addEventListener('click', () => setPlacement(!placementOn));
      paintPlaceBtn();
      wrap.appendChild(placeBtn);
    }

    // ---- Hudson-case-specific: dims + glass material (NO poles) -------
    if (item.label === 'Hudson case' && typeof HUDSON_CASE_DIMS !== 'undefined') {
      const sepHC = document.createElement('div');
      sepHC.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepHC);
      const hcH = document.createElement('div');
      hcH.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffd9a8;';
      hcH.textContent = '🏁 Hudson case dimensions';
      wrap.appendChild(hcH);
      wrap.appendChild(pillInfo('Wood base + glass shell — no poles. Hudson sits directly on the wood floor.'));
      const hcUndo = makePanelUndo();
      function _persistHC() {
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          for (const k of Object.keys(HUDSON_CASE_DIMS)) {
            cur[`hudsonCase.${k}`] = HUDSON_CASE_DIMS[k];
          }
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
        if (typeof window.__rebuildHudsonCase === 'function') window.__rebuildHudsonCase();
      }
      function addHC(key, label, min, max, step = 0.001) {
        const r = buildSliderRow({
          state: HUDSON_CASE_DIMS, key, label, min, max,
          step, fineStep: step / 2,
          undoStack: hcUndo, onApply: _persistHC,
        });
        wrap.appendChild(r.row);
      }
      addHC('width',  'Width (X)',         0.10, 2.0);
      addHC('depth',  'Depth (Z)',         0.10, 1.5);
      addHC('glass',  'Glass height (Y)',  0.10, 2.0);
      addHC('base',   'Base height (wood)', 0.005, 0.20);

      // ---- Case color (wood texture picker + tint) -----------------
      const sepHW = document.createElement('div');
      sepHW.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepHW);
      const hwH = document.createElement('div');
      hwH.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffd9a8;';
      hwH.textContent = '🪵 Case color';
      wrap.appendChild(hwH);
      wrap.appendChild(pillInfo('Pick a wood texture for the base, then tint it via R/G/B (multiplied over the texture — leave at 1,1,1 for the natural wood color).'));
      // Picker buttons — one per wood option.
      const WOODS = window.__hudsonWoodOptions || ['oak_veneer_01'];
      const WOOD_LABELS = {
        'dark_wood':           '🌰 Dark wood',
        'dark_wooden_planks':  '📕 Dark planks',
        'fine_grained_wood':   '🟫 Fine grain',
        'kitchen_wood':        '🍳 Kitchen wood',
        'oak_veneer_01':       '🟧 Oak veneer',
        'rosewood_veneer1':    '🥀 Rosewood',
        'stained_pine':        '🌲 Stained pine',
      };
      const pickerWrap = document.createElement('div');
      pickerWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin:3px 0;';
      const woodBtns = [];
      function paintWoodActive() {
        const cur = (typeof window.__getHudsonWood === 'function') ? window.__getHudsonWood() : 'oak_veneer_01';
        woodBtns.forEach(({ btn, name }) => {
          const on = name === cur;
          btn.style.cssText = `flex:1 1 calc(50% - 4px);padding:5px 8px;border-radius:6px;border:1px solid ${on ? 'rgba(255,200,80,0.65)' : 'rgba(255,255,255,0.15)'};background:${on ? 'rgba(255,200,80,0.18)' : 'transparent'};color:#fff;cursor:pointer;font:10.5px system-ui;text-align:left;`;
        });
      }
      for (const w of WOODS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = WOOD_LABELS[w] || w;
        b.addEventListener('click', () => {
          if (typeof window.__setHudsonWood === 'function') {
            window.__setHudsonWood(w);
            paintWoodActive();
          }
        });
        pickerWrap.appendChild(b);
        woodBtns.push({ btn: b, name: w });
      }
      wrap.appendChild(pickerWrap);
      paintWoodActive();
      // RGB tint sliders — multiply against the texture so user can
      // shift the wood color (e.g. push warmer / cooler / desaturate).
      const baseMatRef = window.__hudsonCaseBaseMat;
      const tintState = {
        r: baseMatRef?.color?.r ?? 1.0,
        g: baseMatRef?.color?.g ?? 1.0,
        b: baseMatRef?.color?.b ?? 1.0,
      };
      function _applyTint() {
        if (!baseMatRef) return;
        baseMatRef.color.setRGB(tintState.r, tintState.g, tintState.b);
        baseMatRef.needsUpdate = true;
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur['hudsonCase.tintR'] = tintState.r;
          cur['hudsonCase.tintG'] = tintState.g;
          cur['hudsonCase.tintB'] = tintState.b;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
      }
      const tintUndo = makePanelUndo();
      function addTint(key, lbl) {
        const r = buildSliderRow({ state: tintState, key, label: lbl, min: 0, max: 1, step: 0.01, fineStep: 0.005, undoStack: tintUndo, onApply: _applyTint });
        wrap.appendChild(r.row);
      }
      addTint('r', 'Tint R (1 = natural)');
      addTint('g', 'Tint G');
      addTint('b', 'Tint B');

      // Glass material — same recipe / same controls as the Nike Display case.
      const sepHG = document.createElement('div');
      sepHG.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepHG);
      const hgH = document.createElement('div');
      hgH.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#cfe9ff;';
      hgH.textContent = '✨ Glass material';
      wrap.appendChild(hgH);
      const hcGlass = window.__hudsonCaseGlassMat;
      const hgState = {
        opacity:      hcGlass?.opacity ?? 1.0,
        transmission: hcGlass?.transmission ?? 0.95,
        roughness:    hcGlass?.roughness ?? 0.02,
        envMap:       hcGlass?.envMapIntensity ?? 1.5,
        thickness:    hcGlass?.thickness ?? 0.30,
        ior:          hcGlass?.ior ?? 1.52,
        tintR:        hcGlass?.color?.r ?? 1.0,
        tintG:        hcGlass?.color?.g ?? 1.0,
        tintB:        hcGlass?.color?.b ?? 1.0,
      };
      function _applyHG() {
        if (!hcGlass) return;
        hcGlass.opacity = hgState.opacity;
        hcGlass.transmission = hgState.transmission;
        hcGlass.roughness = hgState.roughness;
        hcGlass.envMapIntensity = hgState.envMap;
        hcGlass.thickness = hgState.thickness;
        hcGlass.ior = hgState.ior;
        hcGlass.color.setRGB(hgState.tintR, hgState.tintG, hgState.tintB);
        hcGlass.needsUpdate = true;
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur['hudsonCaseGlass.opacity']      = hgState.opacity;
          cur['hudsonCaseGlass.transmission'] = hgState.transmission;
          cur['hudsonCaseGlass.roughness']    = hgState.roughness;
          cur['hudsonCaseGlass.envMap']       = hgState.envMap;
          cur['hudsonCaseGlass.thickness']    = hgState.thickness;
          cur['hudsonCaseGlass.ior']          = hgState.ior;
          cur['hudsonCaseGlass.tintR']        = hgState.tintR;
          cur['hudsonCaseGlass.tintG']        = hgState.tintG;
          cur['hudsonCaseGlass.tintB']        = hgState.tintB;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
      }
      const hgUndo = makePanelUndo();
      function addHG(key, lbl, min, max) {
        const r = buildSliderRow({ state: hgState, key, label: lbl, min, max, step: 0.005, fineStep: 0.001, undoStack: hgUndo, onApply: _applyHG });
        wrap.appendChild(r.row);
      }
      addHG('opacity',      'Glass opacity',      0, 1);
      addHG('transmission', 'Transmission',       0, 1);
      addHG('roughness',    'Glass roughness (high → frosted)', 0, 0.5);
      addHG('envMap',       'Glass reflection',   0, 8);
      addHG('thickness',    'Glass thickness',    0, 1);
      addHG('ior',          'IOR (refraction)',   1.0, 2.5);
      addHG('tintR',        'Tint R',             0, 1);
      addHG('tintG',        'Tint G',             0, 1);
      addHG('tintB',        'Tint B',             0, 1);
    }

    // ---- VHS stand: wooden base + chrome tripod-like holder ---------
    if (item.label === 'VHS stand' && typeof VHS_STAND_DIMS !== 'undefined') {
      const sepVS = document.createElement('div');
      sepVS.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepVS);
      const vsH = document.createElement('div');
      vsH.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffd9a8;';
      vsH.textContent = '📺 VHS stand — dimensions';
      wrap.appendChild(vsH);
      wrap.appendChild(pillInfo('Wooden base + chrome holder. Two vertical posts hold a tilted backplate; two horizontal cradle sticks project forward like a tripod and the VHS rests on them.'));
      const vsUndo = makePanelUndo();
      function _persistVS() {
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          for (const k of Object.keys(VHS_STAND_DIMS)) {
            cur[`vhsStand.${k}`] = VHS_STAND_DIMS[k];
          }
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
        if (typeof window.__rebuildVhsStand === 'function') window.__rebuildVhsStand();
      }
      function addVS(key, label, min, max, step = 0.001) {
        const r = buildSliderRow({
          state: VHS_STAND_DIMS, key, label, min, max,
          step, fineStep: step / 2,
          undoStack: vsUndo, onApply: _persistVS,
        });
        wrap.appendChild(r.row);
      }
      // Wood base.
      addVS('baseW', 'Base width (X)',  0.10, 0.80);
      addVS('baseD', 'Base depth (Z)',  0.08, 0.60);
      addVS('baseH', 'Base height (Y)', 0.008, 0.10);
      // Vertical posts.
      addVS('postH',       'Post height',   0.05, 0.50);
      addVS('postT',       'Post thickness', 0.003, 0.030, 0.0005);
      addVS('postSpacing', 'Post spacing (between)', 0.04, 0.40);
      // Tilted backplate.
      addVS('backW',    'Back plate width',  0.04, 0.40);
      addVS('backH',    'Back plate height', 0.04, 0.40);
      addVS('backT',    'Back plate thickness', 0.002, 0.030, 0.0005);
      addVS('backTilt', 'Back plate tilt (rad)', -0.8, 0.8, 0.005);
      // Forward cradle sticks.
      addVS('cradleLength',  'Cradle length (forward)', 0.01, 0.20);
      addVS('cradleT',       'Cradle thickness', 0.002, 0.025, 0.0005);
      addVS('cradleSpacing', 'Cradle spacing (between)', 0.04, 0.40);
      addVS('cradleLift',    'Cradle lift above base', 0.0, 0.05, 0.0005);

      // ---- Wood color (texture picker + tint) -----------------------
      const sepVW = document.createElement('div');
      sepVW.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepVW);
      const vwH = document.createElement('div');
      vwH.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffd9a8;';
      vwH.textContent = '🪵 Base wood';
      wrap.appendChild(vwH);
      wrap.appendChild(pillInfo('Pick a wood texture for the base, then tint it R/G/B (multiplied over the texture — leave at 1,1,1 for the natural color).'));
      const VS_WOODS = window.__vhsWoodOptions || ['oak_veneer_01'];
      const VS_WOOD_LABELS = {
        'dark_wood':           '🌰 Dark wood',
        'dark_wooden_planks':  '📕 Dark planks',
        'fine_grained_wood':   '🟫 Fine grain',
        'kitchen_wood':        '🍳 Kitchen wood',
        'oak_veneer_01':       '🟧 Oak veneer',
        'rosewood_veneer1':    '🥀 Rosewood',
        'stained_pine':        '🌲 Stained pine',
      };
      const vsPickWrap = document.createElement('div');
      vsPickWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin:3px 0;';
      const vsWoodBtns = [];
      function paintVSWoodActive() {
        const cur = (typeof window.__getVhsWood === 'function') ? window.__getVhsWood() : 'oak_veneer_01';
        vsWoodBtns.forEach(({ btn, name }) => {
          const on = name === cur;
          btn.style.cssText = `flex:1 1 calc(50% - 4px);padding:5px 8px;border-radius:6px;border:1px solid ${on ? 'rgba(255,200,80,0.65)' : 'rgba(255,255,255,0.15)'};background:${on ? 'rgba(255,200,80,0.18)' : 'transparent'};color:#fff;cursor:pointer;font:10.5px system-ui;text-align:left;`;
        });
      }
      for (const w of VS_WOODS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = VS_WOOD_LABELS[w] || w;
        b.addEventListener('click', () => {
          if (typeof window.__setVhsWood === 'function') {
            window.__setVhsWood(w);
            paintVSWoodActive();
          }
        });
        vsPickWrap.appendChild(b);
        vsWoodBtns.push({ btn: b, name: w });
      }
      wrap.appendChild(vsPickWrap);
      paintVSWoodActive();
      // Wood tint sliders.
      const vsBaseMat = window.__vhsStandBaseMat;
      const vsTint = {
        r: vsBaseMat?.color?.r ?? 1.0,
        g: vsBaseMat?.color?.g ?? 1.0,
        b: vsBaseMat?.color?.b ?? 1.0,
      };
      function _applyVSTint() {
        if (!vsBaseMat) return;
        vsBaseMat.color.setRGB(vsTint.r, vsTint.g, vsTint.b);
        vsBaseMat.needsUpdate = true;
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur['vhsStand.tintR'] = vsTint.r;
          cur['vhsStand.tintG'] = vsTint.g;
          cur['vhsStand.tintB'] = vsTint.b;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
      }
      const vsTintUndo = makePanelUndo();
      function addVSTint(key, lbl) {
        const r = buildSliderRow({ state: vsTint, key, label: lbl, min: 0, max: 1, step: 0.01, fineStep: 0.005, undoStack: vsTintUndo, onApply: _applyVSTint });
        wrap.appendChild(r.row);
      }
      addVSTint('r', 'Wood tint R (1 = natural)');
      addVSTint('g', 'Wood tint G');
      addVSTint('b', 'Wood tint B');

      // ---- Chrome holder tint --------------------------------------
      const sepVM = document.createElement('div');
      sepVM.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepVM);
      const vmH = document.createElement('div');
      vmH.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#cfe9ff;';
      vmH.textContent = '🔧 Chrome holder';
      wrap.appendChild(vmH);
      wrap.appendChild(pillInfo('Posts, backplate and cradle sticks share a polished chrome material. Tint shifts its base color, roughness/metalness control the shine.'));
      const vsMetalMat = window.__vhsStandMetalMat;
      const vsMetal = {
        r:         vsMetalMat?.color?.r        ?? 0.81,
        g:         vsMetalMat?.color?.g        ?? 0.82,
        b:         vsMetalMat?.color?.b        ?? 0.83,
        roughness: vsMetalMat?.roughness       ?? 0.22,
        metalness: vsMetalMat?.metalness       ?? 0.95,
      };
      function _applyVSMetal() {
        if (!vsMetalMat) return;
        vsMetalMat.color.setRGB(vsMetal.r, vsMetal.g, vsMetal.b);
        vsMetalMat.roughness = vsMetal.roughness;
        vsMetalMat.metalness = vsMetal.metalness;
        vsMetalMat.needsUpdate = true;
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur['vhsStand.metalR']         = vsMetal.r;
          cur['vhsStand.metalG']         = vsMetal.g;
          cur['vhsStand.metalB']         = vsMetal.b;
          cur['vhsStand.metalRoughness'] = vsMetal.roughness;
          cur['vhsStand.metalMetalness'] = vsMetal.metalness;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
      }
      const vsMetalUndo = makePanelUndo();
      function addVSMetal(key, lbl, min, max, step = 0.01) {
        const r = buildSliderRow({ state: vsMetal, key, label: lbl, min, max, step, fineStep: step / 2, undoStack: vsMetalUndo, onApply: _applyVSMetal });
        wrap.appendChild(r.row);
      }
      addVSMetal('r',         'Metal tint R',  0, 1);
      addVSMetal('g',         'Metal tint G',  0, 1);
      addVSMetal('b',         'Metal tint B',  0, 1);
      addVSMetal('roughness', 'Metal roughness (low = mirror)', 0, 1, 0.005);
      addVSMetal('metalness', 'Metalness',     0, 1, 0.01);
    }

    // ---- Display-case-specific: live dimension sliders ---------------
    if (item.label === 'Display case' && typeof DISPLAY_CASE_DIMS !== 'undefined') {
      const sepC = document.createElement('div');
      sepC.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepC);
      const cHeader = document.createElement('div');
      cHeader.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#cfe9ff;';
      cHeader.textContent = '🪟 Case dimensions';
      wrap.appendChild(cHeader);
      wrap.appendChild(pillInfo('Resize the glass box live. Width = X, Depth = Z, Glass height = the column. Base height = the dark plinth.'));
      const dimsUndo = makePanelUndo();
      function _persistDims() {
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          for (const k of ['width', 'depth', 'base', 'glass']) {
            cur[`displayCase.${k}`] = DISPLAY_CASE_DIMS[k];
          }
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
        if (typeof window.__rebuildDisplayCase === 'function') window.__rebuildDisplayCase();
      }
      function addDim(key, label, min, max) {
        const r = buildSliderRow({
          state: DISPLAY_CASE_DIMS, key, label, min, max,
          step: 0.001, fineStep: 0.0005,
          undoStack: dimsUndo, onApply: _persistDims,
        });
        wrap.appendChild(r.row);
      }
      addDim('width', 'Width (X)',         0.05, 1.5);
      addDim('depth', 'Depth (Z)',         0.05, 1.5);
      addDim('glass', 'Glass height (Y)',  0.05, 2.0);
      addDim('base',  'Base height',       0.005, 0.20);

      // ---- Glass material sliders (live mutation of __caseGlassMat) ----
      const sepG = document.createElement('div');
      sepG.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepG);
      const gHeader = document.createElement('div');
      gHeader.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#cfe9ff;';
      gHeader.textContent = '✨ Glass material';
      wrap.appendChild(gHeader);
      wrap.appendChild(pillInfo('Tune clarity, shine, refraction, and tint of the glass walls. Lower roughness = more reflective shine.'));
      const glassMatRef = window.__caseGlassMat;
      if (glassMatRef) {
        const glassState = {
          opacity:      glassMatRef.opacity,
          transmission: glassMatRef.transmission ?? 0,
          roughness:    glassMatRef.roughness ?? 0,
          envMap:       glassMatRef.envMapIntensity ?? 1,
          thickness:    glassMatRef.thickness ?? 0.05,
          ior:          glassMatRef.ior ?? 1.5,
          tintR:        glassMatRef.color.r,
          tintG:        glassMatRef.color.g,
          tintB:        glassMatRef.color.b,
        };
        function applyGlass() {
          glassMatRef.opacity = glassState.opacity;
          if (glassMatRef.transmission !== undefined) glassMatRef.transmission = glassState.transmission;
          if (glassMatRef.thickness    !== undefined) glassMatRef.thickness    = glassState.thickness;
          glassMatRef.roughness = glassState.roughness;
          glassMatRef.envMapIntensity = glassState.envMap;
          if (glassMatRef.ior !== undefined) glassMatRef.ior = glassState.ior;
          glassMatRef.color.setRGB(glassState.tintR, glassState.tintG, glassState.tintB);
          glassMatRef.needsUpdate = true;
          // Persist
          try {
            const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
            cur['caseGlass.opacity']      = glassState.opacity;
            cur['caseGlass.transmission'] = glassState.transmission;
            cur['caseGlass.roughness']    = glassState.roughness;
            cur['caseGlass.envMap']       = glassState.envMap;
            cur['caseGlass.thickness']    = glassState.thickness;
            cur['caseGlass.ior']          = glassState.ior;
            cur['caseGlass.tintR']        = glassState.tintR;
            cur['caseGlass.tintG']        = glassState.tintG;
            cur['caseGlass.tintB']        = glassState.tintB;
            localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
          } catch {}
        }
        const glassUndo = makePanelUndo();
        function addG(key, label, min, max, step, fineStep) {
          const r = buildSliderRow({
            state: glassState, key, label, min, max, step, fineStep,
            undoStack: glassUndo, onApply: applyGlass,
          });
          wrap.appendChild(r.row);
        }
        addG('opacity',      'Opacity',          0,    1,    0.005, 0.001);
        addG('transmission', 'Clarity (see-thru)', 0,  1,    0.005, 0.001);
        addG('roughness',    'Frosted (rough)',   0,    1,    0.005, 0.001);
        addG('envMap',       'Reflectivity',      0,    5,    0.01,  0.005);
        addG('thickness',    'Refraction depth',  0,    1,    0.005, 0.001);
        addG('ior',          'Index of refraction', 1.0, 2.5, 0.005, 0.001);
        addG('tintR',        'Tint R',            0,    1,    0.005, 0.001);
        addG('tintG',        'Tint G',            0,    1,    0.005, 0.001);
        addG('tintB',        'Tint B',            0,    1,    0.005, 0.001);

        const resetGlassBtn = document.createElement('button');
        resetGlassBtn.type = 'button';
        resetGlassBtn.textContent = '↺ Reset glass';
        resetGlassBtn.style.cssText = 'padding:7px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:#fff;cursor:pointer;font-size:11px;margin-top:4px;';
        resetGlassBtn.addEventListener('click', () => {
          glassState.opacity = 0.55;
          glassState.transmission = 0.40;
          glassState.roughness = 0.04;
          glassState.envMap = 1.4;
          glassState.thickness = 0.05;
          glassState.ior = 1.5;
          glassState.tintR = 0.866; glassState.tintG = 0.933; glassState.tintB = 1.0; // 0xddeeff
          applyGlass();
          if (typeof window.__onSelectionChange === 'function' && selectedItem) {
            window.__onSelectionChange(selectedItem, true);
          }
        });
        wrap.appendChild(resetGlassBtn);
      }

      const resetDimsBtn = document.createElement('button');
      resetDimsBtn.type = 'button';
      resetDimsBtn.textContent = '↺ Reset case dimensions';
      resetDimsBtn.style.cssText = 'padding:7px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:#fff;cursor:pointer;font-size:11px;margin-top:4px;';
      resetDimsBtn.addEventListener('click', () => {
        DISPLAY_CASE_DIMS.width = 0.30;
        DISPLAY_CASE_DIMS.depth = 0.22;
        DISPLAY_CASE_DIMS.glass = 0.36;
        DISPLAY_CASE_DIMS.base  = 0.025;
        _persistDims();
        if (typeof window.__onSelectionChange === 'function' && selectedItem) {
          window.__onSelectionChange(selectedItem, true);
        }
      });
      wrap.appendChild(resetDimsBtn);
    }

    // ---- Pixar lamp-specific: animation crop + speed + hinges + bulb -
    if (/pixar.?lamp|luxo/i.test(item.label || '') && item.group?.userData?.__pixarLampState) {
      const sepL = document.createElement('div');
      sepL.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepL);
      const lh = document.createElement('div');
      lh.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffd9a8;';
      lh.textContent = '🛋 Pixar lamp';
      wrap.appendChild(lh);
      wrap.appendChild(pillInfo('Crop the looping animation, scrub speed, freeze the pose, and tune the bulb to taste.'));

      const ls = item.group.userData.__pixarLampState;
      const ud = item.group.userData;
      const lampUndo = makePanelUndo();

      function rebuildAction() {
        if (!ls.mixer || !ls.originalClip) return;
        if (ls.currentAction) ls.currentAction.stop();
        const sub = makeLampSubclip(ls.originalClip, ls.trimStart, ls.trimEnd) || ls.originalClip;
        const action = ls.mixer.clipAction(sub);
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.timeScale = ls.speed;
        action.paused = ls.paused;
        action.play();
        ls.currentAction = action;
      }
      function persistLamp() {
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur['pixarLamp.trimStart']     = ls.trimStart;
          cur['pixarLamp.trimEnd']       = ls.trimEnd;
          cur['pixarLamp.speed']         = ls.speed;
          cur['pixarLamp.paused']        = ls.paused;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
      }
      function applyAnim() {
        // Speed + paused can be applied without rebuilding the action.
        if (ls.currentAction) {
          ls.currentAction.timeScale = ls.speed;
          ls.currentAction.paused = ls.paused;
        }
        persistLamp();
      }
      function applyTrim() { rebuildAction(); persistLamp(); }
      function addAnim(key, label, min, max, step, fineStep, onApply) {
        const r = buildSliderRow({ state: ls, key, label, min, max, step, fineStep, undoStack: lampUndo, onApply });
        wrap.appendChild(r.row);
      }
      addAnim('trimStart', `Trim start (sec, of ${ls.duration.toFixed(2)}s)`, 0, Math.max(0.1, ls.duration - 0.1), 0.01, 0.005, applyTrim);
      addAnim('trimEnd',   `Trim end (sec from end)`,                          0, Math.max(0.1, ls.duration - 0.1), 0.01, 0.005, applyTrim);
      addAnim('speed',     `Speed (× normal)`,                                 0.1, 3.0, 0.01, 0.005, applyAnim);

      const pauseRow = document.createElement('div');
      pauseRow.style.cssText = 'display:flex;gap:6px;margin-top:4px;';
      const pauseBtn = document.createElement('button');
      pauseBtn.type = 'button';
      function paintPause() {
        pauseBtn.textContent = ls.paused ? '▶ Play animation' : '⏸ Pause animation';
        pauseBtn.style.cssText = `flex:1;padding:7px;border-radius:6px;border:1px solid ${ls.paused ? 'rgba(120,255,150,0.45)' : 'rgba(255,200,80,0.45)'};background:${ls.paused ? 'rgba(120,255,150,0.12)' : 'rgba(255,200,80,0.12)'};color:#fff;cursor:pointer;font-size:11px;font-weight:600;`;
      }
      paintPause();
      pauseBtn.addEventListener('click', () => {
        ls.paused = !ls.paused;
        applyAnim();
        paintPause();
      });
      pauseRow.appendChild(pauseBtn);
      wrap.appendChild(pauseRow);

      // ---- Hinges (only effective while paused) ----
      const sepH = document.createElement('div');
      sepH.style.cssText = 'height:1px;background:rgba(255,255,255,0.08);margin:6px 0 2px;';
      wrap.appendChild(sepH);
      const hh = document.createElement('div');
      hh.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.85;color:#cfe9ff;';
      hh.textContent = '🔧 End-pose hinges (while paused)';
      wrap.appendChild(hh);
      wrap.appendChild(pillInfo('When the animation is paused, these override the neck + head bone rotations so you can aim the lamp.'));

      function readPersistedHinge(key, fallback) {
        try {
          const v = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}')[key];
          return typeof v === 'number' ? v : fallback;
        } catch { return fallback; }
      }
      const neckInit = ud.__neckRotInit || { x: 0, y: 0, z: 0 };
      const headInit = ud.__headRotInit || { x: 0, y: 0, z: 0 };
      const hingeState = ud.__neckRot && ud.__headRot ? { neckX: ud.__neckRot.x, neckY: ud.__neckRot.y, neckZ: ud.__neckRot.z, headX: ud.__headRot.x, headY: ud.__headRot.y, headZ: ud.__headRot.z } : {
        neckX: readPersistedHinge('pixarLamp.neckX', neckInit.x),
        neckY: readPersistedHinge('pixarLamp.neckY', neckInit.y),
        neckZ: readPersistedHinge('pixarLamp.neckZ', neckInit.z),
        headX: readPersistedHinge('pixarLamp.headX', headInit.x),
        headY: readPersistedHinge('pixarLamp.headY', headInit.y),
        headZ: readPersistedHinge('pixarLamp.headZ', headInit.z),
      };
      ud.__neckRot = { x: hingeState.neckX, y: hingeState.neckY, z: hingeState.neckZ };
      ud.__headRot = { x: hingeState.headX, y: hingeState.headY, z: hingeState.headZ };
      function applyHinges() {
        ud.__neckRot.x = hingeState.neckX; ud.__neckRot.y = hingeState.neckY; ud.__neckRot.z = hingeState.neckZ;
        ud.__headRot.x = hingeState.headX; ud.__headRot.y = hingeState.headY; ud.__headRot.z = hingeState.headZ;
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur['pixarLamp.neckX'] = hingeState.neckX;
          cur['pixarLamp.neckY'] = hingeState.neckY;
          cur['pixarLamp.neckZ'] = hingeState.neckZ;
          cur['pixarLamp.headX'] = hingeState.headX;
          cur['pixarLamp.headY'] = hingeState.headY;
          cur['pixarLamp.headZ'] = hingeState.headZ;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
      }
      function addHinge(key, lbl) {
        const r = buildSliderRow({ state: hingeState, key, label: lbl, min: -Math.PI, max: Math.PI, step: 0.01, fineStep: 0.005, undoStack: lampUndo, onApply: applyHinges });
        wrap.appendChild(r.row);
      }
      addHinge('neckX', 'Neck rot X');
      addHinge('neckY', 'Neck rot Y');
      addHinge('neckZ', 'Neck rot Z');
      addHinge('headX', 'Head rot X');
      addHinge('headY', 'Head rot Y');
      addHinge('headZ', 'Head rot Z');

      // ---- Bulb light ----
      const sepBb = document.createElement('div');
      sepBb.style.cssText = 'height:1px;background:rgba(255,255,255,0.08);margin:6px 0 2px;';
      wrap.appendChild(sepBb);
      const bh = document.createElement('div');
      bh.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.85;color:#ffd9a8;';
      bh.textContent = '💡 Bulb';
      wrap.appendChild(bh);
      wrap.appendChild(pillInfo('Same warm-bulb rig the original Luxo uses — point glow + spot pool. Tune intensity to taste.'));
      const bulbState = {
        bulbIntensity: typeof JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}')['pixarLamp.bulbIntensity'] === 'number'
          ? JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}')['pixarLamp.bulbIntensity'] : 1.4,
        spotIntensity: typeof JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}')['pixarLamp.spotIntensity'] === 'number'
          ? JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}')['pixarLamp.spotIntensity'] : 4.0,
      };
      function applyBulb() {
        if (ud.__bulb) ud.__bulb.intensity = bulbState.bulbIntensity;
        if (ud.__spot) ud.__spot.intensity = bulbState.spotIntensity;
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur['pixarLamp.bulbIntensity'] = bulbState.bulbIntensity;
          cur['pixarLamp.spotIntensity'] = bulbState.spotIntensity;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
      }
      applyBulb();
      function addBulbSlider(key, lbl, min, max) {
        const r = buildSliderRow({ state: bulbState, key, label: lbl, min, max, step: 0.01, fineStep: 0.005, undoStack: lampUndo, onApply: applyBulb });
        wrap.appendChild(r.row);
      }
      addBulbSlider('bulbIntensity', 'Bulb point intensity', 0, 6);
      addBulbSlider('spotIntensity', 'Bulb spot intensity',  0, 12);
    }

    // ---- Woody-specific: per-joint hinge editor ----------------------
    if (/woody/i.test(item.label || '') && item.group?.userData?.__woodyBones) {
      const sepW = document.createElement('div');
      sepW.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepW);
      const wh = document.createElement('div');
      wh.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffd9a8;';
      wh.textContent = '🤠 Woody hinges';
      wrap.appendChild(wh);
      wrap.appendChild(pillInfo('Pick a body part, then drag the X / Y / Z sliders to rotate that joint. Hit "🚶 Reset straight" to return every joint to the bind pose.'));
      const ud = item.group.userData;
      const bones = ud.__woodyBones;
      const rest = ud.__woodyRestPose || {};
      const HINGE_KEYS = ud.__woodyHingeKeys || Object.keys(bones);
      // Persist + read full pose.
      function readFullPose() {
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          return cur[`${storeKey}.woody.fullPose`] || {};
        } catch { return {}; }
      }
      function writeFullPose(p) {
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur[`${storeKey}.woody.fullPose`] = p;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
      }
      // ---- Smart compound pose sliders --------------------------------
      // Each compound drives BOTH sides of the body together (e.g.
      // "Both hips forward" rotates LeftUpLeg + RightUpLeg in lockstep)
      // using world-axis rotations so the math is deterministic. Values
      // are deltas in radians applied on TOP of the bind pose. The
      // entire composition is reset-then-overlay every apply, which is
      // why dragging one slider doesn't compound earlier slider values.
      const X_AXIS = new THREE.Vector3(1, 0, 0);
      const Z_AXIS = new THREE.Vector3(0, 0, 1);
      function rotW(boneKey, axis, angle) {
        const b = bones[boneKey];
        if (!b || Math.abs(angle) < 1e-5) return;
        b.rotateOnWorldAxis(axis, angle);
      }
      function resetToBind() {
        for (const k of HINGE_KEYS) {
          const b = bones[k];
          const r = rest[k];
          if (b && r) { b.rotation.x = r.x; b.rotation.y = r.y; b.rotation.z = r.z; }
        }
        if (item.group) item.group.updateMatrixWorld(true);
      }
      // Persisted compound state (per-item).
      const compound = (() => {
        let stored;
        try { stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}')[`${storeKey}.woody.compound`]; } catch {}
        return Object.assign({
          // Hip joint = upper legs swing relative to the pelvis. Affects
          // ONLY the legs (LeftUpLeg + RightUpLeg) — the torso stays put.
          hipJointFwd: 0,
          // Hip BONE = the pelvis itself. Mixamo's Hips is the root, so
          // rotating it tilts the WHOLE body. Useful for "lean the
          // entire figure backward without moving anything else".
          hipsBoneFwd: 0,
          hipSpread: 0,     // splay legs apart (knees out)
          kneeBend: 0,
          ankleFlex: 0,
          spineFwd: 0,
          neckFwd: 0,
          armDown: 0,
          armFwd: 0,
          elbowBend: 0,
          handCurl: 0,
        }, stored || {});
      })();
      // Per-joint overrides (set by the joint picker below). They sit
      // ON TOP of whatever compound rotations have been applied, so
      // pulling a compound slider doesn't wipe your hand fine-tune.
      function readOverrides() {
        try { return JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}')[`${storeKey}.woody.overrides`] || {}; }
        catch { return {}; }
      }
      function writeOverrides(ovr) {
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur[`${storeKey}.woody.overrides`] = ovr;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
      }
      function applyOverridesOnTop() {
        const ovr = readOverrides();
        for (const [k, rot] of Object.entries(ovr)) {
          const b = bones[k];
          if (!b || !rot) continue;
          if (typeof rot.x === 'number') b.rotation.x = rot.x;
          if (typeof rot.y === 'number') b.rotation.y = rot.y;
          if (typeof rot.z === 'number') b.rotation.z = rot.z;
        }
      }
      function applyCompound() {
        resetToBind();
        // 1. WHOLE BODY tilt — rotate the Hips root bone. Everything
        //    descends from Hips, so this tilts the entire figure.
        rotW('Hips', X_AXIS, compound.hipsBoneFwd);
        // 2. HIP JOINTS — just the upper legs swing. Body stays.
        rotW('LeftUpLeg',  X_AXIS, -compound.hipJointFwd);
        rotW('RightUpLeg', X_AXIS, -compound.hipJointFwd);
        // Hip spread (legs apart on the lateral plane). Mirrored.
        rotW('LeftUpLeg',  Z_AXIS, -compound.hipSpread);
        rotW('RightUpLeg', Z_AXIS,  compound.hipSpread);
        // Knees: positive bends them so the shins drop under the seat.
        rotW('LeftLeg',  X_AXIS, compound.kneeBend);
        rotW('RightLeg', X_AXIS, compound.kneeBend);
        rotW('LeftFoot',  X_AXIS, compound.ankleFlex);
        rotW('RightFoot', X_AXIS, compound.ankleFlex);
        rotW('Spine',  X_AXIS, compound.spineFwd);
        rotW('Spine1', X_AXIS, compound.spineFwd * 0.4);
        rotW('Neck',   X_AXIS, compound.neckFwd);
        rotW('Head',   X_AXIS, compound.neckFwd * 0.6);
        rotW('LeftArm',  Z_AXIS, -compound.armDown);
        rotW('RightArm', Z_AXIS,  compound.armDown);
        rotW('LeftArm',  X_AXIS, compound.armFwd);
        rotW('RightArm', X_AXIS, compound.armFwd);
        rotW('LeftForeArm',  X_AXIS, compound.elbowBend);
        rotW('RightForeArm', X_AXIS, compound.elbowBend);
        rotW('LeftHand',  X_AXIS, compound.handCurl);
        rotW('RightHand', X_AXIS, compound.handCurl);
        // OVERLAY any joint-level overrides from the picker — these are
        // your hand-tweaked rotations and must survive compound reapply.
        applyOverridesOnTop();
        // Persist compound + the resulting full pose so reload restores
        // the same look without recomputing.
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur[`${storeKey}.woody.compound`] = { ...compound };
          const fp = {};
          for (const k of HINGE_KEYS) {
            const b = bones[k];
            if (b) fp[k] = { x: b.rotation.x, y: b.rotation.y, z: b.rotation.z };
          }
          cur[`${storeKey}.woody.fullPose`] = fp;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
      }
      const compoundUndo = makePanelUndo();
      const compoundHeader = document.createElement('div');
      compoundHeader.style.cssText = 'font-size:10px;opacity:0.85;margin-top:4px;font-weight:600;color:#cfe9ff;';
      compoundHeader.textContent = '🎮 Quick pose (both sides at once)';
      wrap.appendChild(compoundHeader);
      function addC(key, lbl, min, max) {
        const r = buildSliderRow({ state: compound, key, label: lbl, min, max, step: 0.01, fineStep: 0.005, undoStack: compoundUndo, onApply: applyCompound });
        wrap.appendChild(r.row);
      }
      addC('hipsBoneFwd', 'Whole body tilt (Hips bone)', -Math.PI / 2, Math.PI / 2);
      addC('hipJointFwd','Both LEGS forward at hip',    -Math.PI / 2, Math.PI);
      addC('kneeBend',   'Both knees bend',             -Math.PI / 2, Math.PI);
      addC('hipSpread',  'Legs apart',                  -1.0,          1.0);
      addC('ankleFlex',  'Both ankles flex',            -0.6,          0.6);
      addC('spineFwd',   'Spine forward',               -0.6,          0.8);
      addC('neckFwd',    'Head forward',                -0.6,          0.6);
      addC('armDown',    'Both arms drop (T → A)',       0,            Math.PI);
      addC('armFwd',     'Both arms forward',           -0.6,          1.6);
      addC('elbowBend',  'Both elbows bend',            -Math.PI / 2,  Math.PI);
      addC('handCurl',   'Both wrists curl',            -0.6,          0.6);
      // ---- Quick presets that set compound sliders ---------------
      const PRESETS = {
        '🪑 Sit on shelf': { hipsBoneFwd: 0, hipJointFwd: Math.PI / 2, kneeBend: Math.PI / 2, ankleFlex: 0.10, spineFwd: -0.05, neckFwd: 0.05, armDown: Math.PI / 2, armFwd: 0.0, elbowBend: Math.PI / 4, handCurl: 0, hipSpread: 0.0 },
        '🪑 Hands on lap':  { hipsBoneFwd: 0, hipJointFwd: Math.PI / 2, kneeBend: Math.PI / 2, ankleFlex: 0.10, spineFwd: 0.10,  neckFwd: 0.10, armDown: Math.PI / 2, armFwd: 0.4, elbowBend: Math.PI / 2, handCurl: 0.3, hipSpread: 0.0 },
        '🤠 Standing':      { hipsBoneFwd: 0, hipJointFwd: 0, kneeBend: 0, ankleFlex: 0, spineFwd: 0, neckFwd: 0, armDown: Math.PI / 2, armFwd: 0, elbowBend: 0.10, handCurl: 0, hipSpread: 0.0 },
        '💤 Slouched':      { hipsBoneFwd: 0, hipJointFwd: Math.PI / 2.2, kneeBend: Math.PI / 2.0, ankleFlex: 0.12, spineFwd: 0.30, neckFwd: 0.20, armDown: Math.PI / 2, armFwd: 0.20, elbowBend: Math.PI / 4, handCurl: 0.10, hipSpread: 0.0 },
        '🚶 Reset straight': { hipsBoneFwd: 0, hipJointFwd: 0, kneeBend: 0, ankleFlex: 0, spineFwd: 0, neckFwd: 0, armDown: 0, armFwd: 0, elbowBend: 0, handCurl: 0, hipSpread: 0 },
      };
      const presetRow = document.createElement('div');
      presetRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;';
      for (const [name, vals] of Object.entries(PRESETS)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = name;
        b.style.cssText = 'flex:1 1 45%;padding:7px;border-radius:6px;border:1px solid rgba(255,200,150,0.40);background:rgba(255,200,150,0.10);color:#fff;cursor:pointer;font:11px system-ui;font-weight:600;';
        b.addEventListener('click', () => {
          Object.assign(compound, vals);
          // "Reset straight" wipes overrides too — true clean slate.
          // Other presets keep your hand fine-tunes.
          if (name === '🚶 Reset straight') writeOverrides({});
          applyCompound();
          buildItemEditor(item);
        });
        presetRow.appendChild(b);
      }
      wrap.appendChild(presetRow);
      // 🔄 Forward-axis flip (in case Woody is authored facing -Z so
      // every world-axis sign is inverted). Single click flips ALL
      // compound rotation signs and re-applies.
      const flipRow = document.createElement('div');
      flipRow.style.cssText = 'display:flex;gap:6px;margin-top:4px;';
      const flipBtn = document.createElement('button');
      flipBtn.type = 'button';
      flipBtn.textContent = '🔄 Flip front/back (if poses go backwards)';
      flipBtn.style.cssText = 'flex:1;padding:6px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:#fff;cursor:pointer;font:10px system-ui;';
      flipBtn.addEventListener('click', () => {
        for (const k of ['hipsBoneFwd', 'hipJointFwd', 'kneeBend', 'ankleFlex', 'spineFwd', 'neckFwd', 'armFwd', 'elbowBend', 'handCurl']) {
          compound[k] = -compound[k];
        }
        applyCompound();
        buildItemEditor(item);
      });
      flipRow.appendChild(flipBtn);
      wrap.appendChild(flipRow);

      // Apply once on open so the saved compound is reflected live.
      applyCompound();

      // ---- World-axis pose presets -------------------------------------
      // Earlier presets used per-bone local Euler values, which are
      // unreliable on Mixamo skeletons because each bone's local frame
      // can be authored differently. These presets instead use
      // `bone.rotateOnWorldAxis(axis, angle)` — the rotations happen
      // ---- Saved poses (user-built, persisted) -------------------------
      const POSE_LIB_KEY = 'woody.poseLibrary.v1';
      function loadPoseLib() {
        try {
          const v = JSON.parse(localStorage.getItem(POSE_LIB_KEY) || '{}');
          return (v && typeof v === 'object') ? v : {};
        } catch { return {}; }
      }
      function savePoseLib(lib) {
        try { localStorage.setItem(POSE_LIB_KEY, JSON.stringify(lib)); } catch {}
      }
      function snapshotPoseFull() {
        const fp = {};
        for (const k of HINGE_KEYS) {
          const b = bones[k];
          if (b) fp[k] = { x: b.rotation.x, y: b.rotation.y, z: b.rotation.z };
        }
        return fp;
      }
      function applyPose(pose) {
        for (const k of HINGE_KEYS) {
          const b = bones[k];
          const r = rest[k];
          if (b && r) { b.rotation.x = r.x; b.rotation.y = r.y; b.rotation.z = r.z; }
        }
        for (const [k, rot] of Object.entries(pose)) {
          const b = bones[k];
          if (!b || !rot) continue;
          if (typeof rot.x === 'number') b.rotation.x = rot.x;
          if (typeof rot.y === 'number') b.rotation.y = rot.y;
          if (typeof rot.z === 'number') b.rotation.z = rot.z;
        }
        writeFullPose(snapshotPoseFull());
      }
      // Save current pose button
      const saveRow = document.createElement('div');
      saveRow.style.cssText = 'display:flex;gap:6px;margin-top:4px;';
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.textContent = '💾 Save current pose as…';
      saveBtn.style.cssText = 'flex:1;padding:7px;border-radius:6px;border:1px solid rgba(150,200,255,0.45);background:rgba(150,200,255,0.10);color:#fff;cursor:pointer;font:11px system-ui;font-weight:600;';
      saveBtn.addEventListener('click', () => {
        const name = prompt('Name this pose (e.g. "Sitting on shelf"):');
        if (!name) return;
        const lib = loadPoseLib();
        lib[name] = snapshotPoseFull();
        savePoseLib(lib);
        buildItemEditor(item);
      });
      saveRow.appendChild(saveBtn);
      wrap.appendChild(saveRow);
      // List of saved poses — apply / delete each.
      const lib = loadPoseLib();
      const libNames = Object.keys(lib);
      if (libNames.length) {
        const libHeader = document.createElement('div');
        libHeader.style.cssText = 'font-size:10px;opacity:0.7;margin-top:6px;text-transform:uppercase;letter-spacing:0.4px;';
        libHeader.textContent = 'Saved poses';
        wrap.appendChild(libHeader);
        for (const name of libNames) {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;gap:6px;margin-top:3px;';
          const apply = document.createElement('button');
          apply.type = 'button';
          apply.textContent = name;
          apply.style.cssText = 'flex:1;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,200,150,0.40);background:rgba(255,200,150,0.10);color:#fff;cursor:pointer;font:11px system-ui;text-align:left;';
          apply.addEventListener('click', () => {
            applyPose(lib[name]);
            buildItemEditor(item);
          });
          const del = document.createElement('button');
          del.type = 'button';
          del.textContent = '✕';
          del.title = `Delete pose "${name}"`;
          del.style.cssText = 'flex:0 0 28px;padding:6px;border-radius:6px;border:1px solid rgba(255,120,120,0.45);background:transparent;color:#ffb3b3;cursor:pointer;font-size:11px;';
          del.addEventListener('click', () => {
            const cur = loadPoseLib();
            delete cur[name];
            savePoseLib(cur);
            buildItemEditor(item);
          });
          row.append(apply, del);
          wrap.appendChild(row);
        }
      } else {
        const note = document.createElement('div');
        note.style.cssText = 'font-size:10px;opacity:0.55;margin-top:4px;line-height:1.45;';
        note.textContent = 'No saved poses yet. Build one with the joint picker below, then hit "💾 Save current pose as…".';
        wrap.appendChild(note);
      }
      // ---- Joint picker ----
      const jointRow = document.createElement('div');
      jointRow.style.cssText = 'display:flex;gap:6px;align-items:center;margin-top:6px;';
      const jLab = document.createElement('span');
      jLab.textContent = '🦴 Joint:';
      jLab.style.cssText = 'font-size:11px;opacity:0.85;';
      const jSel = document.createElement('select');
      jSel.style.cssText = 'flex:1;padding:6px 8px;border-radius:6px;background:#111;color:#fff;border:1px solid rgba(255,255,255,0.18);font:11px system-ui;';
      // Persist last picked joint per item so the dropdown remembers
      // selection after editor rebuilds.
      let selKey;
      try {
        const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
        selKey = cur[`${storeKey}.woody.lastJoint`];
      } catch {}
      // Group joints by region for readability.
      const GROUPS = [
        { name: 'Spine + head',   keys: ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head'] },
        { name: 'Left arm',       keys: ['LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand'] },
        { name: 'Right arm',      keys: ['RightShoulder', 'RightArm', 'RightForeArm', 'RightHand'] },
        { name: 'Left leg',       keys: ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase'] },
        { name: 'Right leg',      keys: ['RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase'] },
      ];
      let firstAvailable = null;
      for (const g of GROUPS) {
        const og = document.createElement('optgroup');
        og.label = g.name;
        for (const k of g.keys) {
          if (!bones[k]) continue;
          const opt = document.createElement('option');
          opt.value = k;
          opt.textContent = k;
          og.appendChild(opt);
          if (!firstAvailable) firstAvailable = k;
        }
        if (og.children.length) jSel.appendChild(og);
      }
      const initial = (selKey && bones[selKey]) ? selKey : firstAvailable;
      if (initial) jSel.value = initial;
      jointRow.append(jLab, jSel);
      wrap.appendChild(jointRow);
      // ---- Per-joint XYZ sliders ----
      const xyzWrap = document.createElement('div');
      xyzWrap.style.cssText = 'display:flex;flex-direction:column;gap:2px;margin-top:4px;';
      wrap.appendChild(xyzWrap);
      const woodyUndo = makePanelUndo();
      function rebuildXYZSliders() {
        while (xyzWrap.firstChild) xyzWrap.removeChild(xyzWrap.firstChild);
        const k = jSel.value;
        const b = bones[k];
        if (!b) {
          const note = document.createElement('div');
          note.style.cssText = 'font-size:11px;color:#ffb3b3;padding:6px;border:1px solid rgba(255,120,120,0.35);border-radius:6px;background:rgba(255,120,120,0.06);';
          note.textContent = `Bone "${k}" not found in this skeleton.`;
          xyzWrap.appendChild(note);
          return;
        }
        const jointState = {
          x: b.rotation.x,
          y: b.rotation.y,
          z: b.rotation.z,
        };
        function applyJoint() {
          b.rotation.x = jointState.x;
          b.rotation.y = jointState.y;
          b.rotation.z = jointState.z;
          // Save into both the OVERRIDES layer (so a future compound
          // re-apply keeps the tweak) AND the legacy fullPose snapshot
          // (so a fresh reload's apply-pose path still works).
          const ovr = readOverrides();
          ovr[k] = { x: jointState.x, y: jointState.y, z: jointState.z };
          writeOverrides(ovr);
          const fp = readFullPose();
          fp[k] = { x: jointState.x, y: jointState.y, z: jointState.z };
          writeFullPose(fp);
          try {
            const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
            cur[`${storeKey}.woody.lastJoint`] = k;
            localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
          } catch {}
        }
        function add(axis, lbl) {
          const r = buildSliderRow({ state: jointState, key: axis, label: lbl, min: -Math.PI, max: Math.PI, step: 0.01, fineStep: 0.005, undoStack: woodyUndo, onApply: applyJoint });
          xyzWrap.appendChild(r.row);
        }
        add('x', `${k} — Rotate X`);
        add('y', `${k} — Rotate Y`);
        add('z', `${k} — Rotate Z`);
        // Per-joint reset.
        const jr = document.createElement('button');
        jr.type = 'button';
        jr.textContent = `↺ Reset ${k}`;
        jr.style.cssText = 'padding:6px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:#fff;cursor:pointer;font-size:11px;margin-top:2px;';
        jr.addEventListener('click', () => {
          const r = rest[k] || { x: 0, y: 0, z: 0 };
          b.rotation.x = r.x; b.rotation.y = r.y; b.rotation.z = r.z;
          // Drop this joint from BOTH the overrides AND fullPose so a
          // future compound apply doesn't bring it back.
          const ovr = readOverrides();
          delete ovr[k];
          writeOverrides(ovr);
          const fp = readFullPose();
          delete fp[k];
          writeFullPose(fp);
          rebuildXYZSliders();
        });
        xyzWrap.appendChild(jr);
      }
      jSel.addEventListener('change', () => {
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur[`${storeKey}.woody.lastJoint`] = jSel.value;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
        rebuildXYZSliders();
      });
      rebuildXYZSliders();
    }

    // ---- Frame match (any item) --------------------------------------
    // Every item gets a "🖼 Frame match" section: pair the Speed frame
    // with this item so the frame floats above (or wherever you place
    // it) and follows the item when it moves. The pair-lock + drag-end
    // re-lock work the same as for Speed Racer ↔ Speed frame.
    if (item.label !== 'Speed frame' && !/^Frame \d+$/.test(item.label || '')) {
      const frameBody = wrapSection('🖼 Frame match', '#ffd9a8', false);

      // Discover every available frame in the scene: the Speed frame plus
      // every "Frame N" instance from `extraFrames.v1`. Each entry has the
      // frame's group + its label so we can highlight it on hover and
      // pair it on click.
      function listAllFrames() {
        const out = [];
        const speed = window.__artFrameGroup;
        if (speed) out.push({ label: 'Speed frame', group: speed });
        const extras = (() => { try { return JSON.parse(localStorage.getItem('extraFrames.v1') || '[]'); } catch { return []; } })();
        for (const e of extras) {
          if (!e?.label) continue;
          const grp = scene.getObjectByName(`__prop_extraframe_${e.label.replace(/\s+/g, '_')}`);
          if (grp) out.push({ label: e.label, group: grp });
        }
        return out;
      }

      // Returns the frame group currently paired with THIS item (in either
      // direction), or null if none.
      function findPairedFrame() {
        const all = listAllFrames();
        for (const f of all) {
          const fInfo = _pairLocked.get(f.group);
          if (fInfo && fInfo.anchorGroup === g) return f;
          const gInfo = _pairLocked.get(g);
          if (gInfo && gInfo.anchorGroup === f.group) return f;
        }
        return null;
      }

      // Highlight a frame by toggling an orange emissive on its meshes.
      // Snapshots the original emissive once (in userData) so multiple
      // hovers don't compound and we restore exactly the prior color.
      function setHighlight(frameGroup, on) {
        if (!frameGroup) return;
        frameGroup.traverse((o) => {
          if (!o.isMesh || !o.material) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach((m) => {
            if (!('emissive' in m)) return;
            if (!m.userData) m.userData = {};
            if (on) {
              if (m.userData._frameHighlightSaved == null) {
                m.userData._frameHighlightSaved = m.emissive.getHex();
                m.userData._frameHighlightSavedIntensity = m.emissiveIntensity ?? 1;
              }
              m.emissive.setHex(0xffa040);
              m.emissiveIntensity = 1.4;
            } else {
              if (m.userData._frameHighlightSaved != null) {
                m.emissive.setHex(m.userData._frameHighlightSaved);
                m.emissiveIntensity = m.userData._frameHighlightSavedIntensity ?? 1;
                m.userData._frameHighlightSaved = null;
              }
            }
            m.needsUpdate = true;
          });
        });
      }

      function unmatchFrameFromThis(targetGroup, targetLabel) {
        // Frame is follower of this item.
        const fInfo = _pairLocked.get(targetGroup);
        if (fInfo && fInfo.anchorGroup === g) {
          if (typeof window.__pairUnlock === 'function') window.__pairUnlock(targetGroup);
          if (typeof window.__persistUnpair === 'function') window.__persistUnpair(targetLabel);
        }
        // This item is follower of the frame.
        const gInfo = _pairLocked.get(g);
        if (gInfo && gInfo.anchorGroup === targetGroup) {
          if (typeof window.__pairUnlock === 'function') window.__pairUnlock(g);
          if (typeof window.__persistUnpair === 'function') window.__persistUnpair(item.label);
        }
      }

      function matchFrameToThis(targetGroup, targetLabel) {
        // Wipe any prior pair on this frame OR on this item so we land
        // in a clean state, then create the new lock.
        if (typeof window.__pairUnlock === 'function') window.__pairUnlock(targetGroup);
        if (typeof window.__persistUnpair === 'function') window.__persistUnpair(targetLabel);
        if (_pairLocked.has(g)) {
          if (typeof window.__pairUnlock === 'function') window.__pairUnlock(g);
          if (typeof window.__persistUnpair === 'function') window.__persistUnpair(item.label);
        }
        // Also break any OTHER frame currently paired to this item.
        const prior = findPairedFrame();
        if (prior && prior.group !== targetGroup) unmatchFrameFromThis(prior.group, prior.label);
        if (typeof window.__pairLock === 'function') window.__pairLock(g, targetGroup);
        if (typeof window.__persistPair === 'function') window.__persistPair(item.label, targetLabel);
      }

      const frames = listAllFrames();
      if (frames.length === 0) {
        frameBody.appendChild(pillInfo('No frames in the scene yet — use 🖼 Add frame here below to spawn one.'));
      } else {
        const pickerLabel = document.createElement('div');
        pickerLabel.textContent = '🖼 Pick a frame (hover to highlight, click to pair)';
        pickerLabel.style.cssText = 'font:11px system-ui;color:#ffd9a8;opacity:0.9;margin-bottom:3px;';
        frameBody.appendChild(pickerLabel);
        // One row per frame.
        const rows = [];
        function paintRows() {
          const paired = findPairedFrame();
          rows.forEach(({ btn, frame }) => {
            const isMatched = paired && paired.group === frame.group;
            btn.textContent = isMatched ? `✓ ${frame.label} (matched — click to unmatch)` : `${frame.label}`;
            btn.style.cssText = `padding:6px 9px;border-radius:6px;border:1px solid ${isMatched ? 'rgba(255,200,80,0.65)' : 'rgba(125,160,255,0.40)'};background:${isMatched ? 'rgba(255,200,80,0.18)' : 'transparent'};color:#fff;cursor:pointer;font:11px system-ui;text-align:left;width:100%;`;
          });
        }
        for (const f of frames) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.addEventListener('mouseenter', () => setHighlight(f.group, true));
          btn.addEventListener('mouseleave', () => setHighlight(f.group, false));
          btn.addEventListener('click', () => {
            // Make sure highlight is cleared before mutation so emissive
            // saved values aren't poisoned by the rebuild.
            setHighlight(f.group, false);
            const paired = findPairedFrame();
            if (paired && paired.group === f.group) {
              unmatchFrameFromThis(f.group, f.label);
            } else {
              matchFrameToThis(f.group, f.label);
            }
            buildItemEditor(item);
          });
          frameBody.appendChild(btn);
          rows.push({ btn, frame: f });
        }
        paintRows();
      }

      // Add a fresh horizontal frame BELOW this item.
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.textContent = '🖼 Add frame here (horizontal, under item)';
      addBtn.style.cssText = 'padding:7px;border-radius:6px;border:1px solid rgba(120,255,150,0.45);background:rgba(120,255,150,0.10);color:#fff;cursor:pointer;font:11px system-ui;font-weight:600;width:100%;margin-top:6px;';
      addBtn.addEventListener('click', () => {
        if (typeof window.__spawnFrameForItem === 'function') {
          window.__spawnFrameForItem(g, item.label);
          buildItemEditor(item);
        }
      });
      frameBody.appendChild(addBtn);

      // Offset sliders for whichever frame is currently matched.
      const matched = findPairedFrame();
      if (matched) {
        const info = _pairLocked.get(matched.group);
        const offset = { x: info.offset.x, y: info.offset.y, z: info.offset.z };
        function applyOffset() {
          if (info?.offset) {
            info.offset.set(offset.x, offset.y, offset.z);
            info.offsetDirty = true;
          }
          if (typeof persistPairOffset === 'function') persistPairOffset(matched.label);
        }
        const sliderHdr = document.createElement('div');
        sliderHdr.textContent = `Offset to "${matched.label}"`;
        sliderHdr.style.cssText = 'font:11px system-ui;color:#ffd9a8;opacity:0.85;margin-top:6px;';
        frameBody.appendChild(sliderHdr);
        function addF(key, lbl, min, max) {
          const r = buildSliderRow({ state: offset, key, label: lbl, min, max, step: 0.005, fineStep: 0.001, undoStack: undo, onApply: applyOffset });
          frameBody.appendChild(r.row);
        }
        addF('x', 'Frame X (left ↔ right)', -3, 3);
        addF('y', 'Frame Y (down ↔ up)',    -2, 4);
        addF('z', 'Frame Z (back ↔ front)', -3, 3);
      }
    }

    // ---- Mask stand fill light (Spider-Man / Symbiote / Black Panther) -
    if (item.label === 'Spider-Man mask' || item.label === 'Symbiote mask' || item.label === 'Black Panther mask') {
      const fill = g?.userData?.__maskFillLight;
      if (fill) {
        const sepML = document.createElement('div');
        sepML.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
        wrap.appendChild(sepML);
        const mlh = document.createElement('div');
        mlh.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffd9a8;';
        mlh.textContent = '💡 Mask fill light';
        wrap.appendChild(mlh);
        wrap.appendChild(pillInfo('Tiny warm point light inside the mask recess so it reads even in dim light. Intensity 0 = off. Color shifts the warmth.'));
        const safe = item.label.replace(/ /g, '_');
        const mlState = {
          intensity: fill.intensity ?? 0.20,
          distance:  fill.distance  ?? 0.5,
          tintR:     fill.color?.r  ?? 1.0,
          tintG:     fill.color?.g  ?? 0.94,
          tintB:     fill.color?.b  ?? 0.85,
        };
        function _applyML() {
          fill.intensity = mlState.intensity;
          fill.distance  = mlState.distance;
          fill.color.setRGB(mlState.tintR, mlState.tintG, mlState.tintB);
          try {
            const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
            cur[`maskLight.${safe}.intensity`] = mlState.intensity;
            cur[`maskLight.${safe}.distance`]  = mlState.distance;
            cur[`maskLight.${safe}.tintR`]     = mlState.tintR;
            cur[`maskLight.${safe}.tintG`]     = mlState.tintG;
            cur[`maskLight.${safe}.tintB`]     = mlState.tintB;
            localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
          } catch {}
        }
        const mlUndo = makePanelUndo();
        function addML(key, lbl, min, max) {
          const r = buildSliderRow({ state: mlState, key, label: lbl, min, max, step: 0.005, fineStep: 0.001, undoStack: mlUndo, onApply: _applyML });
          wrap.appendChild(r.row);
        }
        addML('intensity', 'Light intensity (0 = off)', 0, 4);
        addML('distance',  'Light range (falloff)', 0.05, 2);
        addML('tintR',     'Light tint R', 0, 1);
        addML('tintG',     'Light tint G', 0, 1);
        addML('tintB',     'Light tint B', 0, 1);
      }
    }

    // ---- Scream canister: offset on the Scream case -----------------
    if (/scream.?canister|monsters.?inc.*canister/i.test(item.label || '')) {
      function _findScreamPairInfo() {
        if (!g || typeof _pairLocked === 'undefined') return null;
        const info = _pairLocked.get(g);
        if (!info || !info.anchorGroup) return null;
        if (info.anchorGroup !== window.__screamCaseGroup) return null;
        return info;
      }
      const screamPair = _findScreamPairInfo();
      if (screamPair) {
        const sepCN = document.createElement('div');
        sepCN.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
        wrap.appendChild(sepCN);
        const cnh = document.createElement('div');
        cnh.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffd9a8;';
        cnh.textContent = '😱 Canister pose inside case';
        wrap.appendChild(cnh);
        wrap.appendChild(pillInfo('Case is the anchor — the canister follows it. Tune where the canister sits inside (X/Y/Z relative to the case base).'));
        const cnOffset = { x: screamPair.offset.x, y: screamPair.offset.y, z: screamPair.offset.z };
        function applyCNOffset() {
          const info = _findScreamPairInfo();
          if (info?.offset) {
            info.offset.set(cnOffset.x, cnOffset.y, cnOffset.z);
            info.offsetDirty = true;
          }
          if (typeof persistPairOffset === 'function') persistPairOffset(item.label);
        }
        const cnUndo = makePanelUndo();
        function addCNRow(key, lbl, min, max) {
          const r = buildSliderRow({ state: cnOffset, key, label: lbl, min, max, step: 0.005, fineStep: 0.001, undoStack: cnUndo, onApply: applyCNOffset });
          wrap.appendChild(r.row);
        }
        addCNRow('x', 'Canister X (left ↔ right inside case)', -1.5, 1.5);
        addCNRow('y', 'Canister Y (down ↔ up inside case)',    -1.0, 2.0);
        addCNRow('z', 'Canister Z (back ↔ front inside case)', -1.5, 1.5);
      }
    }

    // ---- Stitch's Great Escape sign: offset on the Stitch case ------
    if (/stitch.*escape/i.test(item.label || '')) {
      function _findStitchPairInfo() {
        if (!g || typeof _pairLocked === 'undefined') return null;
        const info = _pairLocked.get(g);
        if (!info || !info.anchorGroup) return null;
        if (info.anchorGroup !== window.__stitchCaseGroup) return null;
        return info;
      }
      const stitchPair = _findStitchPairInfo();
      if (stitchPair) {
        const sepSig = document.createElement('div');
        sepSig.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
        wrap.appendChild(sepSig);
        const sigh = document.createElement('div');
        sigh.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffd9a8;';
        sigh.textContent = '👽 Sign pose inside case';
        wrap.appendChild(sigh);
        wrap.appendChild(pillInfo('Case is the anchor — the Stitch sign follows it. Tune where the sign sits inside (X/Y/Z relative to the case base).'));
        const sigOffset = { x: stitchPair.offset.x, y: stitchPair.offset.y, z: stitchPair.offset.z };
        function applySigOffset() {
          const info = _findStitchPairInfo();
          if (info?.offset) {
            info.offset.set(sigOffset.x, sigOffset.y, sigOffset.z);
            info.offsetDirty = true;
          }
          if (typeof persistPairOffset === 'function') persistPairOffset(item.label);
        }
        const sigUndo = makePanelUndo();
        function addSigRow(key, lbl, min, max) {
          const r = buildSliderRow({ state: sigOffset, key, label: lbl, min, max, step: 0.005, fineStep: 0.001, undoStack: sigUndo, onApply: applySigOffset });
          wrap.appendChild(r.row);
        }
        addSigRow('x', 'Sign X (left ↔ right inside case)', -1.5, 1.5);
        addSigRow('y', 'Sign Y (down ↔ up inside case)',    -1.0, 2.0);
        addSigRow('z', 'Sign Z (back ↔ front inside case)', -1.5, 1.5);
      }
    }

    // ---- Ice Age Nut: crop + animation pause -------------------------
    if (/ice.?age.?nut/i.test(item.label || '')) {
      const sepN = document.createElement('div');
      sepN.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepN);

      // ---- Merge into ONE prop with the Nut case ------------------
      // Re-parents the nut UNDER the case group, so they become a single
      // prop graph that moves AND scales together. THREE's transform
      // inheritance means a case scale of 2× automatically scales the
      // nut too; a case rotation rotates the nut. Persisted via the
      // `nutCase.merged` sentinel so reload reconstructs the parent
      // link after both groups exist.
      const mergeWrap = document.createElement('div');
      mergeWrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-bottom:6px;';
      const mergeHdr = document.createElement('div');
      mergeHdr.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffd9a8;';
      mergeHdr.textContent = '🌰 Nut case (merge)';
      mergeWrap.appendChild(mergeHdr);
      mergeWrap.appendChild(pillInfo('Merges this nut INTO the case as one prop. Drag/scale/rotate the case → the nut goes with it. You can still click the nut for crop/pause/scale-relative-to-case.'));
      const mergeBtn = document.createElement('button');
      mergeBtn.type = 'button';
      function _isMerged() {
        const caseGrp = window.__nutCaseGroup;
        return !!(caseGrp && g.parent === caseGrp);
      }
      function paintMergeBtn() {
        const merged = _isMerged();
        mergeBtn.textContent = merged ? '🔓 Separate from case (back to scene root)' : '🔗 Merge with Nut case';
        mergeBtn.style.cssText = `padding:7px;border-radius:6px;border:1px solid ${merged ? 'rgba(255,200,80,0.55)' : 'rgba(125,160,255,0.55)'};background:${merged ? 'rgba(255,200,80,0.15)' : 'rgba(125,160,255,0.12)'};color:#fff;cursor:pointer;font:11px system-ui;font-weight:600;width:100%;`;
      }
      paintMergeBtn();
      mergeBtn.addEventListener('click', () => {
        const caseGrp = window.__nutCaseGroup;
        if (!caseGrp) { alert('Nut case isn\'t in the scene yet — reload first.'); return; }
        if (_isMerged()) {
          // Separate: re-attach to scene root preserving world transform.
          const sceneRoot = window.__macScreen.parent;
          sceneRoot.attach(g);
          g.updateMatrixWorld(true);
          // Persist new scene-root coords + clear the merged sentinel.
          try {
            const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
            cur[`${storeKey}.x`] = g.position.x;
            cur[`${storeKey}.y`] = g.position.y;
            cur[`${storeKey}.z`] = g.position.z;
            cur['nutCase.merged'] = 0;
            localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
          } catch {}
          paintMergeBtn();
          return;
        }
        // MERGE: re-parent under the case (preserves world transform via
        // attach), then snap to top-of-pole in case-local coords so the
        // nut sits ON the pole.
        caseGrp.attach(g);
        const dims = (typeof NUT_CASE_DIMS !== 'undefined') ? NUT_CASE_DIMS : { base: 0.03, poleLength: 0.18 };
        const yOffset = dims.base + dims.poleLength + 0.02;
        g.position.set(0, yOffset, 0);
        g.updateMatrixWorld(true);
        // Persist BOTH the new local coords AND the merged sentinel so
        // boot can re-attach. We DON'T clear the scene-root persisted
        // x/y/z — they're overwritten next time the case attaches the
        // nut on boot.
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur['nutCase.merged'] = 1;
          cur['nutCase.mergedNutLocalY'] = yOffset;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
        paintMergeBtn();
      });
      mergeWrap.appendChild(mergeBtn);
      wrap.appendChild(mergeWrap);

      const nh = document.createElement('div');
      nh.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#cfe9ff;';
      nh.textContent = '🌰 Nut crop + pause';
      wrap.appendChild(nh);
      wrap.appendChild(pillInfo('Six clip planes that hug the nut\'s bbox. 1.0 = no crop on that side; lower values trim more of the mesh away. Pause toggle freezes the GLB animation.'));
      // Pause toggle
      const pauseBtn = document.createElement('button');
      pauseBtn.type = 'button';
      function paintPause() {
        const on = !!window.__getNutPaused();
        pauseBtn.textContent = on ? '⏸ PAUSED — click to resume' : '▶ PLAYING — click to pause';
        pauseBtn.style.cssText = `padding:7px;border-radius:6px;border:1px solid ${on ? 'rgba(255,200,80,0.55)' : 'rgba(125,160,255,0.45)'};background:${on ? 'rgba(255,200,80,0.18)' : 'rgba(125,160,255,0.10)'};color:#fff;cursor:pointer;font:11px system-ui;font-weight:600;width:100%;`;
      }
      paintPause();
      pauseBtn.addEventListener('click', () => {
        window.__NUT_CROP;   // ensure global init
        const cur = !!window.__getNutPaused();
        // Flip + persist + apply.
        try {
          const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          stored['nutCrop.paused'] = cur ? 0 : 1;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(stored));
        } catch {}
        // Mutate the NUT_PAUSED via the persist path: easiest is a tiny shim.
        // We exposed __getNutPaused only. Update via direct global assignment
        // through window scope.
        // Defensive: read the var via persist + apply.
        Object.defineProperty(window, '__NUT_PAUSED_TMP', { configurable:true, value: cur ? 0 : 1 });
        // Update via __applyNutPause + assigning the underlying var via eval-friendly setter.
        // Simpler: we just set the timeScale directly.
        const scene = window.__macScreen.parent;
        const grp = scene.getObjectByName('__prop_bank-ice_age_nut-mp05yot8-34');
        const mixer = grp?.userData?.__animMixer;
        if (mixer) mixer.timeScale = cur ? 1 : 0;
        // Update the closure-scoped NUT_PAUSED through window setter.
        window.__setNutPaused?.(cur ? 0 : 1);
        paintPause();
      });
      wrap.appendChild(pauseBtn);
      // Crop sliders
      const ncState = window.__NUT_CROP;
      function applyNC() {
        try { window.__persistNutCrop(); } catch {}
      }
      const ncUndo = makePanelUndo();
      function addNC(key, lbl) {
        const r2 = buildSliderRow({ state: ncState, key, label: lbl, min: 0, max: 1, step: 0.005, fineStep: 0.001, undoStack: ncUndo, onApply: applyNC });
        wrap.appendChild(r2.row);
      }
      addNC('left',   '⬅ LEFT crop');
      addNC('right',  'RIGHT crop ➡');
      addNC('front',  '◯ FRONT crop (toward you)');
      addNC('back',   '◯ BACK crop (away)');
      addNC('top',    '⬆ TOP crop');
      addNC('bottom', '⬇ BOTTOM crop');
    }

    // ---- Lumiere: flame controls ------------------------------------
    if (/lumiere/i.test(item.label || '')) {
      const sepLF = document.createElement('div');
      sepLF.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepLF);
      const lfh = document.createElement('div');
      lfh.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffd9a8;';
      lfh.textContent = '🔥 Candle flames';
      wrap.appendChild(lfh);
      wrap.appendChild(pillInfo('Three animated flame sprites on Lumiere\'s wicks + warm point lights. Tune size, color, pulse, and per-flame anchor offsets so they line up exactly with each candle wick.'));
      const lfState = window.__FLAME_TUNE;
      function applyLF() {
        try { window.__persistFlameTune(); } catch {}
        try { window.__applyFlameTune(); } catch {}
      }
      const lfUndo = makePanelUndo();
      function addLF(key, lbl, min, max, step = 0.005) {
        const r = buildSliderRow({ state: lfState, key, label: lbl, min, max, step, fineStep: step / 5, undoStack: lfUndo, onApply: applyLF });
        wrap.appendChild(r.row);
      }
      // Master enable + size + flicker
      addLF('enabled',        'Flames on (0/1)',           0, 1, 1);
      addLF('size',           'Flame size',                0.2, 3.0);
      addLF('pulseAmp',       'Pulse amount',              0, 0.6);
      addLF('pulseSpeed',     'Pulse speed',               0.5, 20.0, 0.05);
      // Sprite color
      addLF('hueR',           'Flame R (orange→white)',    0, 1);
      addLF('hueG',           'Flame G',                   0, 1);
      addLF('hueB',           'Flame B (cool ←→ warm)',    0, 1);
      // Light
      addLF('lightIntensity', 'Light intensity',           0, 6);
      addLF('lightDistance',  'Light range',               0.05, 2.0);
      addLF('flickerAmp',     'Light flicker',             0, 1);
      addLF('lightR',         'Light R',                   0, 1);
      addLF('lightG',         'Light G',                   0, 1);
      addLF('lightB',         'Light B',                   0, 1);
      // Per-flame X + scale (left / center / right). Y/Z stay at the
      // baked defaults so the tip sits on the wick — only X position
      // and per-flame size are user-tunable.
      const sepLA = document.createElement('div');
      sepLA.style.cssText = 'height:1px;background:rgba(255,255,255,0.06);margin:4px 0 2px;';
      wrap.appendChild(sepLA);
      wrap.appendChild(pillInfo('Per-flame X position (along Lumiere\'s arms) + per-flame scale. Y/Z auto-pinned to the candle tops. Negative X = left, positive = right.'));
      addLF('c1x',       '⬅ LEFT flame X',          -2, 2, 0.01);
      addLF('c1y',       '⬅ LEFT flame Y (up/down)', 0, 2, 0.005);
      addLF('c1z',       '⬅ LEFT flame Z (depth)',  -1, 1, 0.005);
      addLF('c1scale',   '⬅ LEFT flame scale',      0.1, 4, 0.02);
      addLF('c1bright',  '⬅ LEFT flame intensity',  0, 3, 0.02);
      addLF('c0x',       '◯ CENTER flame X',        -2, 2, 0.01);
      addLF('c0y',       '◯ CENTER flame Y (up/down)', 0, 2, 0.005);
      addLF('c0z',       '◯ CENTER flame Z (depth)', -1, 1, 0.005);
      addLF('c0scale',   '◯ CENTER flame scale',    0.1, 4, 0.02);
      addLF('c0bright',  '◯ CENTER flame intensity', 0, 3, 0.02);
      addLF('c2x',       'RIGHT flame X ➡',         -2, 2, 0.01);
      addLF('c2y',       'RIGHT flame Y (up/down) ➡', 0, 2, 0.005);
      addLF('c2z',       'RIGHT flame Z (depth) ➡', -1, 1, 0.005);
      addLF('c2scale',   'RIGHT flame scale ➡',     0.1, 4, 0.02);
      addLF('c2bright',  'RIGHT flame intensity ➡', 0, 3, 0.02);
    }

    // ---- Beware Ogre: offset on the Ogre case -----------------------
    // When the figurine is paired to the Ogre case (case = anchor,
    // ogre = follower), the user can dial the figurine's relative pose
    // inside the case via three offset sliders — same pattern as the
    // Speed Racer's car-on-frame controls below.
    if (/beware.?ogre/i.test(item.label || '')) {
      function _findOgrePairInfo() {
        if (!g || typeof _pairLocked === 'undefined') return null;
        const info = _pairLocked.get(g);
        if (!info || !info.anchorGroup) return null;
        // Only show this section when the anchor is actually the Ogre case.
        if (info.anchorGroup !== window.__ogreCaseGroup) return null;
        return info;
      }
      const ogrePair = _findOgrePairInfo();
      if (ogrePair) {
        const sepOG = document.createElement('div');
        sepOG.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
        wrap.appendChild(sepOG);
        const ogh = document.createElement('div');
        ogh.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffd9a8;';
        ogh.textContent = '🐲 Ogre pose inside case';
        wrap.appendChild(ogh);
        wrap.appendChild(pillInfo('Case is the anchor — the figurine follows it. Tune where the ogre sits inside (X/Y/Z relative to the case base).'));
        const ogOffset = { x: ogrePair.offset.x, y: ogrePair.offset.y, z: ogrePair.offset.z };
        function applyOgreOffset() {
          const info = _findOgrePairInfo();
          if (info?.offset) {
            info.offset.set(ogOffset.x, ogOffset.y, ogOffset.z);
            info.offsetDirty = true;
          }
          if (typeof persistPairOffset === 'function') persistPairOffset(item.label);
        }
        const ogUndo2 = makePanelUndo();
        function addOgRow(key, lbl, min, max) {
          const r = buildSliderRow({ state: ogOffset, key, label: lbl, min, max, step: 0.005, fineStep: 0.001, undoStack: ogUndo2, onApply: applyOgreOffset });
          wrap.appendChild(r.row);
        }
        addOgRow('x', 'Ogre X (left ↔ right inside case)', -1.5, 1.5);
        addOgRow('y', 'Ogre Y (down ↔ up inside case)',    -1.0, 2.0);
        addOgRow('z', 'Ogre Z (back ↔ front inside case)', -1.5, 1.5);
      }
    }

    // ---- Speed Racer-specific: Speed frame offset --------------------
    if (/speed.?racer|mach.?6/i.test(item.label || '')) {
      const sepSR = document.createElement('div');
      sepSR.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepSR);
      const srh = document.createElement('div');
      srh.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffd9a8;';
      srh.textContent = '🏁 Car offset on frame';
      wrap.appendChild(srh);
      wrap.appendChild(pillInfo('Frame is the anchor — the car follows it and sits ON top. Tune where exactly the car rests with these sliders (X/Y/Z relative to the frame).'));
      // The car (THIS item) is the FOLLOWER, frame is the ANCHOR.
      function _findCarPairInfo() {
        if (!g || typeof _pairLocked === 'undefined') return null;
        return _pairLocked.get(g) || null;
      }
      const live = _findCarPairInfo();
      const offset = (() => {
        let stored;
        try { stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}')[`${storeKey}.carOnFrameOffset`]; } catch {}
        if (stored && typeof stored === 'object') return { x: stored.x || 0, y: stored.y || 0, z: stored.z || 0 };
        if (live?.offset) return { x: live.offset.x, y: live.offset.y, z: live.offset.z };
        return { x: 0, y: 0.5, z: 0.05 };
      })();
      function applySR() {
        const info = _findCarPairInfo();
        if (info?.offset) {
          info.offset.set(offset.x, offset.y, offset.z);
          info.offsetDirty = true;
        }
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur[`${storeKey}.carOnFrameOffset`] = { x: offset.x, y: offset.y, z: offset.z };
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
        if (typeof persistPairOffset === 'function') persistPairOffset(item.label);
      }
      applySR();
      const srUndo = makePanelUndo();
      function addSR(key, lbl, min, max) {
        const r = buildSliderRow({ state: offset, key, label: lbl, min, max, step: 0.005, fineStep: 0.001, undoStack: srUndo, onApply: applySR });
        wrap.appendChild(r.row);
      }
      addSR('x', 'Car X (left ↔ right of frame)', -3, 3);
      addSR('y', 'Car Y (down ↔ up from frame)',  -2, 4);
      addSR('z', 'Car Z (behind ↔ in front)',     -3, 3);
    }

    // ---- Vespa-specific: steering + kickstand controls ---------------
    if (/vespa|scooter/i.test(item.label || '')) {
      const sepV = document.createElement('div');
      sepV.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepV);
      const vh = document.createElement('div');
      vh.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#cfe9ff;';
      vh.textContent = '🛵 Vespa';
      wrap.appendChild(vh);
      wrap.appendChild(pillInfo('Pick which mesh is the front wheel / handlebar / kickstand by clicking it after pressing the role button. Persists across reloads.'));

      // ---- Manual mesh picker --------------------------------------
      function _pickRole(roleKey, roleLabel) {
        if (!item.group) return;
        window.__meshPickMode = {
          group: item.group,
          assign: (mesh) => {
            try {
              const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
              cur[`vespa.pick.${roleKey}`] = mesh.name;
              localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
              console.log(`[vespa] assigned "${mesh.name}" → ${roleLabel}.`);
              // Hot-rebuild — no refresh needed.
              if (typeof window.__rebuildVespaRig === 'function') {
                window.__rebuildVespaRig(item.group, item.label);
              }
              // Re-open the editor so the new state is reflected.
              buildItemEditor(item);
            } catch (err) { console.warn('[vespa] pick persistence failed', err); }
          },
        };
      }
      const pickRow = document.createElement('div');
      pickRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;';
      function makePickBtn(roleKey, roleLabel) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = `🎯 Pick ${roleLabel}`;
        b.title = `Click then click the mesh in the scene that should act as ${roleLabel}.`;
        b.style.cssText = 'flex:1 1 30%;padding:6px;border-radius:6px;border:1px solid rgba(125,160,255,0.45);background:rgba(125,160,255,0.10);color:#fff;cursor:pointer;font-size:10px;font-weight:600;';
        b.addEventListener('click', () => {
          _pickRole(roleKey, roleLabel);
          b.textContent = `🎯 Now click ${roleLabel}…`;
          setTimeout(() => { b.textContent = `🎯 Pick ${roleLabel}`; }, 6000);
        });
        return b;
      }
      pickRow.appendChild(makePickBtn('wheel',     'front wheel'));
      pickRow.appendChild(makePickBtn('handle',    'handlebar'));
      pickRow.appendChild(makePickBtn('kickstand', 'kickstand'));
      wrap.appendChild(pickRow);
      // Show last-saved picks for clarity.
      const picksLine = document.createElement('div');
      picksLine.style.cssText = 'font-size:10px;opacity:0.7;line-height:1.45;margin-top:4px;';
      try {
        const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
        const lines = [
          `wheel: ${stored['vespa.pick.wheel'] || '(auto)'}`,
          `handle: ${stored['vespa.pick.handle'] || '(auto)'}`,
          `kickstand: ${stored['vespa.pick.kickstand'] || '(auto)'}`,
        ];
        picksLine.textContent = lines.join(' · ');
      } catch {}
      wrap.appendChild(picksLine);

      if (!item.group?.userData?.__vespaSteering && !item.group?.userData?.__vespaKickstand) {
        const note = document.createElement('div');
        note.style.cssText = 'font-size:11px;color:#ffd9a8;margin-top:6px;padding:6px;border:1px solid rgba(255,200,80,0.35);border-radius:6px;background:rgba(255,200,80,0.08);';
        note.textContent = 'No pivot rebuilt yet. Pick at least one role and refresh.';
        wrap.appendChild(note);
      }
      wrap.appendChild(pillInfo('Steering rotates the front wheel + handlebar around the headstock. Kickstand folds the lower stand up. The "Lean against wall" preset tilts the whole bike + drops the kickstand.'));
      const ud = item.group.userData;
      const vespaState = {
        steering:  ud.__vespaSteering?.rotation.y || 0,
        kickstand: ud.__vespaKickstand && ud.__vespaKickstandAxis ? (ud.__vespaKickstand.rotation[ud.__vespaKickstandAxis] || 0) : 0,
      };
      function applyVespa() {
        if (ud.__vespaSteering) ud.__vespaSteering.rotation.y = vespaState.steering;
        if (ud.__vespaKickstand && ud.__vespaKickstandAxis) {
          ud.__vespaKickstand.rotation[ud.__vespaKickstandAxis] = vespaState.kickstand;
        }
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur[`${storeKey}.vespa.steering`]  = vespaState.steering;
          cur[`${storeKey}.vespa.kickstand`] = vespaState.kickstand;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
      }
      const vespaUndo = makePanelUndo();
      function addVespa(key, lbl, min, max) {
        const r = buildSliderRow({ state: vespaState, key, label: lbl, min, max, step: 0.005, fineStep: 0.001, undoStack: vespaUndo, onApply: applyVespa });
        wrap.appendChild(r.row);
      }
      addVespa('steering',  'Steering (turn front wheel + handle)', -Math.PI / 4, Math.PI / 4);
      addVespa('kickstand', 'Kickstand lift',                       -Math.PI / 3, Math.PI / 3);
      // Quick "preset" buttons.
      const presetRow = document.createElement('div');
      presetRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;';
      function makeBtn(text, fn) {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = text;
        b.style.cssText = 'flex:1 1 30%;padding:6px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:#fff;cursor:pointer;font-size:11px;';
        b.addEventListener('click', fn);
        return b;
      }
      presetRow.appendChild(makeBtn('↺ Reset',     () => { vespaState.steering = 0; vespaState.kickstand = 0; applyVespa(); buildItemEditor(item); }));
      presetRow.appendChild(makeBtn('Stand up',    () => { vespaState.kickstand = 0; applyVespa(); buildItemEditor(item); }));
      presetRow.appendChild(makeBtn('Stand down',  () => { vespaState.kickstand = -Math.PI / 4; applyVespa(); buildItemEditor(item); }));
      // "Lean against wall" — tilts the whole Vespa group around the
      // forward axis so the bike rests on the kickstand-side wheel,
      // and pulls the kickstand down to support it. Persists transform.
      presetRow.appendChild(makeBtn('🧱 Lean against wall', () => {
        const fwd = ud.__vespaForwardKey || 'x';
        const tiltAxis = (fwd === 'x') ? 'z' : 'x'; // tilt around the axis perp to forward
        // ~12° lean toward the wall (negative or positive depending on
        // which side the kickstand is on). Persisted via the standard
        // drag-end save path — emit a manual save here.
        const lean = -0.21;
        item.group.rotation[tiltAxis] = lean;
        // Drop the kickstand so it carries the weight.
        vespaState.kickstand = -Math.PI / 4;
        applyVespa();
        // Persist the group's full transform including the tilt.
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          const sk = `item.${(item.label || '').replace(/\s+/g, '_')}`;
          cur[`${sk}.rotX`] = item.group.rotation.x;
          cur[`${sk}.rotY`] = item.group.rotation.y;
          cur[`${sk}.rotZ`] = item.group.rotation.z;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
        buildItemEditor(item);
      }));
      presetRow.appendChild(makeBtn('🧍 Stand upright', () => {
        item.group.rotation.set(0, item.group.rotation.y, 0);
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          const sk = `item.${(item.label || '').replace(/\s+/g, '_')}`;
          cur[`${sk}.rotX`] = 0; cur[`${sk}.rotZ`] = 0;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
        buildItemEditor(item);
      }));
      wrap.appendChild(presetRow);
    }

    // ---- Hoverboard-specific: clearcoat layer ------------------------
    // Drives the MeshPhysicalMaterial.clearcoat / clearcoatRoughness on
    // every mesh in the hoverboard group. Persisted under
    // `hoverboard.clearcoat` / `hoverboard.clearcoatRoughness`.
    if (/hover.?board/i.test(item.label || '')) {
      const sepHB = document.createElement('div');
      sepHB.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepHB);
      const hbHeader = document.createElement('div');
      hbHeader.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#cfe9ff;';
      hbHeader.textContent = '🛹 Hoverboard finish';
      wrap.appendChild(hbHeader);
      wrap.appendChild(pillInfo('Clearcoat = strength of the glossy reflective top layer (0 = matte, 1 = wet-look). Roughness blurs that layer.'));
      const hbState = (() => {
        let stored = {};
        try { stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}'); } catch {}
        return {
          clearcoat: typeof stored['hoverboard.clearcoat'] === 'number' ? stored['hoverboard.clearcoat'] : 1.0,
          clearcoatRoughness: typeof stored['hoverboard.clearcoatRoughness'] === 'number' ? stored['hoverboard.clearcoatRoughness'] : 0.05,
          metalness: typeof stored['hoverboard.metalness'] === 'number' ? stored['hoverboard.metalness'] : 0.85,
        };
      })();
      function _applyHb() {
        item.group.traverse((o) => {
          if (!o.isMesh || !o.material) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach((m) => {
            if (typeof m.clearcoat === 'number') m.clearcoat = hbState.clearcoat;
            if (typeof m.clearcoatRoughness === 'number') m.clearcoatRoughness = hbState.clearcoatRoughness;
            if (typeof m.metalness === 'number') m.metalness = hbState.metalness;
            m.needsUpdate = true;
          });
        });
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          cur['hoverboard.clearcoat']          = hbState.clearcoat;
          cur['hoverboard.clearcoatRoughness'] = hbState.clearcoatRoughness;
          cur['hoverboard.metalness']          = hbState.metalness;
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
      }
      _applyHb();
      const hbUndo = makePanelUndo();
      function addHb(key, label, min, max, step, fineStep) {
        const r = buildSliderRow({
          state: hbState, key, label, min, max,
          step, fineStep, undoStack: hbUndo, onApply: _applyHb,
        });
        wrap.appendChild(r.row);
      }
      addHb('clearcoat',          'Clearcoat strength',  0, 1,    0.005, 0.001);
      addHb('clearcoatRoughness', 'Clearcoat roughness', 0, 0.6,  0.005, 0.001);
      addHb('metalness',          'Metalness',           0, 1,    0.005, 0.001);
    }

    // ---- Boot-specific: 6-plane crop ---------------------------------
    // Matches the original 'Wall-E boot' AND any bank-spawned cropped
    // boot (label contains "walle boot" / "boot cropped" with optional
    // counter suffix). Crop values are shared globally — moving a slider
    // re-crops every boot in the scene.
    if ((/walle.?boot|wall.?e.?boot|boot.?cropped/i.test(item.label || '')) && typeof BOOT_CROP !== 'undefined') {
      const sepB = document.createElement('div');
      sepB.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
      wrap.appendChild(sepB);
      const bHeader = document.createElement('div');
      bHeader.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffd4a3;';
      bHeader.textContent = '✂ Boot crop';
      wrap.appendChild(bHeader);
      wrap.appendChild(pillInfo('Six-plane crop box around the boot. Lower the bottom to crop sand off; tighten any side to remove the rest.'));
      const cropUndo = makePanelUndo();
      function _persistCrop() {
        try {
          const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
          for (const k of ['bottom', 'top', 'left', 'right', 'front', 'back']) {
            cur[`bootCrop.${k}`] = BOOT_CROP[k];
          }
          localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
        } catch {}
      }
      function addCrop(key, label, min, max) {
        const r = buildSliderRow({
          state: BOOT_CROP, key, label, min, max,
          step: 0.001, fineStep: 0.0005,
          undoStack: cropUndo, onApply: _persistCrop,
        });
        wrap.appendChild(r.row);
      }
      addCrop('bottom', 'Bottom (Y up)',     -0.2, 0.5);
      addCrop('top',    'Top (Y down)',       0.05, 1.5);
      addCrop('left',   'Left (X-)',          0.02, 1.0);
      addCrop('right',  'Right (X+)',         0.02, 1.0);
      addCrop('front',  'Front (Z+)',         0.02, 1.0);
      addCrop('back',   'Back (Z-)',          0.02, 1.0);
      const resetCropBtn = document.createElement('button');
      resetCropBtn.type = 'button';
      resetCropBtn.textContent = '↺ Reset boot crop';
      resetCropBtn.style.cssText = 'padding:7px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:#fff;cursor:pointer;font-size:11px;margin-top:4px;';
      resetCropBtn.addEventListener('click', () => {
        BOOT_CROP.bottom = 0.028;
        BOOT_CROP.top = 1.0;
        BOOT_CROP.left = 1.0; BOOT_CROP.right = 1.0;
        BOOT_CROP.front = 1.0; BOOT_CROP.back = 1.0;
        _persistCrop();
        if (typeof window.__onSelectionChange === 'function' && selectedItem) {
          window.__onSelectionChange(selectedItem, true);
        }
      });
      wrap.appendChild(resetCropBtn);
    }

    function syncFromScene() {
      if (!g) return;
      // Pull live transform → state → slider thumbs, then persist so
      // gizmo-drag positions/rotations stick across reloads without the
      // user touching the sliders.
      state.x    = g.position.x;
      state.y    = g.position.y;
      state.z    = g.position.z;
      state.rotX = g.rotation.x;
      state.rotY = g.rotation.y;
      state.rotZ = g.rotation.z;
      state.scale = g.scale.x;
      sliders.x?.set(state.x);
      sliders.y?.set(state.y);
      sliders.z?.set(state.z);
      sliders.rotX?.set(state.rotX);
      sliders.rotY?.set(state.rotY);
      sliders.rotZ?.set(state.rotZ);
      sliders.scale?.set(state.scale);
      persistedSet(storeKey, state);
    }
    PANEL_SYNCS.push(syncFromScene);
  }

  function setMode(label, item, force) {
    if (label === currentMode && !force) return;
    currentMode = label;
    // Drop sync callbacks from the previous editor (cheap: re-create
    // PANEL_SYNCS and let the active panels re-register).
    // To keep it simple, we don't remove old listeners — they target DOM
    // nodes that are about to be GC'd, so calling them is a no-op (their
    // sliders[k]?.set(v) chains evaluate `set` on undefined, which we
    // guard with optional chaining).
    clearBody();
    if (label === 'Bookshelf')             buildShelfEditor();
    else if (label === 'Desk')             buildDeskEditor();
    else if (label === 'Venator backdrop') buildVenatorEditor();
    else if (label === 'Backdrop')         buildBackdropEditor();
    else if (item)                         buildItemEditor(item);
    else { outer.style.display = 'none'; return; }
    // Title reflects the selection
    const headerTitle = outer.querySelector('span');
    if (headerTitle) headerTitle.textContent = `Edit: ${label}`;
    outer.style.display = 'flex';
    // Brief pulse so the user notices the editor when it opens.
    outer.style.transition = 'box-shadow 0.6s ease, border-color 0.6s ease, transform 0.25s ease';
    outer.style.boxShadow = '0 0 0 2px rgba(125,255,160,0.65), 0 12px 40px rgba(125,255,160,0.45)';
    outer.style.borderColor = 'rgba(125,255,160,0.65)';
    outer.style.transform = 'translateY(-2px) scale(1.02)';
    setTimeout(() => {
      outer.style.boxShadow = '';
      outer.style.borderColor = '';
      outer.style.transform = '';
    }, 700);
  }

  window.__onSelectionChange = (item, force) => {
    if (!item) { setMode(null); return; }
    setMode(item.label, item, force);
  };
})();

// (Floating "Copy positions" button removed — every panel auto-saves its
// state to localStorage, so positions stick across reloads without the
// copy/paste-back-to-chat cycle.)

// (Item bank removed — items are added directly in code on demand.)
// One-time cleanup: nuke any leftover bank.added entries from a previous
// session so prop names like "Pixar lamp 1" don't reappear in code paths
// that no longer exist.
try { localStorage.removeItem('bank.added'); } catch {}

// ---------- Mode-aware "Edit" affordance --------------------------------
// When the user enters a focused camera mode (Left shelf view, Use computer,
// Sit at desk), a small floating "✎ Edit" pill slides in from the top-right.
// Clicking it expands the pill into a card with mode-specific sliders and
// a "Done" button. Done collapses the card and returns to hero view.
//
// This is the lightweight "smart UX" path: the user gets contextual edit
// controls without cluttering every screen with sliders by default.
(function mountModeEditAffordance() {
  const root = document.createElement('div');
  root.style.cssText = `
    position: fixed; top: 16px; right: 16px;
    z-index: 60; display: flex; flex-direction: column; align-items: flex-end;
    gap: 10px; pointer-events: none;
  `;
  // Trigger pill — visible when there's something to edit for the mode.
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.style.cssText = `
    pointer-events: auto;
    padding: 9px 16px; border-radius: 999px;
    border: 1px solid rgba(125,160,255,0.55);
    background: rgba(0,0,0,0.78); color: #fff;
    font: 12px system-ui; font-weight: 600;
    cursor: pointer; backdrop-filter: blur(12px);
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    transform: translateX(120%); opacity: 0;
    transition: transform 0.35s cubic-bezier(0.2, 0.9, 0.3, 1.1), opacity 0.25s ease;
  `;
  // Card — shown when the pill is clicked.
  const card = document.createElement('div');
  card.style.cssText = `
    pointer-events: auto;
    width: 280px; padding: 12px 14px;
    background: rgba(0,0,0,0.72);
    border: 1px solid rgba(125,160,255,0.45);
    border-radius: 14px; backdrop-filter: blur(12px);
    box-shadow: 0 8px 28px rgba(0,0,0,0.55);
    color: #fff; font: 12px system-ui;
    display: none; flex-direction: column; gap: 8px;
    transform-origin: top right;
    transform: translateY(-6px) scale(0.96); opacity: 0;
    transition: transform 0.25s ease, opacity 0.25s ease;
    max-height: calc(100vh - 80px); overflow-y: auto;
  `;
  root.append(pill, card);
  document.body.appendChild(root);

  // Helpers --------------------------------------------------------------
  function setPillVisible(visible) {
    if (visible) {
      pill.style.transform = 'translateX(0)';
      pill.style.opacity = '1';
    } else {
      pill.style.transform = 'translateX(120%)';
      pill.style.opacity = '0';
    }
  }
  let cardOpen = false;
  function openCard() {
    if (cardOpen) return;
    cardOpen = true;
    card.style.display = 'flex';
    requestAnimationFrame(() => {
      card.style.transform = 'translateY(0) scale(1)';
      card.style.opacity = '1';
    });
    pill.style.transform = 'translateX(120%)';
    pill.style.opacity = '0';
  }
  function closeCard() {
    if (!cardOpen) return;
    cardOpen = false;
    card.style.transform = 'translateY(-6px) scale(0.96)';
    card.style.opacity = '0';
    setTimeout(() => { if (!cardOpen) card.style.display = 'none'; }, 250);
    setPillVisible(currentMode === 'shelf' || currentMode === 'computer' || currentMode === 'sit');
    // Hide shelf-zone wireframes when any card closes (they're only
    // useful while the shelf-spacing card is open).
    if (typeof window.__setShelfBoxHelpersVisible === 'function') {
      window.__setShelfBoxHelpersVisible(false);
    }
  }

  // Build mode-specific card content ------------------------------------
  function clearCard() { while (card.firstChild) card.removeChild(card.firstChild); }
  function makeCardHeader(titleText) {
    const h = document.createElement('div');
    h.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:6px;';
    const t = document.createElement('span'); t.textContent = titleText;
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:4px;';
    // Minimize: collapses the card body to just the header so the user
    // can keep the card open without taking up screen real estate.
    const min = document.createElement('button');
    min.type = 'button';
    min.textContent = '−';
    min.title = 'Minimize';
    min.style.cssText = 'width:22px;height:22px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:#fff;cursor:pointer;font-size:14px;line-height:1;padding:0;font-weight:700;';
    min.addEventListener('click', () => {
      // Toggle every sibling of the header inside the card.
      const collapsed = card.dataset.minimized === '1';
      Array.from(card.children).forEach((ch) => {
        if (ch !== h) ch.style.display = collapsed ? '' : 'none';
      });
      card.dataset.minimized = collapsed ? '0' : '1';
      min.textContent = collapsed ? '−' : '+';
      min.title = collapsed ? 'Minimize' : 'Expand';
    });
    const x = document.createElement('button');
    x.type = 'button'; x.textContent = '×';
    x.title = 'Close';
    x.style.cssText = 'width:22px;height:22px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:#fff;cursor:pointer;font-size:14px;line-height:1;padding:0;';
    x.addEventListener('click', closeCard);
    btnRow.append(min, x);
    h.append(t, btnRow);
    return h;
  }
  function makeDoneRow(returnTo = 'hero') {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;margin-top:4px;';
    const done = document.createElement('button');
    done.type = 'button';
    done.textContent = '✓ Done';
    done.style.cssText = 'flex:1;padding:8px;border-radius:8px;border:1px solid rgba(125,255,160,0.45);background:rgba(125,255,160,0.12);color:#fff;cursor:pointer;font:12px system-ui;font-weight:600;';
    done.addEventListener('click', () => {
      closeCard();
      setMode(returnTo);
    });
    row.appendChild(done);
    return row;
  }

  // ----- Shelf editor card ---------------------------------------------
  function buildShelfCard() {
    clearCard();
    card.appendChild(makeCardHeader('Editing Bookshelf'));
    const SHELF_FALLBACK = { x: 3.481, y: 0, z: -1.620, rotY: 0 };
    const shelf = (() => {
      const g = propGroups.bookshelf?.group;
      return g ? { x: g.position.x, y: g.position.y, z: g.position.z, rotY: g.rotation.y } : { ...SHELF_FALLBACK };
    })();
    function apply() {
      const g = propGroups.bookshelf?.group;
      if (!g) return;
      g.position.set(shelf.x, shelf.y, shelf.z);
      g.rotation.y = shelf.rotY;
      persistedSet('shelf', shelf);
    }
    const undo = makePanelUndo();
    const sliders = {};
    function add(key, label, min, max) {
      const r = buildSliderRow({ state: shelf, key, label, min, max, step: 0.001, fineStep: 0.001, undoStack: undo, onApply: apply });
      card.appendChild(r.row);
      sliders[key] = r;
    }
    add('x',    'Sink (X → Venator)', -2, 6);
    add('y',    'Y (up/down)',        -5, 10);
    add('z',    'Z (depth)',         -10, 10);
    const r = buildSliderRow({ state: shelf, key: 'rotY', label: 'Rotate Y', min: -Math.PI, max: Math.PI, step: 0.001, fineStep: 0.001, undoStack: undo, onApply: apply });
    card.appendChild(r.row);
    sliders.rotY = r;
    function syncFromScene() {
      const g = propGroups.bookshelf?.group;
      if (!g) return;
      sliders.x?.set(g.position.x);
      sliders.y?.set(g.position.y);
      sliders.z?.set(g.position.z);
      sliders.rotY?.set(g.rotation.y);
    }
    PANEL_SYNCS.push(syncFromScene);

    // ---- Shelf VIEW offset (the camera framing for this mode) ---------
    const sep = document.createElement('div');
    sep.style.cssText = 'height:1px;background:rgba(255,255,255,0.08);margin:6px 0 2px;';
    card.appendChild(sep);
    const tip = document.createElement('div');
    tip.style.cssText = 'font-size:10px;opacity:0.65;line-height:1.45;';
    tip.textContent = 'Camera framing for THIS view only. Drag to nudge where the head-on shot lands.';
    card.appendChild(tip);

    const SV_LOCKED = { x: 0, y: 0, z: 0 };
    const sv = persistedGet('shelfView', SV_LOCKED);
    function applySv() { applyShelfView(sv.x, sv.y, sv.z); persistedSet('shelfView', sv); }
    const svUndo = makePanelUndo();
    const svSliders = {};
    function addSv(key, label, min, max) {
      const r = buildSliderRow({ state: sv, key, label, min, max, step: 0.001, fineStep: 0.001, undoStack: svUndo, onApply: applySv });
      card.appendChild(r.row);
      svSliders[key] = r;
    }
    addSv('x', 'View zoom (− out / + closer)',  -3, 3);
    addSv('y', 'View pan up/down (+ = up)',      -3, 3);
    addSv('z', 'View pan left/right (− = shelf appears right; + = shelf appears left)', -3, 3);
    PANEL_SYNCS.push(() => {
      svSliders.x?.set(shelfViewX);
      svSliders.y?.set(shelfViewY);
      svSliders.z?.set(shelfViewZ);
    });

    // ---- Strip-light position (same X/Y/Z controls as Right shelf) ----
    // PER-SIDE strip-light controls — this card affects ONLY the LEFT
    // shelf's lights. (The Right shelf card has its own independent
    // sliders.) Sliders write to `leftStripOffset.*` + per-side warmth
    // / brightness setters so left and right can be tuned separately.
    const lpHeader = document.createElement('div');
    lpHeader.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#a8e0ff;margin-top:8px;';
    lpHeader.textContent = '🔦 LEFT shelf strip lights';
    card.appendChild(lpHeader);
    const lpTip = document.createElement('div');
    lpTip.style.cssText = 'font-size:10px;opacity:0.7;line-height:1.45;';
    lpTip.textContent = 'Controls ONLY the LEFT shelf. X = depth into alcove. Y = vertical nudge per strip. Z = along shelf width.';
    card.appendChild(lpTip);
    const lpStored = (() => {
      try { return JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}'); }
      catch { return {}; }
    })();
    const lp = {
      x: typeof lpStored['leftStripOffset.x'] === 'number' ? lpStored['leftStripOffset.x'] : (typeof window.__getLeftStripOffsetX === 'function' ? window.__getLeftStripOffsetX() : 0),
      y: typeof lpStored['leftStripOffset.y'] === 'number' ? lpStored['leftStripOffset.y'] : (typeof window.__getLeftStripOffsetY === 'function' ? window.__getLeftStripOffsetY() : 0),
      z: typeof lpStored['leftStripOffset.z'] === 'number' ? lpStored['leftStripOffset.z'] : (typeof window.__getLeftStripOffsetZ === 'function' ? window.__getLeftStripOffsetZ() : 0),
      warmth:     typeof lpStored['leftStrip.warmth']     === 'number' ? lpStored['leftStrip.warmth']     : (typeof window.__getLeftStripWarmth     === 'function' ? window.__getLeftStripWarmth()     : 0.85),
      brightness: typeof lpStored['leftStrip.brightness'] === 'number' ? lpStored['leftStrip.brightness'] : (typeof window.__getLeftStripBrightness === 'function' ? window.__getLeftStripBrightness() : 0.93),
    };
    function applyLP() {
      window.__setLeftStripOffsetX?.(lp.x);
      window.__setLeftStripOffsetY?.(lp.y);
      window.__setLeftStripOffsetZ?.(lp.z);
      window.__setLeftStripWarmth?.(lp.warmth);
      window.__setLeftStripBrightness?.(lp.brightness);
      try {
        const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
        cur['leftStripOffset.x'] = lp.x;
        cur['leftStripOffset.y'] = lp.y;
        cur['leftStripOffset.z'] = lp.z;
        cur['leftStrip.warmth']     = lp.warmth;
        cur['leftStrip.brightness'] = lp.brightness;
        localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
      } catch {}
    }
    applyLP();
    const lpUndo = makePanelUndo();
    function addLP(key, lbl, min, max, step = 0.005) {
      const r2 = buildSliderRow({ state: lp, key, label: lbl, min, max, step, fineStep: step / 5, undoStack: lpUndo, onApply: applyLP });
      card.appendChild(r2.row);
    }
    addLP('x',          'Light X (depth)',           -0.6, 0.6);
    addLP('y',          'Light Y (vertical nudge)',  -0.5, 0.5);
    addLP('z',          'Light Z (along shelf)',     -0.6, 0.6);
    addLP('warmth',     'Warmth (cool ↔ warm)',      0, 1, 0.01);
    addLP('brightness', 'Brightness',                0, 4, 0.02);

    // ---- Extra shelf lights — LEFT side only -----------------------
    const extraSep2 = document.createElement('div');
    extraSep2.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:8px 0 4px;';
    card.appendChild(extraSep2);
    const extraHeader2 = document.createElement('div');
    extraHeader2.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#a8e0ff;';
    extraHeader2.textContent = '🪔 LEFT shelf extra lights';
    card.appendChild(extraHeader2);
    const extraTip2 = document.createElement('div');
    extraTip2.style.cssText = 'font-size:10px;opacity:0.7;line-height:1.45;';
    extraTip2.textContent = 'Add as many extra warm lights to the LEFT shelf as you want. Coords are shelf-LOCAL — each light rides with the bookshelf.';
    card.appendChild(extraTip2);

    const addRow2 = document.createElement('div');
    addRow2.style.cssText = 'display:flex;gap:6px;margin:4px 0;';
    const addL2 = document.createElement('button');
    addL2.type = 'button';
    addL2.textContent = '+ Add light to LEFT shelf';
    addL2.style.cssText = 'flex:1;padding:6px 8px;border-radius:6px;border:1px solid rgba(125,200,255,0.45);background:rgba(125,200,255,0.10);color:#fff;cursor:pointer;font:10.5px system-ui;';
    addL2.addEventListener('click', () => { window.__addExtraShelfLight('left'); rebuildExtraList2(); });
    addRow2.appendChild(addL2);
    card.appendChild(addRow2);

    const extraList2 = document.createElement('div');
    extraList2.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    card.appendChild(extraList2);

    function rebuildExtraList2() {
      extraList2.innerHTML = '';
      // FILTER to LEFT side only.
      const items = window.__readExtraShelfLights().filter(e => e.side === 'left');
      if (items.length === 0) {
        const empty = document.createElement('div');
        empty.textContent = '— no extra lights yet —';
        empty.style.cssText = 'font:10px system-ui;color:#888;padding:4px 6px;';
        extraList2.appendChild(empty);
        return;
      }
      items.forEach((entry, i) => {
        const row = document.createElement('div');
        row.style.cssText = 'padding:6px;border:1px solid rgba(255,255,255,0.10);border-radius:6px;background:rgba(255,255,255,0.03);display:flex;flex-direction:column;gap:3px;';
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font:11px system-ui;';
        const title = document.createElement('span');
        const sideTag = entry.side === 'left' ? '⬅ Left' : 'Right ➡';
        title.textContent = `${sideTag} · Light ${i + 1}`;
        title.style.color = entry.side === 'left' ? '#a8e0ff' : '#ffd9a8';
        const del = document.createElement('button');
        del.type = 'button'; del.textContent = '🗑';
        del.style.cssText = 'background:transparent;border:1px solid rgba(255,120,120,0.40);color:#ffb3b3;border-radius:4px;padding:2px 6px;cursor:pointer;font:11px system-ui;';
        del.addEventListener('click', () => {
          window.__removeExtraShelfLight(entry.id);
          rebuildExtraList2();
        });
        header.appendChild(title); header.appendChild(del);
        row.appendChild(header);
        const state = { ...entry };
        function applyOne() { window.__updateExtraShelfLight(entry.id, state); }
        const undoLocal = makePanelUndo();
        function addS(key, lbl, min, max, step = 0.005) {
          const r2 = buildSliderRow({ state, key, label: lbl, min, max, step, fineStep: step / 4, undoStack: undoLocal, onApply: applyOne });
          row.appendChild(r2.row);
        }
        addS('x', 'X (shelf-local)', -3, 3, 0.005);
        addS('y', 'Y (down ↔ up)',   0,  3.5, 0.005);
        addS('z', 'Z (back ↔ front)', -3, 3, 0.005);
        addS('intensity', 'Intensity', 0, 4, 0.02);
        addS('distance',  'Range',     0.05, 2, 0.01);
        addS('r', 'R', 0, 1, 0.01);
        addS('g', 'G', 0, 1, 0.01);
        addS('b', 'B', 0, 1, 0.01);
        extraList2.appendChild(row);
      });
    }
    rebuildExtraList2();

    // ---- LEFT shelf vertical crop ----------------------------------
    // Drag "Crop top" down from 5 to hide the top compartments one by
    // one. Drag "Crop bottom" up from -1 to hide the bottom. Each
    // shelf compartment top sits at y ≈ 1.35 / 1.71 / 2.07 / 2.42 / 2.78.
    const cropSep = document.createElement('div');
    cropSep.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:8px 0 2px;';
    card.appendChild(cropSep);
    const cropH = document.createElement('div');
    cropH.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffd9ff;';
    cropH.textContent = '✂️ LEFT shelf vertical crop';
    card.appendChild(cropH);
    const cropTip = document.createElement('div');
    cropTip.style.cssText = 'font-size:10px;opacity:0.65;line-height:1.45;';
    cropTip.textContent = 'Slide "Crop top" DOWN to hide the topmost shelf(es). Slide "Crop bottom" UP to hide the bottom. Compartment tops: 1.35 / 1.71 / 2.07 / 2.42 / 2.78.';
    card.appendChild(cropTip);
    const cropState = {
      // Use sentinel-y range numbers (no Infinity in sliders).
      top:    Number.isFinite(_leftShelfCropMaxY) ? _leftShelfCropMaxY  : 5,
      bottom: Number.isFinite(_leftShelfCropMinY) ? _leftShelfCropMinY  : -1,
    };
    function applyLeftCrop() {
      // Slider at max = no crop (Infinity); same for bottom at min.
      const top    = cropState.top    >= 4.99 ?  Infinity : cropState.top;
      const bottom = cropState.bottom <= -0.99 ? -Infinity : cropState.bottom;
      window.__setLeftShelfCropMaxY(top);
      window.__setLeftShelfCropMinY(bottom);
    }
    const cropUndo = makePanelUndo();
    {
      const r = buildSliderRow({
        state: cropState, key: 'top', label: 'Crop top (down = hide top)',
        min: -1, max: 5, step: 0.01, fineStep: 0.005,
        undoStack: cropUndo, onApply: applyLeftCrop,
      });
      card.appendChild(r.row);
    }
    {
      const r = buildSliderRow({
        state: cropState, key: 'bottom', label: 'Crop bottom (up = hide bottom)',
        min: -1, max: 5, step: 0.01, fineStep: 0.005,
        undoStack: cropUndo, onApply: applyLeftCrop,
      });
      card.appendChild(r.row);
    }
    // Reset button.
    const resetCrop = document.createElement('button');
    resetCrop.type = 'button';
    resetCrop.textContent = '↺ Reset crop (show everything)';
    resetCrop.style.cssText = 'padding:6px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:#fff;cursor:pointer;font:11px system-ui;margin-top:4px;';
    resetCrop.addEventListener('click', () => {
      cropState.top = 5; cropState.bottom = -1;
      applyLeftCrop();
      buildShelfCard();
    });
    card.appendChild(resetCrop);

    card.appendChild(makeDoneRow('hero'));
  }

  // ----- Computer editor card ------------------------------------------
  function buildComputerCard() {
    clearCard();
    card.appendChild(makeCardHeader('Editing Computer + view'));
    const tip = document.createElement('div');
    tip.style.cssText = 'font-size:10px;opacity:0.65;line-height:1.45;';
    tip.textContent = 'Top: shifts the Mac body + screen + camera (recenter the computer on the desk). Bottom: shifts only the camera framing for THIS mode.';
    card.appendChild(tip);
    // Computer offset
    const COMP_LOCKED = { x: 0, y: 0, z: 0 };
    const comp = persistedGet('computer', COMP_LOCKED);
    function applyComp() { applyComputerOffset(comp.x, comp.y, comp.z); persistedSet('computer', comp); }
    const compUndo = makePanelUndo();
    const compSliders = {};
    function addComp(key, label, min, max) {
      const r = buildSliderRow({ state: comp, key, label, min, max, step: 0.001, fineStep: 0.001, undoStack: compUndo, onApply: applyComp });
      card.appendChild(r.row);
      compSliders[key] = r;
    }
    addComp('x', 'Computer X', -1.5, 1.5);
    addComp('y', 'Computer Y', -1,   1);
    addComp('z', 'Computer Z', -2,   2);
    PANEL_SYNCS.push(() => {
      compSliders.x?.set(computerOffsetX);
      compSliders.y?.set(computerOffsetY);
      compSliders.z?.set(computerOffsetZ);
    });
    // Use-computer view offset
    const sep = document.createElement('div');
    sep.style.cssText = 'height:1px;background:rgba(255,255,255,0.08);margin:4px 0;';
    card.appendChild(sep);
    const UCV_LOCKED = { x: 0, y: 0, z: 0 };
    const ucv = persistedGet('ucv', UCV_LOCKED);
    function applyUcv() { applyUseComputerView(ucv.x, ucv.y, ucv.z); persistedSet('ucv', ucv); }
    const ucvUndo = makePanelUndo();
    const ucvSliders = {};
    function addUcv(key, label, min, max) {
      const r = buildSliderRow({ state: ucv, key, label, min, max, step: 0.001, fineStep: 0.001, undoStack: ucvUndo, onApply: applyUcv });
      card.appendChild(r.row);
      ucvSliders[key] = r;
    }
    addUcv('x', 'View X (left/right)',  -1, 1);
    addUcv('y', 'View Y (up/down)',     -1, 1);
    addUcv('z', 'View Z (closer/away)', -1, 1);
    PANEL_SYNCS.push(() => {
      ucvSliders.x?.set(useComputerViewX);
      ucvSliders.y?.set(useComputerViewY);
      ucvSliders.z?.set(useComputerViewZ);
    });
    card.appendChild(makeDoneRow('hero'));
  }

  // ----- Desk editor card (Sit at desk view) ---------------------------
  function buildDeskCard() {
    clearCard();
    card.appendChild(makeCardHeader('Editing Desk'));
    const DESK_LOCKED = { x: 0.487, y: -0.001, z: -4.885 };
    const desk = persistedGet('desk', DESK_LOCKED);
    function apply() { applyDeskOffset(desk.x, desk.y, desk.z); persistedSet('desk', desk); }
    const undo = makePanelUndo();
    const sliders = {};
    function add(key, label, min, max) {
      const r = buildSliderRow({ state: desk, key, label, min, max, step: 0.001, fineStep: 0.001, undoStack: undo, onApply: apply });
      card.appendChild(r.row);
      sliders[key] = r;
    }
    add('x', 'Desk X (left/right)', -3,  3);
    add('y', 'Desk Y (up/down)',    -2,  2);
    add('z', 'Desk Z (front/back)', -10, 4);
    PANEL_SYNCS.push(() => {
      sliders.x?.set(deskOffsetX);
      sliders.y?.set(deskOffsetY);
      sliders.z?.set(deskOffsetZ);
    });
    card.appendChild(makeDoneRow('hero'));
  }

  // ----- Backdrop card (position + size of the Rio/Luca plane) ---------
  function buildBackdropCard() {
    clearCard();
    card.appendChild(makeCardHeader('Editing Backdrop'));
    if (!window.__rio) {
      const tip = document.createElement('div');
      tip.style.cssText = 'font-size:10px;opacity:0.65;line-height:1.45;';
      tip.textContent = 'Backdrop plane is still loading — open this again in a moment.';
      card.appendChild(tip);
      card.appendChild(makeDoneRow('hero'));
      return;
    }

    // ---- Visibility toggle + Rio/Luca picker -------------------------
    const BACKDROPS_LOCAL = [
      { id: 'rio',  label: 'Rio',  spec: { type: 'image', src: '/images/rio.jpg', mirror: true } },
      { id: 'luca', label: 'Luca', spec: { type: 'video', src: '/videos/luca.mp4' } },
    ];
    let activeId = (typeof window.__activeBackdropId === 'function')
      ? window.__activeBackdropId() : 'luca';
    let visible  = window.__rio ? window.__rio.visible : true;
    function findBgVideo() {
      return document.querySelector('video[data-src*=".mp4"]');
    }
    const visBtn = document.createElement('button');
    visBtn.type = 'button';
    function paintVis() {
      visBtn.textContent = `Backdrop: ${visible ? 'ON' : 'OFF'}`;
      visBtn.style.cssText = `padding:7px 12px;border-radius:8px;border:1px solid ${visible ? 'rgba(125,255,160,0.55)' : 'rgba(255,255,255,0.18)'};background:${visible ? 'rgba(125,255,160,0.18)' : 'transparent'};color:#fff;cursor:pointer;font:12px system-ui;text-align:left;font-weight:600;`;
    }
    paintVis();
    visBtn.addEventListener('click', () => {
      visible = !visible;
      paintVis();
      if (window.__rio) window.__rio.visible = visible;
      if (visible && typeof swapBackdrop === 'function') {
        const cur = BACKDROPS_LOCAL.find((b) => b.id === activeId);
        if (cur) swapBackdrop(cur.spec);
        const v = findBgVideo();
        if (v) v.play?.().catch(() => {});
      } else if (!visible) {
        const v = findBgVideo();
        if (v) v.pause?.();
      }
    });
    card.appendChild(visBtn);

    const switcher = document.createElement('div');
    switcher.style.cssText = 'display:flex;gap:6px;';
    const swBtns = {};
    function paintSwitcher() {
      Object.entries(swBtns).forEach(([id, b]) => {
        const on = id === activeId;
        b.style.cssText = `flex:1;padding:6px;border-radius:6px;border:1px solid ${on ? 'rgba(125,255,160,0.55)' : 'rgba(255,255,255,0.18)'};background:${on ? 'rgba(125,255,160,0.18)' : 'transparent'};color:#fff;cursor:pointer;font-size:11px;`;
      });
    }
    BACKDROPS_LOCAL.forEach((bd) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = bd.label;
      b.addEventListener('click', () => {
        activeId = bd.id;
        paintSwitcher();
        if (typeof swapBackdrop === 'function' && visible) swapBackdrop(bd.spec);
      });
      swBtns[bd.id] = b;
      switcher.appendChild(b);
    });
    paintSwitcher();
    card.appendChild(switcher);

    const sepBd = document.createElement('div');
    sepBd.style.cssText = 'height:1px;background:rgba(255,255,255,0.08);margin:4px 0;';
    card.appendChild(sepBd);

    // ---- Position + size sliders ------------------------------------
    const BD_LOCKED = {
      x: window.__rio.position.x, y: window.__rio.position.y, z: window.__rio.position.z,
      w: window.__rio.geometry.parameters?.width ?? 26,
    };
    const bd = persistedGet('backdrop', BD_LOCKED);
    function apply() {
      if (typeof window.__setRioPlane === 'function') window.__setRioPlane({ x: bd.x, y: bd.y, z: bd.z, w: bd.w });
      persistedSet('backdrop', bd);
    }
    const undo = makePanelUndo();
    const sliders = {};
    function add(key, label, min, max, step, fineStep) {
      const r = buildSliderRow({ state: bd, key, label, min, max, step, fineStep, undoStack: undo, onApply: apply });
      card.appendChild(r.row);
      sliders[key] = r;
    }
    add('x', 'Backdrop X',     -30, 30, 0.05, 0.01);
    add('y', 'Backdrop Y',     -10, 30, 0.05, 0.01);
    add('z', 'Backdrop Z',     -30, 30, 0.05, 0.01);
    add('w', 'Backdrop width',   1, 80, 0.10, 0.05);
    PANEL_SYNCS.push(() => {
      if (!window.__rio) return;
      sliders.x?.set(window.__rio.position.x);
      sliders.y?.set(window.__rio.position.y);
      sliders.z?.set(window.__rio.position.z);
      sliders.w?.set(window.__rio.geometry.parameters?.width ?? bd.w);
    });
    card.appendChild(makeDoneRow('hero'));
  }

  // ----- Venator lights card -------------------------------------------
  function buildLightsCard() {
    clearCard();
    card.appendChild(makeCardHeader('Editing Venator lights'));
    const VL_FALLBACK = { ...venatorLook };
    const look = persistedGet('venatorLook', VL_FALLBACK);
    Object.assign(venatorLook, look);
    function apply() {
      Object.assign(venatorLook, look);
      if (typeof applyVenatorLook === 'function') applyVenatorLook();
      persistedSet('venatorLook', look);
    }
    const undo = makePanelUndo();
    const sliders = {};
    function add(key, label, min, max, step, fineStep) {
      const r = buildSliderRow({ state: look, key, label, min, max, step, fineStep, undoStack: undo, onApply: apply });
      card.appendChild(r.row);
      sliders[key] = r;
    }
    add('glow',       'Light panels (glow)', 0, 5, 0.01,  0.005);
    add('brightness', 'Brightness',          0, 3, 0.01,  0.005);
    add('reflection', 'Reflection (envMap)', 0, 5, 0.01,  0.005);
    add('shininess',  'Shininess',           0, 1, 0.005, 0.001);
    card.appendChild(makeDoneRow('hero'));
  }

  // ----- Shelf strip lights card (position offsets) --------------------
  function buildRightShelfCard() {
    clearCard();
    card.appendChild(makeCardHeader('Editing Right shelf'));
    const tip = document.createElement('div');
    tip.style.cssText = 'font-size:10px;opacity:0.65;line-height:1.45;';
    tip.textContent = 'Position + rotate the mirrored bookshelf on the right. If you don\'t see it, hit "🔁 (Re)build" first — the mirror only constructs once at boot, so a previous failure leaves nothing.';
    card.appendChild(tip);
    // Default = the mirror's expected position (-3.481, 0, -1.620). User
    // can tweak via the sliders.
    const RIGHT_FALLBACK = { x: -3.481, y: 0, z: -1.620, rotY: 0 };
    const right = persistedGet('rightShelf', RIGHT_FALLBACK);
    function apply() {
      // Make sure the mirror exists.
      let mir = (typeof window.__buildMirroredBookshelf === 'function') ? window.__buildMirroredBookshelf() : null;
      if (!mir) return;
      mir.position.set(right.x, right.y, right.z);
      mir.rotation.y = right.rotY;
      mir.visible = true;
      persistedSet('rightShelf', right);
    }
    apply();
    const undo = makePanelUndo();
    const sliders = {};
    function add(key, label, min, max) {
      const r = buildSliderRow({ state: right, key, label, min, max, step: 0.001, fineStep: 0.001, undoStack: undo, onApply: apply });
      card.appendChild(r.row);
      sliders[key] = r;
    }
    add('x',    'X (left ↔ right)',  -10, 10);
    add('y',    'Y (down ↔ up)',     -5,  10);
    add('z',    'Z (back ↔ front)',  -10, 10);
    const r = buildSliderRow({ state: right, key: 'rotY', label: 'Rotate Y', min: -Math.PI, max: Math.PI, step: 0.001, fineStep: 0.001, undoStack: undo, onApply: apply });
    card.appendChild(r.row);
    sliders.rotY = r;

    // ---- Lights note --------------------------------------------------
    // Per user request: the right shelf's strip lights track the LEFT
    // shelf exactly — same color, warmth, and intensity. Tune via the
    // existing Sliders → 🔦 Shelf strip lights card; both shelves
    // update together (see _allShelfLights in setStripWarmth /
    // setStripBrightness).
    const lmNote = document.createElement('div');
    lmNote.style.cssText = 'font-size:10px;opacity:0.7;line-height:1.45;margin-top:6px;padding:6px;border:1px solid rgba(255,200,150,0.35);border-radius:6px;background:rgba(255,200,150,0.06);';
    lmNote.textContent = '💡 RIGHT shelf strip lights — these sliders affect ONLY the right shelf. Left shelf has its own card.';
    card.appendChild(lmNote);

    // PER-SIDE strip-light controls — this card affects ONLY the RIGHT
    // shelf's lights. Independent of the Left shelf card.
    const lpHeader = document.createElement('div');
    lpHeader.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffd9a8;margin-top:6px;';
    lpHeader.textContent = '🔦 RIGHT shelf strip lights';
    card.appendChild(lpHeader);
    const lpTip = document.createElement('div');
    lpTip.style.cssText = 'font-size:10px;opacity:0.7;line-height:1.45;';
    lpTip.textContent = 'Controls ONLY the RIGHT shelf. X = depth into alcove. Y = vertical nudge per strip. Z = along shelf width.';
    card.appendChild(lpTip);
    const lpStored = (() => {
      try { return JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}'); }
      catch { return {}; }
    })();
    const lp = {
      x: typeof lpStored['rightStripOffset.x'] === 'number' ? lpStored['rightStripOffset.x'] : (typeof window.__getRightStripOffsetX === 'function' ? window.__getRightStripOffsetX() : 0),
      y: typeof lpStored['rightStripOffset.y'] === 'number' ? lpStored['rightStripOffset.y'] : (typeof window.__getRightStripOffsetY === 'function' ? window.__getRightStripOffsetY() : 0),
      z: typeof lpStored['rightStripOffset.z'] === 'number' ? lpStored['rightStripOffset.z'] : (typeof window.__getRightStripOffsetZ === 'function' ? window.__getRightStripOffsetZ() : 0),
      warmth:     typeof lpStored['rightStrip.warmth']     === 'number' ? lpStored['rightStrip.warmth']     : (typeof window.__getRightStripWarmth     === 'function' ? window.__getRightStripWarmth()     : 0.85),
      brightness: typeof lpStored['rightStrip.brightness'] === 'number' ? lpStored['rightStrip.brightness'] : (typeof window.__getRightStripBrightness === 'function' ? window.__getRightStripBrightness() : 0.93),
    };
    function applyLP() {
      window.__setRightStripOffsetX?.(lp.x);
      window.__setRightStripOffsetY?.(lp.y);
      window.__setRightStripOffsetZ?.(lp.z);
      window.__setRightStripWarmth?.(lp.warmth);
      window.__setRightStripBrightness?.(lp.brightness);
      try {
        const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
        cur['rightStripOffset.x'] = lp.x;
        cur['rightStripOffset.y'] = lp.y;
        cur['rightStripOffset.z'] = lp.z;
        cur['rightStrip.warmth']     = lp.warmth;
        cur['rightStrip.brightness'] = lp.brightness;
        localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
      } catch {}
    }
    applyLP();   // ensure live values match persisted
    const lpUndo = makePanelUndo();
    function addLP(key, lbl, min, max, step = 0.005) {
      const r2 = buildSliderRow({ state: lp, key, label: lbl, min, max, step, fineStep: step / 5, undoStack: lpUndo, onApply: applyLP });
      card.appendChild(r2.row);
    }
    addLP('x',          'Light X (depth)',           -0.6, 0.6);
    addLP('y',          'Light Y (vertical nudge)',  -0.5, 0.5);
    addLP('z',          'Light Z (along shelf)',     -0.6, 0.6);
    addLP('warmth',     'Warmth (cool ↔ warm)',      0, 1, 0.01);
    addLP('brightness', 'Brightness',                0, 4, 0.02);

    // ---- Extra shelf lights — RIGHT side only ----------------------
    const extraSep = document.createElement('div');
    extraSep.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:8px 0 4px;';
    card.appendChild(extraSep);
    const extraHeader = document.createElement('div');
    extraHeader.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffd9a8;';
    extraHeader.textContent = '🪔 RIGHT shelf extra lights';
    card.appendChild(extraHeader);
    const extraTip = document.createElement('div');
    extraTip.style.cssText = 'font-size:10px;opacity:0.7;line-height:1.45;';
    extraTip.textContent = 'Add as many extra warm lights to the RIGHT shelf as you want. Coords are shelf-LOCAL — each light rides with its bookshelf.';
    card.appendChild(extraTip);

    const addRow = document.createElement('div');
    addRow.style.cssText = 'display:flex;gap:6px;margin:4px 0;';
    const addR = document.createElement('button');
    addR.type = 'button';
    addR.textContent = '+ Add light to RIGHT shelf';
    addR.style.cssText = 'flex:1;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,200,125,0.45);background:rgba(255,200,125,0.10);color:#fff;cursor:pointer;font:10.5px system-ui;';
    addR.addEventListener('click', () => { window.__addExtraShelfLight('right'); rebuildExtraList(); });
    addRow.appendChild(addR);
    card.appendChild(addRow);

    // Container for the per-light editor rows.
    const extraList = document.createElement('div');
    extraList.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    card.appendChild(extraList);

    function rebuildExtraList() {
      extraList.innerHTML = '';
      // FILTER to RIGHT side only.
      const items = window.__readExtraShelfLights().filter(e => e.side === 'right');
      if (items.length === 0) {
        const empty = document.createElement('div');
        empty.textContent = '— no extra lights yet —';
        empty.style.cssText = 'font:10px system-ui;color:#888;padding:4px 6px;';
        extraList.appendChild(empty);
        return;
      }
      items.forEach((entry, i) => {
        const row = document.createElement('div');
        row.style.cssText = 'padding:6px;border:1px solid rgba(255,255,255,0.10);border-radius:6px;background:rgba(255,255,255,0.03);display:flex;flex-direction:column;gap:3px;';
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font:11px system-ui;';
        const title = document.createElement('span');
        const sideTag = entry.side === 'left' ? '⬅ Left' : 'Right ➡';
        title.textContent = `${sideTag} · Light ${i + 1}`;
        title.style.color = entry.side === 'left' ? '#a8e0ff' : '#ffd9a8';
        const del = document.createElement('button');
        del.type = 'button'; del.textContent = '🗑';
        del.style.cssText = 'background:transparent;border:1px solid rgba(255,120,120,0.40);color:#ffb3b3;border-radius:4px;padding:2px 6px;cursor:pointer;font:11px system-ui;';
        del.addEventListener('click', () => {
          window.__removeExtraShelfLight(entry.id);
          rebuildExtraList();
        });
        header.appendChild(title); header.appendChild(del);
        row.appendChild(header);
        const state = { ...entry };
        function applyOne() { window.__updateExtraShelfLight(entry.id, state); }
        const undoLocal = makePanelUndo();
        function addS(key, lbl, min, max, step = 0.005) {
          const r2 = buildSliderRow({ state, key, label: lbl, min, max, step, fineStep: step / 4, undoStack: undoLocal, onApply: applyOne });
          row.appendChild(r2.row);
        }
        addS('x', 'X (shelf-local)', -3, 3, 0.005);
        addS('y', 'Y (down ↔ up)',   0,  3.5, 0.005);
        addS('z', 'Z (back ↔ front)', -3, 3, 0.005);
        addS('intensity', 'Intensity', 0, 4, 0.02);
        addS('distance',  'Range',     0.05, 2, 0.01);
        addS('r', 'R', 0, 1, 0.01);
        addS('g', 'G', 0, 1, 0.01);
        addS('b', 'B', 0, 1, 0.01);
        extraList.appendChild(row);
      });
    }
    rebuildExtraList();
    // (Re)build button — useful when the mirror failed to construct on
    // first boot (e.g., the original bookshelf hadn't loaded yet).
    const rebuildRow = document.createElement('div');
    rebuildRow.style.cssText = 'display:flex;gap:6px;margin-top:4px;';
    const rebuildBtn = document.createElement('button');
    rebuildBtn.type = 'button';
    rebuildBtn.textContent = '🔁 (Re)build right shelf';
    rebuildBtn.style.cssText = 'flex:1;padding:7px;border-radius:6px;border:1px solid rgba(125,160,255,0.45);background:rgba(125,160,255,0.12);color:#fff;cursor:pointer;font:11px system-ui;font-weight:600;';
    rebuildBtn.addEventListener('click', () => {
      if (typeof window.__rebuildMirroredBookshelf === 'function') {
        window.__rebuildMirroredBookshelf();
        apply();
      }
    });
    rebuildRow.appendChild(rebuildBtn);
    card.appendChild(rebuildRow);

    // ---- RIGHT shelf vertical crop ---------------------------------
    // Independent of the left shelf's crop. Slide "Crop top" down to
    // hide the top shelf(es) on the RIGHT side only.
    const rcropSep = document.createElement('div');
    rcropSep.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:8px 0 2px;';
    card.appendChild(rcropSep);
    const rcropH = document.createElement('div');
    rcropH.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.95;color:#ffd9ff;';
    rcropH.textContent = '✂️ RIGHT shelf vertical crop';
    card.appendChild(rcropH);
    const rcropTip = document.createElement('div');
    rcropTip.style.cssText = 'font-size:10px;opacity:0.65;line-height:1.45;';
    rcropTip.textContent = 'Slide "Crop top" DOWN to hide the topmost shelf(es). Slide "Crop bottom" UP to hide the bottom. Compartment tops: 1.35 / 1.71 / 2.07 / 2.42 / 2.78.';
    card.appendChild(rcropTip);
    const rcropState = {
      top:    Number.isFinite(_rightShelfCropMaxY) ? _rightShelfCropMaxY :  5,
      bottom: Number.isFinite(_rightShelfCropMinY) ? _rightShelfCropMinY : -1,
    };
    function applyRightCrop() {
      const top    = rcropState.top    >= 4.99 ?  Infinity : rcropState.top;
      const bottom = rcropState.bottom <= -0.99 ? -Infinity : rcropState.bottom;
      window.__setRightShelfCropMaxY(top);
      window.__setRightShelfCropMinY(bottom);
    }
    const rcropUndo = makePanelUndo();
    {
      const r = buildSliderRow({
        state: rcropState, key: 'top', label: 'Crop top (down = hide top)',
        min: -1, max: 5, step: 0.01, fineStep: 0.005,
        undoStack: rcropUndo, onApply: applyRightCrop,
      });
      card.appendChild(r.row);
    }
    {
      const r = buildSliderRow({
        state: rcropState, key: 'bottom', label: 'Crop bottom (up = hide bottom)',
        min: -1, max: 5, step: 0.01, fineStep: 0.005,
        undoStack: rcropUndo, onApply: applyRightCrop,
      });
      card.appendChild(r.row);
    }
    const rResetCrop = document.createElement('button');
    rResetCrop.type = 'button';
    rResetCrop.textContent = '↺ Reset crop (show everything)';
    rResetCrop.style.cssText = 'padding:6px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:#fff;cursor:pointer;font:11px system-ui;margin-top:4px;';
    rResetCrop.addEventListener('click', () => {
      rcropState.top = 5; rcropState.bottom = -1;
      applyRightCrop();
      buildRightShelfCard();
    });
    card.appendChild(rResetCrop);

    card.appendChild(makeDoneRow('hero'));
  }

  function buildShelfStripCard() {
    clearCard();
    card.appendChild(makeCardHeader('Editing Shelf strip lights (BOTH shelves)'));
    const tip = document.createElement('div');
    tip.style.cssText = 'font-size:10px;opacity:0.7;line-height:1.45;padding:6px;border:1px solid rgba(255,200,80,0.35);border-radius:6px;background:rgba(255,200,80,0.06);';
    tip.textContent = '⚠ This card moves BOTH shelves\' strip lights in lockstep. For per-shelf control, use 📚 Left shelf or 📚 Right shelf instead.';
    card.appendChild(tip);
    // Fallback values pulled from the LEFT side (legacy stripOffsetX/Y/Z
    // no longer exists since per-side state was split). The setter
    // below applies to both via the legacy combined function.
    const STRIP_FALLBACK = {
      x: (typeof window.__getLeftStripOffsetX === 'function') ? window.__getLeftStripOffsetX() : 0,
      y: (typeof window.__getLeftStripOffsetY === 'function') ? window.__getLeftStripOffsetY() : 0,
      z: (typeof window.__getLeftStripOffsetZ === 'function') ? window.__getLeftStripOffsetZ() : 0,
    };
    const strip = persistedGet('shelfStrip', STRIP_FALLBACK);
    function apply() {
      setStripOffsetX(strip.x);   // legacy combined (bumps BOTH sides)
      setStripOffsetY(strip.y);
      setStripOffsetZ(strip.z);
      persistedSet('shelfStrip', strip);
    }
    // Apply once so persisted values take effect when the card is opened.
    apply();
    const undo = makePanelUndo();
    function add(key, label, min, max) {
      const r = buildSliderRow({ state: strip, key, label, min, max, step: 0.001, fineStep: 0.001, undoStack: undo, onApply: apply });
      card.appendChild(r.row);
    }
    add('x', 'Strip X (depth)',  -1, 1);
    add('y', 'Strip Y (height)', -1, 1);
    add('z', 'Strip Z (along)',  -1, 1);
    card.appendChild(makeDoneRow('hero'));
  }

  // ----- Shelf spacing + swap card -------------------------------------
  function buildShelfSpacingCard() {
    clearCard();
    card.appendChild(makeCardHeader('Editing Shelf spacing'));
    const tip = document.createElement('div');
    tip.style.cssText = 'font-size:10px;opacity:0.65;line-height:1.45;';
    tip.textContent = 'Each shelf has an invisible box (visible while this card is open). Items inside that box are members of that shelf — drag the slider to nudge them, or swap two shelves to switch their contents.';
    card.appendChild(tip);

    // Always re-detect on card open so members reflect any drags / new
    // bank-spawned items since the last open.
    registerShelfMembers();
    setShelfBoxHelpersVisible(true);

    const offsets = loadShelfOffsets();
    function apply() {
      applyShelfSpacing(offsets);
      saveShelfState(offsets);
    }
    apply();

    const undo = makePanelUndo();
    function memberCount(letter) {
      let n = 0;
      for (const m of _shelfMembers.values()) if (m.shelf === letter) n++;
      return n;
    }
    SHELF_LETTERS.forEach((letter) => {
      const n = memberCount(letter);
      const r = buildSliderRow({
        state: offsets,
        key: letter,
        label: `Shelf ${letter} Y  (${n} item${n === 1 ? '' : 's'})`,
        min: -1.0, max: 1.0,
        step: 0.005, fineStep: 0.001,
        undoStack: undo,
        onApply: apply,
      });
      card.appendChild(r.row);
    });

    // ---- Swap section --------------------------------------------------
    const sep = document.createElement('div');
    sep.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 0 2px;';
    card.appendChild(sep);
    const swapTip = document.createElement('div');
    swapTip.style.cssText = 'font-size:10px;opacity:0.65;line-height:1.45;';
    swapTip.textContent = 'Swap two shelves — every item on shelf X moves to where shelf Y was, and vice versa.';
    card.appendChild(swapTip);

    const swapRow = document.createElement('div');
    swapRow.style.cssText = 'display:flex;gap:6px;align-items:center;margin-top:4px;';
    function makeSelect(initial) {
      const sel = document.createElement('select');
      sel.style.cssText = 'flex:1;padding:6px 8px;border-radius:6px;background:#111;color:#fff;border:1px solid rgba(255,255,255,0.15);font:12px system-ui;';
      SHELF_LETTERS.forEach((l) => {
        const opt = document.createElement('option');
        opt.value = l; opt.textContent = `Shelf ${l}`;
        sel.appendChild(opt);
      });
      sel.value = initial;
      return sel;
    }
    const sel1 = makeSelect('A');
    const sel2 = makeSelect('B');
    const swapBtn = document.createElement('button');
    swapBtn.type = 'button';
    swapBtn.textContent = '↔ Swap';
    swapBtn.style.cssText = 'padding:7px 12px;border-radius:8px;border:1px solid rgba(125,160,255,0.45);background:rgba(125,160,255,0.18);color:#fff;cursor:pointer;font:12px system-ui;font-weight:600;';
    swapBtn.addEventListener('click', () => {
      swapShelves(sel1.value, sel2.value);
      apply();
      // Rebuild the card so the per-shelf item counts update.
      buildShelfSpacingCard();
    });
    swapRow.append(sel1, sel2, swapBtn);
    card.appendChild(swapRow);

    // ---- Reset offsets only (keep swaps) ------------------------------
    const resetRow = document.createElement('div');
    resetRow.style.cssText = 'display:flex;gap:6px;margin-top:4px;';
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.textContent = '↺ Reset Y offsets';
    resetBtn.style.cssText = 'flex:1;padding:6px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:#fff;cursor:pointer;font:11px system-ui;';
    resetBtn.addEventListener('click', () => {
      SHELF_LETTERS.forEach((k) => { offsets[k] = 0; });
      apply();
      buildShelfSpacingCard();
    });
    resetRow.appendChild(resetBtn);
    card.appendChild(resetRow);

    card.appendChild(makeDoneRow('hero'));
  }

  // ----- Mode change wiring --------------------------------------------
  let currentMode = 'hero';
  const MODE_CONFIG = {
    shelf:    { pillLabel: '✎ Edit shelf view',    builder: buildShelfCard },
    computer: { pillLabel: '✎ Edit computer view', builder: buildComputerCard },
    sit:      { pillLabel: '✎ Edit desk',          builder: buildDeskCard },
  };
  // Manual openers — driven by the floating Sliders menu (below).
  const MANUAL_OPENERS = {
    shelf:        buildShelfCard,
    rightShelf:   buildRightShelfCard,
    computer:     buildComputerCard,
    desk:         buildDeskCard,
    backdrop:     buildBackdropCard,
    lights:       buildLightsCard,
    shelfStrip:   buildShelfStripCard,
    shelfSpacing: buildShelfSpacingCard,
  };
  // Expose so mountSlidersMenu can pop any card on demand.
  window.__openEditCard = (key) => {
    const builder = MANUAL_OPENERS[key];
    if (!builder) return;
    builder();
    openCard();
  };
  pill.addEventListener('click', () => {
    const cfg = MODE_CONFIG[currentMode];
    if (!cfg) return;
    cfg.builder();
    openCard();
  });
  _modeChangeHandlers.push((mode) => {
    currentMode = mode;
    const cfg = MODE_CONFIG[mode];
    if (cfg) {
      pill.textContent = cfg.pillLabel;
      // If the card was open for the previous mode, swap content so it
      // reflects the new mode without forcing the user to re-click.
      if (cardOpen) {
        cfg.builder();
      } else {
        setPillVisible(true);
      }
    } else {
      setPillVisible(false);
      if (cardOpen) closeCard();
    }
  });
})();

// ---------- Items menu (thumbnails of /items-bank GLBs) ----------------
// One floating button. Click → grid of thumbnails (rendered live in an
// offscreen WebGL canvas the first time). Click a thumbnail → loadProp at
// the camera's current look-at point (controls.target) so the model lands
// exactly where you're looking. Auto-selects so the contextual editor
// opens with full transform / material / remove controls.
(function mountItemsMenu() {
  // Offscreen renderer used solely for thumbnails. Tiny canvas, no DOM.
  // (Still constructed in website mode — harmless overhead, and the
  // function declarations + bank-restore code below need to run.
  // We early-return ONLY at the UI-mount step further down, after
  // the bank items have been restored from localStorage.)
  const thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  thumbRenderer.setSize(120, 120);
  thumbRenderer.setPixelRatio(window.devicePixelRatio || 1);
  thumbRenderer.setClearColor(0x111418, 1);
  thumbRenderer.outputColorSpace = THREE.SRGBColorSpace;

  const thumbScene = new THREE.Scene();
  thumbScene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const thumbKey = new THREE.DirectionalLight(0xffffff, 1.4);
  thumbKey.position.set(2, 3, 4);
  thumbScene.add(thumbKey);
  const thumbFill = new THREE.DirectionalLight(0xffd6a8, 0.5);
  thumbFill.position.set(-3, 1, -2);
  thumbScene.add(thumbFill);
  const thumbCam = new THREE.PerspectiveCamera(35, 1, 0.01, 100);

  const thumbCache = new Map();   // file → dataURL
  const thumbInflight = new Map(); // file → Promise<dataURL>
  const thumbLoader = makeGLTFLoader();

  function _disposeObject(obj) {
    obj.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => {
          if (m.map) m.map.dispose();
          m.dispose();
        });
      }
    });
  }
  async function renderThumbnail(file) {
    if (thumbCache.has(file)) return thumbCache.get(file);
    if (thumbInflight.has(file)) return thumbInflight.get(file);
    const url = `/items-bank/${encodeURIComponent(file)}`;
    const p = new Promise((resolve) => {
      thumbLoader.load(url, (gltf) => {
        try {
          const root = gltf.scene;
          // Fit the model to a 1.5m bbox so it frames cleanly.
          const box = new THREE.Box3().setFromObject(root);
          const size = box.getSize(new THREE.Vector3());
          const longest = Math.max(size.x, size.y, size.z, 0.001);
          const scale = 1.5 / longest;
          root.scale.setScalar(scale);
          root.updateMatrixWorld(true);
          const box2 = new THREE.Box3().setFromObject(root);
          const center = box2.getCenter(new THREE.Vector3());
          root.position.sub(center);
          thumbScene.add(root);
          // Camera 2.5m back, slightly above + 30°-rotated for a 3/4 view.
          thumbCam.position.set(1.6, 1.2, 1.8);
          thumbCam.lookAt(0, 0, 0);
          thumbRenderer.render(thumbScene, thumbCam);
          const dataUrl = thumbRenderer.domElement.toDataURL('image/png');
          thumbScene.remove(root);
          _disposeObject(root);
          thumbCache.set(file, dataUrl);
          resolve(dataUrl);
        } catch (err) {
          console.warn('[items] thumb render failed for', file, err);
          resolve(null);
        }
      }, undefined, (err) => {
        console.warn('[items] glb load failed for', file, err);
        resolve(null);
      });
    });
    thumbInflight.set(file, p);
    p.then(() => thumbInflight.delete(file));
    return p;
  }

  // Spawn point: 1 m in front of the camera, regardless of OrbitControls
  // target staleness or fly-mode state. Earlier versions used
  // `controls.target` directly which can lag behind the live camera (in
  // fly mode the target is whatever HERO_TARGET, COMPUTER_TARGET etc.
  // was set last), so items would drop somewhere the user wasn't looking.
  const _spawnFwd = new THREE.Vector3();
  function spawnAtFocus() {
    camera.getWorldDirection(_spawnFwd);
    const dist = 1.1; // metres in front of the camera
    return {
      x: camera.position.x + _spawnFwd.x * dist,
      y: camera.position.y + _spawnFwd.y * dist,
      z: camera.position.z + _spawnFwd.z * dist,
    };
  }
  // Per-asset scale hints — tuned so common bank models drop in at a
  // human-readable size. Falls back to 0.6 m on the longest axis.
  function _scaleHintForFile(file, label) {
    const s = `${file || ''} ${label || ''}`.toLowerCase();
    if (/light.?saber|saber/.test(s)) return 1.0;       // sabers are ~1 m
    if (/lightning.?mcqueen|mcqueen|mc.?queen/.test(s)) return 0.55;
    if (/falcon|millennium/.test(s)) return 1.4;        // big ship
    if (/\btie\b|tie.?fighter/.test(s)) return 0.8;
    if (/vespa|scooter/.test(s)) return 0.85;
    if (/thor.?hammer|mjolnir/.test(s)) return 0.55;
    if (/hover.?board/.test(s)) return 0.8;
    if (/death.?star/.test(s)) return 1.2;
    if (/woody|toy.?story|zorg|lenny|jessie|buzz/.test(s)) return 1.0; // figures
    if (/walle|wall.?e|boot/.test(s)) return 0.7;
    if (/nike|air.?mag/.test(s)) return 0.35;            // shoes — small
    if (/hammer|axe/.test(s)) return 0.55;
    if (/lego/.test(s)) return 0.7;                      // generic Lego
    return 0.6;
  }
  // Persisted bank-spawn registry — list of every item the user has
  // dropped from the panel. On page load we replay this list so the
  // scene comes back exactly as they left it. Each entry's transform /
  // material state lives under the regular `item.<label>.*` keys, which
  // loadProp already restores when the GLB finishes loading.
  const BANK_SPAWNED_KEY = 'bank.spawned.v2';
  function loadBankSpawnedList() {
    try { return JSON.parse(localStorage.getItem(BANK_SPAWNED_KEY) || '[]'); }
    catch { return []; }
  }
  function saveBankSpawnedList(arr) {
    try { localStorage.setItem(BANK_SPAWNED_KEY, JSON.stringify(arr)); } catch {}
  }
  function pushBankSpawnedEntry(entry) {
    const arr = loadBankSpawnedList();
    arr.push(entry);
    saveBankSpawnedList(arr);
  }
  // Expose so the contextual editor's 🗑 Remove handler can strip an
  // entry from the registry when the user removes a bank-dropped item.
  window.__bankRemoveSpawnedById = (id) => {
    const arr = loadBankSpawnedList().filter((e) => e.id !== id);
    saveBankSpawnedList(arr);
  };

  let _itemSpawnCounter = 0;
  function spawnFromRegistry(entry, autoSelect) {
    const group = loadProp({
      id: entry.id, label: entry.label,
      glbPath: `/items-bank/${encodeURIComponent(entry.file)}`,
      target: entry.target || spawnAtFocus(),
      scaleTarget: entry.scaleTarget ?? 0.6,
    });
    if (!autoSelect) return group;
    // Open the contextual editor IMMEDIATELY — the group exists and has
    // a position even before the GLB streams in, so position / rotate
    // sliders work right away. Once the mesh data arrives, material
    // sliders also become useful (a re-trigger of selection refreshes
    // the editor against the populated geometry).
    //
    // Defer one tick so any lingering pointerdown/click handlers from
    // the modal-close path don't immediately deselect what we just set.
    setTimeout(() => {
      const found = SELECTABLE.find((s) => s.group === group);
      if (!found) {
        console.warn('[items] could not find newly spawned group in SELECTABLE', entry.label);
        return;
      }
      selectedItem = found;
      tControls.attach(group);
      refreshHud();
      if (typeof window.__onSelectionChange === 'function') {
        window.__onSelectionChange(found, true);
        console.log('[items] editor opened for', entry.label);
      } else {
        console.warn('[items] __onSelectionChange not wired yet');
      }
    }, 30);
    // Re-fire selection once the GLB has actually loaded so the editor
    // rebuilds with the real material list (shininess / brightness /
    // reflection / glow sliders need the populated mesh tree). The
    // `force` flag bypasses setMode's same-label early-return.
    let polls = 0;
    const sel = setInterval(() => {
      polls += 1;
      if (group.children.length > 0) {
        clearInterval(sel);
        if (selectedItem && selectedItem.group === group) {
          window.__onSelectionChange?.(selectedItem, true);
        }
        console.log('[items] GLB loaded for', entry.label);
      } else if (polls > 100) {
        clearInterval(sel);
        console.warn('[items] never loaded', entry.file);
      }
    }, 50);
    return group;
  }
  function dropItem(file, label) {
    _itemSpawnCounter += 1;
    const id = `bank-${file.replace(/\.glb$/i, '')}-${Date.now().toString(36)}-${_itemSpawnCounter}`;
    const dropLabel = `${label} ${_itemSpawnCounter}`;
    const entry = { id, file, label: dropLabel, target: spawnAtFocus(), scaleTarget: _scaleHintForFile(file, label) };
    pushBankSpawnedEntry(entry);
    spawnFromRegistry(entry, true);
  }
  // ========================================================================
  // Bank-item restore on page load — load EVERY item the user has dropped.
  // Same code path for build mode and website mode: we sort by distance
  // to the camera focus so what's in view appears first, fire a small
  // immediate "burst" so the hero shot fills in fast, then drip-feed the
  // rest so the GPU upload doesn't spike all at once.
  //
  // (Streaming / disposal-when-far was removed at the user's request —
  // they want all items always visible.)
  // ========================================================================
  setTimeout(() => {
    let list = loadBankSpawnedList();
    if (!list.length) return;

    // 🚫 Website mode: hide the Lumiere candle for now (per user request,
    // until further tuning). Filtering it out of the spawn list means the
    // GLB never loads + the flame sprites + flame point lights never attach,
    // saving the parse + GPU upload + per-frame flame animation entirely.
    // Build mode keeps Lumiere so you can still see + position it.
    if (IS_WEBSITE_MODE) {
      const beforeN = list.length;
      list = list.filter((e) => !/lumiere/i.test(e?.label || '') && !/lumiere/i.test(e?.file || ''));
      if (list.length < beforeN) {
        console.log(`[items] website mode: hid ${beforeN - list.length} lumiere entry/entries`);
      }
    }

    // Maintain counter before we shuffle the iteration order.
    list.forEach((entry) => {
      _itemSpawnCounter = Math.max(_itemSpawnCounter, parseInt((entry.label.match(/(\d+)$/) || [])[1] || '0', 10));
    });

    // Distance sort — anchor on the OrbitControls target (camera focus).
    const focus = (window.__controls && window.__controls.target)
      ? window.__controls.target
      : camera.position;
    const dist2 = (t) => {
      if (!t || t.length < 3) return Infinity;
      const dx = t[0] - focus.x, dy = t[1] - focus.y, dz = t[2] - focus.z;
      return dx*dx + dy*dy + dz*dz;
    };
    const sorted = [...list].sort((a, b) => dist2(a.target) - dist2(b.target));

    const BURST = 8;          // spawn immediately
    const TICK  = 80;         // ms between subsequent spawns
    sorted.slice(0, BURST).forEach((entry) => spawnFromRegistry(entry, false));
    const queue = sorted.slice(BURST);
    if (queue.length === 0) {
      console.log(`[items] restored ${list.length} bank-spawned item(s) — all in burst`);
      return;
    }
    let idx = 0;
    const handle = setInterval(() => {
      if (idx >= queue.length) {
        clearInterval(handle);
        console.log(`[items] restored ${list.length} bank-spawned item(s) (burst=${BURST}, drip=${queue.length})`);
        return;
      }
      spawnFromRegistry(queue[idx], false);
      idx += 1;
    }, TICK);
  }, 1500);

  // 🚫 In website mode, the bank-spawn restore above already ran — we
  // just skip the 📦 Items picker button + modal here so visitors
  // don't see the editor UI.
  if (IS_WEBSITE_MODE) {
    console.log('[items] website mode — bank-spawn restored, picker UI hidden');
    return;
  }
  // ---- UI: floating button (top-left, beside Sliders menu) ------------
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '📦 Items';
  btn.style.cssText = `
    position: fixed; top: 16px; left: 130px;
    z-index: 60;
    pointer-events: auto;
    padding: 9px 14px; border-radius: 999px;
    border: 1px solid rgba(255,255,255,0.22);
    background: rgba(0,0,0,0.78); color: #fff;
    font: 12px system-ui; font-weight: 600;
    cursor: pointer; backdrop-filter: blur(12px);
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  `;
  document.body.appendChild(btn);

  // Modal panel that the button opens / closes.
  const modal = document.createElement('div');
  modal.style.cssText = `
    position: fixed; inset: 0; z-index: 70;
    display: none; align-items: center; justify-content: center;
    background: rgba(0,0,0,0.55); backdrop-filter: blur(4px);
  `;
  const card = document.createElement('div');
  card.style.cssText = `
    width: min(720px, 92vw); max-height: 80vh;
    background: rgba(20,22,26,0.95);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 16px; padding: 16px 18px;
    color: #fff; font: 12px system-ui;
    display: flex; flex-direction: column; gap: 12px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.6);
  `;
  modal.appendChild(card);
  document.body.appendChild(modal);

  // Header
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;';
  const headerTitle = document.createElement('span');
  headerTitle.textContent = '📦 Item bank — click any model to drop into your view';
  const closeX = document.createElement('button');
  closeX.type = 'button';
  closeX.textContent = '×';
  closeX.style.cssText = 'width:28px;height:28px;border-radius:8px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:#fff;cursor:pointer;font-size:18px;line-height:1;padding:0;';
  closeX.addEventListener('click', () => { modal.style.display = 'none'; });
  header.append(headerTitle, closeX);
  card.appendChild(header);

  const status = document.createElement('div');
  status.style.cssText = 'font-size:11px;opacity:0.7;';
  card.appendChild(status);

  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;overflow-y:auto;padding:4px;';
  card.appendChild(grid);

  let _items = null;     // {file,label}[] cached
  let _gridBuilt = false;

  async function ensureLoaded() {
    if (_items) return _items;
    status.textContent = 'Loading item list…';
    try {
      const r = await fetch('/items-bank/index.json');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      // Defensive client-side filter: drop dot-prefixed files (macOS
      // resource-fork "._foo.glb" helpers). Belt + suspenders with the
      // server-side filter — works even if the dev server hasn't been
      // restarted since the vite.config.js change.
      _items = (json.items || []).filter((it) => !it.file.startsWith('.'));
      status.textContent = `${_items.length} models in /items-bank — thumbnails render the first time you open this panel.`;
    } catch (err) {
      status.textContent = `Item bank unavailable: ${err.message}. Restart \`npm run dev\` after vite.config.js changes.`;
      status.style.color = '#ffb3b3';
      _items = [];
    }
    return _items;
  }

  function buildGrid() {
    if (_gridBuilt) return;
    _gridBuilt = true;
    while (grid.firstChild) grid.removeChild(grid.firstChild);
    _items.forEach((it) => {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.style.cssText = `
        display:flex;flex-direction:column;align-items:center;gap:6px;
        padding:8px;border-radius:10px;
        border:1px solid rgba(255,255,255,0.10);
        background:rgba(255,255,255,0.04);
        color:#fff;cursor:pointer;font:11px system-ui;text-align:center;
        transition: background 0.15s;
      `;
      tile.addEventListener('mouseenter', () => { tile.style.background = 'rgba(125,255,160,0.10)'; });
      tile.addEventListener('mouseleave', () => { tile.style.background = 'rgba(255,255,255,0.04)'; });
      // Placeholder image
      const img = document.createElement('img');
      img.style.cssText = 'width:120px;height:120px;border-radius:8px;background:#1a1d22;object-fit:cover;display:block;';
      tile.appendChild(img);
      const lab = document.createElement('span');
      lab.textContent = it.label;
      lab.style.cssText = 'font-weight:600;line-height:1.2;max-width:120px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;';
      tile.appendChild(lab);
      grid.appendChild(tile);
      // Click to drop + close
      tile.addEventListener('click', () => {
        dropItem(it.file, it.label);
        modal.style.display = 'none';
      });
      // Lazy: render thumbnail when the panel is opened.
      renderThumbnail(it.file).then((url) => {
        if (url) img.src = url;
      });
    });
  }

  btn.addEventListener('click', async () => {
    modal.style.display = 'flex';
    await ensureLoaded();
    buildGrid();
  });
  // Click outside the card → close.
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.style.display = 'none';
  });
  // Esc closes.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display === 'flex') {
      modal.style.display = 'none';
    }
  });
})();

// ---------- Floating Sliders menu --------------------------------------
// Single button (top-left corner) that drops down a category list. Pick
// any category and the corresponding edit card slides in (top-right).
// Replaces the half-dozen panels we used to cram in the bottom-left.
(function mountSlidersMenu() {
  // Editor UI is hidden in website mode — visitors should never see
  // build/dev controls. Use ?mode=build on the prod URL to bring it
  // back temporarily for tuning a live deploy.
  if (IS_WEBSITE_MODE) {
    console.log('[mode] website — Sliders menu hidden (editor UI off)');
    return;
  }
  const root = document.createElement('div');
  root.style.cssText = `
    position: fixed; top: 16px; left: 16px;
    z-index: 60; display: flex; flex-direction: column; align-items: flex-start;
    gap: 6px; pointer-events: none;
  `;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '☰ Sliders';
  btn.style.cssText = `
    pointer-events: auto;
    padding: 9px 14px; border-radius: 999px;
    border: 1px solid rgba(255,255,255,0.22);
    background: rgba(0,0,0,0.78); color: #fff;
    font: 12px system-ui; font-weight: 600;
    cursor: pointer; backdrop-filter: blur(12px);
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  `;
  const menu = document.createElement('div');
  menu.style.cssText = `
    pointer-events: auto;
    background: rgba(0,0,0,0.78);
    border: 1px solid rgba(255,255,255,0.14);
    border-radius: 12px; padding: 8px;
    backdrop-filter: blur(12px);
    box-shadow: 0 8px 24px rgba(0,0,0,0.55);
    display: none; flex-direction: column; gap: 4px;
    min-width: 220px;
    max-height: calc(100vh - 60px);
    overflow-y: auto;
  `;
  root.append(btn, menu);
  document.body.appendChild(root);

  const ITEMS = [
    { key: 'shelf',        label: '📚 Left shelf' },
    { key: 'rightShelf',   label: '📚 Right shelf' },
    { key: 'shelfSpacing', label: '📐 Shelf spacing' },
    { key: 'desk',         label: '🪑 Desk + view' },
    { key: 'computer',     label: '🖥 Computer + view' },
    { key: 'backdrop',     label: '🌅 Backdrop' },
    { key: 'lights',       label: '💡 Venator lights' },
    { key: 'shelfStrip',   label: '🔦 Strip lights (BOTH shelves)' },
    { key: 'artFrame',     label: '🏁 Speed frame' },
  ];
  ITEMS.forEach((it) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = it.label;
    b.style.cssText = 'padding:7px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.10);background:transparent;color:#fff;cursor:pointer;font:12px system-ui;text-align:left;';
    b.addEventListener('mouseenter', () => { b.style.background = 'rgba(255,255,255,0.07)'; });
    b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
    b.addEventListener('click', () => {
      menu.style.display = 'none';
      // Art frame is a regular SELECTABLE that we deliberately made
      // click-through so it doesn't steal raycasts. Selecting it via
      // this menu programmatically opens the contextual editor (with
      // every item's full transform / material / fly-lock / remove
      // controls + the frame-specific dimension sliders).
      if (it.key === 'artFrame') {
        const g = window.__artFrameGroup;
        if (g) {
          const item = SELECTABLE.find((s) => s.group === g);
          if (item) {
            selectedItem = item;
            tControls.attach(g);
            refreshHud();
            window.__onSelectionChange?.(item, true);
          }
        }
        return;
      }
      window.__openEditCard?.(it.key);
    });
    menu.appendChild(b);
  });

  // Dynamic Frame N entries — every frame the user spawns via "Add frame
  // here" in any item editor gets its own button here so the user can
  // jump straight into its editor (transform / material / pair sliders).
  // Rebuilt every time the Sliders menu opens (see btn click below) so
  // newly-spawned frames appear immediately without a reload.
  const extraFramesContainer = document.createElement('div');
  extraFramesContainer.style.cssText = 'display:flex;flex-direction:column;gap:3px;';
  menu.appendChild(extraFramesContainer);
  function refreshExtraFrameButtons() {
    extraFramesContainer.innerHTML = '';
    let extras = [];
    try { extras = JSON.parse(localStorage.getItem('extraFrames.v1') || '[]'); } catch {}
    for (const e of extras) {
      if (!e?.label) continue;
      const grp = scene.getObjectByName(`__prop_extraframe_${e.label.replace(/\s+/g, '_')}`);
      if (!grp) continue;
      const fb = document.createElement('button');
      fb.type = 'button';
      fb.textContent = `🖼 ${e.label}` + (e.anchorLabel ? `  ·  under ${e.anchorLabel}` : '');
      fb.style.cssText = 'padding:7px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.10);background:transparent;color:#fff;cursor:pointer;font:12px system-ui;text-align:left;';
      fb.addEventListener('mouseenter', () => { fb.style.background = 'rgba(255,255,255,0.07)'; });
      fb.addEventListener('mouseleave', () => { fb.style.background = 'transparent'; });
      fb.addEventListener('click', () => {
        menu.style.display = 'none';
        const sel = SELECTABLE.find((s) => s.group === grp);
        if (sel) {
          selectedItem = sel;
          tControls.attach(grp);
          refreshHud();
          window.__onSelectionChange?.(sel, true);
        }
      });
      extraFramesContainer.appendChild(fb);
    }
  }
  // Expose so the in-editor "Add frame here" handler can re-trigger this
  // immediately after spawning.
  window.__refreshSlidersFrameList = refreshExtraFrameButtons;

  // (Steam style picker moved into the mug's contextual editor — click
  // the mug in the scene to access it.)

  // Divider + Reset all positions (wipes localStorage and reloads to the
  // hardcoded defaults — useful when the saved state is mangled).
  const sep = document.createElement('div');
  sep.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:4px 0;';
  menu.appendChild(sep);
  // 🔬 Diagnose — prints every saved key + every live SELECTABLE
  // position to the console so we can hand-recover specific items.
  const diag = document.createElement('button');
  diag.type = 'button';
  diag.textContent = '🔬 Diagnose state (copy console output)';
  diag.style.cssText = 'padding:7px 10px;border-radius:8px;border:1px solid rgba(125,160,255,0.45);background:transparent;color:#cfe9ff;cursor:pointer;font:11px system-ui;text-align:left;';
  diag.addEventListener('click', () => {
    try {
      const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
      const pairs = JSON.parse(localStorage.getItem('pairLocks.v1') || '[]');
      const bank  = JSON.parse(localStorage.getItem('bank.spawned.v2') || '[]');
      const itemKeys = Object.keys(cur).filter((k) => /^item\./.test(k)).sort();
      const itemSummary = {};
      for (const k of itemKeys) {
        const m = k.match(/^item\.(.+?)\.(x|y|z|rotX|rotY|rotZ|scale)$/);
        if (!m) continue;
        const lbl = m[1].replace(/_/g, ' ');
        if (!itemSummary[lbl]) itemSummary[lbl] = {};
        itemSummary[lbl][m[2]] = cur[k];
      }
      console.log('=== DIAGNOSE ===');
      console.log('Live SELECTABLE labels + world positions:');
      for (const s of SELECTABLE) {
        if (!s.group) continue;
        const wp = new THREE.Vector3();
        s.group.updateMatrixWorld(true);
        s.group.getWorldPosition(wp);
        console.log(`  "${s.label}" → world (${wp.x.toFixed(2)}, ${wp.y.toFixed(2)}, ${wp.z.toFixed(2)})`);
      }
      console.log('Persisted item positions:', itemSummary);
      console.log('Pair-locks:', pairs);
      console.log('Bank-spawned items:', bank);
      console.log('=== END ===');
      alert('Diagnostic dumped to console. Open DevTools (Cmd+Opt+I) → Console tab, copy everything between "=== DIAGNOSE ===" and "=== END ===", paste it back to me.');
    } catch (err) {
      console.error('[diagnose] failed', err);
    }
  });
  menu.appendChild(diag);
  // 🔓 Unpair everything — breaks every pair-lock so items decouple
  // from each other. Doesn't move them or change their saved positions
  // — just removes all anchor/follower relationships. Use this when
  // multiple items end up clustered to one spot because of a runaway
  // auto-pair.
  const unpair = document.createElement('button');
  unpair.type = 'button';
  unpair.textContent = '🔓 Unpair everything (keeps item positions)';
  unpair.style.cssText = 'padding:7px 10px;border-radius:8px;border:1px solid rgba(255,200,80,0.35);background:transparent;color:#ffd9a8;cursor:pointer;font:11px system-ui;text-align:left;';
  unpair.addEventListener('click', () => {
    if (!confirm('Break every match/pair-lock between items? Item POSITIONS stay where they are — only the auto-follow relationships are removed.')) return;
    try { localStorage.setItem('pairLocks.v1', '[]'); } catch {}
    location.reload();
  });
  menu.appendChild(unpair);
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.textContent = '🗑 Reset all positions';
  reset.style.cssText = 'padding:7px 10px;border-radius:8px;border:1px solid rgba(255,120,120,0.35);background:transparent;color:#ffb3b3;cursor:pointer;font:11px system-ui;text-align:left;';
  reset.addEventListener('click', () => {
    if (!confirm('Clear every saved position + item state and reload?')) return;
    try { localStorage.removeItem('desk-portfolio:positions:v1'); } catch {}
    location.reload();
  });
  menu.appendChild(reset);

  // 🔒 Pinned baselines — survive the 24h pruner. Each entry is a
  // hand-curated checkpoint (e.g. the recovered May 11 1:12am state).
  // Click a row to restore it; current state is auto-snapshotted first
  // so a bad restore can be undone.
  const baseTitle = document.createElement('div');
  baseTitle.textContent = '🔒 Pinned baselines (never auto-deleted)';
  baseTitle.style.cssText = 'margin-top:8px;font:11px system-ui;color:#ffd9a8;opacity:0.95;font-weight:700;';
  menu.appendChild(baseTitle);
  const baseList = document.createElement('div');
  baseList.style.cssText = 'display:flex;flex-direction:column;gap:3px;';
  menu.appendChild(baseList);
  function paintBaselines() {
    baseList.innerHTML = '';
    const items = (typeof window.__listBaselines === 'function') ? window.__listBaselines() : [];
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = '(none yet — saved baselines appear here)';
      empty.style.cssText = 'font:10.5px system-ui;color:#777;padding:3px 6px;';
      baseList.appendChild(empty);
      return;
    }
    for (const it of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const human = it.id
        .replace(/^(\d{4})-(\d{2})-(\d{2})-(\d{4})(am|pm)?/, '$1-$2-$3 $4$5')
        .replace(/-/g, ' ');
      btn.textContent = '🔒 ' + human + '  ·  ' + (it.bytes / 1024).toFixed(0) + ' KB';
      btn.style.cssText = 'padding:7px 10px;border-radius:6px;border:1px solid rgba(255,200,120,0.45);background:rgba(255,200,120,0.08);color:#ffd9a8;cursor:pointer;font:11px system-ui;text-align:left;';
      btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(255,200,120,0.18)'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(255,200,120,0.08)'; });
      btn.addEventListener('click', () => {
        if (!confirm(`Restore baseline "${it.id}"?\n\nYour current state will be snapshotted first so you can undo if needed.`)) return;
        window.__restoreBaseline(it.key);
      });
      baseList.appendChild(btn);
    }
  }
  paintBaselines();

  // 🕘 Snapshots — list of auto-saved position snapshots (every 5 min).
  // Click a row to restore it (current state is snapshotted right before
  // the restore so a bad restore can itself be undone).
  const snapTitle = document.createElement('div');
  snapTitle.textContent = '🕘 Snapshots (auto every 5 min)';
  snapTitle.style.cssText = 'margin-top:6px;font:11px system-ui;color:#cfe9ff;opacity:0.8;';
  menu.appendChild(snapTitle);
  const snapList = document.createElement('div');
  snapList.style.cssText = 'display:flex;flex-direction:column;gap:3px;max-height:180px;overflow:auto;';
  menu.appendChild(snapList);
  const fmtAge = (ms) => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m ago`;
    return `${Math.floor(h / 24)}d ${h % 24}h ago`;
  };
  function refreshSnapList() {
    snapList.innerHTML = '';
    let snaps = [];
    try { snaps = window.__listSnapshots ? window.__listSnapshots() : []; } catch {}
    if (!snaps.length) {
      const empty = document.createElement('div');
      empty.textContent = '— no snapshots yet —';
      empty.style.cssText = 'font:10px system-ui;color:#888;padding:4px 8px;';
      snapList.appendChild(empty);
      return;
    }
    const now = Date.now();
    for (const s of snaps) {
      const row = document.createElement('button');
      row.type = 'button';
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;padding:5px 8px;border-radius:6px;border:1px solid rgba(125,160,255,0.30);background:transparent;color:#cfe9ff;cursor:pointer;font:10.5px system-ui;text-align:left;';
      const left = document.createElement('span');
      left.textContent = `${fmtAge(now - s.t)}  ·  ${s.itemCount} items`;
      const right = document.createElement('span');
      right.textContent = '↺ restore';
      right.style.cssText = 'opacity:0.7;font-size:10px;';
      row.appendChild(left); row.appendChild(right);
      row.addEventListener('click', () => {
        if (!confirm(`Restore snapshot from ${fmtAge(now - s.t)}? Current state is auto-saved as a new snapshot first.`)) return;
        try { window.__restoreSnapshot(s.key); } catch (err) { console.error('[snapshot] restore failed', err); }
      });
      snapList.appendChild(row);
    }
  }
  // Manual snapshot button
  const snapNow = document.createElement('button');
  snapNow.type = 'button';
  snapNow.textContent = '📸 Snapshot now';
  snapNow.style.cssText = 'padding:6px 10px;border-radius:8px;border:1px solid rgba(125,255,200,0.40);background:transparent;color:#a8ffd9;cursor:pointer;font:11px system-ui;text-align:left;margin-top:2px;';
  snapNow.addEventListener('click', () => {
    try {
      window.__takeSnapshot && window.__takeSnapshot('manual');
      refreshSnapList();
    } catch (err) { console.error(err); }
  });
  menu.appendChild(snapNow);

  // 🔍 Max resolution toggle — when ON, force full devicePixelRatio +
  // bigger shadow map for a crisp final-look render. When OFF, the
  // adaptive-DPR system drops to 1.0 during heavy work for smooth
  // dragging. Persisted under positions blob so the choice survives.
  const maxResBtn = document.createElement('button');
  maxResBtn.type = 'button';
  function paintMaxResBtn() {
    const on = !!window.__maxResolution;
    maxResBtn.textContent = on ? '🔍 Max resolution: ON (crisp)' : '🔍 Max resolution: OFF (smooth)';
    maxResBtn.style.cssText = on
      ? 'padding:6px 10px;border-radius:8px;border:1px solid rgba(255,200,100,0.55);background:rgba(255,200,100,0.12);color:#ffd9a8;cursor:pointer;font:11px system-ui;text-align:left;margin-top:2px;'
      : 'padding:6px 10px;border-radius:8px;border:1px solid rgba(255,200,100,0.30);background:transparent;color:#ffd9a8;cursor:pointer;font:11px system-ui;text-align:left;margin-top:2px;';
  }
  maxResBtn.addEventListener('click', () => {
    if (typeof window.__setMaxResolution === 'function') {
      window.__setMaxResolution(!window.__maxResolution);
      paintMaxResBtn();
    }
  });
  paintMaxResBtn();
  // Pin to TOP of menu so it's always visible without scrolling.
  menu.insertBefore(maxResBtn, menu.firstChild);

  // 🚀 Performance Mode picker — 3 presets (Smooth / Balanced / Crisp).
  // Use Smooth while placing items (saves GPU + heat), Crisp for the
  // final showcase look. Auto-defaults to Smooth on weaker machines.
  const perfWrap = document.createElement('div');
  perfWrap.style.cssText = 'display:flex;flex-direction:column;gap:3px;margin-top:6px;padding:6px;border-radius:6px;background:rgba(125,255,200,0.06);border:1px solid rgba(125,255,200,0.18);';
  const perfHdr = document.createElement('div');
  perfHdr.textContent = '🚀 Performance Mode';
  perfHdr.style.cssText = 'font:11px system-ui;color:#a8ffd9;opacity:0.9;margin-bottom:2px;';
  perfWrap.appendChild(perfHdr);
  const perfTip = document.createElement('div');
  perfTip.textContent = '🚀 Turbo = raw FPS (no bloom/DoF, 0.5× DPR, 0.35× glass refraction). 🌬 Smooth = fast & cooler Mac. ✨ Crisp = full cinematic.';
  perfTip.style.cssText = 'font:10px system-ui;color:#888;line-height:1.4;';
  perfWrap.appendChild(perfTip);
  const perfRow = document.createElement('div');
  perfRow.style.cssText = 'display:flex;gap:3px;';
  const perfBtns = {};
  function paintPerfTier() {
    const cur = (typeof window.__getPerfTier === 'function') ? window.__getPerfTier() : 'balanced';
    Object.entries(perfBtns).forEach(([key, btn]) => {
      const on = key === cur;
      btn.style.cssText = `flex:1;padding:6px 4px;border-radius:5px;border:1px solid ${on ? 'rgba(125,255,200,0.55)' : 'rgba(255,255,255,0.12)'};background:${on ? 'rgba(125,255,200,0.18)' : 'transparent'};color:#fff;cursor:pointer;font:10px system-ui;text-align:center;`;
    });
  }
  for (const key of ['turbo', 'smooth', 'balanced', 'crisp']) {
    const b = document.createElement('button');
    b.type = 'button';
    // Short labels for the 4-up button row.
    b.textContent =
      key === 'turbo'    ? '🚀 Turbo'
    : key === 'smooth'   ? '🌬 Smooth'
    : key === 'balanced' ? '⚖ Balanced'
    : '✨ Crisp';
    b.addEventListener('click', () => {
      window.__setPerfTier?.(key);
      paintPerfTier();
    });
    perfBtns[key] = b;
    perfRow.appendChild(b);
  }
  perfWrap.appendChild(perfRow);
  paintPerfTier();
  // Pin Performance Mode to the VERY TOP of the menu (above Max
  // Resolution) so the user never has to scroll to find Turbo / Smooth.
  menu.insertBefore(perfWrap, menu.firstChild);
  // Visual separator between perf controls and the rest of the menu.
  const perfSep = document.createElement('div');
  perfSep.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:4px 0;';
  menu.insertBefore(perfSep, maxResBtn.nextSibling);

  // 📤 Push current state to LIVE site — bundles every localStorage
  // key the website mode reads and POSTs to
  // https://desk-portfolio-production.up.railway.app/api/frozen-scene
  // with Bearer auth. Visitors on the prod URL see the new state on
  // their next page load (no redeploy needed).
  const LIVE_URL = 'https://desk-portfolio-production.up.railway.app';
  const PUSH_BTN_KEY = 'pushSecret.v1';
  const pushBtn = document.createElement('button');
  pushBtn.type = 'button';
  pushBtn.textContent = '📤 Push current state to LIVE site';
  pushBtn.style.cssText = 'padding:8px 10px;border-radius:8px;border:1px solid rgba(120,255,180,0.55);background:rgba(120,255,180,0.14);color:#cfffd9;cursor:pointer;font:11px system-ui;font-weight:700;text-align:left;margin-top:2px;';
  pushBtn.addEventListener('click', async () => {
    let secret = localStorage.getItem(PUSH_BTN_KEY);
    if (!secret) {
      secret = prompt('Paste your Railway PUSH_SECRET (saved locally for next time):');
      if (!secret) return;
      localStorage.setItem(PUSH_BTN_KEY, secret.trim());
      secret = secret.trim();
    }
    const payload = {
      positions:        JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}'),
      pairLocks:        localStorage.getItem('pairLocks.v1'),
      bankSpawned:      localStorage.getItem('bank.spawned.v2'),
      extraFrames:      localStorage.getItem('extraFrames.v1'),
      hidden:           localStorage.getItem('hidden.props.v1'),
      shelfLightsExtra: localStorage.getItem('shelfLights.extra.v1'),
      clonedItems:      localStorage.getItem('clonedItems.v1'),
    };
    const originalLabel = pushBtn.textContent;
    pushBtn.textContent = '⏳ Pushing…';
    pushBtn.disabled = true;
    try {
      const res = await fetch(LIVE_URL + '/api/frozen-scene', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + secret },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        pushBtn.textContent = '✅ Pushed to live!';
        setTimeout(() => { pushBtn.textContent = originalLabel; pushBtn.disabled = false; }, 2200);
        console.log('[push] success — visit', LIVE_URL, 'to verify');
      } else {
        const t = await res.text();
        pushBtn.textContent = `❌ ${res.status}`;
        setTimeout(() => { pushBtn.textContent = originalLabel; pushBtn.disabled = false; }, 3000);
        console.error('[push] failed:', res.status, t);
        if (res.status === 401) {
          localStorage.removeItem(PUSH_BTN_KEY);
          alert('PUSH_SECRET rejected. Cleared local cache — try again.');
        }
      }
    } catch (err) {
      console.error('[push] error', err);
      pushBtn.textContent = '❌ Network error';
      setTimeout(() => { pushBtn.textContent = originalLabel; pushBtn.disabled = false; }, 3000);
    }
  });
  menu.insertBefore(pushBtn, perfSep);

  // 📸 Bake 360° backdrop — captures the current scene as a 6-face cube
  // atlas (single PNG, 3×2 grid). Save it, then on the next push the
  // website mode will use it instead of the live room geometry.
  const bakeBtn = document.createElement('button');
  bakeBtn.type = 'button';
  bakeBtn.textContent = '📸 Bake 360° backdrop (saves PNG to Downloads)';
  bakeBtn.style.cssText = 'padding:8px 10px;border-radius:8px;border:1px solid rgba(255,200,100,0.55);background:rgba(255,200,100,0.14);color:#ffd9a8;cursor:pointer;font:11px system-ui;font-weight:700;text-align:left;margin-top:2px;';
  bakeBtn.addEventListener('click', async () => {
    if (typeof window.__captureBackdrop !== 'function') {
      alert('capture not ready yet — wait for page to finish loading');
      return;
    }
    const prevLabel = bakeBtn.textContent;
    bakeBtn.textContent = '⏳ Baking… (page will freeze for ~30s)';
    bakeBtn.disabled = true;
    try {
      // Capture from the camera's CURRENT position + name by current mode.
      // Lets you switch to any mode in the picker, then 📸 → only that
      // mode's atlas is produced. Useful when one mode failed in the
      // ALL-4 bake (Chrome blocks the 4th rapid download).
      const mode = (typeof _currentMode === 'string' && _currentMode) ? _currentMode : 'hero';
      const fname = `cube-atlas-${mode}-1024.png`;
      await window.__captureBackdrop({
        size: 1024,
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z,
        filename: fname,
      });
      bakeBtn.textContent = `✅ Saved ${fname}`;
      setTimeout(() => { bakeBtn.textContent = prevLabel; bakeBtn.disabled = false; }, 4000);
    } catch (e) {
      bakeBtn.textContent = '❌ Bake failed (see console)';
      console.error('[backdrop] error', e);
      setTimeout(() => { bakeBtn.textContent = prevLabel; bakeBtn.disabled = false; }, 4000);
    }
  });
  menu.insertBefore(bakeBtn, perfSep);

  // 🎬 Bake ALL 4 camera modes at once (sit, computer, shelfL, shelfR).
  // Each capture happens from the actual camera position that mode uses.
  // Drops 4 PNGs into Downloads, named cube-atlas-<mode>-1024.png.
  const bakeAllBtn = document.createElement('button');
  bakeAllBtn.type = 'button';
  bakeAllBtn.textContent = '🎬 Bake ALL 4 modes (sit, computer, L-shelf, R-shelf)';
  bakeAllBtn.style.cssText = 'padding:8px 10px;border-radius:8px;border:1px solid rgba(255,120,200,0.55);background:rgba(255,120,200,0.14);color:#ffd0e8;cursor:pointer;font:11px system-ui;font-weight:700;text-align:left;margin-top:2px;';
  bakeAllBtn.addEventListener('click', async () => {
    if (typeof window.__bakeAllModes !== 'function') {
      alert('bake-all not ready yet — wait for page to finish loading');
      return;
    }
    const prev = bakeAllBtn.textContent;
    bakeAllBtn.textContent = '⏳ Baking 4 modes… (~3 min, page will be janky)';
    bakeAllBtn.disabled = true;
    try {
      await window.__bakeAllModes({ size: 1024 });
      bakeAllBtn.textContent = '✅ Saved 4 cube-atlas PNGs to Downloads';
      setTimeout(() => { bakeAllBtn.textContent = prev; bakeAllBtn.disabled = false; }, 5000);
    } catch (e) {
      bakeAllBtn.textContent = '❌ Bake-all failed (see console)';
      console.error('[bake-all] error', e);
      setTimeout(() => { bakeAllBtn.textContent = prev; bakeAllBtn.disabled = false; }, 5000);
    }
  });
  menu.insertBefore(bakeAllBtn, perfSep);

  // (Per-shelf vertical CROP sliders live inside the 📚 Left shelf and
  // 📚 Right shelf cards now — drag the "Crop top" / "Crop bottom"
  // sliders there to hide individual shelf levels on each side
  // independently.)

  // 🌸 Bonsai leaves — quick-access for when the leaves have drifted
  // off-screen. "Find" frames the camera on them + attaches the gizmo;
  // "Reset" snaps them back to their original room.glb centroid.
  const leavesRow = document.createElement('div');
  leavesRow.style.cssText = 'display:flex;gap:4px;margin-top:2px;';
  const findLeavesBtn = document.createElement('button');
  findLeavesBtn.type = 'button';
  findLeavesBtn.textContent = '🌸 Find leaves';
  findLeavesBtn.style.cssText = 'flex:1;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,180,255,0.45);background:rgba(255,180,255,0.10);color:#ffd9ff;cursor:pointer;font:10.5px system-ui;text-align:center;';
  findLeavesBtn.addEventListener('click', () => {
    if (typeof window.__selectBonsaiLeaves === 'function') window.__selectBonsaiLeaves();
    else alert('Bonsai leaves not loaded yet — wait a moment.');
  });
  const resetLeavesBtn = document.createElement('button');
  resetLeavesBtn.type = 'button';
  resetLeavesBtn.textContent = '↺ Reset leaves';
  resetLeavesBtn.style.cssText = 'flex:1;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,180,255,0.30);background:transparent;color:#ffd9ff;cursor:pointer;font:10.5px system-ui;text-align:center;';
  resetLeavesBtn.addEventListener('click', () => {
    if (!confirm('Snap bonsai leaves back to their original spot? (drag-positions are cleared)')) return;
    if (typeof window.__resetBonsaiLeavesPosition === 'function') window.__resetBonsaiLeavesPosition();
  });
  leavesRow.appendChild(findLeavesBtn);
  leavesRow.appendChild(resetLeavesBtn);
  menu.insertBefore(leavesRow, perfSep);

  // ❌ Deselect — kill any active gizmo (Esc shortcut also does this).
  // Useful when the rotation/translate handles are stuck on screen.
  const deselectBtn = document.createElement('button');
  deselectBtn.type = 'button';
  deselectBtn.textContent = '❌ Hide gizmo / deselect (Esc)';
  deselectBtn.style.cssText = 'padding:6px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.20);background:rgba(255,255,255,0.05);color:#fff;cursor:pointer;font:11px system-ui;text-align:left;margin-top:2px;';
  deselectBtn.addEventListener('click', () => {
    if (typeof window.__deselectAll === 'function') window.__deselectAll();
    else if (typeof tControls !== 'undefined') tControls.detach();
  });
  menu.insertBefore(deselectBtn, perfSep);

  // 📋 Copy / Paste buttons — same code path as Cmd+C / Cmd+V but
  // accessible without keyboard. Useful when focus is somewhere odd.
  const cpRow = document.createElement('div');
  cpRow.style.cssText = 'display:flex;gap:4px;margin-top:2px;';
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.textContent = '📋 Copy selected (Cmd+C)';
  copyBtn.style.cssText = 'flex:1;padding:6px 8px;border-radius:6px;border:1px solid rgba(140,200,255,0.45);background:rgba(140,200,255,0.10);color:#cfe9ff;cursor:pointer;font:10.5px system-ui;text-align:center;';
  copyBtn.addEventListener('click', () => {
    if (typeof window.__copySelectedItem === 'function') window.__copySelectedItem();
  });
  const pasteBtn = document.createElement('button');
  pasteBtn.type = 'button';
  pasteBtn.textContent = '📋 Paste (Cmd+V)';
  pasteBtn.style.cssText = 'flex:1;padding:6px 8px;border-radius:6px;border:1px solid rgba(140,200,255,0.45);background:rgba(140,200,255,0.10);color:#cfe9ff;cursor:pointer;font:10.5px system-ui;text-align:center;';
  pasteBtn.addEventListener('click', () => {
    if (typeof window.__pasteItem === 'function') window.__pasteItem();
  });
  cpRow.appendChild(copyBtn);
  cpRow.appendChild(pasteBtn);
  menu.insertBefore(cpRow, perfSep);

  // 🎯 Red marker workflow — user drags the red translucent box onto
  // the actual leaves in the scene, then clicks Lock to capture every
  // mesh inside the box. After lock, the marker (now hidden cube but
  // active group) drags those meshes around.
  const markerRow = document.createElement('div');
  markerRow.style.cssText = 'display:flex;gap:4px;margin-top:2px;';
  const lockBtn = document.createElement('button');
  lockBtn.type = 'button';
  lockBtn.textContent = '🔒 Lock leaves to red box';
  lockBtn.style.cssText = 'flex:1;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,80,80,0.55);background:rgba(255,80,80,0.15);color:#ffd0d0;cursor:pointer;font:10.5px system-ui;text-align:center;font-weight:700;';
  lockBtn.addEventListener('click', () => {
    if (typeof window.__lockLeavesToMarker === 'function') window.__lockLeavesToMarker();
    else alert('Marker not loaded yet — wait for the scene to finish.');
  });
  const unlockBtn = document.createElement('button');
  unlockBtn.type = 'button';
  unlockBtn.textContent = '🔓 Unlock';
  unlockBtn.style.cssText = 'flex:0 0 70px;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,80,80,0.30);background:transparent;color:#ffd0d0;cursor:pointer;font:10.5px system-ui;text-align:center;';
  unlockBtn.addEventListener('click', () => {
    if (typeof window.__unlockLeavesFromMarker === 'function') window.__unlockLeavesFromMarker();
  });
  markerRow.appendChild(lockBtn);
  markerRow.appendChild(unlockBtn);
  menu.insertBefore(markerRow, perfSep);

  // 🎚 Manual resolution slider — drop the renderer's pixel ratio for
  // smooth dragging / placement. 0.5 = quarter-pixels (very fast, blurry),
  // 1.0 = native, devicePixelRatio = retina max. Setting this overrides
  // Max Resolution + adaptive DPR until the user clicks "Auto" to clear.
  const resWrap = document.createElement('div');
  resWrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-top:6px;padding:6px 8px;border-radius:6px;background:rgba(125,160,255,0.06);border:1px solid rgba(125,160,255,0.18);';
  const resHeader = document.createElement('div');
  resHeader.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font:11px system-ui;color:#cfe9ff;';
  const resTitle = document.createElement('span');
  resTitle.textContent = '🎚 Render resolution';
  resHeader.appendChild(resTitle);
  const resValue = document.createElement('span');
  resValue.style.cssText = 'opacity:0.85;font-variant-numeric:tabular-nums;';
  resHeader.appendChild(resValue);
  resWrap.appendChild(resHeader);
  const resSlider = document.createElement('input');
  resSlider.type = 'range';
  resSlider.min = '0.5'; resSlider.max = String(Math.max(2, window.devicePixelRatio || 2)); resSlider.step = '0.05';
  function _readDpr() {
    return window.__manualDPR != null ? window.__manualDPR : (renderer?.getPixelRatio?.() || 1);
  }
  resSlider.value = String(_readDpr());
  function _paintResValue() {
    const v = _readDpr();
    const auto = window.__manualDPR == null;
    resValue.textContent = `${v.toFixed(2)}×${auto ? '  (auto)' : ''}`;
  }
  _paintResValue();
  resSlider.style.cssText = 'width:100%;';
  resSlider.addEventListener('input', () => {
    const v = parseFloat(resSlider.value);
    if (Number.isFinite(v)) {
      window.__setManualDPR(v);
      _paintResValue();
    }
  });
  resWrap.appendChild(resSlider);
  const resHint = document.createElement('div');
  resHint.textContent = 'Lower = smoother dragging. Higher = crisper. Click Auto to hand control back to adaptive DPR.';
  resHint.style.cssText = 'font:10px system-ui;color:#888;';
  resWrap.appendChild(resHint);
  const resAuto = document.createElement('button');
  resAuto.type = 'button';
  resAuto.textContent = '↺ Auto (clear manual override)';
  resAuto.style.cssText = 'padding:5px 8px;border-radius:6px;border:1px solid rgba(125,160,255,0.40);background:transparent;color:#cfe9ff;cursor:pointer;font:10.5px system-ui;text-align:left;';
  resAuto.addEventListener('click', () => {
    window.__setManualDPR(null);
    resSlider.value = String(_readDpr());
    _paintResValue();
  });
  resWrap.appendChild(resAuto);
  // Resolution slider goes at the TOP of the Sliders menu so it's
  // reachable without scrolling — the user uses it constantly while
  // placing things to drop the render cost for smooth dragging.
  menu.insertBefore(resWrap, menu.firstChild);

  let open = false;
  btn.addEventListener('click', () => {
    open = !open;
    menu.style.display = open ? 'flex' : 'none';
    if (open) {
      refreshSnapList();
      refreshExtraFrameButtons();
    }
  });
  // Refresh once on boot so any extra frames restored from extraFrames.v1
  // already show in the menu without needing to open it first.
  refreshExtraFrameButtons();
  // Click-outside to close
  document.addEventListener('pointerdown', (e) => {
    if (!open) return;
    if (root.contains(e.target)) return;
    open = false;
    menu.style.display = 'none';
  });
})();

// ---------- Floating Shelf View panel ---------------------------------
// Shows ONLY while the camera is in LEFT or RIGHT shelf-view mode. Has
// three sliders (zoom / vertical pan / horizontal pan) — same offsets
// apply to BOTH shelves because `shelfViewX/Y/Z` are now interpreted
// in the camera's local frame. Persisted to `shelfView.x/y/z` so the
// values survive reload.
(function mountViewPanPanel() {
  const panel = document.createElement('div');
  panel.style.cssText = `
    position: fixed; top: 16px; left: 16px;
    z-index: 60; pointer-events: auto; display: none;
    background: rgba(0,0,0,0.78);
    border: 1px solid rgba(255,255,255,0.14);
    border-radius: 10px; padding: 8px 10px;
    backdrop-filter: blur(12px);
    box-shadow: 0 6px 18px rgba(0,0,0,0.45);
    min-width: 280px;
    color: #fff; font: 11px system-ui;
  `;
  const title = document.createElement('div');
  title.style.cssText = 'font-weight:700;margin-bottom:4px;color:#cfe9ff;font-size:11px;';
  panel.appendChild(title);
  const subtitle = document.createElement('div');
  subtitle.style.cssText = 'font-size:10px;opacity:0.7;margin-bottom:6px;';
  subtitle.textContent = 'Shifts the camera + target along its local right/up axes.';
  panel.appendChild(subtitle);

  // Shared slider state; we re-bind it to the current mode's pan
  // values every time the visibility paints (so switching modes
  // updates the thumbs to that mode's stored pan).
  const state = { x: 0, y: 0 };
  let activeMode = null;
  const undo = makePanelUndo();
  function applyForMode() {
    if (!activeMode) return;
    applyModePan(activeMode, state.x, state.y);
  }
  const rows = {};
  function addRow(key, label, min, max) {
    const r = buildSliderRow({
      state, key, label, min, max,
      step: 0.005, fineStep: 0.001,
      undoStack: undo, onApply: applyForMode,
    });
    rows[key] = r;
    panel.appendChild(r.row);
  }
  addRow('x', 'X — move left ↔ right', -3, 3);
  addRow('y', 'Y — move down ↔ up',    -3, 3);

  const MODE_LABEL = {
    hero:     '🎚 Look around view (X / Y)',
    sit:      '🎚 Sit-down view (X / Y)',
    computer: '🎚 Use-computer view (X / Y)',
    shelf:    '🎚 Left shelf view (locked)',
    rightShelf: '🎚 Right shelf view (locked)',
  };
  function syncFromMode(mode) {
    activeMode = mode;
    title.textContent = MODE_LABEL[mode] || '🎚 View pan';
    const pan = _modePan[mode];
    if (pan) {
      state.x = pan.h;
      state.y = pan.v;
    } else {
      state.x = 0; state.y = 0;
    }
    rows.x?.set?.(state.x);
    rows.y?.set?.(state.y);
  }

  document.body.appendChild(panel);
  // Both pan systems (hero/sit/computer AND shelf) are now locked
  // with hardcoded values. The panel stays hidden unless explicitly
  // toggled on for re-tuning. Run window.__toggleViewPanPanel(true)
  // in the console to bring it back.
  function paintVisibility(mode) {
    const isHeroSitComp = (mode === 'hero' || mode === 'sit' || mode === 'computer');
    const isShelf       = (mode === 'shelf' || mode === 'rightShelf');
    const wantShow =
      (isHeroSitComp && !!window.__showViewPanPanel) ||
      (isShelf       && !!window.__showShelfViewPanel);
    panel.style.display = wantShow ? 'block' : 'none';
    if (wantShow && isHeroSitComp) syncFromMode(mode);
    if (wantShow && isShelf) {
      title.textContent = MODE_LABEL[mode];
      activeMode = null;
    }
  }
  paintVisibility(_currentMode);
  _modeChangeHandlers.push(paintVisibility);
  window.__toggleShelfViewPanel = (on) => {
    window.__showShelfViewPanel = (on === undefined) ? !window.__showShelfViewPanel : !!on;
    paintVisibility(_currentMode);
    return window.__showShelfViewPanel;
  };
  window.__toggleViewPanPanel = (on) => {
    window.__showViewPanPanel = (on === undefined) ? !window.__showViewPanPanel : !!on;
    paintVisibility(_currentMode);
    return window.__showViewPanPanel;
  };
})();

// ---------- Backdrop (Rio / Luca) panel -------------------------------
// Switches the through-window scenery between Rio (static image) and Luca
// (looping video) and lets the user position + scale the backdrop plane.
// (Backdrop panel removed — backdrop is locked at Luca with persisted position. Use the Sliders menu → Backdrop to adjust.)

// ---------- Fly mode (PointerLock + WASD + game-feel velocity) ----------
// Velocity-smoothed first-person camera. Movement targets are set by which
// keys are held; the camera's actual velocity lerps toward that target so
// starting/stopping doesn't feel jerky. Mouse look is handled by
// PointerLockControls. Minecraft-creative-style controls:
//
//   W / A / S / D    → forward / left / back / right
//   Space            → up
//   Shift            → down
//   ⌃ Ctrl           → sprint (×2.5)
//   Esc              → free cursor (stays in fly mode)
//   Double-tap Space → toggle fly mode on/off
const flyControls = new PointerLockControls(camera, renderer.domElement);
const flyKeys = { w: false, a: false, s: false, d: false, up: false, down: false, sprint: false };

function enterFly() {
  flyState.prevPos.copy(camera.position);
  flyState.prevTarget.copy(controls.target);
  flyState.active = true;
  controls.enabled = false;
  try { flyControls.lock(); } catch {}
  flyState.onChange(true);
}
function exitFly() {
  flyState.active = false;
  flyControls.unlock();
  controls.enabled = true;
  // Zero velocity so re-entering fly mode starts at rest.
  _flyVel.set(0, 0, 0);
  if (typeof _flyResumePill !== 'undefined') {
    _flyResumePill.style.display = 'none';
  }
  // Restore previous camera framing
  camera.position.copy(flyState.prevPos);
  controls.target.copy(flyState.prevTarget);
  controls.update();
  flyState.onChange(false);
}
function _tryFlyLock() {
  if (flyState.active && !flyControls.isLocked) {
    try { flyControls.lock(); } catch (err) { console.warn('[fly] lock failed', err); }
  }
}
flyControls.addEventListener('lock',   () => {
  flyState.onLockChange?.(true);
  if (_flyResumePill) _flyResumePill.style.display = 'none';
});
flyControls.addEventListener('unlock', () => {
  flyState.onLockChange?.(false);
  // Esc freed the cursor while still in fly mode → show a small corner
  // pill so the user knows how to resume mouse-look, but DON'T blanket
  // the screen with a blurred overlay (the user wants to click items
  // and use the gizmo while the cursor is free). No auto-lock on canvas
  // clicks either — that would steal selection clicks.
  if (flyState.active && _flyResumePill) _flyResumePill.style.display = 'flex';
});

// Small unobtrusive corner pill: "Resume mouse-look" — visible only when
// fly mode is active AND pointer is unlocked. Click it (or press F)
// to re-engage. Doesn't dim or block any other UI.
const _flyResumePill = document.createElement('button');
_flyResumePill.type = 'button';
_flyResumePill.textContent = '🎯 Resume mouse-look (F)';
_flyResumePill.style.cssText = `
  position: fixed; bottom: 76px; left: 50%; transform: translateX(-50%);
  z-index: 70; display: none; align-items: center; justify-content: center;
  padding: 9px 16px; border-radius: 999px;
  background: rgba(0,0,0,0.78);
  border: 1px solid rgba(125,255,160,0.55);
  color: #fff; font: 12px system-ui; font-weight: 600;
  cursor: pointer; backdrop-filter: blur(12px);
  box-shadow: 0 6px 20px rgba(0,0,0,0.55);
`;
_flyResumePill.addEventListener('click', _tryFlyLock);
document.body.appendChild(_flyResumePill);
// Press F to resume mouse-look from anywhere (matches the pill hint).
window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'f' && flyState.active && !flyControls.isLocked) {
    const t = e.target;
    // Skip when typing into a text input.
    if (t && (t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (t && t.tagName === 'INPUT') {
      const type = (t.type || '').toLowerCase();
      if (type === 'text' || type === 'search') return;
    }
    e.preventDefault();
    _tryFlyLock();
  }
});

// Double-tap detection for Space → toggle fly mode globally (works whether
// fly mode is on or off). Threshold is 320 ms between two presses.
let _lastSpaceTime = 0;
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  // Double-tap space toggles fly mode entirely. Always active.
  if (k === ' ' && !e.repeat) {
    const now = performance.now();
    if (now - _lastSpaceTime < 320) {
      _lastSpaceTime = 0;
      if (flyState.active) exitFly(); else enterFly();
      e.preventDefault();
      return;
    }
    _lastSpaceTime = now;
  }
  if (!flyState.active) return;
  if (k === 'w') flyKeys.w = true;
  if (k === 'a') flyKeys.a = true;
  if (k === 's') flyKeys.s = true;
  if (k === 'd') flyKeys.d = true;
  if (k === ' ')        { flyKeys.up = true;     e.preventDefault(); }
  if (k === 'shift')    { flyKeys.down = true;   e.preventDefault(); }
  if (k === 'control' || k === 'meta') { flyKeys.sprint = true; }
});
window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'w') flyKeys.w = false;
  if (k === 'a') flyKeys.a = false;
  if (k === 's') flyKeys.s = false;
  if (k === 'd') flyKeys.d = false;
  if (k === ' ') flyKeys.up = false;
  if (k === 'shift') flyKeys.down = false;
  if (k === 'control' || k === 'meta') flyKeys.sprint = false;
});

const _flyDir   = new THREE.Vector3();
const _flyRight = new THREE.Vector3();
const _flyUp    = new THREE.Vector3(0, 1, 0);
const _flyVel   = new THREE.Vector3();   // smoothed actual velocity
const _flyTarget = new THREE.Vector3();  // desired velocity from keys
const FLY_ACCEL  = 14;   // larger = more responsive (snappier)
const FLY_BASE   = 4.0;  // m/s base move speed (was effectively ~2.4)
const FLY_SPRINT = 2.5;  // sprint multiplier when ctrl held
let _flyLastTime = performance.now();
function updateFly() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - _flyLastTime) / 1000);   // cap dt at 50ms
  _flyLastTime = now;

  if (!flyState.active || !flyControls.isLocked) {
    // Bleed velocity to zero so we don't drift after releasing pointer lock.
    if (_flyVel.lengthSq() > 1e-6) {
      _flyVel.multiplyScalar(Math.max(0, 1 - FLY_ACCEL * dt));
      camera.position.addScaledVector(_flyVel, dt);
    }
    return;
  }

  // Build target velocity from the held keys, in world space.
  camera.getWorldDirection(_flyDir);
  _flyRight.crossVectors(_flyDir, _flyUp).normalize();
  const speed = FLY_BASE * (flyKeys.sprint ? FLY_SPRINT : 1);
  _flyTarget.set(0, 0, 0);
  if (flyKeys.w) _flyTarget.addScaledVector(_flyDir,    speed);
  if (flyKeys.s) _flyTarget.addScaledVector(_flyDir,   -speed);
  if (flyKeys.d) _flyTarget.addScaledVector(_flyRight,  speed);
  if (flyKeys.a) _flyTarget.addScaledVector(_flyRight, -speed);
  if (flyKeys.up)   _flyTarget.y += speed;
  if (flyKeys.down) _flyTarget.y -= speed;

  // Lerp current velocity toward target velocity for that "weighted" feel.
  const a = Math.min(1, FLY_ACCEL * dt);
  _flyVel.x += (_flyTarget.x - _flyVel.x) * a;
  _flyVel.y += (_flyTarget.y - _flyVel.y) * a;
  _flyVel.z += (_flyTarget.z - _flyVel.z) * a;

  camera.position.addScaledVector(_flyVel, dt);
}

// falconCrop and falconCropPlanes are hoisted at the top of the file.
// This block just defines the helpers that mutate them.
function refreshFalconCropPlanes() {
  falconCropPlanes[0].constant = -falconCrop.xMin;
  falconCropPlanes[1].constant =  falconCrop.xMax;
  falconCropPlanes[2].constant = -falconCrop.yMin;
  falconCropPlanes[3].constant =  falconCrop.yMax;
  falconCropPlanes[4].constant = -falconCrop.zMin;
  falconCropPlanes[5].constant =  falconCrop.zMax;
}
function updateFalconClip() { /* planes static unless slider used */ }

const _falconClipInterval = setInterval(() => {
  if (!falconBackdrop.children.length) return;
  clearInterval(_falconClipInterval);
  falconBackdrop.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((m) => {
      m.clippingPlanes = falconCropPlanes;
      m.clipShadows = true;
      m.needsUpdate = true;
    });
  });
  console.log('[falcon] crop applied');
}, 80);

// Falcon crop panel removed — Falcon renders fully without clipping now.

// ---------- Hide ALL room walls + floor + ceiling + window --------------
// Nuke every Wall_*, Floor, Ceiling, WindowFrame_, and Window_Glass mesh
// so the desk + bookshelf + props float in the Venator corridor with
// nothing boxing them in. Bookshelf alcove panels (Shelf_*) survive.
const _hideWallsInterval = setInterval(() => {
  if (!roomRoot) return;
  clearInterval(_hideWallsInterval);
  let hidden = 0;
  roomRoot.traverse((o) => {
    if (!o.isMesh) return;
    const n = o.name;
    if (
      n.startsWith('Wall_') ||
      n.startsWith('WindowFrame_') ||
      n.startsWith('Window_') ||
      /^Floor$|^Ceiling$/.test(n) ||
      /floor|ceiling/i.test(n)
    ) {
      o.visible = false;
      hidden++;
    }
  });
  console.log(`[walls] hid ${hidden} wall / window / floor / ceiling meshes`);
}, 80);

// ---------- Convert Falcon materials to UNLIT -----------------------------
// Falcon's GLB textures are pre-baked; using them with our PBR scene lighting
// makes the corridor look flat/dark. Swap to MeshBasicMaterial so the Falcon
// renders straight from its diffuse map, ignoring our lamp / window / HDRI.
const _falconUnlitInterval = setInterval(() => {
  if (!falconBackdrop.children.length) return;
  clearInterval(_falconUnlitInterval);
  falconBackdrop.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const oldMats = Array.isArray(o.material) ? o.material : [o.material];
    o.material = oldMats.map((m) => {
      const newMat = new THREE.MeshBasicMaterial({
        map: m.map,
        color: m.color ? m.color.clone() : new THREE.Color(0xffffff),
        transparent: false,
        opacity: 1.0,
        side: THREE.FrontSide,
        toneMapped: false,
        clippingPlanes: falconCropPlanes,
        clipShadows: true,
      });
      return newMat;
    });
    if (o.material.length === 1) o.material = o.material[0];
    o.castShadow = false;
    o.receiveShadow = false;
  });
  console.log('[falcon] materials → unlit (MeshBasicMaterial)');
}, 100);

// Hanging plant — top-LEFT corner of the room (user's view = +X side).
// The model has a "Ground_0" mesh (a flat disc that throws off auto-fit),
// so we hide it after load and re-center the visible parts on the group origin.
const hangingPlantGroup = loadProp({
  id: 'hangingPlant', label: 'Hanging plant',
  glbPath: '/models/hanging_plant.glb',
  target: { x: 1.20, y: 2.30, z: 0.30 },
  scaleTarget: 0.55,
});
const _hpInterval = setInterval(() => {
  if (!hangingPlantGroup.children.length) return;
  clearInterval(_hpInterval);
  // Hide ground/floor disc by name, re-fit the rest
  hangingPlantGroup.traverse((o) => {
    if (!o.isMesh) return;
    if (/ground|floor/i.test(o.name)) {
      o.visible = false;
      console.log('[hangingPlant] hid', o.name);
    }
  });
  // Re-fit + re-center using only visible meshes
  const inner = hangingPlantGroup.children[0];   // gltf.scene
  if (inner) {
    const visBox = new THREE.Box3();
    inner.traverse((o) => { if (o.isMesh && o.visible) visBox.expandByObject(o); });
    const visSize = visBox.getSize(new THREE.Vector3());
    const c = visBox.getCenter(new THREE.Vector3());
    // Shift inner so visible bbox is centered XZ and visBox.max.y sits at the
    // group's origin (so the plant HANGS DOWN from the group's position).
    inner.position.x += -c.x;
    inner.position.y += -visBox.max.y;
    inner.position.z += -c.z;
    console.log('[hangingPlant] refit, visible size', visSize.toArray().map((v) => v.toFixed(2)));
  }
}, 80);

// Boot is also selectable (handy for nudging without console)
makeSelectable(bootGroup, 'Wall-E boot');

// Backdrop tuning panel removed — values locked.

// Boot panel disabled — locked. Console helpers: window.__setBootPreset / __setBootField.
if (false) (function mountBootPanel() {
  const wrap = document.createElement('div');
  wrap.style.cssText = `
    position: absolute; top: 16px; right: 16px;
    background: rgba(0,0,0,0.6);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 12px;
    padding: 12px 14px; backdrop-filter: blur(12px);
    color: #fff; font: 12px system-ui, sans-serif; z-index: 10;
    display: flex; flex-direction: column; gap: 10px;
    min-width: 230px; max-height: 88vh; overflow-y: auto;
  `;
  const title = document.createElement('div');
  title.textContent = 'Wall-E boot plant';
  title.style.cssText = 'font-weight:600; opacity:0.9; font-size:11px; text-transform:uppercase; letter-spacing:0.5px;';
  wrap.appendChild(title);

  // Preset buttons
  const presetSec = document.createElement('div');
  presetSec.style.cssText = 'display:grid; grid-template-columns: 1fr 1fr; gap: 6px;';
  Object.entries(BOOT_PRESETS).forEach(([key, p]) => {
    const b = document.createElement('button');
    b.textContent = p.label;
    b.style.cssText = `
      background: transparent; color: #fff;
      border: 1px solid rgba(255,255,255,0.18);
      padding: 6px 8px; border-radius: 7px;
      cursor: pointer; font: 11px system-ui, sans-serif;
    `;
    b.addEventListener('click', () => setBootPreset(key));
    presetSec.appendChild(b);
  });
  wrap.appendChild(presetSec);

  // Sliders
  const valEls = {};
  const slEls  = {};
  function addSlider(key, label, min, max, step) {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex; flex-direction:column; gap:2px; font-size:11px;';
    const top = document.createElement('div');
    top.style.cssText = 'display:flex; justify-content:space-between; opacity:0.85;';
    const lab = document.createElement('span'); lab.textContent = label;
    const val = document.createElement('span'); val.textContent = bootState[key].toFixed(3);
    valEls[key] = val; top.appendChild(lab); top.appendChild(val);
    row.appendChild(top);
    const sl = document.createElement('input');
    sl.type = 'range'; sl.min = min; sl.max = max; sl.step = step;
    sl.value = bootState[key];
    sl.style.cssText = 'width:100%; height:22px;';
    slEls[key] = sl;
    sl.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      val.textContent = v.toFixed(3);
      setBootField(key, v);
    });
    row.appendChild(sl);
    wrap.appendChild(row);
  }
  addSlider('x',     'X (left/right)',  0,    2.5, 0.005);
  addSlider('y',     'Y (height)',      0.5,  3.0, 0.005);
  addSlider('z',     'Z (front/back)',  -2.5, 2.5, 0.005);
  addSlider('scale', 'Size',            0.2,  3.0, 0.01);
  addSlider('rotY',  'Rotation',       -3.14, 3.14, 0.01);

  // Sync slider values when a preset is clicked
  window.__bootPanelSync = (state) => {
    ['x','y','z','scale','rotY'].forEach((k) => {
      if (slEls[k]) {
        slEls[k].value = state[k];
        valEls[k].textContent = state[k].toFixed(3);
      }
    });
  };

  document.body.appendChild(wrap);
})();

// Leaf placement tool
createLeafTool({ scene, camera, controls, renderer });

// ════════════════════════════════════════════════════════════════════════
//   📸  360° BACKDROP CAPTURE  (build-mode only)
//
// Bakes the current localhost scene into a 6-face cubemap. The cube is
// then served as `scene.background` in website mode, replacing the heavy
// real-time room geometry. Visitors get the *exact* localhost look at
// any device's WebGL cost = "one textured sphere" (essentially free).
//
// Usage from DevTools:
//     window.__captureBackdrop()                 // default origin
//     window.__captureBackdrop({ x:0, y:1.6, z:1.6, size:2048 })
//
// Drops 6 PNGs (cube_px / nx / py / ny / pz / nz .png) into Downloads.
// Move them to public/baked/ and push — done.
// ════════════════════════════════════════════════════════════════════════
if (IS_BUILD_MODE) {
  window.__captureBackdrop = async (opts = {}) => {
    const FACE_SIZE = opts.size   ?? 1024;     // per-face size; 1024 → atlas is 3072×2048
    const CX        = opts.x      ?? 0;
    const CY        = opts.y      ?? 1.6;
    const CZ        = opts.z      ?? 1.6;
    const hideItems = opts.hideItems ?? true;
    const FILENAME  = opts.filename ?? `cube-atlas-${FACE_SIZE}.png`;

    // Hide bank-spawned items so they're NOT baked into the backdrop —
    // they keep rendering live in 3D on website mode.
    const restored = [];
    if (hideItems) {
      scene.traverse((o) => {
        if (o.isGroup && o.name && o.name.startsWith('__prop_bank-') && o.visible) {
          restored.push(o); o.visible = false;
        }
      });
      console.log(`[backdrop] hid ${restored.length} bank-spawned items for capture`);
    }

    // Stash + override renderer state for max-quality square capture.
    const prevSize   = { w: renderer.domElement.width, h: renderer.domElement.height };
    const prevPR     = renderer.getPixelRatio();
    const prevAspect = camera.aspect;
    renderer.setPixelRatio(1);
    renderer.setSize(FACE_SIZE, FACE_SIZE, false);

    const tempCam = new THREE.PerspectiveCamera(90, 1, 0.01, 200);

    // Cubemap face order — MUST match Three.js CubeTextureLoader's
    // expected sequence [+X, -X, +Y, -Y, +Z, -Z]. Atlas layout is 3×2:
    //   ┌─────┬─────┬─────┐
    //   │ px  │ nx  │ py  │
    //   ├─────┼─────┼─────┤
    //   │ ny  │ pz  │ nz  │
    //   └─────┴─────┴─────┘
    const FACES = [
      { name: 'px', look: new THREE.Vector3( 1,  0,  0), up: new THREE.Vector3(0, 1,  0), col: 0, row: 0 },
      { name: 'nx', look: new THREE.Vector3(-1,  0,  0), up: new THREE.Vector3(0, 1,  0), col: 1, row: 0 },
      { name: 'py', look: new THREE.Vector3( 0,  1,  0), up: new THREE.Vector3(0, 0, -1), col: 2, row: 0 },
      { name: 'ny', look: new THREE.Vector3( 0, -1,  0), up: new THREE.Vector3(0, 0,  1), col: 0, row: 1 },
      { name: 'pz', look: new THREE.Vector3( 0,  0,  1), up: new THREE.Vector3(0, 1,  0), col: 1, row: 1 },
      { name: 'nz', look: new THREE.Vector3( 0,  0, -1), up: new THREE.Vector3(0, 1,  0), col: 2, row: 1 },
    ];

    // Single atlas canvas — paint all 6 faces into 3×2 grid, then download once.
    const atlas = document.createElement('canvas');
    atlas.width  = FACE_SIZE * 3;
    atlas.height = FACE_SIZE * 2;
    const actx = atlas.getContext('2d');

    for (const f of FACES) {
      tempCam.position.set(CX, CY, CZ);
      tempCam.up.copy(f.up);
      tempCam.lookAt(CX + f.look.x, CY + f.look.y, CZ + f.look.z);
      tempCam.updateMatrixWorld(true);
      renderer.render(scene, tempCam);
      actx.drawImage(renderer.domElement, f.col * FACE_SIZE, f.row * FACE_SIZE, FACE_SIZE, FACE_SIZE);
      console.log(`[backdrop] face ${f.name} painted at (${f.col},${f.row})`);
      // Brief microtask yield so the page stays responsive between faces.
      await new Promise((res) => setTimeout(res, 50));
    }

    // ONE download.
    const blob = await new Promise((res) => atlas.toBlob(res, 'image/png'));
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = FILENAME;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);

    // Restore renderer state.
    renderer.setPixelRatio(prevPR);
    renderer.setSize(prevSize.w / prevPR, prevSize.h / prevPR, false);
    camera.aspect = prevAspect;
    camera.updateProjectionMatrix();
    restored.forEach((g) => (g.visible = true));
    console.log(`[backdrop] DONE — ${FILENAME} in Downloads. Per-face size: ${FACE_SIZE}².`);
  };

  // Bake ALL the camera modes in one go: sit, computer, shelf (left),
  // rightShelf. Each one switches the camera to that mode, lets the
  // camera-tween settle, then captures from the camera's actual position.
  // Drops 4 PNGs into Downloads, named per mode. Website-mode wiring
  // swaps scene.background on every setMode() call.
  window.__bakeAllModes = async (opts = {}) => {
    const SIZE  = opts.size ?? 1024;
    const MODES = ['sit', 'computer', 'shelf', 'rightShelf'];
    const savedPos    = camera.position.clone();
    const savedTarget = (controls && controls.target) ? controls.target.clone() : new THREE.Vector3();
    for (const m of MODES) {
      console.log(`[bake-all] === mode: ${m} ===`);
      setMode(m);
      // Wait long enough for the camera tween to finish (moveCamera is ~1.0s)
      await new Promise((r) => setTimeout(r, 1600));
      await window.__captureBackdrop({
        size: SIZE,
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z,
        filename: `cube-atlas-${m}-${SIZE}.png`,
      });
      // Brief pause between captures so Chrome flushes each download
      await new Promise((r) => setTimeout(r, 600));
    }
    // Restore original camera
    camera.position.copy(savedPos);
    if (controls && controls.target) controls.target.copy(savedTarget);
    setMode('hero');
    console.log(`[bake-all] DONE — 4 PNGs in Downloads (sit, computer, shelf, rightShelf)`);
  };

  console.log('[backdrop] ready — single: __captureBackdrop()  |  all 4 modes: __bakeAllModes()');
}

// ---------- Wooden hook (procedural, fully controllable) ---------------
// A simple cylindrical wooden peg meant to hang the Thor hammer (or any
// small item) from. Registered via makeSelectable() so it behaves like
// every other item — translate / rotate / scale gizmo in build mode,
// persisted transform survives reload + ships to live via 📤 Push.
//
// Persistence keys: item.Thor_hook.x/y/z/rotX/rotY/rotZ/scale
//   (same label→key convention as every other selectable prop:
//    spaces → underscores, case preserved.)
(function buildThorHook() {
  const LABEL = 'Thor hook';
  const KB = 'item.Thor_hook';
  const stored = (() => {
    try { return JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}'); }
    catch { return {}; }
  })();

  const hookGroup = new THREE.Group();
  hookGroup.name = LABEL;

  // 20 cm long, 1.5 cm radius — slim wooden peg that reads as a wall hook.
  // Cylinder geometry's default axis is Y; rotate so the peg lies along X
  // (horizontal). User can re-rotate via the gizmo to whatever wall they
  // want it sticking out of.
  const geo = new THREE.CylinderGeometry(0.015, 0.015, 0.20, 28, 1, false);
  geo.rotateZ(Math.PI / 2);
  // Slightly rounded ends — bevel a few rings so it reads "carved wood"
  // rather than perfect machined dowel. Cheap: just two extra ring caps.
  // (CylinderGeometry already closes both ends; the rounded look comes
  // from material + lighting, not extra geometry.)
  const mat = new THREE.MeshStandardMaterial({
    color: 0x6b4423,         // walnut-brown
    roughness: 0.82,
    metalness: 0.0,
    envMapIntensity: 0.6,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  hookGroup.add(mesh);

  // Default placement — out on the right wall, mid-height. The user
  // is going to move it anyway, so just somewhere visible.
  hookGroup.position.set(2.0, 1.6, 0.0);

  // Restore persisted transform if we have one.
  const num = (k, fallback) => typeof stored[k] === 'number' ? stored[k] : fallback;
  hookGroup.position.x = num(`${KB}.x`,    hookGroup.position.x);
  hookGroup.position.y = num(`${KB}.y`,    hookGroup.position.y);
  hookGroup.position.z = num(`${KB}.z`,    hookGroup.position.z);
  hookGroup.rotation.x = num(`${KB}.rotX`, hookGroup.rotation.x);
  hookGroup.rotation.y = num(`${KB}.rotY`, hookGroup.rotation.y);
  hookGroup.rotation.z = num(`${KB}.rotZ`, hookGroup.rotation.z);
  const s = num(`${KB}.scale`, 1);
  hookGroup.scale.setScalar(s);

  scene.add(hookGroup);
  makeSelectable(hookGroup, LABEL);
  console.log('[hook] Thor hook ready — select it in build mode to move/rotate/scale.');
})();

// ---------- Incredibles car crop (build mode only) -----------------------
// Six-plane axis-aligned clip box for the bank-spawned "the incredibile"
// car, mirroring the WALL-E boot crop pattern. World-space planes that
// track the car's live position + scale every frame, so the trim stays
// put even if you move the car. Each slider is the crop OFFSET from the
// car's origin along that axis (in car-local meters before scale).
// Persisted under item.the_incredibles_the_incredibile_24.crop.<axis> so
// it survives reload AND ships to live via the 📤 Push button.
if (IS_BUILD_MODE) (() => {
  const KEY_BASE = 'item.the_incredibles_the_incredibile_24.crop';
  const AXES = ['top', 'bottom', 'left', 'right', 'front', 'back'];
  // Defaults: 1.0 m on every side = effectively no clip for a normal-sized car.
  // Dial individual axes downward to carve into the mesh.
  const CROP = { top: 1.0, bottom: 1.0, left: 1.0, right: 1.0, front: 1.0, back: 1.0 };
  try {
    const stored = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    for (const axis of AXES) {
      const v = stored[`${KEY_BASE}.${axis}`];
      if (typeof v === 'number') CROP[axis] = v;
    }
  } catch {}

  // Plane normals point INWARD toward the kept region. constant gets
  // recomputed every frame from the car's live world transform.
  const planes = [
    new THREE.Plane(new THREE.Vector3(0,  1, 0), 0),   // bottom (keep y >  ...)
    new THREE.Plane(new THREE.Vector3(0, -1, 0), 0),   // top    (keep y <  ...)
    new THREE.Plane(new THREE.Vector3( 1, 0, 0), 0),   // left   (keep x >  ...)
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0),   // right  (keep x <  ...)
    new THREE.Plane(new THREE.Vector3(0, 0,  1), 0),   // back   (keep z >  ...)
    new THREE.Plane(new THREE.Vector3(0, 0, -1), 0),   // front  (keep z <  ...)
  ];
  // Map axis name → planes index for easy slider lookup.
  const planeIdx = { bottom: 0, top: 1, left: 2, right: 3, back: 4, front: 5 };

  let carGroup = null;
  function attach(g) {
    if (carGroup === g) return;
    carGroup = g;
    g.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const cloned = mats.map((m) => {
        const c = m.clone();
        c.clippingPlanes = planes;
        c.clipShadows    = true;
        c.needsUpdate    = true;
        return c;
      });
      o.material = cloned.length === 1 ? cloned[0] : cloned;
    });
    console.log('[incredibile-crop] attached to', g.userData?.label || g.name || 'group');
  }

  // Per-frame world-space recompute. Same pattern as the boot's updateBootMask.
  const _tmp = new THREE.Vector3();
  const _scl = new THREE.Vector3();
  function tick() {
    if (carGroup && carGroup.parent) {
      carGroup.updateMatrixWorld(true);
      carGroup.getWorldPosition(_tmp);
      carGroup.getWorldScale(_scl);
      const x = _tmp.x, y = _tmp.y, z = _tmp.z;
      const sx = _scl.x, sy = _scl.y, sz = _scl.z;
      // Bottom plane normal (0,1,0): keep p.y >= y - CROP.bottom*sy → constant = -(y - CROP.bottom*sy)
      planes[planeIdx.bottom].constant = -(y - CROP.bottom * sy);
      planes[planeIdx.top   ].constant =  (y + CROP.top    * sy);
      planes[planeIdx.left  ].constant = -(x - CROP.left   * sx);
      planes[planeIdx.right ].constant =  (x + CROP.right  * sx);
      planes[planeIdx.back  ].constant = -(z - CROP.back   * sz);
      planes[planeIdx.front ].constant =  (z + CROP.front  * sz);
    }
    requestAnimationFrame(tick);
  }
  tick();

  // Watch SELECTABLE for the incredibile group — spawn is async so we poll.
  const watch = setInterval(() => {
    const found = (typeof SELECTABLE !== 'undefined' ? SELECTABLE : []).find((s) => s?.label && /incredibile/i.test(s.label));
    if (found && found.group && found.group.children.length > 0) {
      attach(found.group);
      clearInterval(watch);
    }
  }, 300);

  // ---------- Crop slider panel (DISABLED — values locked) ---------------
  // User dialed in their crop (top≈1.392, bottom≈0.178, sides+front+back
  // at 1.000) and asked to hide the sliders. Persisted values continue
  // to drive the per-frame tick() above. Flip `if (false)` back to
  // `if (true)` to re-show the panel for re-tuning.
  if (false) (function mountIncrediblePanel() {
    const wrap = document.createElement('div');
    wrap.style.cssText = `
      position: absolute; bottom: 80px; left: 16px;
      background: rgba(0,0,0,0.65);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 12px;
      padding: 12px 14px; backdrop-filter: blur(12px);
      color: #fff; font: 12px system-ui, sans-serif; z-index: 12;
      display: flex; flex-direction: column; gap: 6px;
      min-width: 280px;
    `;
    const t = document.createElement('div');
    t.textContent = '🚗 Incredibile crop';
    t.style.cssText = 'font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;opacity:0.9;';
    wrap.appendChild(t);

    function persist(axis) {
      try {
        const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
        cur[`${KEY_BASE}.${axis}`] = CROP[axis];
        localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
      } catch {}
    }
    function addSlider(axis, label) {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;flex-direction:column;gap:1px;font-size:11px;';
      const top = document.createElement('div');
      top.style.cssText = 'display:flex;justify-content:space-between;opacity:0.85;';
      const lab = document.createElement('span'); lab.textContent = label;
      const val = document.createElement('span'); val.textContent = CROP[axis].toFixed(3);
      top.appendChild(lab); top.appendChild(val);
      row.appendChild(top);

      const sliderRow = document.createElement('div');
      sliderRow.style.cssText = 'display:flex;align-items:center;gap:4px;';
      const sl = document.createElement('input');
      sl.type = 'range';
      sl.min = '0'; sl.max = '1.5'; sl.step = '0.001';
      sl.value = CROP[axis];
      sl.style.cssText = 'flex:1;height:18px;';
      function setVal(v) {
        CROP[axis] = Math.max(0, Math.min(1.5, v));
        sl.value = CROP[axis];
        val.textContent = CROP[axis].toFixed(3);
        persist(axis);
      }
      sl.addEventListener('input', (e) => setVal(parseFloat(e.target.value)));
      function mkBtn(txt, delta) {
        const b = document.createElement('button');
        b.textContent = txt;
        b.style.cssText = 'width:22px;height:22px;border-radius:4px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:#fff;cursor:pointer;font-size:10px;line-height:1;padding:0;';
        b.addEventListener('click', () => setVal(CROP[axis] + delta));
        return b;
      }
      sliderRow.appendChild(mkBtn('⏪', -0.010));
      sliderRow.appendChild(mkBtn('◀',  -0.001));
      sliderRow.appendChild(sl);
      sliderRow.appendChild(mkBtn('▶',   0.001));
      sliderRow.appendChild(mkBtn('⏩',  0.010));
      row.appendChild(sliderRow);
      wrap.appendChild(row);
    }
    addSlider('top',    'Top    (↑)');
    addSlider('bottom', 'Bottom (↓)');
    addSlider('left',   'Left   (←)');
    addSlider('right',  'Right  (→)');
    addSlider('front',  'Front  (▲)');
    addSlider('back',   'Back   (▼)');

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;margin-top:6px;';
    const reset = document.createElement('button');
    reset.textContent = 'Reset (all 1.0)';
    reset.style.cssText = 'flex:1;padding:5px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:#fff;cursor:pointer;font-size:11px;';
    reset.addEventListener('click', () => {
      for (const a of AXES) CROP[a] = 1.0;
      wrap.querySelectorAll('input[type=range]').forEach((sl, i) => {
        sl.value = 1.0;
        const row = sl.closest('label');
        const readout = row?.querySelector('div > span:last-child');
        if (readout) readout.textContent = '1.000';
        persist(AXES[i]);
      });
    });
    btnRow.appendChild(reset);
    wrap.appendChild(btnRow);

    document.body.appendChild(wrap);
  })();
})();

// ---------- Shelf-light position panel (build mode only) -----------------
// DIRECT light control — bypasses the legacy stripOffset setter chain
// entirely. Captures each light's local position once (the position it
// settled into after all the boot-time setup), then applies the panel's
// X/Y/Z offsets ADDITIVELY every frame. This way no matter what other
// code does to those lights, the panel's offsets stick.
//
// Persistence keys: shelfLightPanel.<left|right>.<x|y|z>
//   (intentionally NOT the legacy leftStripOffset.* keys — those still
//    drive the initial light placement; we layer on top of that.)
// Run in BOTH builder + website modes. Previously gated to IS_BUILD_MODE
// only, which meant the recruiter tab loaded the lights at their raw base
// position (no offsets) — making them look misplaced compared to the
// builder where the locked shelfLightPanel offsets layered on top. The
// applier has no UI anymore, just position-locking, so it's safe to run
// for visitors too.
(() => {
  const MIN = -2.0, MAX = 2.0, STEP_FINE = 0.005, STEP_COARSE = 0.050;
  const STEP_TINY = 0.001;   // ◀ / ▶ buttons = 1 mm
  const clamp = (v) => Math.max(MIN, Math.min(MAX, v));

  // Live panel state — additive offsets per side, in the lights' own
  // local coordinate space (which is bookshelf-local since the lights
  // are children of the bookshelf group).
  const state = {
    left:  { x: 0, y: 0, z: 0 },
    right: { x: 0, y: 0, z: 0 },
  };

  // One-time RESET to the natural shelf position. The previous lock-in
  // attempt forced shelfLightPanel.* offsets that were captured against
  // a different base (different bookshelf transform). With a different
  // base today, those same offsets push the lights out of the visible
  // alcove. Zeroing the panel offsets snaps each strip light back to its
  // natural per-shelf position (driven entirely by the legacy
  // leftStripOffset.* / rightStripOffset.* defaults of 0.110, 0, 0.060
  // which DO produce the same on-shelf placement morning and now).
  // Bump the flag suffix to re-run this reset later if needed.
  const _SHELF_LIGHT_RESET_FLAG = 'desk-portfolio:shelf-lights:reset-natural-v2026-05-13c';
  try {
    if (!localStorage.getItem(_SHELF_LIGHT_RESET_FLAG)) {
      const ls0 = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
      for (const side of ['left', 'right']) {
        for (const axis of ['x', 'y', 'z']) {
          ls0[`shelfLightPanel.${side}.${axis}`] = 0;
        }
      }
      localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(ls0));
      localStorage.setItem(_SHELF_LIGHT_RESET_FLAG, '1');
      console.log('[shelf-lights] ✅ panel offsets reset to 0 — lights snap to natural shelf positions');
    }
  } catch (err) { console.warn('[shelf-lights] reset skipped:', err); }

  // Load persisted offsets (now guaranteed to be the locked values on
  // first boot after this flag).
  try {
    const ls = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
    for (const side of ['left', 'right']) {
      for (const axis of ['x', 'y', 'z']) {
        const k = `shelfLightPanel.${side}.${axis}`;
        if (typeof ls[k] === 'number') state[side][axis] = ls[k];
      }
    }
  } catch {}

  const persist = (side, axis, val) => {
    try {
      const cur = JSON.parse(localStorage.getItem('desk-portfolio:positions:v1') || '{}');
      cur[`shelfLightPanel.${side}.${axis}`] = val;
      localStorage.setItem('desk-portfolio:positions:v1', JSON.stringify(cur));
    } catch {}
  };

  // Live light accessors — call each frame so we pick up the right-shelf
  // mirror lights the moment they're built.
  const lightsFor = (side) => {
    if (side === 'left')  return (typeof window.__getLeftShelfLightsArr  === 'function') ? window.__getLeftShelfLightsArr()  : [];
    if (side === 'right') return (typeof window.__getRightShelfLightsArr === 'function') ? window.__getRightShelfLightsArr() : [];
    return [];
  };

  // Lazily capture each light's base local position the first time we
  // see it. From then on, the panel's offset is layered on top.
  const ensureBase = (l) => {
    if (!l.userData.__shelfPanelBase) {
      l.userData.__shelfPanelBase = l.position.clone();
    }
    return l.userData.__shelfPanelBase;
  };

  // Push state to lights. Called from three places so we don't depend on
  // any one mechanism:
  //   (a) directly from the slider/button apply() — immediate response
  //   (b) every animation frame via the scene render loop (when tab focused)
  //   (c) every 200ms via setInterval (covers background-tab cases where
  //       requestAnimationFrame is suspended)
  function applyAll() {
    for (const side of ['left', 'right']) {
      const off = state[side];
      for (const l of lightsFor(side)) {
        const b = ensureBase(l);
        l.position.set(b.x + off.x, b.y + off.y, b.z + off.z);
      }
    }
  }
  // Expose so we can call it from the slider apply() directly, plus
  // anywhere else if needed (sanity-check from DevTools, etc.).
  window.__shelfLightApplyAll = applyAll;
  // (a) Per-frame via RAF — runs when tab is active.
  function rafLoop() { applyAll(); requestAnimationFrame(rafLoop); }
  setTimeout(() => requestAnimationFrame(rafLoop), 1500);
  // (c) Setinterval safety net — fires even when tab is backgrounded
  // (Chrome throttles to ~1Hz in background but at least it fires).
  setTimeout(() => setInterval(applyAll, 200), 1700);

  // (UI panel removed at user's request — the locked-in shelf-light
  // offsets persist via shelfLightPanel.<left|right>.<x|y|z> in
  // localStorage. State is loaded above and applyAll keeps every light
  // pinned to base + offset every frame + every 200 ms, so the lights
  // stay exactly where you locked them. To re-tune, either edit those
  // localStorage keys directly or re-introduce the slider panel.)
})();

// ---------- resize --------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (composer) composer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- render loop ---------------------------------------------------
function lerp(a, b, t) { return a + (b - a) * t; }

// Hard-pause flag. When the portfolio overlay is active, we skip the room's
// per-frame render + scene updates entirely — every uniform/mixer write is
// avoided so GPU + CPU drop to ~0%. Costs:
//   • the room's WebGL canvas keeps showing its last frame (frozen image
//     underneath the opaque overlay, never visible to the user).
//   • physics-like things (chase cams, anim mixers) freeze too — they
//     resume from where they left off when we unpause.
window.__roomRenderPaused = false;
function tick() {
  // Bail completely while the portfolio overlay owns the screen. We still
  // schedule the next frame so the loop resumes the instant we unpause —
  // no need to manually restart.
  if (window.__roomRenderPaused) {
    requestAnimationFrame(tick);
    return;
  }
  // Only call OrbitControls.update() when fly mode is OFF. When fly is on,
  // PointerLockControls owns the camera rotation via mousemove deltas, and
  // OrbitControls.update() (even with enabled=false) re-orients the camera
  // toward its target every frame — which silently undid mouse-look.
  if (!flyState.active) controls.update();
  // The DOF auto-computes focusDistance every frame from focusTarget (a world
  // Vector3), so we just need to ease the bokehScale toward the target.
  dof.bokehScale = lerp(dof.bokehScale, dofBokehTarget, 0.05);
  updateSucculentMask();
  updateScreenHtmlPosition();
  updateMacScreen();
  updateFalconClip();
  updateVenatorCarve();
  updateBootMask();
  updateFly();
  updateFlyLocks();
  updatePairLocks();
  updateAtAtOrbit();
  updateFalconChase();
  updateAnimMixers();
  // Bypass post-processing on low-end tiers — direct render skips bloom +
  // DoF + vignette and is dramatically cheaper. The composer chain is
  // only worth it when we actually want the cinematic look.
  if (window.__bypassPostFX || !composer) {
    renderer.render(scene, camera);
  } else {
    composer.render();
  }
  requestAnimationFrame(tick);
}
tick();
