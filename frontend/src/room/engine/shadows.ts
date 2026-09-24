// three's PCF shadow lookup takes five taps on a disc rotated per pixel by
// interleaved gradient noise, which assumes temporal anti-aliasing will
// average the noise away. This renderer has none, so every penumbra (the
// monitor's shadow across a hand, the blinds' slats on the desk) shows a
// screen-door dot pattern. Patch the 2D lookup (spot and directional
// lights) to a fixed disc of SHADOW_TAPS hardware-filtered taps: smooth,
// noise-free penumbrae.
import { ShaderChunk } from 'three';

const SHADOW_TAPS = 12;
const NOISY_ROTATION = 'float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;';
const FIVE_TAPS =
  /shadow = \(\s*texture\( shadowMap, vec3\( shadowCoord\.xy \+ vogelDiskSample\( 0, 5, phi \) \* radius, shadowCoord\.z \) \)[\s\S]*?\) \* 0\.2;/;
const FIXED_TAPS = /* glsl */ `shadow = 0.0;
				for ( int i = 0; i < ${SHADOW_TAPS}; i ++ ) {
					shadow += texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( i, ${SHADOW_TAPS}, phi ) * radius, shadowCoord.z ) );
				}
				shadow /= ${SHADOW_TAPS}.0;`;

export function smoothShadowPenumbrae() {
  const chunk = ShaderChunk.shadowmap_pars_fragment;
  if (chunk.includes(FIXED_TAPS)) return;
  if (!chunk.includes(NOISY_ROTATION) || !FIVE_TAPS.test(chunk)) {
    // three changed its shadow chunk: say so rather than silently keeping
    // the dotted penumbrae.
    console.warn('shadows.ts: three.js shadow chunk changed; penumbrae keep their per-pixel noise');
    return;
  }
  ShaderChunk.shadowmap_pars_fragment = chunk
    .replaceAll(NOISY_ROTATION, 'float phi = 0.0;')
    .replace(FIVE_TAPS, FIXED_TAPS);
}
