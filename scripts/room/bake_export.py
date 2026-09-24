"""Lightmap baking and glTF export for the room.

Static meshes keep their PBR materials (exported with their textures) and
get a second UV set, `Lightmap`, packed into one atlas. Cycles bakes the
diffuse lighting (direct + indirect, no albedo) into that atlas once per
state: night, day, and the monitor alone. The runtime multiplies the
atlases back onto the materials, so textures stay sharp while lighting
stays physically baked.
"""
import math
from pathlib import Path

import bpy
import numpy as np

import room_scene as rs

LIGHTMAP_UV = "Lightmap"
ATLAS_SIZE = 2048
# Texel density weights: what the seated camera sees up close gets more. The
# mug is small, curved and near the eye: its shading turns fast around it.
IMPORTANCE = [
    (("mug", "coffee"), 8.0),
    (("desk_top", "desk_mat"), 4.0),
    (("wall_front", "window", "monitor", "book", "binder", "stationery", "round_spectacles", "rubber_duck",
      "sticky", "desk_lamp", "cable", "pc_", "potted_plant"), 2.0),
    (("floor", "ceiling", "wall_back", "wall_left", "wall_right", "skirting"), 0.25),
]


def importance(name):
    for prefixes, weight in IMPORTANCE:
        if name.startswith(prefixes):
            return weight
    return 1.0


def is_static(obj):
    """Room geometry that gets lightmaps (the street outside is baked separately)."""
    return (obj.type == "MESH" and not obj.name.startswith(("rt_", "proxy_", "preview_", "emit_", "street_"))
            and obj.visible_camera)


def apply_modifiers():
    """Bake geometry as rendered: apply modifiers and give every object its own mesh."""
    for obj in [o for o in bpy.data.objects if o.type == "MESH"]:
        if obj.data.users > 1:
            obj.data = obj.data.copy()
        if obj.modifiers:
            bpy.context.view_layer.objects.active = obj
            with bpy.context.temp_override(object=obj, active_object=obj, selected_objects=[obj]):
                for mod in list(obj.modifiers):
                    bpy.ops.object.modifier_apply(modifier=mod.name)


def lightmap_uvs(objects):
    """Smart-project each object into a `Lightmap` UV layer, equalise texel
    density in world space, weight by importance, and pack one atlas."""
    for obj in objects:
        if not obj.data.uv_layers:
            rs.project_uv(obj, 0.5)  # UV0 must exist so the lightmap lands in TEXCOORD_1
        uv = obj.data.uv_layers.get(LIGHTMAP_UV) or obj.data.uv_layers.new(name=LIGHTMAP_UV)
        obj.data.uv_layers.active = uv
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.0, area_weight=0.0, scale_to_bounds=False)
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.average_islands_scale()
    bpy.ops.object.mode_set(mode="OBJECT")
    for obj in objects:
        w = importance(obj.name)
        if w != 1.0:
            data = obj.data.uv_layers[LIGHTMAP_UV].data
            coords = np.empty(len(data) * 2, dtype=np.float32)
            data.foreach_get("uv", coords)
            data.foreach_set("uv", coords * math.sqrt(w))
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.pack_islands(udim_source="CLOSEST_UDIM", rotate=True, scale=True, margin_method="FRACTION",
                            margin=4.0 / ATLAS_SIZE, shape_method="CONCAVE")
    bpy.ops.object.mode_set(mode="OBJECT")
    for obj in objects:
        obj.data.uv_layers.active = obj.data.uv_layers[0]
        obj.data.uv_layers[0].active_render = True


def _bake_targets(objects, image):
    """Point every static material at `image` through the Lightmap UVs."""
    nodes = []
    for mat in {slot.material for obj in objects for slot in obj.material_slots if slot.material}:
        nt = mat.node_tree
        uv = nt.nodes.new("ShaderNodeUVMap")
        uv.uv_map = LIGHTMAP_UV
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = image
        nt.links.new(uv.outputs["UV"], tex.inputs["Vector"])
        nt.nodes.active = tex
        nodes.append((nt, uv, tex))
    return nodes


def _clear_targets(nodes):
    for nt, uv, tex in nodes:
        nt.nodes.remove(tex)
        nt.nodes.remove(uv)


def bake_state(objects, name, samples, passes=("DIRECT", "INDIRECT")):
    """Bake diffuse lighting (no albedo) of `passes` into a float atlas image."""
    image = bpy.data.images.new(f"lightmap_{name}", ATLAS_SIZE, ATLAS_SIZE, alpha=False, float_buffer=True)
    image.colorspace_settings.name = "Non-Color"
    nodes = _bake_targets(objects, image)
    scene = bpy.context.scene
    scene.cycles.samples = samples
    scene.render.bake.use_pass_direct = "DIRECT" in passes
    scene.render.bake.use_pass_indirect = "INDIRECT" in passes
    scene.render.bake.use_pass_color = False
    scene.render.bake.margin = 8
    scene.render.bake.margin_type = "EXTEND"
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
        # Cycles bakes into the active UV layer.
        obj.data.uv_layers.active = obj.data.uv_layers[LIGHTMAP_UV]
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.bake(type="DIFFUSE", pass_filter=set(passes), use_clear=True, margin=8)
    for obj in objects:
        obj.data.uv_layers.active = obj.data.uv_layers[0]
    _clear_targets(nodes)
    return image


def add(image, other):
    """image += other, in place; `other` is removed."""
    a = np.empty(len(image.pixels), dtype=np.float32)
    b = np.empty(len(other.pixels), dtype=np.float32)
    image.pixels.foreach_get(a)
    other.pixels.foreach_get(b)
    total = a + b
    total[3::4] = 1.0
    image.pixels.foreach_set(total)
    bpy.data.images.remove(other)


