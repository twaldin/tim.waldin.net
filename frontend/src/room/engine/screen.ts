// The monitor picture: xterm's WebGL canvas (kept in a hidden layer by
// Terminal's screen mode) sampled as the emissive texture of the panel, plus
// the bridge that turns pointer input on the 3D panel back into DOM mouse
// events on the hidden terminal so selection, links, wheel scrolling and
// mouse-reporting apps keep working.
import {
  CanvasTexture,
  Color,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshStandardMaterial,
  Plane,
  PlaneGeometry,
  Raycaster,
  SRGBColorSpace,
  Vector2,
  Vector3,
  Vector4,
  type Camera,
  type IUniform,
  type WebGLRenderer,
} from 'three';
import type { IDisposable } from '@xterm/xterm';
import type { TerminalScreenHandle } from '@/components/Terminal';
import { getActiveTheme, subscribe as subscribeTheme } from '@/lib/theme-manager';
import { screenPose } from '../layout';

// Fraction of a character cell a typical glyph lights up; used to estimate
// how much light the panel throws into the room from the text density.
const GLYPH_COVERAGE = 0.2;
// Emissive gain for the panel: display white lands just under the bloom
// threshold so only bright, dense text glows.
const PANEL_GAIN = 1.0;
// An IPS panel never reaches black in a dark room.
const BLACK_LEVEL = new Color(0.0028, 0.003, 0.0042);

export interface ScreenLight {
  color: Color; // average linear radiance of the panel (picture × gain)
  luminance: number;
}

export interface TerminalScreen {
  mesh: Mesh;
  bind(handle: TerminalScreenHandle | null): void;
  // Uploads a fresh terminal frame if xterm rendered since the last call.
  update(): void;
  light: ScreenLight;
  dispose(): void;
}

// three allocates immutable storage for a texture on its first upload, and
// xterm resizes its canvas in place: remember the size each texture was
// allocated at so a resize swaps in a new texture instead of writing a
// differently sized frame into the old storage.
interface CanvasTexture2D {
  texture: CanvasTexture;
  width: number;
  height: number;
}

function makeCanvasTexture(canvas: HTMLCanvasElement, renderer: WebGLRenderer, mipmaps: boolean): CanvasTexture2D {
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = mipmaps;
  texture.minFilter = mipmaps ? LinearMipmapLinearFilter : LinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = mipmaps ? renderer.capabilities.getMaxAnisotropy() : 1;
  return { texture, width: canvas.width, height: canvas.height };
}

function isStale(current: CanvasTexture2D, canvas: HTMLCanvasElement) {
  return current.texture.image !== canvas || current.width !== canvas.width || current.height !== canvas.height;
}

