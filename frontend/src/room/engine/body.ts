// The visitor's body in the chair. The room panoramas are captured from the
// seat with nobody sitting in it, and by day the brightest thing in them is
// the doorway behind the chair (the bake's day fill), several times the
// sky's light. A real visitor's chest and shoulders stand between that
// doorway and their hands, the keyboard and the mouse; without them the
// doorway lights the hands head-on from the camera's side, which flattens
// them (the backs, the sides and the undersides of the fingers all
// equally bright), lights every knuckle facing the seat like a lamp, and
// puts a pale sheen of the doorway around each finger's silhouette. The
// body is a sphere around the chest, between the shoulders the sleeves end
// at: where it covers the view of a surface, that surface sees the body's
// own dark clothes, lit from the desk side, instead of the room behind it.
// For the materials of the realtime objects near the seat (skin.ts,
// contact.ts); needs the room's prefiltered panorama as `envMap`.

// Centre (xyz) and radius (w) in metres: the chest below the eye, leaning
// over the desk, its front (z 0.34) a hand's breadth ahead of the
// shoulders the sleeves end at (y 1.05, z 0.45).
const BODY = 'vec4( 0.0, 0.95, 0.56, 0.22 )';

export const BODY_GLSL = /* glsl */ `
#if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
  // The sleeves' charcoal knit.
  const float BODY_ALBEDO = 0.06;
  // How the irradiance at a surface changes (it drops) with the body in
  // the chair: the cosine-weighted solid angle it covers, times the room's
  // radiance from there (blurred over about the body's width) traded for
  // the clothes' own.
  vec3 bodyIrradiance( const in vec3 worldPosition, const in vec3 worldNormal ) {
    vec4 body = ${BODY};
    vec3 toBody = body.xyz - worldPosition;
    float distanceSq = dot( toBody, toBody );
    vec3 toward = toBody * inversesqrt( distanceSq );
    float cover = min( body.w * body.w / distanceSq, 1.0 ) * saturate( dot( worldNormal, toward ) );
    vec3 behind = textureCubeUV( envMap, envMapRotation * toward, 0.6 ).rgb;
    vec3 clothes = BODY_ALBEDO * textureCubeUV( envMap, envMapRotation * -toward, 1.0 ).rgb;
    return PI * envMapIntensity * cover * ( clothes - behind );
  }
  // The share of a reflection, spread over a cone of half-angle \`cone\`
  // around the mirror direction, that shows the (dark) body.
  float bodyReflection( const in vec3 worldPosition, const in vec3 mirror, const in float cone ) {
    vec4 body = ${BODY};
    vec3 toBody = body.xyz - worldPosition;
    float distance = length( toBody );
    float angularRadius = asin( min( body.w / distance, 1.0 ) );
    float apart = acos( clamp( dot( mirror, toBody / distance ), -1.0, 1.0 ) );
    float share = min( angularRadius * angularRadius / ( cone * cone ), 1.0 );
    return share * ( 1.0 - smoothstep( max( angularRadius - cone, 0.0 ), angularRadius + cone, apart ) );
  }
#endif`;
