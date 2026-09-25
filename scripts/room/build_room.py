"""Build the POV room (Blender 5.1, Cycles; scene content in room_scene.py).

  blender -b -P scripts/room/build_room.py -- bake [--samples 256] [--device gpu|cpu]
      Lightmap UVs, night/day/screen lightmap bakes (OIDN denoised), the street
      view through the window, reflection panoramas, then frontend/public/room/:
      room.glb, room.json, lightmap_*.webp, street_*.webp, room_env_*.hdr.
  blender -b -P scripts/room/build_room.py -- preview --state night|day|screen
      [--view pov,wide,window,top,lamp,hands,handside,finger,mug,phone,clock,desk_left] [--samples 96]
      [--scale 0.5] [--tag _x] [--hands] [--debug-light] [--device gpu|cpu]
      [--screen-image terminal.png]
      Look-development renders to /tmp/term-room/lookdev_<view>_<state><tag>.png;
      --screen-image shows a terminal screenshot on the monitor.

Downloads (Poly Haven, CC0) are cached in ~/.cache/term-site-room/.
`--device cpu` works where Metal's shader compiler is unreachable (a shell
outside the macOS login session).
"""
import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bake_export as bx  # noqa: E402
import polyhaven  # noqa: E402
import room_scene as rs  # noqa: E402

REPO = HERE.parent.parent
OUT = REPO / "frontend/public/room"
LAYOUT = json.loads((REPO / "frontend/src/room/layout.json").read_text())
PREVIEW_DIR = Path("/tmp/term-room")

NIGHT_HDRI = "shanghai_bund"
DAY_HDRI = "canary_wharf"


# White balance per state, as a camera would set it: at night the LED lamp
# reads a neutral warm white (skin and walnut stay natural; the monitor, LED
# strip and light panels carry the colour); by day the blue skylight reads
# near neutral and the sun golden.
NIGHT_WB = 3800
DAY_WB = 7500


