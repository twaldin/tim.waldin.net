// Small living details: dust motes drifting through the key light, steam
// off the coffee, and rain running down the window at night.
import {
  AdditiveBlending,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Mesh,
  NormalBlending,
  PlaneGeometry,
  Points,
  ShaderMaterial,
  Vector3,
  type Object3D,
} from 'three';

export interface AtmosphereLights {
  lampPosition: Vector3;
  lampDirection: Vector3;
  lampCosOuter: number;
  lampColor: Color;
  sunDirection: Vector3; // direction the sunlight travels
  sunColor: Color;
}

export interface Atmosphere {
  update(time: number, day: number, lampOn: number): void;
  dispose(): void;
}

const DUST_COUNT = 700;

function createDust(lights: AtmosphereLights, windowCenter: Vector3) {
  const geometry = new BufferGeometry();
  const seeds = new Float32Array(DUST_COUNT * 4);
  for (let i = 0; i < DUST_COUNT; i++) {
    seeds[i * 4] = Math.random();
    seeds[i * 4 + 1] = Math.random();
    seeds[i * 4 + 2] = Math.random();
    seeds[i * 4 + 3] = Math.random();
  }
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(DUST_COUNT * 3), 3));
  geometry.setAttribute('seed', new BufferAttribute(seeds, 4));
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: {
      time: { value: 0 },
      day: { value: 0 },
      lampOn: { value: 1 },
      boxMin: { value: new Vector3(-0.9, 0.76, -0.75) },
      boxSize: { value: new Vector3(1.3, 0.75, 0.95) },
      lampPosition: { value: lights.lampPosition },
      lampDirection: { value: lights.lampDirection },
      lampCosOuter: { value: lights.lampCosOuter },
      lampColor: { value: lights.lampColor },
      sunDirection: { value: lights.sunDirection },
      sunColor: { value: lights.sunColor },
      windowCenter: { value: windowCenter },
    },
    vertexShader: /* glsl */ `
      attribute vec4 seed;
      uniform float time;
      uniform vec3 boxMin;
      uniform vec3 boxSize;
      uniform vec3 lampPosition;
      uniform vec3 lampDirection;
      uniform float lampCosOuter;
      uniform vec3 lampColor;
      uniform vec3 sunDirection;
      uniform vec3 sunColor;
      uniform vec3 windowCenter;
      uniform float day;
      uniform float lampOn;
      varying vec3 vColor;
      void main() {
        // Slow Brownian-ish drift inside the box, wrapping vertically.
        vec3 p = seed.xyz;
        float t = time * (0.004 + seed.w * 0.006);
        p.x += sin(time * 0.11 + seed.w * 31.0) * 0.03;
        p.z += cos(time * 0.09 + seed.x * 17.0) * 0.03;
        p.y = fract(p.y - t + sin(time * 0.2 + seed.z * 9.0) * 0.01);
        vec3 world = boxMin + p * boxSize;

        // Lamp cone.
        vec3 toP = world - lampPosition;
        float d = length(toP);
        float cone = smoothstep(lampCosOuter, mix(lampCosOuter, 1.0, 0.5), dot(toP / d, lampDirection));
        vec3 lit = lampColor * cone * lampOn * 0.006 / (d * d);

        // Sun shaft through the window: close to the ray from the window.
        vec3 fromWin = world - windowCenter;
        float along = dot(fromWin, sunDirection);
        float off = length(fromWin - along * sunDirection);
        float shaft = step(0.0, along) * smoothstep(0.45, 0.12, off);
        lit += sunColor * shaft * day * 0.05;

        vColor = lit;
        vec4 mv = modelViewMatrix * vec4(world, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = (0.6 + seed.w * 1.2) * 0.0016 * projectionMatrix[1][1] * 900.0 / -mv.z;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.0, length(c));
        gl_FragColor = vec4(vColor * a, 1.0);
      }
    `,
  });
  const points = new Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 5;
  return { object: points, material, geometry };
}

// Coffee steam is a faint pale wisp a few centimetres tall. Tinted by the
// lamp or sun colour it read as an orange-brown smoke column, and its
// billboard tinted the speaker behind it.
const STEAM_COLOR = new Color(0.8, 0.83, 0.88);

