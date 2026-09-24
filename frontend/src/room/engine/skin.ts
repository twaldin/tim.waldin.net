// Cheap subsurface look for the POV hands. Light scatters under skin, red
// furthest: each channel's diffuse uses a normal between the detailed one
// (pores, knuckle creases) and the smooth geometric one, blurrier for red
// (the "pre-integrated" normal trick), and wraps a little past the
// terminator, red most, so millimetre-scale valleys (between the knuckles)
// turned from the light stay warm instead of going grey; past the smooth
// terminator a thin orange band of scattered light fades out instead of
// plain Lambert's hard, waxy edge. Ambient light (the room panorama) comes
// out of skin a little warmer, so a hand in shade under a blue sky stays
// skin-coloured instead of turning to grey clay. The baked occlusion (the
// aoMap) takes ambient light out of creases, keeping more red, as light
// bouncing inside a crease does, and a little of the direct light (shadow
// maps can't resolve millimetre creases). Patches three's lighting chunks
// for this material only.
import { ShaderChunk, type MeshStandardMaterial } from 'three';

const LAMBERT_LINE =
  'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );';
const AO_LINE = 'reflectedLight.indirectDiffuse *= ambientOcclusion;';

// `geometryNormal` here is the normal-mapped one; `skinSmoothNormal` is the
// interpolated vertex normal, copied out of main() below.
const WRAPPED = /* glsl */ `{
    // How much of the detail normal each channel keeps.
    const vec3 SKIN_DETAIL = vec3( 0.55, 0.75, 0.85 );
    vec3 ndl = vec3(
      dot( normalize( mix( skinSmoothNormal, geometryNormal, SKIN_DETAIL.r ) ), directLight.direction ),
      dot( normalize( mix( skinSmoothNormal, geometryNormal, SKIN_DETAIL.g ) ), directLight.direction ),
      dot( normalize( mix( skinSmoothNormal, geometryNormal, SKIN_DETAIL.b ) ), directLight.direction )
    );
    // Red light scatters ~1 mm under skin: past the terminator it lingers
    // for a few millimetres of a finger's curve, orange, fading out before
    // the shadow side. Measured on the smooth normal: skin detail must not
    // draw lines where it crosses the terminator.
    const float SKIN_WRAP = 0.07;
    const vec3 SKIN_SCATTER = vec3( 1.0, 0.46, 0.31 );
    float smoothNdl = dot( skinSmoothNormal, directLight.direction );
    float band = ( saturate( ( smoothNdl + SKIN_WRAP ) / ( 1.0 + SKIN_WRAP ) ) - saturate( smoothNdl ) )
      * smoothstep( -SKIN_WRAP, 0.05, smoothNdl );
    // How far each channel's light wraps past the detail terminator.
    const vec3 SKIN_SOFT = vec3( 0.14, 0.09, 0.06 );
    reflectedLight.directDiffuse += directLight.color
      * ( saturate( ( ndl + SKIN_SOFT ) / ( 1.0 + SKIN_SOFT ) ) + band * SKIN_SCATTER )
      * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );
  }`;

// Scattered ambient light's shift toward red (at about equal luminance).
const AMBIENT_TINT = 'vec3( 1.12, 0.97, 0.88 )';
// Occlusion takes ambient light out of creases, keeping more red than blue,
// but never to black (skin scatters light into its creases), and dims the
// direct diffuse light slightly; direct highlights stay to the shadow maps.
const SKIN_OCCLUSION = /* glsl */ `
  reflectedLight.indirectDiffuse *= pow( vec3( mix( 0.55, 1.0, ambientOcclusion ) ), vec3( 0.6, 1.0, 1.2 ) );
  reflectedLight.directDiffuse *= mix( 1.0, ambientOcclusion, 0.15 );`;

// Every name the patch relies on; if three renames any of them the skin keeps
// three's stock shading instead of failing to compile.
const PATCHABLE =
  ShaderChunk.lights_physical_pars_fragment.includes(LAMBERT_LINE) &&
  ShaderChunk.normal_fragment_begin.includes('vec3 nonPerturbedNormal') &&
  ShaderChunk.lights_fragment_end.includes('RE_IndirectSpecular') &&
  ShaderChunk.aomap_fragment.includes(AO_LINE);
if (!PATCHABLE) {
  // three changed its lighting chunks: fail loudly in development rather
  // than silently shipping plain Lambert skin.
  console.warn('skin.ts: three.js lighting chunks changed; skin wrap shading is inactive');
}

export function applySkinShading(material: MeshStandardMaterial) {
  material.envMapIntensity = 0.55;
  if (!PATCHABLE) return;
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <lights_physical_pars_fragment>',
        `vec3 skinSmoothNormal;\n${ShaderChunk.lights_physical_pars_fragment.replace(LAMBERT_LINE, WRAPPED)}`,
      )
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nskinSmoothNormal = nonPerturbedNormal;')
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>\nreflectedLight.indirectDiffuse *= ${AMBIENT_TINT};`,
      )
      .replace('#include <aomap_fragment>', ShaderChunk.aomap_fragment.replace(AO_LINE, SKIN_OCCLUSION));
  };
  material.customProgramCacheKey = () => 'room-skin';
  material.needsUpdate = true;
}