def denoise(image):
    """OIDN over the baked atlas through a throwaway compositor scene
    (Blender 5 compositor: a node group with a group output)."""
    scene = bpy.data.scenes.new("denoise")
    scene.render.resolution_x, scene.render.resolution_y = image.size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "OPEN_EXR"
    scene.view_settings.view_transform = "Standard"
    tree = bpy.data.node_groups.new("denoise", "CompositorNodeTree")
    tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    scene.compositing_node_group = tree
    src = tree.nodes.new("CompositorNodeImage")
    src.image = image
    dn = tree.nodes.new("CompositorNodeDenoise")
    out = tree.nodes.new("NodeGroupOutput")
    tree.links.new(src.outputs["Image"], dn.inputs["Image"])
    tree.links.new(dn.outputs["Image"], out.inputs[0])
    cam = bpy.data.objects.new("denoise_cam", bpy.data.cameras.new("denoise_cam"))
    scene.collection.objects.link(cam)
    scene.camera = cam
    path = Path(bpy.app.tempdir) / f"{image.name}_dn.exr"
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True, scene=scene.name)
    result = bpy.data.images.load(str(path))
    pixels = np.empty(image.size[0] * image.size[1] * 4, dtype=np.float32)
    result.pixels.foreach_get(pixels)
    bpy.data.images.remove(result)
    bpy.data.scenes.remove(scene)
    bpy.data.node_groups.remove(tree)
    return pixels.reshape(image.size[1], image.size[0], 4)[..., :3]


def _percentile_scale(rgb, percentile):
    """The given percentile of the lit texels' brightest channel."""
    peak = rgb.max(axis=-1)
    lit = peak[peak > 1e-6]
    return float(np.percentile(lit, percentile)) if lit.size else 1.0


def _write_webp(encoded, path, rng):
    """8-bit WebP of an already encoded [0, 1] RGB array, dithered by half a code."""
    encoded = np.clip(encoded + (rng.random(encoded.shape, dtype=np.float32) - 0.5) / 255.0, 0, 1)
    h, w = encoded.shape[:2]
    image = bpy.data.images.new(path.stem, w, h, alpha=False)
    image.colorspace_settings.name = "Non-Color"  # already encoded
    image.pixels.foreach_set(np.concatenate([encoded, np.ones((h, w, 1), np.float32)], -1).ravel())
    image.filepath_raw = str(path)
    image.file_format = "WEBP"
    bpy.context.scene.render.image_settings.quality = 92
    image.save(quality=92)
    bpy.data.images.remove(image)


def encode_hdr(rgb, path, rng, percentile=99.7):
    """sRGB WebP of rgb/scale, with the given percentile of the lit texels at
    1.0 (brighter ones clip); returns scale. For pictures (the street view)."""
    scale = _percentile_scale(rgb, percentile)
    v = np.clip(rgb / scale, 0, 1)
    _write_webp(np.where(v <= 0.0031308, v * 12.92, 1.055 * np.power(v, 1 / 2.4) - 0.055), path, rng)
    return scale


# A lightmap spans a sunlit sill and the dark side of a mug. On the sRGB
# curve the dim half of the room lands in the first few 8-bit codes (each
# step 25-50%, with lossy WebP's chroma error turning them into coloured
# blocks), so lightmaps use a log curve with ~3% steps from scale/RANGE up:
#   code e in [0, 1]  <->  x = scale / RANGE * ((RANGE + 1)^e - 1)
LIGHTMAP_RANGE = 4096.0


def encode_lightmap(rgb, path, rng, percentile=99.7):
    """Log-curve WebP of a lightmap (see LIGHTMAP_RANGE); returns scale."""
    scale = _percentile_scale(rgb, percentile)
    v = np.clip(rgb / scale, 0, 1)
    _write_webp(np.log1p(v * LIGHTMAP_RANGE) / math.log1p(LIGHTMAP_RANGE), path, rng)
    return scale


def downscale_textures(limit_default=1024, hero=("desk", "deskmat", "desk_lamp_arm_01")):
    """Cap texture sizes, and give greyscale images RGB copies (Blender's
    WebP writer cannot encode greyscale)."""
    for image in list(bpy.data.images):
        if image.source != "FILE" or not image.size[0]:
            continue
        name = Path(image.filepath).stem
        limit = 2048 if name.startswith(hero) else limit_default
        if image.depth <= 16:  # greyscale (Blender still reports 4 channels)
            w, h = image.size
            pixels = np.empty(len(image.pixels), dtype=np.float32)
            image.pixels.foreach_get(pixels)
            pixels = pixels.reshape(w * h, -1)
            grey = pixels[:, :1]
            pixels = np.concatenate([grey, grey, grey, np.ones_like(grey)], axis=1).ravel()
            rgb = bpy.data.images.new(image.name + "_rgb", w, h, alpha=False)
            rgb.colorspace_settings.name = image.colorspace_settings.name
            rgb.pixels.foreach_set(pixels)
            rgb.pack()
            image.user_remap(rgb)
            image = rgb
        if max(image.size) > limit:
            f = limit / max(image.size)
            image.scale(int(image.size[0] * f), int(image.size[1] * f))


def export_glb(path, objects):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", use_selection=True, export_image_format="WEBP",
        export_image_quality=88, export_texcoords=True, export_normals=True, export_tangents=False,
        export_materials="EXPORT", export_lights=False, export_cameras=False, export_apply=True,
        export_yup=True, export_extras=False)

