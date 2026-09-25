// three's PCF shadow lookup takes five taps on a disc rotated per pixel by
// interleaved gradient noise, which assumes temporal anti-aliasing will
// average the noise away. This renderer has none, so every penumbra (the
// monitor's shadow across a hand, the blinds' slats on the desk) shows a
// screen-door dot pattern. A fixed disc of taps instead is noise-free but
// sparse: a few taps spread over several texels see an occluder's texel
// staircase (the blinds' slat ends, a few texels wide) as a handful of
// shifted copies, so wide penumbrae come out as blocky multi-level steps.
// Patch the 2D lookup (spot and directional lights) to a tent filter whose
// half-width is the shadow's `radius` in texels, weighted at every texel
// centre it covers: each hardware-filtered tap reads a 2×2 texel block at the
// point that reproduces that block's tent weights. The filter moves smoothly
// with the receiver, so texel edges never show, and a radius of r costs about
// r² taps.
//
// A wide filter over a surface the light grazes (the back of a hand at the
// sun's terminator) compares one depth against the surface's own depths
// several texels up- and downhill, and each texel's terrace in the map turns
// into a contour line. Each tap instead compares the depth the receiver's
// plane has under that tap (the plane from the screen-space derivatives of
// the shadow coordinate), but only where the plane comes nearer the light:
// there the surface's own depths would shadow it. Where the plane falls
// away, the flat compare already clears the surface, and following the
// plane would only compare deeper, which in a crease (the web between thumb
// and index gripping the mouse) finds the other side of the crease; since
// the plane is each triangle's own, that drew the crease's triangles. The
// offset is capped so a silhouette's huge slope can't carry a tap past a
// real occluder.
import { ShaderChunk, type DirectionalLight, type Vector3 } from 'three';

// Largest radius, in texels, the tent covers in full: the lights' 4 plus
// skin's wider lookup for red (skin.ts).
const MAX_SHADOW_RADIUS = 6;
const NOISY_ROTATION = 'float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;';
const FIVE_TAPS =
  /shadow = \(\s*texture\( shadowMap, vec3\( shadowCoord\.xy \+ vogelDiskSample\( 0, 5, phi \) \* radius, shadowCoord\.z \) \)[\s\S]*?\) \* 0\.2;/;
// Texel centres sit on whole numbers in `texel` space. A radius of one texel
// is plain hardware filtering. MAX_PLANE_OFFSET is in shadow depth: about
// 1.3 cm for the sun, 6 mm for the lamp at the desk. `depthOffset` moves the
// compare toward the light (the sun's layers, below).
const MAX_PLANE_OFFSET = '0.0015';
const TENT_FILTER = /* glsl */ `
float shadowTent( sampler2DShadow shadowMap, vec2 shadowMapSize, vec3 shadowCoord, vec2 depthSlope, float radius, float depthOffset ) {
	float tentRadius = clamp( radius, 1.0, ${MAX_SHADOW_RADIUS}.0 );
	vec2 texel = shadowCoord.xy * shadowMapSize - 0.5;
	vec2 firstTexel = floor( texel - tentRadius ) + 1.0;
	int blocks = int( ceil( ceil( 2.0 * tentRadius ) * 0.5 ) );
	float weightSum = 0.0;
	float shadow = 0.0;
	for ( int y = 0; y < ${MAX_SHADOW_RADIUS}; y ++ ) {
		if ( y >= blocks ) break;
		float rowTexel = firstTexel.y + 2.0 * float( y );
		vec2 rowWeights = max( 1.0 - abs( vec2( rowTexel, rowTexel + 1.0 ) - texel.y ) / tentRadius, 0.0 );
		float rowWeight = rowWeights.x + rowWeights.y;
		for ( int x = 0; x < ${MAX_SHADOW_RADIUS}; x ++ ) {
			if ( x >= blocks ) break;
			float columnTexel = firstTexel.x + 2.0 * float( x );
			vec2 columnWeights = max( 1.0 - abs( vec2( columnTexel, columnTexel + 1.0 ) - texel.x ) / tentRadius, 0.0 );
			float columnWeight = columnWeights.x + columnWeights.y;
			vec2 at = vec2(
				columnTexel + columnWeights.y / max( columnWeight, 1e-5 ),
				rowTexel + rowWeights.y / max( rowWeight, 1e-5 )
			);
			float weight = columnWeight * rowWeight;
			vec2 tapUv = ( at + 0.5 ) / shadowMapSize;
			float planeDepth = shadowCoord.z - depthOffset + clamp( dot( depthSlope, tapUv - shadowCoord.xy ), -${MAX_PLANE_OFFSET}, 0.0 );
			shadow += weight * texture( shadowMap, vec3( tapUv, planeDepth ) );
			weightSum += weight;
		}
	}
	return shadow / weightSum;
}
// d(depth)/d(shadow uv), solved from the shadow coordinate's screen-space
// derivatives.
vec2 shadowDepthSlope( vec3 shadowCoord ) {
	vec3 coordDx = dFdx( shadowCoord );
	vec3 coordDy = dFdy( shadowCoord );
	float coordDet = coordDx.x * coordDy.y - coordDx.y * coordDy.x;
	return abs( coordDet ) > 1e-14
		? vec2( coordDy.y * coordDx.z - coordDx.y * coordDy.z, coordDx.x * coordDy.z - coordDy.x * coordDx.z ) / coordDet
		: vec2( 0.0 );
}
`;
const TENT_TAPS = 'shadow = shadowTent( shadowMap, shadowMapSize, shadowCoord.xyz, shadowDepthSlope( shadowCoord.xyz ), shadowRadius, 0.0 );';