function createSteam(anchor: Vector3) {
  const geometry = new PlaneGeometry(0.06, 0.09, 1, 1);
  geometry.translate(0, 0.045, 0);
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: NormalBlending,
    uniforms: {
      time: { value: 0 },
      tint: { value: STEAM_COLOR.clone() },
      strength: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        // Billboard around the vertical axis.
        vec4 center = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vec3 offset = position;
        gl_Position = projectionMatrix * (center + vec4(offset.x, offset.y, 0.0, 0.0));
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float time;
      uniform vec3 tint;
      uniform float strength;
      varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
      }
      float fbm(vec2 p) { float v = 0.0; float a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
      void main() {
        vec2 uv = vUv;
        float rise = time * 0.18;
        // Wisps curl sideways more as they rise.
        uv.x += (fbm(vec2(uv.y * 3.0 - rise, time * 0.1)) - 0.5) * 0.6 * uv.y;
        float column = smoothstep(0.5, 0.08, abs(uv.x - 0.5));
        float n = fbm(vec2(uv.x * 4.0, uv.y * 3.0 - rise * 2.0));
        float fade = smoothstep(0.0, 0.12, uv.y) * smoothstep(1.0, 0.35, uv.y);
        float a = column * smoothstep(0.35, 0.85, n) * fade * 0.07 * strength;
        gl_FragColor = vec4(tint, a);
      }
    `,
  });
  const mesh = new Mesh(geometry, material);
  mesh.position.copy(anchor);
  mesh.renderOrder = 6;
  return { object: mesh, material, geometry };
}

function createRain(glass: Mesh) {
  glass.geometry.computeBoundingBox();
  const box = glass.geometry.boundingBox!.clone().applyMatrix4(glass.matrixWorld);
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      time: { value: 0 },
      wet: { value: 1 },
      boxMin: { value: box.min },
      boxSize: { value: box.getSize(new Vector3()) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float time;
      uniform float wet;
      uniform vec3 boxMin;
      uniform vec3 boxSize;
      varying vec3 vWorld;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

      // One layer of drops: beads sliding down with thin trails. Returns the
      // drop's lens offset (xy) and coverage (z).
      vec3 drops(vec2 uv, float scale, float speed) {
        vec2 grid = vec2(scale, scale * 1.6);
        vec2 p = uv * grid;
        vec2 id = floor(p);
        float r = hash(id);
        float fall = fract(time * speed * (0.3 + r) + r);
        vec2 f = fract(p) - vec2(0.5, 1.0 - fall);
        f.x += sin(p.y * 3.0 + r * 6.28) * 0.08;
        float size = 0.12 + 0.1 * r;
        float d = length(f * vec2(1.0, 0.7));
        float drop = smoothstep(size, size * 0.6, d) * step(0.64, r);
        float trail = smoothstep(0.05, 0.0, abs(f.x)) * step(0.0, f.y) * smoothstep(0.9, 0.0, f.y) * step(0.64, r) * 0.35;
        return vec3(f * drop, max(drop, trail));
      }

      void main() {
        vec2 uv = (vWorld.xy - boxMin.xy) / boxSize.xy;
        vec3 a = drops(uv, 36.0, 0.04);
        vec3 b = drops(uv * 1.7 + 3.1, 58.0, 0.07);
        float mask = max(a.z, b.z);
        // Each bead is a tiny lens: dark, with a glint of the street below
        // catching its lower edge.
        float rim = clamp(dot(normalize(a.xy + b.xy + 1e-4), vec2(0.0, -1.0)), 0.0, 1.0);
        vec3 color = vec3(0.02, 0.022, 0.028) + vec3(0.28, 0.24, 0.2) * pow(rim, 6.0);
        gl_FragColor = vec4(color, mask * wet * 0.18);
        #include <colorspace_fragment>
      }
    `,
  });
  const overlay = new Mesh(glass.geometry, material);
  overlay.applyMatrix4(glass.matrixWorld);
  overlay.renderOrder = 3;
  return { object: overlay, material };
}

export function createAtmosphere(
  roomScene: Object3D,
  lights: AtmosphereLights,
): { atmosphere: Atmosphere; objects: Object3D[] } {
  const glass = roomScene.getObjectByName('rt_windowGlass');
  if (!(glass instanceof Mesh)) throw new Error('room.glb has no rt_windowGlass mesh');
  const dust = createDust(lights, new Box3().setFromObject(glass).getCenter(new Vector3()));
  const objects: Object3D[] = [dust.object];

  let steam: { object: Mesh; material: ShaderMaterial; geometry: PlaneGeometry } | null = null;
  const coffee = roomScene.getObjectByName('coffee');
  if (coffee) {
    const box = new Box3().setFromObject(coffee);
    steam = createSteam(new Vector3((box.min.x + box.max.x) / 2, box.max.y + 0.004, (box.min.z + box.max.z) / 2));
    objects.push(steam.object);
  }

  const rain = createRain(glass);
  objects.push(rain.object);

  return {
    objects,
    atmosphere: {
      update(time, day, lampOn) {
        dust.material.uniforms.time.value = time;
        dust.material.uniforms.day.value = day;
        dust.material.uniforms.lampOn.value = lampOn;
        if (steam) {
          steam.material.uniforms.time.value = time;
          steam.material.uniforms.tint.value.copy(STEAM_COLOR).multiplyScalar(0.5 + 0.3 * day);
        }
        rain.material.uniforms.time.value = time;
        rain.material.uniforms.wet.value = 1 - day;
      },
      dispose() {
        dust.geometry.dispose();
        dust.material.dispose();
        steam?.geometry.dispose();
        steam?.material.dispose();
        rain.material.dispose();
      },
    },
  };
}
