// Contact shadows under the POV hands. Neither shadow map resolves the last
// few millimetres between a fingertip and the key it rests on, so the keys
// and the mouse stayed lit right up to the skin and the fingers seemed to
// hover. The hands (hands.ts) publish spheres standing in for their
// fingertips, finger joints and palms every frame; the keyboard's and the
// mouse's materials take out the direct light each sphere blocks (its
// cosine-weighted solid angle, clipped where the sphere dips below the
// surface's horizon: a fingertip resting on a key sits right on that
// horizon, and counting only its centre's side of it left the key lit up to
// the pad), but at most CONTACT_DARKENING of it: some light always
// scatters in under a soft fingertip. Each sphere counts only as it nears
// the surface (its clearance above the surface's plane), so a finger
// hovering over the mouse casts no contact shadow. The room's light, from
// everywhere, they take out of a wider sphere (CONTACT_REACH_SQ). A point light's
// reflection comes from one direction: the lamp's highlight on the mouse's
// lacquer sits under a finger only if the finger doesn't cover it, so each
// specular layer (the lacquer's own, rougher or smoother) takes out what the
// sphere covers of a cone around the mirror direction as wide as the
// layer's roughness spreads its reflection. The room's reflection in a rough
// layer gathers from most of the sky and loses about what its ambient light
// does. The same materials take the visitor's body out of the room's light
// (body.ts) and the hands' soft shadow in that light (shadows.ts's sky
// shade).
import { ShaderChunk, Vector4, type MeshStandardMaterial } from 'three';
import { BODY_GLSL } from './body';

export const MAX_CONTACT_OCCLUDERS = 38;

// World-space centre (xyz) and radius (w) of each sphere; unused ones keep a
// radius of zero.
export const contactOccluders = Array.from({ length: MAX_CONTACT_OCCLUDERS }, () => new Vector4());
const occluderUniform = { value: contactOccluders };

// How much of a reflection cone of half-angle `cone` around `mirror` a
// sphere seen at `toward` (unit) with angular radius `angularRadius`
// covers: all of it once the sphere is as wide as the cone and centred on it.
export const CONE_COVER_GLSL = /* glsl */ `
float contactCover( const in vec3 mirror, const in vec3 toward, const in float angularRadius, const in float cone ) {
  float apart = acos( clamp( dot( mirror, toward ), -1.0, 1.0 ) );
  float share = min( angularRadius * angularRadius / ( cone * cone ), 1.0 );
  return share * ( 1.0 - smoothstep( max( angularRadius - cone, 0.0 ), angularRadius + cone, apart ) );
}`;

// The share of a surface point's cosine-weighted sky a sphere hides, given
// the cosine of its centre off the normal and (distance / radius)², exact
// where the sphere straddles the horizon (Quilez, "Sphere ambient
// occlusion"). A point inside a sphere (a pad pressed into the mouse's
// shell) goes on to all of it smoothly, not at the sphere's edge: that edge
// drew a hard disc under each fingertip.
const CONTACT_GLOBALS = /* glsl */ `
uniform vec4 contactOccluders[ ${MAX_CONTACT_OCCLUDERS} ];
varying vec3 vContactPosition;
${CONE_COVER_GLSL}
float contactBlocked( const in float nl, const in float h2 ) {
  if ( h2 <= 1.0 ) return 0.5 * ( 1.0 + nl ) + 0.5 * ( 1.0 - nl ) * ( 1.0 - h2 );
  float k2 = 1.0 - h2 * nl * nl;
  if ( k2 <= 1e-3 ) return max( nl, 0.0 ) / h2;
  float straddle = nl * acos( clamp( - nl * sqrt( ( h2 - 1.0 ) / max( 1.0 - nl * nl, 1e-6 ) ), -1.0, 1.0 ) )
    - sqrt( k2 * ( h2 - 1.0 ) );
  return saturate( ( straddle / h2 + atan( sqrt( k2 / ( h2 - 1.0 ) ) ) ) / PI );
}`;

