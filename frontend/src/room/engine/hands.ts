// Drives the POV arms (public/room/arms.glb, bind pose = touch-typing pose
// with every fingertip on its home key) so each real keystroke is pressed
// by the finger a touch typist would use: the hand shifts toward far keys
// (two-bone arm IK), the finger reaches and strikes (damped-least-squares
// IK over its three joints), holds while the key is held, and relaxes back.
// While the visitor uses their mouse the right hand reaches over and holds
// the desk mouse in the palm grip authored with the arms.
import { Bone, MathUtils, Matrix3, Quaternion, SkinnedMesh, Vector3, type Object3D } from 'three';
import type { KeyboardRig } from './keyboard';
import type { MouseRig } from './mouse';
import { HOME_KEYS, KEY_BY_CODE, KEY_UNIT, type Finger, type Hand } from './keymap';
import { contactOccluders } from './contact';

// Rig conventions reported by scripts/room/build_arms.py.
const FINGER_BONES: Record<Finger, string> = { 1: 'thumb', 2: 'index', 3: 'middle', 4: 'ring', 5: 'pinky' };
const FLEX_AXIS = new Vector3(1, 0, 0); // +X curls every phalanx toward the palm
const SPREAD_AXIS = new Vector3(0, 0, 1);

const STRIKE_SECONDS = 0.035;
const LIFT_SECONDS = 0.07;
const RELAX_RATE = 14;
const KEY_TRAVEL = 0.0036;
const HOVER = 0.004;
// The rig's fingertip point (distal bone tail) sits inside the finger, this
// far from the skin around it.
const PAD = 0.0055;
// The spheres standing in for each hand in the keys' and mouse's contact
// shadows (contact.ts): a fingertip reaches its pad (thumbs are broader),
// the last finger joint and the middle of the first phalanx are about as
// thick as the finger, and four spheres halfway between the wrist and each
// knuckle fill the palm's width, so under a hand hovering over the keys
// the palm's broad shadow darkens them a third.
const TIP_RADIUS = PAD + 0.001;
const THUMB_TIP_RADIUS = PAD + 0.002;
// The fingertip sphere sits in the pad's pulp, not at tipLocal: that is the
// distal bone's tail, the very end of the finger, and on the mouse's flat
// grip a sphere there reached past the fingertip and printed a dark dot on
// the shell ahead of it. Back along the bone (+Y) and toward the palm (+Z,
// which FLEX_AXIS curls the bone toward); the thumb's tail reaches further.
const PAD_PULP = new Vector3(0, -0.007, 0.003);
const THUMB_PAD_PULP = new Vector3(0, -0.011, 0.003);
const JOINT_RADIUS = 0.0065;
const PHALANX_RADIUS = 0.008;
const PALM_RADIUS = 0.015;
const OCCLUDERS_PER_HAND = 19;
const HAND_RETURN_SECONDS = 0.45;
// Moving the right hand between keyboard and mouse: a minimum-jerk reach
// arcing up to GRAB_LIFT above the straight path, highest over the
// keyboard's edge, the hand turning over the 70% nearest the keyboard. On
// the way the hand takes the shape it's heading for, as a real reach does
// (gripShare): in the air the fingers are a loose cup, FINGERS_FLIGHT of
// the way between the typing curl and the mouse grip, and the thumb stays
// near its typing place under the palm (THUMB_FLIGHT of the way), curled in
// (THUMB_TUCK radians at its MCP and IP joints) rather than sticking out;
// both settle the rest of the way as the hand lands. Reaching for the
// mouse, ring and little finger lag a beat; the palm arrives at 90% and
// settles GRAB_SETTLE onto the shell. Leaving it, the palm lifts off first
// and the fingers let go (extending RELEASE_OPEN radians in passing), the
// thumb tucking in straight away.
const GRAB_SECONDS = 0.5;
const GRAB_LIFT = 0.032;
const FINGERS_FLIGHT = 0.5;
const THUMB_FLIGHT = 0.3;
const THUMB_TUCK = 0.25;
const GRAB_SETTLE = 0.002;
const RELEASE_OPEN = 0.08;
// The index finger's extra flex (radians) pressing the left button.
const MOUSE_CLICK_FLEX = 0.05;
// The share of the hand's roll the forearm carries: pronation turns the
// forearm along its length, so the wrist itself barely twists.
const FOREARM_TWIST = 0.8;

interface FingerState {
  hand: Hand;
  finger: Finger;
  bones: [Bone, Bone, Bone];
  bind: [Quaternion, Quaternion, Quaternion];
  tipLocal: Vector3; // fingertip in the distal bone's space
  padLocal: Vector3; // pad's pulp in the distal bone's space, for contact shadows
  homeTip: Vector3; // fingertip in world space at bind
  rest: Vector3; // fingertip from its home key's top at bind
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
  // Right hand only: progress of the reach from the keyboard (0) to holding
  // the mouse (1), and whether it runs back to the keyboard (set at each
  // end, so a reach reversed midway retraces its own curves).
  grab: number;
  releasing: boolean;
  fingers: FingerState[];
}

