# Desk Portfolio

A photoreal 3D desk scene built with Three.js — the portfolio is the room itself, with the actual project work living inside the Mac Plus's CRT.

## Modes

The same codebase runs in two modes, auto-detected by hostname:

- **Build mode** — `localhost` / `127.0.0.1`. All editor UI: sliders, gizmo, item editor, copy/paste, snapshots, recovery. Used for tuning the scene.
- **Website mode** — production. Editor UI hidden. Scene loads from `/api/frozen-scene` (the latest state pushed from build mode). Visitor-facing.

## Quick start

```bash
npm install
npm run dev              # build mode on http://localhost:3001
```

For the production server locally:

```bash
npm run build            # produces dist/
PORT=3000 npm start      # boots Express + serves dist/
```

## Deployment (Railway)

The `railway.json` declares the build + start commands. Railway auto-detects Node and runs:

```
npm ci --omit=optional && npm run build
node server/index.js
```

Environment variables to set in the Railway dashboard:

| Var | Purpose |
|---|---|
| `PUSH_SECRET` | Bearer token for `POST /api/frozen-scene`. Generate with `openssl rand -hex 32`. |
| `DATA_DIR` | Optional. Where the persistent `frozen-scene.json` lives. Defaults to `<repo>/data/`. Set to a Railway volume path if you want it persisted across deploys. |

## Pushing scene updates from build mode → live site

In build mode (localhost), the Sliders menu has a 📦 **Push to live site** button (coming soon). It POSTs the current state to your Railway URL's `/api/frozen-scene` with the `PUSH_SECRET`. The next visitor sees the new state. No redeploy needed.

## Project structure

```
src/                     — the 3D scene (single big main.jsx)
public/                  — static assets (GLBs, textures, HDRs)
server/                  — Railway entrypoint (Express)
data/baselines/          — pinned baseline scenes (the recovered 1:12 AM snapshot)
```
