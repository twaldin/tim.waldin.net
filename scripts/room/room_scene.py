"""The late-night developer's room, built in Blender from layout.json.

Coordinates in this file are glTF/three.js metres (+Y up, the seated viewer
faces -Z, +X to the viewer's right) and converted with B(). Materials are
plain Principled BSDFs fed by prepared image files so the glTF export and
the three.js runtime see exactly what Cycles renders.

Object naming (read by the runtime):
  rt_*    realtime objects the runtime replaces or animates
  emit_*  light-emitting surfaces whose strength changes between night/day
  live_*  small curved props lit by the realtime lights instead of a
          lightmap (their materials must not be shared with baked meshes)
  proxy_* bake-only occluders (never exported)
Everything else is static and gets baked lightmaps.
"""
import math

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

import polyhaven

PREPARED = polyhaven.CACHE / "prepared"


def B(p):
    """glTF (x, y, z) → Blender (x, -z, y)."""
    x, y, z = p
    return Vector((x, -z, y))


# ---------------------------------------------------------------- textures

def _load(path, non_color=False):
    image = bpy.data.images.load(str(path), check_existing=True)
    if non_color:
        image.colorspace_settings.name = "Non-Color"
    return image


def _pixels(image):
    arr = np.empty(image.size[0] * image.size[1] * 4, dtype=np.float32)
    image.pixels.foreach_get(arr)
    return arr.reshape(image.size[1], image.size[0], 4)


def _save(name, arr, non_color):
    """Write an RGBA float array (linear for colour data) as a PNG in PREPARED."""
    PREPARED.mkdir(parents=True, exist_ok=True)
    path = PREPARED / f"{name}.png"
    h, w = arr.shape[:2]
    image = bpy.data.images.new(name, w, h, alpha=False, float_buffer=False)
    image.colorspace_settings.name = "Non-Color" if non_color else "sRGB"
    image.pixels.foreach_set(arr.astype(np.float32).ravel())
    image.filepath_raw = str(path)
    image.file_format = "PNG"
    image.save()
    bpy.data.images.remove(image)
    return path


def prepared_set(name, asset, res="2k", tint=(1, 1, 1), saturation=1.0, rough=(0.0, 1.0), ao=True):
    """A Poly Haven texture set adjusted for this room.

    Returns {"albedo", "orm", "normal"} image paths. The albedo is tinted
    (multiply, linear) and desaturated; roughness is remapped into `rough`;
    ORM packs AO/roughness/metalness like glTF.
    """
    albedo_path = PREPARED / f"{name}_albedo.png"
    orm_path = PREPARED / f"{name}_orm.png"
    maps = polyhaven.texture(asset, res)
    if not (albedo_path.exists() and orm_path.exists()):
        diff = _pixels(_load(maps["diff"]))  # linear (Blender decodes sRGB)
        rgb = diff[..., :3] * np.array(tint, dtype=np.float32)
        lum = (rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32))[..., None]
        rgb = lum + (rgb - lum) * saturation
        _save(f"{name}_albedo", np.concatenate([np.clip(rgb, 0, 1), np.ones_like(lum)], -1), False)
        if "arm" in maps:
            arm = _pixels(_load(maps["arm"], True))
            occl, r, metal = arm[..., 0], arm[..., 1], arm[..., 2]
        else:
            r = _pixels(_load(maps["rough"], True))[..., 0]
            occl, metal = np.ones_like(r), np.zeros_like(r)
        r = rough[0] + r * (rough[1] - rough[0])
        orm = np.stack([occl if ao else np.ones_like(r), r, metal, np.ones_like(r)], -1)
        _save(f"{name}_orm", orm, True)
    return {"albedo": albedo_path, "orm": orm_path, "normal": maps["nor"]}


# ---------------------------------------------------------------- materials

def material(name, *, textures=None, color=(0.8, 0.8, 0.8), roughness=0.5, metallic=0.0,
             normal_strength=1.0, emission=None, emission_strength=0.0, coat=0.0,
             coat_roughness=0.05, sheen=0.0, transmission=0.0, alpha=1.0, ior=1.45):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    out = nt.nodes["Material Output"]
    nodes, links = nt.nodes, nt.links
    x = -700
    if textures:
        albedo = nodes.new("ShaderNodeTexImage")
        albedo.image = _load(textures["albedo"])
        albedo.location = (x, 300)
        links.new(albedo.outputs["Color"], bsdf.inputs["Base Color"])
        orm = nodes.new("ShaderNodeTexImage")
        orm.image = _load(textures["orm"], True)
        orm.location = (x, 0)
        sep = nodes.new("ShaderNodeSeparateColor")
        sep.location = (x + 300, 0)
        links.new(orm.outputs["Color"], sep.inputs["Color"])
        links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
        links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
        nrm = nodes.new("ShaderNodeTexImage")
        nrm.image = _load(textures["normal"], True)
        nrm.location = (x, -300)
        nmap = nodes.new("ShaderNodeNormalMap")
        nmap.location = (x + 300, -300)
        nmap.inputs["Strength"].default_value = normal_strength
        links.new(nrm.outputs["Color"], nmap.inputs["Color"])
        links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    else:
        bsdf.inputs["Base Color"].default_value = (*color, 1)
        bsdf.inputs["Roughness"].default_value = roughness
        bsdf.inputs["Metallic"].default_value = metallic
    if emission is not None:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    bsdf.inputs["Coat Weight"].default_value = coat
    bsdf.inputs["Coat Roughness"].default_value = coat_roughness
    bsdf.inputs["Sheen Weight"].default_value = sheen
    bsdf.inputs["Transmission Weight"].default_value = transmission
    bsdf.inputs["IOR"].default_value = ior
    bsdf.inputs["Alpha"].default_value = alpha
    del out
    return mat


def emission_input(mat):
    return mat.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"]


# ---------------------------------------------------------------- geometry

def link(obj, collection=None):
    (collection or bpy.context.scene.collection).objects.link(obj)
    return obj


def mesh_from_bmesh(name, bm, mat=None):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    if mat:
        me.materials.append(mat)
    link(obj)
    return obj


def project_uv(obj, tile=1.0, offset=(0.0, 0.0)):
    """World-space box projection: 1 UV unit = `tile` metres on every face."""
    me = obj.data
    if not me.uv_layers:
        me.uv_layers.new(name="UVMap")
    uv = me.uv_layers.active.data
    mw = obj.matrix_world
    rot = mw.to_3x3()
    for poly in me.polygons:
        n = (rot @ poly.normal).normalized()
        ax = max(range(3), key=lambda i: abs(n[i]))
        u_axis, v_axis = [(1, 2), (0, 2), (0, 1)][ax]
        for li in poly.loop_indices:
            co = mw @ me.vertices[me.loops[li].vertex_index].co
            uv[li].uv = (co[u_axis] / tile + offset[0], co[v_axis] / tile + offset[1])