def kelvin(t, white=6500):
    """Linear RGB of a blackbody at t kelvin (Tanner Helland fit), normalised,
    as seen by a camera white-balanced to `white` kelvin (shifted in mireds)."""
    t = 1e6 / (1e6 / t - 1e6 / white + 1e6 / 6500) / 100
    r = 255 if t <= 66 else 329.698727446 * (t - 60) ** -0.1332047592
    g = 99.4708025861 * math.log(t) - 161.1195681661 if t <= 66 else 288.1221695283 * (t - 60) ** -0.0755148492
    b = 255 if t >= 66 else (0 if t <= 19 else 138.5177312231 * math.log(t - 10) - 305.0447927307)
    srgb = [min(255, max(0, c)) / 255 for c in (r, g, b)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    peak = max(lin)
    return tuple(c / peak for c in lin)


def setup_render(samples, device="gpu"):
    """Cycles on the Metal GPU, or on the CPU when Metal's shader compiler
    is unreachable (e.g. a shell outside the login session)."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    if device == "gpu":
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "METAL"
        prefs.get_devices()
        for d in prefs.devices:
            d.use = d.type != "CPU"
    scene.cycles.device = device.upper()
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 10
    scene.cycles.diffuse_bounces = 6
    scene.cycles.glossy_bounces = 4
    scene.cycles.transparent_max_bounces = 16
    scene.cycles.caustics_reflective = False
    scene.cycles.caustics_refractive = False
    scene.view_settings.view_transform = "Khronos PBR Neutral"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.0


def setup_world():
    world = bpy.data.worlds.new("room_world")
    bpy.context.scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    coord = nt.nodes.new("ShaderNodeTexCoord")
    mapping = nt.nodes.new("ShaderNodeMapping")
    nt.links.new(coord.outputs["Generated"], mapping.inputs["Vector"])
    night = nt.nodes.new("ShaderNodeTexEnvironment")
    night.image = bpy.data.images.load(str(polyhaven.hdri(NIGHT_HDRI, "4k")))
    day = nt.nodes.new("ShaderNodeTexEnvironment")
    day.image = bpy.data.images.load(str(polyhaven.hdri(DAY_HDRI, "4k")))
    for env in (night, day):
        nt.links.new(mapping.outputs["Vector"], env.inputs["Vector"])
    sky = nt.nodes.new("ShaderNodeTexSky")
    sky.sky_type = "MULTIPLE_SCATTERING"
    bg_night = nt.nodes.new("ShaderNodeBackground")
    bg_day_view = nt.nodes.new("ShaderNodeBackground")
    bg_sky = nt.nodes.new("ShaderNodeBackground")
    nt.links.new(night.outputs["Color"], bg_night.inputs["Color"])
    nt.links.new(day.outputs["Color"], bg_day_view.inputs["Color"])
    # The camera's white balance applies to the sky as it does to the lamps.
    sky_tint = nt.nodes.new("ShaderNodeMix")
    sky_tint.data_type = "RGBA"
    sky_tint.blend_type = "MULTIPLY"
    sky_tint.inputs["Factor"].default_value = 1.0
    sky_tint.inputs["B"].default_value = (*kelvin(6500, DAY_WB), 1.0)
    nt.links.new(sky.outputs["Color"], sky_tint.inputs["A"])
    nt.links.new(sky_tint.outputs["Result"], bg_sky.inputs["Color"])
    # Day: camera rays see the city photo; light comes from the physical sky.
    path = nt.nodes.new("ShaderNodeLightPath")
    day_mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(path.outputs["Is Camera Ray"], day_mix.inputs[0])
    nt.links.new(bg_sky.outputs[0], day_mix.inputs[1])
    nt.links.new(bg_day_view.outputs[0], day_mix.inputs[2])
    state_mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(bg_night.outputs[0], state_mix.inputs[1])
    nt.links.new(day_mix.outputs[0], state_mix.inputs[2])
    nt.links.new(state_mix.outputs[0], out.inputs["Surface"])
    return {"mapping": mapping, "night": bg_night, "day_view": bg_day_view, "sky": bg_sky, "sky_tex": sky, "mix": state_mix,
            "day_mix": day_mix, "camera_ray": path.outputs["Is Camera Ray"]}


def add_light(name, kind, location, direction, **props):
    light = bpy.data.lights.new(name, kind)
    for key, value in props.items():
        setattr(light, key, value)
    obj = bpy.data.objects.new(name, light)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    return obj


def screen_preview_image(h, path):
    """Show a real terminal frame on the panel in previews (the runtime draws the live one)."""
    mat = h["materials"]["screen"]
    nt = mat.node_tree
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(str(path))
    nt.links.new(tex.outputs["Color"], nt.nodes["Principled BSDF"].inputs["Emission Color"])
    return tex


def setup_lights(h):
    d = LAYOUT["desk"]
    # The lamp's LED bar: a soft spot just under its diffuser.
    lamp = add_light("light_lamp", "SPOT", h["lamp_bulb"], h["lamp_axis"], color=kelvin(3500, NIGHT_WB),
                     spot_size=2 * h["lamp_half_angle"], spot_blend=0.6, shadow_soft_size=0.03)
    led = add_light("light_led", "AREA", rs.B((0, d["topY"] + 0.01, d["zBack"] + 0.015)), rs.B((0, 0.55, -0.85)).normalized(),
                    shape="RECTANGLE", size=d["xMax"] - d["xMin"] - 0.12, size_y=0.01, color=(0.5, 0.42, 1.0))
    # Bias light behind the monitor, aimed back and up at the wall: the right
    # of the desk (mug, speaker, arm pole) reads against its glow at night.
    bias_dir = (h["bias_axis"] + Vector((0, 0, 0.35))).normalized()
    bias = add_light("light_bias", "AREA", h["bias"] + h["bias_axis"] * 0.004, bias_dir,
                     shape="RECTANGLE", size=0.5, size_y=0.01, color=(0.55, 0.45, 1.0))
    # The hex panels' glow on the wall round them: a small light just in
    # front of each tile (which casts no shadow), in its colour.
    hex_lights = [add_light(f"light_hex{i}", "POINT", rs.B(c + Vector((0, 0, 0.012))), Vector((0, 0, -1)), color=color,
                            shadow_soft_size=0.03)
                  for i, (c, color) in enumerate(h["hex_tiles"])]
    # The tiles are baked; lit by their own lights 12 mm away they showed a
    # white hotspot at each centre at night. Their emission carries the glow.
    tiles = bpy.data.collections.new("hex_tiles")
    for obj in bpy.data.objects:
        if obj.name.startswith("hex_panel"):
            tiles.objects.link(obj)
    for light in hex_lights:
        light.light_linking.receiver_collection = tiles
    for item in tiles.collection_objects:
        item.light_linking.link_state = "EXCLUDE"
    # By day, light from the rest of the flat through the open door behind
    # the chair: the one window alone left the wall right of the monitor
    # near black beside the sunlit desk. An emitting plane rather than an
    # area light, so the eye-centred panorama sees it too and the `live_`
    # props facing the seat get the same fill as the baked walls.
    # It spans the back wall (a door-sized plane bright enough to light the
    # room mirrored as a white-hot patch in every screen and gloss surface
    # facing the seat), bright enough that the desk right of the monitor
    # sits within about a stop of the left half by the window.
    zb = LAYOUT["room"]["zBack"] - 0.02
    fill = rs.quad("proxy_fill", [(-1.2, 0.3, zb), (1.4, 0.3, zb), (1.4, 2.4, zb), (-1.2, 2.4, zb)],
                   rs.material("proxy_fill", color=(0, 0, 0), roughness=1.0, emission=kelvin(6500, DAY_WB)))
    # Streetlights below the window wash the facade across the street.
    add_light("light_street", "AREA", rs.B((-5, -16, rs.STREET_Z + 6)), rs.B((0, 0.35, -1)).normalized(),
              shape="RECTANGLE", size=60, size_y=2, energy=0.0, color=kelvin(2200, NIGHT_WB))
    sun_dir = rs.B((0.675, -0.562, 0.525)).normalized()  # afternoon sun through the window onto the desk
    sun = add_light("light_sun", "SUN", Vector((0, 0, 5)), sun_dir, color=kelvin(5600, DAY_WB), angle=math.radians(0.6))
    return {"lamp": lamp, "led": led, "bias": bias, "hex": hex_lights, "fill": fill, "sun": sun, "sun_dir": sun_dir, "street": bpy.data.objects["light_street"]}


def set_state(state, h, world, lights, levels):
    m = h["materials"]
    night, day, screen = state == "night", state == "day", state == "screen"
    lights["lamp"].data.energy = levels["lamp"] if night else 0
    lights["led"].data.energy = levels["led"] if night else 0
    lights["bias"].data.energy = levels["bias"] if night else 0
    for light in lights["hex"]:
        light.data.energy = levels["hex_glow"] if night else 0
    rs.emission_input(lights["fill"].active_material).default_value = levels["fill"] if day else 0
    lights["sun"].data.energy = levels["sun"] if day else 0
    lights["street"].data.energy = levels["street_light"] if night else 0
    rs.emission_input(m["bulb"]).default_value = levels["lamp_led"] if night else 0
    rs.emission_input(m["lamp_touch"]).default_value = levels["lamp_touch"] if night else 0
    rs.emission_input(m["mug_led"]).default_value = levels["mug_led"] if night else (levels["mug_led"] * 0.5 if day else 0)
    rs.emission_input(m["speaker_glow"]).default_value = levels["speaker_glow"] if night else (levels["speaker_glow"] * 0.5 if day else 0)
    # Off by day: even a faint idle read brighter than the sunlit wall.
    for mat in m["hex"]:
        rs.emission_input(mat).default_value = levels["hex"] if night else 0
    rs.emission_input(m["led"]).default_value = levels["led_strip"] if night else 0
    rs.emission_input(m["bias"]).default_value = levels["led_strip"] if night else 0
    rs.emission_input(m["fan"]).default_value = levels["fans"] if night else (levels["fans"] * 0.3 if day else 0)
    rs.emission_input(m["pc_led"]).default_value = levels["pc_led"] if night else (levels["pc_led"] * 0.3 if day else 0)
    for mat in m["street_lit_mats"]:
        rs.emission_input(mat).default_value = m["street_lit"][mat.name] * levels["street"] if night else 0.0
    rs.emission_input(m["screen"]).default_value = 1.0 if screen else levels["screen_preview"]
    world["mix"].inputs[0].default_value = 1.0 if day else 0.0
    world["night"].inputs["Strength"].default_value = levels["night_sky"] if night else 0.0
    world["sky"].inputs["Strength"].default_value = levels["sky"] if day else 0.0
    world["day_view"].inputs["Strength"].default_value = levels["day_view"] if day else 0.0
    world["mapping"].inputs["Rotation"].default_value = (0, 0, math.radians(levels["city_yaw"] if night else levels["day_yaw"]))
    sun_dir = lights["sun_dir"]
    sky = world["sky_tex"]
    if hasattr(sky, "sun_elevation"):
        sky.sun_elevation = math.asin(-sun_dir.z)
        sky.sun_rotation = math.atan2(-sun_dir.x, -sun_dir.y)
        sky.sun_disc = False


LEVELS = {
    "street": 12.0, "street_light": 6000.0, "lamp": 30.0, "lamp_led": 12.0, "lamp_touch": 2.0, "mug_led": 4.0, "speaker_glow": 2.0,
    "hex": 1.2, "hex_glow": 3.0, "led": 6.0, "bias": 6.0, "led_strip": 10.0, "fans": 14.0, "pc_led": 6.0,
    "night_sky": 0.02, "city_yaw": 150, "screen_preview": 1.0,
    # Skylight into the room is held below the facade's (`street_sky`): at
    # the facade's level the desk by the window sat ~5 stops over its right
    # half, and blew out white; the fill lifts the rest of the room.
    "sun": 28.0, "sky": 12.0, "street_sky": 32.0, "fill": 26.0, "day_view": 2.3, "day_yaw": 150,
}


def camera(name, eye, target, vfov_deg):
    cam = bpy.data.objects.new(name, bpy.data.cameras.new(name))
    bpy.context.scene.collection.objects.link(cam)
    cam.location = rs.B(eye)
    cam.rotation_euler = (rs.B(target) - rs.B(eye)).to_track_quat("-Z", "Y").to_euler()
    cam.data.sensor_fit = "VERTICAL"
    cam.data.angle_y = math.radians(vfov_deg)
    cam.data.clip_start = 0.02
    cam.data.clip_end = 100
    return cam


def add_preview_stand_ins():
    """Arms (bind pose = hands on the home row) with their mouse, and a
    keyboard mock-up so previews show the runtime composition. Never
    exported."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(REPO / "frontend/public/room/arms.glb"))
    mouse_plastic = rs.material("preview_mouse", color=(0.02, 0.02, 0.022), roughness=0.48)
    for obj in set(bpy.data.objects) - before:
        if obj.type == "MESH" and obj.name.startswith("Mouse"):
            obj.data.materials.clear()
            obj.data.materials.append(mouse_plastic)
        if obj.type == "MESH" and obj.name == "Skin":
            bsdf = obj.active_material.node_tree.nodes["Principled BSDF"]
            bsdf.inputs["Subsurface Weight"].default_value = 1.0
            bsdf.inputs["Subsurface Radius"].default_value = (1.0, 0.35, 0.2)
            bsdf.inputs["Subsurface Scale"].default_value = 0.0015
    kb = LAYOUT["keyboard"]
    cx, cy, cz = kb["center"]
    case = rs.material("preview_kb_case", color=(0.3, 0.3, 0.32), roughness=0.35, metallic=1.0)
    cap = rs.material("preview_kb_cap", color=(0.03, 0.03, 0.035), roughness=0.55)
    rs.box("preview_kb_case", (kb["footprint"][0], 0.022, kb["footprint"][1]), (cx, cy + 0.011, cz), case, bevel=0.003)
    u = 0.01905
    for row in range(6):
        for col in range(16):
            rs.box(f"preview_kb_key_{row}_{col}", (u - 0.003, 0.009, u - 0.003),
                   (cx - 7.5 * u + col * u, cy + 0.027 + row * 0.0015, cz + 2.5 * u - row * u), cap, bevel=0.0015)


VIEWS = {
    "pov": (LAYOUT["camera"]["eye"], LAYOUT["camera"]["target"], 49),
    "wide": ((0.45, 1.5, 1.6), (-0.3, 0.95, -0.7), 60),
    "window": ((0.1, 1.3, 0.4), (-0.9, 1.3, -0.9), 55),
    "top": ((0.0, 2.45, -0.3), (0.0, 0.74, -0.34), 75),
    "lamp": ((0.1, 1.05, 0.25), (-0.5, 1.15, -0.55), 60),
    "hands": ((0.02, 1.02, 0.14), (-0.02, 0.78, -0.12), 38),
    "handside": ((-0.42, 0.92, -0.36), (-0.08, 0.79, -0.1), 34),
    "finger": ((0.05, 0.86, -0.34), (0.03, 0.79, -0.12), 26),
    "mug": ((0.2, 1.0, 0.02), (0.43, 0.79, -0.33), 30),
    "phone": ((-0.2, 0.95, 0.05), (-0.42, 0.82, -0.28), 30),
    "clock": ((-0.25, 0.95, -0.1), (-0.5, 0.79, -0.58), 30),
    "desk_left": ((0.05, 1.15, 0.15), (-0.5, 0.85, -0.5), 50),
}


def render_environment(path, world):
    """Equirectangular panorama from the seated eye, for reflections and
    bounce light on the realtime hands, keyboard and `live_` props. Its
    camera rays see the physical sky that lit the bake, not the dim city
    photo shown through the window: with the photo the day panorama held a
    tenth of the daylight in the day lightmap, so realtime-lit props went
    dark beside the baked desk by day."""
    day_mix = world["day_mix"]
    links = day_mix.id_data.links
    links.remove(day_mix.inputs[0].links[0])
    day_mix.inputs[0].default_value = 0.0
    scene = bpy.context.scene
    cam = bpy.data.objects.new("cam_env", bpy.data.cameras.new("cam_env"))
    scene.collection.objects.link(cam)
    cam.data.type = "PANO"
    cam.data.panorama_type = "EQUIRECTANGULAR"
    cam.location = rs.B(LAYOUT["camera"]["eye"])
    # Centred on glTF +X: three.js maps an equirect's centre column to +X
    # (u = atan(z, x) / 2π + 0.5). Centred on the room's forward (-Z), the
    # runtime saw the panorama turned 90°: the window's reflection landed on
    # the right of the desk as a blue-white blotch, and its light reached
    # the realtime props from the right.
    cam.rotation_euler = (math.pi / 2, 0, -math.pi / 2)
    scene.camera = cam
    scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = 1024, 512, 100
    scene.render.image_settings.file_format = "HDR"
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)
    links.new(world["camera_ray"], day_mix.inputs[0])


