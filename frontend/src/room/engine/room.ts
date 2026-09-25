// Loads the Blender-built room (public/room/, built by scripts/room/build_room.py).
// Static meshes keep their PBR materials and textures; their diffuse light
// comes from Cycles lightmaps that share one atlas (TEXCOORD_1): night
// (desk lamp, LED strip, the street at night), day (skylight and all bounce
// light) and the monitor alone, which is tinted by whatever the terminal
// shows. The sun's direct light is live (shadowed by the blinds); other
// realtime lights add only specular to these surfaces. The hands and
// keyboard get the full realtime lighting (see engine.ts).
import {
  BufferGeometry,
  Color,
  EquirectangularReflectionMapping,
  Float32BufferAttribute,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  ShaderChunk,
  ShaderMaterial,
  SRGBColorSpace,
  TextureLoader,
  Texture,
  Vector3,
  type Group,
  type IUniform,
  type Material,
  type Object3D,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

const BASE = '/room/';

// Frees a loaded glTF tree: geometries, materials and the textures they hold
// (a material's dispose() leaves its textures on the GPU).
export function disposeTree(root: Object3D) {
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.geometry.dispose();
    const materials: Material[] = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      for (const value of Object.values(material)) if (value instanceof Texture) value.dispose();
      material.dispose();
    }
  });
}

interface LightmapEntry {
  file: string;
  scale: number;
}

export interface RoomManifest {
  // Lightmaps are log-encoded: code e -> scale / range * ((range + 1)^e - 1).
  lightmaps: { range: number; night: LightmapEntry; day: LightmapEntry; screen: LightmapEntry };
  environments: { night: string; day: string };
  // The view out of the window, rendered flat at the facade's depth.
  street: { corners: number[][]; night: LightmapEntry; day: LightmapEntry };
  // Emissive materials by name: Blender emission strength per state.
  emitters: Record<string, { color: number[]; night: number; day: number }>;
  // Realtime lights for the dynamic objects, in units that match the bake.
  lights: {
    lamp: { position: number[]; direction: number[]; angle: number; penumbra: number; color: number[]; intensity: number };
    sun: { direction: number[]; color: number[]; intensity: number };
  };
}

export interface LoadedRoom {
  scene: Group;
  manifest: RoomManifest;
  environments: { night: Texture; day: Texture };
  // Average linear radiance of the monitor panel; scales the screen lightmap.
  screenRadiance: Color;
  setExposure(value: number): void;
  // 0 = night, 1 = day.
  setDayBlend(value: number): void;
  dispose(): void;
}

const LAMBERT_DIRECT = 'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );';
const RECT_AREA_DIFFUSE =
  'reflectedLight.directDiffuse += lightColor * material.diffuseContribution * LTC_Evaluate( normal, viewDir, position, mat3( 1.0 ), rectCoords );';
const LIGHTMAP_SAMPLE = 'vec3 lightMapIrradiance = lightMapTexel.rgb * lightMapIntensity;';
const IBL_DIFFUSE = 'iblIrradiance += getIBLIrradiance( geometryNormal );';
const FIRST_LIGHT_LOOP = '#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )';
const DIRECTIONAL_LOOP = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )';

for (const [chunk, line] of [
  ['lights_physical_pars_fragment', LAMBERT_DIRECT],
  ['lights_physical_pars_fragment', RECT_AREA_DIFFUSE],
  ['lights_fragment_maps', LIGHTMAP_SAMPLE],
  ['lights_fragment_maps', IBL_DIFFUSE],
  ['lights_fragment_begin', FIRST_LIGHT_LOOP],
  ['lights_fragment_begin', DIRECTIONAL_LOOP],
] as const) {
  if (!ShaderChunk[chunk].includes(line)) console.warn(`room.ts: three.js ${chunk} changed; baked lighting is wrong`);
}

// Diffuse comes from the blended lightmaps (every bounce, the lamp's direct
// light, skylight) plus the live sun: the only directional light, whose
// direct light the day map leaves out so the blinds' stripes stay crisp.
// Other realtime lights and the environment contribute specular only.
const staticLightsPars = `float roomDirectDiffuse;\n${ShaderChunk.lights_physical_pars_fragment
  .replace(LAMBERT_DIRECT, LAMBERT_DIRECT.replace('+= irradiance', '+= roomDirectDiffuse * irradiance'))
  .replace(RECT_AREA_DIFFUSE, '')}`;
