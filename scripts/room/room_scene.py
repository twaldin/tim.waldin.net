"""The late-night developer's room, built in Blender from layout.json.

Coordinates in this file are glTF/three.js metres (+Y up, the seated viewer
faces -Z, +X to the viewer's right) and converted with B(). Materials are
plain Principled BSDFs fed by prepared image files so the glTF export and
the three.js runtime see exactly what Cycles renders.

Object naming (read by the runtime):
  rt_*    realtime objects the runtime replaces or animates
  emit_*  light-emitting surfaces whose strength changes between night/day
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

LAMP_BULB_MODEL = Vector((-0.002, 0.175, 0.691))  # bulb centre in desk_lamp_arm_01 space
WINDOW = {"x0": -1.32, "x1": -0.46, "y0": 0.88, "y1": 2.1, "depth": 0.16}
BLINDS_BOTTOM = 1.55


def _mats():
    wall = prepared_set("wall", "white_plaster_02", tint=(0.86, 0.80, 0.72), saturation=0.7, rough=(0.8, 0.95))
    return {
        "wall": material("wall_plaster", textures=wall, normal_strength=0.6),
        "ceiling": material("ceiling_plaster", textures=prepared_set("ceiling", "white_plaster_02", tint=(0.92, 0.9, 0.86), rough=(0.85, 0.95)), normal_strength=0.4),
        "floor": material("floor_oak", textures=prepared_set("floor", "wood_floor", tint=(0.75, 0.68, 0.6), rough=(0.35, 0.6))),
        "desk": material("desk_walnut", textures=prepared_set("desk", "black_walnut_veneer_01", tint=(0.95, 0.88, 0.82), saturation=0.85, rough=(0.3, 0.46)), normal_strength=0.5),
        "mat": material("desk_mat_felt", textures=prepared_set("deskmat2", "caban", tint=(0.34, 0.34, 0.35), saturation=0.25, rough=(0.85, 1.0)), normal_strength=0.8, sheen=0.4),
        "steel": material("steel_black", color=(0.018, 0.018, 0.02), roughness=0.42),
        "paint": material("paint_white", color=(0.78, 0.77, 0.74), roughness=0.4),
        "blind": material("blind_slat", color=(0.7, 0.7, 0.69), roughness=0.35, metallic=0.2),
        "plastic": material("plastic_black", color=(0.016, 0.016, 0.018), roughness=0.55),
        "screen": material("rt_screen", color=(0.004, 0.004, 0.005), roughness=0.12, emission=(1, 1, 1), emission_strength=0.0),
        "alu": material("alu_dark", color=(0.12, 0.12, 0.13), roughness=0.3, metallic=1.0),
        # Satin stoneware: a glossier glaze mirrors the (eye-centred) room
        # panorama and reads as chrome.
        "ceramic": material("mug_ceramic", color=(0.62, 0.6, 0.55), roughness=0.42),
        "coffee": material("coffee", color=(0.02, 0.01, 0.006), roughness=0.04),
        "rubber": material("cable_rubber", color=(0.01, 0.01, 0.011), roughness=0.6),
        "led": material("emit_ledStrip", color=(0.1, 0.1, 0.1), roughness=0.5, emission=(0.46, 0.4, 1.0), emission_strength=0.0),
        "bulb": material("emit_lampBulb", color=(0.9, 0.85, 0.75), roughness=0.3, emission=(1.0, 0.72, 0.42), emission_strength=0.0),
        "pcglass": material("pc_glass", color=(0.02, 0.02, 0.025), roughness=0.05, transmission=1.0, ior=1.5),
        "pcboard": material("pc_board", color=(0.02, 0.022, 0.024), roughness=0.6),
        "fan": material("emit_pcFans", color=(0.05, 0.05, 0.05), roughness=0.4, emission=(0.5, 0.42, 1.0), emission_strength=0.0),
        "paper_y": material("note_yellow", color=(0.75, 0.66, 0.35), roughness=0.8),
        "paper_p": material("note_pink", color=(0.75, 0.45, 0.5), roughness=0.8),
        "paper_g": material("note_green", color=(0.5, 0.7, 0.55), roughness=0.8),
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
    box("wall_left", (t, h, zb - zf), (x0 - t / 2, h / 2, (zf + zb) / 2), m["wall"], tile=1.6)
    box("wall_right", (t, h, zb - zf), (x1 + t / 2, h / 2, (zf + zb) / 2), m["wall"], tile=1.6)
    box("wall_back", (x1 - x0, h, t), ((x0 + x1) / 2, h / 2, zb + t / 2), m["wall"], tile=1.6)
    # Front wall (behind the desk) with the window opening, as four pieces.
    d = w["depth"]
    zc = zf - d / 2
    box("wall_front_l", (w["x0"] - x0, h, d), ((x0 + w["x0"]) / 2, h / 2, zc), m["wall"], tile=1.6)
    box("wall_front_r", (x1 - w["x1"], h, d), ((w["x1"] + x1) / 2, h / 2, zc), m["wall"], tile=1.6)
    box("wall_front_b", (w["x1"] - w["x0"], w["y0"], d), ((w["x0"] + w["x1"]) / 2, w["y0"] / 2, zc), m["wall"], tile=1.6)
    box("wall_front_t", (w["x1"] - w["x0"], h - w["y1"], d), ((w["x0"] + w["x1"]) / 2, (h + w["y1"]) / 2, zc), m["wall"], tile=1.6)
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
             (mat["center"][0], d["topY"] + mat["thickness"] / 2, mat["center"][2]), m["mat"], bevel=0.0015, segments=2, tile=0.5)
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
    # Arm: clamp at the desk's back edge, pole, arm to the VESA plate.
    d = L["desk"]
    zc = d["zBack"] + 0.04
    box("monitor_clamp", (0.07, 0.03, 0.07), (0, d["topY"] + 0.015, zc), m["alu"], bevel=0.004)
    pole_top = 0.98
    cylinder("monitor_pole", 0.016, pole_top - d["topY"], (0, (pole_top + d["topY"]) / 2, zc), m["alu"], bevel=0.002)
    plate = at(0, -0.02, -0.055)
    arm_start = Vector((0, pole_top - 0.03, zc))
    arm_vec = plate - arm_start
    arm = cylinder("monitor_arm", 0.013, arm_vec.length, tuple((arm_start + plate) / 2), m["alu"], bevel=0.002)
    arm.rotation_euler = B(arm_vec).to_track_quat("Z", "Y").to_euler()
    cylinder("monitor_pole_cap", 0.02, 0.03, (0, pole_top - 0.02, zc), m["alu"], bevel=0.003)
    return screen, normal


def _pc(L, m, yaw_deg=28.0):
    """Glass-sided tower at the desk's back right, turned so its window
    faces the chair: front intake fans, GPU and tower cooler with soft RGB."""
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
    box("emit_pcGpuBar", (0.002, 0.008, 0.2), (cx - 0.046, y0 + sh * 0.42 + 0.012, cz + 0.03), m["fan"])
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


def _shade_opening(lamp, bulb, samples=4000):
    """Directions from the bulb that escape the shade: their mean is the
    light axis, their spread the cone half-angle."""
    bpy.context.view_layer.update()
    inv = lamp.matrix_world.inverted()
    origin = inv @ bulb
    escaped = []
    golden = math.pi * (3 - math.sqrt(5))
    for i in range(samples):
        y = 1 - 2 * (i + 0.5) / samples
        r = math.sqrt(1 - y * y)
        d = Vector((math.cos(golden * i) * r, math.sin(golden * i) * r, y))
        local = (inv.to_3x3() @ d).normalized()
        start = origin
        for _ in range(8):  # pass through the bulb's own glass
            hit, location, _normal, index = lamp.ray_cast(start + local * 1e-4, local, distance=0.3)
            if not hit or lamp.material_slots[lamp.data.polygons[index].material_index].material.name.endswith("_light"):
                if not hit:
                    escaped.append(d)
                    break
                start = location
                continue
            break
    axis = sum(escaped, Vector()).normalized()
    half = max(axis.angle(d) for d in escaped)
    print(f"LAMP escaped {len(escaped)}/{samples} axis {tuple(round(v, 3) for v in axis)} half-angle {math.degrees(half):.1f}")
    return axis, half


def _lamp(m, target=(-0.02, 0.74, -0.16), lit=((0.02, 0.8, -0.13), (-0.09, 0.81, -0.07), (0.1, 0.81, -0.07))):
    """Clamp the architect lamp to the desk's back or left edge, turned so
    its light pool lands on `target` (the keyboard) and nothing (the monitor)
    stands between the bulb and the `lit` points: the keyboard and hands.
    Among equally good spots, prefer the back of the desk."""
    objs = import_model("desk_lamp_arm_01")
    lamp = objs[0]
    scale = 0.86
    axis_model, half_angle = _shade_opening(lamp, LAMP_BULB_MODEL)
    goal = B(target)
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()

    def visible(bulb, point):
        to = B(point) - bulb
        hit, *_ = bpy.context.scene.ray_cast(depsgraph, bulb + to.normalized() * 0.06, to.normalized(), distance=to.length - 0.08)
        return not hit

    bases = [(-0.75 + 0.02 * i, -0.79) for i in range(15)] + [(-0.8, -0.72 + 0.04 * i) for i in range(12)]
    best = None
    for base_x, base_z in bases:
        base = B((base_x, 0.74, base_z))
        forward = 0.15 * (base_z + 0.79)
        for step in range(360):
            rot = Matrix.Rotation(math.radians(step), 3, "Z")
            bulb = base + rot @ (LAMP_BULB_MODEL * scale)
            axis = rot @ axis_model
            if axis.z >= -0.2:
                continue
            pool = bulb + axis * ((bulb.z - goal.z) / -axis.z)
            score = (pool - goal).length + forward
            if best is not None and score >= best[0]:
                continue
            if all(visible(bulb, p) for p in lit):
                best = (score, base_x, base_z, step, bulb, axis)
    score, base_x, base_z, yaw, bulb, axis = best
    print(f"LAMP base ({base_x:.2f}, {base_z:.2f}) yaw {yaw} score {score:.3f}")
    place(objs, (base_x, 0.74, base_z), yaw, scale, pivot=Vector((0, 0, 0)))
    lamp.name = "desk_lamp"
    for slot in lamp.material_slots:
        if slot.material.name.endswith("_light"):
            slot.material = m["bulb"]
        else:
            bsdf = slot.material.node_tree.nodes.get("Principled BSDF")
            for link_ in list(bsdf.inputs["Base Color"].links):
                slot.material.node_tree.links.remove(link_)
            bsdf.inputs["Base Color"].default_value = (0.03, 0.03, 0.032, 1)
    return bulb, axis, half_angle


def _props(L, m):
    d = L["desk"]
    top = d["topY"]
    # Plant on the window sill, silhouetted against the city.
    place(import_model("potted_plant_04"), (-1.08, WINDOW["y0"], -0.93), 25)
    # Books stacked flat at the back left, glasses on top.
    books = import_model("book_encyclopedia_set_01", keep=lambda n: n.endswith(("book03", "book07", "book11")))
    y = top
    for i, b in enumerate(books):
        mn, mx = bounds([b])
        b.matrix_world = Matrix.Translation(-(mn + mx) / 2) @ b.matrix_world
        # Lay the book on its side: its height (Blender Z) becomes depth.
        b.matrix_world = Matrix.Rotation(math.pi / 2, 4, "Y") @ b.matrix_world
        b.matrix_world = Matrix.Rotation(math.radians(8 - 11 * i), 4, "Z") @ b.matrix_world
        mn, mx = bounds([b])
        b.matrix_world = Matrix.Translation(B((-0.44 + 0.01 * i, y + (mx.z - mn.z) / 2, -0.56)) ) @ b.matrix_world
        y += mx.z - mn.z
        b.name = f"book_{i}"
    place(import_model("round_spectacles"), (-0.43, y + 0.022, -0.55), 150)
    # Notebook and pen left of the keyboard.
    place(import_model("binder_notebook", keep=lambda n: n.endswith("closed")), (-0.5, top, -0.22), -78)
    place(import_model("stationery_supplies", keep=lambda n: n.endswith("pen_fancy")), (-0.49, top + 0.021, -0.2), 30)
    # Pencil cup behind the mouse, duck keeping watch by the monitor.
    place(import_model("stationery_supplies", keep=lambda n: "pen_fancy" not in n and "eraser" not in n and "pen_red" not in n), (0.4, top, -0.62), 20)
    duck = import_model("rubber_duck_toy")
    place(duck, (0.33, top, -0.47), -40, scale=0.3)
    # Mug of coffee right of the mouse: an open, slightly flared cup with a 4 mm wall.
    mx_, mz = L["decorZones"]["mug"][0], L["decorZones"]["mug"][2]
    mug_bm = bmesh.new()
    bmesh.ops.create_cone(mug_bm, cap_ends=True, segments=64, radius1=0.04, radius2=0.042, depth=0.095)
    top_cap = max(mug_bm.faces, key=lambda f: f.calc_center_median().z)
    bmesh.ops.delete(mug_bm, geom=[top_cap], context="FACES_ONLY")
    smooth_by_angle(mug_bm)
    mug = mesh_from_bmesh("mug", mug_bm, m["ceramic"])
    solid = mug.modifiers.new("shell", "SOLIDIFY")
    solid.thickness = 0.004
    mug.location = B((mx_, top + 0.0475, mz))
    handle = bpy.data.objects.new("mug_handle", bpy.data.meshes.new("mug_handle"))
    handle_bm = bmesh.new()
    bmesh.ops.create_circle(handle_bm, radius=0.024, segments=40)
    handle_bm.to_mesh(handle.data)
    handle_bm.free()
    link(handle)
    handle.data.materials.append(m["ceramic"])
    handle.location = B((mx_ + 0.046, top + 0.05, mz))
    handle.rotation_euler = (math.pi / 2, 0, 0)
    # A ring swept with a round profile; the half inside the mug is hidden by its wall.
    handle.modifiers.new("round", "SKIN").use_smooth_shade = True
    for sv in handle.data.skin_vertices[0].data:
        sv.radius = (0.0045, 0.006)
    handle.modifiers.new("smooth", "SUBSURF").levels = 2
    cylinder("coffee", 0.037, 0.002, (mx_, top + 0.082, mz), m["coffee"])
    # Sticky notes on the wall right of the monitor.
    for i, (dx, dy, mat, rz) in enumerate([(0.36, 1.1, "paper_y", 4), (0.45, 1.06, "paper_p", -6), (0.4, 0.99, "paper_g", 3)]):
        box(f"sticky_{i}", (0.076, 0.076, 0.0015), (dx, dy, -0.849), m[mat], rotation=(math.pi / 2, math.radians(rz), 0))


def _cables(L, m):
    kb = L["keyboard"]["center"]
    top = L["desk"]["topY"]
    tube("cable_keyboard", [(kb[0] - 0.05, top + 0.012, kb[2] - 0.075), (kb[0] - 0.08, top + 0.004, -0.3),
                            (-0.02, top + 0.003, -0.55), (0.03, top + 0.003, -0.74)], 0.0022, m["rubber"])
    tube("cable_monitor", [(0.0, 0.93, -0.43), (0.02, 0.86, -0.62), (0.01, 0.8, -0.74), (0.02, top + 0.005, -0.79)], 0.003, m["rubber"])
    tube("cable_lamp", [(-0.6, top + 0.005, -0.78), (-0.5, top + 0.003, -0.79), (-0.3, top + 0.003, -0.795)], 0.0025, m["rubber"])


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
    screen, screen_normal = _monitor(L, m)
    _pc(L, m)
    bulb, axis, half_angle = _lamp(m)
    _props(L, m)
    _cables(L, m)
    _street(m)
    # Bake-only occluders standing in for the runtime keyboard and mouse.
    kb = L["keyboard"]
    kbp = box("proxy_keyboard", (kb["footprint"][0], 0.03, kb["footprint"][1]), (kb["center"][0], kb["center"][1] + 0.016, kb["center"][2]), m["plastic"], bevel=0.004)
    ms = L["mouse"]
    msp = box("proxy_mouse", (ms["footprint"][0], 0.036, ms["footprint"][1]), (ms["restCenter"][0], ms["restCenter"][1] + 0.018, ms["restCenter"][2]), m["plastic"], bevel=0.015)
    for proxy in (kbp, msp):
        proxy.visible_camera = False
        proxy.visible_glossy = False
    # LED strip along the desk's back edge, washing the wall.
    d = L["desk"]
    strip = box("emit_ledStrip", (d["xMax"] - d["xMin"] - 0.1, 0.004, 0.008), (0, d["topY"] + 0.002, d["zBack"] + 0.01), m["led"])
    return {"materials": m, "screen": screen, "screen_normal": screen_normal, "glass": glass,
            "lamp_bulb": bulb, "lamp_axis": axis, "lamp_half_angle": half_angle, "led": strip}