def quad(name, corners, mat=None):
    """A single face through four glTF points (bottom-left, bottom-right,
    top-right, top-left) with UVs (0,0)→(1,1) in that order."""
    bm = bmesh.new()
    face = bm.faces.new([bm.verts.new(B(p)) for p in corners])
    uv_layer = bm.loops.layers.uv.new("UVMap")
    for loop, uv in zip(face.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
        loop[uv_layer].uv = uv
    return mesh_from_bmesh(name, bm, mat)


def box(name, size, center, mat=None, bevel=0.0, segments=3, tile=None, rotation=None):
    """Axis box; size/center in glTF metres (x width, y height, z depth)."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector((size[0], size[2], size[1])), verts=bm.verts)
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=bm.edges[:] + bm.verts[:], offset=bevel, segments=segments,
                        affect="EDGES", profile=0.5)
    obj = mesh_from_bmesh(name, bm, mat)
    obj.location = B(center)
    if rotation is not None:
        obj.rotation_euler = rotation
    bpy.context.view_layer.update()
    for p in obj.data.polygons:
        p.use_smooth = bevel > 0
    if tile:
        project_uv(obj, tile)
    return obj


def smooth_by_angle(bm, degrees=40.0):
    """Smooth faces, with split normals across edges sharper than `degrees`:
    a cylinder's caps stay flat instead of bending its side's normals."""
    limit = math.radians(degrees)
    for face in bm.faces:
        face.smooth = True
    for edge in bm.edges:
        edge.smooth = edge.calc_face_angle(0.0) < limit


def cylinder(name, radius, depth, center, mat=None, vertices=48, axis="Y", bevel=0.0):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=vertices, radius1=radius, radius2=radius, depth=depth)
    if bevel > 0:
        rims = [e for e in bm.edges if len(e.link_faces) == 2 and abs(e.calc_face_angle()) > 1.0]
        bmesh.ops.bevel(bm, geom=rims, offset=bevel, segments=2, affect="EDGES")
    smooth_by_angle(bm)
    obj = mesh_from_bmesh(name, bm, mat)
    obj.location = B(center)
    # Blender cone axis is Z (glTF Y).
    if axis == "X":
        obj.rotation_euler = (0, math.pi / 2, 0)
    elif axis == "Z":
        obj.rotation_euler = (math.pi / 2, 0, 0)
    return obj


def tube(name, points, radius, mat=None, resolution=12):
    """A cable along glTF points (smooth Bezier through them)."""
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = radius
    curve.bevel_resolution = 3
    curve.resolution_u = resolution
    spline = curve.splines.new("BEZIER")
    spline.bezier_points.add(len(points) - 1)
    for bp, p in zip(spline.bezier_points, points):
        bp.co = B(p)
        bp.handle_left_type = bp.handle_right_type = "AUTO"
    obj = bpy.data.objects.new(name, curve)
    link(obj)
    if mat:
        curve.materials.append(mat)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.ops.object.convert(target="MESH")
    return bpy.context.view_layer.objects.active


def import_model(asset, res="2k", keep=None):
    """Import a Poly Haven model; return its mesh objects (optionally filtered by name)."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(polyhaven.model(asset, res)))
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH" and (keep is None or keep(o.name))]
    # Flatten any parenting so transforms below are world-space.
    for o in meshes:
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
    for o in [o for o in new if o not in meshes]:
        bpy.data.objects.remove(o)
    return meshes


def place(objects, position, yaw_deg=0.0, scale=1.0, pivot=None):
    """Move imported objects to a glTF position. The pivot (default: the
    bottom centre of their bounds) lands on `position`."""
    if pivot is None:
        mn, mx = bounds(objects)
        pivot = Vector(((mn.x + mx.x) / 2, (mn.y + mx.y) / 2, mn.z))
    m = (Matrix.Translation(B(position)) @ Matrix.Rotation(math.radians(yaw_deg), 4, "Z")
         @ Matrix.Scale(scale, 4) @ Matrix.Translation(-pivot))
    for o in objects:
        o.matrix_world = m @ o.matrix_world
    return objects


def bounds(objects):
    pts = [o.matrix_world @ Vector(c) for o in objects for c in o.bound_box]
    return Vector(map(min, *pts)), Vector(map(max, *pts))


# ---------------------------------------------------------------- the room

WINDOW = {"x0": -1.32, "x1": -0.46, "y0": 0.88, "y1": 2.1, "depth": 0.16}
BLINDS_BOTTOM = 1.55
# The hex panels' colours, from the lowest-left tile up the cluster: teal to pink.
HEX_COLOURS = [(0.3, 0.8, 1.0), (0.5, 0.54, 1.0), (0.78, 0.44, 0.98), (1.0, 0.46, 0.72)]
# The monitor arm's pole (x, z).
ARM_POLE = (0.4, -0.68)


def _mats():
    # Warm-white drywall, a fine low-relief finish: the beige, coarser
    # plaster read olive-brown by day, a stucco basement in the shade.
    wall = prepared_set("wall_fine", "white_plaster_02", tint=(0.9, 0.88, 0.85), saturation=0.35, rough=(0.82, 0.95))
    return {
        "wall": material("wall_plaster", textures=wall, normal_strength=0.18),
        "ceiling": material("ceiling_plaster", textures=prepared_set("ceiling", "white_plaster_02", tint=(0.92, 0.9, 0.86), rough=(0.85, 0.95)), normal_strength=0.4),
        "floor": material("floor_oak", textures=prepared_set("floor", "wood_floor", tint=(0.75, 0.68, 0.6), rough=(0.35, 0.6))),
        # Satin-oiled American walnut: glossier, it mirrored the window by day
        # as a milky blue wash over the left of the desk. (The paler black
        # walnut veneer read as light oak.)
        "desk": material("desk_walnut", textures=prepared_set("desk_walnut", "american_walnut_veneer", tint=(0.95, 0.88, 0.82), saturation=0.85, rough=(0.58, 0.78)), normal_strength=0.5),
        # Dark grey felt, ~0.08 linear albedo: charcoal at ~0.035 kept the
        # light bar's pool on the mat below the purple-lit walnut round it,
        # and at coal black (~0.009) the lamp-lit hands looked self-lit
        # against it; a coarser, paler weave read as plaster.
        # (The tint scales the source's sRGB values, so albedo goes ~tint^2.2.)
        "mat": material("desk_mat_felt", textures=prepared_set("deskmat8", "caban", tint=(0.66, 0.66, 0.67), saturation=0.0, rough=(0.85, 1.0)), normal_strength=0.45),
        "steel": material("steel_black", color=(0.018, 0.018, 0.02), roughness=0.42),
        "paint": material("paint_white", color=(0.78, 0.77, 0.74), roughness=0.4),
        "blind": material("blind_slat", color=(0.7, 0.7, 0.69), roughness=0.35, metallic=0.2),
        "plastic": material("plastic_black", color=(0.016, 0.016, 0.018), roughness=0.55),
        "screen": material("rt_screen", color=(0.004, 0.004, 0.005), roughness=0.12, emission=(1, 1, 1), emission_strength=0.0),
        "alu": material("alu_dark", color=(0.12, 0.12, 0.13), roughness=0.3, metallic=1.0),
        # Ember's sage ceramic coating: a mid tone, satin, no clear coat. (White
        # read as a diner mug and clipped to cream in the sun; black was a
        # hole at night, and its clear coat mirrored the day panorama as
        # brushed champagne metal.)
        "ceramic": material("mug_ceramic", color=(0.2, 0.235, 0.19), roughness=0.5),
        "mug_inner": material("mug_interior", color=(0.08, 0.08, 0.082), roughness=0.3),
        # `live_` props need materials no baked mesh shares (room.ts bakes per
        # material). The lip carries the same coating (a bright steel lip
        # read as a ring light).
        "mug_steel": material("mug_steel", color=(0.2, 0.235, 0.19), roughness=0.45),
        # Brown coffee with a satin surface (near black and mirror-smooth, it
        # read as a flat black disc).
        "coffee": material("coffee", color=(0.07, 0.035, 0.015), roughness=0.18),
        "rubber": material("cable_rubber", color=(0.01, 0.01, 0.011), roughness=0.6),
        # Milky diffuser in an aluminium channel: mid grey (dark, it read tan
        # by day; white, it read as switched on in the sun).
        "led": material("emit_ledStrip", color=(0.38, 0.38, 0.38), roughness=0.5, emission=(0.46, 0.4, 1.0), emission_strength=0.0),
        "bulb": material("emit_lampLed", color=(0.9, 0.9, 0.88), roughness=0.4, emission=(1.0, 0.88, 0.77), emission_strength=0.0),
        # The light bar's lens edge, seen from the seat: a faint line.
        "bar_edge": material("emit_lightbarEdge", color=(0.05, 0.05, 0.055), roughness=0.4, emission=(1.0, 0.88, 0.77), emission_strength=0.0),
        # Bias light on the monitor's back, washing the wall behind it.
        "bias": material("emit_biasLight", color=(0.1, 0.1, 0.1), roughness=0.5, emission=(0.5, 0.42, 1.0), emission_strength=0.0),
        # The light bar's backlight (the Halo), a touch warmer than its front.
        "halo": material("emit_lightbarHalo", color=(0.1, 0.1, 0.1), roughness=0.4, emission=(1.0, 0.84, 0.7), emission_strength=0.0),
        "mug_led": material("emit_mugLed", color=(0.3, 0.3, 0.3), roughness=0.3, emission=(0.85, 0.95, 1.0), emission_strength=0.0),
        # Mid-grey diffusers: switched off, a Nanoleaf tile sits just above
        # the wall (~1.5x its albedo), not white.
        "hex": [material(f"emit_hexPanel{i}", color=(0.24, 0.24, 0.235), roughness=0.55, emission=c, emission_strength=0.0)
                for i, c in enumerate(HEX_COLOURS)],
        # Hex panel frames: light grey matte (white ones caught the sun as
        # glowing rims by day).
        "panel_white": material("panel_white", color=(0.45, 0.45, 0.44), roughness=0.7),
        # The light bar: graphite anodised aluminium, mostly diffuse (a pure
        # metal only mirrors the eye-centred panorama).
        "graphite": material("graphite", color=(0.05, 0.05, 0.055), roughness=0.45, metallic=0.3),
        "alu_silver": material("alu_silver", color=(0.78, 0.78, 0.79), roughness=0.3, metallic=1.0),
        # The laptop's bead-blasted shell: polished it mirrored the panorama,
        # mauve at night and blown white by the window by day.
        "alu_satin": material("alu_satin", color=(0.42, 0.42, 0.43), roughness=0.5, metallic=0.3),
        # Black titanium phone frame: a pale, smoother one caught the lamp as a
        # hot white line along its top edge.
        "titanium": material("titanium_black", color=(0.2, 0.2, 0.21), roughness=0.5, metallic=1.0),
        # Bead-blasted aluminium, mostly diffuse: a pure metal only mirrors the
        # (eye-centred) room panorama and flips from silver at night to black by day.
        "alu_bead": material("alu_bead", color=(0.3, 0.3, 0.31), roughness=0.6, metallic=0.2),
        # Cable grommets: matte black powder coat.
        "arm_black": material("arm_black", color=(0.012, 0.012, 0.013), roughness=0.55, metallic=0.5),
        # Monitor arm: space-grey anodised aluminium, mostly diffuse. Flat
        # black read as one dark post at night; strongly metallic it mirrored
        # the room panorama, black at night and pale steel by day.
        "arm_grey": material("arm_grey", color=(0.2, 0.2, 0.21), roughness=0.45, metallic=0.25),
        "glass_black": material("glass_black", color=(0.003, 0.003, 0.004), roughness=0.04, coat=1.0, coat_roughness=0.02),
        "phone_back": material("phone_back_glass", color=(0.12, 0.13, 0.15), roughness=0.35),
        # Phone and clock displays: drawn by the runtime; off-black glass in Blender.
        "device_screen": material("rt_deviceScreen", color=(0.003, 0.003, 0.004), roughness=0.05),
        # The clock's LED matrix and the pad's key LCDs in the bake: their
        # average glow at night (the runtime draws the real faces), so they
        # light the desk, the duck and the pad's bezel round them.
        "clock_glow": material("rt_clockGlow", color=(0.003, 0.003, 0.004), roughness=0.05, emission=(0.72, 1.0, 0.78), emission_strength=0.0),
        "deck_glow": material("rt_deckGlow", color=(0.003, 0.003, 0.004), roughness=0.05, emission=(0.72, 0.72, 1.0), emission_strength=0.0),
        # Gloss-white polycarbonate (the earbuds case), a little below white
        # so the lamp's hotspot doesn't blow it out.
        "gloss_white": material("gloss_white", color=(0.46, 0.46, 0.45), roughness=0.3, coat=0.5, coat_roughness=0.1),
        "soft_touch": material("soft_touch_black", color=(0.04, 0.04, 0.042), roughness=0.6),
        **{f"sticker_{name}": material(f"sticker_{name}", color=c, roughness=0.7) for name, c in (
            ("teal", (0.05, 0.45, 0.45)), ("orange", (0.8, 0.25, 0.05)), ("white", (0.55, 0.55, 0.53)),
            ("purple", (0.3, 0.12, 0.55)), ("black", (0.02, 0.02, 0.022)), ("green", (0.25, 0.7, 0.2)))},
        # White acoustic fabric, a fine knit (see acoustic_mesh): a smooth
        # fabric with sheen read as a glossy ball in three.js, a wool weave
        # too fine to show as a smooth one; space grey read as a black hole
        # beside the arm pole at night.
        "speaker_mesh": material("speaker_fabric", textures=acoustic_mesh("speaker_knit"), normal_strength=1.0),
        # White emission times a radial gradient (see _speaker): a soft glow, not a hard disc.
        "speaker_glow": material("emit_speakerGlow", color=(0.02, 0.02, 0.02), roughness=0.1, emission=(1.0, 1.0, 1.0), emission_strength=0.0),
        "braided": material("cable_braided", color=(0.03, 0.03, 0.032), roughness=0.6),
        # The speaker's own white cable (a black one read as a stray lead).
        "cable_white": material("cable_white", color=(0.62, 0.62, 0.6), roughness=0.5),
        # Tempered glass as a faint, alpha-blended reflector: as a transmissive
        # material its near-black base colour tinted everything behind it
        # black, so the case read as a dead box in Cycles and three.js alike.
        "pcglass": material("pc_glass", color=(0.02, 0.02, 0.025), roughness=0.05, alpha=0.18),
        "pc_led": material("emit_pcLedWhite", color=(0.1, 0.1, 0.1), roughness=0.4, emission=(0.93, 0.92, 1.0), emission_strength=0.0),
        "pcboard": material("pc_board", color=(0.02, 0.022, 0.024), roughness=0.6),
        "fan": material("emit_pcFans", color=(0.05, 0.05, 0.05), roughness=0.4, emission=(0.5, 0.42, 1.0), emission_strength=0.0),
    }


def _glass_material():
    """Window glass: a Fresnel reflection for what we see, fully transparent
    to shadow rays so the sun comes through (a Fresnel mix alone goes opaque
    at the grazing angles of low sun)."""
    mat = bpy.data.materials.new("rt_windowGlass")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    mix = nt.nodes.new("ShaderNodeMixShader")
    fres = nt.nodes.new("ShaderNodeFresnel")
    fres.inputs["IOR"].default_value = 1.5
    gloss = nt.nodes.new("ShaderNodeBsdfGlossy")
    gloss.inputs["Roughness"].default_value = 0.02
    transp = nt.nodes.new("ShaderNodeBsdfTransparent")
    path = nt.nodes.new("ShaderNodeLightPath")
    not_shadow = nt.nodes.new("ShaderNodeMath")
    not_shadow.operation = "SUBTRACT"
    not_shadow.inputs[0].default_value = 1.0
    nt.links.new(path.outputs["Is Shadow Ray"], not_shadow.inputs[1])
    weight = nt.nodes.new("ShaderNodeMath")
    weight.operation = "MULTIPLY"
    nt.links.new(fres.outputs[0], weight.inputs[0])
    nt.links.new(not_shadow.outputs[0], weight.inputs[1])
    nt.links.new(weight.outputs[0], mix.inputs[0])
    nt.links.new(transp.outputs[0], mix.inputs[1])
    nt.links.new(gloss.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    return mat


def _shell(L, m):
    r = L["room"]
    x0, x1, zf, zb, h = r["xMin"], r["xMax"], r["zFront"], r["zBack"], r["ceilingY"]
    t = 0.12
    w = WINDOW
    box("floor", (x1 - x0, 0.02, zb - zf), ((x0 + x1) / 2, -0.01, (zf + zb) / 2), m["floor"], tile=1.2)
    box("ceiling", (x1 - x0, 0.02, zb - zf), ((x0 + x1) / 2, h + 0.01, (zf + zb) / 2), m["ceiling"], tile=2.0)
    box("wall_left", (t, h, zb - zf), (x0 - t / 2, h / 2, (zf + zb) / 2), m["wall"], tile=0.9)
    box("wall_right", (t, h, zb - zf), (x1 + t / 2, h / 2, (zf + zb) / 2), m["wall"], tile=0.9)
    box("wall_back", (x1 - x0, h, t), ((x0 + x1) / 2, h / 2, zb + t / 2), m["wall"], tile=0.9)
    # Front wall (behind the desk) with the window opening, as four pieces.
    d = w["depth"]
    zc = zf - d / 2
    box("wall_front_l", (w["x0"] - x0, h, d), ((x0 + w["x0"]) / 2, h / 2, zc), m["wall"], tile=0.9)
    box("wall_front_r", (x1 - w["x1"], h, d), ((w["x1"] + x1) / 2, h / 2, zc), m["wall"], tile=0.9)
    box("wall_front_b", (w["x1"] - w["x0"], w["y0"], d), ((w["x0"] + w["x1"]) / 2, w["y0"] / 2, zc), m["wall"], tile=0.9)
    box("wall_front_t", (w["x1"] - w["x0"], h - w["y1"], d), ((w["x0"] + w["x1"]) / 2, (h + w["y1"]) / 2, zc), m["wall"], tile=0.9)
    # Skirting boards.
    for name, size, center in [
        ("skirting_front", (x1 - x0, 0.08, 0.012), ((x0 + x1) / 2, 0.04, zf + 0.006)),
        ("skirting_left", (0.012, 0.08, zb - zf), (x0 + 0.006, 0.04, (zf + zb) / 2)),
        ("skirting_right", (0.012, 0.08, zb - zf), (x1 - 0.006, 0.04, (zf + zb) / 2)),
    ]:
        box(name, size, center, m["paint"], bevel=0.002)


def _window(m):
    w = WINDOW
    zf = -0.85
    frame = 0.055
    zg = zf - 0.1  # glass plane, recessed into the reveal
    cx = (w["x0"] + w["x1"]) / 2
    parts = [
        ((w["x1"] - w["x0"], frame, 0.06), (cx, w["y0"] + frame / 2, zg)),
        ((w["x1"] - w["x0"], frame, 0.06), (cx, w["y1"] - frame / 2, zg)),
        ((frame, w["y1"] - w["y0"], 0.06), (w["x0"] + frame / 2, (w["y0"] + w["y1"]) / 2, zg)),
        ((frame, w["y1"] - w["y0"], 0.06), (w["x1"] - frame / 2, (w["y0"] + w["y1"]) / 2, zg)),
        ((0.045, w["y1"] - w["y0"], 0.06), (cx, (w["y0"] + w["y1"]) / 2, zg)),
    ]
    for i, (size, center) in enumerate(parts):
        box(f"window_frame_{i}", size, center, m["paint"], bevel=0.004)
    # Interior sill, proud of the wall.
    box("window_sill", (w["x1"] - w["x0"] + 0.1, 0.025, 0.2), (cx, w["y0"] - 0.0125, zf - 0.03), m["paint"], bevel=0.003)
    gx0, gx1, gy0, gy1 = w["x0"] + frame, w["x1"] - frame, w["y0"] + frame, w["y1"] - frame
    glass = quad("rt_windowGlass", [(gx0, gy0, zg), (gx1, gy0, zg), (gx1, gy1, zg), (gx0, gy1, zg)], _glass_material())
    # Venetian blinds hanging inside the reveal, slats tilted open.
    bm = bmesh.new()
    top, pitch, slat_w = w["y1"] - 0.03, 0.021, 0.025
    y = top
    tilt = math.radians(38)
    length = w["x1"] - w["x0"] - 0.02
    while y > BLINDS_BOTTOM:
        geom = bmesh.ops.create_cube(bm, size=1.0)
        verts = geom["verts"]
        bmesh.ops.scale(bm, vec=Vector((length, slat_w, 0.0006)), verts=verts)
        bmesh.ops.rotate(bm, cent=Vector((0, 0, 0)), matrix=Matrix.Rotation(tilt, 3, "X"), verts=verts)
        bmesh.ops.translate(bm, vec=B((cx, y, zf - 0.035)), verts=verts)
        y -= pitch
    rail = bmesh.ops.create_cube(bm, size=1.0)["verts"]
    bmesh.ops.scale(bm, vec=Vector((length, 0.03, 0.012)), verts=rail)
    bmesh.ops.translate(bm, vec=B((cx, y - 0.004, zf - 0.035)), verts=rail)
    head = bmesh.ops.create_cube(bm, size=1.0)["verts"]
    bmesh.ops.scale(bm, vec=Vector((length + 0.02, 0.045, 0.04)), verts=head)
    bmesh.ops.translate(bm, vec=B((cx, top + 0.03, zf - 0.035)), verts=head)
    mesh_from_bmesh("window_blinds", bm, m["blind"])
    return glass


def _desk(L, m):
    d = L["desk"]
    top = box("desk_top", (d["xMax"] - d["xMin"], d["thickness"], d["zFront"] - d["zBack"]),
              (0, d["topY"] - d["thickness"] / 2, (d["zFront"] + d["zBack"]) / 2), m["desk"], bevel=0.004, tile=1.4)
    # Sled-frame steel legs.
    for sx in (-1, 1):
        x = sx * (d["xMax"] - 0.06)
        for z in (d["zFront"] - 0.06, d["zBack"] + 0.06):
            box(f"desk_leg_{sx}_{z:.2f}", (0.05, d["topY"] - d["thickness"] - 0.02, 0.02), (x, (d["topY"] - d["thickness"]) / 2, z), m["steel"], bevel=0.002)
        box(f"desk_foot_{sx}", (0.05, 0.02, d["zFront"] - d["zBack"] - 0.08), (x, 0.01, (d["zFront"] + d["zBack"]) / 2), m["steel"], bevel=0.002)
        box(f"desk_rail_{sx}", (0.05, 0.03, d["zFront"] - d["zBack"] - 0.1), (x, d["topY"] - d["thickness"] - 0.015, (d["zFront"] + d["zBack"]) / 2), m["steel"], bevel=0.002)
    box("desk_crossbar", (d["xMax"] - d["xMin"] - 0.2, 0.05, 0.02), (0, d["topY"] - d["thickness"] - 0.04, d["zBack"] + 0.1), m["steel"], bevel=0.002)
    mat = L["deskMat"]
    dm = box("desk_mat", (mat["size"][0], mat["thickness"], mat["size"][1]),
             (mat["center"][0], d["topY"] + mat["thickness"] / 2, mat["center"][2]), m["mat"], bevel=0.0015, segments=2, tile=0.22)
    return top, dm


def _monitor(L, m):
    mon = L["monitor"]
    c = Vector(mon["screenCenter"])
    tilt = math.radians(mon["tiltBackDeg"])
    # Screen frame: x right, y up (tilted back), z towards the viewer.
    up = Vector((0, math.cos(tilt), -math.sin(tilt)))
    normal = Vector((0, math.sin(tilt), math.cos(tilt)))
    W, H = mon["screenWidth"], mon["screenHeight"]
    rot = Matrix.Rotation(-tilt, 4, "X")  # about Blender X: the top leans away from the viewer

    def at(u, v, w):  # screen-frame offset → glTF point
        return c + Vector((u, 0, 0)) + up * v + normal * w

    # Panel image surface (drawn by the runtime), UV (0,0) at the viewer's bottom-left.
    screen = quad("rt_screen", [at(-W / 2, -H / 2, 0), at(W / 2, -H / 2, 0), at(W / 2, H / 2, 0), at(-W / 2, H / 2, 0)], m["screen"])
    bezel_s, bezel_t, bezel_b = mon["bezelSide"], mon["bezelTop"], mon["bezelBottom"]
    ow, oh = W + 2 * bezel_s, H + bezel_t + bezel_b
    oc = (bezel_t - bezel_b) / 2
    frames = [
        ((ow, bezel_t, 0.008), (0, H / 2 + bezel_t / 2)),
        ((ow, bezel_b, 0.008), (0, -H / 2 - bezel_b / 2)),
        ((bezel_s, H, 0.008), (-W / 2 - bezel_s / 2, 0)),
        ((bezel_s, H, 0.008), (W / 2 + bezel_s / 2, 0)),
    ]
    for i, (size, (u, v)) in enumerate(frames):
        box(f"monitor_bezel_{i}", size, tuple(at(u, v, -0.004 + 0.0005)), m["plastic"], bevel=0.0012, rotation=rot.to_euler())
    box("monitor_body", (ow, oh, 0.012), tuple(at(0, oc, -0.014)), m["plastic"], bevel=0.003, rotation=rot.to_euler())
    box("monitor_back", (0.34, 0.2, 0.03), tuple(at(0, -0.02, -0.035)), m["plastic"], bevel=0.008, rotation=rot.to_euler())
    # Bias light: an LED strip along the back's top edge washes the wall
    # behind the monitor, so the props right of it show as silhouettes at
    # night instead of sinking into black.
    bias = at(0, H / 2 - 0.012, -0.0215)
    box("emit_biasLight", (ow - 0.06, 0.008, 0.003), tuple(bias), m["bias"], rotation=rot.to_euler())
    # Arm: a space-grey pole on a grommet mount, ending flush in its collar
    # (a cap above the joint read as a desk microphone), an upper arm
    # forward to an elbow just right of the screen's edge and a thicker
    # gas-spring forearm back to a tilt head on the VESA plate at the
    # screen's centre, all hidden behind the screen from the seat (an elbow
    # beside its right edge read as a shelf bracket, and hid the hex
    # panels). The monitor's lead runs clipped under both links and down
    # the pole's back into the mount.
    d = L["desk"]
    px, pz = ARM_POLE
    top = d["topY"]
    cylinder("monitor_mount", 0.034, 0.006, (px, top + 0.003, pz), m["arm_black"], bevel=0.0015)
    cylinder("monitor_mount_collar", 0.021, 0.02, (px, top + 0.016, pz), m["arm_grey"], bevel=0.002)
    # Links at 0.95 m: lower, their shadow cut across the speaker's top as a
    # hard band.
    hub = Vector((px, 0.95, pz))
    pole_top = hub.y + 0.012
    cylinder("monitor_pole", 0.0165, pole_top - top, (px, (pole_top + top) / 2, pz), m["arm_grey"], bevel=0.002)
    cylinder("monitor_arm_collar", 0.02, 0.026, tuple(hub), m["arm_grey"], bevel=0.002)
    plate = at(0, -0.02, -0.07)
    elbow = Vector((0.345, 0.95, -0.54))
    head = plate - normal * 0.012
    y = Vector((0, 1, 0))
    links = []
    # (from, to, width, height, rise): a slim upper arm under a deeper forearm.
    for i, (a, b, w, h, rise) in enumerate(((hub, elbow, 0.026, 0.016, -0.007), (elbow, head, 0.03, 0.022, 0.011))):
        a, b = a + y * rise, b + y * (rise if i == 0 else 0.0)
        run = b - a
        axis = run.normalized()
        lift = (y - axis * y.dot(axis)).normalized()
        side = axis.cross(lift)
        prism(f"monitor_arm_{i}", rounded_rect(run.length + w, h, h / 2 - 0.0005), w,
              frame_matrix((a + b) / 2, axis, lift, side), [m["arm_grey"]], edge=0.002)
        # The cable channel's cover along the underside.
        prism(f"monitor_arm_{i}_channel", rounded_rect(run.length - 0.02, 0.004, 0.0019), w * 0.55,
              frame_matrix((a + b) / 2 - lift * (h / 2), axis, lift, side), [m["arm_black"]], edge=0.0006)
        links.append((a, b, lift, side, w, h))
    cylinder("monitor_arm_elbow", 0.019, 0.042, tuple(elbow + y * 0.002), m["arm_grey"], bevel=0.002)
    cylinder("monitor_arm_elbowCap", 0.014, 0.003, tuple(elbow + y * 0.0235), m["arm_black"], bevel=0.001)
    # Tilt head: a knuckle across the forearm's end, bolted to a 10 × 10 cm
    # VESA plate.
    cylinder("monitor_tilt_knuckle", 0.013, 0.05, tuple(head), m["arm_black"], axis="X", bevel=0.0015)
    box("monitor_vesa", (0.1, 0.1, 0.008), tuple(at(0, -0.02, -0.054)), m["arm_black"], bevel=0.002, rotation=rot.to_euler())
    box("monitor_tilt_head", (0.05, 0.045, 0.016), tuple(at(0, -0.02, -0.064)), m["arm_black"], bevel=0.004, rotation=rot.to_euler())
    # The lead: from the port low on the monitor's back, under the forearm
    # and upper arm (clipped), round the pole's back and down it into the mount.
    r = 0.003
    (a0, b0, lift0, _, _, h0), (a1, b1, lift1, _, _, h1) = links
    under0, under1 = -lift0 * (h0 / 2 + r + 0.0005), -lift1 * (h1 / 2 + r + 0.0005)
    port = at(0.045, -0.13, -0.045)
    behind = Vector((0, 0, -1))
    path = [port, port - y * 0.02 - normal * 0.03, b1 + under1 - y * 0.012, b1 + (a1 - b1) * 0.12 + under1,
            a1 + (b1 - a1) * 0.15 + under1, b0 + (a0 - b0) * 0.12 + under0, a0 + (b0 - a0) * 0.12 + under0,
            hub + behind * 0.024 - y * 0.03, Vector((px, top + 0.06, pz)) + behind * 0.02, Vector((px, top + 0.008, pz)) + behind * 0.019]
    tube("cable_monitor", [tuple(p) for p in path], r, m["rubber"])
    for i, (a, b, lift, side, w, h) in enumerate((links[1], links[0])):
        for j, t in enumerate((0.3, 0.7)):
            prism(f"monitor_arm_clip_{i}_{j}", rounded_rect(w + 0.003, h + 2 * r + 0.004, 0.003), 0.012,
                  frame_matrix(a + (b - a) * t - lift * (r + 0.001), -side, lift, (b - a).normalized()), [m["arm_black"]],
                  edge=0.0008)
    for j, cy in enumerate((0.8, 0.88)):
        box(f"monitor_pole_clip_{j}", (0.016, 0.01, 0.012), (px, cy, pz - 0.018), m["arm_black"], bevel=0.002)
    return screen, normal, bias, -normal


def _pc(L, m, yaw_deg=12.0):
    """Glass-sided tower on the floor under the desk's right end, its window
    turned toward the chair: front intake fans, GPU with a white light bar,
    tower cooler and RAM with soft RGB. (On the desk it filled the right of
    the seated view with a tall dark box and crowded the arm and speaker.)"""
    z = L["decorZones"]["pcTower"]
    (cx, cy, cz), (sw, sh, sd) = z["center"], z["size"]
    y0 = cy
    t = 0.006
    before = set(bpy.data.objects)
    # Steel case minus the glass side (-X).
    box("pc_case_right", (t, sh, sd), (cx + sw / 2 - t / 2, y0 + sh / 2, cz), m["steel"], bevel=0.002)
    box("pc_case_top", (sw, t, sd), (cx, y0 + sh - t / 2, cz), m["steel"], bevel=0.002)
    box("pc_case_bottom", (sw, 0.02, sd), (cx, y0 + 0.01, cz), m["steel"], bevel=0.002)
    box("pc_case_front", (sw, sh, t), (cx, y0 + sh / 2, cz + sd / 2 - t / 2), m["steel"], bevel=0.002)
    box("pc_case_back", (sw, sh, t), (cx, y0 + sh / 2, cz - sd / 2 + t / 2), m["steel"], bevel=0.002)
    box("pc_glass", (0.004, sh - 0.02, sd - 0.02), (cx - sw / 2 + 0.003, y0 + sh / 2, cz), m["pcglass"])
    box("pc_board", (0.004, sh - 0.08, sd - 0.1), (cx + sw / 2 - 0.03, y0 + sh / 2 + 0.02, cz - 0.02), m["pcboard"])
    box("pc_psu_shroud", (sw - 0.02, 0.09, sd - 0.04), (cx, y0 + 0.065, cz), m["steel"], bevel=0.003)
    box("pc_gpu", (0.13, 0.05, 0.29), (cx + 0.02, y0 + sh * 0.42, cz + 0.02), m["plastic"], bevel=0.004)
    box("emit_pcGpuBar", (0.002, 0.008, 0.2), (cx - 0.046, y0 + sh * 0.42 + 0.012, cz + 0.03), m["pc_led"])
    # A little board detail: VRM heatsinks round the socket, chipset and M.2 covers.
    bx0 = cx + sw / 2 - 0.035
    for name, size, (dy, dz) in (("pc_vrm_top", (0.012, 0.018, 0.09), (sh * 0.83, -0.04)),
                                 ("pc_vrm_side", (0.012, 0.09, 0.018), (sh * 0.72, -0.1)),
                                 ("pc_chipset", (0.01, 0.045, 0.045), (sh * 0.3, 0.05)),
                                 ("pc_m2", (0.006, 0.02, 0.09), (sh * 0.52, 0.0))):
        box(name, size, (bx0 - size[0] / 2, y0 + dy, cz + dz), m["alu"], bevel=0.002)
    box("pc_cooler", (0.1, 0.13, 0.05), (cx + 0.03, y0 + sh * 0.7, cz - 0.04), m["alu"], bevel=0.003)
    for i in range(4):
        box(f"pc_ram_{i}", (0.03, 0.035, 0.004), (cx + 0.06, y0 + sh * 0.72, cz + 0.05 + i * 0.009), m["plastic"])
        box(f"emit_pcRam_{i}", (0.03, 0.004, 0.004), (cx + 0.06, y0 + sh * 0.72 + 0.019, cz + 0.05 + i * 0.009), m["fan"])
    rings = [(-0.02, sh * fy - 0.02, sd / 2 - 0.03, (math.pi / 2, 0, 0)) for fy in (0.33, 0.6, 0.85)]
    rings.append((-0.0, sh * 0.7, -0.04, (0, math.pi / 2, 0)))  # cooler fan, facing the glass
    for i, (dx, dy, dz, rot) in enumerate(rings):
        ring = bpy.data.objects.new(f"emit_pcFan_{i}", bpy.data.meshes.new(f"emit_pcFan_{i}"))
        bm = bmesh.new()
        bmesh.ops.create_circle(bm, radius=0.05 if i < 3 else 0.045, segments=48)
        bm.to_mesh(ring.data)
        bm.free()
        link(ring)
        ring.data.materials.append(m["fan"])
        ring.location = B((cx + dx, y0 + dy, cz + dz))
        ring.rotation_euler = rot
        # A thin tube swept along the circle (a Wireframe modifier needs faces).
        ring.modifiers.new("tube", "SKIN").use_smooth_shade = True
        for sv in ring.data.skin_vertices[0].data:
            sv.radius = (0.0025, 0.0025)
        hub_size = (0.11, 0.11, 0.025) if i < 3 else (0.025, 0.1, 0.1)
        box(f"pc_fan_hub_{i}", hub_size, (cx + dx, y0 + dy, cz + dz + (0.01 if i < 3 else 0)), m["plastic"], bevel=0.008)
    bpy.context.view_layer.update()
    pivot = B((cx, y0, cz))
    turn = Matrix.Translation(pivot) @ Matrix.Rotation(math.radians(yaw_deg), 4, "Z") @ Matrix.Translation(-pivot)
    for obj in set(bpy.data.objects) - before:
        obj.matrix_world = turn @ obj.matrix_world


def frame_matrix(origin, right, up, normal):
    """World matrix taking local X/Y/Z to the glTF axes `right`/`up`/`normal` at `origin`."""
    r, u, n, o = B(right), B(up), B(normal), B(origin)
    return Matrix(((r.x, u.x, n.x, o.x), (r.y, u.y, n.y, o.y), (r.z, u.z, n.z, o.z), (0, 0, 0, 1)))


def facing(position, toward, tilt_deg=0.0):
    """Axes (right, up, normal) of an upright panel at `position` turned
    (about the vertical) to face `toward`, leaning back by `tilt_deg`."""
    h = Vector(toward) - Vector(position)
    h.y = 0
    h.normalize()
    t = math.radians(tilt_deg)
    y = Vector((0, 1, 0))
    normal = h * math.cos(t) + y * math.sin(t)
    up = -h * math.sin(t) + y * math.cos(t)
    return up.cross(normal), up, normal


def lying(heading):
    """Axes (right, up, normal) of something lying flat with its local Y along `heading`."""
    h = Vector(heading)
    h.y = 0
    h.normalize()
    return h.cross(Vector((0, 1, 0))), h, Vector((0, 1, 0))


def rounded_rect(width, height, radius, segments=8):
    """Counter-clockwise outline of a rounded rectangle centred on the origin."""
    hw, hh = width / 2 - radius, height / 2 - radius
    points = []
    for cx, cy, start in ((hw, hh, 0), (-hw, hh, 90), (-hw, -hh, 180), (hw, -hh, 270)):
        for i in range(segments + 1):
            a = math.radians(start + 90 * i / segments)
            points.append((cx + radius * math.cos(a), cy + radius * math.sin(a)))
    return points


def circle(radius, segments=40, start_deg=0.0):
    return [(radius * math.cos(math.radians(start_deg) + 2 * math.pi * i / segments),
             radius * math.sin(math.radians(start_deg) + 2 * math.pi * i / segments)) for i in range(segments)]


def clip_outline(points, y, keep_below):
    """The part of a convex outline below (or above) the line at `y`."""
    inside = (lambda p: p[1] <= y) if keep_below else (lambda p: p[1] >= y)
    out = []
    for a, b in zip(points, points[1:] + points[:1]):
        if inside(a):
            out.append(a)
        if inside(a) != inside(b):
            t = (y - a[1]) / (b[1] - a[1])
            out.append((a[0] + (b[0] - a[0]) * t, y))
    return out


def prism(name, outline, thickness, matrix, mats, edge=0.0, edge_segments=3):
    """`outline` (counter-clockwise, local XY) extruded `thickness` along local
    +Z and centred on it, its rims bevelled by `edge`, placed by `matrix`.
    `mats` is [sides, front cap (+Z), back cap (-Z)]; missing caps use the sides."""
    bm = bmesh.new()
    lo = [bm.verts.new((x, y, -thickness / 2)) for x, y in outline]
    hi = [bm.verts.new((x, y, thickness / 2)) for x, y in outline]
    bm.faces.new(list(reversed(lo)))
    bm.faces.new(hi)
    for i in range(len(outline)):
        j = (i + 1) % len(outline)
        bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
    bm.normal_update()
    if edge > 0:
        rims = [e for e in bm.edges if e.calc_face_angle(0.0) > 1.0]
        bmesh.ops.bevel(bm, geom=rims, offset=edge, segments=edge_segments, affect="EDGES", profile=0.5,
                        clamp_overlap=True)
        bm.normal_update()
    smooth_by_angle(bm, 35)
    for face in bm.faces:
        if face.normal.z > 0.999 and len(mats) > 1:
            face.material_index = 1
        elif face.normal.z < -0.999 and len(mats) > 2:
            face.material_index = 2
    obj = mesh_from_bmesh(name, bm)
    for mat in mats:
        obj.data.materials.append(mat)
    obj.matrix_world = matrix
    return obj


def _light_bar(L, m, target=(0.0, 0.74, -0.08)):
    """A ScreenBar-Halo-style monitor light bar, the room's key light: a slim
    graphite bar resting on the monitor's top edge, held by a counterweight
    clamp down the back. Its diffuser faces straight down from the bar's
    front half, behind a lip along the front edge (the real bar's
    asymmetric optics), so from the seat, which is above the bar, the
    emitter shows only as a dim edge while its light goes forward and down
    onto the desk (aimed at `target`), never back at the seat; a softer
    strip on the bar's back (the Halo's backlight) washes the wall behind
    the monitor. (Rolled toward the keyboard, the diffuser faced the seat
    as a hard white line. A desk lamp at the back left read as a stray
    pole from the seat: its head was always out of frame.) Returns the
    light's position, axis and half-angle, and the halo's position and axis."""
    mon = L["monitor"]
    tilt = math.radians(mon["tiltBackDeg"])
    up = Vector((0, math.cos(tilt), -math.sin(tilt)))
    normal = Vector((0, math.sin(tilt), math.cos(tilt)))
    edge = Vector(mon["screenCenter"]) + up * (mon["screenHeight"] / 2 + mon["bezelTop"])  # the bezel's top front edge
    target = Vector(target)
    length, depth, height = 0.45, 0.03, 0.02
    x = Vector((1, 0, 0))
    yv = Vector((0, 1, 0))
    fwd = Vector((0, 0, 1))
    # The bar sits on the top edge, 2 cm proud of the screen's face.
    c = edge + yv * (height / 2 + 0.006) + fwd * 0.012
    bar = prism("lightbar_body", rounded_rect(depth, height, 0.0085), length, frame_matrix(c, fwd, yv, x),
                [m["graphite"]], edge=0.0015)
    for i, side in enumerate((-1, 1)):
        prism(f"lightbar_cap{i}", rounded_rect(depth + 0.001, height + 0.001, 0.009), 0.003,
              frame_matrix(c + x * side * (length / 2 + 0.0012), fwd, yv, x), [m["alu_silver"]], edge=0.0008)
    # The clamp: a saddle on the monitor's top, the counterweight down its back.
    body_back = edge - normal * 0.026
    saddle = (edge + body_back) / 2 + up * 0.004
    box("lightbar_saddle", (0.07, 0.006, 0.034), tuple(saddle), m["graphite"], bevel=0.0015,
        rotation=Matrix.Rotation(-tilt, 4, "X").to_euler())
    weight = body_back - up * 0.022 - normal * 0.006
    box("lightbar_weight", (0.05, 0.05, 0.014), tuple(weight), m["graphite"], bevel=0.003,
        rotation=Matrix.Rotation(-tilt, 4, "X").to_euler())

    def behind_screen(u, v, w):
        return Vector(mon["screenCenter"]) + x * u + up * v + normal * w

    # Its USB lead: down the monitor's back, clear of the VESA head, to the
    # monitor's own lead at the port (see _monitor).
    tube("cable_lightbar", [tuple(p) for p in (weight - up * 0.024 + x * 0.012, behind_screen(0.03, 0.09, -0.03),
                                               behind_screen(0.07, 0.075, -0.056), behind_screen(0.07, -0.1, -0.056),
                                               behind_screen(0.047, -0.128, -0.046))], 0.0018, m["braided"])
    # The diffuser: a flat strip under the bar's front half, facing down.
    bottom = c - yv * (height / 2)
    face = bottom + fwd * 0.003 - yv * 0.0004
    diffuser = prism("emit_lampLed", rounded_rect(length - 0.03, 0.01, 0.004), 0.0012,
                     frame_matrix(face, x, fwd, -yv), [m["bulb"]], edge=0.0004, edge_segments=2)
    # The lip: the bar's front edge carried 4 mm below the diffuser (up into
    # the rounded body), so the seat never sees it; the lip's lower edge
    # glows faintly, the dim line a real bar shows from the chair.
    lip_at = bottom + fwd * (depth / 2 - 0.0012) + yv * 0.0008
    lip = box("lightbar_lip", (length - 0.004, 0.0104, 0.0024), tuple(lip_at), m["graphite"], bevel=0.0006, segments=2)
    edge_glow = box("emit_lightbarEdge", (length - 0.03, 0.0008, 0.0026), tuple(lip_at - yv * 0.0048), m["bar_edge"])
    # The Halo's backlight: a strip on the bar's back, aimed up the wall.
    back = Vector((0, 0.45, -1)).normalized()
    halo_at = c - fwd * (depth / 2 + 0.0004) + yv * 0.002
    halo = prism("emit_lightbarHalo", rounded_rect(length - 0.04, 0.006, 0.003), 0.0012,
                 frame_matrix(halo_at, x, back.cross(x).normalized(), back), [m["halo"]], edge=0.0003)
    # The bar sits inside its own light: none of it casts a shadow.
    for part in (bar, diffuser, lip, edge_glow, halo):
        part.visible_shadow = False
    bulb = face - yv * 0.004
    return B(bulb), B((target - bulb).normalized()), math.radians(48), B(halo_at + back * 0.004), B(back)


def _phone(L, m, eye):
    """A 2-in-1 charging stand at the back left, a hand's width right of the
    clock and clear of the screen's edge (at the front left it was the
    tallest, brightest thing at the frame's edge): a slim tapered post
    rising from the back of a pill-shaped base to a 56 mm MagSafe-style puck
    behind the phone at 40% of its height, the phone's bottom edge floating
    1.5 cm over the base (a neck under its bottom edge read as a lollipop
    stick), and the earbuds case charging on the base's front pad. The runtime draws the
    phone's always-on lock screen (a small local time over notifications) on
    `rt_phoneScreen`."""
    p = Vector(L["decorZones"]["phoneStand"])
    y = Vector((0, 1, 0))
    # Turned 5° off the seat, toward the desk's front (square to the chair
    # it lined up with the clock and pad behind it as one column).
    aim = Matrix.Rotation(math.radians(-5), 3, "Z") @ B(Vector(eye) - p)
    right, up, normal = facing(p, p + Vector((aim.x, 0, -aim.y)), 16)
    fr, fu, fn = lying(-normal)
    base_t = 0.008
    prism("phone_stand_base", rounded_rect(0.078, 0.135, 0.0385), base_t,
          frame_matrix(p - fu * 0.03 + y * (base_t / 2), fr, fu, fn), [m["alu_bead"]], edge=0.0025)
    _earbuds(m, p - fu * 0.062 + y * base_t, fr, fu, fn)
    thick, puck_t = 0.0078, 0.0055
    w, h = 0.0716, 0.1476
    bottom = p + y * (base_t + 0.015)  # the phone's bottom edge, over the base's middle
    c = bottom + up * (h / 2)
    puck = bottom + up * (0.4 * h) - normal * (thick / 2 + puck_t / 2)
    prism("phone_stand_puck", circle(0.028, 64), puck_t, frame_matrix(puck, right, up, normal),
          [m["alu_bead"]], edge=0.0015)
    # The post: an oval section tapering from 16 to 10 mm, base rear to puck.
    foot = p + fu * 0.028 + y * (base_t - 0.002)
    head = puck - normal * (puck_t / 2 - 0.001)
    axis = (head - foot).normalized()
    post = bmesh.new()
    bmesh.ops.create_cone(post, cap_ends=True, segments=32, radius1=0.008, radius2=0.005, depth=(head - foot).length)
    bmesh.ops.scale(post, vec=(1.0, 0.55, 1.0), verts=post.verts)
    smooth_by_angle(post)
    stem = mesh_from_bmesh("phone_stand_post", post, m["alu_bead"])
    stem.matrix_world = frame_matrix((foot + head) / 2, right, axis.cross(right), axis)
    prism("phone_body", rounded_rect(w, h, 0.0105, 12), thick, frame_matrix(c, right, up, normal),
          [m["titanium"], m["glass_black"], m["phone_back"]], edge=0.0014)
    bump = c + right * (w / 2 - 0.021) + up * (h / 2 - 0.021) - normal * (thick / 2 + 0.0006)
    prism("phone_camera", rounded_rect(0.036, 0.037, 0.009), 0.0014, frame_matrix(bump, right, up, normal),
          [m["phone_back"]], edge=0.0005)
    # The screen follows the body's rounded corners (a square quad poked
    # out past them).
    sw, sh = 0.0684, 0.1454
    f = c + normal * (thick / 2 + 0.0002)
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new("UVMap")
    outline = rounded_rect(sw, sh, 0.0092, 12)
    face = bm.faces.new([bm.verts.new(B(f + right * x + up * yy)) for x, yy in outline])
    for loop, (x, yy) in zip(face.loops, outline):
        loop[uv_layer].uv = (x / sw + 0.5, yy / sh + 0.5)
    mesh_from_bmesh("rt_phoneScreen", bm, m["device_screen"])
    return p + fu * 0.036


def _earbuds(m, p, right, heading, up):
    """An AirPods-Pro-style case (60.6 × 45.2 × 21.7 mm) lying on its back
    at `p` on the stand's pad (wireless: it charges there): a rounded pebble,
    domed front and back and round-cornered all round (a flat-topped
    extrusion read as a white brick), split at the lid's seam. Baked with
    the room at high texel density: lit only by the realtime lights (as a
    `live_` prop) its sides went black at night under the lamp-lit lid."""
    heading = -heading  # the lid toward the seat
    right = -right
    a, b, c = 0.0606 / 2, 0.0452 / 2, 0.0217 / 2
    seam = b - 0.0135

    def power(w, e):
        return math.copysign(abs(w) ** e, w)

    for name, lid in (("earbuds_case", False), ("earbuds_lid", True)):
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=64, v_segments=32, radius=1.0)
        # A superellipsoid: squarish in plan (exponent 0.45), rounder in section (0.7).
        for v in bm.verts:
            lat = math.asin(max(-1.0, min(1.0, v.co.z)))
            lon = math.atan2(v.co.y, v.co.x)
            cl = power(math.cos(lat), 0.7)
            v.co = (a * cl * power(math.cos(lon), 0.45), b * cl * power(math.sin(lon), 0.45), c * power(math.sin(lat), 0.7))
        cut = bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, seam + (0.0003 if lid else -0.0003), 0),
                                     plane_no=(0, 1, 0), clear_inner=lid, clear_outer=not lid)
        bmesh.ops.edgeloop_fill(bm, edges=[e for e in cut["geom_cut"] if isinstance(e, bmesh.types.BMEdge)])
        smooth_by_angle(bm, 50)
        part = mesh_from_bmesh(name, bm, m["gloss_white"])
        part.matrix_world = frame_matrix(p + up * c, right, heading, up)


