// Scene placement shared with the Blender build scripts in scripts/room/,
// which read the same JSON. Metres; +Y up, the seated viewer faces -Z.
import { Euler, Quaternion, Vector3 } from 'three';
import layoutJson from './layout.json';

export const layout = layoutJson;

// The monitor panel: centre, orientation (tilted back about X) and size.
export function screenPose() {
  const { screenCenter, screenWidth, screenHeight, tiltBackDeg } = layout.monitor;
  return {
    center: new Vector3().fromArray(screenCenter),
    quaternion: new Quaternion().setFromEuler(new Euler((-tiltBackDeg * Math.PI) / 180, 0, 0)),
    width: screenWidth,
    height: screenHeight,
  };
}
