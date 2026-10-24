/* ============================================================
   post.js — post-processing: bloom + one composite pass (grade, vignette, grain, chromatic aberration)
   ------------------------------------------------------------
   Core three only (WebGLRenderTarget + ShaderMaterial), no addons: nothing to vendor, works from file://.

   Pipeline
     1. scene (and the first-person viewmodel) render into one half-float target — linear HDR,
        no tone mapping yet (three only tone-maps when drawing to the default framebuffer).
     2. bloom: a soft-knee threshold well above any lit surface (only lamp heads and emissives exceed it),
        then a dual-filter down/up chain over 6 mip levels at ½…1/64 resolution. Wide radius, low intensity:
        the goal is air glowing around a lamp, not neon.
     3. composite (one full-screen pass): add bloom in linear light → exposure + ACES via three's own
        tonemapping_fragment (identical to the non-post path) → a single gentle grade curve (replaces the CSS
        #grade overlay) → mild optical vignette (replaces the CSS #vignette veil) → sRGB via colorspace_fragment
        → ±½ LSB dither (breaks 8-bit banding in the sky) → very light grain and lateral chromatic aberration.
        Edges are anti-aliased in the same pass (FXAA on tone-compressed luma) instead of MSAA on the HDR target.
   Grain is seeded from simulation time, never the wall clock, so ?test=1 stays deterministic.
   Under prefers-reduced-motion, grain and chromatic aberration are off (they are the only time-varying parts).
   ?nopost disables the whole thing: the renderer draws straight to the screen as before and the CSS layers stay.
   ============================================================ */
import * as THREE from 'three';

const FULLSCREEN_VS = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }`;

/* soft-knee threshold + 13-tap downsample of the HDR scene into the first bloom level */
const PREFILTER_FS = `
uniform sampler2D tSrc; uniform vec2 texel; uniform float threshold; uniform float knee;
varying vec2 vUv;
vec3 tap( vec2 o ) { return texture2D( tSrc, vUv + o * texel ).rgb; }
void main() {
  vec3 c = tap( vec2( 0.0 ) ) * 0.25
    + ( tap( vec2( -1.0, -1.0 ) ) + tap( vec2( 1.0, -1.0 ) ) + tap( vec2( -1.0, 1.0 ) ) + tap( vec2( 1.0, 1.0 ) ) ) * 0.125
    + ( tap( vec2( -2.0, 0.0 ) ) + tap( vec2( 2.0, 0.0 ) ) + tap( vec2( 0.0, -2.0 ) ) + tap( vec2( 0.0, 2.0 ) ) ) * 0.0625;
  float br = max( c.r, max( c.g, c.b ) );
  float soft = clamp( br - threshold + knee, 0.0, 2.0 * knee );
  soft = soft * soft / ( 4.0 * knee + 1e-4 );
  float w = max( soft, br - threshold ) / max( br, 1e-4 );
  gl_FragColor = vec4( c * w, 1.0 );
}`;

/* dual-filter (Kawase-style) down and up samples */
const DOWN_FS = `
uniform sampler2D tSrc; uniform vec2 texel; varying vec2 vUv;
void main() {
  vec3 c = texture2D( tSrc, vUv ).rgb * 4.0;
  c += texture2D( tSrc, vUv + vec2( -1.0, -1.0 ) * texel ).rgb;
  c += texture2D( tSrc, vUv + vec2( 1.0, -1.0 ) * texel ).rgb;
  c += texture2D( tSrc, vUv + vec2( -1.0, 1.0 ) * texel ).rgb;
  c += texture2D( tSrc, vUv + vec2( 1.0, 1.0 ) * texel ).rgb;
  gl_FragColor = vec4( c / 8.0, 1.0 );
}`;
const UP_FS = `
uniform sampler2D tSrc; uniform sampler2D tBase; uniform vec2 texel; varying vec2 vUv;
void main() {
  vec3 c = vec3( 0.0 );
  c += texture2D( tSrc, vUv + vec2( -2.0, 0.0 ) * texel ).rgb;
  c += texture2D( tSrc, vUv + vec2( 2.0, 0.0 ) * texel ).rgb;
  c += texture2D( tSrc, vUv + vec2( 0.0, -2.0 ) * texel ).rgb;
  c += texture2D( tSrc, vUv + vec2( 0.0, 2.0 ) * texel ).rgb;
  c += texture2D( tSrc, vUv + vec2( -1.0, -1.0 ) * texel ).rgb * 2.0;
  c += texture2D( tSrc, vUv + vec2( 1.0, -1.0 ) * texel ).rgb * 2.0;
  c += texture2D( tSrc, vUv + vec2( -1.0, 1.0 ) * texel ).rgb * 2.0;
  c += texture2D( tSrc, vUv + vec2( 1.0, 1.0 ) * texel ).rgb * 2.0;
  gl_FragColor = vec4( c / 12.0 + texture2D( tBase, vUv ).rgb, 1.0 );
}`;

const COMPOSITE_FS = `
uniform sampler2D tScene; uniform sampler2D tBloom;
uniform float bloomStrength; uniform float vignette; uniform float grain; uniform float aberration;
uniform float seed; uniform vec2 resolution;
varying vec2 vUv;

