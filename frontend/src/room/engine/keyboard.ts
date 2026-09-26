// Procedural 75% mechanical keyboard: an anodised aluminium case, a dark
// plate and one sculpted PBT keycap mesh per key. Every keycap shares one
// material whose albedo atlas carries the keycap colours and legends.
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  ExtrudeGeometry,
  Group,
  MathUtils,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  Path,
  Shape,
  SRGBColorSpace,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { layout } from '../layout';
import {
  BOARD_UNITS_DEEP,
  BOARD_UNITS_WIDE,
  KEY_UNIT,
  KEYS,
  type PlacedKey,
} from './keymap';
import { applyContactShadows } from './contact';

const MM = 0.001;
const TYPING_ANGLE = MathUtils.degToRad(6);
const KEY_TRAVEL = 3.6 * MM;
const CAP_BOTTOM_ABOVE_PLATE = 4.5 * MM;
const RIM_ABOVE_PLATE = 6.5 * MM;
const CASE_MARGIN = 10 * MM;
const CASE_RADIUS = 6 * MM;

// Cherry-style sculpt per row: cap height and top tilt toward the typist.
const ROW_PROFILE = [
  { height: 9.4 * MM, tilt: 7 },
  { height: 9.2 * MM, tilt: 6 },
  { height: 7.9 * MM, tilt: 2.5 },
  { height: 7.5 * MM, tilt: 0 },
  { height: 8.4 * MM, tilt: -4 },
  { height: 8.4 * MM, tilt: -5 },
] as const;

const PALETTE = {
  alpha: '#2a2c31',
  modifier: '#1c1d21',
  accent: '#c0703a',
  legend: '#e4dccb',
  accentLegend: '#1b1a18',
  modLegend: '#b9b1a1',
};
const ACCENT_KEYS: Record<string, true> = { Escape: true, Enter: true };

const ATLAS_PX_PER_UNIT = 128;

// Rounded-rectangle outline sampled at a fixed point count so rings of
// different sizes can be lofted into each other.
function roundedRectPoint(t: number, halfW: number, halfD: number, radius: number): [number, number] {
  const r = Math.min(radius, halfW, halfD);
  const straightW = 2 * (halfW - r);
  const straightD = 2 * (halfD - r);
  const arc = (Math.PI / 2) * r;
  const perimeter = 2 * straightW + 2 * straightD + 4 * arc;
  let s = (((t % 1) + 1) % 1) * perimeter;
  // Start at the front edge centre, walk counter-clockwise seen from above.
  const segments: [number, (u: number) => [number, number]][] = [
    [straightW / 2, (u) => [u, halfD]],
    [arc, (u) => { const a = u / r; return [halfW - r + Math.sin(a) * r, halfD - r + Math.cos(a) * r]; }],
    [straightD, (u) => [halfW, halfD - r - u]],
    [arc, (u) => { const a = u / r; return [halfW - r + Math.cos(a) * r, -(halfD - r) - Math.sin(a) * r]; }],
    [straightW, (u) => [halfW - r - u, -halfD]],
    [arc, (u) => { const a = u / r; return [-(halfW - r) - Math.sin(a) * r, -(halfD - r) - Math.cos(a) * r]; }],
    [straightD, (u) => [-halfW, -(halfD - r) + u]],
    [arc, (u) => { const a = u / r; return [-(halfW - r) - Math.cos(a) * r, halfD - r + Math.sin(a) * r]; }],
    [straightW / 2, (u) => [-(halfW - r) + u, halfD]],
  ];
  for (const [length, point] of segments) {
    if (s <= length) return point(s);
    s -= length;
  }
  return [0, halfD];
}

interface CapShape {
  width: number; // metres
  row: number;
}

