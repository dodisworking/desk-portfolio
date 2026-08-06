import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { promises as fs, createReadStream } from 'fs';
import path from 'path';

// Item bank: GLB models live OUTSIDE the project at /Volumes/SKRATCH_2TB/items.
// This Vite plugin exposes them under /items-bank/* during dev:
//   GET /items-bank/index.json → list of .glb files in the folder
//   GET /items-bank/<filename>.glb → streams the file
// Path-traversal blocked (no '..' or '/' allowed in the requested name).
const ITEM_BANK_DIR = '/Volumes/SKRATCH_2TB/items';

function itemBankPlugin() {
  return {
    name: 'item-bank-server',
    configureServer(server) {
      server.middlewares.use('/items-bank', async (req, res, next) => {
        try {
          const url = decodeURIComponent((req.url || '/').split('?')[0]);
          if (url === '/index.json' || url === '/') {
            const entries = await fs.readdir(ITEM_BANK_DIR, { withFileTypes: true });
            const items = entries
              .filter((e) =>
                e.isFile() &&
                e.name.toLowerCase().endsWith('.glb') &&
                // Skip macOS resource-fork helpers ("._foo.glb"), which
                // aren't real GLBs and silently fail when GLTFLoader hits
                // them, leaving an empty group with nothing to click.
                !e.name.startsWith('._') &&
                !e.name.startsWith('.')
              )
              .map((e) => ({
                file: e.name,
                label: e.name
                  .replace(/\.glb$/i, '')
                  .replace(/[_\-.]+/g, ' ')
                  .replace(/[()]/g, ' ')
                  .replace(/\s+/g, ' ')
                  .trim(),
              }));
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ items }, null, 2));
            return;
          }
          const requested = url.replace(/^\/+/, '');
          if (requested.includes('..') || requested.includes('/')) {
            res.statusCode = 400; res.end('Bad request'); return;
          }
          const fullPath = path.join(ITEM_BANK_DIR, requested);
          const stat = await fs.stat(fullPath).catch(() => null);
          if (!stat || !stat.isFile()) {
            res.statusCode = 404; res.end('Not found'); return;
          }
          res.setHeader('Content-Type', 'model/gltf-binary');
          res.setHeader('Content-Length', String(stat.size));
          const stream = createReadStream(fullPath);
          stream.on('error', (streamErr) => {
            // Guard: macOS may block SSD reads with EPERM even after
            // stat() succeeds. Without this handler, the async stream
            // error crashes the entire vite process.
            console.warn('[item-bank] read failed for', requested, streamErr.code || streamErr.message);
            if (!res.headersSent) { res.statusCode = 500; res.end('Read failed'); }
            else { try { res.destroy(streamErr); } catch {} }
          });
          stream.pipe(res);
        } catch (err) {
          console.error('[item-bank]', err);
          next(err);
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), itemBankPlugin()],
  server: {
    port: 3001,
    host: true,
    allowedHosts: ['.trycloudflare.com', '.ngrok.io', '.ngrok-free.app'],
    fs: {
      allow: ['..', '/Volumes/SKRATCH_2TB'],
    },
  },
});
