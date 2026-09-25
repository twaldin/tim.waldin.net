// Cheap subsurface look for the POV hands. Light scatters under skin, red
// furthest: each channel's diffuse uses a normal between the detailed one
// (pores, knuckle creases) and the smooth geometric one, blurrier for red
// (the "pre-integrated" normal trick), and wraps a little past the
// terminator, red most, so millimetre-scale valleys (between the knuckles)
// turned from the light stay warm instead of going grey; past the smooth
// terminator a thin orange band of scattered light fades out instead of
// plain Lambert's hard, waxy edge. Ambient light is the room's, as on the
// keyboard beside the hands (probes.ts), less what the visitor's body
// hides (body.ts) and under the hands' own soft shadow (shadows.ts's sky
// shade), plus what no capture of the room can hold: the neighbouring
// fingers lit around the hands. The baked occlusion (the aoMap) takes
// ambient light out of creases, keeping more red, as light bouncing inside
// a crease does, and a little of the direct light (shadow maps can't
// resolve millimetre creases). Patches three's lighting chunks for this
// material only.
import { ShaderChunk, type MeshStandardMaterial } from 'three';
import { BODY_GLSL } from './body';
import { CONE_COVER_GLSL } from './contact';

const LAMBERT_LINE =
  'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );';
const AO_LINE = 'reflectedLight.indirectDiffuse *= ambientOcclusion;';