// One sculpted keycap: lofted sides with a filleted top edge and a shallow
// cylindrical dish. Local origin at the bottom centre; +Z toward the typist.
function buildKeycapGeometry({ width, row }: CapShape, uv: { u0: number; v0: number; u1: number; v1: number }) {
  const profile = ROW_PROFILE[row];
  const ringPoints = 64;
  const bottom = { hw: width / 2 - 0.45 * MM, hd: 18.2 * MM / 2, r: 0.9 * MM };
  const top = { hw: width / 2 - 3.1 * MM, hd: 14.4 * MM / 2, r: 2.4 * MM };
  const topOffsetZ = -0.9 * MM;
  const tilt = MathUtils.degToRad(profile.tilt);
  const dishDepth = 0.55 * MM;

  const topY = (x: number, z: number) => {
    const dz = z - topOffsetZ;
    const across = Math.min(1, Math.abs(x) / top.hw);
    return profile.height - dz * Math.tan(tilt) - dishDepth * (1 - across * across);
  };

  const positions: number[] = [];
  const uvs: number[] = [];
  const toUv = (x: number, z: number) => [
    MathUtils.lerp(uv.u0, uv.u1, 0.5 + x / (width)),
    MathUtils.lerp(uv.v0, uv.v1, 0.5 - z / (19.05 * MM)),
  ];

  // Side rings (bottom → just under the top edge), then fillet rings rolling
  // over the edge, then inset rings across the dished top to the centre.
  const rings: { hw: number; hd: number; r: number; y: (x: number, z: number) => number; zOff: number }[] = [];
  const sideSteps = 6;
  for (let i = 0; i <= sideSteps; i++) {
    const t = i / sideSteps;
    const bulge = Math.sin(t * Math.PI) * 0.35 * MM; // slightly convex walls
    const k = t * t * (3 - 2 * t) * 0.15 + t * 0.85;
    const hw = MathUtils.lerp(bottom.hw, top.hw + 0.6 * MM, k) + bulge;
    const hd = MathUtils.lerp(bottom.hd, top.hd + 0.6 * MM, k) + bulge;
    const r = MathUtils.lerp(bottom.r, top.r + 0.4 * MM, k);
    const zOff = topOffsetZ * k;
    rings.push({ hw, hd, r, zOff, y: (x, z) => MathUtils.lerp(0, topY(x, z) - 0.7 * MM, t) });
  }
  const filletSteps = 4;
  for (let i = 1; i <= filletSteps; i++) {
    const a = (i / filletSteps) * (Math.PI / 2);
    const inset = 0.6 * MM * (1 - Math.cos(a));
    rings.push({
      hw: top.hw + 0.6 * MM - inset,
      hd: top.hd + 0.6 * MM - inset,
      r: top.r + 0.4 * MM - inset * 0.6,
      zOff: topOffsetZ,
      y: (x, z) => topY(x, z) - 0.7 * MM * Math.cos(a),
    });
  }
  const insetSteps = 5;
  for (let i = 1; i <= insetSteps; i++) {
    const s = 1 - i / (insetSteps + 1);
    rings.push({ hw: top.hw * s, hd: top.hd * s, r: top.r * s, zOff: topOffsetZ, y: topY });
  }

  for (const ring of rings) {
    for (let p = 0; p < ringPoints; p++) {
      const [x, zLocal] = roundedRectPoint(p / ringPoints, ring.hw, ring.hd, ring.r);
      const z = zLocal + ring.zOff;
      positions.push(x, ring.y(x, z), z);
      uvs.push(...toUv(x, z));
    }
  }
  const centerIndex = positions.length / 3;
  positions.push(0, topY(0, topOffsetZ), topOffsetZ);
  uvs.push(...toUv(0, topOffsetZ));

  const indices: number[] = [];
  for (let r = 0; r < rings.length - 1; r++) {
    for (let p = 0; p < ringPoints; p++) {
      const a = r * ringPoints + p;
      const b = r * ringPoints + ((p + 1) % ringPoints);
      const c = (r + 1) * ringPoints + p;
      const d = (r + 1) * ringPoints + ((p + 1) % ringPoints);
      indices.push(a, b, c, b, d, c);
    }
  }
  const last = (rings.length - 1) * ringPoints;
  for (let p = 0; p < ringPoints; p++) {
    indices.push(last + p, last + ((p + 1) % ringPoints), centerIndex);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function keyColors(key: PlacedKey) {
  if (ACCENT_KEYS[key.code]) return { cap: PALETTE.accent, legend: PALETTE.accentLegend };
  const isAlpha = key.width === 1 && key.row >= 1 && key.row <= 4 && !key.code.startsWith('Arrow') &&
    !['Home', 'PageUp', 'PageDown', 'End'].includes(key.code);
  return isAlpha
    ? { cap: PALETTE.alpha, legend: PALETTE.legend }
    : { cap: PALETTE.modifier, legend: PALETTE.modLegend };
}

// Albedo atlas laid out like the board itself: each key's cell sits at its
// board position, filled with the cap colour and its legend.
function buildLegendAtlas(renderer: WebGLRenderer) {
  const canvas = document.createElement('canvas');
  canvas.width = BOARD_UNITS_WIDE * ATLAS_PX_PER_UNIT;
  canvas.height = Math.ceil(BOARD_UNITS_DEEP * ATLAS_PX_PER_UNIT);
  const ctx = canvas.getContext('2d')!;
  const font = '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", monospace';
  const px = ATLAS_PX_PER_UNIT;

  for (const key of KEYS) {
    const { cap, legend } = keyColors(key);
    const cx = key.x * px;
    const cy = key.z * px;
    const w = key.width * px;
    ctx.fillStyle = cap;
    ctx.fillRect(cx - w / 2, cy - px / 2, w, px);
    // Subtle PBT texture: sparse speckle in the cap colour.
    ctx.fillStyle = 'rgba(255,255,255,0.018)';
    for (let i = 0; i < w * 0.6; i++) {
      ctx.fillRect(cx - w / 2 + Math.random() * w, cy - px / 2 + Math.random() * px, 1, 1);
    }
    ctx.fillStyle = legend;
    ctx.textBaseline = 'middle';
    // Legends sit on the flat part of the dished top, nudged toward the back.
    const topCy = cy - px * 0.06;
    if (key.shiftLegend) {
      ctx.textAlign = 'center';
      ctx.font = `500 ${px * 0.2}px ${font}`;
      ctx.fillText(key.shiftLegend, cx, topCy - px * 0.14);
      ctx.fillText(key.legend, cx, topCy + px * 0.14);
    } else if (key.legend.length === 1) {
      ctx.textAlign = 'center';
      ctx.font = `500 ${px * 0.27}px ${font}`;
      ctx.fillText(key.legend, cx, topCy);
    } else if (key.legend) {
      ctx.textAlign = key.width > 1.2 ? 'left' : 'center';
      ctx.font = `500 ${px * (key.legend.length > 5 ? 0.12 : 0.14)}px ${font}`;
      const tx = key.width > 1.2 ? cx - w / 2 + px * 0.24 : cx;
      ctx.fillText(key.legend, tx, key.width > 1.2 ? topCy + px * 0.12 : topCy);
    }
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return texture;
}

export interface KeyboardRig {
  group: Group;
  // World-space point at the centre of a key's top surface (at rest).
  keyTop(code: string): Vector3 | undefined;
  // Depress (1) or release (0) a key; animated in update().
  setPressed(code: string, pressed: boolean): void;
  update(dt: number): void;
  dispose(): void;
}

export function createKeyboard(renderer: WebGLRenderer): KeyboardRig {
  const { center } = layout.keyboard;
  const group = new Group();
  group.name = 'keyboard';

  const boardW = BOARD_UNITS_WIDE * KEY_UNIT;
  const boardD = BOARD_UNITS_DEEP * KEY_UNIT;

  // Tilted board frame: origin at the plate-top centre, +Y normal to the plate.
  const board = new Object3D();
  board.rotation.x = TYPING_ANGLE;
  group.add(board);

  const atlas = buildLegendAtlas(renderer);
  const capMaterial = new MeshStandardMaterial({ map: atlas, roughness: 0.62, metalness: 0 });
  applyContactShadows(capMaterial);

  interface KeyState { key: PlacedKey; mesh: Mesh; target: number; depth: number; }
  const states: Record<string, KeyState> = {};
  const geometries: BufferGeometry[] = [];
  const atlasW = BOARD_UNITS_WIDE;
  const atlasD = Math.ceil(BOARD_UNITS_DEEP * ATLAS_PX_PER_UNIT) / ATLAS_PX_PER_UNIT;

  for (const key of KEYS) {
    // The key's atlas cell; v0 is its front (typist-side) edge, v1 its back.
    const geometry = buildKeycapGeometry({ width: key.width * KEY_UNIT - 0.2 * MM, row: key.row }, {
      u0: (key.x - key.width / 2) / atlasW,
      u1: (key.x + key.width / 2) / atlasW,
      v0: 1 - (key.z + 0.5) / atlasD,
      v1: 1 - (key.z - 0.5) / atlasD,
    });
    geometries.push(geometry);
    const mesh = new Mesh(geometry, capMaterial);
    mesh.name = `key_${key.code}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(
      (key.x - BOARD_UNITS_WIDE / 2) * KEY_UNIT,
      CAP_BOTTOM_ABOVE_PLATE,
      (key.z - BOARD_UNITS_DEEP / 2) * KEY_UNIT,
    );
    board.add(mesh);
    states[key.code] = { key, mesh, target: 0, depth: 0 };
  }

  // Plate: dark, visible in the gaps between caps.
  const plateShape = new Shape();
  plateShape.moveTo(-boardW / 2 - 1 * MM, -boardD / 2 - 1 * MM);
  plateShape.lineTo(boardW / 2 + 1 * MM, -boardD / 2 - 1 * MM);
  plateShape.lineTo(boardW / 2 + 1 * MM, boardD / 2 + 1 * MM);
  plateShape.lineTo(-boardW / 2 - 1 * MM, boardD / 2 + 1 * MM);
  const plateGeometry = new ExtrudeGeometry(plateShape, { depth: 1.5 * MM, bevelEnabled: false });
  plateGeometry.rotateX(Math.PI / 2);
  const plateMaterial = new MeshStandardMaterial({ color: '#0d0e10', roughness: 0.7, metalness: 0.3 });
  applyContactShadows(plateMaterial);
  const plate = new Mesh(plateGeometry, plateMaterial);
  plate.receiveShadow = true;
  board.add(plate);

  // Case: a bevelled aluminium frame around the key well, sheared into a
  // wedge so its bottom sits flat on the desk and its rim follows the plate.
  const caseW = boardW + 2 * CASE_MARGIN;
  const caseD = boardD + 2 * CASE_MARGIN;
  const outline = new Shape();
  const hole = new Path();
  const roundRect = (target: Shape | Path, hw: number, hd: number, r: number) => {
    target.moveTo(-hw + r, -hd);
    target.lineTo(hw - r, -hd);
    target.quadraticCurveTo(hw, -hd, hw, -hd + r);
    target.lineTo(hw, hd - r);
    target.quadraticCurveTo(hw, hd, hw - r, hd);
    target.lineTo(-hw + r, hd);
    target.quadraticCurveTo(-hw, hd, -hw, hd - r);
    target.lineTo(-hw, -hd + r);
    target.quadraticCurveTo(-hw, -hd, -hw + r, -hd);
  };
  roundRect(outline, caseW / 2, caseD / 2, CASE_RADIUS);
  roundRect(hole, boardW / 2 + 0.8 * MM, boardD / 2 + 0.8 * MM, 1.5 * MM);
  outline.holes.push(hole);
  const caseHeight = 0.05;
  const caseGeometry = new ExtrudeGeometry(outline, {
    depth: caseHeight,
    bevelEnabled: true,
    bevelThickness: 1.2 * MM,
    bevelSize: 1.2 * MM,
    bevelSegments: 4,
    curveSegments: 10,
  });
  // Extrusion runs along +Z; stand it up so it runs along +Y.
  caseGeometry.rotateX(-Math.PI / 2);
  caseGeometry.computeBoundingBox();
  const deskY = center[1];
  // Plate-top height above the desk at the board's centre, chosen so the home
  // row key tops land where layout.json expects the fingertips.
  const homeRow = KEYS.find((k) => k.code === 'KeyJ')!;
  const homeZ = (homeRow.z - BOARD_UNITS_DEEP / 2) * KEY_UNIT;
  const homeTop = layout.keyboard.homeKeys.KeyJ[1];
  const plateCenterY = homeTop - deskY - CAP_BOTTOM_ABOVE_PLATE - ROW_PROFILE[3].height + homeZ * Math.sin(TYPING_ANGLE);
  board.position.set(center[0], deskY + plateCenterY, center[2]);

  const pos = caseGeometry.attributes.position as BufferAttribute;
  const box = caseGeometry.boundingBox!;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // 0 at the bottom face, 1 at the top face (bevel vertices included).
    const t = (y - box.min.y) / (box.max.y - box.min.y);
    const bottomY = 0;
    const rimY = plateCenterY + RIM_ABOVE_PLATE - z * Math.tan(TYPING_ANGLE);
    const yTop = rimY - 1.2 * MM;
    pos.setY(i, t < 0.5 ? bottomY + (y - box.min.y) : yTop + (y - box.max.y));
  }
  caseGeometry.computeVertexNormals();
  const caseMaterial = new MeshPhysicalMaterial({
    color: '#2b2c30',
    metalness: 0.85,
    roughness: 0.34,
    clearcoat: 0.15,
    clearcoatRoughness: 0.5,
  });
  applyContactShadows(caseMaterial);
  const caseMesh = new Mesh(caseGeometry, caseMaterial);
  caseMesh.position.set(center[0], deskY, center[2]);
  caseMesh.castShadow = true;
  caseMesh.receiveShadow = true;
  group.add(caseMesh);

  group.updateMatrixWorld(true);

  return {
    group,
    keyTop(code) {
      const state = states[code];
      if (!state) return undefined;
      const { position } = state.mesh;
      return board.localToWorld(new Vector3(
        position.x,
        CAP_BOTTOM_ABOVE_PLATE + ROW_PROFILE[state.key.row].height - 0.4 * MM,
        position.z - 0.9 * MM,
      ));
    },
    setPressed(code, pressed) {
      const state = states[code];
      if (state) state.target = pressed ? 1 : 0;
    },
    update(dt) {
      for (const code in states) {
        const state = states[code];
        if (state.depth === state.target) continue;
        // Fast bottom-out, springier return.
        const speed = state.target > state.depth ? 55 : 22;
        state.depth += (state.target - state.depth) * Math.min(1, dt * speed);
        if (Math.abs(state.target - state.depth) < 0.002) state.depth = state.target;
        state.mesh.position.y = CAP_BOTTOM_ABOVE_PLATE - state.depth * KEY_TRAVEL;
      }
    },
    dispose() {
      geometries.forEach((g) => g.dispose());
      caseGeometry.dispose();
      plateGeometry.dispose();
      atlas.dispose();
      capMaterial.dispose();
      plateMaterial.dispose();
      caseMaterial.dispose();
    },
  };
}
