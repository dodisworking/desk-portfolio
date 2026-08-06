"""
Blender 4.3 headless lightmap bake — the REAL Option B.

This bake only captures STATIC contributions:
  • Ambient occlusion (corners darken, geometry depth)
  • HDRI environment irradiance (sunset light falling on walls / floor)
  • Indirect bounce light (sunset → wall → desk, etc.)

It does NOT bake the Luxo lamp, window light, or shelf strip lights —
those stay real-time in Three.js so they play across the walls as the
camera orbits. That's how AAA games actually do it (e.g. Spider-Man,
Last of Us): static GI + dynamic key lights.

Lessons from the previous attempt:
  • Smart UV Project on every mesh = 25+ min and hangs Blender.
  • Replaced with `lightmap_pack` which is designed for exactly this
    job and packs all meshes into a single non-overlapping atlas in
    one call.
  • Only DIFFUSE pass (no color, no specular) — half the bake cost.
  • Use existing UV0 for diffuse, new UV1 for the lightmap.

Outputs:
  public/models/room-baked.glb          - room with UV1 + reduced materials
  public/models/room-lightmap.png       - 1024² baked lightmap

Three.js side: load room-baked.glb, set material.lightMap = lightmap
texture (which uses TEXCOORD_1 automatically in r152+).

Run:
  /Applications/Blender.app/Contents/MacOS/Blender \
    --background --python scripts/bake/bake_lightmap.py
"""

import argparse
import sys
import time
from pathlib import Path

import bpy

# ── argparse ──────────────────────────────────────────────────────────
argv = sys.argv
if "--" in argv:
    argv = argv[argv.index("--") + 1:]
else:
    argv = []

ap = argparse.ArgumentParser()
ap.add_argument("--samples", type=int, default=64)
ap.add_argument("--size",    type=int, default=1024)
ap.add_argument("--env-strength", type=float, default=1.5)
args = ap.parse_args(argv)

ROOT = Path(__file__).resolve().parent.parent.parent
ROOM_GLB  = ROOT / "public" / "models" / "room.glb"
HDRI      = ROOT / "public" / "hdri"   / "sunset.hdr"
OUT_GLB   = ROOT / "public" / "models" / "room-baked.glb"
OUT_LMAP  = ROOT / "public" / "models" / "room-lightmap.png"
LM_NAME   = "room_lightmap"
HDRI_NAME = "sunset_hdri"

t0 = time.time()
print(f"[bake] starting | samples={args.samples} | size={args.size}")

# ── Reset Blender ────────────────────────────────────────────────────
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = "CYCLES"

# GPU if available (Apple Silicon Metal)
cycles_prefs = bpy.context.preferences.addons["cycles"].preferences
try:
    cycles_prefs.compute_device_type = "METAL"
    cycles_prefs.refresh_devices()
    for d in cycles_prefs.devices:
        d.use = True
    scene.cycles.device = "GPU"
    n_dev = sum(1 for d in cycles_prefs.devices if d.use)
    print(f"[bake] GPU enabled: METAL ({n_dev} devices)")
except Exception as e:
    print(f"[bake] CPU fallback ({e})")
    scene.cycles.device = "CPU"

scene.cycles.samples = args.samples
scene.cycles.use_adaptive_sampling = True
scene.cycles.adaptive_threshold = 0.01
scene.cycles.use_denoising = True

# Bake pass — DIFFUSE direct+indirect, NO color (lightmap only).
# Setting use_pass_color=False makes the bake output pure lighting,
# which then multiplies cleanly with the existing diffuse textures
# in Three.js. If we baked WITH color, the lightmap would already
# include the wall texture and we'd get a darker result when
# combined.
scene.render.bake.use_pass_direct   = True
scene.render.bake.use_pass_indirect = True
scene.render.bake.use_pass_color    = False
scene.render.bake.margin = 8

