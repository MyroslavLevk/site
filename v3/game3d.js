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
  const DPR = Math.min(devicePixelRatio || 1, 1.75);
  renderer.setPixelRatio(DPR);
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x000000, 0.014);
  const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 600);
  scene.add(camera);

  /* ----- light: sun / moon with shadows, sky fill, onboard headlight for night ----- */
  const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1);
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.position.set(-30, 45, 5);
  sun.target.position.set(0, 0, -30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -48, right: 48, top: 48, bottom: -48, near: 1, far: 140 });
  sun.shadow.bias = -0.0006;
  const head = new THREE.SpotLight(0xfff2d0, 0, 90, 0.55, 0.7, 1.4);
  head.target.position.set(0, -0.15, -10);
  camera.add(head, head.target);
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
  disc.add(halo);

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
  skyGroup.add(stars, disc, moonHalo, moon);
  // light comes from behind-left by day, from the moon at night (so the water shows its path)
  const LIGHT = { day: new THREE.Vector3(-30, 45, 35).normalize(), night: SKY_POS.clone().sub(new THREE.Vector3(0, 0, -30)).normalize() };
  let lightDir = LIGHT.day;

  // reference points the navigator "locks" onto, drawn in the HUD
  const navStars = [[-0.42, 0.34, -1], [0.08, 0.52, -1], [0.5, 0.3, -1]]
    .map((d) => new THREE.Vector3(...d).normalize().multiplyScalar(400));
  navStars.forEach((p) => { const s = glow(0xcfe0ff, 14); s.position.copy(p); stars.add(s); });

  /* ----- terrain: gentle rolling ground, the same function on the CPU (to stand objects
     and the camera on it) and in the ground shader. x across, s along the route. ----- */
  let terrA = 0; // relief amplitude of the current environment, 0 at sea
  const terrainH = (x, s) => terrA * (0.55 * Math.sin(0.021 * x + 0.6) * Math.sin(0.017 * s + 1.1)
    + 0.3 * Math.sin(0.047 * x - 0.033 * s + 2) + 0.15 * Math.sin(0.09 * x + 0.071 * s));
  const TERRAIN_GLSL = `float terrainH(vec2 p){ return uTerrA * (0.55 * sin(0.021 * p.x + 0.6) * sin(0.017 * p.y + 1.1)
    + 0.3 * sin(0.047 * p.x - 0.033 * p.y + 2.0) + 0.15 * sin(0.09 * p.x + 0.071 * p.y)); }`;
  // shared by the ground and water shaders
  const U = {
    dist: { value: 0 }, time: { value: 0 }, terrA: { value: 0 }, amp: { value: 1 },
    dry: { value: new THREE.Vector3(1, 1, 1) },
    deep: { value: new THREE.Color() }, shallow: { value: new THREE.Color() }, foam: { value: new THREE.Color() },
  };

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
    Object.assign(sh.uniforms, { uDist: U.dist, uTerrA: U.terrA, uDry: U.dry, uMacro: { value: macroTex } });
    sh.vertexShader = 'uniform float uDist; uniform float uTerrA; varying vec2 vW;\n' + TERRAIN_GLSL + '\n' + sh.vertexShader
      .replace('#include <beginnormal_vertex>', `
        vec4 wp0 = modelMatrix * vec4(position, 1.0);
        vec2 P = vec2(wp0.x, uDist - wp0.z);
        float th = terrainH(P);
        vec3 objectNormal = normalize(vec3((th - terrainH(P + vec2(0.5, 0.0))) * 2.0, 1.0, (terrainH(P + vec2(0.0, 0.5)) - th) * 2.0));
        vW = P;`)
      .replace('#include <begin_vertex>', 'vec3 transformed = vec3(position.x, th, position.z);');
    sh.fragmentShader = 'uniform sampler2D uMacro; uniform vec3 uDry; varying vec2 vW;\n' + sh.fragmentShader
      .replace('#include <map_fragment>', `
        vec3 det = texture2D(map, vW / ${TILE}.0).rgb;
        float mac = texture2D(uMacro, vW / 170.0).r, mac2 = texture2D(uMacro, vW / 53.0 + 0.37).r;
        diffuseColor.rgb *= det * mix(0.72, 1.18, mac);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * uDry, smoothstep(0.42, 0.72, mac2));`);
  };
  const GCELL = 4;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(720, 520, 720 / GCELL, 520 / GCELL).rotateX(-Math.PI / 2).translate(0, 0, -220), groundMat);
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
  const waterGeo = (() => {
    const g = new THREE.PlaneGeometry(1, 1, 200, 220).rotateX(-Math.PI / 2);
    const p = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i) * 2, v = 0.5 - p.getZ(i);
      const x = 230 * (0.3 * u + 0.7 * u * Math.abs(u)), z = 30 - 460 * (0.25 * v + 0.75 * v * v);
      p.setXYZ(i, x, 0, z);
      uv.setXY(i, x / 10, -z / 10);
    }
    return g;
  })();
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
  const SKY_ENV = { day: skyEnv('#4f78a6', '#9fb1bd', '#173a46'), night: skyEnv('#04060d', '#1d2b4c', '#050a10') };
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
  const water = new THREE.Mesh(waterGeo, waterMat);
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
    buoy: std(0xc8372d, { roughness: 0.6 }),
    boxes: [0x2f6f9f, 0xb5452e, 0x3d7d4a, 0xc9a23a].map((c) => std(c, { roughness: 0.7 })),
    concrete: std(0x9a9a96),
    hull: std(0x2b3038, { roughness: 0.6 }),
    // ground
    earth: std(0x6b573d, { flatShading: true }),
    burnt: std(0x1d1b1a),
    sandbag: std(0xa89a72, { flatShading: true }),
    timber: std(0x5c4630),
    deadwood: std(0x4a4038),
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
      [-14, 14].forEach((z) => {                                  // quay lamps
        part(t, geo.pole, mats.steel, 6, 5, z, 1.5, 6, 1.5);
        const lamp = glow(0xffd9a0, 5);
        lamp.position.set(6, 8.2, z);
        t.add(lamp);
      });
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
      part(g, geo.box, mats.rust, 0, 0, 0, 2.3, 0.16, 0.16);
      part(g, geo.box, mats.rust, 0, 0, 0, 0.16, 2.3, 0.16);
      part(g, geo.box, mats.rust, 0, 0, 0, 0.16, 0.16, 2.3);
      g.rotation.set(0.62, 0, 0.62);
      g.position.y = 0.75;
      t.add(g);
    } },
    crater: { label: 'CRATER', w: 2.5, h: 0.6, build(t) {
      part(t, geo.craterRim, mats.earth, 0, 0.05, 0, 1, 0.6, 1);
      part(t, geo.craterPit, mats.burnt, 0, 0.04, 0);
    } },
    wreck: { label: 'VEHICLE', w: 3.3, h: 2.4, fixed: true, build(t) {
      const g = new THREE.Group();
      part(g, geo.box, mats.burnt, 0, 0.95, 0, 2.4, 1.1, 5);
      part(g, geo.box, mats.rust, 0, 1.9, 0.8, 2.2, 0.9, 1.8);
      [[-1.3, 1.6], [1.3, 1.6], [-1.3, -1.6], [1.3, -1.6]].forEach(([x, z]) => part(g, geo.wheel, mats.dark, x, 0.5, z));
      g.rotation.z = 0.07;
      t.add(g);
    } },
    deadtree: { label: 'DEAD TREE', w: 1.7, h: 5.2, build(t) {
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
    shelter: { label: 'SHELTER', w: 3.2, h: 3.2, far: true, fixed: true, build(t) {
      part(t, geo.gable, mats.sandbag, 0, 1, 0, 4, 2, 2.6);
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
  const ENV = {
    air: {
      speed: 17, margin: 1.8, band: 85, limit: 70, slope: 0.6, seg: [26, 40], relief: 3,
      alts: [2.6, 7, 15], climb: 0.4, overfly: 1.5,
      scatter: [['pine', 330], ['tree', 900], ['rock', 900], ['hay', 1000]],
      extras(s0, s1) {
        for (let k = 0; k < 2; k++) {
          if (Math.random() < 0.4) {
            scatter('house', s0, s1);
            if (Math.random() < 0.6) scatter('barn', s0, s1);
            if (Math.random() < 0.5) scatter('silo', s0, s1);
          }
          if (Math.random() < 0.12) scatter('mast', s0, s1);
          if (Math.random() < 0.15) scatter('windmill', s0, s1);
          if (freeFields.length && Math.random() < 0.75) placeField(s0, s1);
        }
      },
    },
    sea: {
      alt: 1.7, speed: 10, margin: 1.6, band: 85, limit: 70, slope: 0.45, seg: [24, 36], relief: 0,
      // two locations: open water with a heavy swell, and the sheltered approach to a port
      locs: {
        open: {
          amp: 1,
          scatter: [['debris', 1300], ['log', 1500], ['barrel', 1300], ['buoy', 2600], ['boat', 2400], ['container', 3200]],
          extras(s0, s1) {
            if (Math.random() < 0.25) scatter('cargoship', s0, s1);
            if (Math.random() < 0.12) scatter('lighthouse', s0, s1);
          },
        },
        port: {
          amp: 0.35,
          scatter: [['buoy', 1200], ['boat', 1300], ['container', 1900], ['debris', 1700], ['barrel', 1900]],
          extras(s0, s1) {
            if (Math.random() < 0.5) placeCrane(s0, s1);
            if (Math.random() < 0.6) scatter('port', s0, s1);
            if (Math.random() < 0.7) scatter('cargoship', s0, s1);
            if (Math.random() < 0.6) scatter('dock', s0, s1);
            if (Math.random() < 0.2) scatter('lighthouse', s0, s1);
          },
        },
      },
    },
    ground: {
      alt: 1.3, speed: 7, margin: 1.2, band: 65, limit: 50, slope: 0.4, seg: [18, 28], relief: 1.4,
      scatter: [['hedgehog', 520], ['crater', 600], ['deadtree', 700], ['block', 900], ['barricade', 1000],
        ['supply', 900], ['sandbags', 1000], ['trench', 2600], ['wire', 2600]],
      extras(s0, s1) {
        if (Math.random() < 0.4) scatter('dugout', s0, s1);
        if (Math.random() < 0.5) scatter('shelter', s0, s1);
        if (Math.random() < 0.35) scatter('wreck', s0, s1);
      },
    },
  };
  let loc = window.fnavLoc === 'port' ? 'port' : 'open';
  // an environment's settings, with those of the chosen location laid over them
  const resolve = (name) => Object.assign({ amp: 1 }, ENV[name], ENV[name].locs ? ENV[name].locs[loc] : null);
  let envName = ENV[window.fnavEnv] ? window.fnavEnv : 'air', cfg = resolve(envName);

  const DEPTH = 190;
  /* Object pools grow on demand: a class gets a new instance whenever all of its existing
     ones are in use (up to cls.max). Released objects are reused. */
  const objects = [];
  const free = {}, made = {}, ready = {};
  Object.keys(CLASSES).forEach((type) => { free[type] = []; made[type] = 0; });
  function make(type) {
    const t = new THREE.Group();
    t.userData = { type, cls: CLASSES[type] };
    if (ready[type]) t.add(pick(ready[type]).clone()); else CLASSES[type].build(t);
    t.visible = false;
    made[type]++;
    objects.push(t);
    scene.add(t);
    return t;
  }
  const take = (type) => free[type].pop() || (made[type] < (CLASSES[type].max || 400) ? make(type) : null);
  const release = (o) => { o.visible = false; free[o.userData.type].push(o); };

  /* ----- ready-made models (licence files sit next to them in models/): pines and dead
     trees by Quaternius, rocks, boats, buoys, cargo, crates and tents by Kenney, all CC0;
     broadleaf trees from a CGTrader tree pack, decimated for the web (see trees/LICENSE.txt).
     The hand-built shapes above are placeholders: they show at once and stay as the
     fallback (e.g. when the page is opened from disk and files cannot be fetched).
     Models are fetched per environment, the first time it is shown; once a class has
     loaded, every pooled object of that class swaps to a real model.
     fit = which dimension is matched to the class: 'h' height, 'w' footprint.
     set = the file holds several models side by side (five trees), used one by one. ----- */
  const MODELS = {
    pine: { env: 'air', fit: 'h', set: true, files: ['trees/pines'] },
    tree: { env: 'air', fit: 'h', set: true, files: ['trees/pack01'] },
    rock: { env: 'air', fit: 'w', files: ['rock_largeA', 'rock_largeC', 'rock_largeE', 'stone_largeB'] },
    log: { env: 'sea', fit: 'w', files: ['log_large', 'log'] },
    buoy: { env: 'sea', fit: 'h', files: ['watercraft/buoy', 'watercraft/buoy-flag'] },
    container: { env: 'sea', fit: 'w', files: ['watercraft/cargo-container-a', 'watercraft/cargo-container-b', 'watercraft/cargo-container-c'] },
    barrel: { env: 'sea', fit: 'w', files: ['pirate/barrel'] },
    debris: { env: 'sea', fit: 'w', files: ['pirate/crate', 'survival/box-large'] },
    boat: { env: 'sea', fit: 'w', files: ['watercraft/boat-tug-a', 'watercraft/boat-tug-b', 'watercraft/boat-fishing-small', 'watercraft/boat-speed-a'] },
    cargoship: { env: 'sea', fit: 'w', files: ['watercraft/ship-cargo-a', 'watercraft/ship-cargo-b', 'watercraft/ship-cargo-c'] },
    deadtree: { env: 'ground', fit: 'h', set: true, files: ['trees/dead'] },
    barricade: { env: 'ground', fit: 'w', files: ['survival/fence-fortified'] },
    shelter: { env: 'ground', fit: 'w', files: ['survival/tent', 'survival/tent-canvas', 'survival/structure-canvas', 'survival/structure-metal'] },
    supply: { env: 'ground', fit: 'w', files: ['survival/box-large', 'survival/barrel'] },
    // single models from poly.pizza (see models/poly/LICENSE.txt)
    barn: { env: 'air', fit: 'w', files: ['poly/barn', 'poly/big-barn'] },
    silo: { env: 'air', fit: 'h', files: ['poly/silo'] },
    hay: { env: 'air', fit: 'w', files: ['poly/hay'] },
    windmill: { env: 'air', fit: 'h', files: ['poly/windmill'] },
    mast: { env: 'air', fit: 'h', files: ['poly/pylon'] },
    lighthouse: { env: 'sea', fit: 'h', files: ['poly/lighthouse'] },
    dock: { env: 'sea', fit: 'w', files: ['poly/dock'] },
    // pivot = keep the model's own origin (centre of the portal), so the jib overhang is not squeezed into the footprint
    crane: { env: 'sea', fit: 'h', pivot: true, files: ['port/crane-sokol'] },
    wreck: { env: 'ground', fit: 'w', files: ['poly/broken-car', 'poly/tank', 'poly/pickup-armored'] },
    sandbags: { env: 'ground', fit: 'w', files: ['poly/sandbags', 'poly/sandbags-small'] },
    block: { env: 'ground', fit: 'w', files: ['poly/barrier'] },
  };
  const loadModels = (() => {
    if (!THREE.GLTFLoader) return () => {};
    const loader = new THREE.GLTFLoader(), bb = new THREE.Box3(), size = new THREE.Vector3(), mid = new THREE.Vector3();
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
    const prepare = (node, cls, fit, pivot) => {
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
        (Array.isArray(m.material) ? m.material : [m.material]).forEach((mat) => {
          mat.metalness = 0; // some kits ship fully metallic materials, which render black here
          mat.roughness = 0.9;
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
    return (env) => Object.keys(MODELS).forEach((type) => {
      const spec = MODELS[type], cls = CLASSES[type];
      if (spec.env !== env || asked[type]) return;
      asked[type] = true;
      Promise.all(spec.files.map(load)).then((scenes) => {
        const list = [];
        scenes.filter(Boolean).forEach((sc) => (spec.set ? split(sc) : [sc]).forEach((n) => list.push(prepare(n, cls, spec.fit, spec.pivot))));
        if (!list.length) return;
        ready[type] = list; // objects made from now on get a model straight away
        objects.forEach((o) => {
          if (o.userData.type !== type) return;
          while (o.children.length) o.remove(o.children[0]);
          o.add(pick(list).clone());
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
  const CROPS = [0xb39a4e, 0x587f3a, 0x5f4632, 0xbfae4a, 0x70904a];
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

  /* ----- route planning.
     s = distance along the track. The route is a chain of waypoints {s, x, y} joined by
     quintic ease curves, so velocity and acceleration are zero at every joint and the
     motion is smooth by construction (x across, y = altitude above ground for the drone).
     The world ahead is generated one planning step at a time: first the step is filled
     with objects across the whole strip, then the planner tries sideways (and, in the
     air, vertical) targets, cheapest first, and keeps the first one whose curve clears
     every object. The cost prefers flying straight and drifting towards a goal that
     changes every few hundred metres, so the route sweeps far left and right. ----- */
  let dist = 0, time = 0, goal = 0, goalUntil = 0, prefY = 0;
  const wp = [];
  const ease = (t) => t * t * t * (10 - 15 * t + 6 * t * t);
  // order 0 = position, 1 = slope d/ds, 2 = curvature d2/ds2; k = 'x' sideways or 'y' altitude
  function route(s, order, k = 'x') {
    let i = wp.length - 2;
    while (i > 0 && wp[i].s > s) i--;
    const a = wp[i], b = wp[i + 1], L = b.s - a.s, d = b[k] - a[k];
    const t = clamp((s - a.s) / L, 0, 1);
    if (order === 1) return d * 30 * t * t * (1 - t) * (1 - t) / L;
    if (order === 2) return d * 60 * t * (1 - t) * (1 - 2 * t) / (L * L);
    return a[k] + d * ease(t);
  }
  const pathX = (s) => route(s, 0);
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
  const overlaps = (x, s, w) => objects.some((o) => o.visible &&
    Math.hypot(x - o.position.x, s - o.userData.s) < w + o.userData.w + 0.8);

  function put(o, x, s, scale, side) {
    const c = o.userData.cls, w = c.w * scale;
    o.scale.setScalar(scale);
    o.rotation.set(0, c.face ? (side > 0 ? 0 : Math.PI)
      : c.across ? rand(-0.25, 0.25)
      : c.along ? rand(-0.12, 0.12) + (Math.random() < 0.5 ? 0 : Math.PI)
      : c.far ? rand(-0.5, 0.5) + (Math.random() < 0.5 ? 0 : Math.PI / 2)
      : rand(0, Math.PI * 2), 0);
    // stand it at the lowest point of its footprint: sunk a little on a slope, never floating
    let y = terrainH(x, s);
    if (terrA) for (const [dx, ds] of [[w, 0], [-w, 0], [0, w], [0, -w]]) y = Math.min(y, terrainH(x + dx, s + ds));
    o.position.set(x, y, dist - s);
    Object.assign(o.userData, { s, w, h: c.h * scale, conf: rand(0.84, 0.95), phase: rand(0, 6) });
    o.visible = true;
  }

  // place one object anywhere in the strip of [s0, s1]; near the start of the step it must
  // keep clear of the route that is already fixed there
  function scatter(type, s0, s1, xOf) {
    const o = take(type);
    if (!o) return;
    const c = o.userData.cls, scale = c.fixed ? 1 : rand(0.8, 1.35), w = c.w * scale, h = c.h * scale;
    const cx = wp[wp.length - 1].x;
    for (let i = 0; i < 12; i++) {
      const s = rand(s0, s1), x = xOf ? xOf(cx) : cx + rand(-cfg.band, cfg.band);
      if (s - w - cfg.margin < s0 + 8 && onRoute(x, s, w, h)) continue;
      if (overlaps(x, s, w)) continue;
      put(o, x, s, scale, x > cx ? 1 : -1);
      return o;
    }
    release(o);
  }

  // the port crane stands on the left at mid distance, its jib turned towards the route
  function placeCrane(s0, s1) {
    const o = scatter('crane', s0, s1, (cx) => cx - rand(30, 45));
    if (o) o.rotation.y = rand(-0.3, 0.3);
  }

  function populate(s0, s1) {
    const area = (s1 - s0) * cfg.band * 2;
    cfg.scatter.forEach(([type, per]) => {
      for (let i = Math.floor(area / per + Math.random()); i > 0; i--) scatter(type, s0, s1);
    });
    cfg.extras(s0, s1);
  }

  function plan() {
    const a = wp[wp.length - 1], L = rand(cfg.seg[0], cfg.seg[1]), end = a.s + L;
    populate(a.s, end);
    if (a.s > goalUntil) {
      goal = rand(-cfg.limit, cfg.limit);
      goalUntil = a.s + rand(100, 260);
      if (cfg.alts) prefY = rand(cfg.alts[0], cfg.alts[1]);
    }
    const near = objects.filter((o) => o.visible && o.userData.s > a.s - 15 && o.userData.s < end + 25);
    // candidate altitudes: stay, cruise, or just high enough to hop over something ahead
    let ys = [a.y];
    if (cfg.alts) {
      const climb = cfg.climb * L / 1.875;
      ys = [a.y, prefY, cfg.alts[0], ...near.map((o) => o.userData.h + cfg.overfly + 0.4)]
        .filter((y) => y >= cfg.alts[0] && y <= cfg.alts[2] && Math.abs(y - a.y) <= climb);
    }
    const reach = cfg.slope * L / 1.875, cands = [];
    for (let i = -12; i <= 12; i++) {
      const x = a.x + reach * i / 12;
      if (Math.abs(x) > cfg.limit) continue;
      for (const y of ys) {
        cands.push({ x, y, cost: Math.abs(x - goal) * 0.4 + Math.abs(x - a.x) * 0.6 + Math.abs(y - prefY) * 1.2 + (y - a.y > 0 ? (y - a.y) * 0.8 : 0) + Math.random() * 0.4 });
      }
    }
    cands.sort((p, q) => p.cost - q.cost);
    // walk the curve (and 8 m of straight line past its end, where the next step starts)
    const blocked = (c, clearIt) => {
      let hit = false;
      for (let s = a.s; s <= end + 8; s += 1.5) {
        const e = ease(Math.min(1, (s - a.s) / L)), x = a.x + (c.x - a.x) * e, y = a.y + (c.y - a.y) * e;
        for (const o of near) {
          if (!hits(o, x, y, s)) continue;
          if (!clearIt) return true;
          release(o); hit = true;
        }
      }
      return hit;
    };
    let best = cands.find((c) => !blocked(c));
    if (!best) { best = { x: a.x, y: a.y }; blocked(best, true); } // boxed in: drop what is in the way
    wp.push({ s: end, x: best.x, y: best.y });
  }

  function extend() {
    while (wp[wp.length - 1].s < dist + DEPTH) plan();
    while (wp.length > 2 && wp[1].s < dist - 10) wp.shift();
  }

  // start a fresh route from where the camera is
  function reset() {
    const x = clamp(camera.position.x, -cfg.limit, cfg.limit), y = cfg.alts ? cfg.alts[0] + 1 : 0;
    wp.length = 0;
    wp.push({ s: dist - 10, x, y }, { s: dist + 16, x, y });
    goal = x; goalUntil = dist + rand(40, 120); prefY = y;
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
  let vx = 0, ax = 0, roll = 0, agl = 0, W = 1, H = 1, tracked = 0;
  // ground colour by day / night, and the tint of dry patches
  const GROUND = { air: [0x58693a, 0x232c26, [1.14, 1.05, 0.76]], ground: [0x5c4f3c, 0x211c17, [1.15, 1.02, 0.85]] };
  function applyLook() {
    const sea = envName === 'sea';
    // a hazy, slightly desaturated day rather than a postcard blue
    const horizon = day ? (sea ? 0xaebfc9 : 0xb3c1c8) : 0x131b30;
    skyMat.uniforms.top.value.set(day ? 0x3f6c9e : 0x03050b);
    skyMat.uniforms.bottom.value.set(horizon);
    skyMat.uniforms.glowCol.value.set(day ? 0xffd6a0 : 0x141a2c);
    skyMat.uniforms.glowDir.value.copy(SKY_POS).normalize();
    scene.fog.color.set(horizon);
    scene.fog.density = day ? 0.0095 : 0.015;
    renderer.toneMappingExposure = day ? 0.8 : 1.2;
    hemi.color.set(day ? 0xc4d4e6 : 0x6c80d0);
    hemi.groundColor.set(day ? (sea ? 0x3a4a50 : 0x5a5644) : 0x07090d);
    hemi.intensity = day ? 0.6 : 0.42;
    sun.color.set(day ? 0xffe4c0 : 0xb4c4ff);
    sun.intensity = day ? 1.3 : 0.5;
    lightDir = LIGHT[day ? 'day' : 'night'];
    head.intensity = day ? 0 : 1.7;
    mats.glass.emissiveIntensity = day ? 0 : 1.3;
    ground.visible = !sea;
    water.visible = sea;
    if (!sea) {
      const [d, n, dry] = GROUND[envName];
      groundMat.color.set(day ? d : n);
      U.dry.value.set(...dry);
    }
    waterMat.color.set(0xffffff);
    U.deep.value.set(day ? 0x082636 : 0x020b12);
    U.shallow.value.set(day ? 0x1b5d68 : 0x082630);
    U.foam.value.set(day ? 0xd8e2e4 : 0x5d6c78);
    waterMat.envMap = SKY_ENV[day ? 'day' : 'night'];
    waterMat.envMapIntensity = day ? 0.65 : 0.8;
    waterMat.needsUpdate = true;
    disc.visible = day;
    disc.material.color.set(0xfff6e0);
    halo.material.color.set(0x5a4630);
    moon.visible = moonHalo.visible = !day;
    stars.visible = !day;
    dustMat.color.set(day || sea ? 0xffffff : 0xfff0a0);
    dustMat.opacity = day ? 0.3 : sea ? 0.4 : 0.8;
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
    loadModels(name);
    objects.forEach((o) => { if (o.visible) release(o); });
    fields.forEach((f) => { if (f.visible) { f.visible = false; freeFields.push(f); } });
    vx = ax = roll = 0;
    reset();
    applyLook();
  }
  document.addEventListener('envchange', (e) => setEnv(e.detail));
  document.addEventListener('locchange', (e) => {
    loc = e.detail === 'port' ? 'port' : 'open';
    if (envName === 'sea') setEnv('sea');
  });

  /* ----- motion ----- */
  // place the camera for the current distance; each platform moves in its own way
  function pose() {
    const x = pathX(dist), gy = terrainH(x, dist);
    vx = route(dist, 1) * speed;
    ax = route(dist, 2) * speed * speed;
    let y = gy + (cfg.alt || 0), pitch = 0, tilt = 0, down = 0.3, look = 0;
    if (envName === 'air') {
      agl = pathY(dist) + Math.sin(time * 0.4) * 0.12;
      y = gy + agl;
      look = route(dist, 1, 'y') * 30 * 0.7;               // eyes follow the climb or the descent
      tilt = -Math.atan(ax / 9.81);                        // banks into the turn
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
    }
    roll += (tilt - roll) * 0.08;
    camera.position.set(x, y, 0);
    camera.lookAt(x + vx / speed * 30, y - down + look, -30);
    camera.rotateX(pitch);
    camera.rotateZ(roll);
    if (envName === 'ground') agl = Math.abs(roll * 57.3);
    return y;
  }

  function update(dt) {
    time += dt;
    speed = cfg.speed * (1 + Math.sin(time * 0.12) * 0.08);
    dist += speed * dt;
    extend();
    const y = pose(), cx = camera.position.x;
    const sea = envName === 'sea';
    U.dist.value = dist;
    U.time.value = time;

    // the sky, the ground / water sheet and the shadow box travel sideways with the camera
    skyGroup.position.x = cx;
    ground.position.x = Math.round(cx / GCELL) * GCELL;
    sun.target.position.set(cx, y - 3, -30);
    sun.position.copy(lightDir).multiplyScalar(70).add(sun.target.position);
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

  function drawHud() {
    h2.clearRect(0, 0, W, H);
    h2.font = '10px "JetBrains Mono", ui-monospace, monospace';
    h2.lineWidth = 1;
    const cx = W / 2, cy = H / 2;

    // sky references the navigator is locked on
    const refs = day ? [disc.position] : navStars;
    h2.strokeStyle = h2.fillStyle = colors.accent;
    refs.forEach((p, i) => {
      const s = toScreen(p.x + skyGroup.position.x, p.y, p.z);
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
    for (let d = 4; d <= 90; d += 3) {
      const x = pathX(dist + d);
      const s = toScreen(x, sea ? wave(x, dist + d, time) + 0.15 : terrainH(x, dist + d) + 0.05, -d);
      if (!s) continue;
      if (pen) h2.lineTo(s[0], s[1]); else { h2.moveTo(s[0], s[1]); pen = true; }
    }
    h2.stroke();
    h2.setLineDash([]);

    // detections
    tracked = 0;
    for (const o of objects) {
      if (!o.visible) continue;
      const u = o.userData, d = -o.position.z;
      if (d < 3 || d > 95) continue;
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
        const action = over ? 'OVERFLY' : threat ? 'AVOID' : 'TRACK';
        h2.fillText(`${u.cls.label} ${(conf * 100).toFixed(0)}%  ${d.toFixed(0)}m`, Math.max(4, x0), Math.max(12, y0 - 16));
        h2.fillText(action, Math.max(4, x0), Math.max(24, y0 - 5));
      }
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

  function frame(now) {
    const dt = clamp((now - last) / 1000, 0.001, 0.05);
    last = now;
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

  seaAmp = U.amp.value = cfg.amp;
  terrA = U.terrA.value = cfg.relief;
  loadModels(envName);
  reset();
  applyLook();
})();