def _clock(L, m, eye):
    """A pixel-matrix display (a 32 × 16 LED grid) at the desk's back left,
    facing the seat. The runtime draws the visitor's local time and a
    commit graph on `rt_clockFace`."""
    p = Vector(L["decorZones"]["deskClock"])
    right, up, normal = facing(p, eye)
    w, h, d = 0.12, 0.066, 0.034
    c = p + up * (h / 2)
    prism("clock_body", rounded_rect(w, d, 0.006), h, frame_matrix(c, right, -normal, up), [m["soft_touch"]],
          edge=0.0012)
    f = c + normal * (d / 2 + 0.0003)
    fw, fh = w - 0.012, h - 0.012
    prism("clock_glass", rounded_rect(fw + 0.002, fh + 0.002, 0.004), 0.0008,
          frame_matrix(f - normal * 0.0002, right, up, normal), [m["glass_black"]], edge=0.0003)
    quad("rt_clockFace", [f - right * fw / 2 - up * fh / 2 + normal * 0.0003, f + right * fw / 2 - up * fh / 2 + normal * 0.0003,
                          f + right * fw / 2 + up * fh / 2 + normal * 0.0003, f - right * fw / 2 + up * fh / 2 + normal * 0.0003],
         m["clock_glow"])
    return p - normal * (d / 2)


