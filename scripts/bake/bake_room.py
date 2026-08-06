"""
Blender 4.3 headless lightmap bake for the Pixar Desk Portfolio room.

Pipeline:
  1.  Reset Blender, load `public/models/room.glb`.
  2.  Add a second UV channel (UV1) to every mesh and Smart-UV-Project
      it with margin so the lightmap atlas is non-overlapping.
  3.  Recreate the Three.js lighting setup inside Blender:
        - HDRI environment from `public/hdri/sunset.hdr`
        - Luxo lamp (warm spot) at the bulb's world position
        - Window RectAreaLight matching the warm-sunset rect
        - 5 left + 5 right shelf-strip point lights (warm)
  4.  Set up a shared 2048x2048 lightmap target image per material.
  5.  Cycles bake `COMBINED` pass (full lighting + ambient occlusion +
      indirect bounces) at 256 samples. Outputs the lightmap as
      `public/models/room-baked-lightmap.png`.
  6.  Export the scene back to `public/models/room-baked.glb` with the
      lightmap texture embedded and UV1 preserved.

Three.js side: GLTFLoader loads room-baked.glb, copies uv1 → uv2 on
each mesh, sets material.lightMap = lightmapTex, lightMapIntensity =
1.0. With Lambert/Basic material this is one texture sample per pixel
per mesh — orders of magnitude cheaper than real-time PBR + 13 lights.

Run:
    /Applications/Blender.app/Contents/MacOS/Blender \
      --background --python scripts/bake/bake_room.py -- \
      --mode ao            # AO-only smoke test (fast, ~5 min)
    # or
      --mode combined      # full lighting (slow, ~30 min)
"""

import argparse
import os
import sys
from pathlib import Path

import bpy

# ── argparse: anything after `--` is the script's own args ─────────────
argv = sys.argv
if "--" in argv:
    argv = argv[argv.index("--") + 1:]
else:
    argv = []

ap = argparse.ArgumentParser()
ap.add_argument("--mode", choices=["ao", "combined"], default="ao",
                help="ao = ambient-occlusion only (smoke test). "
                     "combined = full lighting bake.")
ap.add_argument("--samples", type=int, default=64,
                help="Cycles samples per pixel. AO is cheap, 32-64 OK. "
                     "Combined needs 256-512 for clean output.")
ap.add_argument("--size", type=int, default=2048,
                help="Lightmap texture resolution (square).")
ap.add_argument("--margin", type=int, default=6,
                help="UV island margin for lightmap unwrap.")
args = ap.parse_args(argv)

ROOT = Path(__file__).resolve().parent.parent.parent
ROOM_GLB    = ROOT / "public" / "models" / "room.glb"
HDRI        = ROOT / "public" / "hdri"  / "sunset.hdr"
OUT_GLB     = ROOT / "public" / "models" / "room-baked.glb"
OUT_LMAP    = ROOT / "public" / "models" / "room-baked-lightmap.png"

# ── reset Blender ────────────────────────────────────────────────────
bpy.ops.wm.read_factory_settings(use_empty=True)

scene = bpy.context.scene
scene.render.engine = "CYCLES"

# Prefer GPU (Apple silicon: Metal). Fall back to CPU.
cycles_prefs = bpy.context.preferences.addons["cycles"].preferences
try:
    cycles_prefs.compute_device_type = "METAL"
    cycles_prefs.refresh_devices()
    for d in cycles_prefs.devices:
        d.use = True
    scene.cycles.device = "GPU"
    print(f"[bake] GPU enabled: METAL ({sum(1 for d in cycles_prefs.devices if d.use)} devices)")
except Exception as e:
    print(f"[bake] GPU not available, falling back to CPU: {e}")
    scene.cycles.device = "CPU"

scene.cycles.samples = args.samples
# Adaptive sampling speeds AO dramatically (most pixels converge fast).
scene.cycles.use_adaptive_sampling = True
scene.cycles.adaptive_threshold = 0.01
scene.cycles.use_denoising = True

# Bake-specific
scene.render.bake.use_pass_direct   = args.mode == "combined"
scene.render.bake.use_pass_indirect = args.mode == "combined"
scene.render.bake.use_pass_color    = args.mode == "combined"
scene.render.bake.margin = args.margin

# ── import room.glb ──────────────────────────────────────────────────
print(f"[bake] importing {ROOM_GLB}")
bpy.ops.import_scene.gltf(filepath=str(ROOM_GLB))
mesh_objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
print(f"[bake] {len(mesh_objs)} mesh objects imported")