// The sun's disc is half a degree across, so its penumbra is about 1% of
// the distance from occluder to receiver: a centimetre under the blinds a
// metre and a half from the desk, under a millimetre beneath a hand hovering
// over the keys. One filter as wide as the blinds' penumbra spreads a hand's
// shadow into soft blotches, with glowing gaps between the fingers' ghosts,
// that float off the desk, and the room-wide map's 2.3 mm texels can't draw
// it any sharper. So the sun has a second, shadow-only directional light
// (the room has no other; fitSunDetail) whose map covers just the desk, a
// fifth of the texel, and only SUN_DETAIL_DEPTH deep around it, which leaves
// the blinds and the window out: a map keeps only the occluder nearest the
// light, and the blinds' slats would hide the hands beneath them. The sun's
// shadow there is two layers: what lies more than SUN_NEAR_LAYER above the
// receiver, from the room-wide map under the wide filter, times what the
// detail map's nearer occluders leave under the detail light's own radius
// (its lookup at the receiver, less what its lookup SUN_NEAR_LAYER up
// already blocks, which the wide layer has). Towards the detail map's edges
// it fades back to the wide lookup alone.
export const SUN_SHADOW_DEPTH = { near: 0.5, far: 9 };
const SUN_DETAIL_WIDTH = 1.0;
const SUN_DETAIL_DEPTH = 1.2;
const SUN_NEAR_LAYER = 0.3;
const SUN_SHADOW = /* glsl */ `
float getSunShadow( sampler2DShadow shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
	shadowCoord.xyz /= shadowCoord.w;
	shadowCoord.z += shadowBias;
	bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
	if ( ! inFrustum || shadowCoord.z > 1.0 ) return 1.0;
	vec2 depthSlope = shadowDepthSlope( shadowCoord.xyz );
	float wide = shadowTent( shadowMap, shadowMapSize, shadowCoord.xyz, depthSlope, shadowRadius, 0.0 );
	float shadow = wide;
	#if NUM_DIR_LIGHT_SHADOWS > 1
		DirectionalLightShadow detail = directionalLightShadows[ 1 ];
		vec3 detailCoord = vDirectionalShadowCoord[ 1 ].xyz / vDirectionalShadowCoord[ 1 ].w;
		detailCoord.z += detail.shadowBias;
		vec2 inside = smoothstep( 0.0, 0.05, detailCoord.xy ) * smoothstep( 1.0, 0.95, detailCoord.xy );
		float detailShare = inside.x * inside.y * step( 0.0, detailCoord.z ) * step( detailCoord.z, 1.0 );
		if ( detailShare > 0.0 ) {
			vec2 detailSlope = shadowDepthSlope( detailCoord );
			// Skin's wider lookup (skin.ts) widens the near layer alike.
			float nearRadius = detail.shadowRadius * shadowRadius / directionalLightShadows[ 0 ].shadowRadius;
			float far = shadowTent( shadowMap, shadowMapSize, shadowCoord.xyz, depthSlope, shadowRadius, ${(SUN_NEAR_LAYER / (SUN_SHADOW_DEPTH.far - SUN_SHADOW_DEPTH.near)).toFixed(4)} );
			float nearFree = shadowTent( directionalShadowMap[ 1 ], detail.shadowMapSize, detailCoord, detailSlope, nearRadius, ${(SUN_NEAR_LAYER / SUN_DETAIL_DEPTH).toFixed(4)} );
			float nearLit = shadowTent( directionalShadowMap[ 1 ], detail.shadowMapSize, detailCoord, detailSlope, nearRadius, 0.0 );
			shadow = mix( wide, far * ( 1.0 - nearFree + nearLit ), detailShare );
		}
	#endif
	return mix( 1.0, shadow, shadowIntensity );
}
`;
const SUN_CALL = 'getShadow( directionalShadowMap[ i ]';
// Only the sun's own light looks its shadow up; the detail light's is dark.
const DIRECTIONAL_SHADOWED = '( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )';
const PCF_GET_SHADOW = /(#if defined\( SHADOWMAP_TYPE_PCF \)\s*)(float getShadow\( sampler2DShadow)/;

export function smoothShadowPenumbrae() {
  const chunk = ShaderChunk.shadowmap_pars_fragment;
  if (chunk.includes(TENT_TAPS)) return;
  const lights = ShaderChunk.lights_fragment_begin;
  if (
    !chunk.includes(NOISY_ROTATION) ||
    !FIVE_TAPS.test(chunk) ||
    !PCF_GET_SHADOW.test(chunk) ||
    !lights.includes(SUN_CALL) ||
    !lights.includes(DIRECTIONAL_SHADOWED)
  ) {
    // three changed its shadow chunks: say so rather than silently keeping
    // the dotted penumbrae.
    console.warn('shadows.ts: three.js shadow chunks changed; penumbrae keep their per-pixel noise');
    return;
  }
  // Point lights keep three's disc, unrotated so it doesn't dot either.
  ShaderChunk.shadowmap_pars_fragment = chunk
    .replaceAll(NOISY_ROTATION, 'float phi = 0.0;')
    .replace(FIVE_TAPS, TENT_TAPS)
    .replace(PCF_GET_SHADOW, `$1${TENT_FILTER}${SUN_SHADOW}$2`);
  ShaderChunk.lights_fragment_begin = lights
    .replace(DIRECTIONAL_SHADOWED, '( UNROLLED_LOOP_INDEX == 0 ) && ( NUM_DIR_LIGHT_SHADOWS > 0 )')
    .replace(SUN_CALL, 'getSunShadow( directionalShadowMap[ i ]');
}

// Frames the sun's detail light on the desk around `center`: the sun's
// position and aim, SUN_DETAIL_WIDTH square and SUN_DETAIL_DEPTH deep.
export function fitSunDetail(sun: DirectionalLight, detail: DirectionalLight, center: Vector3) {
  detail.position.copy(sun.position);
  detail.target.position.copy(sun.target.position);
  const camera = detail.shadow.camera;
  camera.position.copy(detail.position);
  camera.lookAt(detail.target.position);
  camera.updateMatrixWorld();
  const local = center.clone().applyMatrix4(camera.matrixWorldInverse);
  camera.left = local.x - SUN_DETAIL_WIDTH / 2;
  camera.right = local.x + SUN_DETAIL_WIDTH / 2;
  camera.bottom = local.y - SUN_DETAIL_WIDTH / 2;
  camera.top = local.y + SUN_DETAIL_WIDTH / 2;
  camera.near = -local.z - SUN_DETAIL_DEPTH / 2;
  camera.far = -local.z + SUN_DETAIL_DEPTH / 2;
  camera.updateProjectionMatrix();
}