def _duck(L, eye):
    """The rubber duck, in profile on the window sill above the clock,
    looking out over the street (perched on the clock it merged the clock,
    the phone and itself into one clump at the screen's left edge)."""
    p = Vector(L["decorZones"]["duck"])
    _, _, normal = facing(p, eye)
    duck = import_model("rubber_duck_toy")
    place(duck, tuple(p), math.degrees(math.atan2(normal.x, normal.z)) - 60, scale=0.17)
    for slot in (s for o in duck for s in o.material_slots):
        bsdf = slot.material.node_tree.nodes["Principled BSDF"]
        bsdf.inputs["Emission Strength"].default_value = 0.0
        # The asset's 1.58 specular tint exports as a 1.58x specular colour,
        # which three.js turns into a bright Fresnel halo round the duck by day.
        bsdf.inputs["Specular Tint"].default_value = (1.0, 1.0, 1.0, 1.0)


def _stream_deck(L, m, eye):
    """A 15-key LCD macro pad left of the keyboard, propped on its wedge stand
    and turned a little toward the seat: raised keys with even 7 mm bezels round them. The
    runtime draws the key icons on `rt_deckKeys`, one face per key top."""
    p = Vector(L["decorZones"]["streamDeck"])
    y = Vector((0, 1, 0))
    tilt = 42  # from vertical: the face leans back ~48° from the desk (flatter read as a tablet from the seat)
    # Turned only ~8° toward the seat, near square to the keyboard (turned
    # full to the eye it looked tossed aside).
    aim = Vector((p.x + 0.06, eye[1], eye[2]))
    right, up, normal = facing(p, aim, tilt)
    to_eye = aim - p
    to_eye.y = 0
    to_eye.normalize()
    pitch, key, cap = 0.0205, 0.0152, 0.0035
    w, h, t = 5 * pitch + 0.015, 3 * pitch + 0.015, 0.02
    t_sin = math.sin(math.radians(tilt))
    # The bottom-front edge rests on the mat; everything else follows the tilt.
    c = p + up * (h / 2) - normal * (t / 2) + y * (t * t_sin + 0.0005)
    prism("deck_body", rounded_rect(w, h, 0.008), t, frame_matrix(c, right, up, normal), [m["soft_touch"]], edge=0.0025)
    # Wedge stand under the back.
    back_bottom = t * math.cos(math.radians(tilt))  # the body's back edge, behind its front edge
    top_back = up * (h - 0.01) - normal * t
    run = -top_back.dot(to_eye)
    wedge = [(back_bottom + 0.004, 0.0), (run, 0.0), (run - 0.004, top_back.y + t * t_sin)]
    back = -to_eye
    prism("deck_stand", wedge, w - 0.02, frame_matrix(p, back, y, back.cross(y)), [m["soft_touch"]], edge=0.0015)
    face = c + normal * (t / 2)
    # Keys stand `cap` proud of the face with 5 mm gaps; each LCD face maps
    # its own cell of the runtime's 5 × 3 canvas.
    lcd = key - 0.0016
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new("UVMap")
    for row in range(3):
        for col in range(5):
            at = face + right * ((col - 2) * pitch) + up * ((1 - row) * pitch)
            prism(f"deck_key_{row}_{col}", rounded_rect(key, key, 0.0022), cap,
                  frame_matrix(at + normal * (cap / 2 - 0.0005), right, up, normal), [m["glass_black"]], edge=0.0006, edge_segments=2)
            top = at + normal * (cap - 0.0003)
            corners = [top + right * (sx * lcd / 2) + up * (sy * lcd / 2) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
            quad_face = bm.faces.new([bm.verts.new(B(q)) for q in corners])
            u0, v0 = (col + 0.5) / 5, 1 - (row + 0.5) / 3
            du, dv = lcd / pitch / 10, lcd / pitch / 6
            for loop, (su, sv) in zip(quad_face.loops, ((-1, -1), (1, -1), (1, 1), (-1, 1))):
                loop[uv_layer].uv = (u0 + su * du, v0 + sv * dv)
    mesh_from_bmesh("rt_deckKeys", bm, m["deck_glow"])
    return p - to_eye * (run + 0.004) + y * 0.002


def _mug(L, m, eye):
    """An Ember-style smart mug on its charging coaster right of the mouse:
    black satin ceramic coating over a battery base band with a small white
    status LED facing the seat. Its curved walls turn faster than a lightmap texel,
    so the mug is `live_` (lit by the realtime lights). The runtime's steam
    rises off `coffee`."""
    top = L["desk"]["topY"]
    zone = Vector(L["decorZones"]["mug"])
    y = Vector((0, 1, 0))
    to_eye = Vector(eye) - zone
    to_eye.y = 0
    to_eye.normalize()
    right, heading, up = lying(-to_eye)
    coaster_t = 0.007
    prism("mug_coaster", circle(0.05, 64), coaster_t, frame_matrix(zone + y * (coaster_t / 2), right, heading, up),
          [m["soft_touch"]], edge=0.0022)
    # The coaster's USB-C port, at its back (away from the seat).
    box("mug_coasterPort", (0.009, 0.003, 0.004), tuple(zone - to_eye * 0.0495 + y * (coaster_t / 2)), m["plastic"],
        rotation=Matrix.Rotation(-math.atan2(to_eye.x, to_eye.z), 4, "Y").to_euler())
    r, height, band = 0.039, 0.092, 0.013
    floor = top + coaster_t
    cylinder("live_mugBase", r, band, (zone.x, floor + band / 2, zone.z), m["ceramic"], vertices=64, bevel=0.0012)
    body_h = height - band - 0.0006
    mug_bm = bmesh.new()
    bmesh.ops.create_cone(mug_bm, cap_ends=True, segments=64, radius1=r, radius2=r, depth=body_h)
    top_cap = max(mug_bm.faces, key=lambda f: f.calc_center_median().z)
    bmesh.ops.delete(mug_bm, geom=[top_cap], context="FACES_ONLY")
    smooth_by_angle(mug_bm)
    mug = mesh_from_bmesh("live_mug", mug_bm, m["ceramic"])
    for mat in (m["mug_inner"], m["mug_steel"]):
        mug.data.materials.append(mat)
    solid = mug.modifiers.new("shell", "SOLIDIFY")
    solid.thickness = 0.0045
    solid.material_offset, solid.material_offset_rim = 1, 2  # interior coating, steel lip
    rim = mug.modifiers.new("rim", "BEVEL")
    rim.width, rim.segments, rim.limit_method = 0.0016, 3, "ANGLE"
    mug.location = B((zone.x, floor + height - body_h / 2, zone.z))
    # D handle on the side away from the mouse, turned 35° back so it stays
    # in frame from the seat: a smooth swept tube (a skinned polyline showed
    # its facets).
    side = to_eye.cross(y).normalized() * -1
    out = side * math.cos(math.radians(35)) - to_eye * math.sin(math.radians(35))
    path = [(0.037, 0.071), (0.05, 0.0705), (0.0615, 0.065), (0.0655, 0.048), (0.0615, 0.031), (0.05, 0.0255), (0.037, 0.025)]
    tube("live_mugHandle", [tuple(zone + out * a + y * (floor - top + b)) for a, b in path], 0.0048, m["ceramic"], resolution=16)
    # Status light: a 6 × 2 mm pill on the base band, facing the seat.
    arc = bmesh.new()
    facing_angle = math.atan2(to_eye.z, to_eye.x)
    rows = []
    for dy in (-0.001, 0.001):
        ring = []
        for i in range(17):
            a = facing_angle + math.radians(-4.3 + 8.6 * i / 16)
            ring.append(arc.verts.new(B(zone + Vector((math.cos(a) * (r + 0.0003), coaster_t + band / 2 + dy, math.sin(a) * (r + 0.0003))))))
        rows.append(ring)
    for i in range(16):
        arc.faces.new((rows[0][i + 1], rows[0][i], rows[1][i], rows[1][i + 1]))
    mesh_from_bmesh("emit_mugLed", arc, m["mug_led"])
    cylinder("coffee", r - 0.004, 0.002, (zone.x, floor + height - 0.016, zone.z), m["coffee"])
    return zone - to_eye * 0.052 + y * 0.0035


def acoustic_mesh(name, cells=8, size=512, base=(0.62, 0.62, 0.61)):
    """A HomePod-style 3D-knit acoustic fabric, `cells` diamond loops across
    the tile: {"albedo", "orm", "normal"} like prepared_set. The loops'
    grooves are a little darker and occluded, so the weave still reads as a
    matte texture once mipmapping has flattened its relief."""
    t = np.linspace(0, cells * 2 * np.pi, size, endpoint=False)
    u, v = np.meshgrid(t, t)
    # Two crossing ridge sets make diamonds; a third, finer one, the yarn.
    loops = np.abs(np.sin((u + v) / 2)) * np.abs(np.sin((u - v) / 2))
    height = loops ** 0.6 + 0.12 * np.abs(np.sin(3 * u)) * loops
    gy, gx = np.gradient(height)
    strength = size / cells * 0.06
    n = np.stack([-gx * strength, -gy * strength, np.ones_like(height)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    ones = np.ones_like(height)[..., None]
    shade = (0.8 + 0.2 * height)[..., None]
    paths = {
        "albedo": _save(f"{name}_albedo", np.concatenate([np.array(base) * shade, ones], -1), False),
        "orm": _save(f"{name}_orm", np.stack([0.75 + 0.25 * height, np.full_like(height, 0.9), np.zeros_like(height), ones[..., 0]], -1), True),
        "normal": _save(f"{name}_normal", np.concatenate([n * 0.5 + 0.5, ones], -1), True),
    }
    return paths


def _speaker(L, m):
    """A HomePod-mini-style speaker right of the monitor (97.9 mm across,
    84.3 mm tall): a body covered in knit acoustic fabric on a flat, inset
    rubber foot, and a wide flat top under dark glass, where a soft gradient
    glows while it plays. Curved like the mug, so the body is `live_`."""
    p = Vector(L["decorZones"]["smartSpeaker"])
    radius, height, foot = 0.049, 0.0843, 0.0025
    # A spheroid a little taller than the sphere, cut top and bottom: a wider
    # top than a cut sphere (which read as a ball), with its shoulders (a
    # taller one's steep sides read taller than wide from the seat). Cut
    # low, for a 76 mm base on its foot: on a small one it read as a ball
    # resting on a point.
    semi, below = 0.0566, 0.0384 - foot
    above = height - foot - below
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=64, v_segments=40, radius=radius)
    bmesh.ops.scale(bm, vec=(1, 1, semi / radius), verts=bm.verts)
    for sign, at in ((1, above), (-1, below)):
        cut = bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, 0, sign * at),
                                     plane_no=(0, 0, sign), clear_outer=True)
        rim = [e for e in cut["geom_cut"] if isinstance(e, bmesh.types.BMEdge)]
        bmesh.ops.edgeloop_fill(bm, edges=rim)
    bmesh.ops.bevel(bm, geom=[e for e in bm.edges if e.calc_face_angle(0.0) > 0.5], offset=0.004, segments=3,
                    affect="EDGES", profile=0.5, clamp_overlap=True)
    smooth_by_angle(bm, 30)
    body = mesh_from_bmesh("live_speaker", bm, m["speaker_mesh"])
    body.location = B(p + Vector((0, foot + below, 0)))
    bpy.context.view_layer.update()
    # ~1 mm knit loops (8 to the 8 mm tile).
    project_uv(body, 0.008)
    base_r = radius * math.sqrt(1 - (below / semi) ** 2)
    # The foot: dark rubber, inset 3 mm under the fabric's lower edge.
    cylinder("speaker_foot", base_r - 0.003, foot, (p.x, p.y + foot / 2, p.z), m["soft_touch"], vertices=64, bevel=0.0006)
    top_r = radius * math.sqrt(1 - (above / semi) ** 2) - 0.004
    flat = frame_matrix(p + Vector((0, height + 0.0004, 0)), (1, 0, 0), (0, 0, -1), (0, 1, 0))
    prism("speaker_top", circle(top_r, 64), 0.0008, flat, [m["glass_black"]], edge=0.0003)
    glow_r = top_r * 0.8
    glow = prism("emit_speakerGlow", circle(glow_r, 64), 0.0004,
                 frame_matrix(p + Vector((0, height + 0.0009, 0)), (1, 0, 0), (0, 0, -1), (0, 1, 0)), [m["speaker_glow"]])
    project_uv(glow, 2 * glow_r, (0.5 - p.x / (2 * glow_r), 0.5 + p.z / (2 * glow_r)))
    # A top indicator lights nothing round it (in the bake it threw a magenta pool on the desk).
    glow.visible_diffuse = False
    glow.visible_glossy = False
    # The glow: violet-pink at the centre, blue further out, gone by the rim.
    size = 128
    yy, xx = np.mgrid[0:size, 0:size]
    d = np.hypot(xx - (size - 1) / 2, yy - (size - 1) / 2) / (size / 2)
    fall = np.clip(1 - d / 0.95, 0, 1) ** 1.6
    mix = np.clip(d / 0.7, 0, 1)[..., None]
    rgb = (np.array([1.0, 0.45, 0.85]) * (1 - mix) + np.array([0.45, 0.55, 1.0]) * mix) * fall[..., None]
    path = _save("speaker_glow", np.concatenate([rgb, np.ones_like(fall)[..., None]], -1), False)
    nt = m["speaker_glow"].node_tree
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = _load(path)
    nt.links.new(tex.outputs["Color"], nt.nodes["Principled BSDF"].inputs["Emission Color"])
    # The cable leaves from under the foot's rear edge.
    return p - Vector((0, 0, base_r - 0.006))


