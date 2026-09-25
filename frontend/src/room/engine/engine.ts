// The room renderer: scene assembly, lighting for the realtime objects, the
// post-processing chain and the frame loop. RoomView owns its lifetime.
import {
  Box3,
  Color,
  DirectionalLight,
  HalfFloatType,
  MathUtils,
  NoToneMapping,
  Mesh,
  MeshStandardMaterial,
  PCFShadowMap,
  RectAreaLight,
  Scene,
  SkinnedMesh,
  SpotLight,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  NoiseEffect,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  BlendFunction,
} from 'postprocessing';
import type { TerminalScreenHandle } from '@/components/Terminal';
import { resolvedMode, subscribe as subscribeTheme } from '@/lib/theme-manager';
import { screenPose } from '../layout';
import { createPovCamera } from './camera';
import { createKeyboard } from './keyboard';
import { CODE_ALIASES, KEY_BY_CODE } from './keymap';
import { attachScreenPointer, createTerminalScreen } from './screen';
import { disposeTree, loadRoom } from './room';
import { createHands } from './hands';
import { applySkinShading } from './skin';
import { fitSkyShade, fitSunDetail, SKY_SHADE_LAYER, smoothShadowPenumbrae, SUN_SHADOW_DEPTH } from './shadows';
import { captureProbes, propSites, type LocalProbes } from './probes';
import { createRoomAudio } from './audio';
import { typeText } from './autotype';
import { createMouse } from './mouse';
import { createAtmosphere } from './atmosphere';
import { createDeskDevices } from './devices';

export interface RoomEngineOptions {
  canvas: HTMLCanvasElement;
  getTerminal: () => TerminalScreenHandle | null;
  reducedMotion: boolean;
  onProgress?: (fraction: number) => void;
  // Ctrl+wheel / pinch moved the lean-in amount (0 sitting back, 1 leaning in).
  onZoom?: (zoom: number) => void;
}

export interface RoomEngine {
  bindTerminal(handle: TerminalScreenHandle | null): void;
  setZoom(zoom: number): void;
  // Type `text` on the room keyboard, sending each character via `send`;
  // any real keystroke cancels the rest.
  typeText(text: string, send: (data: string) => void): void;
  setSound(enabled: boolean): void;
  dispose(): void;
}

const TYPING_DECAY_SECONDS = 1.6;

// Scene-linear radiance (bake units) → display, before the tone map. The
// room atlases are scaled for 1.
const EXPOSURE = 1;
// By day the room is several times brighter than at night: the window's sky
// lights the whole room to about 1.6 (albedo-1 irradiance) and the sun's
// patches on the desk several times that, so at night's exposure the sunlit
// desk and walls clip and skin in open shade already sits near the tone
// mapper's white, leaving the sun nothing to add. A camera stops down in
// daylight: every light, the lightmaps and the panorama take this share.
const DAY_EXPOSURE = 0.55;
// Bloom starts above this scene luminance: the monitor's text glows at night;
// by day only what is brighter than the sunlit desk does.
const BLOOM_THRESHOLD = { night: 0.82, day: 2.2 };
// Once the intro has settled, a GPU whose median frame is slower than
// SLOW_FRAME_MS (~45 fps) renders the room at 1× device pixels instead.
const PERF_SKIP_FRAMES = 120;
const PERF_SAMPLE_FRAMES = 120;
const SLOW_FRAME_MS = 22;

// Seconds for the room to go from night to day (or back) on a mode switch.
const DAY_TRANSITION_SECONDS = 2.4;

