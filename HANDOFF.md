# Pixar Desk Portfolio — Handoff (May 2026)

A photoreal interactive 3D portfolio scene built in vanilla Three.js. The
user lands inside an office that sits inside a Star Wars Venator
star-cruiser corridor, with a vintage Macintosh Plus on the desk that
boots a portfolio menu when clicked. The shelf is dressed with collected
props (Spider-Man masks, sword, Groot pot + succulent, plants, books,
chest). The window opens onto a Rio sunset (or the Falcon corridor).

---

# ⚠️ READ THIS FIRST — May 19, 2026 session update

> ## 📺 INSIDE-COMPUTER PORTFOLIO: VHS LIBRARY + TV BUILD
>
> Click "Use Computer" → Mac boots → diving overlay zooms into a starfield
> with a CRT TV centered + a VHS library on the left. Each tape is a
> Taylor McWade commercial. Click a tape → real 1080p video plays on the
> TV screen via VideoTexture, paired with a Cormorant-Garamond serif info
> card on the right (client name + current video title + +INFO blurb +
> play/pause). Two floating 3D play/pause GLB buttons rise from below the
> TV when a video starts. The radio sits bottom-right as a future "click
> here for music" hook (not wired yet).

## The portfolio menu (current state)

**Spatial layout** (after clicking the Mac):
- Floating starfield background (3 parallax layers, all rendered with
  `renderOrder: -1` so they sit visually behind every menu mesh and the
  back hemisphere is mirrored so no star ever spawns in front of an item)
- **TV** centered: `tv.glb`, picked-pose rotated 90° on Y. The screen face
  is a custom-shaded plane with a slight bulge to cover the chassis recess
- **VHS library** on the left in a carousel (locked layout):
  - 12 tapes, all sharing one universal model (`coke_vhs.glb`), each with
    its own tag PNG on the front face (`public/textures/vhs_tags/*.png`)
  - Premier Protein default-centered when entering TV view
  - Scroll wheel / ↑↓ keys cycle. 5 visible at a time (3 solid + 2 faded ends)
  - Per-tape transform persistence under `vhs.<id>.inner{X,Y,Z,RotX,Y,Z,Scale}`
  - Per-tape group flip overrides under `vhs.<id>.flip{X,Y,Z}` (Shrek
    needed unique flips because it used to have its own GLB)
- **Radio** at slot (+2.2, -1.5), size 0.5
- **Info card** (right side, bottom) — fixed-position HTML:
  - CLIENT label (small caps)
  - Current video name in Cormorant Garamond 32px
  - `+ INFO` button toggles a blurb (max-height animation)
  - ▶ PLAY / ‖ PAUSE buttons
  - "SPOTS IN THIS REEL" multi-video list for Verizon (3) and Samsung (3)
- **Floating 3D play/pause buttons** below TV:
  - `play_button.glb` + `pause_button.glb` (52-55 MB each, share-cached)
  - Hidden when no video; rise on click with a slow Y lerp (0.035/frame)
  - Idle "shuffle" — gentle sin/cos breathing once they reach target Y
  - User-locked positions: Forward 0.6165 / Y −0.4655 / Horiz spread ±0.101
- **VHS editor** (top-left, minimizable):
  - Dropdown selects active tape
  - Live values readout (rotation/position/scale of body + tag)
  - 🎯 Focus on tape — camera zooms onto the picked tape + freezes its bob
  - 🎯 Auto stand-up cycles 4 likely orientations
  - 180° flip toggles per-axis (per-tape group-flip overrides)
  - Body + tag rotation/position/scale/material sliders + micro-button rows
  - ＋ black backing — adds a black plate behind the front tag with its own
    X/Y/Z/Width/Height/Opacity sliders (May 19, polygonOffset to kill
    z-fighting). Persists per-VHS under `backing.<id>.*`
- **TV controls positioning panel** (hidden — user dialed in and locked)
- **Carousel center label** (bottom center) — shows currently-centered tape

## Per-tape video map (`public/videos/*.mp4`)