def _laptop(L, m):
    """A closed laptop standing in a vertical dock at the far left of the desk."""
    p = Vector(L["decorZones"]["laptopDock"])
    y = Vector((0, 1, 0))
    normal = Vector((1, 0, 0))
    right = y.cross(normal)
    dock_t = 0.014
    prism("laptop_dock", rounded_rect(0.06, 0.22, 0.02), dock_t, frame_matrix(p + y * (dock_t / 2), *lying((0, 0, -1))),
          [m["alu_silver"]], edge=0.004)
    w, h = 0.304, 0.215
    c = p + y * (h / 2 + dock_t - 0.008)
    for name, t, off in (("laptop_base", 0.0085, -0.0043), ("laptop_lid", 0.0062, 0.0035)):
        prism(name, rounded_rect(w, h, 0.012), t, frame_matrix(c + normal * off, right, y, normal), [m["alu_satin"]],
              edge=0.0022)
    # A developer's laptop: vinyl stickers on the lid, kiss-cut with a thin
    # off-white border (a wider, whiter one glowed as a halo). Flat decals a
    # fraction of a millimetre off the lid (extruded, their sides read as
    # magnets' rims).
    lid = c + normal * 0.0066

    def decal(name, outline, at, mat):
        bm = bmesh.new()
        bm.faces.new([bm.verts.new((px, py, 0.0)) for px, py in outline])
        obj = mesh_from_bmesh(name, bm, mat)
        obj.matrix_world = frame_matrix(at, right, y, normal)

    stickers = [
        (circle(0.03, 6, 90), (-0.06, 0.04), "sticker_teal"), (circle(0.024, 48), (0.05, 0.05), "sticker_orange"),
        (rounded_rect(0.07, 0.03, 0.006), (0.03, -0.045), "sticker_black"), (circle(0.022, 6, 90), (-0.085, -0.035), "sticker_purple"),
        (rounded_rect(0.034, 0.034, 0.005), (0.1, -0.01), "sticker_white")]
    for i, (outline, (u, v), mat) in enumerate(stickers):
        at = lid + right * u + y * v
        size = max(math.hypot(px, py) for px, py in outline)
        border = [(px * (1 + 0.0015 / size), py * (1 + 0.0015 / size)) for px, py in outline]
        decal(f"laptop_sticker_{i}", border, at + normal * 0.0003, m["sticker_white"])
        if mat != "sticker_white":
            decal(f"laptop_sticker_{i}_print", outline, at + normal * 0.0005, m[mat])
    # A terminal prompt, ">_", on the black sticker.
    chevron = [(-0.0035, -0.006), (0.0045, 0.0), (-0.0035, 0.006), (-0.0035, 0.0032), (0.0008, 0.0), (-0.0035, -0.0032)]
    for j, (outline, du, dv) in enumerate([(chevron, -0.018, 0.0), (rounded_rect(0.011, 0.0026, 0.0012), -0.004, -0.0045)]):
        decal(f"laptop_sticker_prompt_{j}", outline, lid + right * (0.03 + du) + y * (-0.045 + dv) + normal * 0.0007, m["sticker_green"])
    return c + right * (w / 2) - y * (h / 2 - 0.012)


