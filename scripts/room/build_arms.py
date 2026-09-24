#!/usr/bin/env python3
"""Build the first-person arms (frontend/public/room/arms.glb), rigged, with
the touch-typing home-row pose as the bind pose.

Run with Blender 5.1 and the MPFB 2.0.17 extension installed:
  blender -b -P scripts/room/build_arms.py

Body and rig come from MakeHuman/MPFB (CC0), reshaped with its hand/forearm
targets. The pose curls each finger to a natural resting shape (CURL), places
each hand so those fingertips land on their home keys from layout.json, then
adjusts each finger slightly to touch its key exactly.
Skin detail, nails and textures come from skin_bake.py; the charcoal fleece
sleeves are generated here. ARMS_DEBUG_BLEND=<path> saves the scene.
"""
from __future__ import annotations

import json
import math
import os
import random
import sys
import urllib.request
import zipfile
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import skin_bake  # noqa: E402
LAYOUT_PATH = ROOT / "frontend/src/room/layout.json"
OUTPUT_PATH = ROOT / "frontend/public/room/arms.glb"
CACHE_DIR = Path.home() / ".cache/term-site-room"
ASSET_PACK_URL = "https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip"
ASSET_PACK_NAME = "makehuman_system_assets_cc0.zip"
ARM_BONES = {
    "clavicle_l", "upperarm_l", "lowerarm_l", "hand_l",
    "clavicle_r", "upperarm_r", "lowerarm_r", "hand_r",
    *{f"{finger}_{part:02d}_{side}" for side in ("l", "r") for finger in ("thumb", "index", "middle", "ring", "pinky") for part in (1, 2, 3)},
}
KEEP_BONES = {"Root", "pelvis", "spine_01", "spine_02", "spine_03"} | ARM_BONES
SHAPE_TARGETS = [
    *[(group, f"{side}-{name}", weight) for side in ("l", "r") for group, name, weight in (
        ("hands", "hand-fingers-diameter-decr", 0.7),
        ("hands", "hand-fingers-length-incr", 0.35),
        ("hands", "hand-scale-decr", 0.12),
        # MakeHuman's knuckles span ~73 mm; a real hand's ~60 mm, near the
        # 57 mm from A to F, so fingers rest parallel instead of converging.
        ("hands", "hand-fingers-distance-decr", 1.0),
        ("arms", "lowerarm-fat-decr", 0.6),
        ("arms", "lowerarm-muscle-incr", 0.35),
    )],
    ("hands", "measure-wrist-circ-decr", 0.45),
]
# MakeHuman's finger proportions, corrected toward real hands before posing
# (each finger stretched along its phalanges): its little finger is 65% of
# the middle finger's length where a real hand's is ~76% (too short to curl
# onto its key, it reached down straight), and its middle finger outgrows
# index and ring by ~12% where real hands differ by ~5%.
FINGER_LENGTH_SCALE = {"pinky": 1.14, "middle": 0.955, "ring": 1.03}
CUFF_LENGTH = 0.045
CUFF_RADIUS = 0.034
CUFF_RIBS = 44
# Resting touch-typing curl per finger, degrees: MCP and PIP flexion, and
# splay from the hand's long axis (+ toward the little finger). The knuckles
# are the hand's highest point (MCP joints flex, never bend backwards), the
# fingers arch down to the keys in one curve and, curled, converge a little
# toward the thumb's base as real fingers do.
CURL = {"index": (35, 30, 4), "middle": (40, 36, 1), "ring": (38, 34, -1), "pinky": (32, 26, -4)}
# How far a finger may comfortably depart from CURL to reach its key,
# degrees (MCP, PIP, splay): fingers curl more or less easily, splaying
# them sideways reads as wrong at once.
CURL_GIVE = (10.0, 12.0, 3.0)
# The DIP joint follows the PIP joint (they share a tendon). A resting hand
# bends the fingertip joint less than hands.ts's striking fingers do.
DIP_RATIO = 0.65
# What the per-finger fit may use to touch its key exactly (degrees).
MCP_RANGE = (0.0, 65.0)
PIP_RANGE = (5.0, 95.0)
SPLAY_RANGE = 15.0
# How typing hands are held, degrees (mean, spread): turned in toward the
# keyboard's centre, the back of the hand rising from the wrist to the
# knuckles, thumb side up (forearms are never fully pronated).
HAND_PRIOR = {"yaw": (12, 10), "pitch": (18, 5), "roll": (18, 8)}
FINGER_KEYS = {
    "l": {"pinky": "KeyA", "ring": "KeyS", "middle": "KeyD", "index": "KeyF", "thumb": "SpaceLeftThumb"},
    "r": {"index": "KeyJ", "middle": "KeyK", "ring": "KeyL", "pinky": "Semicolon", "thumb": "SpaceRightThumb"},
}


def gltf_to_blender(v):
    """Layout/glTF (x,y,z) to Blender (x,-z,y)."""
    return Vector((float(v[0]), -float(v[2]), float(v[1])))


def reset_scene():
    bpy.ops.object.mode_set(mode="OBJECT") if bpy.context.object and bpy.context.object.mode != "OBJECT" else None
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials, bpy.data.images, bpy.data.cameras, bpy.data.lights):
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)


def ensure_assets():
    """Download and install the official CC0 MakeHuman system pack if absent."""
    try:
        from bl_ext.user_default.mpfb.services import LocationService
    except Exception as exc:
        raise RuntimeError(
            "MPFB 2.0.17 is required. Install it first with: "
            "blender --command extension install-file -r user_default -e "
            "~/.cache/term-site-room/add-on-mpfb-v2.0.17.zip"
        ) from exc
    user_data = Path(LocationService.get_user_data())
    skin = user_data / "skins/young_caucasian_male/young_caucasian_male.mhmat"
    if skin.exists():
        return skin
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    archive = CACHE_DIR / ASSET_PACK_NAME
    if not archive.exists():
        print(f"Downloading CC0 MakeHuman system assets to {archive}")
        urllib.request.urlretrieve(ASSET_PACK_URL, archive)
    with zipfile.ZipFile(archive) as zf:
        zf.extractall(user_data)
    if not skin.exists():
        raise RuntimeError(f"Asset pack did not provide expected skin: {skin}")
    return skin