| Tape | Video | Resolution |
|------|-------|------------|
| premier_protein | `Go Get 'Em premier_protein` | 1080p |
| coke_vhs | `Coca Cola x Marvel The Heroes` | 1080p |
| ad_council | `Questions Youth Firearm Injury Prevention` | 1080p |
| citizens_bank | `Penny for your Thoughts` | 1080p |
| era_coalition | `woman_corp ERA` | 1080p |
| ikea | `Meatball Candle` (Ogilvy/Vimeo) | 1080p |
| retro_coke_doc | `A New Coke - Documentary` | 1080p |
| dove | `The Game is Ours` | 1080p |
| schwinn | `Freedom Begins With a Bike` | 1080p |
| **verizon** | **3 back-to-back**: Hear the Holidays (cut 7s, compressed) → Honey Comb → Hey Kitty Kitty | 1080p |
| hr_block | `Definitely do your taxes` | 1080p |
| **samsung** | **3 back-to-back**: Flip6 FlexCam → Flip6 Interpreter → Fold6 Circle to Search | 720p/1080p |
| shrek_vhs | local placeholder (Shrek opening) | — |

Multi-video tapes use `videoSrcList: [...]` in the spec. The TV's video
element has a one-time `ended` listener that advances through the queue
(`window.__tvPlayQueue` / `__tvPlayIdx`). When the last clip ends, the
screen mesh hides + `mapReady` flips off → TV returns to its "off" state.

## Color pipeline (carefully tuned, history of pain)

The TV screen uses a custom `ShaderMaterial` (because we have bars/bulge/
boot fade effects). Custom shaders don't auto-handle Three.js's colorspace
includes, so video looked muddy/washed for many iterations.

**Current pipeline that works:**
1. `vTex.colorSpace = THREE.SRGBColorSpace` — Three.js knows source is sRGB
2. Shader does **IEC 61966-2-1 piecewise sRGB→linear** manually:
   ```glsl
   vec3 cLow  = c / 12.92;
   vec3 cHigh = pow((c + 0.055) / 1.055, vec3(2.4));
   c = mix(cLow, cHigh, step(0.04045, c));
   ```
3. `OutputPass` re-encodes linear → sRGB on canvas write
4. Material flags: `toneMapped: false`, `fog: false` (isolate from scene)
5. **NO saturation boost, NO black-floor crush** (both were shifting hues
   — reds went pink. Stripped back to pure IEC.)

**Things tried and didn't work:**
- `pow(c, 2.2)` approximation — slightly off vs piecewise IEC
- `#include <colorspace_fragment>` — ShaderMaterial doesn't auto-include
  the `linearToOutputTexel` definition
- Black-level lift removal (`max((c - 0.004) / 0.996, 0)`) — turned reds pink
- +8% saturation — turned reds pink
- Setting `vTex.colorSpace = NoColorSpace` — caused double-encoding

## What's wired but not perfect yet (open issues)

1. **Color match to QuickTime** — math is correct (round-trip IEC). Any
   remaining perceptual delta is browser video decoder vs Apple's
   (BT.709 ranging, ColorSync metadata) — out of our control.
2. **Black backing depth control** — May 19, polygonOffset added to break
   z-fight with the front tag. If still flickers, push Z further back via
   the "Backing Z (depth)" slider (default offset −0.02).
3. **Radio is decorative only** — no interaction wired beyond positioning.
4. **Bio / project pages still TODO** — VHS library shows the commercials,
   but the broader portfolio (bio, full case studies, contact) doesn't
   exist as a page yet. Globe nav from May 13 plan never built.

## Bug history of the May 19 session

- TDZ crash on `_sliderSubscribers` — fixed by `queueMicrotask` around
  carousel-tuning sliders AND the new backing sliders
- Joint sliders persisted to `tv.btn.both.*` but loaded from
  `tv.btn.{play,pause}.*` — fixed by writing both keys on every joint
  slider set
- Buttons appeared "stacked behind each other" — TV rotated 90° on Y means
  local X is depth, local Z is horizontal. Renamed labels (Forward/X-horiz)
  and fixed defaults to spread along Z, not X
- Stars appearing in front of TV — fixed by spawning all stars in the back
  hemisphere (z<0 mirroring) + `renderOrder: -1`
- Shrek VHS showed back-facing — added `mi.spec.flipX/Y/Z` per-spec
  overrides + 180° flip buttons in editor
- Tag PNGs not fading with body — explicit per-tag opacity write in the
  same tick block as the body fade

## Next session goals

