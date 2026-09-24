"""Skin for the POV arms: anatomical fields, nail plates, a hand-weighted
UV layout, and baked albedo / roughness / normal textures.

Colour starts from the MakeHuman CC0 skin (low-frequency tone only: its
hands are ~400 px wide). Everything finer is procedural and computed per
texel from the rig: knuckle wrinkles in joint-relative coordinates, pores
and the polygonal micro-relief of skin from 3D cellular noise, dorsal
veins, fine arm hair, freckles, nail beds with lunulae.

Fields are baked from mesh attributes into float images (Cycles EMIT
bakes) and combined in numpy, which also differentiates the height map
into a tangent-space normal map.
"""
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Vector

FINGERS = ("thumb", "index", "middle", "ring", "pinky")
SKIN_UV = "SkinUV"
# Fair skin albedo (linear): sRGB ≈ (203, 163, 145).
SKIN_TONE = np.array([0.6, 0.37, 0.28], np.float32)


# --- anatomy -------------------------------------------------------------

def _smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def _dorsal(bone):
    """Back-of-hand direction of a bone (build_arms rolls local +Z palmward)."""
    return -(bone.matrix_local.to_3x3() @ Vector((0, 0, 1))).normalized()


def _vec(v):
    return np.array(v, np.float32)


def anatomy_fields(human, arm):
    """Per-vertex fields the texture bake reads, stored as float attributes."""
    mesh = human.data
    n = len(mesh.vertices)
    co = np.empty(n * 3, np.float32)
    mesh.vertices.foreach_get("co", co)
    co = co.reshape(n, 3)
    normal = np.empty(n * 3, np.float32)
    mesh.vertices.foreach_get("normal", normal)
    normal = normal.reshape(n, 3)
    names = {g.index: g.name for g in human.vertex_groups}
    weight = {name: np.zeros(n, np.float32) for name in names.values()}
    for v in mesh.vertices:
        for g in v.groups:
            weight[names[g.group]][v.index] = g.weight
    zero = np.zeros(n, np.float32)
    out = {k: zero.copy() for k in ("wr_d", "wr_lat", "wr_mask", "knuckle", "tip", "dorsal", "hand_u", "hand_v",
                                    "handness", "arm_u", "arm_v", "hairy", "nail_region", "nail_u")}
    bones = arm.data.bones
    for side in ("l", "r"):
        on_side = (co[:, 0] < 0) if side == "l" else (co[:, 0] >= 0)
        hand = bones[f"hand_{side}"]
        wrist = _vec(hand.head_local)
        forward = _vec((bones[f"middle_01_{side}"].head_local - hand.head_local).normalized())
        up = _vec(_dorsal(hand))
        up = up - forward * up.dot(forward)
        up /= np.linalg.norm(up)
        lateral = np.cross(forward, up)
        if (_vec(bones[f"thumb_01_{side}"].head_local) - wrist).dot(lateral) < 0:
            lateral = -lateral  # +hand_v toward the thumb on both hands
        rel = co - wrist
        handness = sum(weight.get(f"{f}_0{p}_{side}", zero) for f in FINGERS for p in (1, 2, 3)) + weight.get(f"hand_{side}", zero)
        out["handness"] = np.where(on_side, np.clip(handness, 0, 1), out["handness"])
        out["hand_u"] = np.where(on_side, rel @ forward, out["hand_u"])
        out["hand_v"] = np.where(on_side, rel @ lateral, out["hand_v"])
        # Forearm: distance from the elbow and arc length around the arm.
        elbow = _vec(bones[f"lowerarm_{side}"].head_local)
        fore = wrist - elbow
        fore /= np.linalg.norm(fore)
        f_up = np.array([0, 0, 1], np.float32) - fore * fore[2]
        f_up /= np.linalg.norm(f_up)
        f_side = np.cross(fore, f_up)
        r = co - elbow
        out["arm_u"] = np.where(on_side, r @ fore, out["arm_u"])
        out["arm_v"] = np.where(on_side, np.arctan2(r @ f_side, r @ f_up) * 0.028, out["arm_v"])
        forearm = np.clip(weight.get(f"lowerarm_{side}", zero), 0, 1)
        hand_dorsal = np.clip(normal @ up, -1, 1)
        arm_dorsal = normal @ f_up
        out["dorsal"] = np.where(on_side, np.where(handness > 0.5, hand_dorsal, arm_dorsal), out["dorsal"])
        out["hairy"] = np.where(on_side, forearm * (0.45 + 0.55 * _smoothstep(-0.3, 0.6, arm_dorsal))
                                + 0.3 * np.clip(weight.get(f"hand_{side}", zero), 0, 1) * _smoothstep(0.2, 0.8, hand_dorsal),
                                out["hairy"])

        for finger in FINGERS:
            chain = [bones[f"{finger}_0{p}_{side}"] for p in (1, 2, 3)]
            joints = [_vec(b.head_local) for b in chain] + [_vec(chain[2].tail_local)]
            lengths = [float(np.linalg.norm(joints[k + 1] - joints[k])) for k in range(3)]
            starts = [0.0, lengths[0], lengths[0] + lengths[1]]
            w_chain = sum(weight.get(b.name, zero) for b in chain)
            near_knuckle = np.linalg.norm(co - joints[0], axis=1)
            member = on_side & ((w_chain > 0.25) | ((weight.get(f"hand_{side}", zero) > 0.3) & (near_knuckle < 0.013)))
            if finger == "thumb":
                member &= w_chain > 0.25
            idx = np.nonzero(member)[0]
            if not len(idx):
                continue
            p = co[idx]
            best_d = np.full(len(idx), np.inf, np.float32)
            s = np.zeros(len(idx), np.float32)
            seg = np.zeros(len(idx), np.int32)
            for k in range(3):
                a, b = joints[k], joints[k + 1]
                t = ((p - a) @ (b - a)) / lengths[k] ** 2
                t = np.clip(t, -np.inf if k == 0 else 0.0, np.inf if k == 2 else 1.0)
                d = np.linalg.norm(p - (a + t[:, None] * (b - a)), axis=1)
                better = d < best_d
                best_d = np.where(better, d, best_d)
                s = np.where(better, starts[k] + t * lengths[k], s)
                seg = np.where(better, k, seg)
            axis = np.stack([(joints[k + 1] - joints[k]) / lengths[k] for k in range(3)])[seg]
            dors = np.stack([_vec(_dorsal(b)) for b in chain])[seg]
            dors = dors - axis * np.sum(dors * axis, 1, keepdims=True)
            dors /= np.linalg.norm(dors, axis=1, keepdims=True)
            side_axis = np.cross(axis, dors)
            center = np.stack(joints[:3])[seg] + axis * (s - np.array(starts, np.float32)[seg])[:, None]
            radial = p - center
            radius = np.linalg.norm(radial, axis=1) + 1e-6
            up_frac = np.sum(radial * dors, 1) / radius
            lat = np.sum(radial * side_axis, 1)
            # Knuckle wrinkles: nearest joint along the finger, back of the finger only.
            if finger == "thumb":
                joint_s, strength, sigma = [starts[1], starts[2]], [0.8, 1.0], [0.006, 0.0045]
            else:
                joint_s, strength, sigma = [0.0, starts[1], starts[2]], [0.55, 1.0, 0.75], [0.008, 0.006, 0.0042]
            offsets = np.stack([s - js for js in joint_s], 1)
            nearest = np.argmin(np.abs(offsets), 1)
            jd = offsets[np.arange(len(idx)), nearest]
            mask = (np.array(strength)[nearest] * np.exp(-(jd / np.array(sigma)[nearest]) ** 2)
                    * _smoothstep(-0.15, 0.55, up_frac))
            keep = mask > out["wr_mask"][idx]
            out["wr_mask"][idx] = np.where(keep, mask, out["wr_mask"][idx])
            out["wr_d"][idx] = np.where(keep, jd, out["wr_d"][idx])
            out["wr_lat"][idx] = np.where(keep, lat, out["wr_lat"][idx])
            knuckle = (np.exp(-(np.linalg.norm(p - joints[0], axis=1) / 0.009) ** 2)
                       + 0.7 * np.exp(-(np.linalg.norm(p - joints[1], axis=1) / 0.0075) ** 2)) * _smoothstep(0.0, 0.6, up_frac)
            out["knuckle"][idx] = np.maximum(out["knuckle"][idx], knuckle if finger != "thumb" else 0.6 * knuckle)
            out["tip"][idx] = np.maximum(out["tip"][idx], np.exp(-(np.linalg.norm(p - joints[3], axis=1) / 0.011) ** 2))
            out["dorsal"][idx] = up_frac
            # Nail: back of the distal phalanx, from the cuticle to the tip.
            t_distal = (s - starts[2]) / lengths[2]
            region = (seg == 2) & (t_distal > 0.4) & (t_distal < 0.98) & (up_frac > 0.55) & (w_chain[idx] > 0.5)
            out["nail_region"][idx] = np.where(region, 1.0, out["nail_region"][idx])
            out["nail_u"][idx] = np.where(seg == 2, np.clip((t_distal - 0.4) / 0.58, 0, 1), out["nail_u"][idx])
    for name, values in out.items():
        attr = mesh.attributes.get(name) or mesh.attributes.new(name, "FLOAT", "POINT")
        attr.data.foreach_set("value", values.astype(np.float32))