export async function createRoomEngine(options: RoomEngineOptions): Promise<RoomEngine> {
  const { canvas, getTerminal, reducedMotion } = options;
  RectAreaLightUniformsLib.init();
  smoothShadowPenumbrae();

  const renderer = new WebGLRenderer({
    canvas,
    antialias: false,
    stencil: false,
    depth: false,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = NoToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;

  const scene = new Scene();
  scene.background = new Color('#020203');

  const pov = createPovCamera(reducedMotion);
  const { camera } = pov;

  // --- Static room + arms ------------------------------------------------
  const [room, arms] = await Promise.all([
    loadRoom((fraction) => options.onProgress?.(fraction * 0.8)),
    new GLTFLoader().loadAsync('/room/arms.glb'),
  ]);
  scene.add(room.scene);
  arms.scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.castShadow = true;
    object.receiveShadow = true;
    // The arms alone throw the hands' shadow in the room's light (the sky
    // shade below); the mouse, still among them here, doesn't.
    if (object instanceof SkinnedMesh) object.layers.enable(SKY_SHADE_LAYER);
    // Skinned bounds follow the bind pose; the IK moves the hands outside it.
    object.frustumCulled = false;
    if (object.name === 'Skin' && object.material instanceof MeshStandardMaterial) {
      applySkinShading(object.material);
    }
  });
  scene.add(arms.scene);
  options.onProgress?.(0.85);

  // --- Terminal panel ----------------------------------------------------
  const screen = createTerminalScreen(renderer);
  scene.add(screen.mesh);

  // --- Keyboard ------------------------------------------------------------
  await document.fonts.load('500 32px "JetBrainsMono Nerd Font Mono"').catch(() => undefined);
  const keyboard = createKeyboard(renderer);
  scene.add(keyboard.group);
  scene.updateMatrixWorld(true);
  const mouse = createMouse(arms.scene);
  scene.add(mouse.group);
  const hands = createHands(arms.scene, keyboard, mouse);
  const audio = createRoomAudio(false);
  audio.setDay(resolvedMode() === 'light' ? 1 : 0);

  // --- Lights for the realtime objects -------------------------------------
  // The baked room only lights itself. The keyboard, hands, mouse and the
  // live_ props get the room's light from light probes captured beside
  // each of them at night and from the room panorama by day (probes.ts;
  // bounce light, skylight, reflections), the monitor as an area light,
  // and shadowed direct lights placed and sized like the Blender lamp and
  // sun (room.json `lights`).
  const pose = screenPose();
  const screenNormal = new Vector3(0, 0, 1).applyQuaternion(pose.quaternion);
  const screenLight = new RectAreaLight('#ffffff', 0, pose.width, pose.height);
  screenLight.position.copy(pose.center).addScaledVector(screenNormal, 0.002);
  screenLight.lookAt(pose.center.clone().add(screenNormal));
  scene.add(screenLight);

  const { lamp: lampSpec, sun: sunSpec } = room.manifest.lights;
  const lamp = new SpotLight(new Color().fromArray(lampSpec.color), 0, 0, lampSpec.angle, lampSpec.penumbra, 2);
  lamp.position.fromArray(lampSpec.position);
  lamp.target.position.copy(lamp.position).add(new Vector3().fromArray(lampSpec.direction));
  lamp.castShadow = true;
  // The lamp is the light bar on the monitor's top edge, half a metre above
  // and ahead of the hands, lighting their backs nearly head-on: its texels
  // are about half a millimetre there, and a small normal offset keeps a
  // finger's shadow on the next finger (skin looks up 2.5 times further).
  lamp.shadow.mapSize.set(2048, 2048);
  lamp.shadow.bias = -0.0004;
  lamp.shadow.normalBias = 0.002;
  lamp.shadow.radius = 4;
  // Starts past the bar's own housing, just behind the light.
  lamp.shadow.camera.near = 0.06;
  lamp.shadow.camera.far = 3;
  scene.add(lamp, lamp.target);

  // Sun through the window. Its direct light is live on every surface (the
  // day lightmap leaves it out), so its shadow map covers the part of the
  // room the seat can see: the walls, window and blinds cast the stripes.
  const sunDirection = new Vector3().fromArray(sunSpec.direction).normalize();
  const sun = new DirectionalLight(new Color().fromArray(sunSpec.color), 0);
  sun.target.position.set(0, 1.2, -0.3);
  sun.position.copy(sun.target.position).addScaledVector(sunDirection, -4);
  sun.castShadow = true;
  // 2.3 mm texels: fine for the blinds' stripes, whose penumbra is wider;
  // the hands' own shadows on the desk come from sunDetail below.
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0002;
  // The tent filter compares each tap along the receiver's plane
  // (shadows.ts), but inside one hardware 2×2 lookup a surface the sun
  // grazes still drops several millimetres, which speckles the back of a
  // hand near its terminator. Sampling from 6 mm off the skin clears that;
  // contact shadows under the fingertips shift by less than their penumbra.
  sun.shadow.normalBias = 0.006;
  // The sun's disc softens the blinds' slat shadows by about a centimetre
  // at the desk: a tent filter reaching four texels (9 mm) either side
  // reproduces that instead of hard stripes.
  sun.shadow.radius = 4;
  Object.assign(sun.shadow.camera, { left: -2.4, right: 2.4, top: 2.4, bottom: -2.4, ...SUN_SHADOW_DEPTH });
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun, sun.target);
  // The sun's shadow over the desk (shadows.ts): dark itself, 0.5 mm texels
  // around the keyboard and mouse. A fingertip's contact shadow keeps within
  // a millimetre of it with a 2 mm normal offset, and a tent two texels
  // either side stays smooth where the sun grazes the desk.
  const sunDetail = new DirectionalLight(0xffffff, 0);
  sunDetail.castShadow = true;
  sunDetail.shadow.mapSize.set(2048, 2048);
  sunDetail.shadow.bias = -0.0002;
  sunDetail.shadow.normalBias = 0.002;
  sunDetail.shadow.radius = 2;
  fitSunDetail(sun, sunDetail, new Vector3(0.05, 0.8, -0.08));
  scene.add(sunDetail, sunDetail.target);
  // The hands' soft shadow in the room's own light (shadows.ts), from the
  // window's sky above the sun: dark, 7 mm texels over the keyboard and the
  // mouse, and a tent five texels either side, so it spreads a few
  // centimetres as a shadow under a whole sky does; a centimetre's offset
  // on skin (skin.ts's normal bias) keeps the hand's lit back out of it.
  // Added after the sun's two lights: shadows.ts reads it as the third.
  const skyShade = new DirectionalLight(0xffffff, 0);
  skyShade.castShadow = true;
  skyShade.shadow.mapSize.set(128, 128);
  skyShade.shadow.bias = -0.003;
  skyShade.shadow.normalBias = 0.004;
  skyShade.shadow.radius = 5;
  fitSkyShade(skyShade, new Vector3(-0.45, 0.8, -0.4), new Vector3(0.07, 0.76, -0.1));
  scene.add(skyShade, skyShade.target);

  let day = resolvedMode() === 'light' ? 1 : 0;
  let dayGoal = day;
  const unsubscribeMode = subscribeTheme(() => {
    dayGoal = resolvedMode() === 'light' ? 1 : 0;
  });
  let probes: LocalProbes | null = null;
  const lighting = (blend: number) => {
    const exposure = EXPOSURE * MathUtils.lerp(1, DAY_EXPOSURE, blend);
    lamp.intensity = lampSpec.intensity * exposure * (1 - blend);
    sun.intensity = sunSpec.intensity * exposure * blend;
    // A light that is off keeps its last shadow map instead of re-rendering it.
    lamp.shadow.autoUpdate = blend < 1;
    sun.shadow.autoUpdate = blend > 0;
    sunDetail.shadow.autoUpdate = blend > 0;
    // Swap panoramas at the midpoint, where their contribution dips.
    scene.environment = blend < 0.5 ? room.environments.night : room.environments.day;
    scene.environmentIntensity = exposure * (0.35 + 0.65 * Math.abs(blend - 0.5) * 2);
    probes?.apply(blend < 0.5, scene.environmentIntensity);
    screen.setEnvironment(scene.environment, scene.environmentIntensity);
    devices.setEnvironment(scene.environment, scene.environmentIntensity);
    room.setExposure(exposure);
    room.setDayBlend(blend);
    bloom.luminanceMaterial.threshold = MathUtils.lerp(BLOOM_THRESHOLD.night, BLOOM_THRESHOLD.day, blend);
  };

  const { atmosphere, objects: atmosphereObjects } = createAtmosphere(room.scene, {
    lampPosition: lamp.position.clone(),
    lampDirection: new Vector3().fromArray(lampSpec.direction).normalize(),
    lampCosOuter: Math.cos(lamp.angle),
    lampColor: lamp.color.clone(),
    sunDirection,
    sunColor: sun.color.clone(),
  });
  scene.add(...atmosphereObjects);
  const devices = createDeskDevices(room.scene);

  // --- Post-processing -----------------------------------------------------
  const composer = new EffectComposer(renderer, { frameBufferType: HalfFloatType, multisampling: 4 });
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new BloomEffect({
    mipmapBlur: true,
    luminanceThreshold: BLOOM_THRESHOLD.night,
    luminanceSmoothing: 0.22,
    intensity: 0.55,
    radius: 0.72,
  });
  const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.NEUTRAL });
  const vignette = new VignetteEffect({ offset: 0.3, darkness: 0.62 });
  const grain = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
  grain.blendMode.opacity.value = 0.07;
  const effects = new EffectPass(camera, bloom, toneMapping, vignette, grain);
  effects.dithering = true;
  composer.addPass(effects);
  // Every shadow map renders once even if its light starts off: a shadow
  // sampler without a depth map makes every shadow-receiving draw fail.
  // The night probes (probes.ts) are captured first, lit as at night.
  const renderShadowsOnce = () => {
    lamp.shadow.needsUpdate = true;
    sun.shadow.needsUpdate = true;
    sunDetail.shadow.needsUpdate = true;
  };
  lighting(0);
  renderShadowsOnce();
  devices.update(Date.now(), 0);
  const keyboardBox = new Box3().setFromObject(keyboard.group);
  const lampLed = room.scene.getObjectByName('emit_lampLed');
  probes = captureProbes(
    renderer,
    scene,
    [
      // One probe over the home row for the hands, the keys and the mouse:
      // seen from any of them the room differs by a few percent, and each
      // probe costs six renders of the room while it loads.
      {
        at: keyboardBox.getCenter(new Vector3()).setY(keyboardBox.max.y + 0.04),
        objects: [arms.scene, keyboard.group, mouse.group],
      },
      ...propSites(room.scene),
    ],
    [arms.scene, screen.mesh, ...atmosphereObjects, ...(lampLed ? [lampLed] : [])],
  );
  lighting(day);
  renderShadowsOnce();

  // --- Input -----------------------------------------------------------------
  const pointer = new Vector2();
  let typing = 0;
  let zoom = 0;
  // The right hand takes the mouse while the visitor moves the pointer and
  // is not typing, and goes back to the keys on the next keystroke.
  let lastPointerMove = -10;
  let lastKeyAt = -10;
  let clicking = false;
  const onPointerMove = (event: PointerEvent) => {
    pointer.set((event.clientX / window.innerWidth) * 2 - 1, -(event.clientY / window.innerHeight) * 2 + 1);
    if (event.isTrusted && event.target === canvas) lastPointerMove = performance.now() / 1000;
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.target !== canvas) return;
    clicking = true;
    lastPointerMove = performance.now() / 1000;
  };
  const onPointerUp = () => {
    clicking = false;
  };
  const resolveCode = (code: string) => (KEY_BY_CODE[code] ? code : CODE_ALIASES[code]);
  // One path for real keystrokes and the auto-typed arrival command.
  const press = (code: string) => {
    typing = Math.min(1, typing + 0.35);
    lastKeyAt = performance.now() / 1000;
    keyboard.setPressed(code, true);
    hands.keyDown(code);
    audio.keyDown(code, KEY_BY_CODE[code].width);
  };
  const release = (code: string) => {
    keyboard.setPressed(code, false);
    hands.keyUp(code);
    audio.keyUp(code, KEY_BY_CODE[code].width);
  };
  let cancelAutoType: (() => void) | null = null;
  const onKeyDown = (event: KeyboardEvent) => {
    const code = resolveCode(event.code);
    if (!code) return;
    // The visitor takes over the keyboard.
    cancelAutoType?.();
    cancelAutoType = null;
    if (event.repeat) {
      typing = Math.min(1, typing + 0.1);
      return;
    }
    press(code);
  };
  const onKeyUp = (event: KeyboardEvent) => {
    const code = resolveCode(event.code);
    if (code) release(code);
  };
  const releaseAll = () => {
    for (const code in KEY_BY_CODE) keyboard.setPressed(code, false);
    hands.releaseAll();
  };
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', releaseAll);
  const detachPointer = attachScreenPointer({
    canvas,
    camera,
    getHandle: getTerminal,
    onZoom: (delta) => {
      zoom = MathUtils.clamp(zoom + delta * 0.004, 0, 1);
      options.onZoom?.(zoom);
    },
  });

  // --- Sizing --------------------------------------------------------------
  const resize = () => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    composer.setSize(width, height, false);
    pov.setAspect(width / height);
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  resize();

  // --- Frame loop ----------------------------------------------------------
  let frame = 0;
  let last = performance.now();
  let running = true;
  let frameCount = 0;
  const frameIntervals: number[] = [];
  const tick = (now: number) => {
    if (!running) return;
    frame = requestAnimationFrame(tick);
    const interval = now - last;
    const dt = Math.min(0.05, interval / 1000);
    last = now;
    frameCount += 1;
    if (frameCount > PERF_SKIP_FRAMES && frameIntervals.length < PERF_SAMPLE_FRAMES) {
      frameIntervals.push(interval);
      if (frameIntervals.length === PERF_SAMPLE_FRAMES) {
        frameIntervals.sort((a, b) => a - b);
        if (frameIntervals[PERF_SAMPLE_FRAMES / 2] > SLOW_FRAME_MS && renderer.getPixelRatio() > 1) {
          renderer.setPixelRatio(1);
          resize();
        }
      }
    }
    typing = Math.max(0, typing - dt / TYPING_DECAY_SECONDS);

    screen.update();
    room.screenRadiance.copy(screen.light.color);
    screenLight.color.copy(screen.light.color).multiplyScalar(1 / Math.max(1e-4, screen.light.luminance));
    screenLight.intensity = screen.light.luminance;

    const seconds = now / 1000;
    const usingMouse = seconds - lastPointerMove < 1.6 && seconds - lastKeyAt > 0.5;
    if (usingMouse) mouse.setPointer(pointer);
    mouse.setButton(usingMouse && clicking);
    mouse.update(dt);
    hands.setMouse({ holding: usingMouse, clicking: usingMouse && clicking });

    keyboard.update(dt);
    hands.update(dt, seconds);
    if (day !== dayGoal) {
      day = reducedMotion
        ? dayGoal
        : MathUtils.clamp(day + Math.sign(dayGoal - day) * (dt / DAY_TRANSITION_SECONDS), 0, 1);
      // Ease so the change starts and settles gently.
      lighting(day * day * (3 - 2 * day));
      audio.setDay(day);
    }
    atmosphere.update(seconds, day, 1 - day);
    devices.update(Date.now(), day);
    pov.update(dt, { pointer, typing, zoom });
    composer.render(dt);
  };

  screen.bind(getTerminal());
  pov.playIntro();
  options.onProgress?.(1);
  frame = requestAnimationFrame(tick);

  const onVisibility = () => {
    if (document.hidden) {
      running = false;
      cancelAnimationFrame(frame);
    } else if (!running) {
      running = true;
      last = performance.now();
      frame = requestAnimationFrame(tick);
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    bindTerminal: (handle) => screen.bind(handle),
    setZoom: (value) => {
      zoom = MathUtils.clamp(value, 0, 1);
    },
    typeText(text, send) {
      cancelAutoType?.();
      cancelAutoType = typeText(text, { press, release }, send);
    },
    setSound(enabled) {
      audio.setEnabled(enabled);
    },
    dispose() {
      running = false;
      cancelAutoType?.();
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribeMode();
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', releaseAll);
      detachPointer();
      resizeObserver.disconnect();
      screen.dispose();
      keyboard.dispose();
      mouse.dispose();
      atmosphere.dispose();
      probes?.dispose();
      room.dispose();
      disposeTree(arms.scene);
      lamp.shadow.dispose();
      sun.shadow.dispose();
      sunDetail.shadow.dispose();
      skyShade.shadow.dispose();
      audio.dispose();
      composer.dispose();
      renderer.dispose();
    },
  };
}
