// Cheap subsurface look for the POV hands. Light scatters under skin, red
// furthest: each channel's diffuse uses a normal between the detailed one
// (pores, knuckle creases) and the smooth geometric one, blurrier for red
// (the "pre-integrated" normal trick), and wraps past the terminator into a
// warm band instead of plain Lambert's hard, waxy falloff. Patches three's
// physical lighting chunk for this material only.
import { ShaderChunk, type MeshStandardMaterial } from 'three';

const LAMBERT_LINE =
  'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );';

// `geometryNormal` here is the normal-mapped one; `skinSmoothNormal` is the
// interpolated vertex normal, copied out of main() below.
const WRAPPED = /* glsl */ `{
    // How much of the detail normal each channel keeps, and how far it wraps.
    const vec3 SKIN_DETAIL = vec3( 0.35, 0.75, 0.95 );
    const vec3 SKIN_WRAP = vec3( 0.45, 0.18, 0.1 );
    vec3 ndl = vec3(
      dot( normalize( mix( skinSmoothNormal, geometryNormal, SKIN_DETAIL.r ) ), directLight.direction ),
      dot( normalize( mix( skinSmoothNormal, geometryNormal, SKIN_DETAIL.g ) ), directLight.direction ),
      dot( normalize( mix( skinSmoothNormal, geometryNormal, SKIN_DETAIL.b ) ), directLight.direction )
    );
    vec3 wrapped = saturate( ( ndl + SKIN_WRAP ) / ( 1.0 + SKIN_WRAP ) );
    reflectedLight.directDiffuse += directLight.color * wrapped * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );
  }`;

// Every name the patch relies on; if three renames any of them the skin keeps
// three's stock shading instead of failing to compile.
const PATCHABLE =
  ShaderChunk.lights_physical_pars_fragment.includes(LAMBERT_LINE) &&
  ShaderChunk.normal_fragment_begin.includes('vec3 nonPerturbedNormal');
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
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nskinSmoothNormal = nonPerturbedNormal;');
  };
  material.customProgramCacheKey = () => 'room-skin';
  material.needsUpdate = true;
}