def _hex_panels(m, radius=0.07, gap=0.004):
    """Four small hexagonal light panels (14 cm point to point, Govee
    Glide Hexa size) in a tight cluster on the wall right of the monitor,
    every one whole in the seated frame above the speaker: from the seat
    the wall there is a strip ~27 cm wide between the screen and the
    frame's edge, where 23 cm Nanoleaf tiles fit one at a time (the rest
    cut by the frame or tucked behind the screen). Each glows teal to pink,
    bright at the centre and falling off to the edge, and washes the wall
    round it at night (its baked `hex_lights`); by day they are off, milky
    grey. The diffuser wraps the tile's edges too (grey frames drew black
    outlines at night and caught the sun as bright rims by day). A
    controller on the lowest-left tile's edge, just clear of the screen,
    has its lead straight down the wall there. The tiles are baked like the
    wall under them: unbaked, the eye-centred panorama lit them (facing the
    day fill behind the seat) several times brighter than the wall. Returns
    each tile's centre and colour."""
    zw = -0.85 + 0.006
    dx = math.sqrt(3) * radius + gap
    dy = 1.5 * radius + gap * 0.87
    # Two abreast above the speaker, one above between them and one more
    # above that at the left: (from tile, step) per tile after the first.
    # Clear of the screen's right edge from the seat (3.5 cm further left,
    # the lowest-left tile was cut by the bezel).
    c = Vector((0.619, 0.853, zw))
    up_right, up_left, right = Vector((dx / 2, dy, 0)), Vector((-dx / 2, dy, 0)), Vector((dx, 0, 0))
    centres = [c]
    for base, step in ((0, right), (0, up_right), (2, up_left)):
        centres.append(centres[base] + step)
    colours = HEX_COLOURS
    # The diffuser: full at the centre, falling to ~55% at the edge.
    size = 128
    yy, xx = np.mgrid[0:size, 0:size]
    d = np.hypot(xx - (size - 1) / 2, yy - (size - 1) / 2) / (size / 2)
    fall = (1 - 0.45 * np.clip(d, 0, 1) ** 1.5)[..., None]
    tiles = []
    for i, (centre, mat, colour) in enumerate(zip(centres, m["hex"], colours)):
        path = _save(f"hex_glow_{i}", np.concatenate([np.array(colour) * fall, np.ones_like(fall)], -1), False)
        nt = mat.node_tree
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = _load(path)
        bsdf = nt.nodes["Principled BSDF"]
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
        # The texture carries the colour; room.json's emitter colour multiplies it.
        bsdf.inputs["Emission Color"].default_value = (1, 1, 1, 1)
        tile = prism(f"hex_panel{i}", circle(radius, 6, 90), 0.01, frame_matrix(centre, (1, 0, 0), (0, 1, 0), (0, 0, 1)),
                     [mat], edge=0.0025)
        project_uv(tile, 2 * radius, (0.5 - centre.x / (2 * radius), 0.5 - centre.y / (2 * radius)))
        # The glow behind a tile lights the wall round it; the tile must not block it.
        tile.visible_shadow = False
        tiles.append((centre, colour))
    # Controller on the lowest-left tile's left edge, just clear of the screen from the seat.
    edge = c + Vector((-radius * math.sqrt(3) / 2 - 0.007, -radius * 0.25, 0.008))
    # Matte dark grey: a white one lit by the panels read as a glowing block.
    box("hex_controller", (0.014, 0.036, 0.016), tuple(edge), m["soft_touch"], bevel=0.003)
    # Its lead drops straight down the wall behind the desk (a curl out to
    # the side read as a loose loop).
    tube("hex_lead", [tuple(edge + Vector((0, -0.017, -0.004))), (edge.x, edge.y - 0.04, zw + 0.004), (edge.x, 0.6, zw + 0.004)],
         0.0018, m["braided"])
    return tiles