def create_mpfb_human(skin_path):
    from bl_ext.user_default.mpfb.services import HumanService, TargetService
    macro = TargetService.get_default_macro_info_dict()
    macro["gender"] = 1.0
    macro["age"] = 0.5
    macro["muscle"] = 0.62
    macro["weight"] = 0.36
    macro["height"] = 0.55
    macro["race"]["african"] = 0.0
    macro["race"]["asian"] = 0.0
    macro["race"]["caucasian"] = 1.0
    human = HumanService.create_human(
        mask_helpers=True,
        detailed_helpers=True,
        extra_vertex_groups=True,
        feet_on_ground=True,
        scale=0.1,
        macro_detail_dict=macro,
    )
    # Slimmer, longer fingers and a leaner forearm than the macro average:
    # the default MakeHuman hand reads as puffy at first-person distance.
    from bl_ext.user_default.mpfb.services import LocationService
    targets = Path(LocationService.get_mpfb_data("targets"))
    for group, name, weight in SHAPE_TARGETS:
        TargetService.load_target(human, str(targets / group / f"{name}.target.gz"), weight=weight)
    HumanService.set_character_skin(str(skin_path), human, skin_type="GAMEENGINE", material_instances=False)
    HumanService.add_builtin_rig(human, "game_engine", import_weights=True)
    arm = human.parent
    human.name = "Skin"
    human.data.name = "Skin"
    arm.name = "ArmsRig"
    arm.data.name = "ArmsRig"
    # Freeze the selected phenotype before applying the armature.
    bpy.context.view_layer.objects.active = human
    human.select_set(True)
    if human.data.shape_keys:
        bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
    # MPFB's base object contains rigging helpers (joint cubes, eyes, teeth).
    # Apply its mask before posing so those hidden helper faces are genuinely
    # absent from the web asset rather than merely viewport-hidden.
    for mod in list(human.modifiers):
        if mod.type == "MASK":
            while human.modifiers.find(mod.name) > 0:
                bpy.ops.object.modifier_move_up(modifier=mod.name)
            bpy.ops.object.modifier_apply(modifier=mod.name)
    return human, arm


def transform_character_to_layout(human, arm, layout):
    """Rotate MakeHuman to POV orientation and make upper-arm heads hit layout shoulders."""
    left = gltf_to_blender(layout["body"]["shoulderLeft"])
    right = gltf_to_blender(layout["body"]["shoulderRight"])
    old_l = arm.data.bones["upperarm_l"].head_local.copy()
    old_r = arm.data.bones["upperarm_r"].head_local.copy()
    scale = (left - right).length / (old_l - old_r).length
    rot = Matrix.Rotation(math.pi, 4, "Z")
    linear = Matrix.Scale(scale, 4) @ rot
    mapped_mid = linear @ ((old_l + old_r) * 0.5)
    target_mid = (left + right) * 0.5
    xform = Matrix.Translation(target_mid - mapped_mid) @ linear
    for vert in human.data.vertices:
        vert.co = xform @ vert.co
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    for bone in arm.data.edit_bones:
        bone.transform(xform, roll=True)
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.context.view_layer.update()
    err_l = (arm.data.bones["upperarm_l"].head_local - left).length
    err_r = (arm.data.bones["upperarm_r"].head_local - right).length
    if max(err_l, err_r) > 1e-5:
        raise RuntimeError(f"Shoulder placement failed: {err_l:.6g}, {err_r:.6g}")


def correct_finger_lengths(human, arm):
    """Rescale the fingers in FINGER_LENGTH_SCALE along their phalanges:
    each phalanx bone and the skin weighted to it change length along the
    phalanx, and the joints beyond it move with it."""
    moves = {}  # bone name -> (head, axis, length, scale, shift of its head)
    for side in ("l", "r"):
        for finger, scale in FINGER_LENGTH_SCALE.items():
            shift = Vector()
            for part in (1, 2, 3):
                bone = arm.data.bones[f"{finger}_{part:02d}_{side}"]
                head, tail = bone.head_local.copy(), bone.tail_local.copy()
                axis, length = (tail - head).normalized(), (tail - head).length
                moves[bone.name] = (head, axis, length, scale, shift.copy(), part == 3)
                shift += axis * length * (scale - 1)
    group_bone = {g.index: g.name for g in human.vertex_groups if g.name in moves}
    for vert in human.data.vertices:
        offset = Vector()
        for item in vert.groups:
            name = group_bone.get(item.group)
            if name is None:
                continue
            head, axis, length, scale, shift, distal = moves[name]
            along = max(0.0, (vert.co - head).dot(axis))
            offset += item.weight * (shift + axis * (along if distal else min(length, along)) * (scale - 1))
        vert.co += offset
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    for name, (head, axis, length, scale, shift, _) in moves.items():
        bone = arm.data.edit_bones[name]
        bone.head = head + shift
        bone.tail = head + shift + axis * length * scale
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.context.view_layer.update()


def empty_target(name, location):
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = "PLAIN_AXES"
    obj.empty_display_size = 0.015
    obj.location = location
    bpy.context.scene.collection.objects.link(obj)
    return obj


