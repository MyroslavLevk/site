/* Onboard-view simulation in three environments: a drone over farmland, a surface
   vessel at sea, a ground vehicle on a battlefield. No GPS in any of them: the platform
   classifies obstacles and routes around them. Requires global THREE (r128). */
(() => {
  const box = document.getElementById('game');
  const cv = document.getElementById('gameCanvas');
  const hud = document.getElementById('hudCanvas');
  const h2 = hud.getContext('2d');
  const el = (id) => document.getElementById(id);
  const spdEl = el('spd'), altEl = el('alt'), altBox = el('altBox'), objEl = el('obj'), distEl = el('dist'), modeEl = el('navMode');
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (a) => a[Math.floor(Math.random() * a.length)];

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, powerPreference: 'high-performance' });
  } catch (e) {
    el('hint').textContent = 'WebGL is not available on this device';
    return;
  }
  const DPR = Math.min(devicePixelRatio || 1, 1.75); // HUD canvas; the 3D view follows the quality level
  /* Quality levels. Phones and weak machines start lower; while the demo runs, the frame
     rate is measured and the level is stepped down (never up) if it stays low.
     dpr = render resolution cap, shadow = shadow map size (0 = none), density = share of
     scattered objects, litter = share of battlefield litter, fine = dense ground / water grids. */
  const QUALITY = [
    { dpr: 1, shadow: 0, density: 0.45, litter: 0.35, fine: false },
    { dpr: 1.25, shadow: 1024, density: 0.7, litter: 0.6, fine: false },
    { dpr: 1.75, shadow: 2048, density: 1, litter: 1, fine: true },
  ];
  const phone = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 600;
  const weak = (navigator.deviceMemory || 8) <= 2 || (navigator.hardwareConcurrency || 8) <= 2;
  let quality = weak ? 0 : phone ? 1 : 2, Q = QUALITY[quality];
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, Q.dpr));
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x000000, 0.014);
  const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 600);
  scene.add(camera);

  /* ----- light: sun / moon with shadows, sky fill (no onboard light: the platform runs dark) ----- */
  const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1);
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.position.set(-30, 45, 5);
  sun.target.position.set(0, 0, -30);
  sun.castShadow = true;
  // shadows are drawn only close by (the box), far objects are not rendered into the shadow map at all
  sun.castShadow = Q.shadow > 0;
  sun.shadow.mapSize.set(Q.shadow || 1024, Q.shadow || 1024);
  Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 32, bottom: -32, near: 1, far: 140 });
  sun.shadow.bias = -0.0006;
  scene.add(hemi, sun, sun.target);

  /* ----- sky dome: vertical gradient, haze at the horizon and a glow around the sun / moon.
     Everything in the sky rides along with the camera, so it never comes closer. ----- */
  const skyGroup = new THREE.Group();
  scene.add(skyGroup);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      top: { value: new THREE.Color() }, bottom: { value: new THREE.Color() },
      glowCol: { value: new THREE.Color() }, glowDir: { value: new THREE.Vector3(0, 1, 0) },
    },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 bottom; uniform vec3 glowCol; uniform vec3 glowDir; varying vec3 vDir;
      void main(){
        vec3 c = mix(bottom, top, pow(max(vDir.y, 0.0), 0.38));
        float d = max(dot(normalize(vDir), glowDir), 0.0);
        c += glowCol * (pow(d, 12.0) * 0.16 + pow(d, 90.0) * 0.4) * smoothstep(-0.05, 0.1, vDir.y);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <encodings_fragment>
      }`,
  });
  skyGroup.add(new THREE.Mesh(new THREE.SphereGeometry(450, 32, 16), skyMat));

  // soft round sprite used for every glow in the scene
  const glowTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.25, 'rgba(255,255,255,.5)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  const glow = (color, size) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    s.scale.setScalar(size);
    return s;
  };

  /* ----- clouds: a second, nearer dome in front of the stars, sun and moon, its clouds made in
     the shader from layered value noise on a flat sky plane, drifting slowly. They are grey and
     heavier over the battlefield, dark at night with a silver edge towards the moon, and a
     shell flash on the horizon lights the cloud bases above it. ----- */
  const cloudMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, transparent: true, depthWrite: false, fog: false,
    uniforms: {
      uTime: { value: 0 }, uCover: { value: 0.5 }, uLit: { value: new THREE.Color() }, uShade: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color() },
      uFlashDir: { value: new THREE.Vector3(0, 0, -1) }, uFlash: { value: new THREE.Color(0, 0, 0) },
    },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `precision highp float;
      uniform float uTime; uniform float uCover; uniform vec3 uLit; uniform vec3 uShade; uniform vec3 uSunDir; uniform vec3 uSunCol;
      uniform vec3 uFlashDir; uniform vec3 uFlash; varying vec3 vDir;
      float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
      float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < ${quality === 2 ? 5 : 4}; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; } return v; }
      void main(){
        vec3 d = normalize(vDir);
        if (d.y <= 0.0) discard;
        vec2 p = d.xz / (d.y + 0.12) * 1.3 + vec2(uTime * 0.012, uTime * 0.004);
        float n = fbm(p), n2 = fbm(p * 1.9 + 3.7 + uTime * 0.006);
        float a = smoothstep(uCover, uCover + 0.28, n) * smoothstep(0.0, 0.22, d.y);
        float thick = smoothstep(uCover, uCover + 0.5, n * 0.7 + n2 * 0.3);
        vec3 col = mix(uLit, uShade, thick);
        col += uSunCol * pow(max(dot(d, uSunDir), 0.0), 6.0) * (1.0 - thick) * 0.7;   // thin edges glow towards the light
        col += uFlash * pow(max(dot(d, uFlashDir), 0.0), 5.0) * smoothstep(0.45, 0.0, d.y);
        gl_FragColor = vec4(col, a * 0.94);
        #include <tonemapping_fragment>
        #include <encodings_fragment>
      }`,
  });
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(330, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), cloudMat);
  clouds.renderOrder = -1; // drawn after the stars, the sun and the moon (-2), so it passes in front of them
  skyGroup.add(clouds);
  /* ----- the far distance: two rings of low, ragged silhouettes (tree lines, a roof, a mast) that
     ride with the sky, sunk in the haze, so the land does not end in a ruler-straight horizon.
     Each is darker at the foot and fades into the fog colour at the top; not used at sea. ----- */
  const farMat = new THREE.ShaderMaterial({
    fog: false,
    uniforms: { uFog: { value: new THREE.Color() }, uTone: { value: new THREE.Color() }, uMix: { value: 0.3 } },
    vertexShader: 'attribute float aT; varying float vT; void main(){ vT = aT; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 uFog; uniform vec3 uTone; uniform float uMix; varying float vT;
      void main(){ gl_FragColor = vec4(mix(uFog, uTone, uMix * (1.0 - vT * 0.55)), 1.0);
        #include <tonemapping_fragment>
        #include <encodings_fragment>
      }`,
  });
  const farRing = (r, base, seed, mix) => {
    const N = 900, pos = [], t = [], idx = [];
    let h = base;
    for (let i = 0; i <= N; i++) {
      const a = i / N * Math.PI * 2;
      // rolling outline with tree-crown bumps, now and then a gap or a taller block
      const hill = base + 3 * Math.sin(a * 3 + seed) + 2 * Math.sin(a * 7 + seed * 2) + 1.2 * Math.sin(a * 17 + seed * 3);
      h += (hill + rand(-1.5, 1.5) - h) * 0.35;
      // crowns: every vertex a little up or down; here and there a tall dead tree, a roof, a gap
      const top = Math.max(0.5, h + rand(-0.8, 1.6) + (Math.random() < 0.03 ? rand(3, 7) : 0) - (Math.random() < 0.05 ? h * 0.75 : 0));
      const x = Math.sin(a) * r, z = -Math.cos(a) * r;
      pos.push(x, -40, z, x, top, z);
      t.push(0, 1);
      if (i < N) { const k = i * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aT', new THREE.Float32BufferAttribute(t, 1));
    g.setIndex(idx);
    const m = new THREE.Mesh(g, farMat.clone());
    m.material.uniforms.uMix.value = mix;
    m.material.side = THREE.DoubleSide;
    m.frustumCulled = false;
    return m;
  };
  const farRings = [farRing(300, 7, 1.3, 0.2), farRing(245, 4.5, 4.1, 0.36)];
  farRings.forEach((m) => skyGroup.add(m));

  // look of the clouds per environment: [cover threshold by day, at night] - lower = more cloud
  const CLOUD = { air: [0.32, 0.42], sea: [0.32, 0.42], ground: [0.3, 0.4] }; // overcast over the front

  /* ----- stars, sun, moon ----- */
  const starField = (n, size) => {
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, e = rand(0.04, 1.4);
      pos.set([Math.cos(a) * Math.cos(e) * 400, Math.sin(e) * 400, Math.sin(a) * Math.cos(e) * 400], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size, sizeAttenuation: false, fog: false }));
  };
  const stars = new THREE.Group();
  stars.add(starField(900, 1.2), starField(110, 2.2));
  const SKY_POS = new THREE.Vector3(-90, 95, -380); // where the sun or the moon stands
  const disc = new THREE.Mesh(new THREE.SphereGeometry(7, 24, 16), new THREE.MeshBasicMaterial({ fog: false }));
  disc.position.copy(SKY_POS);
  const halo = glow(0xffffff, 55);
  halo.position.copy(SKY_POS); // its own object, so it can stay when the disc is hidden behind cloud

  // the moon: a waxing gibbous drawn on a canvas - maria, craters, darker limb, soft terminator
  const moonTex = (() => {
    const N = 256, R = N / 2 - 3, c = document.createElement('canvas');
    c.width = c.height = N;
    const g = c.getContext('2d');
    const blob = (x, y, r, col) => {
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, col); grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    };
    g.save();
    g.beginPath(); g.arc(N / 2, N / 2, R, 0, Math.PI * 2); g.clip();
    g.fillStyle = '#e4e1d8'; g.fillRect(0, 0, N, N);
    // maria, roughly where they are on the near side
    [[0.36, 0.3, 0.2], [0.52, 0.36, 0.13], [0.6, 0.52, 0.12], [0.42, 0.52, 0.15], [0.28, 0.46, 0.11],
      [0.68, 0.36, 0.08], [0.47, 0.68, 0.1], [0.24, 0.62, 0.09]]
      .forEach(([x, y, r]) => { blob(x * N, y * N, r * N, 'rgba(92,94,104,.55)'); blob(x * N + 6, y * N - 4, r * N * 0.6, 'rgba(80,82,92,.35)'); });
    for (let i = 0; i < 90; i++) {                       // craters: dark floor, lit rim towards the sun
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * R * 0.95, r = Math.pow(Math.random(), 2.2) * 8 + 1.2;
      const x = N / 2 + Math.cos(a) * d, y = N / 2 + Math.sin(a) * d;
      g.fillStyle = 'rgba(40,40,46,.18)'; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(255,255,250,.22)'; g.lineWidth = Math.max(0.8, r * 0.25);
      g.beginPath(); g.arc(x, y, r, -Math.PI * 0.2, Math.PI * 0.7); g.stroke();
    }
    g.strokeStyle = 'rgba(255,255,250,.12)'; g.lineWidth = 1;    // rays of a young crater near the south
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2, l = rand(18, 60);
      g.beginPath(); g.moveTo(N * 0.45, N * 0.83); g.lineTo(N * 0.45 + Math.cos(a) * l, N * 0.83 + Math.sin(a) * l); g.stroke();
    }
    blob(N * 0.45, N * 0.83, 6, 'rgba(255,255,250,.7)');
    const limb = g.createRadialGradient(N / 2, N / 2, R * 0.55, N / 2, N / 2, R);
    limb.addColorStop(0, 'rgba(0,0,0,0)'); limb.addColorStop(1, 'rgba(10,12,20,.4)');
    g.fillStyle = limb; g.fillRect(0, 0, N, N);
    // night side: the left edge, bounded by a half-ellipse terminator, blurred
    g.filter = 'blur(3px)';
    g.fillStyle = 'rgba(6,8,16,.94)';
    g.beginPath();
    g.arc(N / 2, N / 2, R + 4, Math.PI / 2, Math.PI * 1.5);
    g.ellipse(N / 2, N / 2, R * 0.62, R + 4, 0, Math.PI * 1.5, Math.PI / 2, true);
    g.fill();
    g.restore();
    const t = new THREE.CanvasTexture(c);
    t.encoding = THREE.sRGBEncoding;
    return t;
  })();
  const moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: moonTex, transparent: true, depthWrite: false, fog: false }));
  moon.scale.setScalar(19);
  moon.position.copy(SKY_POS);
  const moonHalo = glow(0x1c2238, 60);
  moonHalo.position.copy(SKY_POS).multiplyScalar(1.01);
  skyGroup.add(stars, disc, halo, moonHalo, moon);
  moon.renderOrder = moonHalo.renderOrder = halo.renderOrder = -2; // drawn before the clouds, which pass in front
  // light comes from behind-left by day, from the moon at night (so the water shows its path)
  const LIGHT = { day: new THREE.Vector3(-30, 45, 35).normalize(), night: SKY_POS.clone().sub(new THREE.Vector3(0, 0, -30)).normalize() };
  let lightDir = LIGHT.day;

  // reference points the navigator "locks" onto, drawn in the HUD
  const navStars = [[-0.42, 0.34, -1], [0.08, 0.52, -1], [0.5, 0.3, -1]]
    .map((d) => new THREE.Vector3(...d).normalize().multiplyScalar(400));
  navStars.forEach((p) => { const s = glow(0xcfe0ff, 14); s.position.copy(p); stars.add(s); });

  /* ----- terrain: gentle rolling ground, the same function on the CPU (to stand objects
     and the camera on it) and in the ground shader. x across, s along the route.
     On the battlefield it also gets small bumps and shell craters (bowl + raised rim). ----- */
  let terrA = 0, bumpA = 0; // relief and bump amplitude of the current environment, 0 at sea
  /* Far off the ground grid is coarse (see groundGrid) and cannot show a crater: drawn there it
     comes out flatter than the relief, and stones lying on its rim hang in the air. So craters
     (and the small bumps) are dug only as they come into the fine part of the grid: flat beyond CR_FAR metres ahead,
     full depth at CR_NEAR, and the litter on them is re-seated meanwhile (see updateLitter).
     The dark scorch of a crater is drawn at any distance. CR_SIDE = how far from the track they fall. */
  const CR_N = 60, CR_RAND = 52, CR_NEAR = 42, CR_FAR = 66, CR_SIDE = 28; // craters[CR_RAND..] are big pits (see bigPit)
  const crFade = (s) => { const t = clamp((CR_FAR - (s - dist)) / (CR_FAR - CR_NEAR), 0, 1); return t * t * (3 - 2 * t); };
  const craters = Array.from({ length: CR_N }, () => new THREE.Vector4(0, -1e6, 1, 0)); // x, s, radius, depth
  // full = craters at their final depth whatever the distance (used to stand objects)
  // the lie of the land alone: what a drone holds its height over (it does not drop into every crater)
  const reliefH = (x, s) => terrA * (0.55 * Math.sin(0.021 * x + 0.6) * Math.sin(0.017 * s + 1.1)
    + 0.3 * Math.sin(0.047 * x - 0.033 * s + 2) + 0.15 * Math.sin(0.09 * x + 0.071 * s));
  const terrainH = (x, s, full) => {
    let h = reliefH(x, s);
    if (!bumpA) return h;
    const f = full ? 1 : crFade(s);
    if (!f) return h;
    h += f * bumpA * (0.5 * Math.sin(0.55 * x + 0.3 * s) * Math.sin(0.47 * s - 0.2 * x + 1.3)
      + 0.3 * Math.sin(1.1 * x - 0.9 * s + 0.5) + 0.2 * Math.sin(1.7 * x + 1.3 * s + 2.1));
    for (const c of craters) {
      const q = ((x - c.x) ** 2 + (s - c.y) ** 2) / (c.z * c.z);
      if (q < 3) h += f * c.w * (-Math.max(0, 1 - q) + 0.35 * Math.exp(-(((Math.sqrt(q) - 1.05) / 0.2) ** 2)));
    }
    return h;
  };
  const TERRAIN_GLSL = `uniform float uTerrA; uniform float uBump; uniform vec4 uCr[${CR_N}];
    float terrainH(vec2 p){
      float h = uTerrA * (0.55 * sin(0.021 * p.x + 0.6) * sin(0.017 * p.y + 1.1)
        + 0.3 * sin(0.047 * p.x - 0.033 * p.y + 2.0) + 0.15 * sin(0.09 * p.x + 0.071 * p.y));
      if (uBump == 0.0) return h;
      float f = smoothstep(${CR_FAR}.0, ${CR_NEAR}.0, p.y - uDist);
      h += f * uBump * (0.5 * sin(0.55 * p.x + 0.3 * p.y) * sin(0.47 * p.y - 0.2 * p.x + 1.3)
        + 0.3 * sin(1.1 * p.x - 0.9 * p.y + 0.5) + 0.2 * sin(1.7 * p.x + 1.3 * p.y + 2.1));
      for (int i = 0; i < ${CR_N}; i++) {
        vec2 d = (p - uCr[i].xy) / uCr[i].z;
        float q = dot(d, d);
        if (q < 3.0) h += f * uCr[i].w * (-max(0.0, 1.0 - q) + 0.35 * exp(-pow((sqrt(q) - 1.05) / 0.2, 2.0)));
      }
      return h;
    }`;
  // shared by the ground and water shaders
  const U = {
    dist: { value: 0 }, time: { value: 0 }, terrA: { value: 0 }, amp: { value: 1 }, bump: { value: 0 }, cr: { value: craters },
    dry: { value: new THREE.Vector3(1, 1, 1) }, roadS0: { value: 0 }, roadOn: { value: 0 },
    ash: { value: new THREE.Vector4(-1e6, -1e6, -1e6, -1e6) }, refl: { value: new THREE.Color() }, wet: { value: 1 },
    deep: { value: new THREE.Color() }, shallow: { value: new THREE.Color() }, foam: { value: new THREE.Color() },
  };

  /* ----- the dirt road on the battlefield: a smoothed copy of the route (the vehicle keeps to it
     and leaves it only to get round something), drawn by the ground shader with wheel ruts and
     puddles. Its centre line, 1 m a texel from ROAD_BACK metres behind, is packed into a small
     texture (x as 16 bits in two channels), refreshed whenever a metre has been driven. ----- */
  const ROAD_N = 256, ROAD_BACK = 20, ROAD_SPAN = 400;
  const roadData = new Uint8Array(ROAD_N * 4);
  const roadTex = new THREE.DataTexture(roadData, ROAD_N, 1, THREE.RGBAFormat);
  roadTex.magFilter = roadTex.minFilter = THREE.NearestFilter;
  const ROAD_GLSL = `uniform sampler2D uRoad; uniform float uRoadS0; uniform float uRoadOn;
    float roadAt(float i){ vec4 t = texture2D(uRoad, vec2((i + 0.5) / ${ROAD_N}.0, 0.5));
      return (t.r * 255.0 * 256.0 + t.g * 255.0) / 65535.0 * ${ROAD_SPAN}.0 - ${ROAD_SPAN / 2}.0; }
    float roadX(float s){ float t = s - uRoadS0; if (uRoadOn == 0.0 || t < 0.0 || t > ${ROAD_N - 2}.0) return 1e4;
      float i = floor(t); return mix(roadAt(i), roadAt(i + 1.0), t - i); }`;

  /* ----- ground: grass / soil detail, large-scale patches against tiling, relief ----- */
  const tileCanvas = (N, paint) => {
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const g = c.getContext('2d');
    // draw with 3x3 wrap-around so the tile is seamless
    const wrap = (fn) => { for (const ox of [-N, 0, N]) for (const oy of [-N, 0, N]) { g.save(); g.translate(ox, oy); fn(g); g.restore(); } };
    paint(g, wrap, N);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  };
  const groundTex = tileCanvas(256, (g, wrap, N) => {
    g.fillStyle = '#e8e8e8'; g.fillRect(0, 0, N, N);
    for (let i = 0; i < 40; i++) {                       // clumps and bare patches
      const x = rand(0, N), y = rand(0, N), r = rand(8, 28), a = rand(0.05, 0.14), lit = Math.random() < 0.4;
      wrap((c) => {
        const grd = c.createRadialGradient(x, y, 0, x, y, r);
        grd.addColorStop(0, lit ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`); grd.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = grd; c.fillRect(x - r, y - r, r * 2, r * 2);
      });
    }
    for (let i = 0; i < 2600; i++) {                     // specks
      const x = rand(0, N), y = rand(0, N), s = rand(1, 3.5), a = rand(0.05, 0.35);
      wrap((c) => { c.fillStyle = `rgba(0,0,0,${a})`; c.fillRect(x, y, s, s); });
    }
    g.lineWidth = 1;
    for (let i = 0; i < 1400; i++) {                     // blades
      const x = rand(0, N), y = rand(0, N), l = rand(2, 6), a = rand(-0.5, 0.5), lit = Math.random() < 0.5;
      wrap((c) => {
        c.strokeStyle = lit ? 'rgba(255,255,255,.22)' : 'rgba(0,0,0,.2)';
        c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.sin(a) * l, y - Math.cos(a) * l); c.stroke();
      });
    }
  });
  groundTex.anisotropy = 8;
  const macroTex = tileCanvas(128, (g, wrap, N) => {   // smooth low-frequency noise
    g.fillStyle = '#808080'; g.fillRect(0, 0, N, N);
    for (let i = 0; i < 70; i++) {
      const x = rand(0, N), y = rand(0, N), r = rand(10, 40), a = rand(0.15, 0.35), lit = Math.random() < 0.5;
      wrap((c) => {
        const grd = c.createRadialGradient(x, y, 0, x, y, r);
        grd.addColorStop(0, lit ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`); grd.addColorStop(1, 'rgba(128,128,128,0)');
        c.fillStyle = grd; c.fillRect(x - r, y - r, r * 2, r * 2);
      });
    }
  });
  const TILE = 9; // world units per detail tile
  const groundMat = new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1 });
  groundMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uDist: U.dist, uTerrA: U.terrA, uBump: U.bump, uCr: U.cr, uDry: U.dry, uMacro: { value: macroTex },
      uRoad: { value: roadTex }, uRoadS0: U.roadS0, uRoadOn: U.roadOn, uAsh: U.ash, uRefl: U.refl, uWet: U.wet });
    sh.vertexShader = 'uniform float uDist; varying vec2 vW;\n' + TERRAIN_GLSL + '\n' + sh.vertexShader
      .replace('#include <beginnormal_vertex>', `
        vec4 wp0 = modelMatrix * vec4(position, 1.0);
        vec2 P = vec2(wp0.x, uDist - wp0.z);
        float th = terrainH(P);
        vec3 objectNormal = normalize(vec3((th - terrainH(P + vec2(0.5, 0.0))) * 2.0, 1.0, (terrainH(P + vec2(0.0, 0.5)) - th) * 2.0));
        vW = P;`)
      .replace('#include <begin_vertex>', 'vec3 transformed = vec3(position.x, th, position.z);');
    sh.fragmentShader = `uniform sampler2D uMacro; uniform vec3 uDry; uniform float uBump; uniform vec4 uCr[${CR_N}]; varying vec2 vW; uniform vec4 uAsh; uniform vec3 uRefl; uniform float uWet;\n${ROAD_GLSL}\n` + sh.fragmentShader
      .replace('#include <map_fragment>', `
        vec3 det = texture2D(map, vW / ${TILE}.0).rgb;
        float mac = texture2D(uMacro, vW / 170.0).r, mac2 = texture2D(uMacro, vW / 53.0 + 0.37).r;
        diffuseColor.rgb *= det * mix(0.72, 1.18, mac);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * uDry, smoothstep(0.42, 0.72, mac2));
        float puddle = 0.0;
        if (uBump > 0.0) for (int i = 0; i < ${CR_N}; i++) {   // scorched, churned earth in and around each crater
          float d = length(vW - uCr[i].xy) / uCr[i].z;
          diffuseColor.rgb *= mix(1.0, 0.32 + 0.2 * det.r, (1.0 - smoothstep(0.4, 1.5, d)) * step(0.001, uCr[i].w));
          // rain water standing in the bottom of about half the craters
          puddle = max(puddle, (1.0 - smoothstep(0.3, 0.5, d)) * step(0.001, uCr[i].w) * step(0.5, fract(uCr[i].z * 7.31)));
        }
        if (uBump > 0.0) {
          // puddles in low spots of the field, and grey ash where the forest burnt
          puddle = max(puddle, smoothstep(0.66, 0.7, texture2D(uMacro, vW / vec2(29.0, 41.0) + 0.43).r) * 0.95 * uWet);
          float ash = max(smoothstep(uAsh.x - 15.0, uAsh.x + 10.0, vW.y) * (1.0 - smoothstep(uAsh.y - 10.0, uAsh.y + 15.0, vW.y)),
                          smoothstep(uAsh.z - 15.0, uAsh.z + 10.0, vW.y) * (1.0 - smoothstep(uAsh.w - 10.0, uAsh.w + 15.0, vW.y)));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11))) * vec3(0.62, 0.6, 0.6), ash * 0.85);
        }
        // the road: packed bare soil with ragged edges, two dark wet ruts, puddles in them
        float rd = abs(vW.x - roadX(vW.y));
        if (rd < 4.0) {
          float wob = texture2D(uMacro, vW / 11.0 + 0.6).r - 0.5;
          float road = 1.0 - smoothstep(1.6, 2.5, rd + wob * 1.2);
          vec3 soil = diffuseColor.rgb * vec3(1.18, 1.08, 0.95) * mix(1.0, 0.82 + 0.18 / max(det.r, 0.4), 0.6);
          diffuseColor.rgb = mix(diffuseColor.rgb, soil, road);
          float rut = (1.0 - smoothstep(0.06, 0.2, abs(rd - 0.85 + wob * 0.12))) * road;
          diffuseColor.rgb *= 1.0 - rut * 0.3;
          puddle = max(puddle, rut * smoothstep(0.62, 0.7, texture2D(uMacro, vW / vec2(9.0, 23.0) + 0.21).r));
        }
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.35 + vec3(0.02, 0.025, 0.03), puddle);`)
      // standing water mirrors the grey sky
      .replace('gl_FragColor = vec4( outgoingLight, diffuseColor.a );', 'float water = smoothstep(0.35, 0.65, puddle); float fres = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 4.0);\n outgoingLight = mix(outgoingLight, uRefl * vec3(0.92, 0.96, 1.0) * (0.16 + 0.62 * fres), water);\n gl_FragColor = vec4( outgoingLight, diffuseColor.a );')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, 0.12, puddle);');
  };
  /* The grid is even near the camera and grows coarser towards the horizon. It does not slide
     with the camera: it moves in whole cells (see snapGround), so near vertices always sit on
     the same points of the world. A grid that slides re-samples the relief every frame, and
     craters and bumps then wobble like jelly. */
  const gridAxis = (step, even, far, grow) => { // offsets 0..far: even steps up to `even`, then growing
    const a = [0];
    for (let x = 0, d = step; x < far; a.push(x += d)) if (x >= even) d *= grow;
    return a;
  };
  const groundGrid = (fine) => {
    const dx = fine ? 0.6 : 1, dz = fine ? 0.4 : 0.7;
    const side = gridAxis(dx, 30, 360, fine ? 1.08 : 1.12);
    const xs = [...side.slice(1).reverse().map((x) => -x), ...side];
    const zs = [...gridAxis(dz, 12, 40, 1.15).slice(1).reverse(), ...gridAxis(dz, fine ? 50 : 45, 480, fine ? 1.06 : 1.1).map((z) => -z)];
    const pos = new Float32Array(xs.length * zs.length * 3), idx = [];
    zs.forEach((z, j) => xs.forEach((x, i) => pos.set([x, 0, z], (j * xs.length + i) * 3)));
    for (let j = 0; j < zs.length - 1; j++) for (let i = 0; i < xs.length - 1; i++) {
      const a = j * xs.length + i, b = a + 1, c = a + xs.length, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(pos.map((v, i) => (i % 3 === 1 ? 1 : 0)), 3)); // replaced in the shader
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(xs.length * zs.length * 2), 2));
    g.setIndex(idx); // kept under 65536 vertices: 16-bit indices work on every GPU
    g.userData.cell = [dx, dz];
    return g;
  };
  const ground = new THREE.Mesh(groundGrid(Q.fine), groundMat);
  // follow the camera in whole cells (the shader reads the distance travelled from z)
  const snapGround = (cx) => {
    const [dx, dz] = ground.geometry.userData.cell;
    ground.position.x = Math.round(cx / dx) * dx;
    ground.position.z = dist - Math.floor(dist / dz) * dz;
  };
  ground.receiveShadow = true;
  ground.frustumCulled = false;
  scene.add(ground);

  /* ----- sea: a swell of four Gerstner wave trains computed on the GPU. Crests are
     sharpened by horizontal displacement, tinted where light passes through them and
     whitened with foam where they pinch. The same heights (vertical part) are computed
     on the CPU so the boat and the flotsam ride the very waves that are drawn. ----- */
  // direction (across, along), wavelength and amplitude in metres; speed follows deep-water dispersion
  const STEEP = 2.4; // Gerstner steepness: 0 = round sine swell, higher = sharper crests
  const WAVES = [[0.2, 1, 62, 0.55], [-0.45, 0.9, 35, 0.32], [0.7, 0.7, 19, 0.16], [-0.8, 0.55, 11, 0.08]].map(([dx, ds, L, a], i) => {
    const n = Math.hypot(dx, ds), k = Math.PI * 2 / L;
    return { kx: dx / n * k, ks: ds / n * k, w: Math.sqrt(9.81 * k), a, ph: i * 1.7 };
  });
  const AMP_SUM = WAVES.reduce((m, q) => m + q.a, 0);
  let seaAmp = 1; // sea state: 1 in open water, lower inside a sheltered harbour
  // wave height at world position (x across, s along the route) and time t
  const wave = (x, s, t) => {
    let h = 0;
    for (const q of WAVES) h += q.a * Math.sin(q.kx * x + q.ks * s + q.w * t + q.ph);
    return h * seaAmp;
  };
  const f6 = (n) => n.toFixed(6);
  const WAVE_GLSL = WAVES.map((q) => `
        a = ${f6(q.a)} * uAmp; k = vec2(${f6(q.kx)}, ${f6(q.ks)});
        ph = dot(k, P) + ${f6(q.w)} * uTime + ${f6(q.ph)}; c = cos(ph); sn = sin(ph);
        h += a * sn; hx += a * k.x * c; hs += a * k.y * c;
        dP += ${STEEP.toFixed(2)} * a * normalize(k) * c; pinch += ${STEEP.toFixed(2)} * a * length(k) * sn;`).join('');
  // a grid that is fine near the boat and coarse towards the horizon
  const waterGrid = (nx, nz) => {
    const g = new THREE.PlaneGeometry(1, 1, nx, nz).rotateX(-Math.PI / 2);
    const p = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i) * 2, v = 0.5 - p.getZ(i);
      const x = 230 * (0.3 * u + 0.7 * u * Math.abs(u)), z = 30 - 460 * (0.25 * v + 0.75 * v * v);
      p.setXYZ(i, x, 0, z);
      uv.setXY(i, x / 10, -z / 10);
    }
    return g;
  };
  // ripples too fine for the mesh: a tileable normal map that drifts over the surface
  const rippleTex = (() => {
    const N = 256, c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d'), img = ctx.createImageData(N, N);
    const F = [[3, 1, 0], [-2, 4, 1.3], [5, -3, 2.1], [1, 6, 0.7], [7, 2, 4.2], [-9, 5, 1.1], [11, -4, 3.3], [4, 13, 5.2], [-14, -7, 0.4]]; // whole periods -> seamless
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let nx = 0, ny = 0;
      for (const [a, b, ph] of F) {
        const d = Math.cos(Math.PI * 2 * (a * x + b * y) / N + ph) / Math.pow(Math.hypot(a, b), 1.3);
        nx -= d * a; ny -= d * b;
      }
      const inv = 1 / Math.hypot(nx, ny, 2.2), i = (y * N + x) * 4;
      img.data[i] = (nx * inv * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      img.data[i + 2] = (2.2 * inv * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
  })();
  const RIPPLE = 3.2; // ripple tiles per 10 m
  rippleTex.repeat.set(RIPPLE, RIPPLE);
  // what the water mirrors: a small sky gradient (zenith, horizon, below) turned into an environment map
  const pmrem = new THREE.PMREMGenerator(renderer);
  const skyEnv = (zenith, horizon, below) => {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 32;
    const ctx = c.getContext('2d'), grd = ctx.createLinearGradient(0, 0, 0, 32);
    grd.addColorStop(0, zenith); grd.addColorStop(0.48, horizon); grd.addColorStop(0.52, below); grd.addColorStop(1, below);
    ctx.fillStyle = grd; ctx.fillRect(0, 0, 64, 32);
    const t = new THREE.CanvasTexture(c);
    t.mapping = THREE.EquirectangularReflectionMapping;
    t.encoding = THREE.sRGBEncoding;
    const env = pmrem.fromEquirectangular(t).texture;
    t.dispose();
    return env;
  };
  const SKY_ENV = { day: skyEnv('#77848d', '#a6a9a7', '#232c2a'), night: skyEnv('#04060d', '#1d2b4c', '#050a10') }; // an overcast sky
  const waterMat = new THREE.MeshStandardMaterial({
    roughness: 0.16, metalness: 0,
    normalMap: rippleTex, normalScale: new THREE.Vector2(0.22, 0.22),
  });
  waterMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uDist: U.dist, uTime: U.time, uAmp: U.amp, uDeep: U.deep, uShallow: U.shallow, uFoam: U.foam });
    sh.vertexShader = 'uniform float uDist; uniform float uTime; uniform float uAmp; varying float vH; varying float vPinch;\n' + sh.vertexShader
      .replace('#include <beginnormal_vertex>', `
        vec4 wp0 = modelMatrix * vec4(position, 1.0);
        vec2 P = vec2(wp0.x, uDist - wp0.z);
        float h = 0.0, hx = 0.0, hs = 0.0, pinch = 0.0, a, ph, c, sn; vec2 k, dP = vec2(0.0);
        ${WAVE_GLSL}
        vec3 objectNormal = normalize(vec3(-hx, 1.0 - pinch, hs));
        vH = h / (${f6(AMP_SUM)} * uAmp + 0.001); vPinch = pinch;`)
      .replace('#include <begin_vertex>', 'vec3 transformed = vec3(position.x + dP.x, h, position.z - dP.y);');
    sh.fragmentShader = 'uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uFoam; varying float vH; varying float vPinch;\n' + sh.fragmentShader
      .replace('#include <color_fragment>', `
        // light passing through the thin top of a crest turns it green-blue
        diffuseColor.rgb = mix(uDeep, uShallow, smoothstep(0.1, 0.9, vH));
        float brk = texture2D(normalMap, vUv * 2.7).r - 0.5;
        float foam = smoothstep(0.2, 0.4, vPinch + brk * 0.2) * smoothstep(0.2, 0.7, vH);
        diffuseColor.rgb = mix(diffuseColor.rgb, uFoam, foam * 0.8);`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, 0.85, foam);');
  };
  const water = new THREE.Mesh(waterGrid(...(Q.fine ? [200, 220] : [110, 130])), waterMat);
  water.receiveShadow = true;
  water.frustumCulled = false;
  water.visible = false;
  scene.add(water);

  /* ----- materials and geometry ----- */
  const std = (color, extra) => new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.95 }, extra));
  const mats = {
    bark: std(0x3f2d20),
    pine: [0x2a5236, 0x234a34, 0x35623b, 0x1f4030].map((c) => std(c, { flatShading: true })),
    leaf: [0x4f7a34, 0x5d8a3a, 0x436b2e].map((c) => std(c, { flatShading: true })),
    rock: std(0x7b7f85, { flatShading: true }),
    steel: std(0x8c9299, { metalness: 0.7, roughness: 0.45 }),
    lattice: std(0x8c9299, { metalness: 0.7, roughness: 0.45, wireframe: true }),
    walls: [0xe8dcc0, 0xb5c9d6, 0xd9b08c, 0xc7d3b0, 0xe3a587].map((c) => std(c)),
    roofs: [0x7a3b2e, 0x4a5560, 0x5d6b3a].map((c) => std(c)),
    barn: std(0x9c2f24),
    barnRoof: std(0x3a3d42),
    trim: std(0xf0ece0),
    silo: std(0xb9bec4, { metalness: 0.6, roughness: 0.4 }),
    hay: std(0xc9a94a),
    dark: std(0x2a2c30),
    glass: std(0x1a1c20, { roughness: 0.2, emissive: 0xffc66b, emissiveIntensity: 0 }), // lit at night
    beacon: new THREE.MeshBasicMaterial({ color: 0xff3030, fog: false }),
    // sea
    wood: std(0x9a7a4e),
    rust: std(0x8a4b2a, { roughness: 0.8 }),
    buoy: std(0x7d3a30, { roughness: 0.6 }),
    boxes: [0x4a5a4e, 0x6b4a3a, 0x55554a, 0x5e5240].map((c) => std(c, { roughness: 0.75 })),
    concrete: std(0x9a9a96),
    hull: std(0x2b3038, { roughness: 0.6 }),
    // ground
    earth: std(0x6b573d, { flatShading: true }),
    burnt: std(0x1d1b1a),
    sandbag: std(0xa89a72, { flatShading: true }),
    timber: std(0x5c4630),
    deadwood: std(0x4a4038),
    charred: std(0x3a3029),
    mine: std(0x3b2f27, { roughness: 0.8 }),
    boomFloat: std(0x5c5f58, { roughness: 0.7 }),
    soot: std(0x1e1916), // burnt forest
    mud: std(0x4a3d2e, { flatShading: true }),
    plaster: [0x7e786d, 0x6d685f, 0x857c6e].map((c) => std(c)),
    brick: std(0x7d4c3b),
    slab: std(0x6f6a62),
    tarp: std(0x4d5238), // camouflage net / tarpaulin
    tyre: std(0x1c1c1e),
    steelRust: std(0x3d322b, { metalness: 0.4, roughness: 0.75 }), // hedgehogs: rail steel, rusty
    teeth: std(0x55534e),
  };

  // Displace vertices by a hash of their position: shared corners move together, so
  // the mesh stays watertight while losing its perfect, computer-made silhouette.
  const rough = (g, amt, seed) => {
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const h = (n) => { const s = Math.sin(x * 12.9898 * n + y * 78.233 + z * 37.719 * n + seed) * 43758.5453; return s - Math.floor(s) - 0.5; };
      p.setXYZ(i, x + h(1) * amt, y + h(2) * amt * 0.6, z + h(3) * amt);
    }
    g.computeVertexNormals();
    return g;
  };
  const PINE_TIERS = [[2.0, 1.9, 2.3], [1.75, 1.8, 3.4], [1.45, 1.7, 4.5], [1.15, 1.6, 5.5], [0.85, 1.5, 6.4], [0.5, 1.5, 7.3]]; // radius, height, y
  const geo = {
    pineTrunk: new THREE.CylinderGeometry(0.14, 0.34, 4, 8),
    tiers: PINE_TIERS.map(([r, h, y], i) => ({ g: rough(new THREE.ConeGeometry(r, h, 11), 0.3, i), y })),
    oakTrunk: new THREE.CylinderGeometry(0.28, 0.46, 3.4, 8),
    branch: new THREE.CylinderGeometry(0.09, 0.16, 2.2, 6),
    crowns: [1, 2, 3].map((s) => rough(new THREE.IcosahedronGeometry(1.5, 1), 0.45, s)),
    rocks: [1, 2, 3].map((s) => rough(new THREE.IcosahedronGeometry(0.9, 1), 0.4, s * 7)),
    lattice: new THREE.CylinderGeometry(0.22, 1.2, 18, 4, 9, true),
    arm: new THREE.BoxGeometry(3.8, 0.12, 0.12),
    insulator: new THREE.CylinderGeometry(0.06, 0.06, 0.7, 6),
    beacon: new THREE.SphereGeometry(0.2, 8, 8),
    box: new THREE.BoxGeometry(1, 1, 1), // walls, crates, hulls: scaled per use
    // triangular prism, ridge along x: apex at y = 1, eaves at y = -0.5, z = +-0.866
    gable: new THREE.CylinderGeometry(1, 1, 1, 3).rotateZ(Math.PI / 2).rotateX(-Math.PI / 2),
    siloBody: new THREE.CylinderGeometry(1.4, 1.4, 7, 16),
    siloDome: new THREE.SphereGeometry(1.4, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    bale: new THREE.CylinderGeometry(0.7, 0.7, 1.2, 14).rotateZ(Math.PI / 2),
    // sea
    log: new THREE.CylinderGeometry(0.22, 0.27, 3.4, 8).rotateZ(Math.PI / 2),
    barrel: new THREE.CylinderGeometry(0.3, 0.3, 0.9, 12).rotateZ(Math.PI / 2),
    buoyBody: new THREE.CylinderGeometry(0.45, 0.7, 1.1, 12),
    pole: new THREE.CylinderGeometry(0.05, 0.05, 1, 6),
    // ground
    berm: rough(new THREE.CylinderGeometry(0.8, 0.8, 9, 7, 6).rotateZ(Math.PI / 2), 0.5, 3),
    bag: rough(new THREE.BoxGeometry(0.9, 0.3, 0.45, 2, 1, 1), 0.12, 5),
    craterRim: rough(new THREE.TorusGeometry(1.6, 0.5, 6, 14).rotateX(Math.PI / 2), 0.4, 9),
    craterPit: new THREE.CircleGeometry(1.5, 14).rotateX(-Math.PI / 2),
    wheel: new THREE.CylinderGeometry(0.5, 0.5, 0.4, 12).rotateZ(Math.PI / 2),
    deadTrunk: new THREE.CylinderGeometry(0.1, 0.3, 5, 7),
    stumpTrunk: rough(new THREE.CylinderGeometry(0.15, 0.24, 2.4, 7, 3), 0.04, 6),
    splinter: new THREE.ConeGeometry(0.07, 0.6, 4),
    tooth: new THREE.CylinderGeometry(0.22, 0.85, 1.1, 4, 1),
    tyre: new THREE.TorusGeometry(0.38, 0.13, 6, 12).rotateX(Math.PI / 2),
    mineBody: new THREE.SphereGeometry(0.5, 12, 8),
    horn: new THREE.CylinderGeometry(0.04, 0.06, 0.28, 6),
    drum: new THREE.CylinderGeometry(0.32, 0.32, 1, 10).rotateZ(Math.PI / 2),
    tallTrunk: rough(new THREE.CylinderGeometry(0.1, 0.2, 1, 6, 5), 0.02, 12),
    coil: new THREE.TorusGeometry(0.45, 0.03, 5, 12).rotateY(Math.PI / 2),
    mound: rough(new THREE.SphereGeometry(4, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0.9, 4),
  };
  const part = (parent, g, m, x, y, z, sx, sy, sz) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    if (sx) mesh.scale.set(sx, sy, sz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  // gable roof over a footprint of length l (x) and depth d (z), sitting on walls of height top
  const roof = (t, m, x, top, l, d, rise) => part(t, geo.gable, m, x, top + rise / 3, 0, l + 0.5, rise / 1.5, (d / 2 + 0.35) / 0.866);

  /* ----- object classes.
     w = radius the route must clear (crown / hull / berm, not just the core); h = height;
     low = passed over, never avoided; far = kept well away from the route;
     fixed = no random scale; float = rides the waves; across = lies across the heading. ----- */
  const CLASSES = {
    /* --- air: farmland --- */
    pine: { label: 'PINE', w: 2.1, h: 8.1, build(t) {
      part(t, geo.pineTrunk, mats.bark, 0, 2, 0);
      const a = pick(mats.pine), b = pick(mats.pine);
      geo.tiers.forEach(({ g, y }, i) => { part(t, g, i % 2 ? a : b, 0, y, 0).rotation.y = rand(0, 6); });
    } },
    tree: { label: 'TREE', w: 3.0, h: 7.2, build(t) {
      part(t, geo.oakTrunk, mats.bark, 0, 1.7, 0);
      part(t, geo.branch, mats.bark, 0.6, 3.6, 0).rotation.z = -0.7;
      part(t, geo.branch, mats.bark, -0.6, 3.7, 0.2).rotation.z = 0.7;
      [[0, 5, 0, 1], [1.3, 4.4, 0.3, 0.75], [-1.2, 4.5, -0.4, 0.8], [0.2, 4.3, 1.2, 0.7], [-0.3, 4.6, -1.2, 0.7], [0, 6, 0, 0.7]]
        .forEach(([x, y, z, s], i) => { part(t, geo.crowns[i % 3], mats.leaf[i % 3], x, y, z, s, s, s).rotation.y = rand(0, 6); });
    } },
    rock: { label: 'ROCK', w: 1.3, h: 1.0, low: true, build(t) {
      part(t, pick(geo.rocks), mats.rock, 0, 0.35, 0, 1.3, 0.75, 1);
      part(t, pick(geo.rocks), mats.rock, 0.9, 0.15, 0.4, 0.45, 0.45, 0.45);
    } },
    hay: { label: 'HAY BALE', w: 0.9, h: 1.4, low: true, fixed: true, build(t) {
      part(t, geo.bale, mats.hay, 0, 0.7, 0);
    } },
    mast: { label: 'PYLON', w: 3.0, h: 18.4, fixed: true, build(t) {
      part(t, geo.lattice, mats.lattice, 0, 9, 0);
      [13.5, 16].forEach((y) => {
        part(t, geo.arm, mats.steel, 0, y, 0);
        part(t, geo.insulator, mats.dark, -1.7, y - 0.4, 0);
        part(t, geo.insulator, mats.dark, 1.7, y - 0.4, 0);
      });
      part(t, geo.beacon, mats.beacon, 0, 18.2, 0).add(glow(0xff3030, 3));
    } },
    house: { label: 'FARMHOUSE', w: 3.9, h: 4.8, far: true, fixed: true, build(t) {
      part(t, geo.box, pick(mats.walls), 0, 1.4, 0, 5.4, 2.8, 4.2);
      roof(t, pick(mats.roofs), 0, 2.8, 5.4, 4.2, 2);
      part(t, geo.box, mats.dark, 1.6, 4.2, -0.6, 0.5, 1.4, 0.5);
      part(t, geo.box, mats.dark, -1.5, 1, 2.11, 1, 2, 0.08);
      part(t, geo.box, mats.glass, 0.2, 1.7, 2.11, 1, 1, 0.08);
      part(t, geo.box, mats.glass, 1.7, 1.7, 2.11, 1, 1, 0.08);
      part(t, geo.box, mats.glass, 2.71, 1.7, 0, 0.08, 1, 1.2);
      part(t, geo.box, mats.glass, -2.71, 1.7, 0, 0.08, 1, 1.2);
    } },
    barn: { label: 'BARN', w: 5.0, h: 7.2, far: true, fixed: true, build(t) {
      part(t, geo.box, mats.barn, 0, 2, 0, 7.5, 4, 5.5);
      roof(t, mats.barnRoof, 0, 4, 7.5, 5.5, 3.2);
      part(t, geo.box, mats.trim, 0, 1.6, 2.76, 2.8, 3.2, 0.08);
      part(t, geo.box, mats.dark, 0, 1.5, 2.79, 2.3, 2.9, 0.08);
      part(t, geo.box, mats.trim, -2.6, 2.4, 2.76, 0.9, 0.9, 0.08);
      part(t, geo.box, mats.trim, 2.6, 2.4, 2.76, 0.9, 0.9, 0.08);
    } },
    silo: { label: 'SILO', w: 1.8, h: 8.4, far: true, fixed: true, build(t) {
      part(t, geo.siloBody, mats.silo, 0, 3.5, 0);
      part(t, geo.siloDome, mats.silo, 0, 7, 0);
    } },
    windmill: { label: 'WINDMILL', w: 5, h: 12, far: true, fixed: true, build(t) {
      part(t, geo.siloBody, mats.trim, 0, 4.5, 0, 1.2, 1.3, 1.2);
      part(t, geo.box, mats.timber, 0, 9, 1.8, 9, 0.3, 0.1).rotation.z = 0.6;
      part(t, geo.box, mats.timber, 0, 9, 1.8, 0.3, 9, 0.1).rotation.z = 0.6;
    } },

    /* --- sea: open water, drifting debris, a port now and then --- */
    debris: { label: 'DEBRIS', w: 1.5, h: 0.8, float: true, sink: 0.35, build(t) {
      part(t, geo.box, mats.wood, 0, 0.1, 0, 0.9, 0.7, 0.9).rotation.set(0.2, 0.4, 0.15);
      part(t, geo.box, mats.wood, 0.9, 0, 0.5, 1.8, 0.08, 0.3).rotation.y = 0.5;
      part(t, geo.box, mats.boxes[3], -0.7, 0.05, -0.5, 0.5, 0.4, 0.5).rotation.z = 0.3;
    } },
    log: { label: 'DRIFTWOOD', w: 1.8, h: 0.5, float: true, sink: 0.4, build(t) {
      part(t, geo.log, mats.deadwood, 0, 0.05, 0);
      part(t, geo.branch, mats.deadwood, 0.6, 0.3, 0.2, 0.7, 0.5, 0.7).rotation.x = 0.9;
    } },
    barrel: { label: 'BARREL', w: 0.8, h: 0.6, float: true, fixed: true, sink: 0.45, build(t) {
      part(t, geo.barrel, mats.rust, 0, 0.08, 0);
    } },
    buoy: { label: 'BUOY', w: 1.0, h: 2.6, float: true, fixed: true, sink: 0.12, build(t) {
      part(t, geo.buoyBody, mats.buoy, 0, 0.35, 0);
      part(t, geo.pole, mats.steel, 0, 1.6, 0, 1, 1.6, 1);
      part(t, geo.beacon, mats.beacon, 0, 2.5, 0).add(glow(0xff3030, 2.4));
    } },
    container: { label: 'CONTAINER', w: 3.5, h: 1.8, float: true, fixed: true, sink: 0.45, build(t) {
      part(t, geo.box, pick(mats.boxes), 0, 0.2, 0, 6.1, 2.6, 2.44).rotation.set(0.1, 0, 0.14);
    } },
    // quay with a gantry crane, stacked containers and a moored ship; the water side faces -x
    port: { label: 'PORT', w: 25, h: 18, far: true, fixed: true, face: true, build(t) {
      part(t, geo.box, mats.concrete, 9, 0.6, 0, 10, 3, 44);
      for (let z = -20; z <= 20; z += 8) part(t, geo.box, mats.dark, 4.2, 0.2, z, 0.6, 3.4, 0.6); // piles
      [[6, -4], [6, 4], [12, -4], [12, 4]].forEach(([x, z]) => part(t, geo.box, mats.buoy, x, 9, z, 0.5, 14, 0.5));
      part(t, geo.box, mats.buoy, 4, 16.5, 0, 17, 1, 1.2);        // boom reaching over the water
      part(t, geo.box, mats.trim, 9, 15.2, 0, 2.4, 1.8, 2.4);     // cabin
      part(t, geo.box, mats.dark, -2, 13, 0, 0.12, 6, 0.12);      // hoist cable
      [-17, -10, 10, 17].forEach((z, i) => {
        part(t, geo.box, mats.boxes[i], 10, 3.4, z, 2.44, 2.6, 6.1);
        if (i % 2) part(t, geo.box, mats.boxes[(i + 2) % 4], 10, 6, z, 2.44, 2.6, 6.1);
      });
      part(t, geo.box, mats.hull, 0, 1, 6, 6, 4.4, 30);           // moored ship
      part(t, geo.box, mats.buoy, 0, -0.9, 6, 6.05, 0.8, 30.05);
      part(t, geo.box, mats.trim, 0, 5.6, 16, 4.6, 5, 7);
      part(t, geo.box, mats.glass, 0, 6.8, 12.46, 4, 1, 0.08);
      part(t, geo.box, mats.dark, 0, 9.2, 17, 1.2, 2.4, 1.6);
      [-14, 14].forEach((z) => part(t, geo.pole, mats.steel, 6, 5, z, 1.5, 6, 1.5)); // quay lamp posts, dark: blackout
      for (let i = 0; i < 6; i++) part(t, geo.box, mats.charred, rand(5, 13), 2.2, rand(-20, 20), rand(1, 3), 0.3, 0.4).rotation.y = rand(0, 3); // burnt wreckage on the quay
    } },
    // a warehouse on a pier, shelled: walls standing, the roof half fallen in, scorched
    warehouse: { label: 'WAREHOUSE', w: 7, h: 6, far: true, fixed: true, sink: 0, build(t) {
      part(t, geo.box, mats.concrete, 0, -0.6, 0, 12, 1.6, 18);                           // the pier it stands on
      [[-5, 0, 0.4, 16], [5, 0, 0.4, 16], [0, -8, 10, 0.4], [0, 8, 10, 0.4]].forEach(([x, z, w, d], i) => {
        part(t, geo.box, i === 2 ? mats.burnt : pick(mats.plaster), x, 2.4, z, w, 4.8 - (i === 1 ? 1.6 : 0), d);
      });
      part(t, geo.box, mats.dark, 0, 1.6, 8.05, 4, 3.2, 0.1);                             // the door, blown in
      for (let k = 0; k < 4; k++) if (k !== 1 && k !== 2) roof(t, mats.barnRoof, 0, 4.8, 10, 4, 1.6).position.z = -6 + k * 4;
      const fallen = part(t, geo.box, mats.barnRoof, 0, 2, 0, 9, 0.15, 7);              // and what came down
      fallen.rotation.x = 0.5;
      part(t, geo.mound, mats.earth, 2, 0, -2, 0.5, 0.2, 0.4);
    } },
    // Sokol portal crane on the quay; a single one, always on the left (see placeCrane)
    crane: { label: 'PORT CRANE', w: 10, h: 34, max: 1, far: true, fixed: true, build(t) {
      [[-4, -4], [-4, 4], [4, -4], [4, 4]].forEach(([x, z]) => part(t, geo.box, mats.hull, x, 4, z, 0.8, 8, 0.8));
      part(t, geo.box, mats.trim, 0, 15, 0, 2, 14, 2);            // tower
      part(t, geo.box, mats.trim, 0, 23, 0, 5, 3, 4);             // cabin
      part(t, geo.box, mats.buoy, 11, 27, 0, 22, 1, 1).rotation.z = 0.35; // jib reaching over the water (+x)
    } },
    boat: { label: 'BOAT', w: 3.3, h: 4.6, float: true, fixed: true, sink: 0.1, build(t) {
      part(t, geo.box, mats.hull, 0, 0.5, 0, 2.2, 1.2, 6);
      part(t, geo.box, mats.trim, 0, 1.8, -0.6, 1.6, 1.4, 2);
    } },
    cargoship: { label: 'CARGO SHIP', w: 16, h: 13, far: true, fixed: true, along: true, sink: 0.08, build(t) {
      part(t, geo.box, mats.hull, 0, 1.5, 0, 7, 5, 30);
      part(t, geo.box, mats.trim, 0, 6.5, 10, 5.4, 5, 6);
      [-8, -2, 4].forEach((z, i) => part(t, geo.box, mats.boxes[i], 0, 5.3, z, 5.6, 2.6, 5.4));
    } },
    lighthouse: { label: 'LIGHTHOUSE', w: 4, h: 16, far: true, fixed: true, sink: 0.03, build(t) {
      part(t, geo.siloBody, mats.trim, 0, 7, 0, 1, 2, 1);
      part(t, geo.beacon, mats.beacon, 0, 14.6, 0, 3, 3, 3);
    } },
    dock: { label: 'PIER', w: 7, h: 2.6, far: true, fixed: true, sink: 0.2, build(t) {
      part(t, geo.box, mats.timber, 0, 0.9, 0, 3, 0.3, 13);
      [-5, 0, 5].forEach((z) => part(t, geo.box, mats.timber, 1.2, 0.2, z, 0.3, 2, 0.3));
    } },

    /* --- ground: fortified field --- */
    trench: { label: 'TRENCH', w: 5.2, h: 1.2, fixed: true, across: true, build(t) {
      part(t, geo.berm, mats.earth, 0, 0.1, 1.5, 1, 0.7, 1);
      part(t, geo.berm, mats.earth, 0, 0.1, -1.5, 1, 0.6, 1).rotation.y = Math.PI;
      part(t, geo.box, mats.burnt, 0, 0.03, 0, 9, 0.06, 1.8);     // the dug-out floor
      [-3.6, -1.2, 1.2, 3.6].forEach((x) => part(t, geo.box, mats.timber, x, 0.5, -0.8, 0.14, 1, 0.14));
      part(t, geo.box, mats.timber, 0, 0.9, -0.8, 7.6, 0.12, 0.12);
      for (let i = 0; i < 6; i++) part(t, geo.bag, mats.sandbag, -2.6 + i * 1.0, 0.75 + (i % 2) * 0.05, 1.5).rotation.y = rand(-0.2, 0.2);
    } },
    hedgehog: { label: 'HEDGEHOG', w: 1.4, h: 1.5, fixed: true, build(t) {
      const g = new THREE.Group();
      part(g, geo.box, mats.steelRust, 0, 0, 0, 2.3, 0.16, 0.16);
      part(g, geo.box, mats.steelRust, 0, 0, 0, 0.16, 2.3, 0.16);
      part(g, geo.box, mats.steelRust, 0, 0, 0, 0.16, 0.16, 2.3);
      g.rotation.set(0.62, 0, 0.62);
      g.position.y = 0.75;
      t.add(g);
    } },
    crater: { label: 'CRATER', w: 2.5, h: 0.6, build(t) {
      part(t, geo.craterRim, mats.mud, 0, 0.05, 0, 1, 0.6, 1);
      part(t, geo.craterPit, mats.burnt, 0, 0.04, 0);
    } },
    wreck: { label: 'WRECK', w: 3.3, h: 2.4, fixed: true, build(t) {
      const g = new THREE.Group();
      part(g, geo.box, mats.burnt, 0, 0.95, 0, 2.4, 1.1, 5);
      part(g, geo.box, mats.rust, 0, 1.9, 0.8, 2.2, 0.9, 1.8);
      [[-1.3, 1.6], [1.3, 1.6], [-1.3, -1.6], [1.3, -1.6]].forEach(([x, z]) => part(g, geo.wheel, mats.dark, x, 0.5, z));
      g.rotation.z = 0.07;
      t.add(g);
    } },
    truck: { label: 'BURNT TRUCK', w: 3.1, h: 2.3, fixed: true, build(t) {
      part(t, geo.box, mats.dark, 0, 0.6, 0, 2.2, 0.3, 5.6);
      part(t, geo.box, mats.earth, 0, 1.4, 1.9, 2.2, 1.4, 1.8);
      part(t, geo.box, mats.timber, 0, 1.2, -1, 2.2, 0.9, 3.4);
      [[-1.1, 1.9], [1.1, 1.9], [-1.1, -1.6], [1.1, -1.6]].forEach(([x, z]) => part(t, geo.wheel, mats.dark, x, 0.45, z));
    } },
    deadtree: { label: 'DEAD TREE', w: 1.7, h: 5.2, lean: 0.1, quiet: true, build(t) {
      part(t, geo.deadTrunk, mats.deadwood, 0, 2.5, 0).rotation.z = rand(-0.12, 0.12);
      part(t, geo.branch, mats.deadwood, 0.5, 3.4, 0, 0.8, 0.8, 0.8).rotation.z = -0.9;
      part(t, geo.branch, mats.deadwood, -0.4, 2.6, 0.1, 0.7, 0.6, 0.7).rotation.z = 1;
    } },
    block: { label: 'BARRIER', w: 1.6, h: 1.0, fixed: true, build(t) {
      part(t, geo.box, mats.concrete, 0, 0.5, 0, 2.4, 1, 1);
      part(t, geo.box, mats.concrete, 0, 1.05, 0, 1.6, 0.1, 0.5);
    } },
    wire: { label: 'WIRE', w: 3.7, h: 1.3, fixed: true, across: true, build(t) {
      [-3, 0, 3].forEach((x) => part(t, geo.box, mats.timber, x, 0.65, 0, 0.1, 1.3, 0.1));
      for (let i = 0; i < 9; i++) part(t, geo.coil, mats.steel, -3 + i * 0.75, 0.55, 0);
    } },
    dugout: { label: 'DUGOUT', w: 4.8, h: 2.2, far: true, fixed: true, build(t) {
      part(t, geo.mound, mats.earth, 0, 0, 0, 1, 0.5, 1);
      part(t, geo.box, mats.timber, 0, 0.7, 3.3, 3, 1.4, 0.3);
      part(t, geo.box, mats.burnt, 0, 0.9, 3.36, 1.7, 0.35, 0.3);
    } },
    barricade: { label: 'BARRICADE', w: 1.7, h: 1.7, fixed: true, across: true, build(t) {
      part(t, geo.box, mats.timber, 0, 0.9, 0, 3, 0.2, 0.2);
      [-1.2, 0, 1.2].forEach((x) => part(t, geo.box, mats.timber, x, 0.8, 0, 0.16, 1.6, 0.16).rotation.x = 0.5);
    } },
    // a trunk snapped by a shell: jagged top, sometimes a splinter still hanging off it
    stump: { label: 'BROKEN TREE', w: 0.9, h: 2.4, lean: 0.14, quiet: true, build(t) {
      const hgt = rand(1.2, 3.2), k = rand(0.9, 1.3);
      part(t, geo.stumpTrunk, mats.charred, 0, hgt / 2, 0, k, hgt / 2.4, k);
      // the break: a few splinters of different length round the top
      [[0.07, 0], [-0.08, 0.05], [0, -0.09]].forEach(([x, z], i) => {
        const l = rand(0.15, i ? 0.45 : 0.7);
        part(t, geo.splinter, mats.charred, x * k, hgt + l / 2 - 0.05, z * k, 1, l / 0.6, 1).rotation.set(rand(-0.2, 0.2), rand(0, 6), rand(-0.2, 0.2));
      });
      if (Math.random() < 0.5) part(t, geo.branch, mats.charred, 0.45, hgt * 0.7, 0, 0.6, 0.7, 0.6).rotation.z = -rand(1.1, 1.8);
    } },
    // a farmhouse after shelling: broken walls of uneven height with gaps, no roof left but a
    // slab fallen inside, a chimney standing, rubble heaped against the walls
    ruin: { label: 'RUINS', w: 5.2, h: 3.4, far: true, fixed: true, build(t) {
      const L = rand(7, 8.5), D = rand(5.5, 6.5), H = rand(2.6, 3.1), wall = pick(mats.plaster);
      const side = (x0, z0, x1, z1) => {               // one wall in 3-4 pieces, some knocked out
        const n = 3 + (Math.random() < 0.5 ? 1 : 0), dx = (x1 - x0) / n, dz = (z1 - z0) / n, len = Math.hypot(dx, dz);
        for (let i = 0; i < n; i++) {
          if (Math.random() < 0.28) continue;
          const h = H * rand(0.3, 1), cx = x0 + dx * (i + 0.5), cz = z0 + dz * (i + 0.5);
          const m = part(t, geo.box, Math.random() < 0.3 ? mats.burnt : wall, cx, h / 2, cz, len + 0.02, h, 0.35);
          m.rotation.y = -Math.atan2(dz, dx);
          if (h > H * 0.6 && Math.random() < 0.5) part(t, geo.box, mats.brick, cx, h + 0.2, cz, len * 0.4, 0.4, 0.36).rotation.y = -Math.atan2(dz, dx); // jagged top
        }
      };
      side(-L / 2, -D / 2, L / 2, -D / 2); side(L / 2, -D / 2, L / 2, D / 2); side(L / 2, D / 2, -L / 2, D / 2); side(-L / 2, D / 2, -L / 2, -D / 2);
      part(t, geo.box, mats.brick, rand(-L / 3, L / 3), (H + 1.2) / 2, rand(-D / 4, D / 4), 0.6, H + 1.2, 0.6);   // chimney
      const slab = part(t, geo.box, mats.slab, rand(-1, 1), H * 0.35, 0, L * 0.55, 0.18, D * 0.7);              // roof fallen in
      slab.rotation.z = rand(0.35, 0.55) * (Math.random() < 0.5 ? 1 : -1);
      part(t, geo.mound, mats.earth, rand(-2, 2), 0, rand(-1.5, 1.5), 0.55, 0.2, 0.45);                           // rubble inside
      part(t, geo.mound, pick(mats.plaster), L / 2 + 0.3, 0, rand(-1, 1), 0.3, 0.14, 0.4);                        // and spilled out
      for (let i = 0; i < 3; i++) part(t, geo.box, mats.charred, rand(-L / 3, L / 3), rand(0.4, 1.4), rand(-D / 3, D / 3), 3.2, 0.15, 0.15).rotation.set(rand(-0.4, 0.4), rand(0, 3), rand(0.3, 0.8)); // charred beams
    } },
    // a roadside checkpoint: a guard post walled with sandbags under a camouflage net, a stack of tyres
    checkpoint: { label: 'CHECKPOINT', w: 2.6, h: 2.6, fixed: true, build(t) {
      for (let row = 0; row < 4; row++) {
        const y = 0.16 + row * 0.29;
        for (let i = 0; i < 3; i++) part(t, geo.bag, mats.sandbag, -1.25 + i * 0.95 + (row % 2) * 0.45, y, -1.3);
        for (let i = 0; i < 3; i++) part(t, geo.bag, mats.sandbag, -1.7, y, -0.9 + i * 0.95 + (row % 2) * 0.3).rotation.y = Math.PI / 2;
        for (let i = 0; i < 3; i++) part(t, geo.bag, mats.sandbag, 1.7, y, -0.9 + i * 0.95 + (row % 2) * 0.3).rotation.y = Math.PI / 2;
      }
      [[-1.6, -1.2], [1.6, -1.2], [-1.6, 1.4], [1.6, 1.4]].forEach(([x, z]) => part(t, geo.box, mats.timber, x, 1.2, z, 0.12, 2.4, 0.12));
      part(t, geo.box, mats.tarp, 0, 2.42, 0.1, 3.8, 0.06, 3.2).rotation.x = 0.08;                                // net / roof
      for (let i = 0; i < 4; i++) part(t, geo.tyre, mats.tyre, 2.6, 0.12 + i * 0.24, 0.6);
    } },
    /* --- sea on the front --- */
    // a moored contact mine: a rusty sphere with horns, riding the swell
    mine: { label: 'SEA MINE', w: 1.1, h: 0.9, float: true, fixed: true, build(t) {
      part(t, geo.mineBody, mats.mine, 0, 0.3, 0);
      [[0, 1, 0], [0.8, 0.5, 0], [-0.8, 0.5, 0], [0, 0.5, 0.8], [0, 0.5, -0.8], [0.55, 0.85, 0.55], [-0.55, 0.85, -0.55]].forEach(([x, y, z]) => {
        const h = part(t, geo.horn, mats.dark, x * 0.5, 0.3 + (y - 0.5) * 0.6 + 0.1, z * 0.5);
        h.lookAt(x * 10, 0.3 + (y - 0.5) * 6 + 1, z * 10); h.rotateX(Math.PI / 2);
      });
    } },
    // a floating boom: a string of drums on a cable, laid across the water to stop boats
    boom: { label: 'BOOM', w: 3.2, h: 0.6, float: true, fixed: true, across: true, sink: 0.2, build(t) {
      for (let i = 0; i < 6; i++) part(t, geo.drum, i % 2 ? mats.mine : mats.boomFloat, -3 + i * 1.2, 0.15, 0);
      part(t, geo.box, mats.dark, 0, 0.32, 0, 7.4, 0.05, 0.05);
    } },
    // half-sunk burnt boat (placeholder until the model loads)
    hulk: { label: 'SUNKEN BOAT', w: 2.6, h: 1.4, float: true, sink: 0.45, build(t) {
      part(t, geo.box, mats.burnt, 0, 0.2, 0, 2.2, 1, 5).rotation.z = 0.2;
    } },
    // a big shell crater on the track: the dent is in the terrain (a crater of the pool); this
    // invisible stand-in lets the planner steer round it and the HUD mark it
    pit: { label: 'LARGE CRATER', w: 1, h: 0.25, build() {} },
    // a pine burnt and snapped by shellfire: a tall bare pole with a splintered top and stubs of branches
    trunk: { label: 'BURNT TRUNK', w: 0.7, h: 7, lean: 0.07, quiet: true, max: 700, build(t) {
      const H = rand(4, 9.5);
      part(t, geo.tallTrunk, mats.soot, 0, H / 2, 0, 1, H, 1);
      part(t, geo.splinter, mats.soot, 0.04, H + 0.2, 0, 1.3, rand(0.6, 1.4), 1.3).rotation.z = rand(-0.2, 0.2);
      for (let i = 0, n = 2 + Math.floor(Math.random() * 4); i < n; i++) {
        const b = part(t, geo.branch, mats.soot, 0, H * rand(0.45, 0.95), 0, 0.35, rand(0.25, 0.5), 0.35);
        const a = rand(0, 6.3);
        b.rotation.set(0, a, rand(0.9, 1.4));
        b.position.x = Math.cos(a) * 0.3; b.position.z = -Math.sin(a) * 0.3;
      }
    } },
    // a whole tree down on the ground, roots and all
    fallen: { label: 'FALLEN TREE', w: 2.8, h: 0.7, fixed: true, quiet: true, build(t) {
      const L = rand(5, 7);
      part(t, geo.tallTrunk, mats.soot, 0, 0.25, 0, 1.3, L, 1.3).rotation.z = Math.PI / 2;
      part(t, geo.mound, mats.earth, -L / 2, 0, 0, 0.18, 0.22, 0.2);                     // the root plate torn out
      for (let i = 0; i < 3; i++) part(t, geo.branch, mats.charred, rand(-L / 3, L / 2.2), 0.4, rand(-0.3, 0.3), 0.4, 0.5, 0.4).rotation.set(rand(-1, 1), 0, rand(0.3, 1));
    } },
    // dragon's teeth: truncated concrete pyramids in two staggered rows, set out in long belts
    teeth: { label: "DRAGON'S TEETH", w: 2.3, h: 1.1, fixed: true, across: true, quiet: true, build(t) {
      [[-1.5, -0.65], [0, -0.65], [1.5, -0.65], [-0.75, 0.7], [0.75, 0.7], [2.25, 0.7]].forEach(([x, z]) => {
        part(t, geo.tooth, mats.teeth, x + rand(-0.1, 0.1), 0.5, z + rand(-0.1, 0.1)).rotation.y = Math.PI / 4 + rand(-0.15, 0.15);
      });
    } },
    supply: { label: 'SUPPLY CRATE', w: 1.1, h: 1.1, fixed: true, build(t) {
      part(t, geo.box, mats.wood, 0, 0.5, 0, 1.2, 1, 1.2);
    } },
    sandbags: { label: 'SANDBAGS', w: 2.6, h: 1.2, fixed: true, across: true, build(t) {
      for (let i = 0; i < 10; i++) part(t, geo.bag, mats.sandbag, -2 + (i % 5) * 1.0 + (i > 4 ? 0.5 : 0), i > 4 ? 0.48 : 0.16, 0);
    } },
  };

  /* ----- environments: what each platform meets, and how it moves.
     band = half-width of the strip that is filled with objects (around the route);
     limit = how far the route may wander sideways; slope = steepest sideways drift (dx/ds);
     seg = length of one planning step; scatter = [class, square metres per object];
     alts = drone altitude above ground [lowest, highest cruise, highest climb], climb = steepest dy/ds;
     overfly = clearance needed to pass over an object instead of around it. ----- */
  /* Every platform weaves: its track is a snake (cfg.meander: wavelength and amplitude ranges,
     a new bend chosen at every crossing) laid over a goal that wanders across the strip, and
     obstacles are put on the line it is about to take (cfg.obs: spacing and kinds) so that it has
     to steer round them, showing off the onboard avoidance the module is for. Now and then a gate
     (cfg.gate) bars the way: a row of obstacles across the whole reach of a step with one gap,
     `shift` metres off to one side, just wide enough (`slack` metres to spare each way), which the
     planner has to find.
     lane = scattered things keep this far off that line, leaving room to swerve;
     agile = sideways reach of a planning step, times the usual; segRef = the step length the
     per-step chances of the extras were tuned for (see per). */
  const ENV = {
    // the front from a low-flying drone: shell-pocked fields burnt or gone to weed between tree
    // lines, wrecked farms, burnt-out vehicles, broken pylons, now and then a burnt forest
    air: {
      speed: 17, margin: 1.8, band: 72, limit: 62, slope: 0.5, seg: [30, 42], segRef: 50, relief: 3, bumps: 0.12,
      litter: 0.4, forest: 0.4, rows: 1.6, // lighter than the ground: share of litter, density of burnt forest, spacing in tree lines
      alts: [2.6, 7, 15], climb: 0.2, overfly: 1.5,
      meander: [120, 170, 12, 18], lane: 6, agile: 1.5,
      obs: { every: [16, 28], kinds: ['deadtree', 'deadtree', 'trunk', 'tree', 'pine', 'stump', 'mast'] },
      gate: { chance: 0.5, kinds: ['deadtree', 'deadtree', 'trunk', 'tree', 'pine'], step: 5.5, slack: 1.4, shift: [5, 11], span: 26 },
      scatter: [['deadtree', 900], ['stump', 1600], ['tree', 2600], ['pine', 3200], ['crater', 2600], ['hedgehog', 5000]],
      extras(s0, s1) {
        planForests(s1 + 50);
        burntForest(s0, s1);
        treeLines(s0, s1);
        if (per(0.25)) ruins(s0, s1);
        if (per(0.35)) scatter('wreck', s0, s1);
        if (per(0.25)) scatter('truck', s0, s1);
        if (per(0.1)) defenceBelt(s0, s1);
        if (per(0.15)) scatter('mast', s0, s1);
        for (let k = 0; k < 2; k++) if (freeFields.length && per(0.6)) placeField(s0, s1);
      },
    },
    // a contested coast: grey water, mines and booms, burnt and sunken boats, a shelled port
    sea: {
      alt: 1.7, speed: 10, margin: 1.6, band: 85, limit: 70, slope: 0.6, seg: [26, 36], segRef: 44, relief: 0,
      meander: [90, 140, 8, 14], lane: 6, agile: 1.5,
      // two locations: open water with a heavy swell, and the sheltered approach to a port
      locs: {
        open: {
          amp: 1,
          obs: { every: [14, 24], kinds: ['mine', 'mine', 'mine', 'buoy', 'hulk', 'hulk', 'debris', 'log', 'barrel', 'boat'] },
          gate: { chance: 0.35, kinds: ['boom', 'boom', 'boom', 'mine', 'mine'], step: 4.5, slack: 1.3, shift: [4, 9], span: 22 },
          scatter: [['debris', 1300], ['log', 1500], ['barrel', 1300], ['mine', 2000], ['hulk', 2600], ['buoy', 3200], ['boat', 4000], ['container', 4000]],
          extras(s0, s1) {
            if (per(0.2)) scatter('cargoship', s0, s1);
            if (per(0.1)) scatter('lighthouse', s0, s1);
          },
        },
        port: {
          amp: 0.35,
          obs: { every: [14, 22], kinds: ['mine', 'mine', 'buoy', 'hulk', 'hulk', 'boat', 'container', 'debris'] },
          gate: { chance: 0.4, kinds: ['boom', 'boom', 'boom', 'hulk', 'container'], step: 5, slack: 1.3, shift: [4, 9], span: 22 },
          plumes: 8,
          scatter: [['hulk', 1100], ['boat', 1800], ['container', 1700], ['debris', 1300], ['barrel', 1700], ['mine', 2600], ['buoy', 2600]],
          extras(s0, s1) {
            if (per(0.5)) placeCrane(s0, s1);
            if (per(0.6)) scatter('port', s0, s1);
            if (per(0.45)) scatter('warehouse', s0, s1);
            if (per(0.6)) scatter('cargoship', s0, s1);
            if (per(0.6)) scatter('dock', s0, s1);
            if (per(0.15)) scatter('lighthouse', s0, s1);
          },
        },
      },
    },

    // the grey zone of today's front: open fields between shelled tree lines, positions dug
    // into those tree lines, belts of dragon's teeth and wire, burnt-out vehicles, no one in the open
    ground: {
      alt: 1.3, speed: 7, margin: 1.2, band: 65, limit: 50, slope: 0.5, seg: [20, 28], segRef: 34, relief: 1.4, bumps: 0.16, even: 4,
      meander: [80, 120, 6, 9], lane: 6, agile: 1.5, lines: 0.6, // tree lines: chance of one across per step
      obs: { every: [10, 20], kinds: ['stump', 'stump', 'deadtree', 'crater', 'crater', 'hedgehog', 'hedgehog', 'hedgehog', 'sandbags', 'sandbags', 'block', 'wire', 'wreck', 'truck'] },
      gate: { chance: 0.35, kinds: ['hedgehog', 'hedgehog', 'block', 'stump', 'sandbags'], step: 3.2, slack: 1, shift: [3, 7], span: 16 },
      scatter: [['deadtree', 400], ['stump', 460], ['crater', 950], ['hedgehog', 800], ['sandbags', 1300], ['wire', 3000], ['block', 3400]],
      extras(s0, s1) {
        planForests(s1 + 50);
        burntForest(s0, s1);
        treeLines(s0, s1);
        if (per(0.2)) bigPit(s0, s1);
        if (per(0.12)) ruins(s0, s1);
        if (per(0.07)) checkpoint(s0, s1);
        if (per(0.13)) defenceBelt(s0, s1);
        if (per(0.4)) scatter('wreck', s0, s1);
        if (per(0.3)) scatter('truck', s0, s1);
      },
    },
  };
  let loc = window.fnavLoc === 'port' ? 'port' : 'open';
  // an environment's settings, with those of the chosen location laid over them
  const resolve = (name) => Object.assign({ amp: 1 }, ENV[name], ENV[name].locs ? ENV[name].locs[loc] : null);
  let envName = ENV[window.fnavEnv] ? window.fnavEnv : 'air', cfg = resolve(envName);

  const DEPTH = 190;
  /* Object pools grow on demand: a class gets a new instance whenever all of its existing
     ones are in use (up to cls.max). Released objects are reused.
     An object is a lightweight proxy (position, footprint, label) used by the planner and
     the HUD. Until its class has a loaded model it carries the hand-built placeholder;
     after that it is drawn through instancing (see bindInst) and stays empty itself. */
  const objects = [];
  const free = {}, made = {}, variants = {};
  Object.keys(CLASSES).forEach((type) => { free[type] = []; made[type] = 0; });
  function make(type) {
    const t = new THREE.Group();
    t.userData = { type, cls: CLASSES[type] };
    if (!variants[type]) CLASSES[type].build(t);
    t.visible = false;
    made[type]++;
    objects.push(t);
    scene.add(t);
    return t;
  }
  const take = (type) => free[type].pop() || (made[type] < (CLASSES[type].max || 400) ? make(type) : null);
  const release = (o) => { unbindInst(o); o.visible = false; free[o.userData.type].push(o); };

  /* ----- instanced drawing. Each loaded model (a "variant") is split into its meshes and
     every mesh becomes one InstancedMesh, so a hundred pines cost a handful of draw calls
     instead of hundreds. Instances live under instRoot, which sits at z = dist, so a
     standing object's matrix is written once when it is placed; only floating ones are
     rewritten every frame. Slots are kept packed: a freed slot takes the last instance. ----- */
  const instRoot = new THREE.Group();
  scene.add(instRoot);
  const iM = new THREE.Matrix4(), iM2 = new THREE.Matrix4(), iQ = new THREE.Quaternion(), iP = new THREE.Vector3();
  function growVariant(v, cap) {
    v.parts.forEach((p) => {
      const im = new THREE.InstancedMesh(p.m.geometry, p.m.material, cap);
      im.castShadow = im.receiveShadow = true;
      if (p.m.customDepthMaterial) im.customDepthMaterial = p.m.customDepthMaterial;
      im.frustumCulled = false;
      if (p.im) { im.instanceMatrix.array.set(p.im.instanceMatrix.array); instRoot.remove(p.im); p.im.dispose(); }
      im.count = v.objs.length;
      p.im = im;
      instRoot.add(im);
    });
    v.cap = cap;
  }
  function makeVariant(holder) {
    holder.updateMatrixWorld(true);
    const v = { parts: [], objs: [], cap: 0 };
    holder.traverse((m) => { if (m.isMesh) v.parts.push({ m, rel: m.matrixWorld.clone(), im: null }); });
    growVariant(v, 16);
    return v;
  }
  function syncInst(o) {
    const u = o.userData, v = u.variant;
    if (!v) return;
    iM.compose(iP.set(o.position.x, o.position.y, -u.s), iQ.setFromEuler(o.rotation), o.scale);
    v.parts.forEach((p) => { p.im.setMatrixAt(u.slot, iM2.multiplyMatrices(iM, p.rel)); p.im.instanceMatrix.needsUpdate = true; });
  }
  function bindInst(o) {
    const u = o.userData, vs = variants[u.type];
    if (!vs || u.variant) return;
    const v = pick(vs);
    if (v.objs.length === v.cap) growVariant(v, v.cap * 2);
    u.variant = v; u.slot = v.objs.length; v.objs.push(o);
    v.parts.forEach((p) => { p.im.count = v.objs.length; });
    syncInst(o);
  }
  function unbindInst(o) {
    const u = o.userData, v = u.variant;
    if (!v) return;
    const last = v.objs.pop();
    if (last !== o) { v.objs[u.slot] = last; last.userData.slot = u.slot; syncInst(last); }
    v.parts.forEach((p) => { p.im.count = v.objs.length; });
    u.variant = null;
  }

  /* ----- ready-made models (licence files sit next to them in models/): pines and dead
     trees by Quaternius, rocks, boats, buoys, cargo, crates and fences by Kenney, all CC0;
     broadleaf trees from a CGTrader tree pack, decimated for the web (see trees/LICENSE.txt).
     The hand-built shapes above are placeholders: they show at once and stay as the
     fallback (e.g. when the page is opened from disk and files cannot be fetched).
     Models are fetched per environment, the first time it is shown; once a class has
     loaded, every pooled object of that class swaps to a real model.
     fit = which dimension is matched to the class: 'h' height, 'w' footprint.
     set = the file holds several models side by side (five trees), used one by one. ----- */
  const BURNT_TONE = [0.25, [1.25, 1, 0.8]];
  const MODELS = {
    // tone: the toy-bright kits dulled to the greys and rust of the front (see prepare)
    pine: { env: 'air', fit: 'h', set: true, files: ['trees/pines'], tone: [0.8, 0.55, [0.95, 0.95, 0.9]] },
    tree: { env: 'air', fit: 'h', set: true, files: ['trees/pack01'], tone: [0.8, 0.5, [1, 0.95, 0.85]] },
    log: { env: 'sea', fit: 'w', files: ['log_large', 'log'], tone: [0.35, 0.4, [1, 0.92, 0.85]] },
    buoy: { env: 'sea', fit: 'h', files: ['watercraft/buoy', 'watercraft/buoy-flag'], tone: [0.7, 0.35, [1, 0.95, 0.9]] },
    container: { env: 'sea', fit: 'w', files: ['watercraft/cargo-container-a', 'watercraft/cargo-container-b', 'watercraft/cargo-container-c'], tone: [0.55, 0.2, [1.2, 1, 0.85]] },
    barrel: { env: 'sea', fit: 'w', files: ['pirate/barrel'] },
    debris: { env: 'sea', fit: 'w', files: ['pirate/crate', 'survival/box-large'], tone: [0.65, 0.45, [1, 0.95, 0.9]] },
    boat: { env: 'sea', fit: 'w', files: ['watercraft/boat-tug-a', 'watercraft/boat-tug-b', 'watercraft/boat-fishing-small', 'watercraft/boat-speed-a'], tone: [0.6, 0.12, [0.95, 1, 1]] },
    // the same boats burnt out and half sunk
    hulk: { env: 'sea', fit: 'w', files: ['watercraft/boat-tug-a', 'watercraft/boat-tug-b', 'watercraft/boat-fishing-small'], tone: [0.35, ...BURNT_TONE] },
    cargoship: { env: 'sea', fit: 'w', files: ['watercraft/ship-cargo-a', 'watercraft/ship-cargo-b', 'watercraft/ship-cargo-c'], tone: [0.55, 0.15, [1.1, 1, 0.92]] },
    deadtree: { env: ['ground', 'air'], fit: 'h', set: true, files: ['trees/dead'] },
    barricade: { env: ['ground', 'air'], fit: 'w', files: ['survival/fence-fortified'] },
    supply: { env: ['ground', 'air'], fit: 'w', files: ['survival/box-large', 'survival/barrel'] },
    // single models from poly.pizza (see models/poly/LICENSE.txt)
    mast: { env: 'air', fit: 'h', files: ['poly/pylon'] },
    lighthouse: { env: 'sea', fit: 'h', files: ['poly/lighthouse'], tone: [0.6, 0.25, [1.1, 1, 0.92]] },
    dock: { env: 'sea', fit: 'w', files: ['poly/dock'] },
    // pivot = keep the model's own origin (centre of the portal), so the jib overhang is not squeezed into the footprint
    crane: { env: 'sea', fit: 'h', pivot: true, files: ['port/crane-sokol'] },
    // burnt = colour factor that chars models which come clean (the Humvee is a scan of a real wreck)
    wreck: { env: ['ground', 'air'], fit: 'w', files: ['poly/broken-car', 'poly/pickup-armored', 'vehicles/humvee-wreck'], burnt: { 'poly/pickup-armored': 0.4, 'poly/broken-car': 0.75 } },
    // Sketchfab models (see models/vehicles/LICENSE.txt)
    truck: { env: ['ground', 'air'], fit: 'w', files: ['vehicles/gaz51-a', 'vehicles/gaz51-b', 'vehicles/gaz51-c'], burnt: { 'vehicles/gaz51-a': 0.4, 'vehicles/gaz51-b': 0.4, 'vehicles/gaz51-c': 0.4 } },
    sandbags: { env: ['ground', 'air'], fit: 'w', files: ['poly/sandbags', 'poly/sandbags-small'] },
    block: { env: ['ground', 'air'], fit: 'w', files: ['poly/barrier'] },
  };
  // hand-built classes are instanced too, from three pre-built variants each
  // (except those carrying glow sprites, which instancing cannot draw)
  Object.keys(CLASSES).forEach((type) => {
    if (MODELS[type]) return;
    const vs = [0, 1, 2].map(() => { const g = new THREE.Group(); CLASSES[type].build(g); return g; });
    let sprites = false;
    vs[0].traverse((m) => { if (m.isSprite) sprites = true; });
    if (!sprites) variants[type] = vs.map(makeVariant);
  });
  const loadModels = (() => {
    if (!THREE.GLTFLoader) return () => {};
    const loader = new THREE.GLTFLoader(), bb = new THREE.Box3(), size = new THREE.Vector3(), mid = new THREE.Vector3();
    if (window.MeshoptDecoder) loader.setMeshoptDecoder(window.MeshoptDecoder); // models are meshopt-compressed, textures WebP
    const asked = {};
    const load = (name) => new Promise((ok) => loader.load('models/' + name + '.glb', (g) => ok(g.scene), undefined, () => ok(null)));
    // pull the individual models out of a set, keeping the transforms of the nodes above them
    const split = (sc) => {
      sc.updateMatrixWorld(true);
      let node = sc;
      while (node.children.length === 1 && !node.isMesh) node = node.children[0];
      return node.children.slice().map((p) => {
        p.matrixWorld.decompose(p.position, p.quaternion, p.scale);
        node.remove(p);
        return p;
      });
    };
    // scale a model to its class, stand it on the ground (or sink it into the water), centre it
    // tone = [brightness, saturation kept, [r, g, b] tint]: burnt-out vehicles, or bright toy
    // colours dulled to the drab of the front
    const prepare = (node, cls, fit, pivot, tone) => {
      bb.setFromObject(node); bb.getSize(size); bb.getCenter(mid);
      const r = Math.max(size.x, size.z) / 2;
      const k = fit === 'h' ? cls.h / size.y : cls.w * 0.95 / r;
      const kxz = pivot ? k : Math.min(k, cls.w / r); // never wider than the footprint the route already assumes
      const inner = new THREE.Group();
      inner.add(node);
      inner.scale.set(kxz, k, kxz);
      inner.position.set(pivot ? 0 : -mid.x * kxz, (-bb.min.y - (cls.sink || 0) * size.y) * k, pivot ? 0 : -mid.z * kxz);
      node.traverse((m) => {
        if (!m.isMesh) return;
        m.castShadow = m.receiveShadow = true;
        // scanned models ship unlit (KHR_materials_unlit): give them a lit material, or they glow at night
        if (m.material.isMeshBasicMaterial) m.material = new THREE.MeshStandardMaterial({ map: m.material.map, side: m.material.side });
        (Array.isArray(m.material) ? m.material : [m.material]).forEach((mat) => {
          mat.metalness = 0; // some kits ship fully metallic materials, which render black here
          mat.roughness = 0.9;
          if (tone && !mat.userData.toned) { // meshes may share a material: tone it once
            mat.userData.toned = true;
            const [f, sat, [r, g, b]] = tone, key = `tone${sat},${r},${g},${b}`;
            mat.color.multiplyScalar(f);
            if (mat.emissive) mat.emissive.multiplyScalar(0.2); // no glowing windows on the front
            mat.onBeforeCompile = (sh) => {
              sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
                diffuseColor.rgb = mix(vec3(dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11))), diffuseColor.rgb, ${sat.toFixed(2)}) * vec3(${r.toFixed(2)}, ${g.toFixed(2)}, ${b.toFixed(2)});`);
            };
            mat.customProgramCacheKey = () => key; // the same function with other numbers: keep the programs apart
          }
          if (mat.transparent || mat.alphaTest > 0) { // leaf cards: hard cut-out instead of blending, so they sort and shadow correctly
            mat.transparent = false;
            mat.alphaTest = 0.5;
            mat.side = THREE.DoubleSide;
            m.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: mat.map, alphaTest: 0.5 });
          }
        });
      });
      const holder = new THREE.Group();
      holder.add(inner);
      return holder;
    };
    const BURNT = [0.25, [1.25, 1, 0.8]];
    const toneOf = (spec, file) => (spec.burnt && spec.burnt[file] ? [spec.burnt[file], ...BURNT] : spec.tone || null);
    return (env) => Object.keys(MODELS).forEach((type) => {
      const spec = MODELS[type], cls = CLASSES[type];
      if (!(spec.env === env || (Array.isArray(spec.env) && spec.env.includes(env))) || asked[type]) return;
      asked[type] = true;
      Promise.all(spec.files.map(load)).then((scenes) => {
        const list = [];
        scenes.forEach((sc, i) => sc && (spec.set ? split(sc) : [sc]).forEach((n) => list.push(prepare(n, cls, spec.fit, spec.pivot, toneOf(spec, spec.files[i])))));
        if (!list.length) return;
        variants[type] = list.map(makeVariant); // objects made from now on are drawn instanced straight away
        objects.forEach((o) => {
          if (o.userData.type !== type) return;
          while (o.children.length) o.remove(o.children[0]); // drop the placeholder
          if (o.visible) bindInst(o);
        });
        if (!raf) render();
      });
    });
  })();

  // crop fields: striped patches in a few crop colours, draped over the relief
  const rowTex = (() => {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 8;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, 64, 8);
    g.fillStyle = 'rgba(0,0,0,.28)';
    for (let x = 0; x < 64; x += 8) g.fillRect(x, 0, 3, 8);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(14, 1);
    return t;
  })();
  const CROPS = [0x6e6545, 0x56593a, 0x3a3128, 0x2c2723, 0x77704f]; // unharvested stubble, weeds, bare and burnt earth
  const fields = [], freeFields = [];
  for (let i = 0; i < 16; i++) {
    const g = new THREE.PlaneGeometry(1, 1, 10, 20).rotateX(-Math.PI / 2);
    const f = new THREE.Mesh(g, std(0xffffff, { map: rowTex, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    f.userData.grid = g.attributes.position.array.slice(); // unit grid, stretched per use
    f.receiveShadow = true;
    f.visible = false;
    fields.push(f); freeFields.push(f);
    scene.add(f);
  }
  function placeField(s0, s1) {
    const f = freeFields.pop(), sx = rand(18, 38), sz = (s1 - s0) * rand(0.8, 1.3);
    const s = (s0 + s1) / 2, x = wp[wp.length - 1].x + rand(-cfg.band, cfg.band);
    const p = f.geometry.attributes.position, grid = f.userData.grid;
    for (let i = 0; i < p.count; i++) {
      const gx = grid[i * 3] * sx, gz = grid[i * 3 + 2] * sz;
      p.setXYZ(i, gx, terrainH(x + gx, s - gz) + 0.06, gz);
    }
    p.needsUpdate = true;
    f.geometry.computeVertexNormals();
    f.geometry.computeBoundingSphere();
    Object.assign(f.userData, { s, len: sz });
    f.position.set(x, 0, dist - s);
    f.material.color.set(pick(CROPS));
    f.visible = true;
  }

  /* ----- battlefield litter and shell craters. Litter is thousands of small instanced
     pieces (stones, clods, brick, splinters, scrap, casings) that are never obstacles;
     a piece that falls behind is moved to the far end of the view. Craters are dents in
     the terrain itself (see terrainH), recycled the same way. ----- */
  const LITTER = [
    { g: rough(new THREE.IcosahedronGeometry(0.15, 0), 0.06, 11), m: std(0x4d4945, { flatShading: true }), n: 650, lift: 0.04 },
    { g: rough(new THREE.DodecahedronGeometry(0.16, 0), 0.06, 4), m: mats.earth, n: 650, lift: 0.02 },
    { g: new THREE.BoxGeometry(0.24, 0.07, 0.11), m: std(0x8a4a36), n: 280, lift: 0.03 },
    { g: new THREE.BoxGeometry(0.9, 0.04, 0.12), m: mats.timber, n: 200, lift: 0.02, tilt: 0.15 },
    { g: new THREE.BoxGeometry(0.55, 0.02, 0.38), m: std(0x4a352a, { metalness: 0.3, roughness: 0.7 }), n: 200, lift: 0.03, tilt: 0.35 },
    { g: new THREE.CylinderGeometry(0.035, 0.035, 0.22, 6).rotateZ(Math.PI / 2), m: std(0xb08a3a, { metalness: 0.5, roughness: 0.45 }), n: 200, lift: 0.035 },
    { g: new THREE.BoxGeometry(0.35, 0.18, 0.3), m: mats.deadwood, n: 180, lift: 0.06, tilt: 0.4 }, // charred chunks
    { g: rough(new THREE.CylinderGeometry(0.03, 0.06, 1.6, 5, 3).rotateZ(Math.PI / 2), 0.04, 8), m: std(0x33281f, { flatShading: true }), n: 220, lift: 0.04, tilt: 0.06, size: [0.5, 1.1] }, // branches shot off the trees
  ];
  // bump = how hard a piece kicks the hull when a wheel runs over it (per metre of its size)
  [0.15, 0.12, 0.08, 0.05, 0.04, 0.02, 0.18, 0.08].forEach((b, i) => { LITTER[i].bump = b; });
  const litter = new THREE.Group();
  litter.visible = false;
  scene.add(litter);
  // a kind is one shape (g, m) or several drawn together (parts), e.g. a turf chunk with its grass
  function addLitter(K) {
    K.meshes = (K.parts || [{ g: K.g, m: K.m }]).map(({ g, m }) => {
      const im = new THREE.InstancedMesh(g, m, K.n);
      im.receiveShadow = true;
      im.frustumCulled = false;
      litter.add(im);
      return im;
    });
    Object.assign(K, { x: new Float32Array(K.n), s: new Float64Array(K.n), rx: new Float32Array(K.n), ry: new Float32Array(K.n), rz: new Float32Array(K.n), k: new Float32Array(K.n) });
  }
  LITTER.forEach(addLitter);
  // how many pieces are drawn, and whether they cast shadows (grass never does: thousands of cut-out cards)
  const litterQuality = (K) => K.meshes.forEach((im) => { im.count = Math.round(K.n * Q.litter * (cfg.litter || 1)); im.castShadow = quality === 2 && !K.grass; });
  const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), e3 = new THREE.Euler(), pv = new THREE.Vector3(), sv = new THREE.Vector3();
  // stand piece i of kind K on the ground; the group sits at z = dist, so a piece's local z is -s
  function setLitter(K, i) {
    pv.set(K.x[i], terrainH(K.x[i], K.s[i]) + K.lift * K.k[i], -K.s[i]);
    q4.setFromEuler(e3.set(K.rx[i], K.ry[i], K.rz[i]));
    m4.compose(pv, q4, sv.setScalar(K.k[i]));
    K.meshes.forEach((im) => im.setMatrixAt(i, m4));
    K.dirty = true;
  }
  function placeLitter(k, i, s) {
    const K = LITTER[k], t = K.tilt || 0.1, size = K.size || [0.6, 1.6];
    K.s[i] = s; K.x[i] = pathX(s) + rand(-55, 55) * Math.sqrt(Math.random()); // denser near the track
    K.rx[i] = rand(-t, t); K.ry[i] = rand(0, 6.3); K.rz[i] = rand(-t, t); K.k[i] = rand(size[0], size[1]);
    if (K.grass && inForest(s)) K.k[i] = 0.001;           // burnt ground: no grass
    setLitter(K, i);
  }
  const scatterLitter = (k) => {
    const K = LITTER[k];
    for (let i = 0; i < K.n; i++) placeLitter(k, i, dist + rand(-5, DEPTH));
    K.meshes.forEach((im) => { im.instanceMatrix.needsUpdate = true; });
  };

  /* ----- grass and fallen sticks, from two small files (see models/grass and models/sticks).
     They join the litter once loaded with the other ground models; until then the field is bare.
     Each grass clump is three crossed cards; every clump gets its own shade between a tired
     green and dry straw, so the field reads late-summer and trampled rather than lawn.
     size = scale range in metres (a clump is 1 high, a stick 1 long). ----- */
  const DRY = [new THREE.Color(0x8f9a5a), new THREE.Color(0xc9b27a), new THREE.Color(0x9a8a62)];
  const LITTER_FILES = [
    { file: 'grass/cards', kinds: [
      { node: 'grass1', n: 900, size: [0.3, 0.75], grass: true, shade: true },
      { node: 'grass2', n: 800, size: [0.35, 0.9], grass: true, shade: true },
      { node: 'grass3', n: 700, size: [0.25, 0.6], grass: true, shade: true },
    ] },
    { file: 'sticks/sticks', kinds: [1, 2, 3, 4, 5, 6].map((k) => ({ node: 'stick' + k, n: 70, size: [0.3, 1.0], lift: -0.03, tilt: 0.08 })) },
  ];
  function loadGrass() {
    if (!THREE.GLTFLoader || loadGrass.done) return;
    loadGrass.done = true;
    const loader = new THREE.GLTFLoader();
    LITTER_FILES.forEach((F) => loader.load('models/' + F.file + '.glb', (gltf) => {
      F.kinds.forEach((G) => {
        const node = gltf.scene.getObjectByName(G.node);
        if (!node || !node.isMesh) return;
        const mat = node.material;
        mat.metalness = 0; mat.roughness = 1;
        if (G.grass) {
          mat.transparent = false; mat.alphaTest = 0.5; mat.side = THREE.DoubleSide;
          // the cards carry upward normals (lit like the ground under them); a double-sided material
          // would turn them downwards on the back faces, and half the clumps would come out black
          mat.onBeforeCompile = (sh) => {
            sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>',
              THREE.ShaderChunk.normal_fragment_begin.replace('gl_FrontFacing ? 1.0 : - 1.0', '1.0'));
          };
        }
        const K = { g: node.geometry, m: mat, n: G.n, size: G.size, lift: G.lift || 0, tilt: G.tilt || 0.06, grass: !!G.grass, bump: G.grass ? 0 : 0.14 };
        addLitter(K);
        if (G.shade) K.meshes.forEach((im) => {
          const c = new THREE.Color();
          for (let i = 0; i < K.n; i++) im.setColorAt(i, c.copy(pick(DRY)).lerp(pick(DRY), Math.random()));
          im.instanceColor.needsUpdate = true;
        });
        litterQuality(K);
        LITTER.push(K);
        if (envName === 'ground') scatterLitter(LITTER.length - 1);
      });
      if (!raf) render();
    }));
  }
  function spawnCrater(c, s0, s1) {
    // shells land in groups: most new craters open next to one already in this stretch
    const near = craters.filter((o) => o !== c && o.w > 0 && o.y > s0 - 15 && o.y < s1);
    for (let i = 0; i < 8; i++) {
      const big = Math.random() < 0.2, r = big ? rand(2.5, 4) : rand(0.9, 2.2), o = near.length && Math.random() < 0.6 ? pick(near) : null;
      const s = o ? o.y + rand(-8, 8) : rand(s0, s1), x = o ? clamp(o.x + rand(-8, 8), pathX(s) - CR_SIDE, pathX(s) + CR_SIDE) : pathX(s) + rand(-CR_SIDE, CR_SIDE);
      // never under an object: a solid thing cannot follow the dent and would hang over it
      if (objects.some((o) => o.visible && Math.hypot(x - o.position.x, s - o.userData.s) < r * 1.5 + o.userData.w * 0.6) || (big && Math.abs(x - pathX(s)) < r + 2)) continue;
      c.set(x, s, r, r * rand(0.24, 0.34));
      // re-seat the litter the new dent has moved
      LITTER.forEach((K) => { for (let j = 0; j < K.n; j++) if (Math.abs(K.s[j] - s) < r * 1.8 && Math.hypot(K.x[j] - x, K.s[j] - s) < r * 1.8) setLitter(K, j); });
      return;
    }
    c.set(0, s1, 1, 0); // nowhere free: stay flat, try again once passed
  }
  function updateLitter() {
    litter.position.z = dist;
    for (let i = 0; i < CR_RAND; i++) if (craters[i].y < dist - 10) spawnCrater(craters[i], dist + DEPTH - 30, dist + DEPTH);
    // craters being dug as they come closer (see crFade): keep the litter on them lying on the ground
    const digging = craters.filter((c) => c.w > 0 && c.y - dist > CR_NEAR - 2 * c.z && c.y - dist < CR_FAR + 2 * c.z);
    const s0 = dist + CR_NEAR - 10, s1 = dist + CR_FAR + 10;
    LITTER.forEach((K, k) => {
      for (let i = 0; i < K.n; i++) {
        if (K.s[i] < dist - 6) placeLitter(k, i, K.s[i] + DEPTH + 5);
        else if (K.s[i] > s0 && K.s[i] < s1) {
          for (const c of digging) if (Math.abs(K.s[i] - c.y) < c.z * 1.8 && Math.abs(K.x[i] - c.x) < c.z * 1.8) { setLitter(K, i); break; }
        }
      }
      if (K.dirty) { K.meshes.forEach((im) => { im.instanceMatrix.needsUpdate = true; }); K.dirty = false; }
    });
  }

  /* ----- smoke over the battlefield: a few columns rising from burning wrecks and fresh hits
     far ahead, all puffs drawn in one call (instanced billboards; size, fade and drift are
     worked out in the shader from each puff's age). At night the foot of a column glows. ----- */
  const PLUMES = 8, PUFFS = 24, FLAMES = 6; // columns in use: cfg.plumes (5 unless set)
  const puffTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    for (let i = 0; i < 9; i++) {                        // a lumpy cloud, not a perfect disc
      const x = 32 + rand(-9, 9), y = 32 + rand(-9, 9), r = rand(12, 20);
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(255,255,255,.35)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    }
    return new THREE.CanvasTexture(c);
  })();
  const smokeGeo = new THREE.InstancedBufferGeometry();
  smokeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  smokeGeo.setIndex([0, 1, 2, 0, 2, 3]);
  const puffPos = new THREE.InstancedBufferAttribute(new Float32Array(PLUMES * PUFFS * 3), 3);
  const puffArg = new THREE.InstancedBufferAttribute(new Float32Array(PLUMES * PUFFS * 4), 4); // age, size, darkness, spin
  puffPos.setUsage(THREE.DynamicDrawUsage);
  smokeGeo.setAttribute('aPos', puffPos);
  smokeGeo.setAttribute('aArg', puffArg);
  smokeGeo.instanceCount = PLUMES * PUFFS;
  const smokeMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: {
      uTex: { value: puffTex }, uDark: { value: new THREE.Color() }, uLight: { value: new THREE.Color() },
      uFire: { value: new THREE.Color() }, uFog: { value: new THREE.Color() }, uFogD: { value: 0 },
    },
    vertexShader: `attribute vec3 aPos; attribute vec4 aArg; varying vec2 vUv; varying float vT; varying float vDark; varying float vFog;
      uniform float uFogD;
      void main(){
        float t = aArg.x, size = aArg.y * (1.5 + 9.0 * sqrt(t)), c = cos(aArg.w + t * 1.5), s = sin(aArg.w + t * 1.5);
        vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
        mv.xy += mat2(c, s, -s, c) * position.xy * size;
        gl_Position = projectionMatrix * mv;
        vUv = position.xy + 0.5; vT = t; vDark = aArg.z;
        vFog = 1.0 - exp(-uFogD * uFogD * mv.z * mv.z * 0.45); // thinner than the ground fog, so columns read from afar
      }`,
    fragmentShader: `uniform sampler2D uTex; uniform vec3 uDark; uniform vec3 uLight; uniform vec3 uFire; uniform vec3 uFog;
      varying vec2 vUv; varying float vT; varying float vDark; varying float vFog;
      void main(){
        float a = texture2D(uTex, vUv).a * smoothstep(0.0, 0.08, vT) * pow(1.0 - vT, 1.4);
        vec3 col = mix(uLight, uDark, vDark * (1.0 - vT * 0.6));
        col += uFire * (1.0 - smoothstep(0.0, 0.16, vT));
        gl_FragColor = vec4(mix(col, uFog, vFog), a * 0.85 * (1.0 - vFog * 0.6));
        #include <tonemapping_fragment>
        #include <encodings_fragment>
      }`,
  });
  const smoke = new THREE.Mesh(smokeGeo, smokeMat);
  smoke.frustumCulled = false;
  smoke.renderOrder = 2;
  smoke.visible = false;
  scene.add(smoke);
  const wind = new THREE.Vector2(rand(0.35, 0.6) * (Math.random() < 0.5 ? -1 : 1), rand(-0.25, 0.15)); // drift per metre of rise
  const plumes = Array.from({ length: PLUMES }, () => ({ x: 0, s: -1e6, y: 0, h: 20, rate: 0.1, dark: 0.5, fire: glow(0xff5a14, 3) }));
  plumes.forEach((p) => { p.fire.visible = false; scene.add(p.fire); });
  // flames: tongues of fire drawn in the shader (a flickering, tapering blob, white-yellow at the
  // root, red at the tips), additive, one call for all of them
  const flameGeo = new THREE.InstancedBufferGeometry();
  flameGeo.setAttribute('position', smokeGeo.getAttribute('position'));
  flameGeo.setIndex(smokeGeo.getIndex());
  const flamePos = new THREE.InstancedBufferAttribute(new Float32Array(PLUMES * FLAMES * 3), 3);
  const flameArg = new THREE.InstancedBufferAttribute(new Float32Array(PLUMES * FLAMES * 4), 4); // width, height, seed, strength
  flamePos.setUsage(THREE.DynamicDrawUsage);
  flameGeo.setAttribute('aPos', flamePos);
  flameGeo.setAttribute('aArg', flameArg);
  flameGeo.instanceCount = PLUMES * FLAMES;
  const flameMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: U.time, uFogD: { value: 0 }, uGain: { value: 1 } },
    vertexShader: `attribute vec3 aPos; attribute vec4 aArg; uniform float uTime; uniform float uFogD;
      varying vec2 vUv; varying float vSeed; varying float vA;
      void main(){
        float fl = 0.8 + 0.2 * sin(uTime * 11.0 + aArg.z * 7.0) + 0.1 * sin(uTime * 23.0 + aArg.z);
        vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
        mv.xy += vec2(position.x * aArg.x, (position.y + 0.5) * aArg.y * fl);
        gl_Position = projectionMatrix * mv;
        vUv = position.xy + 0.5; vSeed = aArg.z;
        vA = aArg.w * exp(-uFogD * uFogD * mv.z * mv.z * 0.35);
      }`,
    fragmentShader: `uniform float uTime; uniform float uGain; varying vec2 vUv; varying float vSeed; varying float vA;
      void main(){
        vec2 p = vUv * 2.0 - 1.0;
        p.x += sin(vUv.y * 7.0 - uTime * 9.0 + vSeed * 3.0) * 0.18 * vUv.y;
        float w = mix(0.95, 0.12, pow(vUv.y, 0.8));                 // wide at the root, a tip at the top
        float a = smoothstep(w, w * 0.25, abs(p.x)) * smoothstep(1.0, 0.55, vUv.y) * smoothstep(0.0, 0.12, vUv.y);
        vec3 col = mix(vec3(1.0, 0.86, 0.5), vec3(1.0, 0.32, 0.06), smoothstep(0.1, 0.8, vUv.y));
        gl_FragColor = vec4(col * a * vA * uGain, a * vA);
      }`,
  });
  const flames = new THREE.Mesh(flameGeo, flameMat);
  flames.frustumCulled = false;
  flames.renderOrder = 3;
  scene.add(flames);
  plumes.forEach((p) => { p.tongues = Array.from({ length: FLAMES }, () => ({ dx: 0, dz: 0, w: 1, h: 2, seed: rand(0, 100) })); });
  const BURNS = { wreck: true, truck: true, hulk: true, port: true, warehouse: true }; // what may be on fire
  // light a column somewhere ahead: on a wreck when there is one far enough out, else on open ground
  function spawnPlume(p, s0, s1) {
    const w = objects.filter((o) => o.visible && BURNS[o.userData.type] && o.userData.s > s0 && o.userData.s < s1 && !plumes.some((q) => q.wreck === o));
    const o = w.length && Math.random() < 0.6 ? pick(w) : null;
    p.wreck = o;
    p.s = o ? o.userData.s : rand(s0, s1 + 120);
    p.x = o ? o.position.x : pathX(Math.min(p.s, dist + DEPTH)) + rand(-110, 110);
    p.y = terrainH(p.x, p.s, true) + (o ? (o.userData.type === 'port' || o.userData.type === 'warehouse' ? 2.4 : 0.6) : 0);
    if (o && (o.userData.type === 'port')) p.x = o.position.x + (o.rotation.y ? -1 : 1) * rand(6, 12); // on the quay, not in the water
    p.h = rand(18, 40); p.rate = rand(0.05, 0.09); p.dark = o ? rand(0.75, 1) : rand(0.2, 0.7); p.seed = rand(0, 100);
    p.fire.scale.setScalar(o ? 3.5 : 2.2);
    p.fire.material.opacity = o ? 0.8 : 0.5;
    // the fire itself: a burning hull or vehicle has a big one, open ground a small one
    const big = o ? 1 : 0.45, spread = o ? o.userData.w * 0.6 : 0.8;
    p.flame = Math.random() < (o ? 1 : 0.5) ? big : 0;
    p.tongues.forEach((t) => Object.assign(t, { dx: rand(-spread, spread), dz: rand(-spread, spread), w: rand(0.7, 1.4) * big + 0.3, h: rand(1.4, 3.2) * big + 0.4 }));
  }
  function updateSmoke() {
    const active = cfg.plumes || 5;
    plumes.forEach((p, k) => {
      if (k >= active) p.s = -1e6;                       // not in use here: an old puff, invisible
      else if (p.s < dist - 20) spawnPlume(p, dist + 90, dist + DEPTH);
      p.fire.visible = k < active && !day;
      p.fire.position.set(p.x, p.y + 0.8, dist - p.s);
      p.tongues.forEach((t, i) => {
        const j = k * FLAMES + i, on = k < active && p.flame;
        flamePos.setXYZ(j, p.x + t.dx, p.y - 0.3, dist - p.s + t.dz);
        flameArg.setXYZW(j, t.w, t.h, t.seed, on ? 0.9 : 0);
      });
      for (let i = 0; i < PUFFS; i++) {
        const j = k * PUFFS + i, t = k < active ? (time * p.rate + i / PUFFS) % 1 : 0.999, rise = t * p.h;
        const wob = Math.sin(t * 7 + p.seed + i) * (0.4 + t * 2);
        puffPos.setXYZ(j, p.x + wind.x * rise + wob, p.y + rise, dist - p.s - wind.y * rise);
        puffArg.setXYZW(j, t, 0.6 + 0.4 * Math.abs(Math.sin(p.seed + i * 1.7)), p.dark, p.seed + i * 2.4);
      }
    });
    puffPos.needsUpdate = puffArg.needsUpdate = true;
    flamePos.needsUpdate = flameArg.needsUpdate = true;
  }

  /* ----- mist: low banks lying in the fields off to the left or right, wide soft billboards
     drawn in one call like the smoke. They fade out as they come close, so their flat cards are
     never seen up near, and drift a little. Over the farmland and the battlefield, not at sea. ----- */
  const BANKS = 6, SHEETS = 8;
  const mistGeo = new THREE.InstancedBufferGeometry();
  mistGeo.setAttribute('position', smokeGeo.getAttribute('position'));
  mistGeo.setIndex(smokeGeo.getIndex());
  const mistPos = new THREE.InstancedBufferAttribute(new Float32Array(BANKS * SHEETS * 3), 3);
  const mistArg = new THREE.InstancedBufferAttribute(new Float32Array(BANKS * SHEETS * 3), 3); // width, height, opacity
  mistPos.setUsage(THREE.DynamicDrawUsage);
  mistGeo.setAttribute('aPos', mistPos);
  mistGeo.setAttribute('aArg', mistArg);
  mistGeo.instanceCount = BANKS * SHEETS;
  const mistMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uTex: { value: puffTex }, uCol: { value: new THREE.Color() }, uFog: { value: new THREE.Color() }, uFogD: { value: 0 } },
    vertexShader: `attribute vec3 aPos; attribute vec3 aArg; varying vec2 vUv; varying float vA; varying float vFog; uniform float uFogD;
      void main(){
        vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
        mv.xy += position.xy * aArg.xy;
        gl_Position = projectionMatrix * mv;
        vUv = position.xy + 0.5;
        vA = aArg.z * smoothstep(14.0, 40.0, -mv.z);
        vFog = 1.0 - exp(-uFogD * uFogD * mv.z * mv.z);
      }`,
    fragmentShader: `uniform sampler2D uTex; uniform vec3 uCol; uniform vec3 uFog; varying vec2 vUv; varying float vA; varying float vFog;
      void main(){
        gl_FragColor = vec4(mix(uCol, uFog, vFog), texture2D(uTex, vUv).a * vA);
        #include <tonemapping_fragment>
        #include <encodings_fragment>
      }`,
  });
  const mist = new THREE.Mesh(mistGeo, mistMat);
  mist.frustumCulled = false;
  mist.renderOrder = 1;
  scene.add(mist);
  const banks = Array.from({ length: BANKS }, () => ({ s: -1e6, x: 0, sheets: [] }));
  function spawnBank(b, s0, s1) {
    const side = Math.random() < 0.5 ? -1 : 1;
    b.s = rand(s0, s1);
    b.x = pathX(Math.min(b.s, dist + DEPTH)) + side * rand(10, 50);
    b.sheets = Array.from({ length: SHEETS }, () => {
      const w = rand(16, 30), h = rand(3.5, 7);
      return { dx: rand(-12, 12), ds: rand(-18, 18), w, h, a: rand(0.32, 0.55), ph: rand(0, 6) };
    });
  }
  function updateMist() {
    banks.forEach((b, k) => {
      if (b.s < dist - 20) spawnBank(b, dist + 120, dist + DEPTH + 60);
      b.sheets.forEach((q, i) => {
        const j = k * SHEETS + i, ss = b.s + q.ds, x = b.x + q.dx + Math.sin(time * 0.04 + q.ph) * 3;
        mistPos.setXYZ(j, x, terrainH(x, ss, true) + q.h * 0.45, dist - ss);
        mistArg.setXYZ(j, q.w, q.h, q.a);
      });
    });
    mistPos.needsUpdate = mistArg.needsUpdate = true;
  }

  /* ----- the war beyond the horizon at night: flashes of distant shelling, low on the skyline.
     They ride with the sky, so they never come closer. ----- */
  const flashes = Array.from({ length: 3 }, () => {
    const f = glow(0xff9a50, 40);
    f.material.opacity = 0;
    f.userData = { next: rand(1, 6), t: 1 };
    skyGroup.add(f);
    return f;
  });
  // clouds drift; at night the brightest shell flash lights the cloud bases above it
  const flashCol = new THREE.Color(0xff8a40);
  function updateClouds(dt) {
    cloudMat.uniforms.uTime.value += dt;
    let f = null;
    if (!day) for (const g of flashes) if (!f || g.material.opacity > f.material.opacity) f = g;
    if (f) cloudMat.uniforms.uFlashDir.value.copy(f.position).normalize();
    cloudMat.uniforms.uFlash.value.copy(flashCol).multiplyScalar(f ? f.material.opacity * 1.6 : 0);
  }
  function updateFlashes(dt) {
    flashes.forEach((f) => {
      const u = f.userData;
      if ((u.next -= dt) < 0) {
        const a = rand(-1.1, 1.1) + (Math.random() < 0.3 ? Math.PI : 0);
        f.position.set(Math.sin(a) * 380, rand(4, 14), -Math.cos(a) * 380);
        f.scale.setScalar(rand(25, 55));
        u.next = rand(1.5, 7); u.t = 0; u.peak = rand(0.15, 0.4);
      }
      u.t += dt;
      f.material.opacity = u.peak * Math.exp(-u.t * 5) * (u.t < 0.05 ? u.t / 0.05 : 1);
    });
  }

  /* ----- route planning.
     s = distance along the track. The route is a chain of waypoints {s, x, vx, y, vy}
     (x across, y = altitude above ground for the drone, v = slope d/ds) joined by quintic
     Hermite curves: position and slope carry through every joint and the curvature is
     zero there, so a turn flows into the next one instead of stopping and restarting.
     The world ahead is generated one planning step at a time: first the step is filled
     with objects across the whole strip, then the planner tries sideways (and, in the
     air, vertical) targets, cheapest first, and keeps the first one whose curve clears
     every object. The cost prefers flying straight and drifting towards a goal that
     changes every few hundred metres, so the route sweeps far left and right. ----- */
  let dist = 0, time = 0, goal = 0, goalUntil = 0, prefY = 0;
  const bend = { phase: 0, len: 150, amp: 0 }; // the meander of a winding track (cfg.meander)
  const wp = [];
  // quintic Hermite from (p0, slope v0) to (p1, slope v1) over length L, zero curvature at both ends;
  // order 0 = position, 1 = slope d/ds, 2 = curvature d2/ds2
  function hermite(p0, v0, p1, v1, L, t, order) {
    const t2 = t * t, t3 = t2 * t, t4 = t3 * t, t5 = t4 * t, m0 = v0 * L, m1 = v1 * L;
    if (order === 1) return ((p1 - p0) * (30 * t2 - 60 * t3 + 30 * t4) + m0 * (1 - 18 * t2 + 32 * t3 - 15 * t4) + m1 * (-12 * t2 + 28 * t3 - 15 * t4)) / L;
    if (order === 2) return ((p1 - p0) * (60 * t - 180 * t2 + 120 * t3) + m0 * (-36 * t + 96 * t2 - 60 * t3) + m1 * (-24 * t + 84 * t2 - 60 * t3)) / (L * L);
    return p0 + (p1 - p0) * (10 * t3 - 15 * t4 + 6 * t5) + m0 * (t - 6 * t3 + 8 * t4 - 3 * t5) + m1 * (-4 * t3 + 7 * t4 - 3 * t5);
  }
  // k = 'x' sideways or 'y' altitude; past the last waypoint the route runs on in a straight line
  function route(s, order, k = 'x') {
    let i = wp.length - 2;
    while (i > 0 && wp[i].s > s) i--;
    const a = wp[i], b = wp[i + 1], v = 'v' + k;
    if (s > b.s) return order === 0 ? b[k] + b[v] * (s - b.s) : order === 1 ? b[v] : 0;
    return hermite(a[k], a[v], b[k], b[v], b.s - a.s, clamp((s - a.s) / (b.s - a.s), 0, 1), order);
  }
  const pathX = (s) => route(s, 0);
  // the road: the route averaged over 60 m, so it runs smooth through the swerves round obstacles
  const roadX = (s) => {
    let sum = 0, wsum = 0;
    for (let o = -30; o <= 30; o += 5) { const w = 31 - Math.abs(o); sum += pathX(s + o) * w; wsum += w; }
    return sum / wsum;
  };
  let roadFrom = -1e9;
  function updateRoad() {
    const s0 = Math.floor(dist) - ROAD_BACK;
    if (s0 === roadFrom) return;
    roadFrom = s0;
    for (let i = 0; i < ROAD_N; i++) {
      const v = Math.round(clamp((roadX(s0 + i) + ROAD_SPAN / 2) / ROAD_SPAN, 0, 1) * 65535);
      roadData[i * 4] = v >> 8; roadData[i * 4 + 1] = v & 255;
    }
    roadTex.needsUpdate = true;
    U.roadS0.value = s0;
  }
  const pathY = (s) => route(s, 0, 'y');

  // would a route point (x, altitude y) at s strike object o? A drone may pass over low ones.
  const hits = (o, x, y, s) => {
    const u = o.userData;
    if (!o.visible || Math.hypot(x - o.position.x, s - u.s) >= u.w + cfg.margin) return false;
    return !(cfg.overfly && y >= u.h + cfg.overfly);
  };
  // would an object at (x, s) stand on the route already planned (or its straight continuation)?
  const onRoute = (x, s, w, h) => {
    for (let ds = -(w + cfg.margin); ds <= w + cfg.margin; ds += 1) {
      if (Math.hypot(x - pathX(s + ds), ds) < w + cfg.margin && !(cfg.overfly && pathY(s + ds) >= h + cfg.overfly)) return true;
    }
    return false;
  };
  // does it touch anything already standing? (no house inside a tree, no crate inside a pier)
  const inCrater = (x, s, w) => bumpA > 0 && craters.some((c) => c.w > 0 && Math.hypot(x - c.x, s - c.y) < c.z * 1.5 + w * 0.6);
  const overlaps = (x, s, w) => inCrater(x, s, w) || objects.some((o) => o.visible &&
    Math.hypot(x - o.position.x, s - o.userData.s) < w + o.userData.w + 0.8);
  // distance to the nearest standing object (used to fill the gaps first)
  const room = (x, s) => {
    let d = 1e9;
    for (const o of objects) if (o.visible && Math.abs(s - o.userData.s) < d) d = Math.min(d, Math.hypot(x - o.position.x, s - o.userData.s) - o.userData.w);
    return d;
  };

  function put(o, x, s, scale, side) {
    const c = o.userData.cls, w = c.w * scale;
    o.scale.setScalar(scale);
    o.rotation.set(0, c.face ? (side > 0 ? 0 : Math.PI)
      : c.across ? rand(-0.25, 0.25)
      : c.along ? rand(-0.12, 0.12) + (Math.random() < 0.5 ? 0 : Math.PI)
      : c.far ? rand(-0.5, 0.5) + (Math.random() < 0.5 ? 0 : Math.PI / 2)
      : rand(0, Math.PI * 2), 0);
    if (c.lean) { o.rotation.x = rand(-c.lean, c.lean); o.rotation.z = rand(-c.lean, c.lean); }
    // stand it at the lowest point of its footprint: sunk a little on a slope, never floating
    let y = terrainH(x, s, true);
    if (terrA) for (const [dx, ds] of [[w, 0], [-w, 0], [0, w], [0, -w]]) y = Math.min(y, terrainH(x + dx, s + ds, true));
    o.position.set(x, y, dist - s);
    Object.assign(o.userData, { s, w, h: c.h * scale, conf: rand(0.84, 0.95), phase: rand(0, 6) });
    o.visible = true;
    bindInst(o);
  }

  // place one object anywhere in the strip of [s0, s1]; near the start of the step it must
  // keep clear of the route that is already fixed there
  function scatter(type, s0, s1, xOf) {
    const o = take(type);
    if (!o) return;
    const c = o.userData.cls, scale = c.fixed ? 1 : rand(0.8, 1.35), w = c.w * scale, h = c.h * scale;
    const cx = wp[wp.length - 1].x;
    // on the battlefield, of a few free spots take the one furthest from everything else, so the
    // field fills evenly instead of in clumps with bare patches between them
    let best = null, bestRoom = -1;
    for (let i = 0, ok = 0; i < 12 && ok < (cfg.even || 1); i++) {
      const s = rand(s0, s1), x = xOf ? xOf(cx) : cx + rand(-cfg.band, cfg.band);
      if (s - w - cfg.margin < s0 + 8 && onRoute(x, s, w, h)) continue;
      if (cfg.lane && Math.abs(x - lane(s)) < w + cfg.lane) continue;
      if (overlaps(x, s, w)) continue;
      ok++;
      const r = cfg.even ? room(x, s) : 0;
      if (r > bestRoom) { best = [x, s]; bestRoom = r; }
    }
    if (best) { put(o, best[0], best[1], scale, best[0] > cx ? 1 : -1); return o; }
    release(o);
  }

  /* ----- the battlefield layout. Tree lines (windbreaks between fields) are what is left
     standing on the front: rows of leafless, shelled trees and snapped trunks. Every so often
     one crosses the track, with a gap where the track runs through, and the positions are dug
     in along it: a trench, a dugout, sandbags. Others run beside the track for a while. ----- */
  const TREES = { deadtree: true, stump: true, trunk: true };
  // stand one piece of a row at (x, s), if nothing bigger is there (trees in a row may stand close)
  function plant(type, x, s) {
    if (TREES[type] && cfg.lane && Math.abs(x - lane(s)) < cfg.lane) return null; // room to swerve round what is put on the lane
    if (inCrater(x, s, 1) || objects.some((o) => o.visible && Math.hypot(x - o.position.x, s - o.userData.s) < (TREES[o.userData.type] ? 1.8 : o.userData.w + 2))) return null;
    const o = take(type);
    if (!o) return null;
    put(o, x, s, o.userData.cls.fixed ? 1 : rand(0.8, 1.3), 1);
    return o;
  }
  const treeOrStump = () => (Math.random() < 0.7 ? 'deadtree' : 'stump');
  const rowStep = () => rand(2.6, 4.6) / Math.sqrt(Q.density) * (cfg.rows || 1);
  let alongs = []; // tree lines running beside the track: { x at s0, drift dx/ds, end }
  function treeLines(s0, s1) {
    const a = wp[wp.length - 1], band = cfg.band;
    if (per(cfg.lines || 0.3)) {                         // one across the track
      const s = rand(s0 + 14, s1), tilt = rand(-0.3, 0.3), gap = lane(s) + rand(-1.5, 1.5);
      for (let x = a.x - band; x < a.x + band; x += rowStep()) {
        if (Math.abs(x - gap) < 6.5) continue;
        if (Math.random() < 0.08) { x += rand(5, 12); continue; } // shelled out completely here
        plant(treeOrStump(), x, s + (x - a.x) * tilt + rand(-1.2, 1.2));
      }
      // the position along it, on the far side, away from the track
      for (let k = 0; k < 2; k++) {
        const side = Math.random() < 0.5 ? -1 : 1, x = gap + side * rand(14, band * 0.8), ss = s + (x - a.x) * tilt + 5;
        const kind = k === 0 ? 'trench' : Math.random() < 0.5 ? 'dugout' : 'sandbags';
        const o = plant(kind, x, ss);
        if (o) { o.rotation.y = -Math.atan(tilt); syncInst(o); }
        if (o && Math.random() < 0.5) plant(Math.random() < 0.5 ? 'supply' : 'barricade', x + rand(-5, 5), ss + rand(2, 4));
      }
    }
    alongs = alongs.filter((l) => l.end > s0);
    if (alongs.length < 3 && per(cfg.lines ? 0.5 : 0.35)) { // one beside it, starting here
      const side = Math.random() < 0.5 ? -1 : 1;
      alongs.push({ x: a.x + side * rand(16, 45), s: s0, drift: rand(-0.08, 0.08), end: s0 + rand(60, 220) });
    }
    for (const l of alongs) {
      for (let s = s0; s < Math.min(s1, l.end); s += rowStep()) {
        if (Math.random() < 0.06) { s += rand(5, 12); continue; }
        plant(treeOrStump(), l.x + (s - l.s) * l.drift + rand(-1.2, 1.2), s);
      }
    }
  }
  /* something on the line the platform is heading along every so often (cfg.obs), so it keeps
     steering round things: on the ground mostly what lies about everywhere, a wreck rarely;
     trees and silos in the air; buoys, boats and flotsam at sea */
  let nextObs = 0;
  let gateAt = -1e9; // where the gate of the step being planned stands (single obstacles keep off it)
  function gate(s0, s1) {
    const G = cfg.gate;
    if (!G || !per(G.chance)) return;
    const s = rand(s0 + (s1 - s0) * 0.7, s1 + 3), base = lane(s);
    // the gap: off to one side of the line, but within what one step can reach
    const lo = Math.max(laneFrom - laneReach * 0.85, -cfg.limit + 8), hi = Math.min(laneFrom + laneReach * 0.85, cfg.limit - 8);
    let side = Math.random() < 0.5 ? -1 : 1;
    if (base + side * G.shift[0] < lo || base + side * G.shift[0] > hi) side = -side;
    const gapX = clamp(base + side * rand(G.shift[0], G.shift[1]), lo, hi);
    for (let x = base - G.span; x <= base + G.span; x += G.step * rand(0.85, 1.15)) {
      const o = take(pick(G.kinds));
      if (!o) continue;
      const scale = o.userData.cls.fixed ? 1 : rand(0.85, 1.1), ss = s + rand(-1.2, 1.2);
      // the way through: room for the platform and its margin, with a little to spare
      if (Math.abs(x - gapX) < o.userData.cls.w * scale + cfg.margin + G.slack) { release(o); continue; }
      if (objects.some((q) => q.visible && Math.hypot(x - q.position.x, ss - q.userData.s) < q.userData.w + 0.6)) { release(o); continue; }
      put(o, x, ss, scale, 1);
    }
    gateAt = s;
  }
  function inPath(s0, s1) {
    const a = wp[wp.length - 1];
    nextObs = Math.max(nextObs, s0 + (s1 - s0) * 0.55);    // early in a step the curve has not swung out yet
    for (; nextObs < s1; nextObs += rand(cfg.obs.every[0], cfg.obs.every[1])) {
      const s = nextObs, x = lane(s) + rand(-2.5, 2.5);     // on the line the step is about to take
      if (Math.abs(s - gateAt) < 12) continue;                         // the gate is enough there
      if (Math.abs(x) > cfg.limit - 8) continue;                       // leave room to pass it on either side
      const o = take(pick(cfg.obs.kinds));
      if (!o) continue;
      if (overlaps(x, s, o.userData.cls.w * 0.6)) { release(o); continue; } // something is there already: fine too
      put(o, x, s, o.userData.cls.fixed ? 1 : rand(0.85, 1.2), 1);
    }
  }

  // what is left of a hamlet by the road: two to four houses on one side
  function ruins(s0, s1) {
    const a = wp[wp.length - 1], side = Math.random() < 0.5 ? -1 : 1, s = rand(s0 + 10, s1);
    for (let i = 0, n = 2 + Math.floor(Math.random() * 3); i < n; i++) {
      const ss = s + i * rand(13, 18), x = a.x + side * rand(15, 40);
      const o = plant('ruin', x, ss);
      if (o) { o.rotation.y = rand(-0.2, 0.2) + (Math.random() < 0.5 ? 0 : Math.PI / 2); syncInst(o); }
    }
  }
  // a checkpoint at the roadside, with concrete blocks staggered across the road to slow traffic
  function checkpoint(s0, s1) {
    const s = rand(s0 + (s1 - s0) * 0.6 + 9, s1 + 6), side = Math.random() < 0.5 ? -1 : 1;
    const x = lane(s);
    const o = plant('checkpoint', x + side * rand(5, 6.5), s);
    if (!o) return;
    o.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2; syncInst(o);       // facing the road
    plant('block', x - side * 2.2, s - 9);
    plant('block', x + side * 2.2, s + 9);
    if (Math.random() < 0.6) plant('hedgehog', x + side * 3.5, s + 2);
  }

  /* a stretch of burnt forest now and then (after a frame from an FPV drone over the front): a
     dense stand of snapped, charred trunks, a few dead crowns, fallen trees, grey ash on the
     ground and no grass; the road runs through it in a clear lane */
  let forests = [];                                       // { s0, s1 }, the next ones ahead
  const inForest = (s) => forests.some((f) => s > f.s0 && s < f.s1);
  function planForests(upTo) {
    if (!forests.length) forests.push({ s0: dist + rand(140, 260), s1: 0 });
    let f = forests[forests.length - 1];
    if (!f.s1) f.s1 = f.s0 + rand(130, 220);
    while (f.s1 < upTo) { f = { s0: f.s1 + rand(380, 700), s1: 0 }; f.s1 = f.s0 + rand(130, 220); forests.push(f); }
    forests = forests.filter((g) => g.s1 > dist - 40);
    const a = forests[0] || { s0: -1e6, s1: -1e6 }, b = forests[1] || { s0: -1e6, s1: -1e6 };
    U.ash.value.set(a.s0, a.s1, b.s0, b.s1);
  }
  const FOREST = ['trunk', 'trunk', 'trunk', 'trunk', 'stump', 'stump', 'deadtree'];
  function burntForest(s0, s1) {
    const a = wp[wp.length - 1];
    for (const f of forests) {
      const lo = Math.max(s0, f.s0), hi = Math.min(s1, f.s1);
      if (hi <= lo) continue;
      const n = Math.round((hi - lo) * 100 / 24 * Q.density * (cfg.forest || 1));
      for (let i = 0; i < n; i++) {
        const s = rand(lo, hi), x = a.x + rand(-50, 50);
        if (Math.abs(x - lane(s)) < cfg.lane) continue;    // the road keeps its lane through the trees
        plant(Math.random() < 0.05 ? 'fallen' : pick(FOREST), x, s);
      }
    }
  }

  // now and then a big crater right where the vehicle is heading: too deep to drive through
  function bigPit(s0, s1) {
    const c = craters.slice(CR_RAND).find((k) => k.y < dist - 10);
    if (!c) return;
    const s = rand(s0 + (s1 - s0) * 0.75, s1 + 6), r = rand(3, 4.2);
    const x = lane(s) + rand(-1.5, 1.5);
    if (Math.abs(x) > cfg.limit - 8 || inCrater(x, s, r) ||
      objects.some((o) => o.visible && Math.hypot(x - o.position.x, s - o.userData.s) < r * 1.4 + o.userData.w * 0.6)) return;
    const o = take('pit');
    if (!o) return;
    c.set(x, s, r, r * rand(0.28, 0.34));
    put(o, x, s, r * 1.1, 1);
    o.userData.crater = c;
    o.rotation.set(0, 0, 0);
  }

  // a defence belt across the track: two rows of dragon's teeth with wire in front, and a
  // passage left open where the track goes through it
  function defenceBelt(s0, s1) {
    const a = wp[wp.length - 1], s = rand(s0 + 16, s1), tilt = rand(-0.15, 0.15), gap = lane(s) + rand(-1.5, 1.5);
    for (let x = a.x - cfg.band * 0.85; x < a.x + cfg.band * 0.85; x += 4.6) {
      if (Math.abs(x - gap) < 7) continue;
      const ss = s + (x - a.x) * tilt;
      const o = plant('teeth', x, ss);
      if (o) { o.rotation.y = -Math.atan(tilt) + rand(-0.05, 0.05); syncInst(o); }
      if (Math.random() < 0.3) plant('wire', x + rand(-1, 1), ss - 5);
    }
    // hedgehogs beside the passage
    for (const side of [-1, 1]) if (Math.random() < 0.7) plant('hedgehog', gap + side * rand(8, 11), s + rand(-2, 2));
  }

  // the port crane stands on the left at mid distance, its jib turned towards the route
  function placeCrane(s0, s1) {
    const o = scatter('crane', s0, s1, (cx) => cx - rand(30, 45));
    if (o) { o.rotation.y = rand(-0.3, 0.3); syncInst(o); }
  }

  // a chance given per planning step, scaled to the length of this one
  let stepK = 1;
  const per = (p) => Math.random() < p * stepK;
  function populate(s0, s1) {
    const area = (s1 - s0) * cfg.band * 2 * Q.density;
    stepK = (s1 - s0) / (cfg.segRef || (s1 - s0));
    cfg.scatter.forEach(([type, m2]) => {
      for (let i = Math.floor(area / m2 + Math.random()); i > 0; i--) scatter(type, s0, s1);
    });
    cfg.extras(s0, s1);
    gateAt = -1e9;
    gate(s0, s1);
    if (cfg.obs) inPath(s0, s1);
  }

  // the line the step being planned is expected to take (from its start towards its target);
  // scattered objects keep off it, tree lines and belts leave their gap on it, and the
  // obstacles meant to be driven round are put on it
  let lane = (s) => wp[wp.length - 1].x, laneFrom = 0, laneReach = 10;

  function plan() {
    const a = wp[wp.length - 1], L = rand(cfg.seg[0], cfg.seg[1]), end = a.s + L;
    if (a.s > goalUntil) {
      goal = rand(-cfg.limit, cfg.limit);
      goalUntil = a.s + rand(100, 260);
      if (cfg.alts) prefY = rand(cfg.alts[0], cfg.alts[1]);
    }
    // the point the step aims at: the goal, swung from side to side along a winding track
    let target = goal;
    if (cfg.meander) {
      const [l0, l1, a0, a1] = cfg.meander, was = bend.phase;
      bend.phase += Math.PI * 2 * L / bend.len;
      if (Math.floor(was / Math.PI) !== Math.floor(bend.phase / Math.PI)) { bend.len = rand(l0, l1); bend.amp = rand(a0, a1); } // a new bend at each crossing
      target = clamp(goal + bend.amp * Math.sin(bend.phase), -cfg.limit, cfg.limit);
    }
    const reach = cfg.slope * L / 1.875 * (cfg.agile || 1), cands = [];
    const xEnd = clamp(target, a.x - reach * 0.7, a.x + reach * 0.7), vEnd = (xEnd - a.x) / L * 0.6;
    laneFrom = a.x; laneReach = reach;
    lane = (s) => (s <= end ? hermite(a.x, a.vx, xEnd, vEnd, L, clamp((s - a.s) / L, 0, 1), 0) : xEnd + vEnd * (s - end));
    populate(a.s, end);
    const near = objects.filter((o) => o.visible && o.userData.s > a.s - 15 && o.userData.s < end + 25);
    // candidate altitudes: stay, cruise, or just high enough to hop over something ahead
    let ys = [a.y];
    if (cfg.alts) {
      const climb = cfg.climb * L / 1.875;
      ys = [a.y, prefY, cfg.alts[0], ...near.map((o) => o.userData.h + cfg.overfly + 0.4)]
        .filter((y) => y >= cfg.alts[0] && y <= cfg.alts[2] && Math.abs(y - a.y) <= climb);
    }
    for (let i = -12; i <= 12; i++) {
      const x = a.x + reach * i / 12;
      if (Math.abs(x) > cfg.limit) continue;
      for (const y of ys) {
        // leave the step still drifting the same way, a little slower, so the next one carries on smoothly
        cands.push({ x, y, vx: (x - a.x) / L * 0.6, vy: (y - a.y) / L * 0.5, cost: Math.abs(x - target) * (cfg.meander ? 0.9 : 0.4) + Math.abs(x - a.x) * (cfg.meander ? 0.3 : 0.6) + Math.abs(y - prefY) * 1.2 + (y - a.y > 0 ? (y - a.y) * (cfg.meander ? 2.2 : 0.8) : 0) + Math.random() * 0.4 });
      }
    }
    cands.sort((p, q) => p.cost - q.cost);
    // walk the curve (and 8 m of straight line past its end, where the next step starts)
    // what stands on a candidate curve (and 8 m of straight line past its end, where the next step starts)
    const blockers = (c, all) => {
      const found = new Set();
      for (let s = a.s; s <= end + 8; s += 1.5) {
        const t = (s - a.s) / L, x = t > 1 ? c.x + c.vx * (s - end) : hermite(a.x, a.vx, c.x, c.vx, L, t, 0);
        const y = t > 1 ? c.y + c.vy * (s - end) : hermite(a.y, a.vy, c.y, c.vy, L, t, 0);
        for (const o of near) if (hits(o, x, y, s)) { found.add(o); if (!all) return found; }
      }
      return found;
    };
    let best = cands.find((c) => !blockers(c).size);
    if (!best) {
      // boxed in: of the cheapest ways take the one blocked least and clear it. A big crater on it
      // is filled in too; it lies far ahead, where the ground is still drawn flat (see crFade)
      let fewest = Infinity;
      for (const c of cands.slice(0, 12)) {
        const n = blockers(c, true).size;
        if (n < fewest) { fewest = n; best = c; }
      }
      blockers(best, true).forEach((o) => {
        if (o.userData.crater) { o.userData.crater.set(0, -1e6, 1, 0); o.userData.crater = null; }
        release(o);
      });
    }
    wp.push({ s: end, x: best.x, vx: best.vx, y: best.y, vy: best.vy });
  }

  function extend() {
    while (wp[wp.length - 1].s < dist + DEPTH) plan();
    while (wp.length > 2 && wp[1].s < dist - 10) wp.shift();
  }

  // start a fresh route from where the camera is
  function reset() {
    const x = clamp(camera.position.x, -cfg.limit, cfg.limit), y = cfg.alts ? cfg.alts[0] + 1 : 0;
    wp.length = 0;
    wp.push({ s: dist - 10, x, vx: 0, y, vy: 0 }, { s: dist + 16, x, vx: 0, y, vy: 0 });
    goal = x; goalUntil = dist + rand(40, 120); prefY = y;
    if (cfg.meander) Object.assign(bend, { phase: 0, len: rand(cfg.meander[0], cfg.meander[1]), amp: rand(cfg.meander[2], cfg.meander[3]) });
    extend();
  }

  /* ----- drifting particles: fireflies at night, pollen by day, spray at sea ----- */
  const DUST = 260;
  const dustPos = new Float32Array(DUST * 3);
  for (let i = 0; i < DUST; i++) dustPos.set([rand(-30, 30), rand(0.3, 9), rand(-90, 5)], i * 3);
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dustMat = new THREE.PointsMaterial({ map: glowTex, size: 0.22, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  scene.add(new THREE.Points(dustGeo, dustMat));

  /* ----- look of the scene: time of day (own switch) x environment ----- */
  // scene starts in the site theme, then is switched by its own control
  let colors = {}, day = root.dataset.theme === 'light', paused = reduced;
  let speed = cfg.speed, last = 0, raf = 0, visible = false;
  let vx = 0, ax = 0, roll = 0, poseDt = 1 / 60, agl = 0, W = 1, H = 1, tracked = 0;
  // ground colour by day / night, and the tint of dry patches
  const GROUND = { air: [0x57533a, 0x201f19, [1.1, 1.0, 0.82]], ground: [0x45392b, 0x1f1a15, [1.12, 1.0, 0.86]] };
  function applyLook() {
    const sea = envName === 'sea';
    // a hazy, slightly desaturated day rather than a postcard blue
    const grey = true; // overcast, dust and smoke over the front, in every environment
    const horizon = day ? (sea ? 0xa2a8a8 : 0xa7a9a6) : 0x10141f;
    skyMat.uniforms.top.value.set(day ? (grey ? 0x6f7c88 : 0x3f6c9e) : 0x03050b);
    skyMat.uniforms.bottom.value.set(horizon);
    skyMat.uniforms.glowCol.value.set(day ? 0xffd6a0 : 0x141a2c);
    skyMat.uniforms.glowDir.value.copy(SKY_POS).normalize();
    scene.fog.color.set(horizon);
    scene.fog.density = grey ? (day ? 0.0135 : 0.018) : day ? 0.0095 : 0.015;
    renderer.toneMappingExposure = day ? (grey ? 0.85 : 0.8) : 1.2;
    hemi.color.set(day ? 0xc4d4e6 : 0x6c80d0);
    hemi.groundColor.set(day ? (sea ? 0x3a4a50 : 0x5a5644) : 0x07090d);
    hemi.intensity = day ? (grey ? 0.8 : 0.6) : 0.42;      // under cloud the light comes from the whole sky,
    sun.color.set(day ? (grey ? 0xe8e4dc : 0xffe4c0) : 0xb4c4ff);
    sun.intensity = day ? (grey ? 0.55 : 1.3) : 0.5;        // the sun is a pale disc, shadows faint
    lightDir = LIGHT[day ? 'day' : 'night'];
    mats.glass.emissiveIntensity = day ? 0 : 1.3;
    ground.visible = !sea;
    water.visible = sea;
    if (!sea) {
      const [d, n, dry] = GROUND[envName];
      groundMat.color.set(day ? d : n);
      U.dry.value.set(...dry);
    }
    waterMat.color.set(0xffffff);
    U.deep.value.set(day ? 0x141f1e : 0x03080a);               // murky grey-green, not a holiday blue
    U.shallow.value.set(day ? 0x2c3a35 : 0x0b1517);
    U.foam.value.set(day ? 0xb9bdb7 : 0x48525a);
    waterMat.envMap = SKY_ENV[day ? 'day' : 'night'];
    waterMat.envMapIntensity = day ? 0.65 : 0.8;
    waterMat.needsUpdate = true;
    disc.visible = day && !grey;
    disc.material.color.set(grey ? 0xd9d6cc : 0xfff6e0);
    halo.material.color.set(grey ? 0x6a655c : 0x5a4630);
    halo.visible = day;
    farRings.forEach((m) => {
      m.visible = !sea;
      m.material.uniforms.uFog.value.set(horizon);
      m.material.uniforms.uTone.value.set(day ? 0x4a4b46 : 0x05070c);
    });
    mistMat.uniforms.uCol.value.set(day ? (grey ? 0xbdbfbc : 0xd6dde0) : 0x2a3348);
    mistMat.uniforms.uFog.value.set(horizon);
    mistMat.uniforms.uFogD.value = scene.fog.density;
    U.refl.value.set(horizon).multiplyScalar(day ? 0.95 : 0.7);
    moon.visible = moonHalo.visible = !day;
    stars.visible = !day;
    dustMat.color.set(day || sea ? 0xffffff : 0xfff0a0);
    dustMat.opacity = day ? 0.3 : sea ? 0.4 : 0.8;
    const grd = true;
    smokeMat.uniforms.uDark.value.set(day ? 0x2e2b28 : 0x0b0c0f);
    smokeMat.uniforms.uLight.value.set(day ? 0x8f8a82 : 0x22252c);
    smokeMat.uniforms.uFire.value.set(day ? 0x000000 : 0x9a3c10);
    smokeMat.uniforms.uFog.value.copy(scene.fog.color);
    smokeMat.uniforms.uFogD.value = scene.fog.density;
    flameMat.uniforms.uFogD.value = scene.fog.density;
    flameMat.uniforms.uGain.value = day ? 0.8 : 1.3;
    flashes.forEach((f) => { f.visible = grd && !day; });
    const cu = cloudMat.uniforms;
    cu.uCover.value = CLOUD[envName][day ? 0 : 1];
    cu.uLit.value.set(day ? (grd ? 0xb4b6b5 : 0xe8e8e4) : 0x1b2233);
    cu.uShade.value.set(day ? (grd ? 0x5d6064 : 0x8a9098) : 0x0a0d14);
    cu.uSunDir.value.copy(SKY_POS).normalize();
    cu.uSunCol.value.set(day ? 0xffe2b0 : 0x55607a);
    modeEl.textContent = day ? 'SOLARNAV' : 'STARNAV';
    altBox.firstChild.textContent = sea ? 'SWELL ' : envName === 'ground' ? 'TILT ' : 'ALT ';
    altBox.lastChild.textContent = envName === 'ground' ? '°' : ' m';
    const s = getComputedStyle(root);
    colors = { accent: s.getPropertyValue('--accent').trim(), ink: day ? '#161a12' : '#e9e6d6' };
    if (!raf) { pose(); render(); }
  }
  document.addEventListener('themechange', applyLook); // only the accent colour follows the site theme

  // switch environment: clear the world and regenerate it from the current position
  function setEnv(name) {
    if (!ENV[name]) return;
    envName = name; cfg = resolve(name);
    seaAmp = U.amp.value = cfg.amp;
    terrA = U.terrA.value = cfg.relief;
    bumpA = U.bump.value = cfg.bumps || 0;
    craters.forEach((c) => c.set(0, -1e6, 1, 0));
    alongs = []; nextObs = 0; roadFrom = -1e9; forests = [];
    U.ash.value.set(-1e6, -1e6, -1e6, -1e6);
    U.roadOn.value = U.wet.value = name === 'ground' ? 1 : 0;
    fpsWarm = 2.5;
    loadModels(name);
    if (name !== 'sea') loadGrass();
    objects.forEach((o) => { if (o.visible) release(o); });
    fields.forEach((f) => { if (f.visible) { f.visible = false; freeFields.push(f); } });
    vx = ax = roll = 0;
    shakeFrom = dist;
    reset();
    litter.visible = name !== 'sea';
    LITTER.forEach(litterQuality);
    smoke.visible = mist.visible = true;
    banks.forEach((b, i) => spawnBank(b, dist + 25 + i * 30, dist + 60 + i * 30));
    plumes.forEach((p, i) => spawnPlume(p, dist + 30 + i * 35, dist + 60 + i * 35));
    if (name !== 'sea') {
      craters.forEach((c, i) => { if (i < CR_RAND) spawnCrater(c, dist + 6, dist + DEPTH); });
      LITTER.forEach((K, k) => scatterLitter(k));
    }
    applyLook();
  }
  document.addEventListener('envchange', (e) => setEnv(e.detail));
  document.addEventListener('locchange', (e) => {
    loc = e.detail === 'port' ? 'port' : 'open';
    if (envName === 'sea') setEnv('sea');
  });

  /* ----- course: the platform turns towards the side its route is drifting to, up to ~40°.
     The world strip stays laid out along -z; instead the sky (sun, moon, stars, the references
     locked on them) and the light swing round, and the camera leans a little into the turn. ----- */
  const Y_AXIS = new THREE.Vector3(0, 1, 0), lightNow = new THREE.Vector3();
  let heading = 0, yaw = 0;
  /* shake: wheels running over a stone, a stick or scrap give the hull a kick (height, pitch,
     roll) that a stiff, damped spring takes out again within a fraction of a second */
  const shake = { y: 0, vy: 0, p: 0, vp: 0, r: 0, vr: 0 };
  let shakeFrom = 0;
  function stepShake(dt) {
    if (envName === 'ground') {
      const s0 = shakeFrom, s1 = dist + 0.6;              // the front wheels are about 0.6 m ahead of the eye
      LITTER.forEach((K) => {
        if (!K.bump) return;
        for (let i = 0; i < K.n; i++) {
          if (K.s[i] <= s0 || K.s[i] > s1 || K.k[i] < 0.01) continue;
          const lat = Math.abs(K.x[i] - pathX(K.s[i]));
          if (lat > 1.15 || lat < 0.45) continue;          // only what passes under a wheel, not between them
          const kick = K.bump * K.k[i];
          shake.vy += kick * 6;
          shake.vp -= kick * 1.6;
          shake.vr += kick * (K.x[i] > pathX(K.s[i]) ? -1 : 1) * 3;
        }
      });
      shakeFrom = s1;
    }
    for (const k of ['y', 'p', 'r']) {                     // spring back
      shake['v' + k] += (-260 * shake[k] - 16 * shake['v' + k]) * dt;
      shake[k] += shake['v' + k] * dt;
    }
  }
  function steerCourse(dt) {
    const target = clamp((goal - camera.position.x) / 90, -0.7, 0.7);
    const turn = (target - heading) * (1 - Math.exp(-dt * 0.35));
    heading += turn;
    const look = envName === 'air' ? 0.1 : 0.2;
    yaw += (clamp(turn / dt * 1.5, -look, look) - yaw) * (1 - Math.exp(-dt * 1.5)); // looks into the turn
    skyGroup.rotation.y = heading;
  }

  /* ----- motion ----- */
  // place the camera for the current distance; each platform moves in its own way
  function pose() {
    const x = pathX(dist), gy = envName === 'air' ? reliefH(x, dist) : terrainH(x, dist);
    vx = route(dist, 1) * speed;
    ax = route(dist, 2) * speed * speed;
    let y = gy + (cfg.alt || 0), pitch = 0, tilt = 0, down = 0.3, look = 0;
    if (envName === 'air') {
      agl = pathY(dist) + Math.sin(time * 0.4) * 0.12;
      y = gy + agl;
      look = route(dist, 1, 'y') * 30 * 0.7;               // eyes follow the climb or the descent
      tilt = -Math.atan(ax / 9.81) * 0.6;                  // banks into the turn (gently: the view stays readable)
      down = 0.3 + agl * 0.04;                             // looks further down from higher up
    } else if (envName === 'sea') {
      y += wave(x, dist, time);                            // heaves, pitches and rolls with the swell
      pitch = Math.atan((wave(x, dist + 1.5, time) - wave(x, dist - 1.5, time)) / 3) * 0.7;
      tilt = Math.atan((wave(x + 1, dist, time) - wave(x - 1, dist, time)) / 2) * 0.7 + Math.atan(ax / 9.81) * 0.3;
      down = 0.12;
      agl = Math.abs(y - cfg.alt);
    } else {
      y += Math.sin(dist * 1.3) * 0.03 + Math.sin(dist * 3.1) * 0.015; // rough ground under the wheels
      // the hull follows the slope of the ground it is on
      pitch = Math.atan((terrainH(x, dist + 2) - terrainH(x, dist - 2)) / 4) + Math.sin(dist * 1.7) * 0.012;
      tilt = Math.atan((terrainH(x + 1.2, dist) - terrainH(x - 1.2, dist)) / 2.4) + Math.sin(dist * 0.9) * 0.015 + Math.sin(dist * 2.3) * 0.008;
      down = 0.08;
      y += shake.y; pitch += shake.p;
    }
    roll += (tilt - roll) * (1 - Math.exp(-poseDt * (envName === 'air' ? 1.4 : 2.2))); // eases into the bank instead of snapping
    camera.position.set(x, y, 0);
    camera.lookAt(x + vx / speed * 30, y - down + look, -30);
    camera.rotateY(-yaw);
    camera.rotateX(pitch);
    camera.rotateZ(roll + (envName === 'ground' ? shake.r : 0));
    if (envName === 'ground') agl = Math.abs(roll * 57.3);
    return y;
  }

  function update(dt) {
    time += dt;
    speed = cfg.speed * (1 + Math.sin(time * 0.12) * 0.08);
    dist += speed * dt;
    extend();
    poseDt = dt;
    steerCourse(dt);
    stepShake(dt);
    const y = pose(), cx = camera.position.x;
    const sea = envName === 'sea';
    U.dist.value = dist;
    U.time.value = time;

    // the sky, the ground / water sheet and the shadow box travel sideways with the camera
    skyGroup.position.x = cx;
    snapGround(cx);
    instRoot.position.z = dist;
    if (envName !== 'sea') updateLitter();
    if (envName === 'ground') updateRoad();
    updateSmoke();
    if (!day) updateFlashes(dt);
    updateClouds(dt);
    updateDrops(dt);
    if (mist.visible) updateMist();
    sun.target.position.set(cx, y - 3, -28);
    sun.position.copy(lightNow.copy(lightDir).applyAxisAngle(Y_AXIS, heading)).multiplyScalar(70).add(sun.target.position);
    if (sea) {
      water.position.x = Math.round(cx);
      rippleTex.offset.set(time * 0.02 + water.position.x / 10 * RIPPLE, dist / 10 * RIPPLE + time * 0.03);
    }
    for (const o of objects) {
      if (!o.visible) continue;
      const u = o.userData;
      o.position.z = dist - u.s;
      if (u.cls.float) {                                   // flotsam rides the swell and rocks
        o.position.y = wave(o.position.x, u.s, time);
        o.rotation.x = Math.sin(time * 0.9 + u.phase) * 0.12;
        o.rotation.z = Math.cos(time * 0.7 + u.phase) * 0.12;
        syncInst(o);
      }
      if (o.position.z > 8 + u.w) release(o);
    }
    for (const f of fields) {
      if (!f.visible) continue;
      f.position.z = dist - f.userData.s;
      if (f.position.z - f.userData.len / 2 > 8) { f.visible = false; freeFields.push(f); }
    }
    for (let i = 0; i < DUST; i++) {
      dustPos[i * 3 + 2] += speed * dt;
      dustPos[i * 3] += Math.sin(time + i) * dt * 0.3;
      if (dustPos[i * 3 + 2] > 5) {
        dustPos[i * 3 + 2] -= 95;
        dustPos[i * 3] = cx + rand(-30, 30);
        dustPos[i * 3 + 1] = Math.max(y + rand(-5, 6), 0.3);
      }
    }
    dustGeo.attributes.position.needsUpdate = true;

    spdEl.textContent = Math.round(speed * 3.6);
    altEl.textContent = agl.toFixed(1);
    distEl.textContent = Math.floor(dist);
    objEl.textContent = tracked;
  }

  /* ----- HUD overlay: detections, planned route, sky references ----- */
  const v = new THREE.Vector3();
  const toScreen = (x, y, z) => {
    v.set(x, y, z).project(camera);
    return v.z > 1 ? null : [(v.x + 1) / 2 * W, (1 - v.y) / 2 * H];
  };

  /* ----- spray on the lens at sea: now and then a drop lands on the camera window, clings for a
     moment, then runs down leaving a faint wet trail. Drawn on the HUD canvas, kept subtle. ----- */
  const drops = [];
  let dropNext = 3;
  function updateDrops(dt) {
    if (envName !== 'sea') { drops.length = 0; return; }
    if ((dropNext -= dt) < 0) {
      for (let n = Math.random() < 0.3 ? 2 : 1; n > 0; n--) {
        drops.push({ x: rand(0.06, 0.94) * W, y: rand(0.05, 0.6) * H, r: rand(3.5, 9), age: 0, hold: rand(0.6, 2.2), vy: 0, trail: [] });
      }
      dropNext = rand(3, 8);
    }
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.age += dt;
      if (d.age > d.hold) {                                 // it lets go and runs down, wobbling a little
        d.vy = Math.min(d.vy + 90 * dt, 70);
        d.y += d.vy * dt;
        d.x += Math.sin(d.age * 3 + d.r) * 6 * dt;
        d.r = Math.max(1.5, d.r - dt * 0.8);
        const last = d.trail[d.trail.length - 1];
        if (!last || d.y - last[1] > 3) d.trail.push([d.x, d.y - d.r * 0.6]);
        if (d.trail.length > 16) d.trail.shift();           // the streak dries from the top
      }
      if (d.y - d.r > H || d.age > d.hold + 3) drops.splice(i, 1);
    }
  }
  function drawDrops() {
    for (const d of drops) {
      const fade = clamp(Math.min(d.age * 6, d.hold + 3 - d.age), 0, 1);
      if (d.trail.length > 1) {                             // the wet streak it leaves, drying from the top
        h2.lineWidth = Math.max(1, d.r * 0.5);
        h2.lineCap = 'round';
        for (let k = 1; k < d.trail.length; k++) {
          h2.strokeStyle = `rgba(220,230,235,${0.07 * fade * k / d.trail.length})`;
          h2.beginPath(); h2.moveTo(d.trail[k - 1][0], d.trail[k - 1][1]); h2.lineTo(d.trail[k][0], d.trail[k][1]); h2.stroke();
        }
      }
      // the drop: a clear lens, darker rim at the bottom, a highlight at the top
      const g = h2.createRadialGradient(d.x, d.y - d.r * 0.2, d.r * 0.2, d.x, d.y, d.r);
      g.addColorStop(0, `rgba(255,255,255,${0.05 * fade})`);
      g.addColorStop(0.75, `rgba(200,210,215,${0.1 * fade})`);
      g.addColorStop(1, `rgba(20,25,30,${0.22 * fade})`);
      h2.fillStyle = g;
      h2.beginPath(); h2.ellipse(d.x, d.y, d.r * 0.9, d.r, 0, 0, Math.PI * 2); h2.fill();
      h2.fillStyle = `rgba(255,255,255,${0.4 * fade})`;
      h2.beginPath(); h2.arc(d.x - d.r * 0.3, d.y - d.r * 0.4, Math.max(0.8, d.r * 0.18), 0, Math.PI * 2); h2.fill();
    }
    h2.lineCap = 'butt';
  }

  function drawHud() {
    h2.clearRect(0, 0, W, H);
    h2.globalAlpha = 1;
    drawDrops();
    h2.font = '10px "JetBrains Mono", ui-monospace, monospace';
    h2.lineWidth = 1;
    const cx = W / 2, cy = H / 2;

    // sky references the navigator is locked on
    const refs = day ? [disc.position] : navStars;
    h2.strokeStyle = h2.fillStyle = colors.accent;
    refs.forEach((p, i) => {
      v.copy(p).applyAxisAngle(Y_AXIS, heading);
      const s = toScreen(v.x + skyGroup.position.x, v.y, v.z);
      if (!s || s[0] < 0 || s[0] > W || s[1] < 0 || s[1] > H) return;
      h2.globalAlpha = 0.22 + 0.1 * Math.sin(time * 2 + i);
      h2.beginPath(); h2.moveTo(cx, cy); h2.lineTo(s[0], s[1]); h2.stroke();
      h2.globalAlpha = 0.9;
      h2.strokeRect(s[0] - 7, s[1] - 7, 14, 14);
      h2.fillText(day ? 'SOL REF' : `REF 0${i + 1}`, s[0] + 12, s[1] + 3);
    });

    // planned route on the surface
    const sea = envName === 'sea';
    h2.globalAlpha = 0.9;
    h2.lineWidth = 1.5;
    h2.setLineDash([6, 6]);
    h2.beginPath();
    let pen = false;
    for (let d = 0.5; d <= 90; d += d < 6 ? 0.5 : 3) { // from right under the camera, so it leaves the bottom edge at any height
      const x = pathX(dist + d);
      const s = toScreen(x, sea ? wave(x, dist + d, time) + 0.15 : terrainH(x, dist + d) + 0.05, -d);
      if (!s) continue;
      if (pen) h2.lineTo(s[0], s[1]); else { h2.moveTo(s[0], s[1]); pen = true; }
    }
    h2.stroke();
    h2.setLineDash([]);

    // detections
    tracked = 0;
    const labels = [];
    for (const o of objects) {
      if (!o.visible) continue;
      const u = o.userData, d = -o.position.z;
      if (d < 3 || d > 95 || (u.crater && d > CR_FAR - 4)) continue; // a big crater is marked once it is dug (crFade)
      const a = toScreen(o.position.x - u.w, o.position.y, o.position.z);
      const b = toScreen(o.position.x + u.w, o.position.y + u.h, o.position.z);
      if (!a || !b) continue;
      const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]);
      const y0 = Math.max(Math.min(a[1], b[1]), -20), y1 = Math.max(a[1], b[1]);
      if (x1 < 0 || x0 > W) continue;
      tracked++;
      // over = the drone passes above it; threat = the route had to bend around it, or it stands right beside it
      const lat = Math.abs(o.position.x - pathX(u.s));
      const over = !!cfg.overfly && lat < u.w + cfg.margin && pathY(u.s) >= u.h + cfg.overfly;
      const threat = !over && lat < u.w + cfg.margin + 2.5;
      if (u.cls.quiet && !threat) continue; // a tree line is not a hundred targets: only trees by the track get a box
      const col = threat ? colors.accent : colors.ink;
      h2.globalAlpha = clamp((95 - d) / 20, 0, 1) * (threat || over ? 1 : 0.35);
      h2.strokeStyle = h2.fillStyle = col;
      h2.lineWidth = threat ? 1.5 : 1;
      // corner brackets
      const c = Math.min(12, (x1 - x0) / 3, (y1 - y0) / 3);
      h2.beginPath();
      [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]].forEach(([x, y, sx, sy]) => {
        h2.moveTo(x + sx * c, y); h2.lineTo(x, y); h2.lineTo(x, y + sy * c);
      });
      h2.stroke();
      if (x1 - x0 > 26 && (threat || over || (d < 45 && x1 - x0 > 40))) { // text only where it matters, or the view drowns in labels
        const conf = Math.min(0.99, u.conf + (1 - d / 95) * 0.08);
        labels.push({ d, x: Math.max(4, x0), y: Math.max(12, y0 - 16), col, alpha: h2.globalAlpha, rank: threat || over ? 0 : 1,
          text: `${u.cls.label} ${(conf * 100).toFixed(0)}%  ${d.toFixed(0)}m`, action: over ? 'OVERFLY' : threat ? 'AVOID' : 'TRACK' });
      }
    }

    // labels: the nearest threats first, at most five, none written over another
    labels.sort((p, q) => p.rank - q.rank || p.d - q.d);
    const shown = [];
    for (const l of labels) {
      if (shown.length === 5) break;
      if (shown.some((m) => Math.abs(m.x - l.x) < 150 && Math.abs(m.y - l.y) < 24)) continue;
      shown.push(l);
      h2.globalAlpha = l.alpha;
      h2.fillStyle = l.col;
      h2.fillText(l.text, l.x, l.y);
      h2.fillText(l.action, l.x, Math.max(24, l.y + 11));
    }

    // boresight
    h2.globalAlpha = 0.8;
    h2.strokeStyle = colors.ink;
    h2.lineWidth = 1;
    h2.beginPath();
    h2.moveTo(cx - 18, cy); h2.lineTo(cx - 6, cy); h2.moveTo(cx + 6, cy); h2.lineTo(cx + 18, cy);
    h2.moveTo(cx, cy - 18); h2.lineTo(cx, cy - 6); h2.moveTo(cx, cy + 6); h2.lineTo(cx, cy + 18);
    h2.stroke();
    h2.globalAlpha = 1;
  }

  function render() {
    renderer.render(scene, camera);
    drawHud();
  }

  function setQuality(level) {
    const was = Q;
    quality = level; Q = QUALITY[level];
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, Q.dpr));
    renderer.setSize(W, H, false);
    if (Q.shadow !== was.shadow) {
      sun.castShadow = Q.shadow > 0;
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
      sun.shadow.mapSize.set(Q.shadow || 1024, Q.shadow || 1024);
    }
    if (Q.fine !== was.fine) {
      ground.geometry.dispose(); ground.geometry = groundGrid(Q.fine);
      water.geometry.dispose(); water.geometry = waterGrid(...(Q.fine ? [200, 220] : [110, 130]));
    }
    LITTER.forEach(litterQuality);
  }
  // frame-rate watch: after a warm-up (models and shaders load then), average over 2 s windows
  let fpsWarm = 2, fpsFrames = 0, fpsTime = 0;
  function watchFps(raw) {
    raw = Math.min(raw, 1);                       // the loop is stopped in hidden tabs, so long frames are real
    if (fpsWarm > 0) { fpsWarm -= raw; return; }
    fpsFrames++; fpsTime += raw;
    if (fpsTime < 2) return;
    const fps = fpsFrames / fpsTime;
    fpsFrames = fpsTime = 0;
    if (fps < 40 && quality > 0) { setQuality(quality - 1); fpsWarm = 1.5; }
  }

  function frame(now) {
    const raw = (now - last) / 1000, dt = clamp(raw, 0.001, 0.05);
    last = now;
    watchFps(raw);
    update(dt);
    render();
    raf = requestAnimationFrame(frame);
  }

  // only run the loop while the demo is on screen, the tab is visible and it is not paused
  function setRunning() {
    const run = visible && !document.hidden && !paused;
    if (run && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
    if (!run && raf) { cancelAnimationFrame(raf); raf = 0; }
  }
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; setRunning(); }).observe(box);
  document.addEventListener('visibilitychange', setRunning);
  new ResizeObserver(() => {
    W = box.clientWidth; H = box.clientHeight;
    renderer.setSize(W, H, false);
    hud.width = W * DPR; hud.height = H * DPR;
    h2.setTransform(DPR, 0, 0, DPR, 0, 0);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    if (!raf) render();
  }).observe(box);

  /* ----- demo controls ----- */
  const playBtn = el('simPlay'), modeBtn = el('simMode');
  const syncUi = () => {
    playBtn.textContent = paused ? 'Play' : 'Pause';
    modeBtn.textContent = day ? 'Day · SolarNav' : 'Night · StarNav';
  };
  playBtn.addEventListener('click', () => { paused = !paused; syncUi(); setRunning(); });
  modeBtn.addEventListener('click', () => { day = !day; syncUi(); applyLook(); });
  syncUi();

  LITTER.forEach(litterQuality);
  setEnv(envName);
})();