1. Wire the bio / case-study pages (per May 13 plan, still standing)
2. Decide on globe nav vs. simpler menu — get more video content in first
3. Possibly: re-encode all videos through ffmpeg for consistent bitrate /
   color profile if more "doesn't match QuickTime" complaints surface
4. Replace placeholders (Shrek VHS plays the actual Shrek opening mp4,
   could be swapped for a real Taylor reel cut)

---

# 📜 OLDER UPDATES BELOW
---

# ⚠️ May 13, 2026 session update

> ## 🛑 PUSHING TO RAILWAY IS PAUSED
>
> User is **iterating locally only** for now. **Do NOT run `git push origin main`** unless the user explicitly asks.
>
> Workflow: edit code → user previews on the dual-localhost setup (see cheat-sheet below) → iterate. Commits to local git are fine; the `push` step is paused.
>
> When the user is ready to resume pushing they will say so explicitly.

The original handoff (below this section) documents the **3D scene** itself —
props, materials, lighting, gizmo system. That's still accurate for the
local build experience. **What changed since:** we're shipping this thing
to Pixar recruiters, so we hit production concerns. This section captures
everything from the May 13 session — streaming experiments, visitor-side
optimizations, and a strategic pivot.

## Owner / accounts

| Service | Account | Purpose |
|---|---|---|
| Railway | dodisworking@gmail.com | Hosting. Auto-deploys main. Env vars: `PUSH_SECRET`, `HYPERBEAM_API_KEY` |
| GitHub | dodisworking/desk-portfolio | Source. Push to main = Railway deploys |
| Hyperbeam | logged in via GitHub SSO | Cloud-browser streaming. Test key live. Free tier. |
| Vagon (Mr stark) | $13 deposit — **pending refund** | Pixel streaming for Windows apps. Path abandoned. Email support@vagon.io for refund. |

**Live URL:** https://desk-portfolio-production.up.railway.app/

## Goal (the portfolio's job)

Marc is applying to **Pixar as a producer**. The portfolio's job is to demonstrate:
1. **Aesthetic taste** — the 3D room does this (already built)
2. **Ability to scope, plan, and ship a complex creative-technical project** — the portfolio IS this demonstration
3. **Actual project case studies** — bio + 3-5 projects with images/videos/text (NOT YET BUILT)

## The architecture decided May 13

**Two connected experiences:**

1. 🏠 **3D room** (current build, KEEP as-is) — the "trailer" / first impression
2. 🖥 **Click "Use Computer" on the Mac → 2D portfolio overlay takes over the viewport**
   - Boot animation → screen grows fullscreen → dark space transition → globe with section markers → click marker → section page slides in (bio, projects, reel, contact)
   - All 2D HTML/CSS (maybe a tiny isolated Three.js globe widget). Renders on every device.
   - When inside, the room canvas is hidden (so we never run two heavy scenes at once)
3. **Return-to-room button** = back to the 3D room hero camera

**Critical insight:** Because the inside-computer is 2D, pixel streaming is NOT needed. The existing room optimizations (Lambert + cubemap + Turbo tier + no shadows + no postFX) already handle Safari for the room half. The 2D overlay adds essentially zero GPU load. **$0/month in streaming fees.**

## What was attempted in this session (and outcomes)

### ✅ Worked (kept in code)
- **Asset compression:** Draco + WebP at 1024² across all GLBs. 890 MB → 205 MB total in `public/`.
- **Visitor-mode optimizations** in `src/main.jsx`:
  - Lambert "fake bake" of room materials (line ~836)
  - Per-mode cube backdrops (sit/computer/shelf/hero), files in `public/baked/cube-atlas-*.png`
  - Turbo tier forced in website mode (DPR 0.5×, 256² shadows, BasicShadowMap)
  - `antialias: false`, `shadowMap.enabled = false`, `EffectComposer` skipped
  - `powerPreference: 'default'`, initial DPR 0.75
  - Video preload `'metadata'` (not auto) so H.264 decoder doesn't reserve memory upfront
  - **main.jsx EARLY-ABORTS on visitor mode** without `?stream=1` (line ~28-50) — prevents Safari OOM by not initializing WebGL on visitor side
- **Asset baselines** under `data/baselines/2026-05-12-1054am-room-milestone-pre-bake.json` — restorable snapshot of localStorage scene state
- **Cache-Control headers** in `server/index.js` — `no-cache, no-store, must-revalidate` for `index.html` so visitor refreshes get latest immediately
- **Lumiere candle hidden in website mode** (per user request) — bank-spawn filter at items mount