const CONTACT_FRAGMENT = /* glsl */ `{
    const float CONTACT_DARKENING = 0.9;
    // The room's light comes from everywhere, and the spheres are a sparse
    // stand-in for fingers that run on between them and are fleshier than
    // they are: it takes out the light of a sphere this many times the
    // area, which closes the gaps along a finger and reaches the few
    // millimetres of keycap beside the fingertip that the camera sees.
    const float CONTACT_REACH_SQ = 2.0;
    // A sphere's shadow fades out as it lifts off the surface, gone once
    // its clearance above the surface's plane is CONTACT_LIFT plus
    // CONTACT_LIFT_SHARE of its radius (4.6 mm for a fingertip, 8 mm for
    // the palm; a pad resting on the mouse sits 1.5 mm clear, hovering ones
    // 4-6 mm): the shadow the hand casts from further up is the shadow
    // maps' and the sky shade's. Without it a fingertip hovering over the
    // mouse printed the same dark spot as one resting on it.
    const float CONTACT_LIFT = 0.002;
    const float CONTACT_LIFT_SHARE = 0.4;
    vec3 contactNormal = transformNormalByInverseViewMatrix( geometryNormal, viewMatrix );
    vec3 contactMirror = reflect( normalize( vContactPosition - cameraPosition ), contactNormal );
    // The half-angle a GGX lobe spreads a reflection over.
    float specularCone = mix( 0.05, 1.2, material.roughness );
    float contactLight = 1.0;
    float contactAmbient = 1.0;
    float contactSpecular = 1.0;
    float contactReflection = 1.0;
    #ifdef USE_CLEARCOAT
      float coatCone = mix( 0.05, 1.2, material.clearcoatRoughness );
      float contactCoat = 1.0;
      float contactCoatReflection = 1.0;
    #endif
    for ( int i = 0; i < ${MAX_CONTACT_OCCLUDERS}; i ++ ) {
      float radius = contactOccluders[ i ].w;
      if ( radius <= 0.0 ) continue;
      vec3 toOccluder = contactOccluders[ i ].xyz - vContactPosition;
      float clearance = dot( toOccluder, contactNormal ) - radius;
      float touch = 1.0 - smoothstep( 0.0, CONTACT_LIFT + CONTACT_LIFT_SHARE * radius, clearance );
      if ( touch <= 0.0 ) continue;
      // A pad pressed into the surface (the spheres are rounder than a
      // pad, which flattens) shades as one resting on it: counted inside
      // it, the surface went to full dark over the whole disc the sphere
      // cut, a hard-edged spot under every fingertip.
      toOccluder -= contactNormal * min( clearance, 0.0 );
      float radiusSq = radius * radius;
      float distanceSq = max( dot( toOccluder, toOccluder ), 1e-8 );
      vec3 toward = toOccluder * inversesqrt( distanceSq );
      float facing = dot( contactNormal, toward );
      // Squared: still full at the contact point, but a pad's width away a
      // third of the sphere's own occlusion, which spread each fingertip's
      // shadow into a disc twice the pad it stands for.
      float blocked = contactBlocked( facing, distanceSq / radiusSq );
      blocked *= blocked * touch;
      float blockedRoom = contactBlocked( facing, distanceSq / ( CONTACT_REACH_SQ * radiusSq ) );
      blockedRoom *= blockedRoom * touch;
      contactLight *= 1.0 - CONTACT_DARKENING * blocked;
      contactAmbient *= 1.0 - CONTACT_DARKENING * blockedRoom;
      float angularRadius = asin( sqrt( min( radiusSq / distanceSq, 1.0 ) ) );
      float cover = contactCover( contactMirror, toward, angularRadius, specularCone ) * touch;
      contactSpecular *= 1.0 - CONTACT_DARKENING * cover;
      // A rough reflection of the room gathers from most of the sky, so a
      // finger beside it takes out about what it takes of the ambient
      // light (the keycaps are nearly black: what shows on them is this).
      // Right at the contact the finger is all of the sky, however smooth
      // the surface: keeping a smooth reflection there left the sky's blue
      // in every contact shadow on the mouse.
      float roomCover = blockedRoom * mix( material.roughness, 1.0, blockedRoom );
      contactReflection *= 1.0 - CONTACT_DARKENING * max( cover, roomCover );
      #ifdef USE_CLEARCOAT
        float coatCover = contactCover( contactMirror, toward, angularRadius, coatCone ) * touch;
        contactCoat *= 1.0 - CONTACT_DARKENING * coatCover;
        contactCoatReflection *= 1.0 - CONTACT_DARKENING * max( coatCover, blockedRoom * mix( material.clearcoatRoughness, 1.0, blockedRoom ) );
      #endif
    }
    // The room's light: less the body's share (it is the panorama's, so
    // it scales the ambient diffuse by what is left of it) and under the
    // hands' sky shade.
    float ambientShade = 1.0;
    #ifdef HAS_SKY_SHADE
      ambientShade = getSkyShade();
    #endif
    vec3 bodyShade = vec3( 1.0 );
    #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
      bodyShade = max( iblIrradiance + bodyIrradiance( vContactPosition, contactNormal ), vec3( 0.0 ) )
        / max( iblIrradiance, vec3( 1e-6 ) );
      float bodyShown = bodyReflection( vContactPosition, contactMirror, specularCone );
    #else
      float bodyShown = 0.0;
    #endif
    reflectedLight.directDiffuse *= contactLight;
    reflectedLight.indirectDiffuse *= contactAmbient * ambientShade * bodyShade;
    reflectedLight.directSpecular *= contactSpecular;
    reflectedLight.indirectSpecular *= contactReflection * ambientShade * ( 1.0 - bodyShown );
    #ifdef USE_CLEARCOAT
      clearcoatSpecularDirect *= contactCoat;
      clearcoatSpecularIndirect *= contactCoatReflection * ambientShade;
      #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
        clearcoatSpecularIndirect *= 1.0 - bodyReflection( vContactPosition, contactMirror, coatCone );
      #endif
    #endif
    #ifdef USE_SHEEN
      sheenSpecularDirect *= contactLight;
      sheenSpecularIndirect *= contactAmbient;
    #endif
  }`;

// Every name the patch relies on; if three renames any of them the keys keep
// three's stock shading instead of failing to compile.
const PATCHABLE =
  ShaderChunk.meshphysical_vert.includes('#include <project_vertex>') &&
  ShaderChunk.meshphysical_frag.includes('#include <aomap_fragment>') &&
  ShaderChunk.meshphysical_frag.includes('#include <envmap_physical_pars_fragment>') &&
  ShaderChunk.envmap_physical_pars_fragment.includes('textureCubeUV( envMap, envMapRotation *') &&
  ShaderChunk.lights_fragment_begin.includes('vec3 iblIrradiance = vec3( 0.0 );') &&
  ShaderChunk.common.includes('vec3 transformNormalByInverseViewMatrix(');
if (!PATCHABLE) {
  console.warn('contact.ts: three.js shader chunks changed; the hands cast no contact shadows');
}

export function applyContactShadows(material: MeshStandardMaterial) {
  if (!PATCHABLE) return;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.contactOccluders = occluderUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vContactPosition;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvContactPosition = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${CONTACT_GLOBALS}`)
      .replace('#include <envmap_physical_pars_fragment>', `#include <envmap_physical_pars_fragment>\n${BODY_GLSL}`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${CONTACT_FRAGMENT}`);
  };
  material.customProgramCacheKey = () => 'room-contact';
}
