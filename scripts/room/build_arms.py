#!/usr/bin/env python3
"""Build the first-person arms (frontend/public/room/arms.glb), rigged, with
the touch-typing home-row pose as the bind pose, and the desk mouse the right
hand holds, with that hand's authored grip on it.

Run with Blender 5.1 and the MPFB 2.0.17 extension installed:
  blender -b -P scripts/room/build_arms.py

Body and rig come from MakeHuman/MPFB (CC0), reshaped with its hand/forearm
targets. The pose curls each finger to a natural resting shape (CURL), places
each hand so those fingertips land on their home keys from layout.json, then
adjusts each finger slightly to touch its key exactly. The mouse grip is
placed the same way (GRIP_CURL, MOUSE_CONTACTS, the thumb by fit_thumb) and
stored on the rig as the `mouseGrip` extra for hands.ts, with a MouseGrip
shape key correcting the skinning in that pose. Knuckles, tendons and
finger shapes are sculpted on the posed mesh; skin detail, nails, occlusion
and textures come from skin_bake.py; the charcoal fleece sleeves are
generated here.
ARMS_DEBUG_BLEND=<path> saves the scene.
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

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import skin_bake  # noqa: E402
from room_scene import smooth_by_angle  # noqa: E402
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
# Back-of-hand relief (sculpt_hand_back), metres. Knuckles: (peak height,
# half width across) per finger, the middle finger's the tallest, ring and
# little smaller down the ulnar arc; crest position along the metacarpal
# from the joint centre; half length toward the wrist and onto the finger
# (shorter than across: the heads are broad, flat-topped under the
# extensor hood).
KNUCKLES = {"index": (0.0038, 0.0088), "middle": (0.0042, 0.0092), "ring": (0.0036, 0.0080),
            "pinky": (0.0029, 0.0068)}
KNUCKLE_CREST = -0.0015
KNUCKLE_SPREAD = (0.0075, 0.0055)
# The extensor hood carrying each knuckle's crown onto its finger: a low
# swell (height, centre and half length along the finger from the joint
# centre, as a share of the knuckle's width across) so the skin runs from
# knuckle to finger in a shallow saddle, not a pit.
HOOD = (0.0011, 0.0055, 0.0035, 0.75)
# The web of skin joining neighbouring knuckles, raised so the saddle
# between two knuckles is a shallow U, not a pit: (height, how far onto the
# fingers its centre sits, half length along the fingers, half width as a
# share of the knuckles' spacing).
WEB = (0.0018, 0.004, 0.006, 0.28)
# Extensor tendon ridges (height per finger; half width, doubling into the
# extensor hood over the knuckle) and the grooves between the metacarpals.
TENDONS = {"index": 0.00045, "middle": 0.00045, "ring": 0.00032, "pinky": 0.00025}
TENDON_WIDTH = 0.001
GROOVE_DEPTH = 0.0004
# How far the back of the hand sinks between wrist and knuckles, and more
# over the ring and little-finger bones.
DORSUM_SAG = 0.0008
DORSUM_FLATTEN = 0.0018
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
# The mouse the right hand holds (build_mouse): half width, half length and
# height of its shell (m), a large palm-grip mouse for the model's large
# hands; its top line's superellipse exponents in front of and behind the
# centre (2 would be an ellipse; higher keeps the buttons fuller).
MOUSE_SIZE = (0.033, 0.063, 0.042)
MOUSE_CROWN = (2.8, 2.2)
# The right hand's relaxed palm grip on the mouse: where the palm, index,
# middle finger and thumb pads touch the shell, as rays onto it in the
# mouse's own frame (glTF axes: x right, y up, z toward the typist; its
# nose is at -z). The front of the palm rests on the back of the mouse, the
# knuckles over its hump; index and middle drape along the two buttons,
# their pads a centimetre behind the front edge; the thumb pad presses the
# left flank low down, about 7.5 cm behind the nose, so the thumb curls
# along the flank instead of pointing forward; ring and little finger curl down
# until they rest on the right flank or the desk.
MOUSE_CONTACTS = {
    "palm": ((0.004, 0.1, 0.045), (0.0, -1.0, 0.0)),
    "index": ((-0.012, 0.1, -0.047), (0.0, -1.0, 0.0)),
    "middle": ((0.008, 0.1, -0.053), (0.0, -1.0, 0.0)),
    "thumb": ((-0.1, 0.014, 0.012), (1.0, 0.0, 0.0)),
}
# How far from the wrist toward the middle knuckle the palm touches the mouse.
PALM_CONTACT = 0.8
# A fingertip bone's tail sits inside the finger, this far above the pad
# that touches (hands.ts's PAD).
FINGER_PAD = 0.0055
# The thumb on the mouse (fit_thumb): its nail facing up and out from the
# flank at ~50° (mouse frame, glTF axes), the pad pressing THUMB_PRESS into
# the flank (the soft pad flattens against it); seen from above its
# proximal phalanx angles in from outside the mouse (THUMB_SPREAD, degrees
# off the mouse's long axis: mean, spread), leaving a web between thumb and
# index; MCP and IP flexion, degrees (mean, spread): the tip curls in.
THUMB_NAIL = (-1.25, 1.0, 0.0)
THUMB_PRESS = 0.002
THUMB_SPREAD = (12.0, 4.0)
THUMB_FLEX = {"mcp": (20.0, 5.0), "ip": (30.0, 4.0)}
THUMB_RADII = (0.0095, 0.0085)
# Radii of a finger at its PIP and DIP joints and fingertip bone tail, for
# resting fingers on the mouse.
FINGER_RADII = (0.0085, 0.0072, FINGER_PAD)
# Natural curl of the fingers on the mouse (as CURL): index and middle
# drape over the buttons, bending evenly at the knuckle and the middle
# joint so the middle phalanx lies on the button; ring and little finger
# curl a little more along the whole finger, converging onto the right
# edge and flank, and rest there by the knuckle. On a mouse they may
# converge or spread further (GRIP_GIVE) than on the keys.
GRIP_CURL = {"index": (26, 18, 6), "middle": (26, 22, 2), "ring": (15, 42, -1), "pinky": (20, 46, -5)}
GRIP_GIVE = (10.0, 12.0, 6.0)
# The hand on a mouse: square to it, the back of the hand arching up from a
# low wrist to the knuckles, the little-finger side ~13° lower. GRIP_WRIST
# is place_hand's soft floor for the wrist (the hand bone's head): at 36 mm
# the fit settles it ~22 mm up, its underside resting on the desk.
GRIP_PRIOR = {"yaw": (0, 6), "pitch": (20, 5), "roll": (13, 5)}
GRIP_WRIST = 0.036
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


def place_hand(arm, side, curls, targets, prior, floor, give=CURL_GIVE, anchors=(), clearance=None):
    """Rigid hand pose from which each finger reaches its target (world, for
    its tip bone's tail) with the least departure from its natural curl
    (weighted by `give`), weighed against the `prior` hand angles. The
    hand is rigid, so each finger's angle-to-fingertip response is fixed in
    hand coordinates: search turn, pitch and roll, and per candidate solve
    the wrist position by weighted least squares on the linearised angle
    changes, together with any `anchors` ((hand point relative to the wrist
    in the current hand frame, world target, tolerance in metres)). The
    wrist stays above `floor`. `clearance(frame, wrist)`, if given, adds a
    cost to the best candidates. Returns (frame, wrist)."""
    frame = anatomical_frame(arm, side)
    to_local = frame.transposed()
    wrist = arm.pose.bones[f"hand_{side}"].head.copy()
    give = Matrix.Diagonal([1 / math.radians(g) for g in give])
    fingers = []
    for finger, curl in curls.items():
        _, _, pose = finger_rig(arm, side, finger, frame)
        natural = [math.radians(a) for a in curl]
        tip = pose(*natural)[1][3]
        columns = []
        for j in range(3):
            nudged = list(natural)
            nudged[j] += 1e-3
            columns.append(to_local @ ((pose(*nudged)[1][3] - tip) / 1e-3))
        to_angles = Matrix(columns).transposed().inverted()  # hand-local tip offset -> angle change
        fingers.append((to_local @ (tip - wrist), to_angles, give @ to_angles, targets[finger], curl))
    anchors = [(to_local @ point, target, 1 / tolerance) for point, target, tolerance in anchors]

    def fit(yaw, pitch, roll):
        world = hand_frame(side, *(math.radians(a) for a in (yaw, pitch, roll)))
        inverse = world.transposed()
        rows = []
        for tip, _, weighted, target, _ in fingers:
            m = weighted @ inverse  # weighted angle change = b - m @ w
            rows.append((m, m @ target - weighted @ tip))
        for point, target, weight in anchors:
            rows.append((Matrix.Diagonal((weight, weight, weight)), (target - world @ point) * weight))
        normal, rhs = Matrix.Diagonal((0.0, 0.0, 0.0)), Vector((0.0, 0.0, 0.0))
        for m, b in rows:
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
            mean, spread = prior[name]
            cost += ((angle - mean) / spread) ** 2
        cost += (max(0.0, floor - w.z) / 0.005) ** 2
        return cost, world, w, changes, (yaw, pitch, roll)

    fits = sorted((fit(yaw, pitch, roll) for yaw in range(-20, 37, 2) for pitch in range(-10, 31, 2)
                   for roll in range(-10, 41, 2)), key=lambda r: r[0])
    if clearance:
        fits = sorted(((cost + clearance(world, w), world, w, changes, angles)
                       for cost, world, w, changes, angles in fits[:300]), key=lambda r: r[0])
    cost, world, w, changes, angles = fits[0]
    span = (arm.pose.bones[f"index_01_{side}"].head - arm.pose.bones[f"pinky_01_{side}"].head).length
    misses = [round((target - w - world @ point).length * 1000, 1) for point, target, _ in anchors]
    print(f"HAND {side} knuckle span {span * 1000:.0f}mm yaw/pitch/roll {angles} wrist {tuple(round(c, 3) for c in w)} cost {cost:.2f} "
          f"curl changes {[[round(a) for a in c] for c in changes]} anchor misses (mm) {misses}")
    return world, w


def fit_finger(arm, side, finger, frame, curl, target=None, gap=None):
    """Pose one finger from its natural `curl` (degrees): onto `target` (its
    tip bone's tail) by damped least squares over MCP, PIP and splay within
    the anatomical ranges, or, given `gap(joints)` (how far the finger's
    joints are from touching something, metres), curled or opened until it
    just rests on it. Returns the finger's flex axis."""
    bones, joints, pose = finger_rig(arm, side, finger, frame)
    rest = [b.matrix.copy() for b in bones]  # before posing moves the children
    mcp0, pip0, splay0 = curl
    limits = [tuple(math.radians(a) for a in r) for r in
              (MCP_RANGE, PIP_RANGE, (splay0 - SPLAY_RANGE, splay0 + SPLAY_RANGE))]
    params = [math.radians(a) for a in (mcp0, pip0, splay0)]
    if target is not None:
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
    else:
        # Curl at the knuckle (the middle joint following a little) until
        # the finger just touches.
        def curled(c):
            return [min(hi, max(lo, p)) for p, (lo, hi) in
                    zip((params[0] + c, params[1] + 0.3 * c, params[2]), limits)]

        lo, hi = math.radians(-25), math.radians(60)
        if gap(pose(*curled(lo))[1]) <= 0:
            hi = lo
        for _ in range(30):
            mid = (lo + hi) / 2
            lo, hi = (mid, hi) if gap(pose(*curled(mid))[1]) > 0 else (lo, mid)
        params = curled(hi)
    rotations, heads, axis = pose(*params)
    for bone, rotation, head, old_head, matrix in zip(bones, rotations, heads, joints, rest):
        bone.matrix = Matrix.Translation(head) @ rotation.to_4x4() @ Matrix.Translation(-old_head) @ matrix
        bpy.context.view_layer.update()
    mcp, pip, splay = (math.degrees(p) for p in params)
    reach = f"error {(bones[2].tail - target).length * 1000:.2f}mm" if target is not None else f"gap {gap(heads) * 1000:.1f}mm"
    print(f"FINGER {side}.{finger} mcp {mcp:.0f} pip {pip:.0f} dip {pip * DIP_RATIO:.0f} splay {splay:.0f} {reach}")
    return axis


def fit_thumb(arm, side, target, mouse, gap):
    """Pose the thumb onto `target` (its tip bone's tail) on the mouse
    (`mouse`: its rotation) with its nail (the distal bone's -Z, as
    skin_bake paints it) facing THUMB_NAIL, spread by THUMB_SPREAD, flexed
    near THUMB_FLEX and clear of what `gap(point)` measures (signed
    distance, metres), by Levenberg-Marquardt over the metacarpal's swing
    and roll at the CMC joint and the MCP and IP flexion (local +X, which
    curls the tip toward the pad)."""
    nail = (mouse @ gltf_to_blender(THUMB_NAIL)).normalized()
    forward = mouse @ gltf_to_blender((0.0, 0.0, -1.0))
    outward = mouse @ gltf_to_blender((-1.0, 0.0, 0.0))
    bones = [arm.pose.bones[f"thumb_{part:02d}_{side}"] for part in (1, 2, 3)]
    base = [b.matrix.to_3x3() for b in bones]
    cmc = bones[0].head.copy()
    lengths = [b.length for b in bones]
    local = [base[0].inverted() @ base[1], base[1].inverted() @ base[2]]

    def bend(parent, child):
        """Flexion of `child` from `parent` about the parent's +X, radians."""
        y = child.col[1] - parent.col[0] * child.col[1].dot(parent.col[0])
        return math.atan2(y.dot(parent.col[2]), y.dot(parent.col[1]))

    rest_bend = [bend(base[0], base[1]), bend(base[1], base[2])]

    def pose(params):
        swing_x, swing_z, roll, mcp, ip = params
        axis = base[0].col[0] * swing_x + base[0].col[2] * swing_z
        r1 = Matrix.Rotation(axis.length, 3, axis.normalized()) @ base[0] if axis.length > 1e-9 else base[0].copy()
        r1 = Matrix.Rotation(roll, 3, r1.col[1]) @ r1
        r2 = r1 @ local[0] @ Matrix.Rotation(mcp, 3, "X")
        r3 = r2 @ local[1] @ Matrix.Rotation(ip, 3, "X")
        joints = [cmc]
        for rotation, length in zip((r1, r2, r3), lengths):
            joints.append(joints[-1] + rotation.col[1] * length)
        return (r1, r2, r3), joints

    def residuals(params):
        rotations, joints = pose(params)
        out = list((joints[3] - target) / 0.001)
        facing = -rotations[2].col[2]
        out += list(facing.cross(nail) / 0.2) + [(1 - facing.dot(nail)) / 0.2]
        proximal = rotations[1].col[1]
        spread = math.degrees(math.atan2(proximal.dot(outward), proximal.dot(forward)))
        out.append((spread - THUMB_SPREAD[0]) / THUMB_SPREAD[1])
        for (name, (mean, spread)), rest, flex in zip(THUMB_FLEX.items(), rest_bend, params[3:]):
            out.append((math.degrees(rest + flex) - mean) / spread)
        out += [p / 0.8 for p in params[:3]]
        for k, radius in ((1, THUMB_RADII[0]), (2, THUMB_RADII[1])):
            for t in (0.35, 0.7, 1.0):
                point = joints[k] + (joints[k + 1] - joints[k]) * t
                out.append(max(0.0, radius * (1.0 if t < 1.0 else 0.9) - gap(point)) / 0.001)
        return np.array(out)

    params = np.zeros(5)
    damping = 1e-2
    current = residuals(params)
    for _ in range(200):
        jac = np.column_stack([(residuals(params + step) - current) / 1e-4 for step in np.eye(5) * 1e-4])
        delta = np.linalg.solve(jac.T @ jac + damping * np.eye(5), -jac.T @ current)
        trial = residuals(params + delta)
        if trial @ trial < current @ current:
            params, current, damping = params + delta, trial, damping * 0.5
            if np.abs(delta).max() < 1e-6:
                break
        else:
            damping *= 4.0
    rotations, joints = pose(params)
    for bone, rotation, head in zip(bones, rotations, joints):
        bone.matrix = Matrix.Translation(head) @ rotation.to_4x4()
        bpy.context.view_layer.update()
    facing = -rotations[2].col[2]
    proximal = rotations[1].col[1]
    print(f"THUMB {side} spread {math.degrees(math.atan2(proximal.dot(outward), proximal.dot(forward))):.0f} swing {math.degrees(float(np.hypot(params[0], params[1]))):.0f} roll {math.degrees(params[2]):.0f} "
          f"mcp {math.degrees(rest_bend[0] + params[3]):.0f} ip {math.degrees(rest_bend[1] + params[4]):.0f} "
          f"nail off {math.degrees(math.acos(max(-1.0, min(1.0, facing.dot(nail))))):.0f}° "
          f"error {(bones[2].tail - target).length * 1000:.2f}mm "
          f"clearance {min(gap(j) for j in joints[2:]) * 1000:.1f}mm")


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
        targets_for = {f: gltf_to_blender(home[FINGER_KEYS[side][f]]) for f in CURL}
        frame, wrist = place_hand(arm, side, CURL, targets_for, HAND_PRIOR, key_top + 0.03)
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
                flex_axes[(side, finger)] = fit_finger(arm, side, finger, frame, CURL[finger], target=pos)
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

    bake_constraints(arm, targets)
    bpy.ops.object.mode_set(mode="OBJECT")
    return flex_axes


def bake_constraints(arm, targets):
    """Bake the evaluated constrained pose into ordinary pose transforms and
    remove the constraints and their target empties."""
    matrices = {pb.name: pb.matrix.copy() for pb in arm.pose.bones}
    for pb in arm.pose.bones:
        for con in list(pb.constraints):
            pb.constraints.remove(con)
    for pb in arm.pose.bones:
        pb.matrix = matrices[pb.name]
    bpy.context.view_layer.update()
    for target in targets:
        bpy.data.objects.remove(target, do_unlink=True)


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


def build_mouse(layout):
    """The mouse the right hand holds, exported with the arms so the grip is
    authored against the exact shell: glTF node "Mouse" at its rest centre
    with MouseShell (flat base, hump toward the palm, rounded nose),
    MouseSeam (the button split) and MouseWheel. mouse.ts moves it and gives
    it its materials. Returns (root, shell)."""
    half_width, half_length, height = MOUSE_SIZE
    root = bpy.data.objects.new("Mouse", None)
    bpy.context.scene.collection.objects.link(root)
    root.location = gltf_to_blender(layout["mouse"]["restCenter"])

    def part(name, bm):
        mesh = bpy.data.meshes.new(name)
        bm.to_mesh(mesh)
        bm.free()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        obj.parent = root
        return obj

    def crown(z):
        """Height of the shell's top line at `z` (m, from the centre): a
        hump behind the centre under the palm, the buttons sloping gently
        forward and rounding over only near the nose and the tail."""
        zs = z / half_length
        exponent = MOUSE_CROWN[0] if zs < 0 else MOUSE_CROWN[1]
        hump = 0.72 + 0.28 * math.exp(-((((zs + 1) / 2 - 0.62) / 0.3) ** 2))
        return (1 - min(1.0, abs(zs)) ** exponent) ** (1 / exponent) * height * hump + 0.0015

    bm = bmesh.new()
    rows, cols = 40, 72
    rings = []
    for iy in range(rows + 1):
        theta = math.pi * iy / rows
        ring = []
        for ix in range(1 if iy in (0, rows) else cols):
            phi = 2 * math.pi * ix / cols
            x, y, z = -math.cos(phi) * math.sin(theta), math.cos(theta), math.sin(phi) * math.sin(theta)
            along = (z + 1) / 2  # 0 at the nose, 1 at the tail
            # Seen from above a squarish oval (a superellipse), so the
            # buttons stay wide up to a rounded nose instead of a point.
            circle = math.sqrt(max(0.0, 1 - z * z))
            plan = (1 - abs(z) ** 3) ** (1 / 3) / circle if circle > 1e-6 else 1.0
            width = half_width * plan * (0.82 + 0.18 * math.sin(along * math.pi * 0.95))
            # The lower hemisphere flattens into the base.
            lift = max(0.0, y) / circle if circle > 1e-6 else 0.0
            ring.append(bm.verts.new(gltf_to_blender((x * width, lift * (crown(z * half_length) - 0.0015) + 0.0015,
                                                      z * half_length))))
        rings.append(ring)
    for iy in range(rows):
        upper, lower = rings[iy], rings[iy + 1]
        for ix in range(cols):
            nxt = (ix + 1) % cols
            if iy == 0:
                bm.faces.new((upper[0], lower[nxt], lower[ix]))
            elif iy == rows - 1:
                bm.faces.new((upper[ix], upper[nxt], lower[0]))
            else:
                bm.faces.new((upper[ix], upper[nxt], lower[nxt], lower[ix]))
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    smooth_by_angle(bm, 40)
    shell = part("MouseShell", bm)

    # Button seam: a thin rod lying along the top of the front half.
    bm = bmesh.new()
    path = [(0.0, crown(z) + 0.0003, z) for z in np.linspace(-half_length * 0.94, -half_length * 0.08, 24)]
    rings = []
    for i, point in enumerate(path):
        ahead, behind = path[min(i + 1, len(path) - 1)], path[max(i - 1, 0)]
        tangent = Vector(ahead) - Vector(behind)
        tangent.normalize()
        normal = Vector((0.0, 1.0, 0.0))
        normal = (normal - tangent * normal.dot(tangent)).normalized()
        side = tangent.cross(normal)
        rings.append([bm.verts.new(gltf_to_blender(Vector(point) + 0.0007 * (math.cos(a) * normal + math.sin(a) * side)))
                      for a in np.linspace(0, 2 * math.pi, 6, endpoint=False)])
    for a, b in zip(rings, rings[1:]):
        for j in range(6):
            bm.faces.new((a[j], a[(j + 1) % 6], b[(j + 1) % 6], b[j]))
    bm.faces.new(rings[0][::-1])
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    smooth_by_angle(bm, 40)
    part("MouseSeam", bm)

    # Scroll wheel, its axle across the mouse, standing 2.5 mm proud of the
    # shell between the buttons.
    bm = bmesh.new()
    radius = 0.0095
    bmesh.ops.create_cone(bm, cap_ends=True, segments=28, radius1=radius, radius2=radius, depth=0.0065)
    wheel_z = -half_length * 0.5
    bmesh.ops.transform(bm, verts=bm.verts, matrix=Matrix.Translation(gltf_to_blender((0, crown(wheel_z) + 0.0025 - radius, wheel_z)))
                        @ Matrix.Rotation(math.pi / 2, 4, "Y"))
    smooth_by_angle(bm, 40)
    part("MouseWheel", bm)
    bpy.context.view_layer.update()
    return root, shell


def pose_mouse_grip(human, arm, mouse):
    """Pose the right hand, from the typing rest pose, in a relaxed palm grip
    on the mouse and return the grip for hands.ts in glTF axes: the hand
    bone's position and world rotation in the mouse's frame, and each hand
    bone's rotation relative to its rest. The front of the palm rests on the
    hump and the fingertip pads on MOUSE_CONTACTS; the hand is placed like
    the typing hands (place_hand), clear of the shell and the desk."""
    root, shell = mouse
    side = "r"
    bpy.context.view_layer.update()
    # The shell without its flat base (the desk stands in for it), so a point
    # beside the mouse is outside it, not under its base.
    desk = root.matrix_world.translation.z
    verts = [shell.matrix_world @ v.co for v in shell.data.vertices]
    bvh = BVHTree.FromPolygons(verts, [tuple(p.vertices) for p in shell.data.polygons
                                       if max(verts[i].z for i in p.vertices) > desk + 0.002])
    contacts = {}
    for name, (origin, direction) in MOUSE_CONTACTS.items():
        hit, normal, _, _ = bvh.ray_cast(root.matrix_world @ gltf_to_blender(origin), gltf_to_blender(direction))
        if hit is None:
            raise RuntimeError(f"Mouse contact ray for {name} missed the shell")
        pad = {"palm": 0.0, "thumb": FINGER_PAD - THUMB_PRESS}.get(name, FINGER_PAD)
        contacts[name] = hit + normal.normalized() * pad

    frame = anatomical_frame(arm, side)
    up = frame.col[2].to_3d()
    wrist = arm.pose.bones[f"hand_{side}"].head.copy()
    hand_group = human.vertex_groups[f"hand_{side}"].index
    palm = [v.co - wrist for v in human.data.vertices
            if v.normal.dot(up) < -0.5 and any(g.group == hand_group and g.weight > 0.7 for g in v.groups)]
    to_local = frame.transposed()
    reach = to_local @ ((arm.pose.bones[f"middle_01_{side}"].head - wrist) * PALM_CONTACT)
    contact = min(palm, key=lambda p: ((to_local @ p).xy - reach.xy).length)

    def surface_gap(p):
        """Signed distance from `p` to the shell or the desk (negative inside)."""
        nearest, normal, _, _ = bvh.find_nearest(p)
        return min((p - nearest).dot(normal), p.z - desk)

    def clearance(world, w):
        """Cost of the palm sinking into the shell or the desk."""
        depth = 0.0
        for p in palm[::2]:
            q = w + world @ to_local @ p
            nearest, normal, _, _ = bvh.find_nearest(q)
            depth = max(depth, (nearest - q).dot(normal), desk - q.z)
        return (depth / 0.0015) ** 2

    targeted = {f: GRIP_CURL[f] for f in ("index", "middle")}
    grip_frame, grip_wrist = place_hand(
        arm, side, targeted, contacts, GRIP_PRIOR, desk + GRIP_WRIST, give=GRIP_GIVE,
        anchors=[(contact, contacts["palm"], 0.003)], clearance=clearance)

    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")
    targets = [empty_target("_grip_wrist", grip_wrist)]
    con = arm.pose.bones["lowerarm_r"].constraints.new("IK")
    con.target = targets[0]
    con.chain_count = 2
    con.iterations = 128
    con.use_stretch = False
    bpy.context.view_layer.update()
    orient_hand(arm, side, grip_frame)
    bpy.context.view_layer.update()
    fit_thumb(arm, side, contacts["thumb"], root.matrix_world.to_3x3(), surface_gap)
    for finger, curl in GRIP_CURL.items():
        if finger in targeted:
            fit_finger(arm, side, finger, grip_frame, curl, target=contacts[finger])
        else:
            fit_finger(arm, side, finger, grip_frame, curl, gap=lambda joints: min(
                surface_gap(p) - r for p, r in zip(joints[1:], FINGER_RADII)))
    for _ in range(4):
        bpy.context.view_layer.update()
    bake_constraints(arm, targets)

    to_gltf = Matrix(((1, 0, 0), (0, 0, 1), (0, -1, 0)))
    origin = root.matrix_world.translation
    hand = arm.pose.bones[f"hand_{side}"]
    rotation = (to_gltf @ hand.matrix.to_3x3()).to_quaternion()
    bones = {}
    for finger in ("thumb", "index", "middle", "ring", "pinky"):
        for part in (1, 2, 3):
            q = arm.pose.bones[f"{finger}_{part:02d}_{side}"].matrix_basis.to_quaternion()
            bones[f"{finger}_{part:02d}_{side}"] = [round(c, 6) for c in (q.x, q.y, q.z, q.w)]

    # Report how far the posed skin sinks into the mouse.
    evaluated = human.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh()
    group_names = {g.index: g.name for g in human.vertex_groups}
    worst, where = 0.0, None
    for v, source in zip(mesh.vertices, human.data.vertices):
        q = human.matrix_world @ v.co
        if (q - origin).length < 0.2:
            depth = -surface_gap(q)
            if depth > worst:
                deforming = [g for g in source.groups if group_names[g.group] in ARM_BONES]
                worst, where = depth, max(deforming, key=lambda g: g.weight, default=None)
    evaluated.to_mesh_clear()
    print(f"GRIP skin inside the mouse or desk by up to {worst * 1000:.1f}mm"
          f" ({group_names[where.group] if where else '-'})")
    bpy.ops.object.mode_set(mode="OBJECT")
    grip = {
        "wrist": [round(c, 6) for c in to_gltf @ (hand.head - origin)],
        "hand": [round(c, 6) for c in (rotation.x, rotation.y, rotation.z, rotation.w)],
        "bones": bones,
    }
    return grip, {pb.name: pb.matrix_basis.copy() for pb in arm.pose.bones}


def add_grip_corrective(human, arm, pose):
    """Shape key "MouseGrip": rest-space offsets hands.ts blends in with the
    mouse grip. Swinging the thumb out onto the mouse's flank and turning the
    wrist, linear skinning (glTF's) pinches the thumb's fleshy base and the
    wrist into creases. Pose the grip, let a Corrective Smooth modifier
    restore the rest pose's local shape over the right hand and wrist, and
    map each vertex's correction back through its blended bone transforms."""
    mesh = human.data
    names = {g.index: g.name for g in human.vertex_groups}
    region = human.vertex_groups.new(name="_grip_fix")
    for v in mesh.vertices:
        weight = sum(g.weight for g in v.groups if names[g.group].endswith("_r") and names[g.group] in ARM_BONES
                     and names[g.group] not in ("clavicle_r", "upperarm_r"))
        if weight > 0:
            region.add([v.index], min(1.0, weight), "REPLACE")
    skinning = next(m for m in human.modifiers if m.type == "ARMATURE")
    skinning.use_deform_preserve_volume = False  # match glTF's linear skinning
    smooth = human.modifiers.new("Grip corrective", "CORRECTIVE_SMOOTH")
    smooth.rest_source = "ORCO"  # the unposed mesh
    smooth.smooth_type = "LENGTH_WEIGHTED"
    smooth.factor = 0.5
    smooth.iterations = 20
    smooth.vertex_group = region.name

    for pb in arm.pose.bones:
        pb.matrix_basis = pose[pb.name]
    bpy.context.view_layer.update()

    def evaluated():
        deps = bpy.context.evaluated_depsgraph_get()
        ev = human.evaluated_get(deps)
        out = np.empty(len(mesh.vertices) * 3, np.float32)
        ev.to_mesh().vertices.foreach_get("co", out)
        ev.to_mesh_clear()
        return out.reshape(-1, 3)

    smooth.show_viewport = False
    skinned = evaluated()
    smooth.show_viewport = True
    corrected = evaluated()
    deform = {pb.name: (pb.matrix @ pb.bone.matrix_local.inverted()).to_3x3() for pb in arm.pose.bones}
    offsets = np.zeros_like(skinned)
    for v in mesh.vertices:
        delta = Vector(corrected[v.index] - skinned[v.index])
        if delta.length < 1e-6:
            continue
        blend = Matrix.Diagonal((0.0, 0.0, 0.0))
        total = 0.0
        for g in v.groups:
            if names.get(g.group) in deform and g.weight > 0:
                blend += deform[names[g.group]] * g.weight
                total += g.weight
        if total > 0:
            offsets[v.index] = (blend * (1 / total)).inverted() @ delta
    offsets[np.linalg.norm(offsets, axis=1) < 5e-5] = 0.0  # keep the shape key sparse
    human.modifiers.remove(smooth)
    human.vertex_groups.remove(region)
    skinning.use_deform_preserve_volume = True
    clear_pose(arm)

    human.shape_key_add(name="Basis", from_mix=False)
    key = human.shape_key_add(name="MouseGrip", from_mix=False)
    base = np.empty(len(mesh.vertices) * 3, np.float32)
    mesh.vertices.foreach_get("co", base)
    key.data.foreach_set("co", base + offsets.ravel())
    moved = np.linalg.norm(offsets, axis=1)
    worst = mesh.vertices[int(moved.argmax())]
    print(f"GRIP corrective moves {int((moved > 1e-4).sum())} vertices, 90th percentile "
          f"{np.percentile(moved[moved > 1e-4], 90) * 1000:.1f}mm, up to {moved.max() * 1000:.1f}mm "
          f"({names.get(max(worst.groups, key=lambda g: g.weight).group)})")


def clear_pose(arm):
    for pb in arm.pose.bones:
        pb.matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()


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


def hand_back_frame(arm, side):
    """(wrist, forward, up, toward the little finger, wrist-to-knuckle
    reach) for sculpting the back of a hand."""
    frame = anatomical_frame(arm, side)
    forward, up = frame.col[1].to_3d(), frame.col[2].to_3d()
    wrist = arm.data.bones[f"hand_{side}"].head_local
    toward_pinky = arm.data.bones[f"pinky_01_{side}"].head_local - arm.data.bones[f"index_01_{side}"].head_local
    toward_pinky = (toward_pinky - up * toward_pinky.dot(up)).normalized()
    reach = (arm.data.bones[f"middle_01_{side}"].head_local - wrist).dot(forward)
    return wrist, forward, up, toward_pinky, reach


def refine_hand_backs(human, arm):
    """Subdivide the back of each hand once more (edges ~1.7 mm), so the
    knuckles and tendons sculpt_hand_back raises come out round instead of
    faceted; the rest of the arm keeps one subdivision. The refined patch
    ends on the flat of the hand, well inside the sculpted relief's fade."""
    bm = bmesh.new()
    bm.from_mesh(human.data)
    deform = bm.verts.layers.deform.active
    names = {g.index: g.name for g in human.vertex_groups}
    region = set()
    for side in ("l", "r"):
        wrist, forward, up, _, reach = hand_back_frame(arm, side)
        bones = {f"hand_{side}", *(f"{f}_01_{side}" for f in KNUCKLES)}
        for v in bm.verts:
            weight = sum(w for g, w in v[deform].items() if names.get(g) in bones)
            along = (v.co - wrist).dot(forward) / reach
            if weight > 0.2 and v.normal.dot(up) > -0.05 and 0.35 < along < 1.2:
                region.add(v)
    faces = [f for f in bm.faces if all(v in region for v in f.verts)]
    edges = {e for f in faces for e in f.edges}
    # Flat: at ~3.5 mm edges the smooth surface bows only ~0.1 mm between
    # vertices; the relief sculpted afterwards is what needs the density.
    # Faces along the patch's border with one edge cut split into
    # triangles fanning from the new vertex (not a pentagon with three
    # vertices in a line, which triangulates into slivers); any other
    # ngons are triangulated too (for tangents).
    bmesh.ops.subdivide_edges(bm, edges=list(edges), cuts=1, use_grid_fill=True, use_single_edge=True)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    bm.to_mesh(human.data)
    bm.free()
    human.data.update()


def sculpt_hand_back(human, arm):
    """Model the back of each hand: bony knuckles, extensor tendons, the
    grooves between the metacarpals, and a back of the hand that falls
    toward the little finger.

    MakeHuman's skin over the MCP joint sits ~6 mm above its centre, lower
    than the back of the hand behind it, and skinning flattens it further as
    the finger flexes, so the knuckles read as a collapsed shelf on an even,
    puffy dome. A real hand's metacarpal heads stand 3-5 mm proud of the
    valleys between them, oblate (~15 mm wide, ~10 mm long) and squarish on
    top; a tendon ridge 3-4 mm wide runs back from each toward the wrist,
    with shallow grooves between the bones; the back of the hand is highest
    along the index and middle bones. Everything moves the skin up from the
    back of the hand, on the dorsal side only; overlapping knuckles take the
    largest.
    """
    mesh = human.data
    mesh.update()
    group_names = {group.index: group.name for group in human.vertex_groups}
    for side in ("l", "r"):
        wrist, forward_hand, up_hand, toward_pinky, reach = hand_back_frame(arm, side)
        knuckles = {f: arm.data.bones[f"{f}_01_{side}"].head_local.copy() for f in KNUCKLES}
        mean = sum(knuckles.values(), Vector()) / len(knuckles)
        heads, tendons, webs = [], [], []
        order = list(knuckles.values())
        for a, b in zip(order, order[1:]):
            along = ((a + b) / 2 - wrist).normalized()
            webs.append(((a + b) / 2 + along * WEB[1], along, (b - a).normalized(), (b - a).length))
        for finger, centre in knuckles.items():
            along = (centre - wrist).normalized()
            up = (up_hand - along * up_hand.dot(along)).normalized()
            heads.append((centre, along.cross(up), along, *KNUCKLES[finger]))
            # Each tendon comes out from under the wrist band, where the four
            # run close together, and fans to its knuckle.
            start = wrist + (mean - wrist) * 0.15 + (centre - mean) * 0.35
            tendons.append((start, centre - start, TENDONS[finger]))
        bones = {f"hand_{side}", *(f"{f}_01_{side}" for f in KNUCKLES)}
        for vert in mesh.vertices:
            # Only the back of the hand and the finger bases, fading out
            # smoothly so the relief has no edge.
            dorsal = smoothstep(0.0, 0.5, vert.normal.dot(up_hand)) * smoothstep(
                0.15, 0.5, sum(g.weight for g in vert.groups if group_names.get(g.group) in bones))
            if dorsal <= 0.0:
                continue
            knuckle = 0.0
            for centre, lateral, along, height, width in heads:
                d = vert.co - centre
                s = d.dot(along) - KNUCKLE_CREST
                length = KNUCKLE_SPREAD[0] if s < 0 else KNUCKLE_SPREAD[1]
                r2 = (d.dot(lateral) / width) ** 2 + (s / length) ** 2
                knuckle = max(knuckle, height * math.exp(-(r2 ** 1.5)))  # flat-topped
                hood_height, hood_at, hood_length, hood_width = HOOD
                knuckle = max(knuckle, hood_height * math.exp(
                    -((d.dot(lateral) / (width * hood_width)) ** 2) - ((d.dot(along) - hood_at) / hood_length) ** 2))
            for middle, along, across, spacing in webs:
                d = vert.co - middle
                knuckle = max(knuckle, WEB[0] * math.exp(
                    -((d.dot(across) / (spacing * WEB[3])) ** 2) - (d.dot(along) / WEB[2]) ** 2))
            ridge, nearest = 0.0, math.inf
            for start, seg, height in tendons:
                t = (vert.co - start).dot(seg) / seg.length_squared
                offset = vert.co - (start + seg * min(1.0, max(0.0, t)))
                offset -= up_hand * offset.dot(up_hand)
                nearest = min(nearest, offset.length)
                # Faint where it leaves the wrist, clearest over the distal
                # metacarpal, spreading into the hood over the knuckle.
                window = smoothstep(0.3, 0.7, t) * (1 - smoothstep(0.92, 1.05, t))
                width = TENDON_WIDTH * (1 + smoothstep(0.75, 1.0, t))
                ridge = max(ridge, height * window * math.exp(-((offset.length / width) ** 2)))
            rel = vert.co - wrist
            along_hand = rel.dot(forward_hand) / reach
            # Between tendons the skin dips into the grooves over the
            # interosseous spaces (distal half of the hand only).
            groove = GROOVE_DEPTH * smoothstep(0.004, 0.009, nearest) * smoothstep(0.45, 0.65, along_hand) * (
                1 - smoothstep(0.75, 0.9, along_hand))
            flatten = (DORSUM_SAG + DORSUM_FLATTEN * smoothstep(-0.005, 0.02, rel.dot(toward_pinky))) * smoothstep(
                0.1, 0.3, along_hand) * (1 - smoothstep(0.62, 0.82, along_hand))
            # Along the back of the hand's normal, not each vertex's: where
            # the skin folds in front of a flexed knuckle, vertex normals
            # cross and would push the fold through itself.
            vert.co += up_hand * ((max(knuckle, ridge) - groove - flatten) * dorsal)


def enhance_skin_geometry(human, arm):
    """Smooth with one subdivision (two over the backs of the hands), shape
    the fingers, narrow the wrists and sculpt the backs of the hands. (Veins
    are texture detail: too fine for the mesh's resolution.)"""
    mesh = human.data
    mesh.update()
    sub = human.modifiers.new("Skin silhouette", "SUBSURF")
    sub.subdivision_type = "CATMULL_CLARK"
    sub.levels = 1
    sub.render_levels = 1
    while human.modifiers.find(sub.name) > 0:
        bpy.context.view_layer.objects.active = human
        bpy.ops.object.modifier_move_up(modifier=sub.name)
    bpy.context.view_layer.objects.active = human
    bpy.ops.object.modifier_apply(modifier=sub.name)
    refine_hand_backs(human, arm)
    mesh = human.data
    group_names = {group.index: group.name for group in human.vertex_groups}
    finger_prefixes = ("thumb_", "index_", "middle_", "ring_", "pinky_")
    # Shape the phalanges without moving any bone endpoint: taper each, keep
    # a fleshy fingertip pad and slight joint flares, and give the proximal
    # and middle phalanges a flatter back and slimmer waist (a D-shaped
    # section under the extensor hood) instead of MakeHuman's round tubes.
    # Each bone a vertex is weighted to proposes a position; they blend by
    # weight, so the shape runs continuously through the joints.
    for vert in mesh.vertices:
        influences = [(item.weight, group_names[item.group]) for item in vert.groups
                      if group_names.get(item.group, "").startswith(finger_prefixes)]
        total = sum(w for w, _ in influences)
        if total > 0.2:
            proposed = Vector()
            for weight, group_name in influences:
                bone = arm.data.bones[group_name]
                axis = (bone.tail_local - bone.head_local).normalized()
                length = (bone.tail_local - bone.head_local).length
                t = max(0.0, min(1.0, (vert.co - bone.head_local).dot(axis) / max(length, 1e-6)))
                center = bone.head_local + axis * (t * length)
                radial = vert.co - center
                part = int(group_name.split("_")[-2])
                if part == 3:
                    # Gentle taper into a rounded fingertip pad, not a point.
                    factor = 0.955 - 0.07 * t + 0.03 * math.exp(-(((t - 0.78) / 0.16) ** 2))
                else:
                    # Shafts narrowing toward the next joint, which flares
                    # only a millimetre or so (its condyles).
                    ends = math.exp(-(((t - 1.0) / 0.14) ** 2)) + (math.exp(-((t / 0.14) ** 2)) if part == 2 else 0.0)
                    factor = 0.98 - 0.14 * t + 0.035 * ends
                radial = radial * factor
                if part < 3 and not group_name.startswith("thumb_"):
                    shaft = smoothstep(0.12, 0.35, t) * (1 - smoothstep(0.7, 0.9, t))
                    dorsal = -(bone.matrix_local.to_3x3() @ Vector((0, 0, 1)))
                    dorsal = (dorsal - axis * dorsal.dot(axis)).normalized()
                    lateral = axis.cross(dorsal)
                    radial -= dorsal * max(0.0, radial.dot(dorsal)) * 0.22 * shaft
                    radial -= lateral * radial.dot(lateral) * 0.06 * shaft
                target = center + radial
                if part == 3 and t > 0.72:
                    palmward = (bone.matrix_local.to_3x3() @ Vector((0, 0, 1))).normalized()
                    target += palmward * (0.0008 * ((t - 0.72) / 0.28))
                proposed += target * weight
            vert.co = vert.co.lerp(proposed / total, smoothstep(0.2, 0.6, total))
            if total > 0.35:
                continue
        weights = {group_names[item.group]: item.weight for item in vert.groups}
        for side in ("l", "r"):
            wrist = arm.data.bones[f"hand_{side}"].head_local
            hand_weight = weights.get(f"hand_{side}", 0.0)
            fore_weight = weights.get(f"lowerarm_{side}", 0.0)
            if hand_weight + fore_weight > 0.25 and abs(vert.co.y - wrist.y) < 0.027:
                # Bring the wrist to a believable 5.5–6 cm width and taper
                # the distal forearm into it.
                blend = 1.0 - abs(vert.co.y - wrist.y) / 0.027
                vert.co.x = wrist.x + (vert.co.x - wrist.x) * (1.0 - 0.12 * blend)
    sculpt_hand_back(human, arm)
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
        "export_morph": True, "export_morph_normal": False, "export_try_sparse_sk": True, "export_lights": False, "export_cameras": False,
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
    mouse = build_mouse(layout)
    grip, grip_pose = pose_mouse_grip(human, arm, mouse)
    arm["mouseGrip"] = json.dumps(grip, separators=(",", ":"))
    clear_pose(arm)
    prune_skin(human, arm)
    enhance_skin_geometry(human, arm)
    mh_diffuse = next(n.image for n in human.data.materials[0].node_tree.nodes
                      if n.type == "TEX_IMAGE" and n.image and "diffuse" in n.image.name)
    skin_bake.anatomy_fields(human, arm)
    skin_bake.raise_nails(human)
    skin_bake.hand_weighted_uv(human)
    skin_bake.bake_skin(human, arm, mh_diffuse, size=2048, cache=CACHE_DIR)
    add_grip_corrective(human, arm, grip_pose)
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
    export_glb((*assets, *mouse[0].children, mouse[0]), arm)
    size = OUTPUT_PATH.stat().st_size
    if size > 4 * 1024 * 1024:
        raise RuntimeError(f"File budget exceeded: {size} bytes")
    print("ARMS_BUILD_RESULT", json.dumps({
        "output": str(OUTPUT_PATH), "bytes": size, "triangles": tris,
        "fingertips_gltf": finger_report(arm),
    }, sort_keys=True))


if __name__ == "__main__":
    main()