export function createTerminalScreen(renderer: WebGLRenderer): TerminalScreen {
  const pose = screenPose();
  const mesh = new Mesh(new PlaneGeometry(pose.width, pose.height));
  mesh.position.copy(pose.center);
  mesh.quaternion.copy(pose.quaternion);
  mesh.name = 'terminal-panel';

  // Blank 1×1 stand-ins until the terminal canvases exist.
  const blank = document.createElement('canvas');
  blank.width = blank.height = 1;
  let main = makeCanvasTexture(blank, renderer, false);
  let link = makeCanvasTexture(blank, renderer, false);

  // Where the xterm canvas sits inside the panel, in panel UV (x0, y0, x1, y1).
  const termRect = new Vector4(0, 0, 1, 1);
  const termBg = new Color();
  const uniforms: Record<string, IUniform> = {
    termLink: { value: link.texture },
    termRect: { value: termRect },
    termBg: { value: termBg },
    termGain: { value: PANEL_GAIN },
    blackLevel: { value: BLACK_LEVEL },
  };

  // Matte anti-glare panel: a dark, fairly rough dielectric that reflects the
  // lamp softly, lit from within by the terminal.
  const material = new MeshStandardMaterial({
    color: '#020203',
    roughness: 0.36,
    metalness: 0,
    emissive: '#ffffff',
    emissiveMap: main.texture,
    envMapIntensity: 0.5,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <emissivemap_pars_fragment>',
        `#include <emissivemap_pars_fragment>
        uniform sampler2D termLink;
        uniform vec4 termRect;
        uniform vec3 termBg;
        uniform float termGain;
        uniform vec3 blackLevel;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `{
          vec2 tuv = (vEmissiveMapUv - termRect.xy) / (termRect.zw - termRect.xy);
          vec3 picture = termBg;
          if (all(greaterThanEqual(tuv, vec2(0.0))) && all(lessThanEqual(tuv, vec2(1.0)))) {
            picture = texture2D(emissiveMap, tuv).rgb;
            vec4 link = texture2D(termLink, tuv);
            picture = mix(picture, link.rgb, link.a);
          }
          // Slight falloff toward the panel edges, like a real edge-lit panel.
          vec2 centered = vEmissiveMapUv * 2.0 - 1.0;
          float falloff = 1.0 - 0.06 * dot(centered * centered, vec2(0.6, 0.9));
          totalEmissiveRadiance = picture * termGain * falloff + blackLevel;
        }`,
      );
  };
  mesh.material = material;

  const light: ScreenLight = { color: new Color(), luminance: 0 };
  const bgColor = new Color();
  const fgColor = new Color();
  const applyTheme = () => {
    const theme = getActiveTheme();
    bgColor.set(theme.background).convertSRGBToLinear();
    fgColor.set(theme.foreground).convertSRGBToLinear();
    termBg.copy(bgColor);
  };
  applyTheme();
  const unsubscribeTheme = subscribeTheme(applyTheme);

  let handle: TerminalScreenHandle | null = null;
  let disposables: IDisposable[] = [];
  let dirty = true;
  let lightDirtyAt = 0;
  let textCoverage = 0;

  const estimateCoverage = () => {
    if (!handle) return;
    const buffer = handle.xterm.buffer.active;
    let filled = 0;
    for (let row = 0; row < handle.xterm.rows; row++) {
      const line = buffer.getLine(buffer.viewportY + row);
      if (line) filled += line.translateToString(true).replace(/\s/g, '').length;
    }
    textCoverage = filled / Math.max(1, handle.xterm.rows * handle.xterm.cols);
  };

  const syncRect = () => {
    if (!handle) return;
    const screenElement = handle.xterm.element?.querySelector('.xterm-screen');
    if (!screenElement) return;
    const host = handle.host.getBoundingClientRect();
    const inner = screenElement.getBoundingClientRect();
    termRect.set(
      (inner.left - host.left) / host.width,
      1 - (inner.bottom - host.top) / host.height,
      (inner.right - host.left) / host.width,
      1 - (inner.top - host.top) / host.height,
    );
  };

  const syncTextures = () => {
    const screenElement = handle?.xterm.element?.querySelector('.xterm-screen');
    const mainCanvas = screenElement?.querySelector<HTMLCanvasElement>('canvas:not(.xterm-link-layer)');
    const linkCanvas = screenElement?.querySelector<HTMLCanvasElement>('canvas.xterm-link-layer');
    if (mainCanvas && isStale(main, mainCanvas)) {
      main.texture.dispose();
      main = makeCanvasTexture(mainCanvas, renderer, true);
      material.emissiveMap = main.texture;
      syncRect();
    }
    if (linkCanvas && isStale(link, linkCanvas)) {
      link.texture.dispose();
      link = makeCanvasTexture(linkCanvas, renderer, false);
      uniforms.termLink.value = link.texture;
    }
  };

  return {
    mesh,
    light,
    bind(next) {
      disposables.forEach((d) => d.dispose());
      disposables = [];
      handle = next;
      if (!next) return;
      disposables.push(
        next.xterm.onRender(() => {
          dirty = true;
        }),
        next.xterm.onResize(() => {
          dirty = true;
          requestAnimationFrame(syncRect);
        }),
      );
      dirty = true;
    },
    update() {
      if (!handle) return;
      syncTextures();
      if (dirty) {
        dirty = false;
        main.texture.needsUpdate = true;
        link.texture.needsUpdate = true;
        const now = performance.now();
        if (now - lightDirtyAt > 250) {
          lightDirtyAt = now;
          estimateCoverage();
          syncRect();
        }
      }
      const lit = Math.min(1, textCoverage * GLYPH_COVERAGE);
      light.color.copy(bgColor).lerp(fgColor, lit).multiplyScalar(PANEL_GAIN);
      light.luminance = light.color.r * 0.2126 + light.color.g * 0.7152 + light.color.b * 0.0722;
    },
    dispose() {
      disposables.forEach((d) => d.dispose());
      unsubscribeTheme();
      main.texture.dispose();
      link.texture.dispose();
      material.dispose();
      mesh.geometry.dispose();
    },
  };
}

export interface ScreenPointerOptions {
  canvas: HTMLCanvasElement;
  camera: Camera;
  getHandle: () => TerminalScreenHandle | null;
  onHoverChange?: (overScreen: boolean) => void;
  // Ctrl+wheel (trackpad pinch) over the room; positive = zoom in.
  onZoom?: (delta: number) => void;
}

// Forwards pointer input on the panel to the hidden xterm DOM. Real mouse
// events over the canvas are stopped at the window (capture phase) so xterm's
// document-level drag listeners only ever see the re-targeted copies.
export function attachScreenPointer(options: ScreenPointerOptions): () => void {
  const { canvas, camera, getHandle } = options;
  const raycaster = new Raycaster();
  const ndc = new Vector2();
  const hit = new Vector3();
  const pose = screenPose();
  const plane = new Plane().setFromNormalAndCoplanarPoint(
    new Vector3(0, 0, 1).applyQuaternion(pose.quaternion),
    pose.center,
  );
  const toPanel = pose.quaternion.clone().invert();
  let dragging = false;
  let overScreen = false;

  // Panel UV under a client point; `extrapolate` keeps mapping past the panel
  // edges (while dragging a selection out of the screen).
  const panelUv = (clientX: number, clientY: number, extrapolate: boolean) => {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    if (!raycaster.ray.intersectPlane(plane, hit)) return null;
    hit.sub(pose.center).applyQuaternion(toPanel);
    const u = hit.x / pose.width + 0.5;
    const v = hit.y / pose.height + 0.5;
    const inside = u >= 0 && u <= 1 && v >= 0 && v <= 1;
    if (!inside && !extrapolate) return null;
    return { u, v, inside };
  };

  const forward = (type: string, source: MouseEvent, uv: { u: number; v: number }) => {
    const handle = getHandle();
    const target = handle?.xterm.element?.querySelector('.xterm-screen');
    if (!handle || !target) return;
    const host = handle.host.getBoundingClientRect();
    const init: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: host.left + uv.u * host.width,
      clientY: host.top + (1 - uv.v) * host.height,
      button: source.button,
      buttons: source.buttons,
      detail: source.detail,
      ctrlKey: source.ctrlKey,
      shiftKey: source.shiftKey,
      altKey: source.altKey,
      metaKey: source.metaKey,
    };
    if (source instanceof WheelEvent) {
      target.dispatchEvent(new WheelEvent(type, {
        ...init,
        deltaX: source.deltaX,
        deltaY: source.deltaY,
        deltaZ: source.deltaZ,
        deltaMode: source.deltaMode,
      }));
    } else {
      target.dispatchEvent(new MouseEvent(type, init));
    }
  };

  const setHover = (next: boolean) => {
    if (next === overScreen) return;
    overScreen = next;
    options.onHoverChange?.(next);
    if (!next) {
      const target = getHandle()?.xterm.element?.querySelector('.xterm-screen');
      target?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    }
  };

  const updateCursor = () => {
    const target = getHandle()?.xterm.element?.querySelector('.xterm-screen');
    canvas.style.cursor = !overScreen
      ? 'default'
      : target?.classList.contains('xterm-cursor-pointer') ? 'pointer' : 'text';
  };

  const onMouseDown = (event: MouseEvent) => {
    if (!event.isTrusted || event.target !== canvas) return;
    event.stopPropagation();
    // Keep keyboard focus in xterm's textarea; the canvas never takes it.
    event.preventDefault();
    const uv = panelUv(event.clientX, event.clientY, false);
    if (uv) {
      dragging = true;
      forward('mousedown', event, uv);
    }
    getHandle()?.xterm.focus();
  };

  const onMouseMove = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    if (!dragging && event.target !== canvas) {
      setHover(false);
      return;
    }
    event.stopPropagation();
    const uv = panelUv(event.clientX, event.clientY, dragging);
    setHover(Boolean(uv?.inside));
    if (uv) forward('mousemove', event, uv);
    updateCursor();
  };

  const onMouseUp = (event: MouseEvent) => {
    if (!event.isTrusted || (!dragging && event.target !== canvas)) return;
    event.stopPropagation();
    const uv = panelUv(event.clientX, event.clientY, true);
    if (uv && (dragging || uv.inside)) forward('mouseup', event, uv);
    dragging = false;
  };

  const onWheel = (event: WheelEvent) => {
    if (event.target !== canvas) return;
    event.preventDefault();
    if (event.ctrlKey) {
      options.onZoom?.(-event.deltaY);
      return;
    }
    // Wheel anywhere in the room scrolls the terminal: it is the only thing
    // on screen that scrolls.
    const uv = panelUv(event.clientX, event.clientY, true) ?? { u: 0.5, v: 0.5 };
    forward('wheel', event, { u: Math.min(1, Math.max(0, uv.u)), v: Math.min(1, Math.max(0, uv.v)) });
  };

  const onContextMenu = (event: MouseEvent) => {
    if (event.target === canvas) event.preventDefault();
  };

  const onLeave = () => {
    if (!dragging) setHover(false);
    updateCursor();
  };

  window.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('mousemove', onMouseMove, true);
  window.addEventListener('mouseup', onMouseUp, true);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('mouseleave', onLeave);
  return () => {
    window.removeEventListener('mousedown', onMouseDown, true);
    window.removeEventListener('mousemove', onMouseMove, true);
    window.removeEventListener('mouseup', onMouseUp, true);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('contextmenu', onContextMenu);
    canvas.removeEventListener('mouseleave', onLeave);
  };
}
