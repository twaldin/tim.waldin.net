// Drives the POV arms (public/room/arms.glb, bind pose = touch-typing pose
// with every fingertip on its home key) so each real keystroke is pressed
// by the finger a touch typist would use: the hand shifts toward far keys
// (two-bone arm IK), the finger reaches and strikes (damped-least-squares
// IK over its three joints), holds while the key is held, and relaxes back.
import { Bone, MathUtils, Matrix3, Quaternion, Vector3, type Object3D } from 'three';
import type { KeyboardRig } from './keyboard';
import type { MouseRig } from './mouse';
import { HOME_KEYS, KEY_BY_CODE, KEY_UNIT, type Finger, type Hand } from './keymap';
import { layout } from '../layout';

// Rig conventions reported by scripts/room/build_arms.py.
const FINGER_BONES: Record<Finger, string> = { 1: 'thumb', 2: 'index', 3: 'middle', 4: 'ring', 5: 'pinky' };
const FLEX_AXIS = new Vector3(1, 0, 0); // +X curls every phalanx toward the palm
const SPREAD_AXIS = new Vector3(0, 0, 1);

const STRIKE_SECONDS = 0.035;
const LIFT_SECONDS = 0.07;
const RELAX_RATE = 14;
const KEY_TRAVEL = 0.0036;
const HOVER = 0.004;
// The rig's fingertip point (distal bone tail) sits inside the finger; the
// pad that touches the key is this far below it.
const PAD = 0.0055;
const HAND_RETURN_SECONDS = 0.45;
// Mouse grip: palm surface below the wrist→knuckle midline, roll onto the
// pinky side, and how far the index pushes the button on click.
const PALM_DEPTH = 0.025;
const MOUSE_ROLL = 0.2;
const MOUSE_CLICK_DEPTH = 0.0015;

interface FingerState {
  hand: Hand;
  finger: Finger;
  bones: [Bone, Bone, Bone];
  bind: [Quaternion, Quaternion, Quaternion];
  tipLocal: Vector3; // fingertip in the distal bone's space
  homeTip: Vector3; // fingertip in world space at bind
  // IK parameters on top of the bind pose: base flex, middle flex, spread.
  params: [number, number, number];
  key: string | null;
  down: boolean;
  pressedAt: number;
  releasedAt: number;
  target: Vector3;
  noisePhase: number;
}

interface HandState {
  side: Hand;
  upper: Bone;
  lower: Bone;
  hand: Bone;
  upperBind: Quaternion;
  lowerBind: Quaternion;
  handBind: Quaternion;
  handBindWorld: Quaternion;
  wristBind: Vector3;
  elbowBind: Vector3;
  lengths: [number, number];
  offset: Vector3; // current wrist displacement from the bind pose
  offsetGoal: Vector3;
  lastActive: number;
  dip: number;
  // Right hand only: 0 on the keyboard, 1 holding the mouse.
  mouseBlend: number;
  fingers: FingerState[];
}

export interface MouseGrip {
  holding: boolean;
  clicking: boolean;
}

export interface HandsRig {
  setMouse(grip: MouseGrip): void;
  keyDown(code: string): void;
  keyUp(code: string): void;
  releaseAll(): void;
  update(dt: number, time: number): void;
}

const tmpA = new Vector3();
const tmpB = new Vector3();
const tmpQ = new Quaternion();
const tmpQ2 = new Quaternion();
const UP = new Vector3(0, 1, 0);

function setWorldRotation(bone: Bone, world: Quaternion) {
  const parentWorld = bone.parent ? bone.parent.getWorldQuaternion(tmpQ2) : tmpQ2.identity();
  bone.quaternion.copy(parentWorld.invert().multiply(world));
}

// Rotate `bone` in world space so the direction `from` (world) turns into `to`.
function aimBone(bone: Bone, from: Vector3, to: Vector3) {
  const delta = tmpQ.setFromUnitVectors(from.clone().normalize(), to.clone().normalize());
  const world = bone.getWorldQuaternion(new Quaternion());
  setWorldRotation(bone, delta.multiply(world));
  bone.updateMatrixWorld(true);
}