def street_view(state, samples, width=2048):
    """Render what the window frames (the building across the street and
    the sky above it) from the seated eye, as a flat picture at the facade's
    depth. The runtime maps it onto `street_card`, so the facade keeps its
    parallax without shipping its geometry."""
    import numpy as np
    scene = bpy.context.scene
    eye = rs.B(LAYOUT["camera"]["eye"])
    # The window seen from anywhere the head can move to, projected to the facade.
    reach = 0.25
    depth = LAYOUT["camera"]["eye"][2] - rs.STREET_Z
    near = LAYOUT["camera"]["eye"][2] - LAYOUT["room"]["zFront"]
    f = depth / near
    w = rs.WINDOW
    ex, ey = LAYOUT["camera"]["eye"][0], LAYOUT["camera"]["eye"][1]
    x0, x1 = ex + (w["x0"] - ex) * f - reach * (f - 1), ex + (w["x1"] - ex) * f + reach * (f - 1)
    y0, y1 = ey + (w["y0"] - ey) * f - reach * (f - 1), ey + (w["y1"] - ey) * f + reach * (f - 1)
    height = int(width * (y1 - y0) / (x1 - x0))
    cam = bpy.data.objects.new("cam_street", bpy.data.cameras.new("cam_street"))
    scene.collection.objects.link(cam)
    # Looking straight along -Z so the facade plane maps linearly to the image.
    cam.location = eye
    cam.rotation_euler = (math.pi / 2, 0, 0)
    cam.data.sensor_fit = "HORIZONTAL"
    cam.data.sensor_width = 36
    cam.data.lens = 36 * depth / (x1 - x0)
    cam.data.shift_x = ((x0 + x1) / 2 - ex) / (x1 - x0)
    cam.data.shift_y = ((y0 + y1) / 2 - ey) / (x1 - x0)
    cam.data.clip_end = 200
    hidden = [o for o in bpy.data.objects if o.type == "MESH" and not o.name.startswith("street_") and o.visible_camera]
    for o in hidden:
        o.visible_camera = False
    scene.camera = cam
    scene.cycles.samples = samples
    scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = width, height, 100
    scene.render.image_settings.file_format = "OPEN_EXR"
    path = Path(bpy.app.tempdir) / f"street_{state}.exr"
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    for o in hidden:
        o.visible_camera = True
    bpy.data.objects.remove(cam)
    image = bpy.data.images.load(str(path))
    pixels = np.empty(width * height * 4, dtype=np.float32)
    image.pixels.foreach_get(pixels)
    bpy.data.images.remove(image)
    corners = [[x0, y0, rs.STREET_Z + 0.05], [x1, y0, rs.STREET_Z + 0.05], [x1, y1, rs.STREET_Z + 0.05], [x0, y1, rs.STREET_Z + 0.05]]
    return pixels.reshape(height, width, 4)[..., :3], corners