# ── Import room ──────────────────────────────────────────────────────
print(f"[bake] importing {ROOM_GLB.name}")
bpy.ops.import_scene.gltf(filepath=str(ROOM_GLB))
all_mesh_objs = [o for o in scene.objects if o.type == "MESH"]
print(f"[bake] {len(all_mesh_objs)} meshes imported ({time.time()-t0:.1f}s)")

# Filter to meshes worth baking — anything under MIN_VERTS is too small
# to merit its own lightmap chart and just clutters the atlas. With
# 3500+ mesh primitives from Draco, we'd otherwise pack everything at
# ~10×10 pixels each, useless. Filtering to >200 verts keeps the big
# walls / floor / ceiling / desk / bookshelf surfaces.
MIN_VERTS = 200
mesh_objs = [o for o in all_mesh_objs if len(o.data.vertices) >= MIN_VERTS]
print(f"[bake] {len(mesh_objs)} meshes pass MIN_VERTS={MIN_VERTS} filter")
if not mesh_objs:
    print("[bake] FATAL: no meshes pass the filter — lower MIN_VERTS")
    sys.exit(1)

# ── Strip all textures: replace materials with clean white Principled
#    AND nuke every image from bpy.data.images so Blender's render
#    engine doesn't try to load them during bake setup. This is the
#    single biggest speedup — texture loading was 15+ min, now <5s.
print("[bake] stripping textures from materials + clearing image data")
seen_mats = set()
for obj in mesh_objs:
    for slot in obj.material_slots:
        mat = slot.material
        if mat is None or mat.name in seen_mats:
            continue
        seen_mats.add(mat.name)
        mat.use_nodes = True
        nt = mat.node_tree
        nt.nodes.clear()
        out_n = nt.nodes.new("ShaderNodeOutputMaterial")
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        bsdf.inputs["Base Color"].default_value = (1.0, 1.0, 1.0, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.9
        nt.links.new(bsdf.outputs["BSDF"], out_n.inputs["Surface"])
print(f"[bake] stripped {len(seen_mats)} unique materials")

# Now nuke every image that was loaded via the GLB import. They're no
# longer referenced (we replaced all materials), but they sit in
# bpy.data.images and Blender's render engine still has to evaluate
# them during setup. Wipe them all.
purged = 0
for img_data in list(bpy.data.images):
    # Don't kill the lightmap target we may have already created or
    # the HDRI we'll attach below.
    if img_data.name in (LM_NAME,):
        continue
    bpy.data.images.remove(img_data)
    purged += 1
print(f"[bake] purged {purged} embedded images from bpy.data.images")

# ── HDRI world for environment contribution ──────────────────────────
world = scene.world or bpy.data.worlds.new("BakeWorld")
scene.world = world
world.use_nodes = True
wn = world.node_tree.nodes
wl = world.node_tree.links
wn.clear()
bg  = wn.new("ShaderNodeBackground")
out = wn.new("ShaderNodeOutputWorld")
env = wn.new("ShaderNodeTexEnvironment")
env.image = bpy.data.images.load(str(HDRI))
bg.inputs["Strength"].default_value = args.env_strength
wl.new(env.outputs["Color"], bg.inputs["Color"])
wl.new(bg.outputs["Background"], out.inputs["Surface"])
print(f"[bake] HDRI '{HDRI.name}' loaded, strength={args.env_strength}")

# ── Create lightmap target image ─────────────────────────────────────
if LM_NAME in bpy.data.images:
    bpy.data.images.remove(bpy.data.images[LM_NAME])
img = bpy.data.images.new(LM_NAME, width=args.size, height=args.size,
                          alpha=False, float_buffer=True)
img.colorspace_settings.name = "sRGB"

# ── Add UV1 (lightmap UV) on every mesh ──────────────────────────────
for obj in mesh_objs:
    me = obj.data
    if "UV1" not in me.uv_layers:
        me.uv_layers.new(name="UV1")
    # active = which UV op edits / which UV the bake samples
    me.uv_layers["UV1"].active = True
    me.uv_layers["UV1"].active_render = False  # original UV0 still renders diffuse
print("[bake] UV1 added to every mesh")

# ── Pack lightmap UVs with lightmap_pack (fast, designed for this) ───
bpy.ops.object.select_all(action="DESELECT")
for obj in mesh_objs:
    obj.select_set(True)
bpy.context.view_layer.objects.active = mesh_objs[0]

print("[bake] running lightmap_pack on all meshes…")
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.lightmap_pack(
    PREF_CONTEXT="ALL_FACES",
    PREF_PACK_IN_ONE=True,        # one atlas across all meshes
    PREF_NEW_UVLAYER=False,       # we already created UV1
    PREF_BOX_DIV=12,              # packing tightness
    PREF_MARGIN_DIV=0.10,
)
bpy.ops.object.mode_set(mode="OBJECT")
print(f"[bake] lightmap_pack done ({time.time()-t0:.1f}s)")

# ── Attach lightmap-target image node to every material so the bake
#    writes into our single shared atlas image, and a UVMap node so the
#    bake samples UV1 ──
for obj in mesh_objs:
    for slot in obj.material_slots:
        mat = slot.material
        if mat is None:
            continue
        if not mat.use_nodes:
            mat.use_nodes = True
        nt = mat.node_tree
        for n in [n for n in nt.nodes if n.name in ("__lmap_target", "__lmap_uv")]:
            nt.nodes.remove(n)
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.name = "__lmap_target"
        tex.image = img
        tex.select = True
        nt.nodes.active = tex
        uvm = nt.nodes.new("ShaderNodeUVMap")
        uvm.name = "__lmap_uv"
        uvm.uv_map = "UV1"
        nt.links.new(uvm.outputs["UV"], tex.inputs["Vector"])

print("[bake] bake-target nodes wired")

# ── Run the bake ─────────────────────────────────────────────────────
bpy.ops.object.select_all(action="DESELECT")
for obj in mesh_objs:
    obj.select_set(True)
bpy.context.view_layer.objects.active = mesh_objs[0]

print(f"[bake] STARTING DIFFUSE BAKE ({args.samples} samples × {args.size}²) …")
t_bake = time.time()
bpy.ops.object.bake(
    type="DIFFUSE",
    use_clear=True,
    use_selected_to_active=False,
    margin=8,
)
print(f"[bake] BAKE FINISHED in {time.time()-t_bake:.1f}s")

# ── Save the lightmap ────────────────────────────────────────────────
img.filepath_raw = str(OUT_LMAP)
img.file_format = "PNG"
img.save()
size_mb = OUT_LMAP.stat().st_size / 1e6
print(f"[bake] lightmap saved: {OUT_LMAP.name} ({size_mb:.1f} MB)")

# ── Strip bake-target nodes from materials so the exported GLB is clean ──
for obj in mesh_objs:
    for slot in obj.material_slots:
        mat = slot.material
        if mat is None or not mat.use_nodes:
            continue
        nt = mat.node_tree
        for n in [n for n in nt.nodes if n.name in ("__lmap_target", "__lmap_uv")]:
            nt.nodes.remove(n)

# ── Export the room with UV1 preserved ───────────────────────────────
print(f"[bake] exporting {OUT_GLB.name}")
bpy.ops.export_scene.gltf(
    filepath=str(OUT_GLB),
    export_format="GLB",
    use_selection=False,
    export_apply=False,
    export_yup=True,
    export_texcoords=True,           # preserves UV0 + UV1
    export_extras=False,
    export_animations=False,
    export_skins=False,
    export_morph=False,
    export_lights=False,
)
out_size_mb = OUT_GLB.stat().st_size / 1e6
print(f"[bake] DONE — room-baked.glb ({out_size_mb:.1f} MB), lightmap PNG ({size_mb:.1f} MB)")
print(f"[bake] total elapsed: {time.time()-t0:.1f}s")