# ── add UV1 + smart-unwrap each mesh ─────────────────────────────────
for obj in mesh_objs:
    me = obj.data
    # Create or reuse UV1
    if "UV1" not in me.uv_layers:
        me.uv_layers.new(name="UV1")
    uv1 = me.uv_layers["UV1"]
    me.uv_layers.active = uv1
    uv1.active = True
    uv1.active_render = False  # render still uses UV0 for diffuse

    # Smart UV project on UV1 — give every mesh a unique non-overlapping
    # chart inside the shared lightmap atlas.
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=66.0, island_margin=0.002,
                              area_weight=0.0, correct_aspect=True,
                              scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    obj.select_set(False)

print("[bake] UV1 smart-projected on every mesh")

# ── create the shared lightmap target image ──────────────────────────
img_name = "room_lightmap"
if img_name in bpy.data.images:
    bpy.data.images.remove(bpy.data.images[img_name])
img = bpy.data.images.new(img_name, width=args.size, height=args.size,
                          alpha=False, float_buffer=True)
img.colorspace_settings.name = "Non-Color" if args.mode == "ao" else "sRGB"

# ── lighting setup (only when mode == "combined") ────────────────────
if args.mode == "combined":
    # HDRI world environment
    world = scene.world
    if world is None:
        world = bpy.data.worlds.new("BakeWorld")
        scene.world = world
    world.use_nodes = True
    nodes = world.node_tree.nodes
    links = world.node_tree.links
    nodes.clear()
    bg     = nodes.new("ShaderNodeBackground")
    out    = nodes.new("ShaderNodeOutputWorld")
    envtex = nodes.new("ShaderNodeTexEnvironment")
    envtex.image = bpy.data.images.load(str(HDRI))
    bg.inputs["Strength"].default_value = 1.4   # matches Three.js env intensity
    links.new(envtex.outputs["Color"], bg.inputs["Color"])
    links.new(bg.outputs["Background"], out.inputs["Surface"])
    print(f"[bake] HDRI loaded: {HDRI.name}")

    # Helper: Three.js (x, y, z) → Blender (x, -z, y)
    def t2b(v):
        return (v[0], -v[2], v[1])

    def add_light(name, ltype, location, color=(1, 1, 1), energy=1000, **extra):
        ld = bpy.data.lights.new(name, type=ltype)
        ld.color = color
        ld.energy = energy
        for k, v in extra.items():
            setattr(ld, k, v)
        obj = bpy.data.objects.new(name, ld)
        obj.location = location
        scene.collection.objects.link(obj)
        return obj

    # ── Luxo spot ──
    # Three.js: SpotLight 0xffc090, intensity 4.0, range 2.6, cone PI*0.42,
    # penumbra 0.85, at (0.51, 1.17, 1.85), targeted at (-0.05, 0.74, 1.90)
    import math
    luxo_pos    = t2b((0.51, 1.17, 1.85))
    luxo_target = t2b((-0.05, 0.74, 1.90))
    luxo = add_light("LuxoSpot", "SPOT", luxo_pos,
                      color=(1.0, 0.753, 0.565),   # 0xffc090 normalized
                      energy=120, spot_size=math.pi * 0.42,
                      spot_blend=0.85, shadow_soft_size=0.05)
    # Aim at target
    dirv = [luxo_target[i] - luxo_pos[i] for i in range(3)]
    import mathutils
    luxo.rotation_mode = "QUATERNION"
    luxo.rotation_quaternion = mathutils.Vector(dirv).to_track_quat("-Z", "Y")

    # ── Window rect-area light ──
    # Three.js: RectAreaLight 0xff8a4a intensity 0.85, 4.0×2.6, at (3.4, 1.7, 4.8)
    win_pos = t2b((3.4, 1.7, 4.8))
    win = add_light("WindowAreaLight", "AREA", win_pos,
                     color=(1.0, 0.541, 0.290),   # 0xff8a4a
                     energy=200, shape="RECTANGLE", size=4.0, size_y=2.6)
    # Aim back toward room center (origin-ish)
    dirv = [-win_pos[i] for i in range(3)]
    win.rotation_mode = "QUATERNION"
    win.rotation_quaternion = mathutils.Vector(dirv).to_track_quat("-Z", "Y")

    # ── 5 left shelf-strip point lights ──
    # Three.js: PointLight 0xffb070 intensity 1.2 distance 0.6, at
    # x=1.34+0.110=1.45 (post-offset), Y varies, z=1.38+0.43+0.060=1.87
    # PLUS the panel offset of (-1.300, -0.335, -0.350)
    strip_x = 1.45 + (-1.300)   # 0.15
    strip_z = 1.87 + (-0.350)   # 1.52
    for shelf_y in [2.78, 2.42, 2.07, 1.71, 1.35]:
        shelf_y += -0.335 - 0.012   # panel offset + the -12mm "below shelf top"
        loc = t2b((strip_x, shelf_y, strip_z))
        add_light(f"LeftStrip_{shelf_y:.2f}", "POINT", loc,
                   color=(1.0, 0.690, 0.439), energy=30)   # 0xffb070

    # ── 5 right shelf-strip point lights (mirrored about X=0) ──
    rstrip_x = -strip_x - (-1.150 - (-1.300))  # mirror + apply right offset diff
    # Actually right offset is independent: x=-1.15. Light's base x mirrors left.
    # For simplicity, mirror left to -1.45 + apply right offset -1.15 to that base.
    rstrip_x = -1.45 + (-1.150)
    rstrip_z = 1.87 + (-0.749)
    for shelf_y in [2.78, 2.42, 2.07, 1.71, 1.35]:
        shelf_y += -0.335 - 0.012
        loc = t2b((rstrip_x, shelf_y, rstrip_z))
        add_light(f"RightStrip_{shelf_y:.2f}", "POINT", loc,
                   color=(1.0, 0.690, 0.439), energy=30)

    print("[bake] lights placed (Luxo + window + 5L + 5R strip)")