def _props(L, m):
    """Everything on the desk but the monitor and its light bar; returns where each device's cable leaves it."""
    eye = L["camera"]["eye"]
    # Plant on the window sill, silhouetted against the city.
    place(import_model("potted_plant_04"), (-1.08, WINDOW["y0"], -0.93), 25)
    _duck(L, eye)
    m["hex_tiles"] = _hex_panels(m)
    return {"deck": _stream_deck(L, m, eye), "phone": _phone(L, m, eye), "clock": _clock(L, m, eye), "laptop": _laptop(L, m), "speaker": _speaker(L, m),
            "mug": _mug(L, m, eye)}


def _cables(L, m, ends):
    """USB-C cables from the devices (the monitor's runs along its arm, see
    _monitor), each one short, deliberate run with a gentle bend, none
    across open desk from the seat: the clock's, the laptop dock's and the
    phone stand's straight back into a slim raceway along the desk's back
    edge that ends in the grommet behind the monitor's left side; the macro
    pad's straight back from its port, under the monitor, to the same
    grommet; the mug coaster's straight back into the monitor arm's mount;
    the speaker's (white) straight back over the desk's back edge. (Dropped
    into small grommets each device hid from the seat, they vanished from
    close up too, and the devices read as unpowered props.) The keyboard is
    wireless."""
    top = L["desk"]["topY"]
    back = L["desk"]["zBack"]
    r = 0.0019
    grommet = Vector((-0.24, top, back + 0.06))
    prism("cable_grommet", circle(0.03, 48), 0.003, frame_matrix(grommet + Vector((0, 0.0015, 0)), (1, 0, 0), (0, 0, -1), (0, 1, 0)),
          [m["arm_black"]], edge=0.001)
    # The raceway: a low graphite channel along the back edge, from the
    # desk's left end to the grommet (loose runs there read as clutter).
    race_z, race_h = back + 0.035, 0.009
    x0, x1 = L["desk"]["xMin"] + 0.01, grommet.x - 0.028
    box("cable_raceway", (x1 - x0, race_h, 0.018), ((x0 + x1) / 2, top + race_h / 2, race_z), m["graphite"], bevel=0.002)
    for name in ("clock", "laptop", "phone"):
        start = ends[name]
        tube(f"cable_{name}", [tuple(start), (start.x, top + r, start.z - 0.014), (start.x, top + r, race_z + 0.016),
                               (start.x, top + race_h - 0.001, race_z)], r, m["braided"])
    # The mug's, into the arm's mount (the monitor's lead drops through it).
    start = ends["mug"]
    px, pz = ARM_POLE
    tube("cable_mug", [tuple(start), (start.x, top + r, start.z - 0.014), (start.x + (px - start.x) * 0.6, top + r, pz + 0.07),
                       (px, top + 0.0045, pz + 0.036), (px, top + 0.004, pz + 0.02)], r, m["braided"])
    # The speaker's, over the LED channel and the desk's back edge, and down.
    start = ends["speaker"]
    tube("cable_speaker", [tuple(start), (start.x, top + r, start.z - 0.014), (start.x, top + r, back + 0.03),
                           (start.x, top + 0.0065, back + 0.01), (start.x, top - 0.006, back - 0.012), (start.x, top - 0.2, back - 0.02)],
         r, m["cable_white"])
    # The macro pad's: a deliberate lead straight back from its port across
    # the mat and under the monitor to the grommet.
    start = ends["deck"]
    mat_top = top + L["deskMat"]["thickness"]
    mat_back = L["deskMat"]["center"][2] - L["deskMat"]["size"][1] / 2
    tube("cable_deck", [tuple(start), (start.x, mat_top + r, start.z - 0.015), (start.x, mat_top + r, mat_back + 0.006),
                        (start.x - 0.002, top + r, mat_back - 0.012), (grommet.x + 0.012, top + r, grommet.z + 0.04),
                        (grommet.x + 0.01, top - 0.004, grommet.z + 0.012), (grommet.x + 0.01, top - 0.15, grommet.z + 0.012)],
         r, m["braided"])