def anatomical_frame(arm, side):
    wrist = arm.pose.bones[f"hand_{side}"].head.copy()
    index = arm.pose.bones[f"index_01_{side}"].head.copy()
    pinky = arm.pose.bones[f"pinky_01_{side}"].head.copy()
    middle_knuckle = arm.pose.bones[f"middle_01_{side}"].head.copy()
    lateral = (index - pinky) if side == "l" else (pinky - index)
    lateral.normalize()
    forward = middle_knuckle - wrist
    forward -= lateral * forward.dot(lateral)
    forward.normalize()
    up = lateral.cross(forward).normalized()
    forward = up.cross(lateral).normalized()
    return Matrix((lateral, forward, up)).transposed()


def hand_frame(side, yaw, pitch, roll):
    """World frame (lateral, forward along the metacarpals, up columns) of a
    hand turned `yaw` in toward the keyboard's centre, pitched `pitch`
    knuckles-up and rolled `roll` thumb-side up (radians)."""
    s = 1 if side == "l" else -1
    return Matrix.Rotation(-s * yaw, 3, "Z") @ Matrix.Rotation(pitch, 3, "X") @ Matrix.Rotation(-s * roll, 3, "Y")


def orient_hand(arm, side, frame):
    """Rotate the whole hand rigidly about the wrist into `frame`."""
    delta = frame @ anatomical_frame(arm, side).transposed()
    hand = arm.pose.bones[f"hand_{side}"]
    m = (delta @ hand.matrix.to_3x3()).to_4x4()
    m.translation = hand.head.copy()
    hand.matrix = m


def finger_rig(arm, side, finger, frame):
    """A finger's bones, rest joints and a `pose(mcp, pip, splay)` giving its
    phalanges' world rotations, joint positions and flex axis for absolute
    angles (radians; DIP = DIP_RATIO × PIP). The finger is rebuilt straight
    along the hand, splayed, then curled about one axis, so MakeHuman's
    fanned, twisted rest fingers do not leak into the pose."""
    lateral, forward, up = (frame.col[i].to_3d() for i in range(3))
    bones = [arm.pose.bones[f"{finger}_{part:02d}_{side}"] for part in (1, 2, 3)]
    joints = [b.head.copy() for b in bones] + [bones[2].tail.copy()]
    lengths = [(joints[i + 1] - joints[i]).length for i in range(3)]
    rest = []
    for i in range(3):
        y = (joints[i + 1] - joints[i]).normalized()
        x = (-lateral - y * (-lateral).dot(y)).normalized()
        rest.append(Matrix((x, y, x.cross(y))).transposed())
    toward_pinky = 1 if side == "l" else -1

    def pose(mcp, pip, splay):
        turn = Matrix.Rotation(toward_pinky * splay, 3, up)
        axis = turn @ -lateral  # positive rotation curls toward the palm
        straight = turn @ forward
        heads, rotations, bend = [joints[0]], [], 0.0
        for i, angle in enumerate((mcp, pip, pip * DIP_RATIO)):
            bend += angle
            y = Matrix.Rotation(bend, 3, axis) @ straight
            rotations.append(Matrix((axis, y, axis.cross(y))).transposed() @ rest[i].transposed())
            heads.append(heads[-1] + y * lengths[i])
        return rotations, heads, axis

    return bones, joints, pose


def place_hand(arm, side, home, key_top):
    """Rigid hand pose from which each finger reaches its home key with the
    least departure from CURL (weighted by CURL_GIVE), weighed against
    HAND_PRIOR. The hand is rigid, so each finger's angle-to-fingertip
    response is fixed in hand coordinates: search turn, pitch and roll, and
    per candidate solve the wrist position by weighted least squares on the
    linearised angle changes. Returns (frame, wrist)."""
    frame = anatomical_frame(arm, side)
    to_local = frame.transposed()
    wrist = arm.pose.bones[f"hand_{side}"].head.copy()
    give = Matrix.Diagonal([1 / math.radians(g) for g in CURL_GIVE])
    fingers = []
    for finger, curl in CURL.items():
        _, _, pose = finger_rig(arm, side, finger, frame)
        natural = [math.radians(a) for a in curl]
        tip = pose(*natural)[1][3]
        columns = []
        for j in range(3):
            nudged = list(natural)
            nudged[j] += 1e-3
            columns.append(to_local @ ((pose(*nudged)[1][3] - tip) / 1e-3))
        to_angles = Matrix(columns).transposed().inverted()  # hand-local tip offset -> angle change
        target = gltf_to_blender(home[FINGER_KEYS[side][finger]])
        fingers.append((to_local @ (tip - wrist), to_angles, give @ to_angles, target, curl))

    def fit(yaw, pitch, roll):
        world = hand_frame(side, *(math.radians(a) for a in (yaw, pitch, roll)))
        inverse = world.transposed()
        rows = []
        normal, rhs = Matrix.Diagonal((0.0, 0.0, 0.0)), Vector((0.0, 0.0, 0.0))
        for tip, _, weighted, target, _ in fingers:
            m = weighted @ inverse  # weighted angle change = b - m @ w
            b = m @ target - weighted @ tip
            rows.append((m, b))
            normal += m.transposed() @ m
            rhs += m.transposed() @ b
        w = normal.inverted() @ rhs
        cost = sum((b - m @ w).length_squared for m, b in rows)
        changes = []
        for tip, to_angles, _, target, curl in fingers:
            change = [math.degrees(a) for a in to_angles @ (inverse @ (target - w) - tip)]
            changes.append(change)
            cost += (max(0.0, 2.0 - curl[0] - change[0]) / 1.0) ** 2  # no MCP hyperextension
            cost += (max(0.0, 8.0 - curl[1] - change[1]) / 1.0) ** 2
        for name, angle in (("yaw", yaw), ("pitch", pitch), ("roll", roll)):
            mean, spread = HAND_PRIOR[name]
            cost += ((angle - mean) / spread) ** 2
        cost += (max(0.0, key_top + 0.03 - w.z) / 0.005) ** 2  # wrist clear of the keycaps
        return cost, world, w, changes, (yaw, pitch, roll)

    cost, world, w, changes, angles = min(
        (fit(yaw, pitch, roll) for yaw in range(-10, 37, 2) for pitch in range(-6, 31, 2) for roll in range(-6, 41, 2)),
        key=lambda r: r[0])
    span = (arm.pose.bones[f"index_01_{side}"].head - arm.pose.bones[f"pinky_01_{side}"].head).length
    print(f"HAND {side} knuckle span {span * 1000:.0f}mm yaw/pitch/roll {angles} wrist {tuple(round(c, 3) for c in w)} cost {cost:.2f} "
          f"curl changes {[[round(a) for a in c] for c in changes]}")
    return world, w