// The baked normal map's pores read as glittering stucco at full strength
// under the lamp; this keeps the pores and creases without the grit.
const SKIN_NORMAL_SCALE = 0.6;

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
    float smoothNdl = dot( skinSmoothNormal, directLight.direction );
    float band = ( saturate( ( smoothNdl + SKIN_WRAP ) / ( 1.0 + SKIN_WRAP ) ) - saturate( smoothNdl ) )
      * smoothstep( -SKIN_WRAP, 0.05, smoothNdl );
    // Light wraps skinSoft past the detail terminator, and what wraps has
    // come out of skin away from where it went in, so it's scatter-coloured.
    // (A wrap per channel, red's widest, leaves a strip only red reaches,
    // which the tone mapper's toe turns crimson in the lamp's dark.)
    vec3 lit = saturate( ndl );
    vec3 wrapped = saturate( ( ndl + skinSoft ) / ( 1.0 + skinSoft ) );
    reflectedLight.directDiffuse += directLight.color
      * ( lit + ( wrapped - lit + band ) * SKIN_SCATTER )
      * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );
    skinArriving += directLight.color;
  }`;

// Skin takes the room's light as the keyboard does (probes.ts: a probe
// over the home row at night, the panorama by day), less the share the
// visitor's body hides (body.ts): cool from the window by day, the
// lamp-lit keys below and the LED-lit wall ahead at night. What no capture
// of the room can hold is the hand itself: between two fingers, or in the
// web of the thumb, the skin a crease looks at is its neighbour, lit as
// this skin is: the part of the view the baked occlusion takes away is
// skin, about half of it lit, returning its albedo's share of the light
// that arrives here (where the occlusion says it is a crease, so the open
// back of a hand doesn't glow). It is the light that arrives, shadows and
// all: by day the hands type in the monitor's shade, and a web taking the
// sun's full light lit like a coal.
const SKIN_AMBIENT = /* glsl */ `{
    // Half the neighbour lit, and that half turned about 70 degrees from
    // the light on average (a finger's side, not its back).
    const float SKIN_CREASE_BOUNCE = 0.15;
    #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
      vec3 skinWorld = ( vec4( geometryPosition, 0.0 ) * viewMatrix ).xyz + cameraPosition;
      iblIrradiance = max(
        iblIrradiance + bodyIrradiance( skinWorld, transformNormalByInverseViewMatrix( skinSmoothNormal, viewMatrix ) ),
        vec3( 0.0 )
      );
    #endif
    #ifdef USE_AOMAP
      float creaseOcclusion = ( texture2D( aoMap, vAoMapUv ).r - 1.0 ) * aoMapIntensity + 1.0;
      iblIrradiance += skinArriving * material.diffuseContribution * ( smoothstep( 0.9, 0.3, creaseOcclusion ) * SKIN_CREASE_BOUNCE );
    #endif
  }`;

// Skin reflects about 2.8% of light head-on (index of refraction 1.4) where
// three's standard material assumes 4%, which on a sunlit hand reads as a
// milky film; nail keratin (1.55) keeps about 4%, and the bake gives the
// plates roughness ~0.34 against skin's ~0.5, which is how the patch finds
// them. The room's reflection, like its light, is under the hands' sky
// shade and shows the visitor's body where the body stands in it. Near a
// silhouette half a rough reflection's lobe points into the hand itself,
// which the prefiltered room behind it doesn't know: that half lit a pale
// rim around every finger seen against the bright end of the room.
const SKIN_F0 = 'material.specularColor = vec3( 0.04 );';
const SKIN_NAIL_F0 = 'material.specularColor = vec3( mix( 0.04, 0.028, smoothstep( 0.37, 0.45, material.roughness ) ) );';
const SKIN_ROOM_SPECULAR = /* glsl */ `{
    #ifdef HAS_SKY_SHADE
      float skinSky = getSkyShade();
      reflectedLight.indirectDiffuse *= skinSky;
      reflectedLight.indirectSpecular *= skinSky;
    #endif
    #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
      vec3 skinWorld = ( vec4( geometryPosition, 0.0 ) * viewMatrix ).xyz + cameraPosition;
      vec3 skinMirror = transformDirectionByInverseViewMatrix( reflect( - geometryViewDir, geometryNormal ), viewMatrix );
      float skinCone = mix( 0.05, 1.2, material.roughness );
      reflectedLight.indirectSpecular *= 1.0 - bodyReflection( skinWorld, skinMirror, skinCone );
      float lobeAbove = dot( skinMirror, transformNormalByInverseViewMatrix( skinSmoothNormal, viewMatrix ) );
      reflectedLight.indirectSpecular *= saturate( 0.5 + lobeAbove / ( 2.0 * sin( skinCone ) ) );
    #endif
  }`;

// Occlusion takes ambient light out of creases, keeping a little more red
// than blue, but never to black (skin scatters light into its creases),
// and dims the direct diffuse light slightly; direct highlights stay to the
// shadow maps. (Keeping much more red lit the curled fingertips' undersides
// and the web of the thumb orange under the room's bright daylight.)
const SKIN_OCCLUSION = /* glsl */ `
  reflectedLight.indirectDiffuse *= pow( vec3( mix( 0.55, 1.0, ambientOcclusion ) ), vec3( 0.8, 1.0, 1.1 ) );
  reflectedLight.directDiffuse *= mix( 1.0, ambientOcclusion, 0.15 );`;

// Sunlight on the back of a hand is three to four times brighter than the
// tone mapper's white, which then drains it to a milky pink. Skin exposes
// its direct light down so its brightest channel lands on a knee's white,
// hue kept, and sunlit skin stays peach. The exposure comes from the light
// that would arrive unshadowed (the lights on the smooth normal plus the
// room's ambient light, on a blurred albedo), and only scales the direct
// light: a curve over each pixel instead would flatten pores and creases
// with the brightness, and squeeze a shadow's penumbra into its last few
// percent of coverage, where the shadow map's texels show. The lamp lights
// skin to about 1.0, which the tone mapper rolls off well, so the knee
// comes down from there only as the sun takes over from the lamp (the
// room's one directional and one spot light).
const SKIN_SHOULDER = /* glsl */ `{
    const vec3 LUMINANCE = vec3( 0.2126, 0.7152, 0.0722 );
    vec3 unshadowed = iblIrradiance;
    float sunColor = 0.0;
    float lampColor = 0.0;
    #if NUM_DIR_LIGHTS > 0
      sunColor = dot( directionalLights[ 0 ].color, LUMINANCE );
      float sunNdl = dot( skinSmoothNormal, directionalLights[ 0 ].direction );
      unshadowed += skinSunlight( directionalLights[ 0 ].color ) * saturate( ( sunNdl + SKIN_SOFT ) / ( 1.0 + SKIN_SOFT ) );
    #endif
    #if NUM_SPOT_LIGHTS > 0
      lampColor = dot( spotLights[ 0 ].color, LUMINANCE );
      IncidentLight skinLamp;
      getSpotLightInfo( spotLights[ 0 ], geometryPosition, skinLamp );
      float lampNdl = dot( skinSmoothNormal, skinLamp.direction );
      unshadowed += skinLamp.color * saturate( ( lampNdl + SKIN_SOFT ) / ( 1.0 + SKIN_SOFT ) );
    #endif
    float knee = mix( 1.0, 0.7, sunColor / max( sunColor + lampColor, 1e-6 ) );
    // How far above the knee the brightest skin ends up.
    const float SKIN_HEADROOM = 0.28;
    vec3 smoothAlbedo = diffuse;
    #ifdef USE_MAP
      // Mip three of the map: pores out, fingertip and knuckle tints in.
      smoothAlbedo *= texture( map, vMapUv, 3.0 ).rgb;
    #endif
    vec3 arriving = unshadowed * RECIPROCAL_PI * smoothAlbedo;
    float skinPeak = max( max( arriving.r, arriving.g ), arriving.b );
    if ( skinPeak > knee ) {
      float over = skinPeak - knee;
      float exposure = ( knee + over / ( 1.0 + over / SKIN_HEADROOM ) ) / skinPeak;
      outgoingLight -= ( 1.0 - exposure ) * ( reflectedLight.directDiffuse + reflectedLight.directSpecular );
    }
  }`;

// Shadow maps have no idea light diffuses under skin, so a shadow's edge on
// a hand is as sharp in red as in blue and its penumbra comes out a greyer
// version of the lit colour. Under skin red light spreads a few
// millimetres, green less, blue barely: skin looks the shadow up a second
// time with a filter SKIN_SHADOW_REACH texels wider (about 3 mm more: the
// lamp's and the sun's texels are 1.5 and 2.3 mm at the desk) and gives red
// the wide one half blended in, green a little of it and blue the sharp one
// (all of the wide one lit a penumbra on the thick web of the thumb, a
// centimetre from any thin edge, in orange paint). Like the diffusion it
// stands for, a wider filter only moves light across an edge: the shadow
// side of a tight edge turns red, its lit side loses a little red, and a
// broad penumbra (the blinds' stripes across the back of a hand by day)
// keeps its colour. It has to be the filter and not a curve over the
// coverage: the blinds leave most of a sunlit hand in partial coverage,
// which a curve would tint all over. The sun's lookup is shadows.ts's
// two-layer one once that has patched the chunk.
const SHADOW_LOOKUP =
  /directLight\.color \*= \( directLight\.visible && receiveShadow \) \? (get(?:Sun)?Shadow\( [^;]*\)) : 1\.0;/g;
const SKIN_SHADOW_REACH = '1.5';

// Shared by the lighting patches. SKIN_SCATTER is the colour of light that
// comes out of skin a few millimetres from where it went in (red travels
// furthest, and some is lost on the way); it is multiplied by the albedo,
// which is red already, so a deeper red squares into crimson past the
// lamp's terminator (the underside of a thumb at night, lit by nothing
// else), and a paler one into orange putty where light grazes thick tissue
// (fingertips, the palm's edge). SKIN_SOFT is how far past the terminator
// light wraps on a finger's broad curve. Light spreads SKIN_DIFFUSION under
// skin whatever the surface does above it, so where the surface turns
// faster (the groove around a thumbnail turns 40° in two millimetres) it
// wraps further: the wrap follows the vertex normals' curvature, from their
// screen-space derivatives, as pre-integrated skin shading does. At night
// the groove's far wall, turned from the light bar, had no light at all and
// drew a black line around each thumbnail; skin that thin is lit through.
//
// The sun's colour is the room's golden stripes on its white walls and grey
// desk. Skin is orange itself, and the sun's warmth on top of it (red over
// blue 1.8) reads as sunburn beside the blue-grey keys the same sun lights,
// so skin takes the sun at SKIN_SUN_CHROMA of its colour, brightness kept.
const SKIN_GLOBALS = /* glsl */ `
${CONE_COVER_GLSL}
${BODY_GLSL}
vec3 skinSmoothNormal;
// Every direct light reaching this skin, shadowed: what lights its neighbours.
vec3 skinArriving = vec3( 0.0 );
const vec3 SKIN_SCATTER = vec3( 0.9, 0.7, 0.6 );
const float SKIN_SOFT = 0.15;
const float SKIN_DIFFUSION = 0.0015;
float skinSoft = SKIN_SOFT;
const float SKIN_SUN_CHROMA = 0.2;
vec3 skinSunlight( const in vec3 color ) {
  return mix( vec3( dot( color, vec3( 0.2126, 0.7152, 0.0722 ) ) ), color, SKIN_SUN_CHROMA );
}
vec3 skinShadowReach( const in float shadow, const in float wideShadow ) {
  return vec3( mix( shadow, wideShadow, 0.5 ), mix( shadow, wideShadow, 0.15 ), shadow );
}`;
// Copied out of main() once the normal map is applied: the vertex normal,
// and how fast it turns (radians per metre across the pixel, both
// derivatives in view space) for the wrap's reach.
const SKIN_NORMALS = /* glsl */ `
  skinSmoothNormal = nonPerturbedNormal;
  float skinCurvature = length( fwidth( skinSmoothNormal ) ) / max( length( fwidth( vViewPosition ) ), 1e-7 );
  skinSoft = clamp( skinCurvature * SKIN_DIFFUSION, SKIN_SOFT, 0.8 );`;
const SUN_LOOKUP = 'getDirectionalLightInfo( directionalLight, directLight );';

// engine.ts tone maps with Khronos PBR Neutral, whose toe takes a dark
// colour's weakest channel almost all out of every channel: skin in shade
// (red over green over blue) arrives crimson, its green and blue near zero,
// far redder than the grey-blue keys beside it in the same shade. Dark skin
// is handed over lifted just enough that it comes out at the toe's
// brightness in its own hue. Fades out where the toe does.
const SKIN_TOE = /* glsl */ `{
    const vec3 LUMINANCE = vec3( 0.2126, 0.7152, 0.0722 );
    float darkest = min( min( outgoingLight.r, outgoingLight.g ), outgoingLight.b );
    if ( darkest < 0.08 ) {
      vec3 toned = outgoingLight - ( darkest - 6.25 * darkest * darkest );
      vec3 ownHue = outgoingLight * ( max( dot( toned, LUMINANCE ), 0.0 ) / max( dot( outgoingLight, LUMINANCE ), 1e-6 ) );
      // What the toe will take back out of ownHue.
      float ownDarkest = min( min( ownHue.r, ownHue.g ), ownHue.b );
      vec3 lifted = ownHue + ( ownDarkest < 0.04 ? 0.4 * sqrt( ownDarkest ) - ownDarkest : 0.04 );
      outgoingLight = mix( outgoingLight, lifted, 1.0 - smoothstep( 0.04, 0.08, darkest ) );
    }
  }`;

// A hand is its own worst occluder at the shadow filter's scale: across the
// concave web between two knuckles, a filter 6 mm wide finds the
// neighbouring skin nearer the light than the plane of the triangle it
// shades, and each triangle there comes out as a dark tear. Skin looks its
// shadows up SKIN_NORMAL_BIAS times further off its surface (half a
// centimetre for the light bar and the sun's detail map, 1.5 cm its wide one)
// than the rest of the room does; the shadows other things cast on a hand
// come from centimetres away, so they barely move, and the keys' contact
// shadows under the fingertips keep the lights' own smaller offset.
const NORMAL_BIAS_LOOKUP = /(directionalLightShadows|spotLightShadows)\[ i \]\.shadowNormalBias/g;
const SKIN_NORMAL_BIAS = '2.5';

// Every name the patch relies on; if three renames any of them the skin keeps
// three's stock shading instead of failing to compile.
const PATCHABLE =
  ShaderChunk.lights_physical_pars_fragment.includes(LAMBERT_LINE) &&
  ShaderChunk.normal_fragment_begin.includes('vec3 nonPerturbedNormal') &&
  ShaderChunk.meshphysical_frag.includes('varying vec3 vViewPosition;') &&
  ShaderChunk.lights_fragment_maps.includes('iblIrradiance +=') &&
  ShaderChunk.aomap_fragment.includes('texture2D( aoMap, vAoMapUv )') &&
  ShaderChunk.lights_pars_begin.includes('void getSpotLightInfo(') &&
  ShaderChunk.lights_fragment_end.includes('RE_IndirectSpecular') &&
  ShaderChunk.lights_physical_fragment.includes(SKIN_F0) &&
  ShaderChunk.envmap_physical_pars_fragment.includes('textureCubeUV( envMap, envMapRotation *') &&
  ShaderChunk.aomap_fragment.includes(AO_LINE) &&
  ShaderChunk.opaque_fragment.includes('outgoingLight') &&
  ShaderChunk.map_fragment.includes('vMapUv') &&
  ShaderChunk.lights_fragment_begin.includes(SUN_LOOKUP) &&
  (ShaderChunk.lights_fragment_begin.match(SHADOW_LOOKUP) ?? []).filter((line) => line.includes('Shadow.shadowRadius,'))
    .length === 2 &&
  (ShaderChunk.shadowmap_vertex.match(NORMAL_BIAS_LOOKUP) ?? []).length === 2;
if (!PATCHABLE) {
  // three changed its lighting chunks: fail loudly in development rather
  // than silently shipping plain Lambert skin.
  console.warn('skin.ts: three.js lighting chunks changed; skin wrap shading is inactive');
}

export function applySkinShading(material: MeshStandardMaterial) {
  material.normalScale.multiplyScalar(SKIN_NORMAL_SCALE);
  if (!PATCHABLE) return;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <shadowmap_vertex>',
      ShaderChunk.shadowmap_vertex.replace(NORMAL_BIAS_LOOKUP, `$& * ${SKIN_NORMAL_BIAS}`),
    );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <lights_physical_pars_fragment>',
        `${SKIN_GLOBALS}\n${ShaderChunk.lights_physical_pars_fragment.replace(LAMBERT_LINE, WRAPPED)}`,
      )
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${SKIN_NORMALS}`)
      .replace(
        '#include <lights_fragment_begin>',
        ShaderChunk.lights_fragment_begin
          .replace(SUN_LOOKUP, `${SUN_LOOKUP}\ndirectLight.color = skinSunlight( directLight.color );`)
          .replace(
            SHADOW_LOOKUP,
            (_, lookup: string) =>
              `directLight.color *= ( directLight.visible && receiveShadow ) ? skinShadowReach( ${lookup}, ${lookup.replace(
                'Shadow.shadowRadius,',
                `Shadow.shadowRadius + ${SKIN_SHADOW_REACH},`,
              )} ) : vec3( 1.0 );`,
          ),
      )
      .replace('#include <lights_physical_fragment>', ShaderChunk.lights_physical_fragment.replace(SKIN_F0, SKIN_NAIL_F0))
      .replace('#include <lights_fragment_end>', `${SKIN_AMBIENT}\n#include <lights_fragment_end>\n${SKIN_ROOM_SPECULAR}`)
      .replace('#include <aomap_fragment>', ShaderChunk.aomap_fragment.replace(AO_LINE, SKIN_OCCLUSION))
      .replace('#include <opaque_fragment>', `${SKIN_SHOULDER}\n${SKIN_TOE}\n#include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => 'room-skin';
  material.needsUpdate = true;
}