def raise_nails(human, depth=0.00028, smoothing=3):
    """Lift the nail plates a fraction of a millimetre off the finger: the
    nail region's mask is blurred over the mesh so the plate rises from its
    folds without a wall. Stores the blurred mask as `nail`."""
    mesh = human.data
    bm = bmesh.new()
    bm.from_mesh(mesh)
    region = bm.verts.layers.float["nail_region"]
    nail = bm.verts.layers.float.new("nail")
    bm.verts.ensure_lookup_table()
    mask = [v[region] for v in bm.verts]
    neighbours = [[e.other_vert(v).index for e in v.link_edges] for v in bm.verts]
    for _ in range(smoothing):
        mask = [0.5 * m + 0.5 * sum(mask[i] for i in ns) / len(ns) if ns else m for m, ns in zip(mask, neighbours)]
    for v, m in zip(bm.verts, mask):
        v[nail] = m
        v.co += v.normal * depth * m
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()


# --- UVs -------------------------------------------------------------------

def _uv_islands(bm, uv_layer):
    parent = list(range(len(bm.faces)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    bm.faces.ensure_lookup_table()
    for edge in bm.edges:
        if len(edge.link_faces) != 2:
            continue
        f0, f1 = edge.link_faces
        uv0 = {loop.vert: loop[uv_layer].uv for loop in f0.loops}
        uv1 = {loop.vert: loop[uv_layer].uv for loop in f1.loops}
        if all((uv0[v] - uv1[v]).length < 1e-6 for v in edge.verts):
            a, b = find(f0.index), find(f1.index)
            if a != b:
                parent[a] = b
    islands = {}
    for f in bm.faces:
        islands.setdefault(find(f.index), []).append(f)
    return list(islands.values())


def hand_weighted_uv(human, hand_scale=2.6, margin=0.004):
    """A second UV set from MakeHuman's, with the hand islands enlarged
    before packing so the hands get most of the texture."""
    mesh = human.data
    mesh.uv_layers.active = mesh.uv_layers[0]
    if SKIN_UV not in mesh.uv_layers:
        mesh.uv_layers.new(name=SKIN_UV)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    uv = bm.loops.layers.uv[SKIN_UV]
    handness = bm.verts.layers.float["handness"]
    for island in _uv_islands(bm, uv):
        loops = [loop for f in island for loop in f.loops]
        hand = sum(loop.vert[handness] for loop in loops) / len(loops)
        scale = hand_scale if hand > 0.5 else 1.0
        center = sum((loop[uv].uv for loop in loops), Vector((0, 0))) / len(loops)
        for loop in loops:
            loop[uv].uv = center + (loop[uv].uv - center) * scale
    bm.to_mesh(mesh)
    bm.free()
    mesh.uv_layers.active = mesh.uv_layers[SKIN_UV]
    bpy.ops.object.select_all(action="DESELECT")
    human.select_set(True)
    bpy.context.view_layer.objects.active = human
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.pack_islands(rotate=True, scale=True, margin_method="FRACTION", margin=margin, shape_method="CONCAVE")
    bpy.ops.object.mode_set(mode="OBJECT")


# --- procedural patterns (numpy) ------------------------------------------

def _hash(ix, iy, iz, seed):
    h = (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791) ^ (seed * 2654435761)
    h = (h ^ (h >> 13)) * 1274126177
    h ^= h >> 16
    return (h & 0xFFFFFF).astype(np.float32) / float(0xFFFFFF)


def voronoi(p, cell, seed=0):
    """F1, F2 (metres) and the nearest cell's random id for jittered-grid
    3D cellular noise with `cell`-sized cells."""
    q = p / cell
    base = np.floor(q).astype(np.int64)
    frac = (q - base).astype(np.float32)
    f1 = np.full(len(p), 9.0, np.float32)
    f2 = np.full(len(p), 9.0, np.float32)
    ident = np.zeros(len(p), np.float32)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                ix, iy, iz = base[:, 0] + dx, base[:, 1] + dy, base[:, 2] + dz
                jitter = np.stack([_hash(ix, iy, iz, seed + k) for k in range(3)], 1)
                d = np.linalg.norm(np.array([dx, dy, dz], np.float32) + jitter - frac, axis=1)
                closer = d < f1
                f2 = np.where(closer, f1, np.minimum(f2, d))
                ident = np.where(closer, _hash(ix, iy, iz, seed + 7), ident)
                f1 = np.where(closer, d, f1)
    return f1 * cell, f2 * cell, ident


def value_noise(p, cell, seed=0):
    """Smooth 3D value noise in [-1, 1]."""
    q = p / cell
    base = np.floor(q).astype(np.int64)
    f = q - base
    f = f * f * (3 - 2 * f)
    total = np.zeros(len(p), np.float32)
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = ((f[:, 0] if dx else 1 - f[:, 0]) * (f[:, 1] if dy else 1 - f[:, 1]) * (f[:, 2] if dz else 1 - f[:, 2]))
                total += w * _hash(base[:, 0] + dx, base[:, 1] + dy, base[:, 2] + dz, seed)
    return total * 2 - 1


# --- baking ----------------------------------------------------------------

def _emit_material(name):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    emit = nt.nodes.new("ShaderNodeEmission")
    nt.links.new(emit.outputs[0], out.inputs["Surface"])
    return mat, nt, emit


def _attr(nt, name, scale=1.0, offset=0.0):
    node = nt.nodes.new("ShaderNodeAttribute")
    node.attribute_type = "GEOMETRY"
    node.attribute_name = name
    if scale == 1.0 and offset == 0.0:
        return node.outputs["Fac"]
    math_node = nt.nodes.new("ShaderNodeMath")
    math_node.operation = "MULTIPLY_ADD"
    nt.links.new(node.outputs["Fac"], math_node.inputs[0])
    math_node.inputs[1].default_value = scale
    math_node.inputs[2].default_value = offset
    return math_node.outputs[0]


def _bake(human, material, size):
    image = bpy.data.images.new(f"bake_{material.name}", size, size, alpha=False, float_buffer=True)
    image.colorspace_settings.name = "Non-Color"
    nt = material.node_tree
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = image
    nt.nodes.active = tex
    human.data.materials.clear()
    human.data.materials.append(material)
    bpy.ops.object.select_all(action="DESELECT")
    human.select_set(True)
    bpy.context.view_layer.objects.active = human
    human.data.uv_layers.active = human.data.uv_layers[SKIN_UV]
    bake = bpy.context.scene.render.bake
    bake.margin = 16
    bake.margin_type = "EXTEND"
    bpy.ops.object.bake(type="EMIT", margin=16)
    pixels = np.empty(size * size * 4, np.float32)
    image.pixels.foreach_get(pixels)
    bpy.data.images.remove(image)
    bpy.data.materials.remove(material)
    return pixels.reshape(size, size, 4)[..., :3]


def _bake_fields(human, packs, size):
    """EMIT-bake each (r, g, b) triple of attribute sockets into a float image."""
    baked = []
    for i, channels in enumerate(packs):
        mat, nt, emit = _emit_material(f"field_{i}")
        combine = nt.nodes.new("ShaderNodeCombineXYZ")
        for axis, maker in zip("XYZ", channels):
            if maker is not None:
                nt.links.new(maker(nt), combine.inputs[axis])
        nt.links.new(combine.outputs[0], emit.inputs["Color"])
        baked.append(_bake(human, mat, size))
    return baked


def _to_image(name, rgb, colorspace):
    h, w = rgb.shape[:2]
    image = bpy.data.images.new(name, w, h, alpha=False)
    image.colorspace_settings.name = colorspace
    rgba = np.concatenate([rgb, np.ones((h, w, 1), np.float32)], -1)
    image.pixels.foreach_set(rgba.astype(np.float32).ravel())
    image.pack()
    return image


def bake_skin(human, arm, mh_image, size=2048, cache=None):
    """Bake albedo, roughness and normal textures for the skin into SKIN_UV
    and give the mesh its final material. Returns the material."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 1
    mh_uv = human.data.uv_layers[0].name

    def object_coords(nt):
        return nt.nodes.new("ShaderNodeTexCoord").outputs["Object"]

    def mh_color(nt):
        uvmap = nt.nodes.new("ShaderNodeUVMap")
        uvmap.uv_map = mh_uv
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = mh_image
        nt.links.new(uvmap.outputs["UV"], tex.inputs["Vector"])
        return tex.outputs["Color"]

    def field(name, scale=1.0, offset=0.0):
        return lambda nt: _attr(nt, name, scale, offset)

    # Positions come through as one vector socket; everything else per channel.
    mat, nt, emit = _emit_material("field_p")
    add = nt.nodes.new("ShaderNodeVectorMath")
    add.operation = "ADD"
    nt.links.new(object_coords(nt), add.inputs[0])
    add.inputs[1].default_value = (1, 1, 1)
    nt.links.new(add.outputs[0], emit.inputs["Color"])
    position = _bake(human, mat, size) - 1.0
    mat, nt, emit = _emit_material("field_mh")
    nt.links.new(mh_color(nt), emit.inputs["Color"])
    mh = _bake(human, mat, size)
    wr, marks, handf, armf, nailf = _bake_fields(human, [
        (field("wr_d", 10, 0.5), field("wr_lat", 10, 0.5), field("wr_mask")),
        (field("knuckle"), field("tip"), field("dorsal", 0.5, 0.5)),
        (field("hand_u", 5, 0.5), field("hand_v", 5, 0.5), field("handness")),
        (field("arm_u", 3), field("arm_v", 5, 0.5), field("hairy")),
        (field("nail"), field("nail_u"), None),
    ], size)

    flat = lambda a: a.reshape(-1, a.shape[-1]) if a.ndim == 3 else a.ravel()  # noqa: E731
    p = flat(position)
    wr_d, wr_lat, wr_mask = (wr[..., 0].ravel() - 0.5) / 10, (wr[..., 1].ravel() - 0.5) / 10, wr[..., 2].ravel()
    knuckle, tip, dorsal = marks[..., 0].ravel(), marks[..., 1].ravel(), marks[..., 2].ravel() * 2 - 1
    hand_u, hand_v, handness = (handf[..., 0].ravel() - 0.5) / 5, (handf[..., 1].ravel() - 0.5) / 5, handf[..., 2].ravel()
    arm_u, arm_v, hairy = armf[..., 0].ravel() / 3, (armf[..., 1].ravel() - 0.5) / 5, armf[..., 2].ravel()
    nail, nail_u = np.clip(nailf[..., 0].ravel(), 0, 1), nailf[..., 1].ravel()
    skin = 1.0 - nail

    # Height (metres). The texture resolves ~0.2 mm on the hands, so the
    # detail is what reads at that scale: knuckle domes and extensor tendons,
    # veins, knuckle wrinkles, the ~1 mm polygonal micro-relief of skin.
    dorsal_hand = handness * _smoothstep(0.2, 0.7, dorsal)
    domes = np.zeros(len(p), np.float32)
    tendons = np.zeros(len(p), np.float32)
    for side, on_side in (("l", p[:, 0] < 0), ("r", p[:, 0] >= 0)):
        bones = arm.data.bones
        wrist = _vec(bones[f"hand_{side}"].head_local)
        up = _vec(_dorsal(bones[f"hand_{side}"]))
        knuckles = [_vec(bones[f"{f}_01_{side}"].head_local) for f in FINGERS[1:]]
        mean = np.mean(knuckles, 0)
        for j0 in knuckles:
            rel = p - j0
            planar = rel - np.outer(rel @ up, up)
            domes = np.maximum(domes, on_side * np.exp(-(np.linalg.norm(planar, axis=1) / 0.0055) ** 2))
            # Extensor tendon: out from under the wrist, where the four run
            # within ~2 cm, fanning to its knuckle. Relaxed over a curled hand:
            # a soft ridge a few mm wide, only across the middle of the hand.
            start = wrist + (mean - wrist) * 0.15 + (j0 - mean) * 0.35
            seg = j0 - start
            t = np.clip(((p - start) @ seg) / (seg @ seg), 0, 1)
            d = p - (start + t[:, None] * seg)
            d -= np.outer(d @ up, up)
            ridge = np.exp(-(np.linalg.norm(d, axis=1) / 0.0032) ** 2) * _smoothstep(0.15, 0.45, t) * (1 - _smoothstep(0.7, 0.92, t))
            tendons = np.maximum(tendons, on_side * ridge)
    domes *= dorsal_hand
    tendons *= dorsal_hand
    # Veins: zero crossings of smooth noise, a little stretched along the
    # hand, make a wandering, branching network (not parallel streaks);
    # strongest mid-hand, gone at the knuckles.
    q = np.stack([hand_u / 0.022, hand_v / 0.013, p[:, 0] * 40], 1).astype(np.float32)
    net = value_noise(q, 1.0, seed=11) + 0.2 * value_noise(q * 2.3, 1.0, seed=12)
    veins = np.exp(-(net / 0.1) ** 2) * dorsal_hand * _smoothstep(0.0, 0.025, hand_u) * (1 - _smoothstep(0.05, 0.075, hand_u))
    g1, g2, _ = voronoi(p, 0.0011, seed=2)
    groove = np.exp(-((g2 - g1) / 0.00008) ** 2)
    warp = value_noise(p, 0.0015, seed=3)
    phase = (wr_d + 2.5 * wr_lat ** 2) / 0.00125 + 0.35 * warp
    wrinkle = np.exp(-((phase - np.round(phase)) / 0.18) ** 2) * wr_mask
    pore = np.exp(-(voronoi(p, 0.0007, seed=1)[0] / 0.00016) ** 2)
    # Faint lengthwise ridges on the nails (0.6 mm apart across the nail).
    ridges = np.sin(wr_lat * (2 * np.pi / 0.0006) + 2 * value_noise(p, 0.002, seed=4)) * nail
    height = skin * (550e-6 * domes + 130e-6 * tendons + 110e-6 * veins
                     - 90e-6 * wrinkle - 16e-6 * groove - 10e-6 * pore) + 3e-6 * ridges

    # Albedo: MakeHuman's colour variation at half strength around SKIN_TONE.
    mh_rgb = flat(mh)
    reference = np.median(mh_rgb[handness > 0.5], axis=0)
    albedo = SKIN_TONE * np.power(np.clip(mh_rgb / reference, 0.2, 5.0), 0.45)
    mottle = 0.6 * value_noise(p, 0.006, seed=5) + 0.4 * value_noise(p, 0.0022, seed=6)
    albedo *= 1 + 0.05 * mottle[:, None] * np.array([1.0, -0.5, -0.7], np.float32)
    redden = np.array([1.1, 0.86, 0.84], np.float32)
    albedo *= 1 + (redden - 1) * np.clip(0.75 * knuckle + 0.6 * tip, 0, 1)[:, None]
    albedo *= 1 - veins[:, None] * np.array([0.12, 0.06, -0.03], np.float32)
    # Skin stretched over tendons and knuckles is paler and less red.
    albedo *= 1 + np.clip(0.3 * tendons + 0.4 * domes, 0, 1)[:, None] * np.array([0.03, 0.05, 0.05], np.float32)
    albedo *= (1 - 0.06 * pore - 0.035 * groove - 0.1 * wrinkle)[:, None]
    h1, _, spot = voronoi(p, 0.0016, seed=8)
    freckle = (spot > 0.965) * np.exp(-(h1 / 0.00032) ** 2) * (1 - 0.6 * handness)
    albedo *= 1 - freckle[:, None] * np.array([0.12, 0.2, 0.24], np.float32)
    # Fine hair: thin dark streaks along the forearm, sparser on the hand.
    hair_q = np.stack([arm_u / 0.011, arm_v / 0.0006, np.zeros_like(arm_u)], 1)
    hh, _, hid = voronoi(hair_q, 1.0, seed=9)
    hair = (hid > 0.35) * np.exp(-(hh / 0.1) ** 2) * hairy
    albedo *= 1 - 0.35 * hair[:, None] * np.array([0.8, 0.85, 0.88], np.float32)
    # Nails: pink bed, pale lunula at the cuticle, white free edge.
    bed = np.array([0.72, 0.42, 0.37], np.float32)
    lunula = np.array([0.84, 0.68, 0.63], np.float32)
    free_edge = np.array([0.88, 0.84, 0.78], np.float32)
    nail_color = bed + (lunula - bed) * (1 - _smoothstep(0.06, 0.2, nail_u))[:, None]
    nail_color = nail_color + (free_edge - nail_color) * (0.7 * _smoothstep(0.9, 0.97, nail_u))[:, None]
    albedo = albedo * skin[:, None] + nail_color * nail[:, None]
    albedo = np.clip(albedo, 0, 1)

    # Skin's sheen is broad and soft (roughness ~0.6); knuckles and
    # fingertips a little shinier, creases and pores duller.
    roughness = (0.6 - 0.05 * np.clip(knuckle + tip, 0, 1) + 0.06 * pore + 0.08 * groove
                 + 0.08 * wrinkle) * skin + (0.22 + 0.04 * np.abs(ridges)) * nail
    roughness = np.clip(roughness, 0.1, 0.8)

    shape = (size, size)
    srgb = np.where(albedo <= 0.0031308, albedo * 12.92, 1.055 * np.power(albedo, 1 / 2.4) - 0.055)
    albedo_img = _to_image("skin_albedo", srgb.reshape(*shape, 3), "sRGB")
    albedo_img.colorspace_settings.name = "sRGB"
    rough_img = _to_image("skin_roughness", np.repeat(roughness.reshape(*shape, 1), 3, -1), "Non-Color")

    # Height → tangent-space normal map, differentiating in texel space and
    # scaling by metres per texel along u and v (MikkTSpace tangents follow
    # dP/du and dP/dv closely on this unwrap).
    h = height.reshape(shape)
    pos = position
    du = np.linalg.norm(np.roll(pos, -1, 1) - np.roll(pos, 1, 1), axis=-1) / 2
    dv = np.linalg.norm(np.roll(pos, -1, 0) - np.roll(pos, 1, 0), axis=-1) / 2
    typical = float(np.median(du[handness.reshape(shape) > 0.5]))
    du = np.clip(du, typical * 0.25, typical * 4)
    dv = np.clip(dv, typical * 0.25, typical * 4)
    dh_du = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) / 2 / du
    dh_dv = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) / 2 / dv
    n = np.stack([-dh_du, -dh_dv, np.ones_like(h)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    normal_img = _to_image("skin_normal", n * 0.5 + 0.5, "Non-Color")
    if cache is not None:
        for image in (albedo_img, rough_img, normal_img):
            image.filepath_raw = str(Path(cache) / f"{image.name}.png")
            image.file_format = "PNG"
            image.save()

    # Final material: textures through SKIN_UV only; MakeHuman's UVs go.
    material = bpy.data.materials.new("Skin")
    material.use_nodes = True
    nt = material.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    for image, socket in ((albedo_img, "Base Color"), (rough_img, "Roughness")):
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = image
        nt.links.new(tex.outputs["Color"], bsdf.inputs[socket])
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = normal_img
    normal_map = nt.nodes.new("ShaderNodeNormalMap")
    nt.links.new(tex.outputs["Color"], normal_map.inputs["Color"])
    nt.links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Metallic"].default_value = 0.0
    human.data.materials.clear()
    human.data.materials.append(material)
    human.data.uv_layers.remove(human.data.uv_layers[mh_uv])
    human.data.uv_layers.active = human.data.uv_layers[SKIN_UV]
    human.data.uv_layers[SKIN_UV].active_render = True
    for name in ("wr_d", "wr_lat", "wr_mask", "knuckle", "tip", "dorsal", "hand_u", "hand_v", "handness",
                 "arm_u", "arm_v", "hairy", "nail_region", "nail_u", "nail"):
        human.data.attributes.remove(human.data.attributes[name])
    return material