def fit_finger(arm, side, finger, target, frame):
    """Land one finger on `target` starting from its CURL shape: damped
    least squares over MCP, PIP and splay within the anatomical ranges, then
    pose the three phalanges. Returns the finger's flex axis."""
    bones, joints, pose = finger_rig(arm, side, finger, frame)
    rest = [b.matrix.copy() for b in bones]  # before posing moves the children
    mcp0, pip0, splay0 = CURL[finger]
    limits = [tuple(math.radians(a) for a in r) for r in
              (MCP_RANGE, PIP_RANGE, (splay0 - SPLAY_RANGE, splay0 + SPLAY_RANGE))]
    params = [math.radians(a) for a in (mcp0, pip0, splay0)]
    for _ in range(80):
        tip = pose(*params)[1][3]
        error = target - tip
        if error.length < 1e-5:
            break
        columns = []
        for j in range(3):
            nudged = list(params)
            nudged[j] += 1e-4
            columns.append((pose(*nudged)[1][3] - tip) / 1e-4)
        jac = Matrix(columns).transposed()  # columns: d tip / d param
        step = jac.transposed() @ ((jac @ jac.transposed() + Matrix.Identity(3) * 1e-4).inverted() @ error)
        params = [min(hi, max(lo, p + max(-0.1, min(0.1, d)))) for p, d, (lo, hi) in zip(params, step, limits)]
    rotations, heads, axis = pose(*params)
    for bone, rotation, head, old_head, matrix in zip(bones, rotations, heads, joints, rest):
        bone.matrix = Matrix.Translation(head) @ rotation.to_4x4() @ Matrix.Translation(-old_head) @ matrix
        bpy.context.view_layer.update()
    mcp, pip, splay = (math.degrees(p) for p in params)
    print(f"FINGER {side}.{finger} mcp {mcp:.0f} pip {pip:.0f} dip {pip * DIP_RATIO:.0f} splay {splay:.0f} "
          f"error {(bones[2].tail - target).length * 1000:.2f}mm")
    return axis


def pose_typing(arm, layout):
    """IK the arms and all 30 finger phalanges into the layout home keys.
    Returns each finger's flex axis (armature space) by (side, finger)."""
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")
    # MPFB allows slight stretch by default; hard-disable it for believable anatomy.
    for pb in arm.pose.bones:
        pb.ik_stretch = 0.0
    # Each hand is placed (and turned, pitched, rolled) so its fingers reach
    # their home keys in their natural resting curl.
    key_top = layout["keyboard"]["keyTopY"]["frontRow"]
    home = layout["keyboard"]["homeKeys"]
    targets = []
    wrist_targets = {}
    for side in ("l", "r"):
        target = empty_target(f"_ik_wrist_{side}", Vector((-0.1 if side == "l" else 0.1, -0.056, key_top + 0.035)))
        targets.append(target)
        wrist_targets[side] = target
        con = arm.pose.bones[f"lowerarm_{side}"].constraints.new("IK")
        con.name = "Typing wrist IK"
        con.target = target
        con.chain_count = 2
        con.iterations = 96
        con.use_stretch = False
    bpy.context.view_layer.update()
    for side in ("l", "r"):
        orient_hand(arm, side, hand_frame(side, 0.0, 0.0, 0.0))
        bpy.context.view_layer.update()
        frame, wrist = place_hand(arm, side, home, key_top)
        wrist_targets[side].location = wrist
        bpy.context.view_layer.update()
        orient_hand(arm, side, frame)
        bpy.context.view_layer.update()
        reached = arm.pose.bones[f"hand_{side}"].head
        print(f"WRIST {side} reached within {(reached - wrist).length * 1000:.1f}mm")

    finger_targets = {}
    flex_axes = {}
    for side, mapping in FINGER_KEYS.items():
        frame = anatomical_frame(arm, side)
        for finger, key in mapping.items():
            pos = gltf_to_blender(home[key])
            finger_targets[(side, finger)] = pos
            if finger == "thumb":
                target = empty_target(f"_ik_{finger}_{side}", pos)
                targets.append(target)
                con = arm.pose.bones[f"{finger}_03_{side}"].constraints.new("IK")
                con.name = "Home key IK"
                con.target = target
                con.chain_count = 3
                con.iterations = 128
                con.use_stretch = False
            else:
                flex_axes[(side, finger)] = fit_finger(arm, side, finger, pos, frame)
    for _ in range(4):
        bpy.context.view_layer.update()

    errors = {}
    for (side, finger), pos in finger_targets.items():
        tail = arm.pose.bones[f"{finger}_03_{side}"].tail.copy()
        errors[(side, finger)] = (tail - pos).length
    max_error = max(errors.values())
    print("IK target errors (m):", {f"{s}.{f}": round(e, 6) for (s, f), e in errors.items()})
    if max_error > 0.008:
        raise RuntimeError(f"Finger IK cannot reach home row; max error {max_error:.4f}m")

    # Bake evaluated constrained matrices into ordinary pose transforms.
    matrices = {pb.name: pb.matrix.copy() for pb in arm.pose.bones}
    for pb in arm.pose.bones:
        for con in list(pb.constraints):
            pb.constraints.remove(con)
    for pb in arm.pose.bones:
        pb.matrix = matrices[pb.name]
    bpy.context.view_layer.update()
    for target in targets:
        bpy.data.objects.remove(target, do_unlink=True)
    bpy.ops.object.mode_set(mode="OBJECT")
    return flex_axes


