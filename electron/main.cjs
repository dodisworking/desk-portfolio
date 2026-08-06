// Electron wrapper for Vagon Streams hosting.
//
// Vagon hosts this as a Windows .exe on their cloud GPU instances.
// On launch, opens a single fullscreen BrowserWindow pointing at the
// LIVE Railway URL with ?stream=1. The Three.js scene then renders on
// Vagon's RTX A6000 / A4000 (depending on tier), and Vagon's streaming
// layer captures the window output and streams it as WebRTC video to
// the visitor's browser.
//
// Why we open the LIVE URL (not bundled dist/):
//   • Any push to GitHub → Railway updates → next stream session uses
//     the new code with ZERO rebuild of the .exe needed.
//   • .exe stays tiny (~100 MB) instead of 500+ MB with all assets.
//   • Single source of truth — what visitors see matches what you push.

const { app, BrowserWindow, screen } = require('electron');

// Live URL — ?stream=1 tells main.jsx to skip the visitor abort + run
// the full Three.js scene.
const TARGET_URL = process.env.PORTFOLIO_URL ||
  'https://desk-portfolio-production.up.railway.app/?stream=1';

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  const win = new BrowserWindow({
    width,
    height,
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    show: false,                       // show only after first paint to avoid flash
    webPreferences: {
      // Hardware acceleration is essential — without it WebGL falls back
      // to software rendering and the whole point is lost.
      offscreen: false,
      // No need for node integration; this is a thin browser wrapper.
      nodeIntegration: false,
      contextIsolation: true,
      // Allow autoplay (the room has a video backdrop) without user gesture.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadURL(TARGET_URL);

  // Optional: reload-on-crash so a misbehaving page doesn't kill the
  // streaming session for the next visitor.
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[electron] render process gone:', details.reason);
    win.loadURL(TARGET_URL);
  });
}

// Force the GPU process to use the discrete card on multi-GPU machines.
app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder,Vulkan');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