const staticLightsMaps = ShaderChunk.lights_fragment_maps
  .replace(
    LIGHTMAP_SAMPLE,
    /* glsl */ `vec3 lightMapIrradiance = (
      mix(
        decodeLightmap( lightMapTexel.rgb, lightMapScales.x ),
        decodeLightmap( texture2D( lightMapDay, vLightMapUv ).rgb, lightMapScales.y ),
        dayBlend
      )
      + decodeLightmap( texture2D( lightMapScreen, vLightMapUv ).rgb, lightMapScales.z ) * screenRadiance
    ) * lightMapIntensity;`,
  )
  .replace(IBL_DIFFUSE, '');

// Lightmaps hold log-encoded data (decoded in the shader), not colours.
function loadTexture(loader: TextureLoader, url: string) {
  return loader.loadAsync(url).then((texture) => {
    texture.flipY = false; // glTF UV convention
    texture.channel = 1;
    return texture;
  });
}

// Loader rejections are DOM events; turn them into errors that name the file.
function named<T>(url: string, promise: Promise<T>) {
  return promise.catch((cause: unknown) => {
    throw new Error(`room asset failed to load: ${url}`, { cause });
  });
}

export async function loadRoom(onProgress: (fraction: number) => void): Promise<LoadedRoom> {
  const manifest: RoomManifest = await fetch(`${BASE}room.json`).then((r) => {
    if (!r.ok) throw new Error(`room.json: ${r.status}`);
    return r.json();
  });

  const textureLoader = new TextureLoader();
  const hdrLoader = new HDRLoader();
  const { lightmaps, environments } = manifest;
  let loaded = 0;
  const step = <T,>(url: string, promise: Promise<T>) =>
    named(url, promise).then((value) => {
      loaded += 1;
      onProgress(loaded / 8);
      return value;
    });

  const { street } = manifest;
  const [gltf, envNight, envDay, lmNight, lmDay, lmScreen, streetNight, streetDay] = await Promise.all([
    step('room.glb', new GLTFLoader().loadAsync(`${BASE}room.glb`)),
    step(environments.night, hdrLoader.loadAsync(BASE + environments.night)),
    step(environments.day, hdrLoader.loadAsync(BASE + environments.day)),
    step(lightmaps.night.file, loadTexture(textureLoader, BASE + lightmaps.night.file)),
    step(lightmaps.day.file, loadTexture(textureLoader, BASE + lightmaps.day.file)),
    step(lightmaps.screen.file, loadTexture(textureLoader, BASE + lightmaps.screen.file)),
    step(street.night.file, loadTexture(textureLoader, BASE + street.night.file)),
    step(street.day.file, loadTexture(textureLoader, BASE + street.day.file)),
  ]);
  envNight.mapping = EquirectangularReflectionMapping;
  envDay.mapping = EquirectangularReflectionMapping;

  const screenRadiance = new Color(0, 0, 0);
  const shared: Record<string, IUniform> = {
    lightMapDay: { value: lmDay },
    lightMapScreen: { value: lmScreen },
    lightMapScales: { value: new Vector3(lightmaps.night.scale, lightmaps.day.scale, lightmaps.screen.scale) },
    lightMapRange: { value: lightmaps.range },
    dayBlend: { value: 0 },
    screenRadiance: { value: screenRadiance },
  };
  const baked = new Set<MeshStandardMaterial>();
  const emitters: { material: MeshStandardMaterial; night: number; day: number }[] = [];
  const disposables: { dispose(): void }[] = [envNight, envDay, lmNight, lmDay, lmScreen, streetNight, streetDay];

  // Rendered radiance: shown as is, cross-fading between night and day.
  const streetGeometry = new BufferGeometry();
  streetGeometry.setAttribute('position', new Float32BufferAttribute(street.corners.flat(), 3));
  streetGeometry.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  streetGeometry.setIndex([0, 1, 2, 0, 2, 3]);
  for (const texture of [streetNight, streetDay]) {
    texture.colorSpace = SRGBColorSpace;
    texture.flipY = true;
    texture.channel = 0;
  }
  const streetMaterial = new ShaderMaterial({
    uniforms: {
      night: { value: streetNight },
      day: { value: streetDay },
      scales: { value: new Vector3(street.night.scale, street.day.scale, 1) },
      dayBlend: shared.dayBlend,
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D night;
      uniform sampler2D day;
      uniform vec3 scales;
      uniform float dayBlend;
      varying vec2 vUv;
      void main() {
        vec3 color = mix(texture2D(night, vUv).rgb * scales.x, texture2D(day, vUv).rgb * scales.y, dayBlend) * scales.z;
        gl_FragColor = vec4(color, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    toneMapped: true,
  });
  const streetCard = new Mesh(streetGeometry, streetMaterial);
  streetCard.name = 'street_card';
  gltf.scene.add(streetCard);
  disposables.push(streetGeometry, streetMaterial);

  const bake = (material: MeshStandardMaterial) => {
    if (baked.has(material)) return;
    baked.add(material);
    material.lightMap = lmNight;
    material.aoMap = null; // the lightmap already holds the occlusion
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, shared);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <lightmap_pars_fragment>',
          /* glsl */ `#include <lightmap_pars_fragment>
          uniform sampler2D lightMapDay;
          uniform sampler2D lightMapScreen;
          uniform vec3 lightMapScales;
          uniform float lightMapRange;
          uniform float dayBlend;
          uniform vec3 screenRadiance;
          vec3 decodeLightmap( vec3 code, float scale ) {
            return scale / lightMapRange * ( exp2( code * log2( lightMapRange + 1.0 ) ) - 1.0 );
          }`,
        )
        .replace('#include <lights_physical_pars_fragment>', staticLightsPars)
        // Read at compile time: engine.ts has shadows.ts patch the sun's
        // shadow lookup into this chunk after this module has loaded.
        .replace(
          '#include <lights_fragment_begin>',
          ShaderChunk.lights_fragment_begin
            .replace(FIRST_LIGHT_LOOP, `roomDirectDiffuse = 0.0;\n${FIRST_LIGHT_LOOP}`)
            .replace(DIRECTIONAL_LOOP, `roomDirectDiffuse = 1.0;\n${DIRECTIONAL_LOOP}`),
        )
        .replace('#include <lights_fragment_maps>', staticLightsMaps);
    };
    material.customProgramCacheKey = () => 'room-baked';
    material.needsUpdate = true;
  };

  gltf.scene.traverse((object) => {
    if (!(object instanceof Mesh) || object === streetCard) return;
    const { name, material } = object;
    if (Array.isArray(material)) return; // GLTFLoader gives every primitive its own mesh

    // The runtime draws its own terminal panel.
    if (name === 'rt_screen') {
      object.visible = false;
      return;
    }
    if (name === 'rt_windowGlass') {
      const glass = new MeshPhysicalMaterial({
        color: '#ffffff',
        metalness: 0,
        roughness: 0.03,
        transparent: true,
        opacity: 0.08,
        envMapIntensity: 1,
        depthWrite: false,
      });
      object.material = glass;
      object.renderOrder = 2;
      disposables.push(material, glass);
      return;
    }
    if (!(material instanceof MeshStandardMaterial)) return;
    const emitter = manifest.emitters[material.name];
    if (emitter) {
      material.emissive.setRGB(emitter.color[0], emitter.color[1], emitter.color[2]);
      emitters.push({ material, night: emitter.night, day: emitter.day });
    }
    if (object.geometry.getAttribute('uv1')) {
      bake(material);
      object.castShadow = true;
      object.receiveShadow = true;
    } else if (name.startsWith('live_')) {
      // Small curved props lit by the realtime lights instead of a lightmap
      // (their materials are their own, never shared with baked meshes).
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });

  let exposure = 1;
  let dayBlend = 0;
  const apply = () => {
    shared.dayBlend.value = dayBlend;
    // Lightmaps store radiance of an albedo-1 surface; three wants irradiance.
    for (const material of baked) material.lightMapIntensity = Math.PI * exposure;
    for (const { material, night, day } of emitters) material.emissiveIntensity = (night + (day - night) * dayBlend) * exposure;
    streetMaterial.uniforms.scales.value.z = exposure;
  };
  apply();

  return {
    scene: gltf.scene,
    manifest,
    environments: { night: envNight, day: envDay },
    screenRadiance,
    setExposure(value) {
      exposure = value;
      apply();
    },
    setDayBlend(value) {
      dayBlend = value;
      apply();
    },
    dispose() {
      disposables.forEach((d) => d.dispose());
      disposeTree(gltf.scene);
    },
  };
}