def bake(h, world, lights, samples):
    import time

    import numpy as np
    rng = np.random.default_rng(1)
    clock = time.time()

    def lap(label):
        nonlocal clock
        print(f"BAKE {label}: {time.time() - clock:.0f}s", flush=True)
        clock = time.time()

    screen = rs.emission_input(h["materials"]["screen"])
    bx.apply_modifiers()
    statics = [o for o in bpy.data.objects if bx.is_static(o)]
    bx.lightmap_uvs(statics)
    lap(f"lightmap UVs for {len(statics)} objects")
    scales = {}
    for state, n in (("night", samples), ("day", samples), ("screen", samples)):
        set_state(state, h, world, lights, LEVELS)
        if state != "screen":
            screen.default_value = 0.0  # the runtime adds the live screen's light
        if state == "day":
            # The runtime draws the sun's direct light live (crisp stripes
            # through the blinds, on the hands too); the map keeps skylight
            # and every bounce, the sun's included: all indirect light plus
            # the direct light with the sun off. (Subtracting a sun-only pass
            # from the full bake leaves clamped, coloured noise in sunlit spots.)
            image = bx.bake_state(statics, state, n, passes=("INDIRECT",))
            lights["sun"].data.energy = 0.0
            bx.add(image, bx.bake_state(statics, "day_sky", n, passes=("DIRECT",)))
        else:
            image = bx.bake_state(statics, state, n)
        lap(f"bake {state}")
        scales[state] = bx.encode_lightmap(bx.denoise(image), OUT / f"lightmap_{state}.webp", rng)
        lap(f"denoise+encode {state} (scale {scales[state]:.4g})")
    street = {}
    for state in ("night", "day"):
        set_state(state, h, world, lights, dict(LEVELS, sky=LEVELS["street_sky"]))
        rgb, corners = street_view(state, samples)
        street[state] = {"file": f"street_{state}.webp", "scale": bx.encode_hdr(rgb, OUT / f"street_{state}.webp", rng, 99.9)}
        lap(f"street {state}")
    # Reflection / bounce panoramas for the realtime hands and keyboard.
    for state in ("night", "day"):
        set_state(state, h, world, lights, LEVELS)
        screen.default_value = 0.0
        render_environment(OUT / f"room_env_{state}.hdr", world)
        lap(f"environment {state}")
    exported = [o for o in bpy.data.objects
                if o.type == "MESH" and not o.name.startswith(("proxy_", "preview_", "street_"))]
    emitters = {}
    used = {slot.material for o in exported for slot in o.material_slots if slot.material}
    for state in ("night", "day"):
        set_state(state, h, world, lights, LEVELS)
        for mat in used:
            bsdf = mat.node_tree.nodes.get("Principled BSDF") if mat.node_tree else None
            if not bsdf or mat.name == "rt_screen":
                continue
            strength = bsdf.inputs["Emission Strength"].default_value
            if strength > 0 or mat.name in emitters:
                color = tuple(round(c, 4) for c in bsdf.inputs["Emission Color"].default_value[:3])
                emitters.setdefault(mat.name, {"color": color, "night": 0.0, "day": 0.0})[state] = round(strength, 4)
    bx.downscale_textures()
    bx.export_glb(OUT / "room.glb", exported)
    lap("export")
    manifest = {
        "version": 3,
        "coordinateSystem": "glTF: +Y up, viewer faces -Z, metres",
        "lightmaps": {
            "uv": "TEXCOORD_1",
            "encoding": "log curve: code e in [0, 1] -> scale / range * ((range + 1)^e - 1), linear lighting",
            "range": bx.LIGHTMAP_RANGE,
            "units": "Cycles diffuse lighting: outgoing radiance of an albedo-1 surface",
            "night": {"file": "lightmap_night.webp", "scale": scales["night"]},
            "day": {"file": "lightmap_day.webp", "scale": scales["day"],
                    "note": "without the sun's direct light, which the runtime's shadowed sun adds"},
            "screen": {"file": "lightmap_screen.webp", "scale": scales["screen"],
                       "note": "monitor alone emitting white at strength 1; multiply by the live screen radiance"},
        },
        "environments": {"night": "room_env_night.hdr", "day": "room_env_day.hdr"},
        "street": {"corners": [[round(c, 3) for c in p] for p in corners], **street},
        "emitters": emitters,
        "lights": lights_manifest(h, lights),
    }
    (OUT / "room.json").write_text(json.dumps(manifest, indent=1))
    print("EXPORTED", OUT / "room.glb")