# ── attach the lightmap image as the bake target on every material ──
for obj in mesh_objs:
    for slot in obj.material_slots:
        mat = slot.material
        if mat is None or not mat.use_nodes:
            if mat is not None:
                mat.use_nodes = True
        nt = mat.node_tree
        # Remove any prior bake-target node from previous runs.
        for n in [n for n in nt.nodes if n.name == "__bake_target"]:
            nt.nodes.remove(n)
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.name = "__bake_target"
        tex.image = img
        tex.select = True
        nt.nodes.active = tex
        # Hook a UV Map node feeding UV1 so the bake samples the new layout.
        uvm = nt.nodes.new("ShaderNodeUVMap")
        uvm.uv_map = "UV1"
        nt.links.new(uvm.outputs["UV"], tex.inputs["Vector"])

print("[bake] all materials have bake target wired to UV1")

# ── select-active dance so bake operates on all meshes ──
bpy.ops.object.select_all(action="DESELECT")
for obj in mesh_objs:
    obj.select_set(True)
if mesh_objs:
    bpy.context.view_layer.objects.active = mesh_objs[0]

# ── bake ──
print(f"[bake] starting Cycles bake ({args.mode}, {args.samples} samples, "
      f"{args.size}², {len(mesh_objs)} meshes)")
bpy.ops.object.bake(
    type="AO" if args.mode == "ao" else "COMBINED",
    use_clear=True,
    use_selected_to_active=False,
    margin=args.margin,
)
print("[bake] bake complete")

# ── save lightmap PNG ──
img.filepath_raw = str(OUT_LMAP)
img.file_format = "PNG"
img.save()
print(f"[bake] lightmap saved: {OUT_LMAP}")

# ── disconnect/clean the bake-target nodes so the exported GLB's
#    materials don't ship the bake plumbing. The lightmap will be wired
#    into the room at Three.js load time via material.lightMap. ──
for obj in mesh_objs:
    for slot in obj.material_slots:
        mat = slot.material
        if mat is None or not mat.use_nodes:
            continue
        nt = mat.node_tree
        for n in [n for n in nt.nodes if n.name == "__bake_target"]:
            nt.nodes.remove(n)
        for n in [n for n in nt.nodes if n.type == "UVMAP" and n.uv_map == "UV1"]:
            nt.nodes.remove(n)

# ── export the baked GLB ──
print(f"[bake] exporting {OUT_GLB}")
bpy.ops.export_scene.gltf(
    filepath=str(OUT_GLB),
    export_format="GLB",
    use_selection=False,
    export_apply=False,
    export_yup=True,
    export_texcoords=True,
    export_attributes=False,
    export_extras=False,
    export_animations=False,
    export_skins=False,
    export_morph=False,
    export_lights=False,
)
print(f"[bake] DONE — {OUT_GLB} ({OUT_GLB.stat().st_size / 1e6:.1f} MB)")
