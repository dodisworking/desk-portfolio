// Leaf placement tool. Lets the user click on the bonsai (or any mesh) to add
// a leaf, then rotate / color / delete each one. Outputs a Blender Python
// script that recreates the placements so we can bake them into room.glb.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const LEAF_URL = '/models/leaf.glb';
const _leafDraco = new DRACOLoader().setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
const HIT_LAYER = 1; // we'll set the bonsai meshes to this layer

export function createLeafTool({ scene, camera, controls, renderer }) {
  const state = {
    enabled: false,
    leafTemplate: null,           // Object3D loaded from leaf.glb (cloned for each leaf)
    leaves: [],                   // [{obj, position, rotation, color}]
    selectedIndex: -1,
    color: '#e23a8e',
    leafScale: 0.06,              // default size (m)
    pickables: [],                // meshes the raycaster checks against
    // Preview: a translucent ghost leaf that follows the mouse cursor
    // while placement mode is on, so the user sees where the next leaf
    // will land + how it'll be oriented BEFORE they click.
    preview: null,                // THREE.Object3D | null
    previewVisible: false,
    // Random rotation jitter applied to each placement for variation.
    // Re-rolled every time the mouse hovers a NEW pickable spot, so
    // each preview reflects the rotation that'll be committed.
    jitterTwist: 0,               // rad — spin around the surface normal
    jitterTiltX: 0, jitterTiltZ: 0,  // small tilts away from normal
    onLeafAdded: null,            // callback(leafObj) fired after addLeafAt
  };

  const raycaster = new THREE.Raycaster();
  const mouseNDC = new THREE.Vector2();

  // ---------- load leaf template ------------------------------------------
  const _leafLoader = new GLTFLoader();
  _leafLoader.setDRACOLoader(_leafDraco);
  _leafLoader.setMeshoptDecoder(MeshoptDecoder);
  _leafLoader.load(LEAF_URL, (gltf) => {
    state.leafTemplate = gltf.scene;
    // Compute bbox to know its native size for scale normalization
    const bb = new THREE.Box3().setFromObject(state.leafTemplate);
    const size = bb.getSize(new THREE.Vector3());
    const longest = Math.max(size.x, size.y, size.z) || 1;
    state.leafTemplate.userData.normScale = 1 / longest;
    console.log('[leafTool] leaf.glb loaded, native longest=', longest);
    // Notify any waiting code (e.g. main.jsx's leaf-restore on boot)
    // that the template is finally ready.
    if (typeof window.__onLeafTemplateReady === 'function') {
      try { window.__onLeafTemplateReady(); } catch (err) { console.warn('[leafTool] __onLeafTemplateReady threw', err); }
    }
    // Build the preview ghost. Cloned from the template; materials are
    // swapped for transparent versions so it reads as a "where will
    // it go" indicator instead of looking placed.
    const ghost = state.leafTemplate.clone(true);
    ghost.traverse((o) => {
      if (!o.isMesh) return;
      const m = new THREE.MeshBasicMaterial({
        color: 0xffaad0, transparent: true, opacity: 0.55,
        depthWrite: false, side: THREE.DoubleSide,
      });
      o.material = m;
      o.castShadow = false; o.receiveShadow = false;
    });
    ghost.scale.setScalar(state.leafTemplate.userData.normScale * state.leafScale);
    ghost.visible = false;
    ghost.renderOrder = 999;        // draw on top so the preview is always readable
    scene.add(ghost);
    state.preview = ghost;
  }, undefined, (err) => console.error('[leafTool] leaf load failed', err));

  // Re-roll the random rotation jitter (called every time the mouse
  // hovers a new spot OR after a placement so the next leaf differs).
  function _rerollJitter() {
    state.jitterTwist = (Math.random() * 2 - 1) * Math.PI;     // full 360° spin
    state.jitterTiltX = (Math.random() * 2 - 1) * 0.35;         // ~±20° tilt
    state.jitterTiltZ = (Math.random() * 2 - 1) * 0.35;
  }
  _rerollJitter();

  // Orient an Object3D so its local +Y points along the surface
  // normal, then apply the per-placement random jitter. Returns the
  // composed quaternion for both preview and placed leaf.
  const _tmpMatrix = new THREE.Matrix4();
  const _tmpQuat = new THREE.Quaternion();
  const _jitterEuler = new THREE.Euler();
  function _applyOrientation(obj, normalWorld) {
    _tmpMatrix.lookAt(new THREE.Vector3(0, 0, 0), normalWorld, new THREE.Vector3(0, 1, 0));
    obj.quaternion.setFromRotationMatrix(_tmpMatrix);
    // Layer the random twist (around Y = the leaf's surface-aligned
    // up-axis) + small tilts on X/Z.
    _jitterEuler.set(state.jitterTiltX, state.jitterTwist, state.jitterTiltZ, 'XYZ');
    _tmpQuat.setFromEuler(_jitterEuler);
    obj.quaternion.multiply(_tmpQuat);
  }

  // ---------- add the bonsai meshes to the pickable list ------------------
  // (called externally once room.glb is loaded)
  function setPickableRoot(root) {
    state.pickables.length = 0;
    root.traverse((o) => {
      if (!o.isMesh) return;
      const n = (o.name || '').toLowerCase();
      // Allow placement on the bonsai trunk and the desk surface
      if (n.includes('bonsai') || n.includes('object') || n.includes('desk')) {
        state.pickables.push(o);
      }
    });
    console.log('[leafTool] pickables:', state.pickables.length);
  }
  window.__leafToolSetPickables = setPickableRoot;

  // ---------- click handler ----------------------------------------------
  function onCanvasClick(ev) {
    if (!state.enabled || !state.leafTemplate) return;
    const rect = renderer.domElement.getBoundingClientRect();
    mouseNDC.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    mouseNDC.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouseNDC, camera);
    const hits = raycaster.intersectObjects(state.pickables, true);
    if (hits.length === 0) return;
    const hit = hits[0];
    addLeafAt(hit.point, hit.face?.normal, hit.object.matrixWorld);
  }
  renderer.domElement.addEventListener('click', onCanvasClick);

  // (Suppression of SELECTABLE pointerdown while in placement mode is
  // handled inside main.jsx's pointerdown handler — it checks
  // `window.__leafTool?.isPlacementActive()` and early-returns. We
  // intentionally don't stopPropagation here so OrbitControls keeps
  // working — user can still right-drag to orbit while placing.)

  // ---------- hover preview ---------------------------------------------
  // While placement mode is on, the ghost leaf tracks the mouse and
  // sits on whatever pickable surface is under the cursor. Every fresh
  // hover spot re-rolls the rotation jitter so the user sees the
  // variation that'll be applied if they click.
  function onCanvasMove(ev) {
    if (!state.enabled || !state.preview || !state.leafTemplate) return;
    const rect = renderer.domElement.getBoundingClientRect();
    mouseNDC.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    mouseNDC.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouseNDC, camera);
    const hits = raycaster.intersectObjects(state.pickables, true);
    if (hits.length === 0) {
      state.preview.visible = false;
      return;
    }
    const hit = hits[0];
    state.preview.position.copy(hit.point);
    const normalLocal = hit.face?.normal;
    if (normalLocal) {
      const normalWorld = normalLocal.clone().transformDirection(hit.object.matrixWorld).normalize();
      _applyOrientation(state.preview, normalWorld);
    }
    state.preview.visible = true;
  }
  renderer.domElement.addEventListener('pointermove', onCanvasMove);

  // ---------- creating a leaf --------------------------------------------
  function addLeafAt(worldPos, normal, hitObjMatrix) {
    const leaf = state.leafTemplate.clone(true);
    const ns = state.leafTemplate.userData.normScale * state.leafScale;
    leaf.scale.setScalar(ns);
    leaf.position.copy(worldPos);
    if (normal) {
      const worldNormal = normal.clone().transformDirection(hitObjMatrix).normalize();
      _applyOrientation(leaf, worldNormal);
    }
    // Give every mesh its own material clone so we can recolor it
    // independently. Force DoubleSide so the flat leaf reads from any
    // angle (matches the pink-leaf detection elsewhere in the app).
    const colorObj = new THREE.Color(state.color);
    leaf.traverse((o) => {
      if (o.isMesh && o.material) {
        o.material = o.material.clone();
        if (o.material.color) o.material.color.copy(colorObj);
        o.material.side = THREE.DoubleSide;
      }
    });
    scene.add(leaf);
    state.leaves.push({ obj: leaf, color: state.color });
    selectLeaf(state.leaves.length - 1);
    if (window.__updateLeafCount) window.__updateLeafCount(state.leaves.length);
    // Re-roll jitter so the NEXT placed leaf differs from this one.
    _rerollJitter();
    // Fire the caller hook (lets the bonsai editor attach the new
    // leaf to `__leavesContainer` so the Leaves X/Y/Z sliders move it
    // alongside the existing leaves).
    if (typeof state.onLeafAdded === 'function') {
      try { state.onLeafAdded(leaf); } catch (err) { console.warn('[leafTool] onLeafAdded threw', err); }
    }
  }

  // ---------- selection -----------------------------------------------------
  function selectLeaf(i) {
    state.selectedIndex = i;
    if (window.__updateLeafSelection) {
      const leaf = state.leaves[i];
      window.__updateLeafSelection(i, leaf?.obj?.rotation, leaf?.color);
    }
  }

  // expose useful actions to the UI
  window.__leafTool = {
    setEnabled(b) {
      state.enabled = !!b;
      if (state.preview) state.preview.visible = false;   // hidden until first hover
      // Re-roll jitter on entry so the first hover already shows variation.
      if (state.enabled) _rerollJitter();
    },
    isPlacementActive() { return !!state.enabled; },
    isTemplateReady() { return !!state.leafTemplate; },
    setOnLeafAdded(fn) { state.onLeafAdded = typeof fn === 'function' ? fn : null; },
    // Spawn a leaf from a serialized snapshot (used to restore
    // user-placed leaves from localStorage on reload). Returns the
    // new Object3D so the caller can parent it into __leavesContainer.
    spawnFromData(data) {
      if (!state.leafTemplate) return null;
      const leaf = state.leafTemplate.clone(true);
      if (data.px !== undefined) leaf.position.set(data.px, data.py, data.pz);
      if (data.qx !== undefined) leaf.quaternion.set(data.qx, data.qy, data.qz, data.qw);
      if (data.sx !== undefined) leaf.scale.set(data.sx, data.sy, data.sz);
      const colorObj = new THREE.Color(data.color || state.color);
      leaf.traverse((o) => {
        if (o.isMesh && o.material) {
          o.material = o.material.clone();
          if (o.material.color) o.material.color.copy(colorObj);
          o.material.side = THREE.DoubleSide;
        }
      });
      return leaf;
    },
    setScale(s) {
      state.leafScale = s;
      if (state.preview && state.leafTemplate) {
        state.preview.scale.setScalar(state.leafTemplate.userData.normScale * s);
      }
      const i = state.selectedIndex;
      if (i < 0 || !state.leaves[i]) return;
      const ns = state.leafTemplate.userData.normScale * s;
      state.leaves[i].obj.scale.setScalar(ns);
    },
    setColor(hex) {
      state.color = hex;
      const i = state.selectedIndex;
      if (i >= 0 && state.leaves[i]) {
        state.leaves[i].color = hex;
        const c = new THREE.Color(hex);
        state.leaves[i].obj.traverse((o) => {
          if (o.isMesh && o.material && o.material.color) o.material.color.copy(c);
        });
      }
    },
    setColorAll(hex) {
      state.color = hex;
      const c = new THREE.Color(hex);
      state.leaves.forEach((l) => {
        l.color = hex;
        l.obj.traverse((o) => {
          if (o.isMesh && o.material && o.material.color) o.material.color.copy(c);
        });
      });
    },
    setRotation(axis, val) {
      const i = state.selectedIndex;
      if (i < 0 || !state.leaves[i]) return;
      state.leaves[i].obj.rotation[axis] = val;
    },
    deleteSelected() {
      const i = state.selectedIndex;
      if (i < 0) return;
      const leaf = state.leaves.splice(i, 1)[0];
      scene.remove(leaf.obj);
      selectLeaf(-1);
      if (window.__updateLeafCount) window.__updateLeafCount(state.leaves.length);
    },
    clear() {
      state.leaves.forEach((l) => scene.remove(l.obj));
      state.leaves.length = 0;
      selectLeaf(-1);
      if (window.__updateLeafCount) window.__updateLeafCount(0);
    },
    exportBlenderScript() {
      // Output Blender Python that recreates the placements.
      const out = [];
      out.push('"""Auto-generated leaf placements from the browser tool. Run via bmcp.py."""');
      out.push('import bpy, os, math, mathutils');
      out.push('LEAF = "/Users/jarvis/Pixar/desk-portfolio/public/models/leaf.glb"');
      out.push('# Remove any prior generated leaves');
      out.push('for n in list(bpy.data.objects.keys()):');
      out.push('    if n.startswith("LeafPlaced_"):');
      out.push('        bpy.data.objects.remove(bpy.data.objects[n], do_unlink=True)');
      out.push('# Coordinate conversion: Three.js (Y-up) -> Blender (Z-up).');
      out.push('# Three.js (x, y, z) -> Blender (x, z, -y).');
      out.push('def threejs_to_blender_pos(x, y, z): return (x, -z, y)');
      out.push('def threejs_to_blender_euler(rx, ry, rz):');
      out.push('    # quick best-effort conversion: rotate around X by 90° to align axes');
      out.push('    return (rx + math.pi/2, rz, -ry)');
      out.push('def import_leaf(idx, pos, rot, scale, rgba):');
      out.push('    pre = set(bpy.data.objects.keys())');
      out.push('    bpy.ops.import_scene.gltf(filepath=LEAF)');
      out.push('    new = [n for n in bpy.data.objects.keys() if n not in pre]');
      out.push('    roots = [bpy.data.objects[n] for n in new if bpy.data.objects[n].parent is None]');
      out.push('    root = roots[0]');
      out.push('    root.name = f"LeafPlaced_{idx}"');
      out.push('    root.location = pos');
      out.push('    root.rotation_euler = rot');
      out.push('    root.scale = (scale, scale, scale)');
      out.push('    # color override on each mesh');
      out.push('    for o in root.children_recursive if hasattr(root, "children_recursive") else []:');
      out.push('        if o.type != "MESH": continue');
      out.push('        for slot in o.material_slots:');
      out.push('            mat = slot.material');
      out.push('            if not mat: continue');
      out.push('            mat = mat.copy(); slot.material = mat');
      out.push('            mat.use_nodes = True');
      out.push('            bsdf = mat.node_tree.nodes.get("Principled BSDF")');
      out.push('            if bsdf:');
      out.push('                bsdf.inputs["Base Color"].default_value = rgba');
      out.push('# Placements:');
      const ns = state.leafTemplate?.userData?.normScale ?? 1.0;
      const scale = state.leafScale * ns;
      state.leaves.forEach((l, idx) => {
        const p = l.obj.position;
        const r = l.obj.rotation;
        const c = new THREE.Color(l.color);
        out.push(`import_leaf(${idx},`
          + ` threejs_to_blender_pos(${p.x.toFixed(4)}, ${p.y.toFixed(4)}, ${p.z.toFixed(4)}),`
          + ` threejs_to_blender_euler(${r.x.toFixed(4)}, ${r.y.toFixed(4)}, ${r.z.toFixed(4)}),`
          + ` ${scale.toFixed(4)},`
          + ` (${c.r.toFixed(3)}, ${c.g.toFixed(3)}, ${c.b.toFixed(3)}, 1.0))`);
      });
      out.push('bpy.ops.wm.save_as_mainfile(filepath="/Users/jarvis/Pixar/desk-portfolio/blender/scene.blend")');
      out.push('print(f"placed { ' + state.leaves.length + ' } leaves")');
      out.push('"ok"');
      return out.join('\n');
    },
    leafCount() { return state.leaves.length; },
    // Exposed so other code (e.g. the bonsai-leaf detach button) can
    // walk the live leaves and wrap each in its own SELECTABLE group.
    getLeafObjects() { return state.leaves.map((l) => l.obj).filter(Boolean); },
  };

  return state;
}