### 🟡 Built but parked (in repo, not actively used)
- **Hyperbeam pixel streaming integration** — `index.html` has `__stream-gate` IIFE with "▶ ENTER THE ROOM" button; `server/index.js` has `/api/hyperbeam-session` endpoint. Wiring works. **Free tier hardware too weak for our scene** (cloud Chrome can't fully load the scene smoothly). Paid tier might work but untested.
- **Electron wrap** at `electron/main.cjs` + `electron-builder.json`. Builds `dist-electron/DeskPortfolio-x64.zip` (160 MB) via `npm run electron:build:win`. Was for Vagon path. The .exe inside opens the live Railway URL with `?stream=1`.
- **Blender Cycles lightmap bake script** at `scripts/bake/bake_lightmap.py`. Designed to bake AO + HDRI environment to a UV1 lightmap, then apply as `material.lightMap` in Three.js. **Bake stalled at "Updating Images" step** with 3500+ mesh primitives. Never completed. Solution would be: pre-strip materials before bake (script attempts this but had bugs).

### ❌ Didn't work
- **Hyperbeam free tier** — cloud machines underpowered for the full scene. User saw "WARMING UP" forever in the streamed Chrome.
- **Vagon Streams** — Advanced Setup has a flat **$0.67-2.01/day reservation fee per region** that I didn't catch upfront. Misadvised user. Path abandoned at "Coverage" map step (the SVG world map needs real user clicks, can't be programmatically driven due to `event.isTrusted` checks).
- **Browser automation of OS file pickers** — fundamental browser security. Can't bypass.
- **Programmatic clicks on Hyperbeam "Reveal test key" + Vagon map** — `event.isTrusted` filter blocks synthetic clicks. User must physically click.
- **Vagon Choose App dropdown** — was empty for ~10 min after upload because Vagon's backend was still processing. Eventually populated.

## Strategic pivot — May 13

After ~10 hours fighting streaming infrastructure, user realized:

> The portfolio website isn't built. There's no bio, no projects, no case studies. The streaming-smoothness fight is putting cart before horse.