def lights_manifest(h, lights):
    """Realtime lights for the dynamic objects, in three.js units that
    match the bake: a Blender spot of P watts has intensity P / 4π, a sun of
    strength S has intensity S."""
    lamp = lights["lamp"].data
    to_gltf = lambda v: [round(v.x, 4), round(v.z, 4), round(-v.y, 4)]  # noqa: E731
    lamp_pos = lights["lamp"].location
    return {
        "lamp": {"position": to_gltf(lamp_pos), "direction": to_gltf(h["lamp_axis"]), "angle": lamp.spot_size / 2,
                 "penumbra": lamp.spot_blend, "color": list(lamp.color), "intensity": LEVELS["lamp"] / (4 * math.pi)},
        "sun": {"direction": to_gltf(lights["sun_dir"]), "color": list(lights["sun"].data.color), "intensity": LEVELS["sun"]},
    }


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["preview", "bake"])
    parser.add_argument("--state", default="night", choices=["night", "day", "screen"])
    parser.add_argument("--view", default="pov")
    parser.add_argument("--samples", type=int, default=96)
    parser.add_argument("--device", default="gpu", choices=["gpu", "cpu"])
    parser.add_argument("--scale", type=float, default=0.5)
    parser.add_argument("--tag", default="")
    parser.add_argument("--debug-light", action="store_true", help="flat grey world to check layout")
    parser.add_argument("--hands", action="store_true", help="show the arms and a keyboard mock-up (preview)")
    parser.add_argument("--screen-image", type=Path, help="terminal screenshot shown on the monitor (preview)")
    args = parser.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    setup_render(args.samples, args.device)
    h = rs.build(LAYOUT)
    world = setup_world()
    lights = setup_lights(h)
    if args.mode == "bake":
        bake(h, world, lights, args.samples)
        return
    set_state(args.state, h, world, lights, LEVELS)
    if args.hands:
        add_preview_stand_ins()
    if args.screen_image:
        screen_preview_image(h, args.screen_image)
    if args.debug_light:
        add_light("debug_ceiling", "AREA", rs.B((0, 2.5, 0.2)), Vector((0, 0, -1)), shape="RECTANGLE", size=2.5, size_y=2.5, energy=250)
    scene = bpy.context.scene
    scene.render.resolution_x = 1440
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = int(args.scale * 100)
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    for view in args.view.split(","):
        eye, target, fov = VIEWS[view]
        scene.camera = camera(f"cam_{view}", eye, target, fov)
        scene.render.filepath = str(PREVIEW_DIR / f"lookdev_{view}_{args.state}{args.tag}.png")
        bpy.ops.render.render(write_still=True)
        print("WROTE", scene.render.filepath)


main()
