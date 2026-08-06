#!/usr/bin/env bash
# One-shot: rsync the project to /Volumes/SKRATCH_2TB/Pixar/desk-portfolio,
# skipping node_modules + Vite cache. Run from the Mac mini whenever you
# want the SSD to mirror the current project state.
#
# Usage:
#   bash scripts/sync-to-ssd.sh

set -e

SRC="/Users/jarvis/Pixar/desk-portfolio/"
DST="/Volumes/SKRATCH_2TB/Pixar/desk-portfolio/"

if [ ! -d "/Volumes/SKRATCH_2TB" ]; then
  echo "ERROR: SKRATCH_2TB SSD is not mounted." >&2
  exit 1
fi

echo "Syncing $SRC → $DST …"
rsync -a \
  --exclude='node_modules/' \
  --exclude='.vite/' \
  --exclude='.next/' \
  --exclude='dist-electron/' \
  --exclude='.DS_Store' \
  "$SRC" "$DST"

# Verify the inlined state block exists in the SSD copy of index.html
KEY_COUNT=$(node -e "
const fs = require('fs');
try {
  const html = fs.readFileSync('$DST/index.html', 'utf-8');
  const m = html.match(/const __STATE_DEFAULTS__ = (\{.*?\});/s);
  if (m) {
    const data = JSON.parse(m[1]);
    console.log(Object.keys(data).length);
  } else { console.log(0); }
} catch (e) { console.log(0); }
" 2>/dev/null)

echo "  SSD index.html inlined state: $KEY_COUNT keys"
if [ "$KEY_COUNT" -lt 30 ]; then
  echo
  echo "⚠  Only $KEY_COUNT keys baked in. To capture ALL keys (bonsai, dropped items, perf tier, etc.):"
  echo "   1. Make sure Vite is running (npm run dev)"
  echo "   2. In Chrome at localhost:3001, hard-refresh (Cmd+Shift+R)"
  echo "   3. Click ⭐ SAVE TO PROJECT (pink button, bottom-center)"
  echo "   4. Re-run this script"
  echo
fi
echo "Done."
