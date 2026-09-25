// Contact shadows under the POV hands. Neither shadow map resolves the last
// few millimetres between a fingertip and the key it rests on, so the keys
// and the mouse stayed lit right up to the skin and the fingers seemed to
// hover. The hands (hands.ts) publish spheres standing in for their
// fingertips, finger joints and palms every frame; the keyboard's and the
// mouse's materials take out the diffuse light each sphere blocks (its
// cosine-weighted solid angle, which reaches all of it where a sphere sits
// on the surface), but at most CONTACT_DARKENING of it: some light always
// scatters in under a soft fingertip. A reflection comes from one
// direction, not the whole sky: the lamp's highlight on the mouse's
// lacquer sits under a finger only if the finger doesn't cover it, so each
// specular layer (the lacquer's own, rougher or smoother) takes out what the
// sphere covers of a cone around the mirror direction as wide as the
// layer's roughness spreads its reflection.
import { ShaderChunk, Vector4, type MeshStandardMaterial } from 'three';

export const MAX_CONTACT_OCCLUDERS = 38;

// World-space centre (xyz) and radius (w) of each sphere; unused ones keep a
// radius of zero.
export const contactOccluders = Array.from({ length: MAX_CONTACT_OCCLUDERS }, () => new Vector4());
const occluderUniform = { value: contactOccluders };

const CONTACT_GLOBALS = /* glsl */ `
uniform vec4 contactOccluders[ ${MAX_CONTACT_OCCLUDERS} ];
varying vec3 vContactPosition;
// How much of a reflection cone of half-angle \`cone\` around \`mirror\` a
// sphere seen at \`toward\` (unit) with angular radius \`angularRadius\`
// covers: all of it once the sphere is as wide as the cone and centred on it.
float contactCover( const in vec3 mirror, const in vec3 toward, const in float angularRadius, const in float cone ) {
  float apart = acos( clamp( dot( mirror, toward ), -1.0, 1.0 ) );
  float share = min( angularRadius * angularRadius / ( cone * cone ), 1.0 );
  return share * ( 1.0 - smoothstep( max( angularRadius - cone, 0.0 ), angularRadius + cone, apart ) );
}`;

const CONTACT_FRAGMENT = /* glsl */ `{
    const float CONTACT_DARKENING = 0.9;
    vec3 contactNormal = transformNormalByInverseViewMatrix( geometryNormal, viewMatrix );
    vec3 contactMirror = reflect( normalize( vContactPosition - cameraPosition ), contactNormal );
    // The half-angle a GGX lobe spreads a reflection over.
    float specularCone = mix( 0.05, 1.2, material.roughness );
    float contactLight = 1.0;
    float contactSpecular = 1.0;
    #ifdef USE_CLEARCOAT
      float coatCone = mix( 0.05, 1.2, material.clearcoatRoughness );
      float contactCoat = 1.0;
    #endif
    for ( int i = 0; i < ${MAX_CONTACT_OCCLUDERS}; i ++ ) {
      vec3 toOccluder = contactOccluders[ i ].xyz - vContactPosition;
      float distanceSq = max( dot( toOccluder, toOccluder ), 1e-8 );
      float radiusSq = contactOccluders[ i ].w * contactOccluders[ i ].w;
      vec3 toward = toOccluder * inversesqrt( distanceSq );
      float blocked = saturate( dot( contactNormal, toward ) ) * min( radiusSq / distanceSq, 1.0 );
      contactLight *= 1.0 - CONTACT_DARKENING * blocked;
      float angularRadius = asin( sqrt( min( radiusSq / distanceSq, 1.0 ) ) );
      contactSpecular *= 1.0 - CONTACT_DARKENING * contactCover( contactMirror, toward, angularRadius, specularCone );
      #ifdef USE_CLEARCOAT
        contactCoat *= 1.0 - CONTACT_DARKENING * contactCover( contactMirror, toward, angularRadius, coatCone );
      #endif
    }
    reflectedLight.directDiffuse *= contactLight;
    reflectedLight.indirectDiffuse *= contactLight;
    reflectedLight.directSpecular *= contactSpecular;
    reflectedLight.indirectSpecular *= contactSpecular;
    #ifdef USE_CLEARCOAT
      clearcoatSpecularDirect *= contactCoat;
      clearcoatSpecularIndirect *= contactCoat;
    #endif
    #ifdef USE_SHEEN
      sheenSpecularDirect *= contactLight;
      sheenSpecularIndirect *= contactLight;
    #endif
  }`;

// Every name the patch relies on; if three renames any of them the keys keep
// three's stock shading instead of failing to compile.
const PATCHABLE =
  ShaderChunk.meshphysical_vert.includes('#include <project_vertex>') &&
  ShaderChunk.meshphysical_frag.includes('#include <aomap_fragment>') &&
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
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${CONTACT_FRAGMENT}`);
  };
  material.customProgramCacheKey = () => 'room-contact';
}