STREET_Z = -24.0  # facade of the building across the street (glTF z)


def _street(m, seed=7):
    """The apartment block across the street: a concrete facade with a grid
    of windows, some lit (warm lamps, the blue of a TV), seen through the
    rain at night and reflecting the sky by day."""
    import random
    rng = random.Random(seed)
    facade = prepared_set("facade", "concrete_wall_008", tint=(0.62, 0.6, 0.58), saturation=0.6, rough=(0.75, 0.95))
    # Four storeys above ours: low enough that the afternoon sun clears it.
    box("street_facade", (70.0, 34.0, 0.5), (-5.0, -5.0, STREET_Z - 0.25), material("street_concrete", textures=facade), tile=3.5)
    glass_day = material("street_window", color=(0.02, 0.022, 0.025), roughness=0.08, metallic=0.0)
    lit = [
        ("street_lit_warm", (1.0, 0.55, 0.25), 0.16),
        ("street_lit_soft", (1.0, 0.7, 0.42), 0.08),
        ("street_lit_cool", (0.8, 0.82, 0.9), 0.05),
        ("street_lit_tv", (0.35, 0.45, 1.0), 0.03),
    ]
    mats = [glass_day] + [material(name, color=(0.02, 0.02, 0.022), roughness=0.1, emission=c, emission_strength=0.0) for name, c, _ in lit]
    m["street_lit"] = {mat.name: strength for (name, _, strength), mat in zip(lit, mats[1:])}
    m["street_lit_mats"] = mats[1:]
    bm = bmesh.new()
    faces = []
    for floor in range(-6, 4):
        y = floor * 3.1 + 0.9
        for col in range(-12, 8):
            x = col * 2.9 + rng.uniform(-0.02, 0.02)
            w, hgt = 1.5, 1.7
            verts = [bm.verts.new(B((x + dx, y + dy, STREET_Z + 0.03))) for dx, dy in ((0, 0), (w, 0), (w, hgt), (0, hgt))]
            face = bm.faces.new(verts)
            roll = rng.random()
            face.material_index = 0 if roll < 0.6 else 1 + min(3, int((roll - 0.6) / 0.4 * 4))
            faces.append(face)
    obj = mesh_from_bmesh("street_windows", bm)
    for mat in mats:
        obj.data.materials.append(mat)
    # Window sills catching a little light.
    for floor in range(-6, 4):
        box(f"street_ledge_{floor}", (60.0, 0.12, 0.25), (-5.0, floor * 3.1 + 0.85, STREET_Z + 0.12), m["paint"])


def build(L):
    m = _mats()
    _shell(L, m)
    glass = _window(m)
    _desk(L, m)
    screen, screen_normal, bias, bias_axis = _monitor(L, m)
    _pc(L, m)
    bulb, axis, half_angle, halo, halo_axis = _light_bar(L, m)
    ends = _props(L, m)
    _cables(L, m, ends)
    _street(m)
    # Bake-only occluders standing in for the runtime keyboard and mouse.
    kb = L["keyboard"]
    kbp = box("proxy_keyboard", (kb["footprint"][0], 0.03, kb["footprint"][1]), (kb["center"][0], kb["center"][1] + 0.016, kb["center"][2]), m["plastic"], bevel=0.004)
    ms = L["mouse"]
    msp = box("proxy_mouse", (ms["footprint"][0], 0.04, ms["footprint"][1]), (ms["restCenter"][0], ms["restCenter"][1] + 0.02, ms["restCenter"][2]), m["plastic"], bevel=0.015)
    for proxy in (kbp, msp):
        proxy.visible_camera = False
        proxy.visible_glossy = False
    # LED strip along the desk's back edge, washing the wall.
    d = L["desk"]
    strip_len = d["xMax"] - d["xMin"] - 0.1
    strip = box("emit_ledStrip", (strip_len, 0.003, 0.008), (0, d["topY"] + 0.0035, d["zBack"] + 0.01), m["led"])
    box("led_channel", (strip_len, 0.004, 0.012), (0, d["topY"] + 0.002, d["zBack"] + 0.01), m["alu"], bevel=0.0008)
    # End caps on the aluminium channel: the bare ends faced the seat and bloomed.
    for sx in (-1, 1):
        box(f"led_cap_{sx}", (0.012, 0.007, 0.011), (sx * (strip_len / 2 + 0.002), d["topY"] + 0.0035, d["zBack"] + 0.01), m["arm_black"], bevel=0.001)
    return {"materials": m, "hex_tiles": m["hex_tiles"], "screen": screen, "screen_normal": screen_normal, "glass": glass,
            "lamp_bulb": bulb, "lamp_axis": axis, "lamp_half_angle": half_angle, "halo": halo, "halo_axis": halo_axis, "led": strip,
            "bias": B(bias), "bias_axis": B(bias_axis)}
