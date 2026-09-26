// Light from right beside the realtime objects at night. The room panorama
// is one capture from the seat, and at night most of what lights the room
// sits within centimetres of the props: the LED strip and the wall it
// washes lilac behind the speaker and the mug, the hex panels above them.
// From the seat those are small and far; from the speaker they fill half
// its view (toward the wall it takes about four times the panorama's
// light). So at night each realtime object takes its own light probe: the
// room rendered from the object's centre with the object itself hidden,
// prefiltered like the panorama. The room is baked, so that render is
// exactly the light it shows, in the bake's units. The probes leave out
// what the realtime lights add themselves (the lamp's LED is the spot
// light, the monitor its area light) and whatever moves (the arms, the
// atmosphere's dust and steam). By day the window's
// sky lights the whole room from one side and the panorama, rendered
// seeing the sky that lit the bake rather than the street photo in the
// window, is the better match; the probes switch off at the midpoint of
// the transition, where the panoramas swap too.
import {
  Box3,
  CubeCamera,
  HalfFloatType,
  Mesh,
  MeshStandardMaterial,
  PMREMGenerator,
  Vector3,
  WebGLCubeRenderTarget,
  type Object3D,
  type Scene,
  type WebGLRenderer,
} from 'three';

// Faces of 256 texels, the size three prefilters the panoramas at: a probe
// then compiles to the same shader as the panorama it stands in for, so the
// theme's midpoint swap recompiles nothing.
const PROBE_SIZE = 256;

export interface ProbeSite {
  // Captured from here, with `objects` hidden; lights their materials.
  at: Vector3;
  objects: Object3D[];
  // Hidden from this probe only, lighting nothing (a prop's own LED).
  alsoHidden?: Object3D[];
}

export interface LocalProbes {
  // Night probes on (true) or back to the scene's panorama.
  apply(on: boolean, intensity: number): void;
  dispose(): void;
}

// The room's props lit by the realtime lights (`live_*` meshes), grouped
// into the objects they make up (a mug is five meshes that touch), each
// with the small emitters on it (the mug's LED, the speaker's glow) and
// the baked meshes inside it. A probe sits at its object's centre, and
// what the object holds sits right over that: the mug's coffee, three
// centimetres above the probe and seven across, hid half the sky from it,
// and the mug took the coffee's dark instead of the lilac wall and the
// light bar's glow (a twentieth of the light the desk beside it gets).
export function propSites(room: Object3D): ProbeSite[] {
  const sites: (ProbeSite & { box: Box3 })[] = [];
  const others: { mesh: Mesh; box: Box3 }[] = [];
  room.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const box = new Box3().setFromObject(object).expandByScalar(0.005);
    if (!object.name.startsWith('live_')) {
      others.push({ mesh: object, box });
      return;
    }
    const site = sites.find((candidate) => candidate.box.intersectsBox(box));
    if (site) {
      site.objects.push(object);
      site.box.union(box);
    } else {
      sites.push({ at: new Vector3(), objects: [object], alsoHidden: [], box });
    }
  });
  for (const site of sites) {
    site.box.getCenter(site.at);
    site.alsoHidden = others
      .filter(({ mesh, box }) =>
        mesh.name.startsWith('emit_') ? site.box.intersectsBox(box) : site.box.containsBox(box),
      )
      .map(({ mesh }) => mesh);
  }
  return sites;
}

// Renders every site's probe with the scene as it is lit now; `alwaysHidden`
// stays out of all of them.
export function captureProbes(
  renderer: WebGLRenderer,
  scene: Scene,
  sites: ProbeSite[],
  alwaysHidden: Object3D[],
): LocalProbes {
  const cube = new WebGLCubeRenderTarget(PROBE_SIZE, { type: HalfFloatType });
  const camera = new CubeCamera(0.005, 30, cube);
  const pmrem = new PMREMGenerator(renderer);
  // Nothing moves between the faces: render the shadow maps once, not six
  // times per probe.
  const shadowAutoUpdate = renderer.shadowMap.autoUpdate;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  const probes = sites.map(({ at, objects, alsoHidden = [] }) => {
    const hidden = [...alwaysHidden, ...objects, ...alsoHidden].filter((object) => object.visible);
    for (const object of hidden) object.visible = false;
    camera.position.copy(at);
    camera.update(renderer, scene);
    for (const object of hidden) object.visible = true;
    const materials = new Set<MeshStandardMaterial>();
    for (const root of objects) {
      root.traverse((object) => {
        if (object instanceof Mesh && object.material instanceof MeshStandardMaterial) materials.add(object.material);
      });
    }
    return { target: pmrem.fromCubemap(cube.texture), materials };
  });
  renderer.shadowMap.autoUpdate = shadowAutoUpdate;
  pmrem.dispose();
  cube.dispose();

  return {
    apply(on, intensity) {
      for (const { target, materials } of probes) {
        for (const material of materials) {
          material.envMap = on ? target.texture : null;
          material.envMapIntensity = intensity;
        }
      }
    },
    dispose() {
      for (const { target } of probes) target.dispose();
    },
  };
}
