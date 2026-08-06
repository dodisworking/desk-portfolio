// Asset optimization pipeline.
// Walks every .glb under public/models/ and rewrites it in place with mesh
// quantization + Draco compression + WebP texture compression. Typically
// shrinks model files 10–20× without visible quality loss.
//
// Usage:
//   npm run optimize-assets        — process every GLB under public/models
//   npm run optimize-assets -- --check  — dry-run, just print sizes
//
// To skip a model (e.g. it's already optimized) name it *.opt.glb or list
// it in SKIP below.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup, prune, weld, simplify, draco,
  textureCompress, resample, instance, flatten, join,
} from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { promises as fs } from 'fs';
import path from 'path';

const ROOT = path.resolve(process.cwd(), 'public/models');
const SKIP = new Set([
  // add filenames here to skip e.g. 'walle_boot.glb'
]);
const DRY_RUN = process.argv.includes('--check');

async function* walkGlbs(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkGlbs(full);
    else if (entry.name.endsWith('.glb') && !entry.name.endsWith('.opt.glb')) yield full;
  }
}

async function fileSize(p) {
  const s = await fs.stat(p);
  return s.size;
}

function fmtMB(bytes) { return (bytes / 1024 / 1024).toFixed(2) + ' MB'; }

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });

let totalBefore = 0, totalAfter = 0, processed = 0, skipped = 0;

for await (const file of walkGlbs(ROOT)) {
  const rel = path.relative(ROOT, file);
  if (SKIP.has(path.basename(file))) {
    console.log(`⏭  ${rel}  (in skip list)`);
    skipped++;
    continue;
  }
  const sizeBefore = await fileSize(file);
  totalBefore += sizeBefore;

  if (DRY_RUN) {
    console.log(`◽ ${rel.padEnd(40)}  ${fmtMB(sizeBefore)}`);
    continue;
  }

  console.log(`⏳ ${rel}  ${fmtMB(sizeBefore)} → ...`);
  try {
    const doc = await io.read(file);
    await doc.transform(
      dedup(),
      instance({ min: 5 }),         // collapse identical meshes into instances
      flatten(),
      join(),                        // merge meshes with the same material
      weld(),                        // remove duplicate vertices
      simplify({ simplifier: MeshoptSimplifier, ratio: 0.85, error: 0.001 }),
      resample(),                    // optimize animation tracks
      prune(),                       // strip unused nodes/textures
      textureCompress({ encoder: sharp, codec: 'webp', quality: 80 }),
      draco({ method: 'edgebreaker' }),
    );
    // Backup the original once the first time we touch it
    const backup = file + '.bak';
    if (!await fs.stat(backup).then(() => true, () => false)) {
      await fs.copyFile(file, backup);
    }
    await io.write(file, doc);
    const sizeAfter = await fileSize(file);
    totalAfter += sizeAfter;
    const pct = (sizeAfter / sizeBefore * 100).toFixed(1);
    console.log(`✓ ${rel.padEnd(40)}  ${fmtMB(sizeBefore)} → ${fmtMB(sizeAfter)}  (${pct}%)`);
    processed++;
  } catch (err) {
    console.error(`✗ ${rel}  failed:`, err.message);
    totalAfter += sizeBefore;          // didn't reduce, so count original size
  }
}

if (DRY_RUN) {
  console.log(`\n📊 ${fmtMB(totalBefore)} total raw assets`);
} else {
  console.log(`\n📊 ${processed} processed, ${skipped} skipped`);
  console.log(`   ${fmtMB(totalBefore)} → ${fmtMB(totalAfter)}  ` +
              `(${(totalAfter / totalBefore * 100).toFixed(1)}% of original)`);
  console.log(`   originals backed up next to each file as *.bak`);
}