export interface MouseGrip {
  holding: boolean;
  clicking: boolean;
}

// The right hand's palm grip, authored by build_arms.py: the hand bone's
// position and world rotation in the mouse's frame (mouse at rest), and
// each hand bone's rotation relative to its bind.
interface GripPose {
  wrist: Vector3;
  hand: Quaternion;
  bones: Record<string, Quaternion>;
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
const tmpC = new Vector3();
const tmpQ = new Quaternion();
const tmpQ2 = new Quaternion();
const tmpQ3 = new Quaternion();
const tmpQ4 = new Quaternion();
const UP = new Vector3(0, 1, 0);

const minJerk = (t: number) => t * t * t * (10 - 15 * t + 6 * t * t);

// How much of the way from one pose to another (the typing pose, the mouse
// grip) a hand moving between them has taken, `along` the move (0-1): the
// share `flight` over its first `lift`, the rest over the 35% from `land`.
function gripShare(along: number, flight: number, lift: number, land: number): number {
  return (
    flight * minJerk(MathUtils.clamp(along / lift, 0, 1)) +
    (1 - flight) * minJerk(MathUtils.clamp((along - land) / 0.35, 0, 1))
  );
}

function numbers(value: unknown, length: number): number[] {
  if (!Array.isArray(value) || value.length !== length || !value.every((n) => typeof n === 'number')) {
    throw new Error('arms.glb has a malformed mouse grip');
  }
  return value;
}

function readGrip(root: Object3D): GripPose {
  const text: unknown = root.getObjectByName('ArmsRig')?.userData.mouseGrip;
  if (typeof text !== 'string') throw new Error('arms.glb has no mouse grip');
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || !('wrist' in raw) || !('hand' in raw) || !('bones' in raw)) {
    throw new Error('arms.glb has a malformed mouse grip');
  }
  const { bones } = raw;
  if (!bones || typeof bones !== 'object') throw new Error('arms.glb has a malformed mouse grip');
  return {
    wrist: new Vector3().fromArray(numbers(raw.wrist, 3)),
    hand: new Quaternion().fromArray(numbers(raw.hand, 4)),
    bones: Object.fromEntries(
      Object.entries(bones).map(([name, q]) => [name, new Quaternion().fromArray(numbers(q, 4))]),
    ),
  };
}