/* integer hash → [0,1): stable across GPUs, no sin() precision artefacts */
float hash( vec2 p ) {
  uvec2 q = uvec2( ivec2( p ) ) * uvec2( 1597334673u, 3812015801u );
  uint n = ( q.x ^ q.y ) * 1597334673u;
  return float( n ) * ( 1.0 / 4294967296.0 );
}

/* Grade: one gentle curve applied after ACES in linear display space.
   · a slight toe lift (black point 0.4% linear ≈ sRGB 12): the deepest shadows keep a little separation
     instead of clipping, without turning milky
   · a mild midtone contrast around 0.18 linear so the image doesn't go flat after the lift
   · a gentle highlight rolloff above ~0.8 luminance, like a film shoulder: lamp cores go towards white
     rather than saturated orange. Everything below that keeps its saturation.
   No hue shifts — the colour temperature comes from the lights (sodium vs sky), not from the grade. */
vec3 grade( vec3 c ) {
  c = c * 0.996 + 0.004 * ( 1.0 - c );
  vec3 l = log2( max( c, 1e-5 ) / 0.18 );
  c = 0.18 * exp2( l * 1.07 );
  float luma = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  c = mix( c, vec3( luma ), smoothstep( 0.8, 1.3, luma ) * 0.25 );
  return clamp( c, 0.0, 1.0 );
}

/* luma of a tone-compressed sample: edge detection must not be dominated by HDR lamp values */
float L( vec3 c ) { c = c / ( 1.0 + c ); return dot( c, vec3( 0.299, 0.587, 0.114 ) ); }
vec3 S( vec2 uv ) { return texture2D( tScene, uv ).rgb; }

/* Edge anti-aliasing (FXAA, console variant, 9 taps) on the HDR scene.
   4× MSAA on a half-float target cost +36% frame time under swiftshader against the no-post path; this costs a
   few percent and keeps edges, lamp poles and container seams clean. */
vec3 fxaa( vec2 uv, vec2 texel ) {
  vec3 rgbM = S( uv );
  float lNW = L( S( uv + vec2( -1.0, -1.0 ) * texel ) ), lNE = L( S( uv + vec2( 1.0, -1.0 ) * texel ) );
  float lSW = L( S( uv + vec2( -1.0, 1.0 ) * texel ) ), lSE = L( S( uv + vec2( 1.0, 1.0 ) * texel ) );
  float lM = L( rgbM );
  float lMin = min( lM, min( min( lNW, lNE ), min( lSW, lSE ) ) );
  float lMax = max( lM, max( max( lNW, lNE ), max( lSW, lSE ) ) );
  if ( lMax - lMin < max( 0.0312, lMax * 0.125 ) ) return rgbM;   // no edge: leave untouched
  vec2 dir = vec2( -( ( lNW + lNE ) - ( lSW + lSE ) ), ( lNW + lSW ) - ( lNE + lSE ) );
  float reduce = max( ( lNW + lNE + lSW + lSE ) * 0.03125, 1.0 / 128.0 );
  dir = clamp( dir / ( min( abs( dir.x ), abs( dir.y ) ) + reduce ), -8.0, 8.0 ) * texel;
  vec3 a = 0.5 * ( S( uv + dir * ( 1.0 / 3.0 - 0.5 ) ) + S( uv + dir * ( 2.0 / 3.0 - 0.5 ) ) );
  vec3 b = a * 0.5 + 0.25 * ( S( uv - dir * 0.5 ) + S( uv + dir * 0.5 ) );
  float lB = L( b );
  return ( lB < lMin || lB > lMax ) ? a : b;
}

