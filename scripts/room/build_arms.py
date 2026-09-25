#!/usr/bin/env python3
"""Build the first-person arms (frontend/public/room/arms.glb), rigged, with
the touch-typing home-row pose as the bind pose, and the desk mouse the right
hand holds, with that hand's authored grip on it.

Run with Blender 5.1 and the MPFB 2.0.17 extension installed:
  blender -b -P scripts/room/build_arms.py

Body and rig come from MakeHuman/MPFB (CC0), reshaped with its hand/forearm
targets and its phalanges corrected to real proportions (FINGER_LENGTH_SCALE).
The pose curls each finger to a natural resting shape (CURL), places each
hand so those fingertips land on their home keys from layout.json, then
adjusts each finger slightly to touch its key exactly; the thumbs rest on the
space bar (fit_thumb). The mouse grip is placed the same way (GRIP_CURL,
MOUSE_CONTACTS, the thumb by fit_thumb) and stored on the rig as the
`mouseGrip` extra for hands.ts, with a MouseGrip shape key correcting the
skinning in that pose. Knuckles, tendons and finger shapes are sculpted on
the posed mesh; skin detail, nails, occlusion and textures come from
skin_bake.py; the charcoal fleece sleeves are generated here.
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
        # A smaller hand with longer fingers: MakeHuman's palm is long for
        # its fingers (wrist to knuckles ~113 mm where a real hand's ~90);
        # at full size the curled hand read as a spider on the keys and
        # overhung the mouse.
        ("hands", "hand-fingers-length-incr", 0.35),
        ("hands", "hand-scale-decr", 0.7),
        # MakeHuman's knuckles span ~73 mm; a real hand's ~60 mm, near the
        # 57 mm from A to F, so fingers rest parallel instead of converging.
        ("hands", "hand-fingers-distance-decr", 1.0),
        ("arms", "lowerarm-fat-decr", 0.6),
        ("arms", "lowerarm-muscle-incr", 0.35),
    )],
    ("hands", "measure-wrist-circ-decr", 0.45),
]
# MakeHuman's finger proportions, corrected toward real hands before posing
# (each phalanx stretched along its length: proximal, middle, distal). Its
# phalanges are near equal in length where a real finger's shrink ~1 : 0.6 :
# 0.45 (its middle joint sat too close to the knuckle, so a curled finger
# read as a stub hooked at its base); its little finger is 65% of the
# middle finger's length where a real hand's is ~76% (too short to curl
# onto its key, it reached down straight), and its middle finger outgrows
# index and ring by ~12% where real hands differ by ~5%. The fingers end
# ~1.1x the hand's breadth from the knuckle (longer, the curled fingers
# read as a spider's). Its thumb (metacarpal, then phalanges) bends at an
# MCP joint 13 mm too near the wrist, and with the longer fingers reaches
# 12 cm from its base where a real one's ~11 cm.
FINGER_LENGTH_SCALE = {"index": (1.12, 0.83, 0.73), "middle": (1.04, 0.8, 0.7), "ring": (1.08, 0.89, 0.76),
                       "pinky": (1.17, 0.97, 0.87), "thumb": (1.5, 0.78, 0.86)}
# Each finger's half width mid-way along its first phalanx (m), and how much
# it narrows per finger length (enhance_skin_geometry): its middle phalanx
# ~13%, its end phalanx ~21% narrower mid-way than its first; the index
# nearly as thick as the middle finger, the little finger a fifth thinner
# than the ring (a seventh, it read as thick as the ring). The thumb is
# ~1.2x as thick as the index finger; MakeHuman's is as thin as one.
FINGER_HALF_WIDTH = {"index": 0.0084, "middle": 0.0089, "ring": 0.0082, "pinky": 0.0066}
FINGER_TAPER = 0.38
THUMB_FULLNESS = 1.18
# The flexed middle and end joints' flat tops: the height above the finger's
# axis (share of its half width) where the crown starts to level, and how
# hard it levels.
JOINT_CROWN = (0.4, 4.0)
# Back-of-hand relief (sculpt_hand_back), metres. Knuckles: (peak height,
# half width across) per finger, the middle finger's the tallest, ring and
# little smaller down the ulnar arc; crest position along the metacarpal
# from the joint centre; half length toward the wrist and onto the finger
# (shorter than across: the heads are broad, flat-topped under the
# extensor hood). Low and wide enough that neighbours merge into one arch
# with shallow valleys: taller, the flexed heads read as marbles.
KNUCKLES = {"index": (0.00135, 0.0106), "middle": (0.0015, 0.011), "ring": (0.0012, 0.0098),
            "pinky": (0.0009, 0.0083)}
KNUCKLE_CREST = -0.0015
KNUCKLE_SPREAD = (0.0075, 0.0055)
# The extensor hood carrying each knuckle's crown onto its finger: a low
# swell (height, centre and half length along the finger from the joint
# centre, as a share of the knuckle's width across) so the skin runs from
# knuckle to finger in a shallow saddle, not a pit.
HOOD = (0.0008, 0.0055, 0.0035, 0.75)
# The web of skin joining neighbouring knuckles, raised so the saddle
# between two knuckles is a shallow U, not a pit (bent, the knuckles rise
# around it and a pit's walls face away from the light: dark dots), and
# the fingers part a third of the way along their first phalanges, not at
# the knuckles: (height, how far onto the fingers its centre sits, half
# length along the fingers, half width as a share of the knuckles' spacing).
WEB = (0.0035, 0.009, 0.014, 0.4)
# Extensor tendon ridges (height per finger; half width, doubling into the
# extensor hood over the knuckle) and the grooves between the metacarpals.
TENDONS = {"index": 0.0007, "middle": 0.0007, "ring": 0.0005, "pinky": 0.0004}
TENDON_WIDTH = 0.001
GROOVE_DEPTH = 0.0004
# How far the back of the hand sinks between wrist and knuckles, and more
# over the ring and little-finger bones.
DORSUM_SAG = 0.0008
DORSUM_FLATTEN = 0.0018
# The sleeve's cuff (build_sleeves): how far it runs back from the hem
# snug around the forearm (m), its outer radius (the forearm there is round,
# 24-27 mm), and the cloth's thickness: the outer wall rolls over at the
# hem into an inner wall that runs CUFF_TUCK back up the sleeve, past where
# prune_skin cuts the forearm off, and is closed there (a single wall read
# as a paper tube, and the forearm's cut end showed inside it). Its knit
# ribs are the fleece normal map's: ~50 of them round the cuff need ~100
# vertices (44 sampled by 32 aliased into 12 lumps). prune_skin keeps the
# forearm SKIN_TUCK up inside the cuff from its hem (the refined skin's
# ragged cut edge ends ~20 mm short of it, on average).
CUFF_LENGTH = 0.045
CUFF_RADIUS = 0.031
CUFF_THICKNESS = 0.0035
CUFF_TUCK = 0.07
SKIN_TUCK = 0.045
# Resting touch-typing curl per finger, degrees: MCP and PIP flexion, and
# splay from the hand's long axis (+ toward the little finger). The hand
# crests at its knuckles and the fingers arch down to the keys in one
# gentle C-curve, bending at the knuckle at least as much as at the middle
# joint (bent mostly at the middle joint, the seat sees a row of domed
# joints and no fingertips: a claw); curled, they fan a little, one per key
# (drawn together, the index rode over the middle finger and each hand read
# as a bunched paw).
CURL = {"index": (18, 20, -1), "middle": (20, 24, 0), "ring": (20, 24, 1), "pinky": (24, 28, 3)}
# How far a finger may comfortably depart from CURL to reach its key,
# degrees: curling or opening its MCP and PIP joints together, trading one
# against the other (which bends the finger out of its arc, into a straight
# stick or a hook), and splaying sideways (reads as wrong at once).
CURL_GIVE = (12.0, 4.0, 2.0)
# The DIP joint follows the PIP joint (they share a tendon), but a pad
# resting on a key or button presses its end joint nearly straight: at the
# free hand's two-thirds the fingertips hook under, and from the seat the
# fingers end at their middle joints. hands.ts's striking fingers bend it
# more.
DIP_RATIO = 0.3
# What the per-finger fit may use to touch its key exactly (degrees).
MCP_RANGE = (0.0, 65.0)
PIP_RANGE = (5.0, 95.0)
SPLAY_RANGE = 15.0
# How typing hands are held, degrees (mean, spread): turned in toward the
# keyboard's centre, the back of the hand rising steeply from a low wrist to
# the knuckles (level, the fingers must curl hard to get down to the keys),
# rolled a little thumb side up as a forearm rests, which lowers the little
# finger's knuckle so it curls onto its key (level, it stretched straight
# down and read as tucked under the ring finger).
HAND_PRIOR = {"yaw": (8, 8), "pitch": (22, 6), "roll": (6, 3)}
# How high the wrist joint hovers above the front-row key tops and how
# firmly (m): low, near the desk.
TYPING_WRIST = (0.01, 0.012)
# Where each fingertip bone's tail rests over its home key (m): how far
# toward the typist of the key centre (negative: past it), and how far above
# the key top there (the tail sits within ~3 mm of the pad; lower, the pad
# sinks into the cap). The tips arc with the fingers' reach: the index and
# little finger short of the centre, the long middle and ring beyond it, so
# neither pair has to curl or stretch out of the others' gentle arc.
TYPING_PADS = {"index": (0.008, 0.0014), "middle": (-0.003, 0.0), "ring": (-0.002, 0.0004), "pinky": (0.006, 0.0023)}
TYPING_TILT = math.radians(6)
# The steepest a typing fingertip's end segment may fall below level
# (degrees: limit, tolerance): the seated eye looks down on the home row
# ~46° from level, so steeper the nail turns away from it and the finger
# ends in a rounded nailless knob (the middle and ring fingers fell 69° and
# read as stubs tucked under the index).
TYPING_SLOPE = (32.0, 2.0)
# The typing thumbs (fit_thumb, as on the mouse) rest on the space bar,
# angled in toward the keyboard's centre and resting on the outer (radial)
# side of the tip, rolled so the nail faces half up, half out toward the
# other thumb (nail up, a thumb reads as a sixth finger; nail out, its bend
# lies flat along the bar and it reads straight); both joints gently bent.
# Its target must lie well within its reach: at full stretch it can only
# lie dead straight, pointing ahead like a fifth finger.
TYPING_THUMB_NAIL = (-1.0, 0.9, 0.2)
TYPING_THUMB_SPREAD = (30.0, 8.0)
TYPING_THUMB_FLEX = {"mcp": (15.0, 5.0), "ip": (20.0, 5.0)}
# How far from its base the gently bent thumb's tip bone reaches, as a
# share of its length, and how firmly (m) the hand is placed so its base
# stands that far back from the space bar (placed by the fingers alone, the
# hand sat too far back and the thumb stretched straight short of the bar).
TYPING_THUMB_REACH = 0.9
TYPING_THUMB_REACH_GIVE = 0.003
# Smoothing passes and strength over the thumb webs (smooth_thumb_webs).
THUMB_WEB_SMOOTH = (8, 0.5)
# The mouse the right hand holds (build_mouse, mouse_top): an MX Master 3S,
# 125 mm long and 84 wide across its thumb rest (a smaller, symmetric egg
# read as a featureless lump the hand swallowed). Its own frame, glTF axes:
# x right, y up, z toward the typist, the nose at -z, the origin centring
# its footprint (layout.json mouse.footprint).
MOUSE_HALF_LENGTH = 0.0625
# The shell's top line along its crest (m): the button tips low at the
# nose, rising in one long slope to a hump MOUSE_HUMP of the half length
# behind the centre, under the palm, and rounding off to the tail. The
# hump stands 49 mm to the real one's 51, 65% of the way back: the rigid
# palm can't cup round it, and 51 mm tall at 60% it held the knuckles high
# over the buttons and the fingers clawed down onto them.
MOUSE_CREST = {"nose": 0.021, "hump": 0.049, "tail": 0.031}
MOUSE_HUMP = 0.3
# The body either side of its crest line (x, m): half widths at its widest
# (the nose ~12% narrower), the superellipse exponents of its flanks (the
# right stands full, its top rolling down toward it by `roll`).
MOUSE_BODY = {"crest": 0.006, "right": 0.0355, "left": 0.03, "round_right": 2.4, "round_left": 2.6, "roll": 0.1}
# The thumb rest: a low shelf flaring out of the left flank (how far past
# the body at its widest, its height, m), from ~a quarter of the length
# back from the nose (half-length units, where it starts and where it is
# full) to the tail. The flank above it eases into it by MOUSE_SCOOP (a
# power: over 1 it meets the shelf level, a hollow the thumb lies in).
MOUSE_WING = {"flare": 0.019, "height": 0.017, "start": -0.55, "full": -0.05}
MOUSE_SCOOP = 1.6
# The scroll wheel's channel between the buttons, a third of the way back
# from the nose (centre z, half width, half length, depth, m), and the metal
# wheel in it (radius, width, how far it stands above the buttons' line).
MOUSE_CHANNEL = (-0.0206, 0.0055, 0.0145, 0.004)
MOUSE_WHEEL = (0.0105, 0.007, 0.0025)
# The side (horizontal) scroll wheel above the front of the thumb rest:
# centre z and height on the left flank, radius, width, how far it stands
# out of the flank (m).
MOUSE_THUMB_WHEEL = (-0.02, 0.038, 0.0075, 0.004, 0.0025)
# The shell stands on its feet this far above the desk (m).
MOUSE_FEET = 0.0015
# The mouse turned nose-right (degrees) in line with the right forearm,
# which reaches out to it from the shoulder: square to the desk, the hand
# bent sideways at the wrist to hold it.
MOUSE_YAW = 12.0
# The right hand's relaxed palm grip on the mouse: where the palm, index,
# middle finger and thumb pads touch the shell, as rays onto it in the
# mouse's frame. The hand runs straight along the body, the palm in line
# with the middle finger (angled across it or off to the thumb side, the
# index and palm hung over the left edge), the pads at the base of the
# fingers cupped over the rear of the hump and the knuckles just behind its
# crest (further forward, a hand this long must claw to keep its fingertips
# on the buttons); index and middle lie close either side of the wheel
# (wider, they fanned with shell showing between them), their pads 14-16 mm
# behind the nose (at the front edge the fingers hook over it); the thumb
# pad presses into the hollow above the thumb rest about mid-length; ring
# and little finger curl down until they rest on the right flank or desk.
MOUSE_CONTACTS = {
    "palm": ((0.007, 0.1, 0.038), (0.0, -1.0, 0.0)),
    "index": ((-0.005, 0.1, -0.047), (0.0, -1.0, 0.0)),
    "middle": ((0.018, 0.1, -0.049), (0.0, -1.0, 0.0)),
    "thumb": ((-0.1, 0.021, -0.008), (1.0, 0.0, 0.0)),
}
# How far from the wrist toward the middle knuckle the palm touches the
# mouse, and how deep the hollow of the palm cups over the shell there (m;
# the grip corrective presses the skin flat onto it; resting on its surface,
# the rigid palm held the knuckles high and the fingers clawed down).
PALM_CONTACT = 0.85
PALM_SINK = 0.009
# A fingertip bone's tail sits inside the finger, this far above the pad
# that touches (hands.ts's PAD).
FINGER_PAD = 0.0055
# The thumb on the mouse (fit_thumb): its nail facing up and out from the
# flank at ~50° (mouse frame, glTF axes), the pad pressing THUMB_PRESS into
# the flank (the soft pad flattens against it; the tip bone's tail aimed
# any nearer the shell than the pad's radius allows, the fit stopped short
# of it, the thumb floating off the flank); seen from above its proximal
# phalanx angles in from outside the mouse (THUMB_SPREAD, degrees off the
# mouse's long axis: mean, spread), leaving a web between thumb and index;
# MCP and IP flexion, degrees (mean, spread): the tip curls in.
THUMB_NAIL = (-1.25, 1.0, 0.0)
THUMB_PRESS = 0.0035
THUMB_SPREAD = (12.0, 4.0)
THUMB_FLEX = {"mcp": (20.0, 5.0), "ip": (30.0, 4.0)}
THUMB_RADII = (0.0105, 0.0092)
# How close along its length the thumb lies to the flank (m, a soft pull):
# drawn only at its pad, it touched with the tip and stood off the shell
# along the rest, a prong with lit desk between it and the mouse.
THUMB_LIE = 0.003
# Radii of a finger at its PIP and DIP joints and fingertip bone tail, for
# resting fingers on the mouse.
FINGER_RADII = (0.0088, 0.0076, FINGER_PAD)
# Natural curl of the fingers on the mouse (as CURL): index and middle
# lie side by side, draped down the buttons' slope from knuckles up on the
# hump, bent mostly at the knuckle and gently at the middle joint; ring
# and little finger curl further, drawn in against the middle finger
# (fanned, they splay off the mouse's side), onto the right edge and
# flank, and rest there by the knuckle. On a mouse they may curl or open
# further (GRIP_GIVE) than on the keys.
GRIP_CURL = {"index": (14, 10, 1), "middle": (14, 12, 0), "ring": (34, 40, -8), "pinky": (36, 44, -14)}
GRIP_GIVE = (10.0, 6.0, 3.0)
# The hand on a mouse: square to it (MOUSE_YAW), the back of the hand
# rising steeply from the wrist to knuckles up over the hump, the
# little-finger side ~13° lower. GRIP_WRIST is place_hand's soft floor for
# the wrist (the hand bone's head); the palm presses at most GRIP_PRESS
# into the shell and the desk (the hand is raised until it does; the grip
# corrective flattens the pad against them): over a centimetre into the
# shell, as a soft palm's hollow cups a mouse's hump (at 4 mm the rigid palm
# held the knuckles high, the fingers clawed down to the buttons and the
# wrist and forearm floated off the desk).
GRIP_PRIOR = {"yaw": (-MOUSE_YAW, 6), "pitch": (26, 4), "roll": (13, 5)}
GRIP_WRIST = 0.022
GRIP_PRESS = (0.014, 0.003)
# The share of the knuckles' sculpted relief (sculpt_hand_back) the grip
# corrective takes back.
GRIP_KNUCKLE_SOFTEN = 0.45
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
    """Rescale the phalanges in FINGER_LENGTH_SCALE along their length:
    each phalanx bone and the skin weighted to it change length along the
    phalanx, and the joints beyond it move with it."""
    moves = {}  # bone name -> (head, axis, length, scale, shift of its head)
    for side in ("l", "r"):
        for finger, scales in FINGER_LENGTH_SCALE.items():
            shift = Vector()
            for part, scale in zip((1, 2, 3), scales):
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


def place_hand(arm, side, curls, targets, prior, floor, give=CURL_GIVE, anchors=(), lift=None, height=None, slope=None):
    """Rigid hand pose from which each finger reaches its target (world, for
    its tip bone's tail) with the least departure from its natural curl
    (weighted by `give`), weighed against the `prior` hand angles. The
    hand is rigid, so each finger's angle-to-fingertip response is fixed in
    hand coordinates: search turn, pitch and roll, and per candidate solve
    the wrist position by weighted least squares on the linearised angle
    changes, together with any `anchors` ((hand point relative to the wrist
    in the current hand frame, world target, tolerance in metres)) and the
    wrist `height` ((world z, tolerance in metres)), if given. The wrist
    stays above `floor`. `lift(frame, wrist)`, if given, is how far the
    best candidates' wrists must rise to clear something; they are raised
    and costed there (the fingers reaching further down). `slope` ((degrees,
    tolerance)), if given, is the steepest each fingertip's end segment
    should fall below level. Returns (frame, wrist)."""
    frame = anatomical_frame(arm, side)
    to_local = frame.transposed()
    wrist = arm.pose.bones[f"hand_{side}"].head.copy()
    # Departures are weighed as (curl: MCP and PIP together, shape: MCP
    # against PIP, splay).
    give = Matrix.Diagonal([1 / math.radians(g) for g in give]) @ Matrix(((0.5, 0.5, 0), (0.5, -0.5, 0), (0, 0, 1)))
    rigs = {finger: finger_rig(arm, side, finger, frame)[2] for finger in curls}
    natural = {finger: Vector([math.radians(a) for a in curl]) for finger, curl in curls.items()}
    ranges = [tuple(math.radians(a) for a in r) for r in (MCP_RANGE, PIP_RANGE)] + [(-math.pi, math.pi)]

    def linearise(about):
        """Each finger's tip and angle response about the angles `about`,
        and its end segment's direction and response (hand-local)."""
        fingers = []
        for finger, curl in curls.items():
            base = about[finger]

            def ends(angles):
                heads = rigs[finger](*angles)[1]
                return heads[3], to_local @ (heads[3] - heads[2]).normalized()

            tip, distal = ends(base)
            columns, turns = [], []
            for j in range(3):
                nudged = list(base)
                nudged[j] += 1e-3
                moved, turned = ends(nudged)
                columns.append(to_local @ ((moved - tip) / 1e-3))
                turns.append((turned - distal) / 1e-3)
            to_angles = Matrix(columns).transposed().inverted()  # hand-local tip offset -> angle change
            fingers.append((to_local @ (tip - wrist), to_angles, give @ to_angles, targets[finger], curl,
                            base - natural[finger], (distal, Matrix(turns).transposed())))
        return fingers

    anchors = [(to_local @ point, target, 1 / tolerance) for point, target, tolerance in anchors]

    def fit(fingers, yaw, pitch, roll, raise_by=None):
        world = hand_frame(side, *(math.radians(a) for a in (yaw, pitch, roll)))
        inverse = world.transposed()
        rows = []
        for tip, _, weighted, target, _, offset, _ in fingers:
            m = weighted @ inverse  # weighted angle change = b - m @ w
            rows.append((m, m @ target - weighted @ tip + give @ offset))
        for point, target, weight in anchors:
            rows.append((Matrix.Diagonal((weight, weight, weight)), (target - world @ point) * weight))
        if height:
            rows.append((Matrix.Diagonal((0.0, 0.0, 1 / height[1])), Vector((0.0, 0.0, height[0] / height[1]))))
        normal, rhs = Matrix.Diagonal((0.0, 0.0, 0.0)), Vector((0.0, 0.0, 0.0))
        for m, b in rows:
            normal += m.transposed() @ m
            rhs += m.transposed() @ b
        w = normal.inverted() @ rhs
        if raise_by:
            w.z += raise_by(world, w)
        cost = sum((b - m @ w).length_squared for m, b in rows)
        changes = []
        for tip, to_angles, _, target, curl, offset, (distal, turns) in fingers:
            turn = to_angles @ (inverse @ (target - w) - tip)
            change = [math.degrees(a) for a in offset + turn]
            changes.append(change)
            cost += (max(0.0, 2.0 - curl[0] - change[0]) / 1.0) ** 2  # no MCP hyperextension
            cost += (max(0.0, 8.0 - curl[1] - change[1]) / 1.0) ** 2
            if slope:
                end = world @ (distal + turns @ turn)
                fall = math.degrees(math.asin(max(-1.0, min(1.0, -end.z / end.length))))
                cost += (max(0.0, fall - slope[0]) / slope[1]) ** 2
        for name, angle in (("yaw", yaw), ("pitch", pitch), ("roll", roll)):
            mean, spread = prior[name]
            cost += ((angle - mean) / spread) ** 2
        cost += (max(0.0, floor - w.z) / 0.005) ** 2
        return cost, world, w, changes, (yaw, pitch, roll)

    # A fingertip moves along arcs, so its response linearised about the
    # natural curl misjudges large changes (a finger the fit bends 20° more
    # at the knuckle may, posed exactly, straighten instead): relinearise
    # about the best fit's angles and search again.
    about = natural
    for _ in range(4):
        fingers = linearise(about)
        fits = sorted((fit(fingers, yaw, pitch, roll) for yaw in range(-36, 37, 2) for pitch in range(-10, 31, 2)
                       for roll in range(-10, 41, 2)), key=lambda r: r[0])
        if lift:
            fits = sorted((fit(fingers, *angles, lift) for *_, angles in fits[:150]), key=lambda r: r[0])
        cost, world, w, changes, angles = fits[0]
        about = {finger: Vector([min(hi, max(lo, a + math.radians(c))) for a, c, (lo, hi) in zip(natural[finger], change, ranges)])
                 for finger, change in zip(curls, changes)}
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


def fit_thumb(arm, side, target, axes, gap, nail=THUMB_NAIL, spread=THUMB_SPREAD, flex=THUMB_FLEX, press=0.0, lie=None):
    """Pose the thumb onto `target` (its tip bone's tail) with its nail (the
    distal bone's -Z, as skin_bake paints it) facing `nail`, its proximal
    phalanx turned `spread` (degrees: mean, spread) from forward toward the
    thumb's side, MCP and IP flexion near `flex` and clear of what
    `gap(point)` measures (signed distance, metres; the pad at the tip may
    press `press` into it; given `lie` (metres), its phalanges are drawn
    to within that of touching it along their length), by Levenberg-Marquardt
    over the metacarpal's swing and roll at the CMC joint and the MCP and IP
    flexion (local +X, which curls the tip toward the pad). `nail` is in
    glTF axes of a frame whose -Z is forward and -X the thumb's side;
    `axes` takes that frame to the world (a reflection for a left hand)."""
    nail = (axes @ gltf_to_blender(nail)).normalized()
    forward = axes @ gltf_to_blender((0.0, 0.0, -1.0))
    outward = axes @ gltf_to_blender((-1.0, 0.0, 0.0))
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
        out += list(facing.cross(nail) / 0.12) + [(1 - facing.dot(nail)) / 0.12]
        proximal = rotations[1].col[1]
        out.append((math.degrees(math.atan2(proximal.dot(outward), proximal.dot(forward))) - spread[0]) / spread[1])
        for (mean, width), rest, bent in zip(flex.values(), rest_bend, params[3:]):
            out.append((math.degrees(rest + bent) - mean) / width)
        # Swinging the metacarpal far from its rest strains the hand; rolling
        # it is the thumb's own opposition, freer.
        out += [params[0] / 0.8, params[1] / 0.8, params[2] / 1.6]
        for k, radius, give in ((1, THUMB_RADII[0], 0.0), (2, THUMB_RADII[1], press)):
            for t in (0.35, 0.7, 1.0):
                point = joints[k] + (joints[k + 1] - joints[k]) * t
                out.append(max(0.0, radius * (1.0 if t < 1.0 else 0.9) - give - gap(point)) / 0.001)
                if lie:
                    out.append(max(0.0, gap(point) - radius) / lie)
        return np.array(out)

    def solve(params):
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
        return current @ current, params

    # From several starting rolls: rolling the thumb far enough to turn its
    # nail swings its tip off target on the way, a valley one start can't
    # cross.
    _, params = min((solve(np.array([0.0, 0.0, roll, 0.0, 0.0])) for roll in (-1.2, -0.6, 0.0, 0.6, 1.2)),
                    key=lambda r: r[0])
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
    # Each fingertip bone's tail over its home key: the thumbs' on the space
    # bar, the fingers' where TYPING_PADS rests them on the tilted key tops.
    def back(finger):
        if finger == "thumb":
            return Vector()
        away, lift = TYPING_PADS[finger]
        return Vector((0.0, -away, lift - away * math.sin(TYPING_TILT)))

    pads = {(side, f): gltf_to_blender(home[key]) + back(f)
            for side, mapping in FINGER_KEYS.items() for f, key in mapping.items()}
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
        targets_for = {f: pads[(side, f)] for f in CURL}
        # The thumb's base anchored where, gently bent and angled in by its
        # spread, the thumb reaches its place on the space bar.
        thumb = [arm.pose.bones[f"thumb_{part:02d}_{side}"] for part in (1, 2, 3)]
        inward = math.radians(TYPING_THUMB_SPREAD[0]) * (1 if side == "l" else -1)
        base = pads[(side, "thumb")] + gltf_to_blender((-math.sin(inward), 0.0, math.cos(inward))) * (
            TYPING_THUMB_REACH * sum(b.length for b in thumb))
        cmc = (thumb[0].head - arm.pose.bones[f"hand_{side}"].head, base, TYPING_THUMB_REACH_GIVE)
        frame, wrist = place_hand(arm, side, CURL, targets_for, HAND_PRIOR, key_top, anchors=[cmc],
                                  height=(key_top + TYPING_WRIST[0], TYPING_WRIST[1]), slope=TYPING_SLOPE)
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
        for finger in mapping:
            pos = pads[(side, finger)]
            finger_targets[(side, finger)] = pos
            if finger == "thumb":
                # The frame's -X is the thumb's side: +X for a left hand.
                axes = Matrix.Diagonal((-1.0, 1.0, 1.0)) if side == "l" else Matrix.Identity(3)
                fit_thumb(arm, side, pos, axes, lambda p: p.z - key_top,
                          TYPING_THUMB_NAIL, TYPING_THUMB_SPREAD, TYPING_THUMB_FLEX)
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
    smooth_thumb_webs(human)
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    human.select_set(False)
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    mod = human.modifiers.new("ArmsRig", "ARMATURE")
    mod.object = arm
    mod.use_deform_preserve_volume = True


def smooth_thumb_webs(human):
    """Relax the skin where each thumb's metacarpal blends into the hand:
    swinging the thumb in to the space bar, linear skinning folds the web
    between thumb and index into a pinched notch (it read as a crease cut
    into the hand). Laplacian smoothing weighted to the blend (strongest
    where the thumb and hand share a vertex half and half), which fills the
    fold and leaves the skin either side as it was."""
    mesh = human.data
    count = len(mesh.vertices)
    names = {g.index: g.name for g in human.vertex_groups}
    mask = np.zeros(count)
    for v in mesh.vertices:
        w = sum(g.weight for g in v.groups if names[g.group].startswith(("thumb_01_", "thumb_02_")))
        weight = sum(g.weight for g in v.groups if names[g.group] in ARM_BONES)
        if weight > 0:
            share = min(1.0, w / weight)
            mask[v.index] = 4 * share * (1 - share)
    edges = np.array([e.vertices[:] for e in mesh.edges])
    degree = np.bincount(edges.ravel(), minlength=count).astype(float)
    co = np.array([v.co[:] for v in mesh.vertices])
    for _ in range(THUMB_WEB_SMOOTH[0]):
        total = np.zeros_like(co)
        np.add.at(total, edges[:, 0], co[edges[:, 1]])
        np.add.at(total, edges[:, 1], co[edges[:, 0]])
        mean = total / np.maximum(degree, 1)[:, None]
        co += (THUMB_WEB_SMOOTH[1] * mask)[:, None] * (mean - co)
    for v, p in zip(mesh.vertices, co):
        v.co = p
    mesh.update()


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


def round_off(u, exponent):
    """A superellipse's fall from 1 at `u` = 0 to 0 at `u` = 1 and beyond."""
    return (1 - np.clip(u, 0.0, 1.0) ** exponent) ** (1 / exponent)


def mouse_top(x, z):
    """Height of the mouse's shell above its feet over (x, z) (arrays, m,
    its frame; 0 off it): the body, sloping from low button tips up to a hump
    behind the middle and rolling off to the right, the thumb rest flaring
    from its left flank, the wheel's channel and the buttons' shallow
    finger dishes."""
    body, crest = MOUSE_BODY, MOUSE_CREST
    zn = np.clip(z / MOUSE_HALF_LENGTH, -1.0, 1.0)
    rise = np.sin(np.pi / 2 * np.clip((zn + 1) / (MOUSE_HUMP + 1), 0.0, 1.0)) ** 1.4
    fall = np.clip((zn - MOUSE_HUMP) / (1 - MOUSE_HUMP), 0.0, 1.0) ** 2
    top = np.where(zn < MOUSE_HUMP, crest["nose"] + (crest["hump"] - crest["nose"]) * rise,
                   crest["hump"] - (crest["hump"] - crest["tail"]) * fall)
    # The nose drops steeply into a front face under the button tips, the
    # tail rounds; seen from above both ends are squarish ovals, so the
    # buttons stay wide up to a rounded nose.
    front = zn < 0
    top = top * round_off(np.abs(zn), np.where(front, 5.0, 3.0))
    plan = round_off(np.abs(zn), np.where(front, 3.2, 2.2)) * (0.88 + 0.12 * np.exp(-((zn - 0.25) / 0.8) ** 2))
    dx = x - body["crest"]
    right = dx > 0
    width = np.maximum(plan, 1e-6) * np.where(right, body["right"], body["left"])
    across = np.clip(np.abs(dx) / width, 0.0, 1.0)
    # The thumb rest: a low shelf flaring out of the left flank, growing in
    # from the front and running out round the tail with the body; the flank
    # above falls into it with a level tangent, a hollow for the thumb.
    wing = MOUSE_WING
    grow = np.clip((zn - wing["start"]) / (wing["full"] - wing["start"]), 0.0, 1.0)
    grow = np.where(right | (np.abs(z) >= MOUSE_HALF_LENGTH), 0.0, grow * grow * (3 - 2 * grow))
    shelf = np.minimum(wing["height"] * grow, 0.6 * top)
    ease = 1 / body["round_left"] + (MOUSE_SCOOP - 1 / body["round_left"]) * grow
    flank = np.where(right, top * round_off(across, body["round_right"]) * (1 - body["roll"] * across ** 2),
                     shelf + (top - shelf) * (1 - across ** body["round_left"]) ** ease)
    out = np.maximum(np.abs(dx) - width, 0.0) / np.maximum(wing["flare"] * grow * plan, 1e-6)
    height = np.where(np.abs(dx) < width, flank, shelf * round_off(out, 3.0))
    cz, cw, cl, depth = MOUSE_CHANNEL
    height -= depth / (1 + (dx / cw) ** 8) / (1 + ((z - cz) / cl) ** 8)
    for side in (-1, 1):
        height -= 0.001 * np.exp(-((dx - side * 0.0135) / 0.011) ** 2 - ((z + 0.04) / 0.018) ** 2)
    return np.maximum(height, 0.0)


def mouse_surface(x, z, lift=0.0):
    """Shell points (glTF axes, the mouse's frame) over plan points (x, z),
    `lift` out along the surface normal, and the normals."""
    x, z = np.asarray(x, dtype=float), np.asarray(z, dtype=float)
    y = mouse_top(x, z) + MOUSE_FEET
    e = 1e-4
    slope_x = (mouse_top(x + e, z) - mouse_top(x - e, z)) / (2 * e)
    slope_z = (mouse_top(x, z + e) - mouse_top(x, z - e)) / (2 * e)
    normal = np.stack([-slope_x, np.ones_like(y), -slope_z], -1)
    normal /= np.linalg.norm(normal, axis=-1, keepdims=True)
    return np.stack([x, y, z], -1) + lift * normal, normal


def along_surface(plan, count):
    """`count` points spaced evenly over the shell along a plan polyline."""
    points = mouse_surface(plan[:, 0], plan[:, 1])[0]
    run = np.concatenate([[0.0], np.cumsum(np.linalg.norm(np.diff(points, axis=0), axis=1))])
    even = np.linspace(0.0, run[-1], count)
    return np.stack([np.interp(even, run, plan[:, 0]), np.interp(even, run, plan[:, 1])], -1)


def build_mouse(layout):
    """The mouse the right hand holds, exported with the arms so the grip is
    authored against the exact shell: glTF node "Mouse" at its rest centre,
    turned MOUSE_YAW, with MouseShell (mouse_top on its feet, a flat base),
    MouseSeam (the button splits and the wheel's channel, dark) and
    MouseWheel (the scroll wheel and the side wheel, metal). mouse.ts moves
    it and gives it its materials. Returns (root, shell)."""
    root = bpy.data.objects.new("Mouse", None)
    bpy.context.scene.collection.objects.link(root)
    root.location = gltf_to_blender(layout["mouse"]["restCenter"])
    root.rotation_euler = (0.0, 0.0, -math.radians(MOUSE_YAW))

    def part(name, bm):
        mesh = bpy.data.meshes.new(name)
        bm.to_mesh(mesh)
        bm.free()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        obj.parent = root
        return obj

    def vert(bm, point):
        return bm.verts.new(gltf_to_blender(point))

    # The shell as rings about the hump: each ray from it runs over the top
    # and down the flank to the edge, its vertices spaced evenly along the
    # surface (the flanks fall steeply over the last millimetres of plan),
    # the rays spaced evenly around the edge.
    hump = np.array([MOUSE_BODY["crest"], MOUSE_HUMP * MOUSE_HALF_LENGTH])

    def edge(angles):
        """Plan directions from the hump and the distance to the shell's edge along each."""
        dirs = np.stack([np.cos(angles), np.sin(angles)], -1)
        steps = np.linspace(0.0, 0.12, 1201)
        points = hump + dirs[:, None, :] * steps[None, :, None]
        first_out = np.argmin(mouse_top(points[..., 0], points[..., 1]) > 0, axis=1)
        lo, hi = steps[first_out - 1], steps[first_out]
        for _ in range(24):
            mid = (lo + hi) / 2
            points = hump + dirs * mid[:, None]
            inside = mouse_top(points[:, 0], points[:, 1]) > 0
            lo, hi = np.where(inside, mid, lo), np.where(inside, hi, mid)
        return dirs, lo

    fine = np.linspace(0.0, 2 * np.pi, 2049)
    dirs, reach = edge(fine)
    run = np.concatenate([[0.0], np.cumsum(np.linalg.norm(np.diff(dirs * reach[:, None], axis=0), axis=1))])
    around, rows = 160, 56
    dirs, reach = edge(np.interp(np.linspace(0.0, run[-1], around, endpoint=False), run, fine))
    radii = reach[:, None] * (1 - (1 - np.linspace(0.0, 1.0, 900)) ** 3)
    heights = mouse_top(hump[0] + dirs[:, :1] * radii, hump[1] + dirs[:, 1:] * radii)
    run = np.concatenate([np.zeros((around, 1)), np.cumsum(np.hypot(np.diff(radii), np.diff(heights)), axis=1)], axis=1)
    share = np.linspace(0.0, 1.0, rows + 1)[1:]
    bm = bmesh.new()
    pole = vert(bm, (hump[0], float(mouse_top(hump[0], hump[1])) + MOUSE_FEET, hump[1]))
    base = vert(bm, (hump[0], MOUSE_FEET, hump[1]))
    grid = []
    for direction, radii_i, run_i in zip(dirs, radii, run):
        r = np.interp(share * run_i[-1], run_i, radii_i)
        x, z = hump[0] + direction[0] * r, hump[1] + direction[1] * r
        y = mouse_top(x, z) + MOUSE_FEET
        y[-1] = MOUSE_FEET
        grid.append([vert(bm, p) for p in zip(x, y, z)])
    for i, ray in enumerate(grid):
        nxt = grid[(i + 1) % around]
        bm.faces.new((pole, ray[0], nxt[0]))
        for k in range(rows - 1):
            bm.faces.new((ray[k], ray[k + 1], nxt[k + 1], nxt[k]))
        bm.faces.new((ray[-1], base, nxt[-1]))
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    smooth_by_angle(bm, 40)
    shell = part("MouseShell", bm)

    # The seams: dark strips lying on the shell, the split between the
    # buttons from the nose to the wheel's channel, the buttons' back edges
    # sweeping from behind the wheel out and back to the flanks, and the
    # channel's lining.
    bm = bmesh.new()

    def strip(plan, width=0.0009, lift=0.0003):
        plan = along_surface(plan, 80)
        tangent = np.gradient(plan, axis=0)
        tangent /= np.linalg.norm(tangent, axis=1, keepdims=True)
        offset = np.stack([-tangent[:, 1], tangent[:, 0]], -1) * width / 2
        sides = [mouse_surface(*(plan + s).T, lift) for s in (-offset, offset)]
        verts = [[vert(bm, p) for p in points] for points, _ in sides]
        for k in range(len(plan) - 1):
            bm.faces.new((verts[0][k], verts[0][k + 1], verts[1][k + 1], verts[1][k]))

    crest = MOUSE_BODY["crest"]
    cz, cw, cl, depth = MOUSE_CHANNEL
    ahead = np.linspace(-MOUSE_HALF_LENGTH, cz - cl, 600)
    nose = ahead[np.argmax(mouse_top(np.full_like(ahead, crest), ahead) > 0.004)]
    strip(np.stack([np.full_like(ahead, crest), np.linspace(nose, cz - cl - 0.0008, 600)], -1))
    sweep = np.linspace(0.0, 1.0, 300)
    for side, reach in ((-1, MOUSE_BODY["left"] * 0.78), (1, MOUSE_BODY["right"] * 0.72)):
        strip(np.stack([crest + side * (cw + 0.0012 + sweep * (reach - cw)), cz + cl + 0.003 + 0.013 * sweep ** 1.6], -1))
    strip(np.stack([crest + np.linspace(-cw - 0.0012, cw + 0.0012, 60), np.full(60, cz + cl + 0.003)], -1))
    theta = np.linspace(0.0, 2 * np.pi, 48, endpoint=False)
    lining = np.stack([np.sign(np.cos(theta)) * np.abs(np.cos(theta)) ** 0.5 * cw * 1.15,
                       np.sign(np.sin(theta)) * np.abs(np.sin(theta)) ** 0.5 * cl * 1.06], -1)
    rings = [[vert(bm, p) for p in mouse_surface(crest + lining[:, 0] * q, cz + lining[:, 1] * q, 0.0002)[0]]
             for q in np.linspace(0.15, 1.0, 7)]
    middle = vert(bm, mouse_surface(crest, cz, 0.0002)[0])
    for j in range(48):
        bm.faces.new((middle, rings[0][j], rings[0][(j + 1) % 48]))
        for inner, outer in zip(rings, rings[1:]):
            bm.faces.new((inner[j], outer[j], outer[(j + 1) % 48], inner[(j + 1) % 48]))
    # Everything lies on a height field, so every face looks up.
    bm.normal_update()
    for face in bm.faces:
        if face.normal.z < 0:
            face.normal_flip()
    smooth_by_angle(bm, 40)
    part("MouseSeam", bm)

    # The wheels, knurled metal: the scroll wheel across the channel, its top
    # MOUSE_WHEEL's last value above the buttons' line, and the side wheel
    # standing out of the left flank above the thumb rest, turning about the
    # flank's upward line.
    bm = bmesh.new()

    def wheel(centre, axis, out, radius, width):
        across = np.cross(axis, out)
        rings = []
        for offset, r in ((-width / 2, radius - 0.0008), (-width / 2 + 0.0007, radius), (width / 2 - 0.0007, radius),
                          (width / 2, radius - 0.0008)):
            ring = []
            for k in range(72):
                a = 2 * np.pi * k / 72
                knurl = 0.0003 if k % 2 and r == radius else 0.0
                ring.append(vert(bm, centre + axis * offset + (r - knurl) * (np.cos(a) * out + np.sin(a) * across)))
            rings.append(ring)
        for ring, nxt in zip(rings, rings[1:]):
            for k in range(72):
                bm.faces.new((ring[k], ring[(k + 1) % 72], nxt[(k + 1) % 72], nxt[k]))
        for ring, offset in ((rings[0], -width / 2), (rings[-1], width / 2)):
            hub = vert(bm, centre + axis * offset)
            for k in range(72):
                bm.faces.new((hub, ring[(k + 1) % 72], ring[k]))

    radius, width, proud = MOUSE_WHEEL
    wheel_y = float(mouse_top(crest, cz)) + depth + proud - radius + MOUSE_FEET
    wheel(np.array([crest, wheel_y, cz]), np.array([1.0, 0.0, 0.0]), np.array([0.0, 1.0, 0.0]), radius, width)
    tz, ty, radius, width, proud = MOUSE_THUMB_WHEEL
    xs = np.linspace(crest, -0.05, 2000)
    flank = xs[np.argmax(mouse_top(xs, np.full_like(xs, tz)) + MOUSE_FEET < ty)]
    point, normal = mouse_surface(flank, tz)
    axis = np.array([0.0, 1.0, 0.0]) - normal * normal[1]
    wheel(point - normal * (radius - proud), axis / np.linalg.norm(axis), normal, radius, width)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
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
        hit, normal, _, _ = bvh.ray_cast(root.matrix_world @ gltf_to_blender(origin),
                                         root.matrix_world.to_3x3() @ gltf_to_blender(direction))
        if hit is None:
            raise RuntimeError(f"Mouse contact ray for {name} missed the shell")
        pad = {"palm": -PALM_SINK, "thumb": 0.9 * THUMB_RADII[1] - THUMB_PRESS}.get(name, FINGER_PAD)
        contacts[name] = hit + normal.normalized() * pad

    frame = anatomical_frame(arm, side)
    up = frame.col[2].to_3d()
    wrist = arm.pose.bones[f"hand_{side}"].head.copy()
    hand_group = human.vertex_groups[f"hand_{side}"].index

    def underside(weight):
        return [v.co - wrist for v in human.data.vertices
                if v.normal.dot(up) < -0.2 and any(g.group == hand_group and g.weight > weight for g in v.groups)]

    palm = underside(0.7)
    # The heel of the hand blends into the forearm's weights, and the pads
    # under the knuckles face forward as much as down; left out, they sink
    # into the mouse's back unseen.
    heel = underside(0.3)
    to_local = frame.transposed()
    reach = to_local @ ((arm.pose.bones[f"middle_01_{side}"].head - wrist) * PALM_CONTACT)
    contact = min(palm, key=lambda p: ((to_local @ p).xy - reach.xy).length)

    def surface(p):
        """Signed distance from `p` to the shell or the desk (negative
        inside), and the way out."""
        nearest, normal, _, _ = bvh.find_nearest(p)
        shell = (p - nearest).dot(normal)
        return (shell, normal) if shell < p.z - desk else (p.z - desk, Vector((0.0, 0.0, 1.0)))

    def surface_gap(p):
        """Signed distance from `p` to the shell or the desk (negative inside)."""
        return surface(p)[0]

    def lift(world, w):
        """How far the wrist must rise for the palm to rest on the shell and
        the desk, pressing into them at most GRIP_PRESS (soft tissue)."""
        points = [w + world @ to_local @ p for p in heel]
        raised = 0.0
        for _ in range(4):
            need = 0.0
            for q in points:
                q = q + Vector((0.0, 0.0, raised))
                nearest, normal, _, _ = bvh.find_nearest(q)
                need = max(need, ((nearest - q).dot(normal) - GRIP_PRESS[0]) / max(normal.z, 0.35), desk + GRIP_PRESS[1] - q.z)
            if need <= 1e-4:
                break
            raised += need
        return raised

    targeted = {f: GRIP_CURL[f] for f in ("index", "middle")}
    grip_frame, grip_wrist = place_hand(
        arm, side, targeted, contacts, GRIP_PRIOR, desk + GRIP_WRIST, give=GRIP_GIVE,
        anchors=[(contact, contacts["palm"], 0.003)], lift=lift)

    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")
    targets = [empty_target("_grip_wrist", grip_wrist)]
    con = arm.pose.bones["lowerarm_r"].constraints.new("IK")
    con.target = targets[0]
    con.chain_count = 2
    con.iterations = 128
    con.use_stretch = False
    bpy.context.view_layer.update()
    # Freeze the arm where the IK put it before posing the hand on it: left
    # live, the chain settles further as the digits are fitted and carries
    # them off their contacts.
    bake_constraints(arm, targets)
    orient_hand(arm, side, grip_frame)
    bpy.context.view_layer.update()
    fit_thumb(arm, side, contacts["thumb"], root.matrix_world.to_3x3(), surface_gap, press=THUMB_PRESS, lie=THUMB_LIE)
    for finger, curl in GRIP_CURL.items():
        if finger in targeted:
            fit_finger(arm, side, finger, grip_frame, curl, target=contacts[finger])
        else:
            fit_finger(arm, side, finger, grip_frame, curl, gap=lambda joints: min(
                surface_gap(p) - r for p, r in zip(joints[1:], FINGER_RADII)))
    bpy.context.view_layer.update()
    hand = arm.pose.bones[f"hand_{side}"]
    print(f"GRIP wrist off its fit by {(hand.head - grip_wrist).length * 1000:.1f}mm; final tip errors (mm) "
          f"{ {f: round((arm.pose.bones[f'{f}_03_{side}'].tail - contacts[f]).length * 1000, 2) for f in ('thumb', 'index', 'middle')} }")

    to_gltf = Matrix(((1, 0, 0), (0, 0, 1), (0, -1, 0)))
    origin = root.matrix_world.translation
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
    worst, where, at, sunk = 0.0, None, None, 0
    to_mouse = to_gltf @ root.matrix_world.to_3x3().transposed()
    for v, source in zip(mesh.vertices, human.data.vertices):
        q = human.matrix_world @ v.co
        if (q - origin).length < 0.2:
            depth = -surface_gap(q)
            sunk += depth > 0.002
            if depth > worst:
                deforming = [g for g in source.groups if group_names[g.group] in ARM_BONES]
                worst, where, at = depth, max(deforming, key=lambda g: g.weight, default=None), to_mouse @ (q - origin)
    evaluated.to_mesh_clear()
    print(f"GRIP skin inside the mouse or desk by up to {worst * 1000:.1f}mm"
          f" ({group_names[where.group] if where else '-'} at {tuple(round(c * 1000) for c in at) if at else '-'} mm"
          f" in the mouse's frame; {sunk} vertices over 2mm)")
    bpy.ops.object.mode_set(mode="OBJECT")
    grip = {
        "wrist": [round(c, 6) for c in to_gltf @ (hand.head - origin)],
        "hand": [round(c, 6) for c in (rotation.x, rotation.y, rotation.z, rotation.w)],
        "bones": bones,
    }
    return grip, {pb.name: pb.matrix_basis.copy() for pb in arm.pose.bones}, surface


def add_grip_corrective(human, arm, pose, surface):
    """Shape key "MouseGrip": rest-space offsets hands.ts blends in with the
    mouse grip. Swinging the thumb out onto the mouse's flank and turning the
    wrist, linear skinning (glTF's) pinches the thumb's fleshy base and the
    wrist into creases. Pose the grip, let a Corrective Smooth modifier
    restore the rest pose's local shape over the right hand and wrist, and
    map each vertex's correction back through its blended bone transforms;
    soften the knuckles by GRIP_KNUCKLE_SOFTEN of their sculpted relief.
    Where the right hand's skin still sinks into the mouse or the desk
    (`surface(point)`: signed distance and the way out), press it flat
    onto them, as the palm's soft pad flattens against the shell."""
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
    to_world = human.matrix_world
    to_local = to_world.inverted().to_3x3()
    sunk = 0.0
    for v in mesh.vertices:
        if any(g.group == region.index and g.weight > 0 for g in v.groups):
            depth, out = surface(to_world @ Vector(corrected[v.index]))
            if depth < 0:
                corrected[v.index] += np.array(to_local @ (out * -depth))
                sunk = max(sunk, -depth)
    print(f"GRIP corrective presses the palm flat against the mouse by up to {sunk * 1000:.1f}mm")
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
    # On the mouse the fingers are near straight, so the metacarpal heads
    # hardly stand out: take back part of the knuckles' sculpted relief.
    relief = np.empty(len(mesh.vertices) * 3, np.float32)
    mesh.attributes["knuckle_relief"].data.foreach_get("vector", relief)
    rest = np.empty(len(mesh.vertices) * 3, np.float32)
    mesh.vertices.foreach_get("co", rest)
    right = rest.reshape(-1, 3)[:, 0] > 0
    offsets -= GRIP_KNUCKLE_SOFTEN * relief.reshape(-1, 3) * right[:, None]
    mesh.attributes.remove(mesh.attributes["knuckle_relief"])
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
    """Retain only the arm skin the sleeves leave visible (plus a SKIN_TUCK
    tuck inside each cuff, which build_sleeves' inner wall closes past)."""
    deform_group_indices = {g.index for g in human.vertex_groups if g.name in ARM_BONES}
    cuffs = {}
    for side in ("l", "r"):
        _, (_, _, cuff) = sleeve_path(arm, side)
        wrist = arm.data.bones[f"hand_{side}"].head_local
        cuffs[side] = (cuff, (wrist - arm.data.bones[f"lowerarm_{side}"].head_local).normalized())
    for v in human.data.vertices:
        cuff, fore = cuffs["l" if v.co.x < 0 else "r"]
        hidden = (v.co - cuff).dot(fore) < -SKIN_TUCK
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
    # The knuckles' share of the relief, for add_grip_corrective to soften.
    relief = mesh.attributes.new("knuckle_relief", "FLOAT_VECTOR", "POINT")
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
            relief.data[vert.index].vector = up_hand * (max(knuckle, ridge) - ridge) * dorsal


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
    # Shape the phalanges without moving any bone endpoint: each finger
    # measured and rescaled onto one steady taper from its base width
    # (FINGER_HALF_WIDTH, FINGER_TAPER; MakeHuman's fingers taper from 12% to
    # 35% by finger, its index thinner than its ring), its middle and end
    # joints flaring a little past the shafts beside them, flat-topped, a
    # fleshy fingertip pad bulging below the bone, and a flatter back (a
    # D-shaped section under the extensor hood) instead of MakeHuman's round
    # tubes. The thumb, its bones modelled as thin as a finger's, fills out
    # to THUMB_FULLNESS over its base and tapers back toward its tip (full to
    # the end, it read as a log).
    # Each bone a vertex is weighted to proposes a position; they blend by weight, so
    # the shape runs continuously through the joints.
    along = {}  # bone -> (where it starts along its finger, its share of it)
    for side in ("l", "r"):
        for finger in ("thumb", "index", "middle", "ring", "pinky"):
            chain = [arm.data.bones[f"{finger}_{p:02d}_{side}"] for p in (1, 2, 3)]
            total = sum(b.length for b in chain)
            start = 0.0
            for b in chain:
                along[b.name] = (start / total, b.length / total)
                start += b.length

    def shaft_frame(bone):
        axis = (bone.tail_local - bone.head_local).normalized()
        dorsal = -(bone.matrix_local.to_3x3() @ Vector((0, 0, 1)))
        dorsal = (dorsal - axis * dorsal.dot(axis)).normalized()
        return axis, dorsal, axis.cross(dorsal)

    # Each finger phalanx's cross-section between t_lo and t_hi along it:
    # its centre (MakeHuman's bones run up to 8 mm off the middle of the
    # finger), its half width across and half depth, from the skin it
    # carries alone.
    def cross_sections(t_lo, t_hi):
        sections = {}
        for vert in mesh.vertices:
            for item in vert.groups:
                name = group_names.get(item.group, "")
                if item.weight > 0.6 and name.startswith(finger_prefixes[1:]):
                    bone = arm.data.bones[name]
                    span = bone.tail_local - bone.head_local
                    t = (vert.co - bone.head_local).dot(span) / span.length_squared
                    if t_lo < t < t_hi:
                        _, dorsal, lateral = shaft_frame(bone)
                        radial = vert.co - bone.head_local - span * t
                        sections.setdefault(name, []).append((radial.dot(lateral), radial.dot(dorsal)))
        found = {}  # bone -> (centre offset from its axis, half width, half depth)
        for name, points in sections.items():
            _, dorsal, lateral = shaft_frame(arm.data.bones[name])
            low, high = np.percentile(np.array(points), 3, axis=0), np.percentile(np.array(points), 97, axis=0)
            centre = (low + high) / 2
            found[name] = (lateral * float(centre[0]) + dorsal * float(centre[1]),
                           float(high[0] - low[0]) / 2, float(high[1] - low[1]) / 2)
        return found

    # Rescaled by its width alone: by the mean of width and depth, the
    # flatter end phalanges (MakeHuman's ~15% wider than deep) came out
    # wider than their target, and with the pad's and joints' swelling the
    # fingertips were as wide as the base (no taper: sausages).
    shafts = cross_sections(0.4, 0.7)
    print("FINGER_WIDTH rescale from MakeHuman half widths (mm)",
          {k: round(v[1] * 1000, 1) for k, v in shafts.items() if k.endswith("_r")})
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
                offset = shafts[group_name][0] if group_name in shafts else Vector()
                center = bone.head_local + axis * (t * length) + offset
                radial = vert.co - center
                part = int(group_name.split("_")[-2])
                start, share = along[group_name]
                # The PIP and DIP joints (not the knuckle: sculpt_hand_back's):
                # the one at the bone's end, at its start, and the phalanx
                # beyond each.
                joints = [(math.exp(-(((t - 1.0) / 0.14) ** 2)), part + 1)] if part < 3 else []
                joints += [(math.exp(-((t / 0.14) ** 2)), part - 1)] if part > 1 else []
                joint = sum(j for j, _ in joints)
                u = start + t * share
                if group_name.startswith("thumb_"):
                    factor = 1 + (THUMB_FULLNESS - 1) * smoothstep(0.15, 0.4, u) * (1 - 0.85 * smoothstep(0.55, 0.95, u))
                    if part == 3:
                        factor += 0.04 * math.exp(-(((t - 0.72) / 0.18) ** 2))  # the pad under the nail
                    radial = radial * factor
                else:
                    # The taper runs on along each phalanx, not stepped per
                    # bone (stepped, each phalanx read as a constant tube).
                    finger, _, side = group_name.split("_")
                    base_start, base_share = along[f"{finger}_01_{side}"]
                    width = FINGER_HALF_WIDTH[finger] * (1 - FINGER_TAPER * (u - base_start - base_share / 2))
                    radial = radial * (width / shafts[group_name][1])
                    shaft = smoothstep(0.12, 0.35, t) * (1 - smoothstep(0.7, 0.9, t)) if part < 3 else 0.0
                    _, dorsal, lateral = shaft_frame(bone)
                    height = radial.dot(dorsal)
                    radial -= dorsal * max(0.0, height) * 0.22 * shaft
                    # The joints' crowns pressed toward a flat top plane,
                    # square to the bisector of the two phalanges' backs (the
                    # bent joint's crown): above JOINT_CROWN[0] of the width
                    # each mm rises less, level by the top (scaled down
                    # evenly, a flexed middle joint kept its round section
                    # and read as a ball).
                    for strength, other in joints:
                        up = (dorsal + shaft_frame(arm.data.bones[f"{finger}_{other:02d}_{side}"])[1]).normalized()
                        rise = max(0.0, radial.dot(up) - JOINT_CROWN[0] * width)
                        radial -= up * (rise - rise / (1 + JOINT_CROWN[1] * rise / width)) * strength
                    # Widest across their condyles; the pad bulges palmward
                    # only (all round, it widened the fingertip).
                    radial += lateral * radial.dot(lateral) * (0.05 * joint - 0.03 * shaft)
                    if part == 3:
                        radial -= dorsal * min(0.0, radial.dot(dorsal)) * 0.06 * math.exp(-(((t - 0.72) / 0.18) ** 2))
                target = center + radial
                if part == 3 and t > 0.72:
                    palmward = (bone.matrix_local.to_3x3() @ Vector((0, 0, 1))).normalized()
                    target += palmward * (0.0016 * ((t - 0.72) / 0.28))
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
    # The shaped fingers measured: half widths at the base, middle and tip of
    # the middle and end phalanges, and how much narrower the end phalanx is
    # mid-way than the middle one mid-way and at its (flared) base.
    out = [cross_sections(c - 0.08, c + 0.08) for c in (0.15, 0.5, 0.85)]
    girth = {}
    for finger in ("index", "middle", "ring", "pinky"):
        rows = [[out[i][f"{finger}_{p:02d}_r"][1] * 1000 for i in range(3)] for p in (2, 3)]
        girth[finger] = (" | ".join(" ".join(f"{w:.1f}" for w in row) for row in rows)
                         + f", narrower {1 - rows[1][1] / rows[0][1]:.0%} / {1 - rows[1][1] / rows[0][0]:.0%}")
    print("FINGER_WIDTH half widths (mm), base mid tip of middle | end phalanx", girth)
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
    """Both sleeves, each one closed surface: a cloth tube along sleeve_path
    from the shoulder to the cuff's hem, turning over there into an inner
    wall CUFF_THICKNESS inside it that runs CUFF_TUCK back up the forearm
    and is closed, skinned to the clavicle, upper arm and forearm."""
    verts, faces, weight_rows = [], [], []
    radial = 32
    angles = [j / radial * math.tau for j in range(radial)]

    def ellipse(center, side_axis, binormal, radii, flat, drape):
        # A cloth tube flattened by `flat`, plus asymmetric drape under the arm.
        return [center + side_axis * (math.cos(a) * r) + binormal * (math.sin(a) * r * flat - drape * (1.0 - math.cos(a)))
                for a, r in zip(angles, radii)]

    for side in ("l", "r"):
        rng = random.Random(3 if side == "l" else 5)
        waves = [(rng.uniform(0.02, 0.034), rng.choice((-2, -1, -1, 0, 0, 1, 1, 2)), rng.uniform(0, math.tau),
                  rng.uniform(0.5, 1.0)) for _ in range(7)]
        wave_weight = sum(w for *_, w in waves)
        path, (_, elbow, _) = sleeve_path(arm, side)
        run = [0.0]
        for i in range(1, len(path)):
            run.append(run[-1] + (path[i] - path[i-1]).length)
        total = run[-1]
        # The sleeve passes from the upper arm to the forearm over 5.5 cm
        # either side of the elbow, by distance along it (split by height,
        # the forearm's far half, rising to the keys, rode the upper arm:
        # the elbow bending to the mouse folded the cuff back into a flat,
        # serrated shard and bared the forearm's cut end).
        bend = run[min(range(len(path)), key=lambda i: (path[i] - elbow).length)]
        rings, frames = [], []
        prev_binormal = Vector((0, 0, 1))
        for i, center in enumerate(path):
            traveled = run[i]
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
            # cuff, which grips the forearm.
            bunch_zone = smoothstep(0.17, 0.08, d_end) * smoothstep(CUFF_LENGTH - 0.004, CUFF_LENGTH + 0.012, d_end)
            amplitude = 0.0012 + 0.0055 * bunch_zone + 0.0035 * elbow_fold
            if d_end < CUFF_LENGTH:
                radii = [CUFF_RADIUS] * radial
            else:
                # |sin| waves: rounded crests, sharp creases; the angular
                # terms tilt them into the diagonal folds of a sleeve.
                radii = [base_radius + 0.006 * bunch_zone + amplitude * (
                    sum(w * abs(math.sin(traveled * math.tau / length + n * a + phase))
                        for length, n, phase, w in waves) / wave_weight - 0.64) for a in angles]
            if s < 0.10:
                weights = [(f"clavicle_{side}", 1.0 - s / 0.10), (f"upperarm_{side}", s / 0.10)]
            else:
                lower = smoothstep(-0.055, 0.055, traveled - bend)
                weights = [(f"upperarm_{side}", 1.0 - lower), (f"lowerarm_{side}", lower)]
            # The cuff is round, as the forearm is near the wrist (flattened,
            # it stood off the forearm's sides like a pipe).
            shape = (1.0 - 0.12 * smoothstep(CUFF_LENGTH - 0.004, CUFF_LENGTH + 0.012, d_end), 0.0035 * (0.3 + elbow_fold))
            frames.append((center, tangent, side_axis, binormal, shape, weights))
            rings.append((ellipse(center, side_axis, binormal, radii, *shape), weights))
        # The hem: the cloth turns over in a half round CUFF_THICKNESS across,
        # standing just past the last ring toward the hand, into the inner wall.
        center, tangent, side_axis, binormal, shape, weights = frames[-1]
        half = CUFF_THICKNESS / 2
        for k in range(1, 5):
            turn = k / 4 * math.pi
            rings.append((ellipse(center + tangent * (half * math.sin(turn)), side_axis, binormal,
                                  [CUFF_RADIUS - half + half * math.cos(turn)] * radial, *shape), weights))
        # The inner wall, on every other ring back up the sleeve until past
        # CUFF_TUCK, where it is closed.
        for i in range(len(path) - 3, 0, -2):
            center, _, side_axis, binormal, shape, weights = frames[i]
            rings.append((ellipse(center, side_axis, binormal, [CUFF_RADIUS - CUFF_THICKNESS] * radial, *shape), weights))
            if total - run[i] >= CUFF_TUCK:
                break
        first = len(verts)
        for k, (ring, weights) in enumerate(rings):
            verts.extend(tuple(p) for p in ring)
            weight_rows.extend([weights] * radial)
            if k:
                a0, a1 = first + (k-1) * radial, first + k * radial
                for j in range(radial):
                    n = (j + 1) % radial
                    faces.append((a0+j, a0+n, a1+n, a1+j))
        # Close both ends: the shoulder, and the inner wall up inside the cuff.
        last = first + (len(rings) - 1) * radial
        start_center = len(verts)
        verts.append(tuple(path[0]))
        weight_rows.append(frames[0][5])
        end_center = len(verts)
        verts.append(tuple(center))
        weight_rows.append(weights)
        for j in range(radial):
            n = (j+1) % radial
            faces.append((start_center, first+n, first+j))
            faces.append((end_center, last+j, last+n))
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
        "export_image_quality": 92, "export_apply": False, "export_skins": True,
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
    """Each fingertip bone's tail in the typing rest pose (glTF), by bone:
    hands.ts reads it (as the rig's `typingTips`) for where each tip rests
    and strikes relative to its key."""
    out = {}
    for side, mapping in FINGER_KEYS.items():
        for finger in mapping:
            p = arm.data.bones[f"{finger}_03_{side}"].tail_local
            out[f"{finger}_03_{side}"] = [round(v, 5) for v in (p.x, p.z, -p.y)]
    return out


def report_typing_pads(human, layout):
    """Log how far each resting fingertip's lowest skin stands above the key
    top under it (negative: sunk into the cap); the thumbs against the
    space bar's top."""
    home = layout["keyboard"]["homeKeys"]
    bar = layout["keyboard"]["keyTopY"]["frontRow"]
    names = {g.index: g.name for g in human.vertex_groups}
    low = {}
    for v in human.data.vertices:
        for g in v.groups:
            name = names[g.group]
            if g.weight > 0.5 and name[:-2].endswith("_03") and name in ARM_BONES:
                side, finger = name[-1], name.split("_")[0]
                centre = gltf_to_blender(home[FINGER_KEYS[side][finger]])
                q = human.matrix_world @ v.co
                top = bar if finger == "thumb" else centre.z + (q.y - centre.y) * math.tan(TYPING_TILT)
                low[name] = min(low.get(name, 1.0), q.z - top)
    print("TYPING pad gaps above the keys (mm):", {n: round(g * 1000, 1) for n, g in sorted(low.items())})


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
    grip, grip_pose, grip_surface = pose_mouse_grip(human, arm, mouse)
    arm["mouseGrip"] = json.dumps(grip, separators=(",", ":"))
    clear_pose(arm)
    prune_skin(human, arm)
    enhance_skin_geometry(human, arm)
    report_typing_pads(human, layout)
    arm["typingTips"] = json.dumps(finger_report(arm), separators=(",", ":"))
    mh_diffuse = next(n.image for n in human.data.materials[0].node_tree.nodes
                      if n.type == "TEX_IMAGE" and n.image and "diffuse" in n.image.name)
    skin_bake.anatomy_fields(human, arm)
    skin_bake.raise_nails(human)
    skin_bake.hand_weighted_uv(human)
    skin_bake.bake_skin(human, arm, mh_diffuse, size=2048, cache=CACHE_DIR)
    add_grip_corrective(human, arm, grip_pose, grip_surface)
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
    if size > 5 * 1024 * 1024:
        raise RuntimeError(f"File budget exceeded: {size} bytes")
    print("ARMS_BUILD_RESULT", json.dumps({
        "output": str(OUTPUT_PATH), "bytes": size, "triangles": tris,
        "fingertips_gltf": finger_report(arm),
    }, sort_keys=True))


if __name__ == "__main__":
    main()
