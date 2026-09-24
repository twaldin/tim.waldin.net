// A matte black wireless mouse on the desk mat. It slides with the
// visitor's pointer (a few centimetres of travel across the whole window)
// while the right hand holds it, and its buttons dip on click.
import {
  CylinderGeometry,
  Group,
  MathUtils,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Raycaster,
  SphereGeometry,
  Vector2,
  Vector3,
} from 'three';
import { layout } from '../layout';
import type { Finger } from './keymap';

const HALF_WIDTH = 0.031;
const HALF_LENGTH = 0.059;
const HEIGHT = 0.038;
const TRAVEL = new Vector2(0.06, 0.04); // metres across the full window

// A point on the shell and its outward normal, in the mouse's local space.
export interface MouseContact {
  point: Vector3;
  normal: Vector3;
}

export interface MouseRig {
  group: Group;
  // Where the right hand touches it: palm on the hump, index and middle on
  // the buttons, thumb on the left flank, ring and pinky on the right.
  palm: MouseContact;
  fingertips: Record<Finger, MouseContact>;
  setPointer(ndc: Vector2): void;
  setButton(pressed: boolean): void;
  update(dt: number): void;
  dispose(): void;
}

// Egg-shaped shell: flat base, hump toward the palm, narrow nose.
function shellGeometry() {
  const geometry = new SphereGeometry(1, 72, 40);
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    let y = pos.getY(i);
    const z = pos.getZ(i); // +z toward the typist (the palm end)
    const along = (z + 1) / 2; // 0 at the nose, 1 at the tail
    const width = HALF_WIDTH * (0.82 + 0.18 * Math.sin(along * Math.PI * 0.95));
    const hump = 0.72 + 0.28 * Math.exp(-Math.pow((along - 0.62) / 0.3, 2));
    y = y < 0 ? y * 0.08 : y;
    pos.setXYZ(i, x * width, Math.max(0, y) * HEIGHT * hump + 0.0015, z * HALF_LENGTH);
  }
  geometry.computeVertexNormals();
  return geometry;
}

export function createMouse(): MouseRig {
  const group = new Group();
  group.name = 'mouse';
  const rest = new Vector3().fromArray(layout.mouse.restCenter);
  const position = rest.clone();
  const goal = rest.clone();

  const shellMaterial = new MeshPhysicalMaterial({
    color: '#141416',
    roughness: 0.48,
    metalness: 0,
    clearcoat: 0.25,
    clearcoatRoughness: 0.6,
  });
  const shellGeo = shellGeometry();
  const shell = new Mesh(shellGeo, shellMaterial);
  shell.castShadow = true;
  shell.receiveShadow = true;
  group.add(shell);

  // Button seam and scroll wheel.
  const seamMaterial = new MeshStandardMaterial({ color: '#050506', roughness: 0.9 });
  const seamGeo = new CylinderGeometry(0.0007, 0.0007, HALF_LENGTH * 0.9, 6);
  seamGeo.rotateX(Math.PI / 2);
  const seam = new Mesh(seamGeo, seamMaterial);
  seam.position.set(0, HEIGHT * 0.83, -HALF_LENGTH * 0.52);
  seam.rotation.x = -0.32;
  group.add(seam);
  const wheelGeo = new CylinderGeometry(0.0095, 0.0095, 0.0065, 28);
  wheelGeo.rotateZ(Math.PI / 2);
  const wheel = new Mesh(wheelGeo, new MeshStandardMaterial({ color: '#232427', roughness: 0.7 }));
  wheel.position.set(0, HEIGHT * 0.76, -HALF_LENGTH * 0.5);
  wheel.castShadow = true;
  group.add(wheel);

  group.updateMatrixWorld(true);
  const raycaster = new Raycaster();
  const contact = (origin: [number, number, number], direction: [number, number, number]): MouseContact => {
    raycaster.set(new Vector3(...origin), new Vector3(...direction));
    const hit = raycaster.intersectObject(shell, false)[0];
    if (!hit?.face) throw new Error('mouse contact ray missed the shell');
    return { point: hit.point, normal: hit.face.normal.clone() };
  };
  const palm = contact([0.002, 0.1, 0.024], [0, -1, 0]);
  const fingertips: Record<Finger, MouseContact> = {
    1: contact([-0.1, 0.014, 0.002], [1, 0, 0]),
    2: contact([-0.012, 0.1, -0.038], [0, -1, 0]),
    3: contact([0.012, 0.1, -0.035], [0, -1, 0]),
    4: contact([0.1, 0.016, -0.012], [-1, 0, 0]),
    5: contact([0.1, 0.01, 0.012], [-1, 0, 0]),
  };

  group.position.copy(position);
  let click = 0;
  let clickGoal = 0;

  return {
    group,
    palm,
    fingertips,
    setPointer(ndc) {
      goal.set(rest.x + ndc.x * TRAVEL.x * 0.5, rest.y, rest.z - ndc.y * TRAVEL.y * 0.5);
    },
    setButton(pressed) {
      clickGoal = pressed ? 1 : 0;
    },
    update(dt) {
      position.x = MathUtils.damp(position.x, goal.x, 18, dt);
      position.z = MathUtils.damp(position.z, goal.z, 18, dt);
      click = MathUtils.damp(click, clickGoal, 40, dt);
      group.position.copy(position);
      // A slight yaw as it travels sideways, like a wrist pivot.
      group.rotation.y = -(position.x - rest.x) * 1.6;
      seam.position.y = HEIGHT * 0.83 - click * 0.0008;
    },
    dispose() {
      shellGeo.dispose();
      seamGeo.dispose();
      wheelGeo.dispose();
      shellMaterial.dispose();
      seamMaterial.dispose();
    },
  };
}
