// First-person head: the seated pose from layout.json, a zoom toward the
// monitor, a small lean while typing, pointer-driven glance and breathing.
import { MathUtils, PerspectiveCamera, Quaternion, Vector2, Vector3 } from 'three';
import { layout, screenPose } from '../layout';

const MIN_HORIZONTAL_FOV = 72; // degrees; narrow windows widen the vertical FOV
const FOCUS_FILL = 0.9; // share of the viewport width the panel fills when zoomed in
const INTRO_SECONDS = 3.2;

export interface PovInput {
  pointer: Vector2; // NDC, -1..1
  typing: number; // 0..1 recent typing activity
  zoom: number; // 0 = seated view, 1 = panel fills the viewport
}

export interface PovCamera {
  camera: PerspectiveCamera;
  setAspect(aspect: number): void;
  playIntro(): void;
  update(dt: number, input: PovInput): void;
}

export function createPovCamera(reducedMotion: boolean): PovCamera {
  const baseFov = layout.camera.verticalFovDeg;
  const camera = new PerspectiveCamera(baseFov, 16 / 9, 0.02, 80);
  const baseEye = new Vector3().fromArray(layout.camera.eye);
  const baseTarget = new Vector3().fromArray(layout.camera.target);
  const pose = screenPose();
  const screenNormal = new Vector3(0, 0, 1).applyQuaternion(pose.quaternion);

  let time = 0;
  let introT = 1;
  const glance = new Vector2();
  let lean = 0;
  let zoom = 0;

  // Eye position from which the panel fills FOCUS_FILL of the viewport width.
  const focusEye = (fill: number) => {
    const hFov = 2 * Math.atan(Math.tan(MathUtils.degToRad(camera.fov) / 2) * camera.aspect);
    const distance = pose.width / (2 * fill * Math.tan(hFov / 2));
    return pose.center.clone().addScaledVector(screenNormal, distance);
  };

  const eye = new Vector3();
  const target = new Vector3();
  const look = new Quaternion();
  const up = new Vector3(0, 1, 0);

  return {
    camera,
    setAspect(aspect) {
      camera.aspect = aspect;
      const minVertical = MathUtils.radToDeg(2 * Math.atan(Math.tan(MathUtils.degToRad(MIN_HORIZONTAL_FOV) / 2) / aspect));
      camera.fov = Math.max(baseFov, minVertical);
      camera.updateProjectionMatrix();
    },
    playIntro() {
      introT = reducedMotion ? 1 : 0;
    },
    update(dt, input) {
      time += dt;
      introT = Math.min(1, introT + dt / INTRO_SECONDS);
      const damp = (current: number, goal: number, rate: number) => MathUtils.damp(current, goal, rate, dt);
      glance.x = damp(glance.x, input.pointer.x, 2.2);
      glance.y = damp(glance.y, input.pointer.y, 2.2);
      lean = damp(lean, input.typing, input.typing > lean ? 1.6 : 0.5);
      zoom = damp(zoom, input.zoom, 4);

      // Intro: start with the panel filling the view, then sit back.
      const intro = 1 - Math.pow(1 - introT, 3);
      const zoomBlend = Math.max(zoom, 1 - intro);
      const fill = MathUtils.lerp(FOCUS_FILL, 1.02, 1 - intro);
      eye.copy(baseEye).lerp(focusEye(fill), zoomBlend * zoomBlend * (3 - 2 * zoomBlend));
      target.copy(baseTarget).lerp(pose.center, zoomBlend);

      // Lean in a little while typing; the hands stay in frame.
      eye.addScaledVector(screenNormal, -0.035 * lean * (1 - zoomBlend));
      eye.y -= 0.01 * lean * (1 - zoomBlend);

      if (!reducedMotion) {
        const breathe = Math.sin(time * Math.PI * 2 * 0.21);
        eye.y += breathe * 0.0022;
        eye.x += Math.sin(time * 0.37) * 0.0015 + Math.sin(time * 0.91) * 0.0006;
        const parallax = 1 - zoomBlend * 0.8;
        eye.x += glance.x * 0.014 * parallax;
        eye.y += glance.y * 0.007 * parallax;
      }

      camera.position.copy(eye);
      camera.up.copy(up);
      camera.lookAt(target);
      if (!reducedMotion) {
        // Glance toward the pointer: small yaw/pitch on top of the look-at.
        const yaw = -glance.x * MathUtils.degToRad(2.2) * (1 - zoomBlend * 0.7);
        const pitch = glance.y * MathUtils.degToRad(1.4) * (1 - zoomBlend * 0.7);
        look.setFromAxisAngle(up, yaw);
        camera.quaternion.premultiply(look);
        camera.rotateX(pitch);
        camera.rotateZ(Math.sin(time * 0.29) * MathUtils.degToRad(0.12));
      }
    },
  };
}