**Decision: stop streaming work. Build content + 2D inside-computer experience. Revisit streaming only if a final-scene complexity issue actually requires it (it shouldn't, since the inside-computer is 2D).**

Plan file location: `/Users/jarvis/.claude/plans/snazzy-tinkering-fern.md`

## Open decisions

1. **Remove Hyperbeam gate from `index.html`?** Defer until Phase 1 verification confirms Safari runs the room smoothly with all current optimizations. If yes → strip the gate. If still tight → leave as fallback.
2. **Globe implementation: SVG, CSS-3D, or tiny isolated Three.js sphere?** Defer to Phase 3 design.
3. **Custom domain at launch?** Probably yes (`marcportfolio.com` or similar — ~$12/year through Railway).
4. **Should the 3D room canvas be hidden or just paused when inside the computer?** Hidden (`canvas.style.display='none'`) — simplest, biggest perf win, easy to resume.

## Recommended next steps (in order)

### Immediate — 10 min
1. **Close the Vagon stream-link wizard** without clicking Save (no fees accrue until a stream link exists)
2. **Email `support@vagon.io`** asking for $13 refund
3. **Hard-refresh Safari** at the live URL with Cmd+Option+E → Cmd+R. Confirm the room loads smoothly. If yes, streaming is officially not needed.

### Next 1-2 weeks — USER (no coding)
Gather portfolio content in a `/portfolio-content/` folder:
- `bio.md` (2-4 paragraphs, Pixar-producer angle)
- `headshot.jpg`
- `projects/01-<name>/index.md` + images, repeat for 3-5 projects
- `sections.md` — list of section names that become globe markers

### Next 2-3 weeks — CLAUDE (when content ready)
Build the inside-the-computer experience:
- **Phase 3a:** Boot animation polish (~1 day)
- **Phase 3b:** "Dive into the computer" — new `setMode('inside')` that grows the screen overlay to fullscreen and fades the room canvas (~2-3 days)
- **Phase 3c:** Globe nav widget (~3-4 days)
- **Phase 3d:** Section pages — bio, projects, reel, contact (~1-2 days each)
- **Phase 3e:** Return-to-room button, mobile responsive, animations, sound (~2-3 days)

### Final week — Polish + ship
- Custom domain
- Open Graph metadata
- Cross-device test
- Remove Hyperbeam gate (probably)
- Tag `v1.0-recruiter-ready`

## Critical files for Phase 3 work

| File | Lines | Purpose |
|---|---|---|
| `src/main.jsx` | 1663-1701 | `screenHtml` overlay — seed for the inside-computer UI |
| `src/main.jsx` | 1722 | `updateScreenHtmlPosition()` stub — parallax hook |
| `src/main.jsx` | 1341+ | `setMode()` — add `'inside'` mode here |
| `src/main.jsx` | 1332 | `_modeChangeHandlers` array — register transition hooks |
| `src/ui.js` | 57 | `onUseComputer` — entry point to the new experience |
| `index.html` | 79-180 | `__stream-gate` IIFE — remove in Phase 4 if Safari clean |

## Lessons learned (don't repeat)

1. **Don't pre-pay for streaming infrastructure before there's content.** Cart before horse.
2. **Vagon's Advanced Setup ≠ pay-per-use.** It reserves capacity = daily fees. Their Automated Setup is pay-per-use but Enterprise-only.
3. **Hyperbeam takes URLs directly** (no Electron wrap) but free-tier hardware is too weak for non-trivial Three.js scenes. Pro tier untested.
4. **Browser security blocks lots of automation.** OS file pickers, `event.isTrusted` checks on critical buttons. Pure JS can't bypass.
5. **Chrome MCP can drive most DOM** but file dialogs and SVG maps with `isTrusted` filters require human gestures.
6. **Anthropic's "read-only" tier on Chrome** means `computer-use` can't physically click in browsers. The two automation tools (Chrome MCP + computer-use) complement: MCP for DOM, computer-use for screenshots. But computer-use can't click on Chrome.
7. **The 3D room only needs to run on Safari once per visit.** Once inside the computer overlay, hide the canvas. Never run two heavy scenes at once.
8. **Cross-compile Windows .exe from Apple Silicon Mac** — Wine 4.0.1 (electron-builder default) is x86_64-only. Use `zip` target instead of `portable`/`nsis`.

## Quick reference cheat-sheet

```bash
# Deploy a code change (PAUSED — user is working locally for now)
git add -A && git commit -m "..." && git push origin main
# Railway auto-deploys in ~2-3 min

# Local dev — DUAL-LOCALHOST PREVIEW (the new setup, May 13)
npm run dev                              # Vite dev on http://localhost:3001
# Then open BOTH in separate tabs:
#   1. http://localhost:3001/             ← BUILDER mode (full editor, sliders, gizmos)
#   2. http://localhost:3001/?mode=website ← RECRUITER mode (what visitors see locally)
#
# The ?mode= override is wired at src/main.jsx line 17-25. Both run off
# the same Vite dev server, hot-reload works in both. The recruiter URL
# runs the visitor-mode optimizations (Lambert, cubemap, Turbo) AND
# skips the visitor-abort because we're on localhost.

# Build + serve production locally (matches Railway behavior exactly)
npm run build && node server/index.js    # http://localhost:3001

# Set a Railway env var via CLI (when we resume pushing)
railway variables --set "KEY=value"

# Check what's deployed
curl -s https://desk-portfolio-production.up.railway.app/ | grep -oE 'index-[^.]+\.js'
```

## Dual-localhost workflow

The user works in TWO Chrome tabs:
- **`http://localhost:3001/`** — "builder" mode. Edit room, drag items, tune sliders. Snapshot state via Push button. All editor UI visible.
- **`http://localhost:3001/?mode=website`** — "recruiter" mode. Exact replica of what a visitor on Railway sees AFTER the Hyperbeam gate (in localhost it skips the gate because hostname is localhost). All visitor-mode optimizations apply: Lambert materials, cubemap backdrop, Turbo tier, no shadows, no postFX. Mac-Plus → "computer mode" overlay all renders here.

**The flow:** edit in builder → preview in recruiter → iterate. No git push needed during iteration. When ready to ship, the user will resume the push-to-Railway pipeline.

---

# 📜 ORIGINAL HANDOFF (pre-May 13) — scene reference, still accurate


## How to run

```bash
cd /Users/jarvis/Pixar/desk-portfolio
npm run dev          # Vite dev server at http://localhost:3001/ (or 3002)
```

Hard reload in Chrome (`⌘+Shift+R`) after any code or asset change. The
GLB cache buster `?v=${Date.now()}` is appended to `room.glb` so the room
itself reloads on every refresh.

---

## URL flags

- `?lite` — skip the heaviest assets (foliage_study, grass merging, strip
  lights). Use to confirm a black-screen issue is a perf problem vs. a
  code bug.

---

## Asset optimization pipeline

`scripts/optimize-assets.mjs` walks every `.glb` under `public/models/`
and rewrites it in place with mesh quantization + Draco compression +
WebP texture compression. Originals are backed up next to each file as
`*.bak`.

```bash
npm run optimize-assets:check   # dry-run, prints sizes
npm run optimize-assets         # apply optimization
```

This took 400 MB of raw assets → 102 MB on the first pass. Re-run after
dropping any new GLB into `public/models/`.

The runtime is configured to load Draco + Meshopt encoded GLBs:
- A shared `makeGLTFLoader()` factory at top of [main.jsx](src/main.jsx)
  attaches DRACOLoader (CDN decoders) and MeshoptDecoder.
- `leafTool.js` has its own configured loader for `leaf.glb`.

---

## Repo layout

```
desk-portfolio/
├── public/
│   ├── images/rio.jpg                 ← window backdrop
│   ├── hdri/sunset.hdr                ← environment lighting
│   ├── videos/luca.mp4                ← (unused now — Luca scenery removed)
│   ├── textures/                      ← Polyhaven PBR sets
│   │   ├── stone/                     ← old_stone_wall_02 (left wall fallback)
│   │   ├── wall/                      ← concrete_wall_005 / 008 / grey_plaster
│   │   ├── wood/                      ← dark_wood, oak_veneer, etc.
│   │   ├── grass/                     ← leafy_grass (floor)
│   │   ├── wood_panel/                ← dark_wooden_planks
│   │   └── oak/                       ← oak_veneer for shelves
│   └── models/                        ← all GLBs (Draco + WebP optimized)
│       ├── room.glb                   ← THE main room — Blender-built
│       ├── walle_boot.glb             ← Wall-E boot prop on desk
│       ├── childhood_books/scene.gltf ← books on shelf
│       ├── finns_sword/scene.gltf     ← Adventure Time sword
│       ├── spiderman.glb              ← red mask
│       ├── spiderman_symbiote.glb     ← black mask
│       ├── groot_pot.glb              ← Groot flower pot
│       ├── succulent/scene.gltf       ← succulent (sits in Groot)
│       ├── pothos.glb                 ← shelf plant
│       ├── foliage_study.glb          ← shelf plant
│       ├── monstera/scene.gltf        ← floor plant
│       ├── hanging_plant.glb          ← ceiling-corner plant
│       ├── minecraft_chest.glb        ← chest on shelf
│       ├── venator_prefab.glb         ← Star Wars Venator interior (2k tex)
│       ├── yt1300_inside.glb          ← Falcon interior (low-poly fallback)
│       ├── yt1300_hd/                 ← Falcon HD (OBJ + MTL + textures)
│       └── leaf.glb                   ← bonsai cherry-blossom leaf template
│
├── src/
│   ├── main.jsx                       ← scene root: renderer/camera/lights/loaders/UI/all panels
│   ├── ui.js                          ← bottom button bar (scenery picker)
│   ├── scenery.js                     ← Rio / Costa Rica / NYC presets
│   └── leafTool.js                    ← (legacy) click-to-place leaf system
│
├── blender/
│   ├── scene.blend
│   ├── bmcp.py                        ← TCP client to drive Blender headlessly
│   └── scripts/                       ← every transformation we've run, numbered
│
├── scripts/
│   └── optimize-assets.mjs            ← gltf-transform optimization pipeline
│
└── assets/                            ← raw source assets (NOT served)
    ├── textures/                      ← raw Polyhaven PBR sets
    └── generated/                     ← AI-generated bonsai_v2.glb, etc.
```

---

## What's currently in the scene

### Locked (set in code, no UI)
- **Desk** at locked position (locked desk-slide = -0.220 in X, camera follows)
- **Mac Plus** with locked transform on desk
- **Bonsai** (with cherry blossom leaves) on desk back-right
- **Luxo lamp** (Pixar logo lamp) on desk back-left, locked rotation/scale
- **Wall-E boot** plant on desk
- **Bookshelf** at locked Z slide 0.430 (final Z = baseLocal.z + 0.770)
- **Shelf interior**: 4 horizontal red-wood plank dividers + alcove walls
  use the shared concrete material; back panel uses concrete; rim trim
  borders use the dark mahogany wood
- **Groot pot + succulent** in big-bottom compartment
- **Childhood books** on Small 1
- **Pothos + Foliage study** on Small 2 (side-by-side)
- **Minecraft chest** + **Spider-Man + Symbiote masks** on stands in Small 1
- **Sword** leaning against the bookshelf
- **Monstera** floor plant on screen-right of desk
- **Hanging plant** in the top-left ceiling corner of the room
- **Strip lights** under each shelf divider (locked at warmth 1.0,
  brightness 0.93). Now child of bookshelf prop group so they slide with it.
- **Mac screen surface** — concave glass-like CRT plane at locked
  `pos=(-0.169, 1.029, 1.898) rot=(0.104, 0, 0) scale=1.265`. Renders the
  portfolio menu via a CanvasTexture on a MeshStandardMaterial with
  emissive map, fades in over 2.4s with a typewriter boot animation.
- **Lighting** locked: Luxo brightness 1.0, Luxo warmth 1.0 (saturated
  tungsten orange), HDRI warmth 1.75, HDRI brightness 0.51, Luxo color
  via mahogany red multiply.
- **Falcon backdrop** (Sketchfab YT-1300 HD OBJ) at locked transform
  `pos=(-4.627, 1.351, 0.667) rot=(3.142, -1.555, 3.142) scale=2.880`.
  No clip planes anymore — full corridor renders. Hidden by default.
- **Venator backdrop** (Sketchfab Clone Wars prefab GLB, 2k textures) at
  locked `pos=(5.000, 0.074, -5.000) rot=(0,0,0) scale=5.000`. Hidden by
  default. PBR look locked: reflection 0.00, glow 0.73, shininess 0.83,
  brightness 1.40. Live carve-out clipping cuts a hole through the
  Venator wherever the bookshelf assembly's bbox is, so the office can
  sit cleanly inside the corridor.

### Live UI (sliders, toggles)

**Bottom-left "Backdrops & nav" panel:**
- Falcon ON/OFF toggle (default OFF)
- Venator ON/OFF toggle (auto-attaches gizmo when turned on)
- Select Falcon for gizmo
- Room walls ON/OFF (toggles the back wall + window frame)
- Fly mode ON/OFF
- Lock position (free cursor) — toggles pointer-lock for editing
- WASD / space / shift help text
- **Shelf assembly**: X/Y/Z sliders to slide the bookshelf-and-everything
  on it as one unit (default Z = 0.770)

**Bottom scenery picker** (mountUI in [ui.js](src/ui.js)):
- Rio de Janeiro / Costa Rica / New York
- Sit at desk / Use computer / Look around camera modes

**Top-right gizmo HUD** (only when item selected):
- X / Y / Z position sliders (range ±25, step 0.001 m)
- rot X / Y / Z (range ±π, step 0.005 rad)
- scale (0.05–20, step 0.005)
- ↶ Undo (per-prop, 60-deep stack)
- 📋 Copy values (clipboard)
- ✕ Close

**Click-to-select**: any prop in `SELECTABLE` list can be raycast-clicked
to attach the gizmo. While in fly mode, Esc unlocks the cursor for
editing without exiting fly mode.

### Removed / disabled UI
- Wood picker (locked to dark mahogany)
- Backdrop X/Y/scale sliders (rio plane locked)
- Falcon look + Venator look slider panels (values locked above)
- Falcon crop panel (no more clipping on Falcon)
- Top-left tuning panel (everything moved to Backdrops & nav)

---

## Mac screen as portfolio

The Mac Plus screen is a real 3D textured plane (`macScreen` group at
the locked transform above) with a concave pillow-bow geometry and a
glass-like material:
- `MeshStandardMaterial` with `color: 0x000000`, `emissiveMap` =
  CanvasTexture, `emissiveIntensity` ramps 0→1 during boot
- Low roughness 0.18 + envMapIntensity 1.4 → HDRI sunset reflects on
  the glass when off
- **State machine**: `off` (black + reflections) → `booting` (terminal
  lines fading in over 2.4s) → `on` (portfolio menu)
- Driven by the existing "Use computer" camera mode

Customize content in `drawScreenMenu()` and `drawScreenBooting()` in
[main.jsx](src/main.jsx) — anything you draw to that 2D canvas appears on
the CRT in 3D.

---

## Camera modes

`src/main.jsx` has three preset cameras:

| Mode | Description |
|---|---|
| **Look around** | wide hero view at desk-eye height |
| **Sit at desk** | a touch closer to the desk, slight angle |
| **Use computer** | inches from the Mac CRT, screen face-on, fades in portfolio |

Plus **fly mode** for free navigation: WASD + space (up) + shift (down)
+ mouse-look via PointerLockControls. Esc / "Lock position" button
releases the cursor so you can click and gizmo-edit objects without
exiting fly mode. Click "Fly mode: ON" to exit and snap back.

---

## Direct manipulation (gizmo system)

- Built on Three.js `TransformControls` (T = move, R = rotate, S = scale)
- Click any prop in the scene → gizmo attaches
- Esc to deselect
- Ctrl+Z / Cmd+Z = undo last drag
- HUD has precision sliders that two-way bind with the gizmo

Selectable groups (registered via `makeSelectable`):
- All loaded props (Wall-E boot, books, sword, Groot, succulent\*,
  monstera, hanging plant, pothos, foliage, chest, both Spider-Man
  stands, Falcon, Venator, Mac screen surface)
- *Succulent* is auto-deselected because it's parented under Groot —
  clicks on its leaves bubble up to select Groot.

---

## Lighting setup (current values)

```js
luxoBulb       PointLight        0.6  warm 0xffb070, distance 0.45 (lamp head)
luxoSpot       SpotLight         11   warm 0xffb56a, cone 30°       (desk pool)
windowLight    RectAreaLight     0.85 warm 0xff8a4a, 4×2.6m         (window soft fill)
hemisphere     HemisphereLight   0    warm 0xff8a40, ground 0x180a04  (HDRI warmth bias)
stripLights    PointLight × 5    1.2  varies          (5 under-shelf accent lights)
```

Plus the HDRI environment map for indirect light (Polyhaven sunset).

---

## Running Blender remotely

The Blender MCP server runs inside Blender on `localhost:9876`. The
`bmcp.py` client speaks the protocol over a TCP socket so we can run
Python scripts without Claude Code needing direct MCP integration.

```bash
# Run a script:
python3 blender/bmcp.py exec "$(cat blender/scripts/06_export_glb.py)"

# Quick scene inspection:
python3 blender/bmcp.py scene
```

If Blender is closed/restarted: open Blender → press N in 3D viewport →
BlenderMCP sidebar tab → "Connect to MCP server".

---

## What's open / interesting to push

1. **Real portfolio content** on the Mac screen — drop actual commercials
   into `drawScreenMenu()` (Three.js VideoTexture for video playback on
   the CRT, or HTML iframe via CSS3DRenderer if you want clickable links).
2. **More HD model swaps** — e.g., a higher-poly Macintosh Plus, a real
   chair model, a textured table mat. Drop a GLB in `public/models/` and
   `npm run optimize-assets`.
3. **Fly-mode improvements** — speed control, collision, camera bookmarks.
4. **Mobile / touch** support — current setup is desktop-only.
5. **Real deploy** — `npm run build` produces a static `dist/` folder.
   Vercel / Netlify with the optimized assets should be near-instant.

---

## Attributions (required by CC BY-SA / CC BY)

- **Macintosh Plus** — Deutsches Museum | Digital, CC BY-SA 4.0 (already
  shown in the bottom-right footer)
- **Bonsai** — Hyper3D Rodin (user-generated)
- **Sunset HDRI**, **wood / wall / grass textures** — Polyhaven (CC0)
- **Wall-E boot, Childhood books, Finn's sword, Spider-Man masks,
  Groot pot, succulent, pothos, foliage study, Monstera, hanging plant,
  Minecraft chest, Falcon, Venator** — Sketchfab artists (verify license
  on each before public deploy)
- **Rio backdrop** — user-provided

If shipping publicly, double-check every Sketchfab source's license.