// Each fingertip bone's tail at bind (world), by bone name, as build_arms.py
// records it on the rig.
function readTips(root: Object3D): Record<string, Vector3> {
  const rig = root.getObjectByName('ArmsRig');
  const text: unknown = rig?.userData.typingTips;
  if (!rig || typeof text !== 'string') throw new Error('arms.glb has no typing tips');
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== 'object') throw new Error('arms.glb has malformed typing tips');
  return Object.fromEntries(
    Object.entries(raw).map(([name, p]) => {
      if (!Array.isArray(p) || p.length !== 3 || !p.every((n) => typeof n === 'number')) {
        throw new Error('arms.glb has malformed typing tips');
      }
      return [name, rig.localToWorld(new Vector3().fromArray(p))];
    }),
  );
}

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

  // Where each fingertip rests at bind (build_arms.py places the tips on
  // their home keys, the pads just touching the tops) and so where it
  // lands on any key: the same offset from that key's top.
  const tips = readTips(root);
  const homeTipFor = (bones: [Bone, Bone, Bone]) => {
    const tip = tips[bones[2].name];
    if (!tip) throw new Error(`arms.glb typing tips are missing ${bones[2].name}`);
    return tip;
  };
  const restFor = (side: Hand, finger: Finger, homeTip: Vector3) => {
    const top = keyboard.keyTop(HOME_KEYS[side][finger]);
    if (!top) throw new Error(`keyboard has no key ${HOME_KEYS[side][finger]}`);
    return homeTip.clone().sub(top);
  };

  const hands: Record<Hand, HandState> = { L: null!, R: null! };
  for (const side of ['L', 'R'] as const) {
    const suffix = side === 'L' ? '_l' : '_r';
    const upper = bone(`upperarm${suffix}`);
    const lower = bone(`lowerarm${suffix}`);
    const hand = bone(`hand${suffix}`);
    const fingers: FingerState[] = ([1, 2, 3, 4, 5] as Finger[]).map((finger) => {
      const bones = [1, 2, 3].map((i) => bone(`${FINGER_BONES[finger]}_0${i}${suffix}`)) as [Bone, Bone, Bone];
      const homeTip = homeTipFor(bones);
      const tipLocal = bones[2].worldToLocal(homeTip.clone());
      return {
        hand: side,
        finger,
        bones,
        bind: bones.map((b) => b.quaternion.clone()) as [Quaternion, Quaternion, Quaternion],
        tipLocal,
        padLocal: tipLocal.clone().add(finger === 1 ? THUMB_PAD_PULP : PAD_PULP),
        homeTip,
        rest: restFor(side, finger, homeTip),
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
      grab: 0,
      releasing: false,
      fingers,
    };
  }

  const fingerFor = (code: string) => {
    const key = KEY_BY_CODE[code];
    if (!key) return null;
    return hands[key.hand].fingers[key.finger - 1];
  };

  // Where on a key the fingertip lands: as far from the key's top as it
  // rests from its home key's, sideways its home tip clamped into the top
  // face, so wide keys (space, shift, enter) are hit near the finger.
  const strikePoint = (finger: FingerState, code: string) => {
    const key = KEY_BY_CODE[code];
    const top = keyboard.keyTop(code);
    if (!key || !top) return null;
    const halfW = (key.width * KEY_UNIT) / 2 - 0.006;
    const x = MathUtils.clamp(finger.homeTip.x, top.x - halfW, top.x + halfW);
    return new Vector3(x, top.y + finger.rest.y, top.z + finger.rest.z);
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

    // Pronation: turn the forearm about its own axis by most of the hand's
    // twist from where the forearm would carry it, so the wrist doesn't wring.
    const axis = tmpA.copy(wrist).sub(elbowNow).normalize();
    const lowerWorld = h.lower.getWorldQuaternion(tmpQ3);
    const twist = tmpQ4.copy(lowerWorld).multiply(h.handBind).invert().premultiply(handWorld);
    const along = axis.x * twist.x + axis.y * twist.y + axis.z * twist.z;
    if (Math.hypot(along, twist.w) > 1e-6) {
      twist.set(axis.x * along, axis.y * along, axis.z * along, twist.w).normalize();
      setWorldRotation(h.lower, tmpQ.identity().slerp(twist, FOREARM_TWIST).multiply(lowerWorld));
      h.lower.updateMatrixWorld(true);
    }

    setWorldRotation(h.hand, handWorld);
    h.hand.updateMatrixWorld(true);
  };

  // The right hand's grip on the mouse: its fingers' bone rotations, and
  // where the hand sits relative to the mouse, which it follows.
  const grip = readGrip(root);
  const gripBones = new Map(
    hands.R.fingers.map((f) => [
      f,
      f.bones.map((b, i) => {
        const q = grip.bones[b.name];
        if (!q) throw new Error(`arms.glb mouse grip is missing ${b.name}`);
        return f.bind[i].clone().multiply(q);
      }),
    ]),
  );
  // The grip's corrective shape (build_arms.py add_grip_corrective), on
  // each skin primitive carrying it.
  const gripShapes: { influences: number[]; index: number }[] = [];
  root.traverse((o) => {
    const index = o instanceof SkinnedMesh ? o.morphTargetDictionary?.MouseGrip : undefined;
    if (o instanceof SkinnedMesh && index !== undefined && o.morphTargetInfluences) {
      gripShapes.push({ influences: o.morphTargetInfluences, index });
    }
  });
  const mouseState = { holding: false, clicking: false };
  let click = 0;
  const handWorld = new Quaternion();
  const gripWorld = new Quaternion();
  const gripWrist = new Vector3();

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
        wrist.y += breathe - h.dip * 0.0018;
        handWorld.setFromAxisAngle(UP, -h.offset.x * 2.5).multiply(h.handBindWorld);

        // Right hand: how far the fingers and the thumb have closed onto the
        // mouse, how far the hand opens letting go of it and how far the
        // thumb is tucked in.
        let fingersClose = 0;
        let outerClose = 0; // ring and little finger
        let thumbClose = 0;
        let fingersOpen = 0;
        let thumbTuck = 0;
        if (side === 'R') {
          if (h.grab === 0) h.releasing = false;
          else if (h.grab === 1) h.releasing = true;
          const step = dt / GRAB_SECONDS;
          h.grab = MathUtils.clamp(h.grab + (mouseState.holding ? step : -step), 0, 1);
          click = MathUtils.damp(click, mouseState.clicking ? 1 : 0, 40, dt);
          const along = h.releasing ? 1 - h.grab : h.grab; // from where this reach began
          if (h.releasing) {
            fingersClose = 1 - gripShare(along, FINGERS_FLIGHT, 0.3, 0.35);
            outerClose = fingersClose;
            thumbClose = 1 - gripShare(along, 1 - THUMB_FLIGHT, 0.3, 0.35);
            fingersOpen = RELEASE_OPEN * Math.sin(Math.PI * MathUtils.clamp(along / 0.35, 0, 1));
            thumbTuck = THUMB_TUCK * Math.sin(Math.PI * MathUtils.clamp(along / 0.8, 0, 1));
          } else {
            fingersClose = gripShare(along, FINGERS_FLIGHT, 0.4, 0.6);
            outerClose = gripShare(along - 0.05, FINGERS_FLIGHT, 0.4, 0.6);
            thumbClose = gripShare(along, THUMB_FLIGHT, 0.4, 0.5);
            thumbTuck = THUMB_TUCK * Math.sin(Math.PI * MathUtils.clamp(along / 0.9, 0, 1));
          }
          for (const shape of gripShapes) shape.influences[shape.index] = thumbClose;
          if (h.grab > 0) {
            mouse.group.updateMatrixWorld();
            gripWorld.copy(mouse.group.quaternion).multiply(grip.hand);
            mouse.group.localToWorld(gripWrist.copy(grip.wrist));
            gripWrist.y += breathe;
            // The palm arrives at 90% and leaves after the first 10%.
            wrist.lerp(gripWrist, minJerk(Math.min(1, h.grab / 0.9)));
            // Arc over the keyboard edge; leaving the mouse, lift off first.
            const travel = minJerk(along);
            wrist.y += Math.sin(Math.PI * Math.pow(travel, h.releasing ? 0.6 : 0.55)) * GRAB_LIFT;
            if (!h.releasing) {
              wrist.y += GRAB_SETTLE * MathUtils.smoothstep(along, 0.5, 0.8) * (1 - MathUtils.smoothstep(along, 0.88, 1));
            }
            handWorld.slerp(gripWorld, minJerk(Math.min(1, h.grab / 0.7)));
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
            f.target.y -= depth;
            solveFinger(f, f.target);
          } else {
            if (f.key && !f.down) f.key = null;
            // Relax toward the bind pose with a faint idle drift.
            const drift = Math.sin(time * 0.7 + f.noisePhase) * 0.025 + Math.sin(time * 1.9 + f.noisePhase * 2) * 0.01;
            f.params[0] = MathUtils.damp(f.params[0], drift, RELAX_RATE, dt);
            f.params[1] = MathUtils.damp(f.params[1], drift * 0.6, RELAX_RATE, dt);
            f.params[2] = MathUtils.damp(f.params[2], 0, RELAX_RATE, dt);
            applyFinger(f);
            const held = side === 'R' ? gripBones.get(f) : undefined;
            if (held && h.grab > 0) {
              // Close onto the mouse, then hold with a faint drift; the index
              // presses the left button.
              const thumb = f.finger === 1;
              const close = thumb ? thumbClose : f.finger >= 4 ? outerClose : fingersClose;
              // Opening: the fingers extend at their MCP and PIP joints, the
              // thumb at its MCP and IP joints (where it also tucks in).
              for (let i = 0; i < 3; i++) {
                const q = f.bones[i].quaternion.slerp(held[i], close);
                if (i === 0) {
                  const press = f.finger === 2 ? click * MOUSE_CLICK_FLEX : 0;
                  q.multiply(tmpQ.setFromAxisAngle(FLEX_AXIS, press + drift * 0.4 * close - (thumb ? 0 : fingersOpen)));
                } else {
                  const open = fingersOpen * (thumb ? 0.5 : i === 1 ? 0.6 : 0);
                  q.multiply(tmpQ.setFromAxisAngle(FLEX_AXIS, (thumb ? thumbTuck : 0) - open));
                }
              }
              f.bones[0].updateMatrixWorld(true);
            }
          }
        }

        let occluder = side === 'L' ? 0 : OCCLUDERS_PER_HAND;
        const wristAt = h.hand.getWorldPosition(tmpC);
        for (const f of h.fingers) {
          tmpA.copy(f.padLocal).applyMatrix4(f.bones[2].matrixWorld);
          contactOccluders[occluder++].set(tmpA.x, tmpA.y, tmpA.z, f.finger === 1 ? THUMB_TIP_RADIUS : TIP_RADIUS);
          f.bones[2].getWorldPosition(tmpA);
          contactOccluders[occluder++].set(tmpA.x, tmpA.y, tmpA.z, JOINT_RADIUS);
          f.bones[0].getWorldPosition(tmpA).lerp(f.bones[1].getWorldPosition(tmpB), 0.5);
          contactOccluders[occluder++].set(tmpA.x, tmpA.y, tmpA.z, PHALANX_RADIUS);
          if (f.finger !== 1) {
            f.bones[0].getWorldPosition(tmpA).lerp(wristAt, 0.5);
            contactOccluders[occluder++].set(tmpA.x, tmpA.y, tmpA.z, PALM_RADIUS);
          }
        }
      }
    },
  };
}
