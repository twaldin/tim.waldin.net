// A matte black wireless mouse on the desk mat, modelled with the arms
// (scripts/room/build_arms.py) so the right hand's grip is authored against
// this exact shell. It slides with the visitor's pointer (a few centimetres
// of travel across the whole window) while the right hand holds it, and its
// button seam dips on click.
import { Group, MathUtils, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, Vector2, Vector3, type Object3D } from 'three';
import { layout } from '../layout';

const TRAVEL = new Vector2(0.06, 0.04); // metres across the full window

export interface MouseRig {
  group: Group;
  setPointer(ndc: Vector2): void;
  setButton(pressed: boolean): void;
  update(dt: number): void;
  dispose(): void;
}

// Takes the mouse (node "Mouse": MouseShell, MouseSeam, MouseWheel) out of
// the loaded arms.glb scene.
export function createMouse(arms: Object3D): MouseRig {
  const part = (name: string) => {
    const found = arms.getObjectByName(name);
    if (!(found instanceof Mesh)) throw new Error(`arms.glb is missing ${name}`);
    return found;
  };
  const model = arms.getObjectByName('Mouse');
  if (!model) throw new Error('arms.glb is missing Mouse');
  const shell = part('MouseShell');
  const seam = part('MouseSeam');
  const wheel = part('MouseWheel');

  const group = new Group();
  group.name = 'mouse';
  const rest = new Vector3().fromArray(layout.mouse.restCenter);
  const position = rest.clone();
  const goal = rest.clone();
  model.removeFromParent();
  model.position.set(0, 0, 0);
  group.add(model);

  const shellMaterial = new MeshPhysicalMaterial({
    color: '#141416',
    roughness: 0.48,
    metalness: 0,
    clearcoat: 0.25,
    clearcoatRoughness: 0.6,
  });
  const seamMaterial = new MeshStandardMaterial({ color: '#050506', roughness: 0.9 });
  const wheelMaterial = new MeshStandardMaterial({ color: '#232427', roughness: 0.7 });
  shell.material = shellMaterial;
  seam.material = seamMaterial;
  wheel.material = wheelMaterial;
  shell.castShadow = true;
  shell.receiveShadow = true;
  wheel.castShadow = true;

  group.position.copy(position);
  let click = 0;
  let clickGoal = 0;

  return {
    group,
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
      seam.position.y = -click * 0.0008;
    },
    dispose() {
      for (const mesh of [shell, seam, wheel]) mesh.geometry.dispose();
      shellMaterial.dispose();
      seamMaterial.dispose();
      wheelMaterial.dispose();
    },
  };
}