def apply_pose_as_rest(human, arm):
    """Bake deformed skin, set pose as rest, then restore skinning as required."""
    bpy.context.view_layer.objects.active = human
    human.hide_set(False)
    bpy.ops.object.select_all(action="DESELECT")
    human.select_set(True)
    arm_mod = next((m for m in human.modifiers if m.type == "ARMATURE"), None)
    if not arm_mod:
        raise RuntimeError("MPFB did not attach its armature modifier")
    bpy.ops.object.modifier_apply(modifier=arm_mod.name)
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    human.select_set(False)
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    mod = human.modifiers.new("ArmsRig", "ARMATURE")
    mod.object = arm
    mod.use_deform_preserve_volume = True


def normalize_control_axes(arm, flex_axes):
    """Give every phalanx one predictable local-axis animation convention.

    Bone local +Y runs down each phalanx and local +X is the finger's flex
    axis (from pose_typing), so +X rotation carries +Y toward +Z, palmward:
    the same positive X delta curls every phalanx in the finger's own plane,
    even a fingertip that points straight down. Hand and thumb bones take
    local +Z toward the desk.
    """
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    down = Vector((0.0, 0.0, -1.0))
    for side in ("l", "r"):
        hand = arm.data.edit_bones[f"hand_{side}"]
        forward = (arm.data.edit_bones[f"middle_01_{side}"].head - hand.head).normalized()
        hand.tail = hand.head + forward * 0.075
        hand.align_roll(down)
        for part in (1, 2, 3):
            arm.data.edit_bones[f"thumb_{part:02d}_{side}"].align_roll(down)
        for finger in ("index", "middle", "ring", "pinky"):
            axis = flex_axes[(side, finger)]
            for part in (1, 2, 3):
                bone = arm.data.edit_bones[f"{finger}_{part:02d}_{side}"]
                bone.align_roll(axis.cross((bone.tail - bone.head).normalized()))
    bpy.ops.object.mode_set(mode="OBJECT")


def prune_skin(human, arm):
    """Retain only the arm skin the sleeves leave visible (plus a 3.5 cm
    tuck inside each cuff)."""
    deform_group_indices = {g.index for g in human.vertex_groups if g.name in ARM_BONES}
    cuffs = {}
    for side in ("l", "r"):
        _, (_, _, cuff) = sleeve_path(arm, side)
        wrist = arm.data.bones[f"hand_{side}"].head_local
        cuffs[side] = (cuff, (wrist - arm.data.bones[f"lowerarm_{side}"].head_local).normalized())
    for v in human.data.vertices:
        cuff, fore = cuffs["l" if v.co.x < 0 else "r"]
        hidden = (v.co - cuff).dot(fore) < -0.035
        v.select = hidden or not any(g.group in deform_group_indices and g.weight > 0.001 for g in v.groups)
    bpy.context.view_layer.objects.active = human
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.delete(type="VERT")
    bpy.ops.object.mode_set(mode="OBJECT")
    # Remove unused torso/leg groups but retain root chain groups for hierarchy compatibility.
    for vg in list(human.vertex_groups):
        if vg.name not in KEEP_BONES:
            human.vertex_groups.remove(vg)
    limit_influences(human)
    for poly in human.data.polygons:
        poly.use_smooth = True