void main() {
  vec2 texel = 1.0 / resolution;
  vec3 hdr = fxaa( vUv, texel );
  /* lateral chromatic aberration: red and blue sampled slightly in/out along the radius (≤ ~1.5 px at the corners).
     It replaces the anti-aliased red/blue only where the shift is a sizeable fraction of a pixel (the periphery). */
  if ( aberration > 0.0 ) {
    vec2 d = ( vUv - 0.5 ) * aberration;
    float w = clamp( length( d * resolution ) - 0.25, 0.0, 1.0 );
    hdr.r = mix( hdr.r, texture2D( tScene, vUv - d ).r, w );
    hdr.b = mix( hdr.b, texture2D( tScene, vUv + d ).b, w );
  }
  hdr += texture2D( tBloom, vUv ).rgb * bloomStrength;

  gl_FragColor = vec4( hdr, 1.0 );
  #include <tonemapping_fragment>
  vec3 c = grade( gl_FragColor.rgb );

  /* optical vignette (cos^4-like falloff), far lighter than the old CSS veil */
  vec2 v = ( vUv - 0.5 ) * vec2( resolution.x / resolution.y, 1.0 );
  c *= 1.0 - vignette * smoothstep( 0.35, 1.05, dot( v, v ) * 1.6 );

  /* film grain: luminance-weighted (more visible in the midtones, nearly none in deep shadow or highlights) */
  float g = hash( gl_FragCoord.xy + seed * 113.0 ) - 0.5;
  float lw = dot( c, vec3( 0.333 ) );
  c += g * grain * 4.0 * lw * ( 1.0 - lw );

  gl_FragColor = vec4( c, 1.0 );
  #include <colorspace_fragment>
  /* ±½ LSB triangular dither after encoding: hides 8-bit banding in the smooth sky gradient */
  float dz = hash( gl_FragCoord.yx + 7.0 ) + hash( gl_FragCoord.xy + 19.0 ) - 1.0;
  gl_FragColor.rgb += dz / 255.0;
}`;

export class Post {
  constructor(renderer) {
    this.renderer = renderer;
    this.enabled = true;
    /* the only tuning: strength of the glow, size of the vignette, amplitude of grain and aberration */
    this.params = { threshold: 1.35, knee: 0.5, bloom: 0.22, vignette: 0.22, grain: 0.035, aberration: 0.0016 };
    this.reducedMotion = false;
    try {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.reducedMotion = mq.matches;
      if (mq.addEventListener) mq.addEventListener('change', (e) => { this.reducedMotion = e.matches; });
    } catch (e) { /* matchMedia unavailable: keep motion effects on */ }

    const hdr = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false };
    /* no MSAA here: edges are anti-aliased in the composite pass (see fxaa()) */
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, { ...hdr, depthBuffer: true });
    this.levels = [];
    for (let i = 0; i < 6; i++) {
      this.levels.push({
        down: new THREE.WebGLRenderTarget(1, 1, hdr),
        up: new THREE.WebGLRenderTarget(1, 1, hdr),
      });
    }

    const mk = (fs, uniforms, extra = {}) => new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VS, fragmentShader: fs, uniforms,
      depthTest: false, depthWrite: false, toneMapped: false, ...extra,
    });
    this.prefilter = mk(PREFILTER_FS, {
      tSrc: { value: null }, texel: { value: new THREE.Vector2() },
      threshold: { value: this.params.threshold }, knee: { value: this.params.knee },
    });
    this.down = mk(DOWN_FS, { tSrc: { value: null }, texel: { value: new THREE.Vector2() } });
    this.up = mk(UP_FS, { tSrc: { value: null }, tBase: { value: null }, texel: { value: new THREE.Vector2() } });
    this.composite = mk(COMPOSITE_FS, {
      tScene: { value: this.sceneRT.texture }, tBloom: { value: null },
      bloomStrength: { value: this.params.bloom }, vignette: { value: this.params.vignette },
      grain: { value: this.params.grain }, aberration: { value: this.params.aberration },
      seed: { value: 0 }, resolution: { value: new THREE.Vector2(1, 1) },
    }, { toneMapped: true });

    /* one full-screen triangle, reused by every pass */
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.quad = new THREE.Mesh(geo, this.composite);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._size = new THREE.Vector2();
  }

  setSize() {
    const s = this.renderer.getDrawingBufferSize(this._size);
    const w = Math.max(1, s.x), h = Math.max(1, s.y);
    this.sceneRT.setSize(w, h);
    let lw = w, lh = h;
    for (const l of this.levels) {
      lw = Math.max(1, lw >> 1); lh = Math.max(1, lh >> 1);
      l.down.setSize(lw, lh); l.up.setSize(lw, lh);
    }
    this.composite.uniforms.resolution.value.set(w, h);
  }

  /* everything drawn between begin() and end() lands in the HDR scene target */
  begin() {
    const s = this.renderer.getDrawingBufferSize(this._size);
    if (s.x !== this.sceneRT.width || s.y !== this.sceneRT.height) this.setSize();
    this.renderer.setRenderTarget(this.sceneRT);
    this.renderer.clear(true, true, false);
  }

  _pass(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  /* simTime: simulation seconds (deterministic), used only to reseed grain each frame */
  end(simTime) {
    const r = this.renderer, P = this.params;
    const prevAutoClear = r.autoClear;
    r.autoClear = true;
    // bloom: prefilter into level 0, then down the chain, then back up accumulating
    const L = this.levels;
    this.prefilter.uniforms.tSrc.value = this.sceneRT.texture;
    this.prefilter.uniforms.texel.value.set(1 / this.sceneRT.width, 1 / this.sceneRT.height);
    this.prefilter.uniforms.threshold.value = P.threshold;
    this.prefilter.uniforms.knee.value = P.knee;
    this._pass(this.prefilter, L[0].down);
    for (let i = 1; i < L.length; i++) {
      this.down.uniforms.tSrc.value = L[i - 1].down.texture;
      this.down.uniforms.texel.value.set(1 / L[i - 1].down.width, 1 / L[i - 1].down.height);
      this._pass(this.down, L[i].down);
    }
    let src = L[L.length - 1].down;
    for (let i = L.length - 2; i >= 0; i--) {
      this.up.uniforms.tSrc.value = src.texture;
      this.up.uniforms.tBase.value = L[i].down.texture;
      this.up.uniforms.texel.value.set(1 / src.width, 1 / src.height);
      this._pass(this.up, L[i].up);
      src = L[i].up;
    }
    // composite to the screen
    const u = this.composite.uniforms;
    u.tBloom.value = src.texture;
    u.bloomStrength.value = P.bloom;
    u.vignette.value = P.vignette;
    const motion = !this.reducedMotion;
    u.grain.value = motion ? P.grain : 0;
    u.aberration.value = motion ? P.aberration : 0;
    u.seed.value = Math.floor(simTime * 60) % 997;
    this._pass(this.composite, null);
    r.autoClear = prevAutoClear;
  }

  dispose() {
    this.sceneRT.dispose();
    for (const l of this.levels) { l.down.dispose(); l.up.dispose(); }
    for (const m of [this.prefilter, this.down, this.up, this.composite]) m.dispose();
    this.quad.geometry.dispose();
  }
}