export function createHands(root: Object3D, keyboard: KeyboardRig, mouse: MouseRig): HandsRig {
  const bone = (name: string) => {
    const found = root.getObjectByName(name);
    if (!(found instanceof Bone)) throw new Error(`arms.glb is missing bone ${name}`);
    return found;
  };
  root.updateMatrixWorld(true);

  const homeKeys: Record<string, number[]> = layout.keyboard.homeKeys;
  const homeTipFor = (side: Hand, finger: Finger) => {
    const key = finger === 1 ? `Space${side === 'L' ? 'Left' : 'Right'}Thumb` : HOME_KEYS[side][finger];
    return new Vector3().fromArray(homeKeys[key]);
  };

  const hands: Record<Hand, HandState> = { L: null!, R: null! };
  for (const side of ['L', 'R'] as const) {
    const suffix = side === 'L' ? '_l' : '_r';
    const upper = bone(`upperarm${suffix}`);
    const lower = bone(`lowerarm${suffix}`);
    const hand = bone(`hand${suffix}`);
    const fingers: FingerState[] = ([1, 2, 3, 4, 5] as Finger[]).map((finger) => {
      const bones = [1, 2, 3].map((i) => bone(`${FINGER_BONES[finger]}_0${i}${suffix}`)) as [Bone, Bone, Bone];
      const homeTip = homeTipFor(side, finger);
      const tipLocal = bones[2].worldToLocal(homeTip.clone());
      return {
        hand: side,
        finger,
        bones,
        bind: bones.map((b) => b.quaternion.clone()) as [Quaternion, Quaternion, Quaternion],
        tipLocal,
        homeTip,
        params: [0, 0, 0],
        key: null,
        down: false,
        pressedAt: -1,
        releasedAt: -1,
        target: homeTip.clone(),
        noisePhase: Math.random() * 100,
      };
    });
    const shoulder = upper.getWorldPosition(new Vector3());
    const elbowBind = lower.getWorldPosition(new Vector3());
    const wristBind = hand.getWorldPosition(new Vector3());
    hands[side] = {
      side,
      upper,
      lower,
      hand,
      upperBind: upper.quaternion.clone(),
      lowerBind: lower.quaternion.clone(),
      handBind: hand.quaternion.clone(),
      handBindWorld: hand.getWorldQuaternion(new Quaternion()),
      wristBind,
      elbowBind,
      lengths: [shoulder.distanceTo(elbowBind), elbowBind.distanceTo(wristBind)],
      offset: new Vector3(),
      offsetGoal: new Vector3(),
      lastActive: -10,
      dip: 0,
      mouseBlend: 0,
      fingers,
    };
  }

  const fingerFor = (code: string) => {
    const key = KEY_BY_CODE[code];
    if (!key) return null;
    return hands[key.hand].fingers[key.finger - 1];
  };

  // Where on a key the fingertip lands: its home tip clamped into the key's
  // top face, so wide keys (space, shift, enter) are hit near the finger.
  const strikePoint = (finger: FingerState, code: string) => {
    const key = KEY_BY_CODE[code];
    const center = keyboard.keyTop(code);
    if (!key || !center) return null;
    const halfW = (key.width * KEY_UNIT) / 2 - 0.006;
    const x = MathUtils.clamp(finger.homeTip.x, center.x - halfW, center.x + halfW);
    return new Vector3(x, center.y, center.z);
  };

  const applyFinger = (f: FingerState) => {
    const [base, mid, spread] = f.params;
    const flex = [base, mid, mid * 0.72];
    for (let i = 0; i < 3; i++) {
      const q = f.bones[i].quaternion.copy(f.bind[i]);
      if (i === 0) q.multiply(tmpQ.setFromAxisAngle(SPREAD_AXIS, spread));
      q.multiply(tmpQ.setFromAxisAngle(FLEX_AXIS, flex[i]));
    }
    f.bones[0].updateMatrixWorld(true);
  };

  const tipWorld = (f: FingerState, out: Vector3) => out.copy(f.tipLocal).applyMatrix4(f.bones[2].matrixWorld);

  const LIMITS: [number, number][] = [[-0.35, 1.3], [-0.2, 1.6], [-0.35, 0.35]];
  const jac = [new Vector3(), new Vector3(), new Vector3()];
  const JJt = new Matrix3();
  const solveFinger = (f: FingerState, goal: Vector3) => {
    const lambda2 = 0.0004;
    for (let iter = 0; iter < 4; iter++) {
      applyFinger(f);
      const tip = tipWorld(f, new Vector3());
      const err = tmpA.copy(goal).sub(tip);
      if (err.lengthSq() < 1e-8) break;
      for (let j = 0; j < 3; j++) {
        const saved = f.params[j];
        f.params[j] = saved + 0.01;
        applyFinger(f);
        tipWorld(f, jac[j]).sub(tip).divideScalar(0.01);
        f.params[j] = saved;
      }
      // Δp = Jᵀ (J Jᵀ + λ²I)⁻¹ e, with J's columns = jac[j].
      const e = JJt.set(
        jac[0].x * jac[0].x + jac[1].x * jac[1].x + jac[2].x * jac[2].x + lambda2,
        jac[0].x * jac[0].y + jac[1].x * jac[1].y + jac[2].x * jac[2].y,
        jac[0].x * jac[0].z + jac[1].x * jac[1].z + jac[2].x * jac[2].z,
        jac[0].y * jac[0].x + jac[1].y * jac[1].x + jac[2].y * jac[2].x,
        jac[0].y * jac[0].y + jac[1].y * jac[1].y + jac[2].y * jac[2].y + lambda2,
        jac[0].y * jac[0].z + jac[1].y * jac[1].z + jac[2].y * jac[2].z,
        jac[0].z * jac[0].x + jac[1].z * jac[1].x + jac[2].z * jac[2].x,
        jac[0].z * jac[0].y + jac[1].z * jac[1].y + jac[2].z * jac[2].y,
        jac[0].z * jac[0].z + jac[1].z * jac[1].z + jac[2].z * jac[2].z + lambda2,
      );
      const y = tmpB.copy(err).applyMatrix3(e.invert());
      for (let j = 0; j < 3; j++) {
        const step = jac[j].dot(y);
        f.params[j] = MathUtils.clamp(f.params[j] + MathUtils.clamp(step, -0.25, 0.25), LIMITS[j][0], LIMITS[j][1]);
      }
    }
    applyFinger(f);
  };

  // Two-bone arm IK: place the wrist at `wrist`, keeping the elbow on the
  // bind-pose side, then give the hand the world orientation `handWorld`.
  const solveArm = (h: HandState, wrist: Vector3, handWorld: Quaternion) => {
    h.upper.quaternion.copy(h.upperBind);
    h.lower.quaternion.copy(h.lowerBind);
    h.hand.quaternion.copy(h.handBind);
    h.upper.updateMatrixWorld(true);
    const shoulder = h.upper.getWorldPosition(new Vector3());
    const [l1, l2] = h.lengths;
    const toWrist = wrist.clone().sub(shoulder);
    const d = MathUtils.clamp(toWrist.length(), Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);
    const dir = toWrist.normalize();
    const pole = h.elbowBind.clone().sub(shoulder);
    pole.addScaledVector(dir, -pole.dot(dir)).normalize();
    const cosA = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d);
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    const elbow = shoulder.clone().addScaledVector(dir, l1 * cosA).addScaledVector(pole, l1 * sinA);

    aimBone(h.upper, h.lower.getWorldPosition(new Vector3()).sub(shoulder), elbow.clone().sub(shoulder));
    const elbowNow = h.lower.getWorldPosition(new Vector3());
    aimBone(h.lower, h.hand.getWorldPosition(new Vector3()).sub(elbowNow), wrist.clone().sub(elbowNow));

    setWorldRotation(h.hand, handWorld);
    h.hand.updateMatrixWorld(true);
  };

  // Mouse grip for the right hand: the palm rests on the mouse's hump and
  // each fingertip is solved onto its contact point on the shell (see
  // mouse.ts), so the hand stays on the mouse as it moves.
  const right = hands.R;
  const mcp = (finger: Finger) => right.fingers[finger - 1].bones[0].getWorldPosition(new Vector3());
  const forward = mcp(3).sub(right.wristBind);
  // Down out of the palm: across the knuckles (pinky → index) × forward.
  const palmDown = mcp(2).sub(mcp(5)).cross(forward).normalize();
  const palmBind = right.wristBind.clone().addScaledVector(forward, 0.5).addScaledVector(palmDown, PALM_DEPTH);
  // The palm point relative to the wrist, in the hand's own orientation.
  const palmFromWrist = palmBind.sub(right.wristBind).applyQuaternion(right.handBindWorld.clone().invert());
  const gripBase = new Quaternion()
    .setFromUnitVectors(forward.clone().setY(0).normalize(), new Vector3(0, 0, -1))
    .premultiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -MOUSE_ROLL))
    .multiply(right.handBindWorld);
  const mouseState = { holding: false, clicking: false };
  const handWorld = new Quaternion();
  const gripWorld = new Quaternion();
  const contactWorld = new Vector3();
  const contactNormal = new Vector3();
  const relaxedTip = new Vector3();

  return {
    setMouse(grip) {
      mouseState.holding = grip.holding;
      mouseState.clicking = grip.clicking;
    },
    keyDown(code) {
      const f = fingerFor(code);
      if (!f) return;
      const now = performance.now() / 1000;
      f.key = code;
      f.down = true;
      f.pressedAt = now;
      const h = hands[f.hand];
      h.lastActive = now;
      const point = strikePoint(f, code);
      if (point) {
        // Share the reach between hand and finger: near keys are reached by
        // the finger alone, far ones (arrows, backspace, F-row) move the hand.
        const reach = point.clone().sub(f.homeTip);
        const distance = Math.hypot(reach.x, reach.z);
        const share = MathUtils.smoothstep(distance, 0.012, 0.06) * 0.9;
        h.offsetGoal.set(reach.x * share, 0.004 * share, reach.z * share);
      }
    },
    keyUp(code) {
      const f = fingerFor(code);
      if (!f || f.key !== code) return;
      f.down = false;
      f.releasedAt = performance.now() / 1000;
    },
    releaseAll() {
      for (const side of ['L', 'R'] as const) {
        for (const f of hands[side].fingers) f.down = false;
      }
    },
    update(dt, time) {
      const now = performance.now() / 1000;
      for (const side of ['L', 'R'] as const) {
        const h = hands[side];
        if (now - h.lastActive > HAND_RETURN_SECONDS && !h.fingers.some((f) => f.down)) h.offsetGoal.set(0, 0, 0);
        const pressing = h.fingers.some((f) => f.down && now - f.pressedAt < 0.12);
        h.dip = MathUtils.damp(h.dip, pressing ? 1 : 0, pressing ? 30 : 10, dt);
        h.offset.x = MathUtils.damp(h.offset.x, h.offsetGoal.x, 16, dt);
        h.offset.y = MathUtils.damp(h.offset.y, h.offsetGoal.y, 16, dt);
        h.offset.z = MathUtils.damp(h.offset.z, h.offsetGoal.z, 16, dt);

        const breathe = Math.sin(time * Math.PI * 2 * 0.21 + (side === 'L' ? 0 : 0.6)) * 0.0008;
        const wrist = h.wristBind.clone().add(h.offset);
        wrist.y += PAD;
        wrist.y += breathe - h.dip * 0.0018;
        handWorld.setFromAxisAngle(UP, -h.offset.x * 2.5).multiply(h.handBindWorld);

        if (side === 'R') {
          h.mouseBlend = MathUtils.damp(h.mouseBlend, mouseState.holding ? 1 : 0, mouseState.holding ? 6 : 16, dt);
          if (h.mouseBlend > 0.001) {
            mouse.group.updateMatrixWorld();
            gripWorld.copy(mouse.group.quaternion).multiply(gripBase);
            const palm = mouse.group.localToWorld(contactWorld.copy(mouse.palm.point));
            palm.y += breathe;
            const grip = palm.sub(tmpA.copy(palmFromWrist).applyQuaternion(gripWorld));
            const t = h.mouseBlend * h.mouseBlend * (3 - 2 * h.mouseBlend);
            wrist.lerp(grip, t);
            // Lift over the keyboard edge on the way across.
            wrist.y += Math.sin(t * Math.PI) * 0.028;
            handWorld.slerp(gripWorld, t);
          }
        }
        solveArm(h, wrist, handWorld);

        for (const f of h.fingers) {
          const sinceRelease = now - f.releasedAt;
          const active = f.key && (f.down || sinceRelease < LIFT_SECONDS);
          const point = active && f.key ? strikePoint(f, f.key) : null;
          if (point) {
            // Strike: fast drop onto the key and through its travel; lift: rise
            // a little above the cap before relaxing home.
            const strike = MathUtils.clamp((now - f.pressedAt) / STRIKE_SECONDS, 0, 1);
            const depth = f.down ? (1 - Math.pow(1 - strike, 3)) * (KEY_TRAVEL + 0.0008) : -HOVER * Math.sin((sinceRelease / LIFT_SECONDS) * Math.PI);
            f.target.copy(point);
            f.target.y += PAD - depth;
            solveFinger(f, f.target);
          } else {
            if (f.key && !f.down) f.key = null;
            // Relax toward the bind pose with a faint idle drift, or onto the
            // mouse (the index presses the left button on click).
            const drift = Math.sin(time * 0.7 + f.noisePhase) * 0.025 + Math.sin(time * 1.9 + f.noisePhase * 2) * 0.01;
            const onMouse = side === 'R' ? h.mouseBlend : 0;
            if (onMouse > 0.001) {
              const held: [number, number, number] = [...f.params];
              f.params = [drift, drift * 0.6, 0];
              applyFinger(f);
              const relaxed = tipWorld(f, relaxedTip);
              f.params = held;
              const contact = mouse.fingertips[f.finger];
              contactNormal.copy(contact.normal).transformDirection(mouse.group.matrixWorld);
              mouse.group.localToWorld(contactWorld.copy(contact.point));
              const press = f.finger === 2 && mouseState.clicking ? MOUSE_CLICK_DEPTH : 0;
              contactWorld.addScaledVector(contactNormal, PAD - press);
              solveFinger(f, relaxed.lerp(contactWorld, onMouse * onMouse * (3 - 2 * onMouse)));
            } else {
              f.params[0] = MathUtils.damp(f.params[0], drift, RELAX_RATE, dt);
              f.params[1] = MathUtils.damp(f.params[1], drift * 0.6, RELAX_RATE, dt);
              f.params[2] = MathUtils.damp(f.params[2], 0, RELAX_RATE, dt);
              applyFinger(f);
            }
          }
        }
      }
    },
  };
}