def enhance_skin_geometry(human, arm):
    """Add restrained knuckle relief, then smooth with one subdivision. (The
    extensor tendons are texture detail: under a curled hand's skin they are
    too soft for the mesh's resolution.)"""
    mesh = human.data
    mesh.update()
    knuckles = [arm.data.bones[f"{finger}_01_{side}"].head_local.copy()
                for side in ("l", "r") for finger in ("index", "middle", "ring", "pinky")]
    for vert in mesh.vertices:
        p = vert.co
        lift = 0.0
        for mcp in knuckles:
            planar = Vector((p.x - mcp.x, p.y - mcp.y, 0.0)).length
            if planar < 0.014:
                top_weight = max(0.0, min(1.0, (p.z - (mcp.z - 0.012)) / 0.014))
                lift += 0.0022 * math.exp(-((planar / 0.0085) ** 2)) * top_weight
        p.z += min(lift, 0.0028)
    sub = human.modifiers.new("Skin silhouette", "SUBSURF")
    sub.subdivision_type = "CATMULL_CLARK"
    sub.levels = 1
    sub.render_levels = 1
    while human.modifiers.find(sub.name) > 0:
        bpy.context.view_layer.objects.active = human
        bpy.ops.object.modifier_move_up(modifier=sub.name)
    bpy.context.view_layer.objects.active = human
    bpy.ops.object.modifier_apply(modifier=sub.name)
    mesh = human.data
    group_names = {group.index: group.name for group in human.vertex_groups}
    finger_prefixes = ("thumb_", "index_", "middle_", "ring_", "pinky_")
    # Taper every phalanx, preserve a fleshy fingertip pad, and retain small
    # PIP/DIP bulges. This removes the cylindrical silhouette visible in the
    # runtime top view without changing any bone endpoint.
    for vert in mesh.vertices:
        influences = [(item.weight, group_names[item.group]) for item in vert.groups
                      if group_names.get(item.group, "").startswith(finger_prefixes)]
        finger_weight, group_name = max(influences) if influences else (0.0, None)
        if finger_weight > 0.35:
            bone = arm.data.bones[group_name]
            axis = (bone.tail_local - bone.head_local).normalized()
            length = (bone.tail_local - bone.head_local).length
            raw_t = (vert.co - bone.head_local).dot(axis) / max(length, 1e-6)
            t = max(0.0, min(1.0, raw_t))
            center = bone.head_local + axis * (t * length)
            radial = vert.co - center
            part = int(group_name.split("_")[-2])
            if part == 3:
                # Gentle taper into a rounded fingertip pad, not a point.
                factor = 0.955 - 0.07 * t + 0.03 * math.exp(-(((t - 0.78) / 0.16) ** 2))
            else:
                factor = 0.93 + 0.075 * math.exp(-(((t - 0.96) / 0.18) ** 2))
            vert.co = center + radial * factor
            if part == 3 and t > 0.72:
                palmward = (bone.matrix_local.to_3x3() @ Vector((0, 0, 1))).normalized()
                vert.co += palmward * (0.0008 * ((t - 0.72) / 0.28))
            continue
        weights = {group_names[item.group]: item.weight for item in vert.groups}
        for side in ("l", "r"):
            wrist = arm.data.bones[f"hand_{side}"].head_local
            hand_weight = weights.get(f"hand_{side}", 0.0)
            fore_weight = weights.get(f"lowerarm_{side}", 0.0)
            if hand_weight > 0.12:
                # A shallow dorsal metacarpal arch is highest midway across
                # the hand and fades before the wrist and MCP joints.
                arch_y = math.exp(-(((vert.co.y - (wrist.y + 0.058)) / 0.052) ** 2))
                arch_x = math.exp(-(((vert.co.x - wrist.x) / 0.040) ** 2))
                top_weight = max(0.0, min(1.0, (vert.co.z - (wrist.z - 0.010)) / 0.014))
                vert.co.z += 0.0024 * arch_x * arch_y * hand_weight * top_weight
            if hand_weight + fore_weight > 0.25 and abs(vert.co.y - wrist.y) < 0.027:
                # Bring the wrist to a believable 5.5–6 cm width and taper
                # the distal forearm into it.
                blend = 1.0 - abs(vert.co.y - wrist.y) / 0.027
                vert.co.x = wrist.x + (vert.co.x - wrist.x) * (1.0 - 0.12 * blend)
    bpy.context.view_layer.objects.active = human
    bpy.ops.object.mode_set(mode="WEIGHT_PAINT")
    bpy.ops.object.vertex_group_smooth(group_select_mode="BONE_DEFORM", factor=0.32, repeat=2, expand=0.0)
    bpy.ops.object.mode_set(mode="OBJECT")
    mesh.update()
    limit_influences(human)


def limit_influences(obj):
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="WEIGHT_PAINT")
    bpy.ops.object.vertex_group_limit_total(group_select_mode="BONE_DEFORM", limit=4)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode="BONE_DEFORM", lock_active=False)
    bpy.ops.object.mode_set(mode="OBJECT")


def normal_texture(name, kind, size=512):
    """Create a small tileable RGB tangent-space normal texture."""
    cache = CACHE_DIR / f"{name}.png"
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    u = x / size * 2.0 * math.pi
    v = y / size * 2.0 * math.pi
    # Alternating knit columns plus a fine cotton-fleece nap.
    height = (0.72 * np.sin(u * 28 + 0.55 * np.sin(v * 28)) +
              0.36 * np.cos(v * 56 - u * 14) + 0.10 * np.sin(u * 113 + v * 97))
    strength = 0.11
    dy, dx = np.gradient(height)
    nx = -dx * strength
    ny = -dy * strength
    nz = np.ones_like(nx)
    norm = np.sqrt(nx * nx + ny * ny + nz * nz)
    rgba = np.stack((nx / norm * 0.5 + 0.5, ny / norm * 0.5 + 0.5, nz / norm * 0.5 + 0.5, np.ones_like(nx)), axis=-1)
    image = bpy.data.images.new(name, width=size, height=size, alpha=True)
    image.colorspace_settings.name = "Non-Color"
    image.pixels.foreach_set(rgba.astype(np.float32).ravel())
    image.filepath_raw = str(cache)
    image.file_format = "PNG"
    image.save()
    return image


def add_normal_to_material(material, image, strength):
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    bsdf = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
    tex = nodes.new("ShaderNodeTexImage")
    tex.name = f"{image.name}Texture"
    tex.image = image
    tex.interpolation = "Linear"
    normal = nodes.new("ShaderNodeNormalMap")
    normal.inputs["Strength"].default_value = strength
    links.new(tex.outputs["Color"], normal.inputs["Color"])
    links.new(normal.outputs["Normal"], bsdf.inputs["Normal"])
    return bsdf


def catmull_rom(points, samples_per_span=6):
    out = []
    ext = [points[0]] + points + [points[-1]]
    for i in range(1, len(ext) - 2):
        p0, p1, p2, p3 = ext[i - 1:i + 3]
        for j in range(samples_per_span):
            t = j / samples_per_span
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2*p0 - 5*p1 + 4*p2 - p3) * t2 + (-p0 + 3*p1 - 3*p2 + p3) * t3))
    out.append(points[-1])
    return out


def sleeve_path(arm, side):
    b = arm.data.bones
    shoulder = b[f"upperarm_{side}"].head_local.copy()
    elbow = b[f"lowerarm_{side}"].head_local.copy()
    wrist = b[f"hand_{side}"].head_local.copy()
    clav_head = b[f"clavicle_{side}"].head_local.copy()
    upper_mid = shoulder.lerp(elbow, 0.52)
    upper_mid.z -= 0.008
    lower_mid = elbow.lerp(wrist, 0.48)
    fore = (wrist - elbow).normalized()
    cuff = wrist - fore * 0.06
    cap = shoulder.lerp(clav_head, 0.24)
    cap.z += 0.012
    return catmull_rom([cap, shoulder, upper_mid, elbow, lower_mid, cuff], 14), (shoulder, elbow, cuff)


