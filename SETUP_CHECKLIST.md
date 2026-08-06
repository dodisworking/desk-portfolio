# Setup checklist — what's done and what only you can do

## What I've done already

- [x] Created project at `/Users/jarvis/Pixar/desk-portfolio/`
- [x] Installed Next.js 16, React Three Fiber, drei, postprocessing, GSAP
- [x] Built a working blockout scene (room, desk, chair, monitor, lamp, Luxo ball)
- [x] Wired up scenery swap (Rio / Costa Rica / NYC) — clicking changes lighting
- [x] Wired up "Sit at desk" / "Look around" camera moves
- [x] Window video plane (will show looping video once `.mp4` files are dropped in `public/videos/`)
- [x] Downloaded Blender 4.3.2 to `~/Downloads/`
- [x] Downloaded BlenderMCP addon to `blender/addon.py`
- [x] Installed `uv` (the Python tool that runs the Blender MCP server)
- [x] Configured Claude Code to talk to Blender via `.mcp.json`

## What only you can do (~10 min total)

These all require your fingers because they need either your physical clicks, your password, your identity, or your credit card. I cannot legally or practically do them for you.

### 1. Install Blender (2 min)
- Open Finder → `~/Downloads/`
- Double-click `blender-4.3.2-macos-arm64.dmg`
- Drag the Blender app icon into the **Applications** folder
- Open Applications → right-click Blender → **Open** (only first time, to bypass macOS Gatekeeper)

### 2. Install the BlenderMCP addon inside Blender (2 min)
- In Blender: top menu → **Edit → Preferences → Add-ons**
- Click **Install...** (top right)
- Navigate to `/Users/jarvis/Pixar/desk-portfolio/blender/addon.py` and select it
- Search for "MCP" in the addons list, **check the box** next to "Interface: Blender MCP"
- In Blender's 3D view, press `N` to open the sidebar — you should see a **BlenderMCP** tab
- Click **Connect to Claude** in that sidebar (it starts a local socket server)

### 3. Restart Claude Code in this folder (30 sec)
- Quit Claude Code
- Open Terminal, run: `cd /Users/jarvis/Pixar/desk-portfolio`
- Re-launch Claude Code from there
- It will detect `.mcp.json` and ask permission to connect to the Blender MCP — say yes

### 4. (Optional, for AI-generated 3D models) Get free API keys (5 min)
None of these require payment for the free tier. You enter the credit card; I'll never ask.

| Service | Free tier | Sign up |
|---|---|---|
| **Meshy.ai** | 200 credits/month | https://meshy.ai |
| **Hyper3D Rodin** | Free trial | https://hyper3d.ai |
| **Tripo3D** | Free generations | https://tripo3d.ai |

After signing up, paste API keys into a new file: `desk-portfolio/.env.local`:
```
MESHY_API_KEY=...
HYPER3D_API_KEY=...
TRIPO_API_KEY=...
```

I can drive sign-up via Chrome (navigate, prefill non-payment fields) if you want — see the response that came with this checklist.

### 5. Drop reference images (whenever you're ready)
- Save reference photos / AI-generated images of objects you want in the room into `assets/references/`
- Tell me the filename and what it is ("`hunny-pot.png` is the Pooh honey pot, sits on the right side of the desk")
- I generate the 3D model, import to Blender, place in the scene

## Once you finish steps 1–3, ping me

I'll connect to Blender, and from then on the loop is:
1. You drop an image in `assets/references/`
2. You tell me what it is
3. I generate the 3D model + add to the Blender scene
4. I export to web, you see it in the browser

That is the "you don't do the work" workflow you asked for.

## Already-running dev server

`npm run dev` is running. View at **http://localhost:3001** — you'll see the grey-box room with the scenery picker. It will stay ugly until we replace placeholders with photoreal assets in Phase 2.