def smoothstep(e0, e1, x):
    t = min(1.0, max(0.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def build_sleeves(arm):
    verts, faces, weight_rows = [], [], []
    radial = 32
    ring_offset = 0
    for side in ("l", "r"):
        rng = random.Random(3 if side == "l" else 5)
        waves = [(rng.uniform(0.02, 0.034), rng.choice((-2, -1, -1, 0, 0, 1, 1, 2)), rng.uniform(0, math.tau),
                  rng.uniform(0.5, 1.0)) for _ in range(7)]
        wave_weight = sum(w for *_, w in waves)
        path, landmarks = sleeve_path(arm, side)
        shoulder, elbow, cuff = landmarks
        total = sum((path[i] - path[i-1]).length for i in range(1, len(path)))
        traveled = 0.0
        prev_binormal = Vector((0, 0, 1))
        for i, center in enumerate(path):
            if i:
                traveled += (path[i] - path[i-1]).length
            s = traveled / max(total, 1e-6)
            if i == 0:
                tangent = (path[1] - path[0]).normalized()
            elif i == len(path)-1:
                tangent = (path[-1] - path[-2]).normalized()
            else:
                tangent = (path[i+1] - path[i-1]).normalized()
            side_axis = tangent.cross(prev_binormal)
            if side_axis.length < 1e-5:
                side_axis = tangent.cross(Vector((0, 1, 0)))
            side_axis.normalize()
            binormal = side_axis.cross(tangent).normalized()
            if binormal.dot(prev_binormal) < 0:
                side_axis.negate()
                binormal.negate()
            prev_binormal = binormal
            base_radius = 0.063 * (1 - s) + 0.034 * s
            elbow_fold = math.exp(-((s - 0.61) / 0.12) ** 2)
            d_end = total - traveled
            # Pushed up a little: the sleeve bunches in the 10 cm above the
            # ribbed cuff, which grips the forearm.
            bunch_zone = smoothstep(0.17, 0.08, d_end) * smoothstep(CUFF_LENGTH - 0.004, CUFF_LENGTH + 0.012, d_end)
            amplitude = 0.0012 + 0.0055 * bunch_zone + 0.0035 * elbow_fold
            for j in range(radial):
                a = j / radial * math.tau
                if d_end < CUFF_LENGTH:
                    radius = CUFF_RADIUS + 0.00035 * math.cos(a * CUFF_RIBS)
                else:
                    # |sin| waves: rounded crests, sharp creases; the angular
                    # terms tilt them into the diagonal folds of a sleeve.
                    fold = sum(w * abs(math.sin(traveled * math.tau / length + n * a + phase))
                               for length, n, phase, w in waves) / wave_weight - 0.64
                    radius = base_radius + 0.006 * bunch_zone + amplitude * fold
                # Slightly flattened cloth tube, plus asymmetric drape under the arm.
                ring = side_axis * (math.cos(a) * radius) + binormal * (math.sin(a) * radius * 0.88)
                ring += binormal * (-0.0035 * (1.0 - math.cos(a)) * (0.3 + elbow_fold))
                verts.append(tuple(center + ring))
                if s < 0.10:
                    weights = [(f"clavicle_{side}", 1.0 - s / 0.10), (f"upperarm_{side}", s / 0.10)]
                else:
                    de = (center - elbow).length
                    blend = max(0.0, 1.0 - de / 0.055)
                    if center.z > elbow.z + 0.01:
                        weights = [(f"upperarm_{side}", 1.0 - 0.5 * blend), (f"lowerarm_{side}", 0.5 * blend)]
                    else:
                        weights = [(f"upperarm_{side}", 0.5 * blend), (f"lowerarm_{side}", 1.0 - 0.5 * blend)]
                weight_rows.append(weights)
            if i > 0:
                a0 = ring_offset + (i-1) * radial
                a1 = ring_offset + i * radial
                for j in range(radial):
                    n = (j + 1) % radial
                    faces.append((a0+j, a0+n, a1+n, a1+j))
        # Close both ends; the cuff cap sits inside the forearm and prevents light leaks.
        start_center = len(verts)
        verts.append(tuple(path[0]))
        weight_rows.append([(f"clavicle_{side}", 1.0)])
        end_center = len(verts)
        verts.append(tuple(path[-1]))
        weight_rows.append([(f"lowerarm_{side}", 1.0)])
        last = len(path)-1
        for j in range(radial):
            n = (j+1) % radial
            faces.append((start_center, ring_offset+n, ring_offset+j))
            faces.append((end_center, ring_offset+last*radial+j, ring_offset+last*radial+n))
        ring_offset = len(verts)
    mesh = bpy.data.meshes.new("Sleeves")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    sleeves = bpy.data.objects.new("Sleeves", mesh)
    bpy.context.scene.collection.objects.link(sleeves)
    sleeves.parent = arm
    sleeves.matrix_parent_inverse = Matrix.Identity(4)
    for bone in KEEP_BONES:
        sleeves.vertex_groups.new(name=bone)
    for vi, weights in enumerate(weight_rows):
        for group, weight in weights:
            if weight > 1e-5:
                sleeves.vertex_groups[group].add([vi], weight, "REPLACE")
    mod = sleeves.modifiers.new("ArmsRig", "ARMATURE")
    mod.object = arm
    mod.use_deform_preserve_volume = True
    for poly in mesh.polygons:
        poly.use_smooth = True
    # One subtle subdivision level rounds the silhouette while staying well under budget.
    sub = sleeves.modifiers.new("Cloth silhouette", "SUBSURF")
    sub.subdivision_type = "CATMULL_CLARK"
    sub.levels = 1
    sub.render_levels = 1
    bpy.context.view_layer.objects.active = sleeves
    bpy.ops.object.modifier_apply(modifier=sub.name)
    bpy.ops.object.select_all(action="DESELECT")
    sleeves.select_set(True)
    bpy.context.view_layer.objects.active = sleeves
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=1.15192, island_margin=0.015)
    bpy.ops.object.mode_set(mode="OBJECT")
    # Subdivision interpolates deform weights; enforce the runtime's four-influence ceiling.
    limit_influences(sleeves)
    mat = bpy.data.materials.new("CharcoalCottonFleece")
    mat.use_nodes = True
    mat.diffuse_color = (0.023, 0.026, 0.031, 1.0)
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (0.023, 0.026, 0.031, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.72
    bsdf.inputs["Metallic"].default_value = 0.0
    # Fleece fuzz: a soft grey sheen at grazing angles (glTF sheen colour =
    # weight × tint, so the tint sets its brightness).
    bsdf.inputs["Sheen Weight"].default_value = 1.0
    bsdf.inputs["Sheen Tint"].default_value = (0.09, 0.09, 0.1, 1.0)
    bsdf.inputs["Sheen Roughness"].default_value = 0.6
    fleece = normal_texture("charcoal_fleece_normal", "fleece")
    add_normal_to_material(mat, fleece, 0.62)
    mesh.materials.append(mat)
    return sleeves


def remove_unused_bones(arm):
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    for bone in list(arm.data.edit_bones):
        if bone.name not in KEEP_BONES:
            arm.data.edit_bones.remove(bone)
    bpy.ops.object.mode_set(mode="OBJECT")
    arm.show_in_front = False
    arm.data.display_type = "STICK"


def export_glb(assets, arm):
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in (*assets, arm):
        obj.hide_set(False)
        obj.hide_render = False
        obj.select_set(True)
    bpy.context.view_layer.objects.active = arm
    props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    options = {
        "filepath": str(OUTPUT_PATH), "export_format": "GLB", "use_selection": True,
        "export_yup": True, "export_animations": False, "export_image_format": "WEBP",
        "export_image_quality": 82, "export_apply": False, "export_skins": True,
        "export_morph": False, "export_lights": False, "export_cameras": False,
        "export_leaf_bone": False, "export_def_bones": True,
        "export_all_influences": False, "export_attributes": False, "export_extras": True,
        "export_tangents": True,
    }
    options = {k: v for k, v in options.items() if k in props}
    result = bpy.ops.export_scene.gltf(**options)
    if result != {"FINISHED"}:
        raise RuntimeError(f"glTF export failed: {result}")


def triangle_count(objects):
    deps = bpy.context.evaluated_depsgraph_get()
    total = 0
    for obj in objects:
        evaluated = obj.evaluated_get(deps)
        mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles()
        total += len(mesh.loop_triangles)
        evaluated.to_mesh_clear()
    return total


def finger_report(arm):
    out = {}
    for side, mapping in FINGER_KEYS.items():
        for finger, key in mapping.items():
            p = arm.data.bones[f"{finger}_03_{side}"].tail_local
            gltf = (p.x, p.z, -p.y)
            out[f"{side}.{finger}:{key}"] = [round(v, 5) for v in gltf]
    return out


def main():
    layout = json.loads(LAYOUT_PATH.read_text())
    reset_scene()
    skin_path = ensure_assets()
    human, arm = create_mpfb_human(skin_path)
    transform_character_to_layout(human, arm, layout)
    correct_finger_lengths(human, arm)
    flex_axes = pose_typing(arm, layout)
    apply_pose_as_rest(human, arm)
    normalize_control_axes(arm, flex_axes)
    prune_skin(human, arm)
    enhance_skin_geometry(human, arm)
    mh_diffuse = next(n.image for n in human.data.materials[0].node_tree.nodes
                      if n.type == "TEX_IMAGE" and n.image and "diffuse" in n.image.name)
    skin_bake.anatomy_fields(human, arm)
    skin_bake.raise_nails(human)
    skin_bake.hand_weighted_uv(human)
    skin_bake.bake_skin(human, arm, mh_diffuse, size=2048, cache=CACHE_DIR)
    sleeves = build_sleeves(arm)
    remove_unused_bones(arm)

    arm["fingerFlexAxis_gltf"] = "+X rotation (same sign bends all phalanges toward palm)"
    arm["fingerSpreadAxis_gltf"] = "local Z rotation; mirror the sign by hand for symmetric abduction"
    arm["wristPitchAxis_gltf"] = "+X rotation; positive pitches fingertips down"
    arm["wristYawAxis_gltf"] = "+Z rotation; positive yaws fingertips toward local -X"
    arm["bindPose"] = "layout home-row typing pose"
    arm["sourceLicense"] = "MakeHuman/MPFB CC0"

    assets = (human, sleeves)
    tris = triangle_count(assets)
    if tris > 100000:
        raise RuntimeError(f"Triangle budget exceeded: {tris}")
    if os.environ.get("ARMS_DEBUG_BLEND"):
        bpy.ops.wm.save_as_mainfile(filepath=os.environ["ARMS_DEBUG_BLEND"])
    export_glb(assets, arm)
    size = OUTPUT_PATH.stat().st_size
    if size > 4 * 1024 * 1024:
        raise RuntimeError(f"File budget exceeded: {size} bytes")
    print("ARMS_BUILD_RESULT", json.dumps({
        "output": str(OUTPUT_PATH), "bytes": size, "triangles": tris,
        "fingertips_gltf": finger_report(arm),
    }, sort_keys=True))


if __name__ == "__main__":
    main()
