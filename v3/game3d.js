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

  /* ----- sky dome with a vertical gradient ----- */
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color() }, bottom: { value: new THREE.Color() } },
    vertexShader: 'varying float vY; void main(){ vY = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 bottom; varying float vY;
      void main(){
        gl_FragColor = vec4(mix(bottom, top, pow(max(vY, 0.0), 0.55)), 1.0);
        #include <tonemapping_fragment>
        #include <encodings_fragment>
      }`,
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(450, 32, 16), skyMat));

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

  /* ----- stars, sun / moon disc, distant ridge ----- */
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
  stars.add(starField(700, 1.3), starField(90, 2.4));
  const disc = new THREE.Mesh(new THREE.SphereGeometry(10, 24, 16), new THREE.MeshBasicMaterial({ fog: false }));
  disc.position.set(-90, 95, -380);
  const halo = glow(0xffffff, 110);
  disc.add(halo);
  scene.add(stars, disc);

  // reference points the navigator "locks" onto, drawn in the HUD
  const navStars = [[-0.42, 0.34, -1], [0.08, 0.52, -1], [0.5, 0.3, -1]]
    .map((d) => new THREE.Vector3(...d).normalize().multiplyScalar(400));
  navStars.forEach((p) => { const s = glow(0xcfe0ff, 14); s.position.copy(p); stars.add(s); });

  const ridgeMat = new THREE.MeshBasicMaterial({ fog: false });
  const ridge = new THREE.Group();
  for (let i = 0; i < 16; i++) {
    const m = new THREE.Mesh(new THREE.ConeGeometry(rand(60, 110), rand(30, 75), 5), ridgeMat);
    m.position.set(-420 + i * 56 + rand(-15, 15), 0, -380 + rand(-20, 20));
    m.rotation.y = rand(0, 3);
    ridge.add(m);
  }
  scene.add(ridge);

  /* ----- ground with a speckle texture that scrolls with speed ----- */
  const gc = document.createElement('canvas');
  gc.width = gc.height = 256;
  const g2 = gc.getContext('2d');
  g2.fillStyle = '#fff'; g2.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2600; i++) {
    g2.fillStyle = `rgba(0,0,0,${rand(0.04, 0.4)})`;
    g2.fillRect(rand(0, 256), rand(0, 256), rand(1, 5), rand(1, 5));
  }
  const groundTex = new THREE.CanvasTexture(gc);
  groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping;
  groundTex.anisotropy = 4;
  const TILE = 14; // world units per texture tile
  groundTex.repeat.set(600 / TILE, 600 / TILE);
  const groundMat = new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  /* ----- sea: a swell built from four wave trains, smooth-shaded and reflecting the sky ----- */
  // direction (across, along), wavelength and amplitude in metres; speed follows deep-water dispersion
  const WAVES = [[0.2, 1, 62, 0.46], [-0.45, 0.9, 35, 0.27], [0.7, 0.7, 19, 0.13], [-0.8, 0.55, 11, 0.06]].map(([dx, ds, L, a], i) => {
    const n = Math.hypot(dx, ds), k = Math.PI * 2 / L;
    return { kx: dx / n * k, ks: ds / n * k, w: Math.sqrt(9.81 * k), a, ph: i * 1.7 };
  });
  let seaAmp = 1; // sea state: 1 in open water, lower inside a sheltered harbour
  // wave height at world position (x across, s along the route) and time t
  const wave = (x, s, t) => {
    let h = 0;
    for (const q of WAVES) h += q.a * Math.sin(q.kx * x + q.ks * s + q.w * t + q.ph);
    return h * seaAmp;
  };
  const WSIZE = 300, WSEG = 100;
  const waterGeo = new THREE.PlaneGeometry(WSIZE, WSIZE, WSEG, WSEG).rotateX(-Math.PI / 2);
  waterGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(waterGeo.attributes.position.count * 3).fill(1), 3));
  // ripples too fine for the mesh: a tileable normal map that drifts over the surface
  const rippleTex = (() => {
    const N = 128, c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d'), img = ctx.createImageData(N, N);
    const F = [[3, 1, 0], [-2, 4, 1.3], [5, -3, 2.1], [1, 6, 0.7], [7, 2, 4.2]]; // whole periods -> seamless
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let nx = 0, ny = 0;
      for (const [a, b, ph] of F) {
        const d = Math.cos(Math.PI * 2 * (a * x + b * y) / N + ph) / Math.hypot(a, b);
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
    t.repeat.set(30, 30);
    return t;
  })();
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
  const SKY_ENV = { day: skyEnv('#3f86d6', '#eef4f6', '#1d4250'), night: skyEnv('#04060d', '#22335c', '#050a10') };
  const waterMat = new THREE.MeshStandardMaterial({
    roughness: 0.12, metalness: 0, vertexColors: true,
    normalMap: rippleTex, normalScale: new THREE.Vector2(0.4, 0.4),
  });
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.position.z = 20 - WSIZE / 2;
  water.receiveShadow = true;
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
    pine: { label: 'PINE', w: 2.1, h: 8.1, n: 44, build(t) {
      part(t, geo.pineTrunk, mats.bark, 0, 2, 0);
      const a = pick(mats.pine), b = pick(mats.pine);
      geo.tiers.forEach(({ g, y }, i) => { part(t, g, i % 2 ? a : b, 0, y, 0).rotation.y = rand(0, 6); });
    } },
    tree: { label: 'TREE', w: 3.0, h: 7.2, n: 16, build(t) {
      part(t, geo.oakTrunk, mats.bark, 0, 1.7, 0);
      part(t, geo.branch, mats.bark, 0.6, 3.6, 0).rotation.z = -0.7;
      part(t, geo.branch, mats.bark, -0.6, 3.7, 0.2).rotation.z = 0.7;
      [[0, 5, 0, 1], [1.3, 4.4, 0.3, 0.75], [-1.2, 4.5, -0.4, 0.8], [0.2, 4.3, 1.2, 0.7], [-0.3, 4.6, -1.2, 0.7], [0, 6, 0, 0.7]]
        .forEach(([x, y, z, s], i) => { part(t, geo.crowns[i % 3], mats.leaf[i % 3], x, y, z, s, s, s).rotation.y = rand(0, 6); });
    } },
    rock: { label: 'ROCK', w: 1.3, h: 1.0, n: 16, low: true, build(t) {
      part(t, pick(geo.rocks), mats.rock, 0, 0.35, 0, 1.3, 0.75, 1);
      part(t, pick(geo.rocks), mats.rock, 0.9, 0.15, 0.4, 0.45, 0.45, 0.45);
    } },
    hay: { label: 'HAY BALE', w: 0.9, h: 1.4, n: 14, low: true, fixed: true, build(t) {
      part(t, geo.bale, mats.hay, 0, 0.7, 0);
    } },
    mast: { label: 'PYLON', w: 3.0, h: 18.4, n: 3, fixed: true, build(t) {
      part(t, geo.lattice, mats.lattice, 0, 9, 0);
      [13.5, 16].forEach((y) => {
        part(t, geo.arm, mats.steel, 0, y, 0);
        part(t, geo.insulator, mats.dark, -1.7, y - 0.4, 0);
        part(t, geo.insulator, mats.dark, 1.7, y - 0.4, 0);
      });
      part(t, geo.beacon, mats.beacon, 0, 18.2, 0).add(glow(0xff3030, 3));
    } },
    house: { label: 'FARMHOUSE', w: 3.9, h: 4.8, n: 4, far: true, fixed: true, build(t) {
      part(t, geo.box, pick(mats.walls), 0, 1.4, 0, 5.4, 2.8, 4.2);
      roof(t, pick(mats.roofs), 0, 2.8, 5.4, 4.2, 2);
      part(t, geo.box, mats.dark, 1.6, 4.2, -0.6, 0.5, 1.4, 0.5);
      part(t, geo.box, mats.dark, -1.5, 1, 2.11, 1, 2, 0.08);
      part(t, geo.box, mats.glass, 0.2, 1.7, 2.11, 1, 1, 0.08);
      part(t, geo.box, mats.glass, 1.7, 1.7, 2.11, 1, 1, 0.08);
      part(t, geo.box, mats.glass, 2.71, 1.7, 0, 0.08, 1, 1.2);
      part(t, geo.box, mats.glass, -2.71, 1.7, 0, 0.08, 1, 1.2);
    } },
    barn: { label: 'BARN', w: 5.0, h: 7.2, n: 2, far: true, fixed: true, build(t) {
      part(t, geo.box, mats.barn, 0, 2, 0, 7.5, 4, 5.5);
      roof(t, mats.barnRoof, 0, 4, 7.5, 5.5, 3.2);
      part(t, geo.box, mats.trim, 0, 1.6, 2.76, 2.8, 3.2, 0.08);
      part(t, geo.box, mats.dark, 0, 1.5, 2.79, 2.3, 2.9, 0.08);
      part(t, geo.box, mats.trim, -2.6, 2.4, 2.76, 0.9, 0.9, 0.08);
      part(t, geo.box, mats.trim, 2.6, 2.4, 2.76, 0.9, 0.9, 0.08);
    } },
    silo: { label: 'SILO', w: 1.8, h: 8.4, n: 2, far: true, fixed: true, build(t) {
      part(t, geo.siloBody, mats.silo, 0, 3.5, 0);
      part(t, geo.siloDome, mats.silo, 0, 7, 0);
    } },
    windmill: { label: 'WINDMILL', w: 5, h: 12, n: 2, far: true, fixed: true, build(t) {
      part(t, geo.siloBody, mats.trim, 0, 4.5, 0, 1.2, 1.3, 1.2);
      part(t, geo.box, mats.timber, 0, 9, 1.8, 9, 0.3, 0.1).rotation.z = 0.6;
      part(t, geo.box, mats.timber, 0, 9, 1.8, 0.3, 9, 0.1).rotation.z = 0.6;
    } },

    /* --- sea: open water, drifting debris, a port now and then --- */
    debris: { label: 'DEBRIS', w: 1.5, h: 0.8, n: 14, float: true, sink: 0.35, build(t) {
      part(t, geo.box, mats.wood, 0, 0.1, 0, 0.9, 0.7, 0.9).rotation.set(0.2, 0.4, 0.15);
      part(t, geo.box, mats.wood, 0.9, 0, 0.5, 1.8, 0.08, 0.3).rotation.y = 0.5;
      part(t, geo.box, mats.boxes[3], -0.7, 0.05, -0.5, 0.5, 0.4, 0.5).rotation.z = 0.3;
    } },
    log: { label: 'DRIFTWOOD', w: 1.8, h: 0.5, n: 10, float: true, sink: 0.4, build(t) {
      part(t, geo.log, mats.deadwood, 0, 0.05, 0);
      part(t, geo.branch, mats.deadwood, 0.6, 0.3, 0.2, 0.7, 0.5, 0.7).rotation.x = 0.9;
    } },
    barrel: { label: 'BARREL', w: 0.8, h: 0.6, n: 12, float: true, fixed: true, sink: 0.45, build(t) {
      part(t, geo.barrel, mats.rust, 0, 0.08, 0);
    } },
    buoy: { label: 'BUOY', w: 1.0, h: 2.6, n: 14, float: true, fixed: true, sink: 0.12, build(t) {
      part(t, geo.buoyBody, mats.buoy, 0, 0.35, 0);
      part(t, geo.pole, mats.steel, 0, 1.6, 0, 1, 1.6, 1);
      part(t, geo.beacon, mats.beacon, 0, 2.5, 0).add(glow(0xff3030, 2.4));
    } },
    container: { label: 'CONTAINER', w: 3.5, h: 1.8, n: 6, float: true, fixed: true, sink: 0.45, build(t) {
      part(t, geo.box, pick(mats.boxes), 0, 0.2, 0, 6.1, 2.6, 2.44).rotation.set(0.1, 0, 0.14);
    } },
    // quay with a gantry crane, stacked containers and a moored ship; the water side faces -x
    port: { label: 'PORT', w: 25, h: 18, n: 3, far: true, fixed: true, face: true, build(t) {
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
    crane: { label: 'PORT CRANE', w: 10, h: 34, n: 1, far: true, fixed: true, build(t) {
      [[-4, -4], [-4, 4], [4, -4], [4, 4]].forEach(([x, z]) => part(t, geo.box, mats.hull, x, 4, z, 0.8, 8, 0.8));
      part(t, geo.box, mats.trim, 0, 15, 0, 2, 14, 2);            // tower
      part(t, geo.box, mats.trim, 0, 23, 0, 5, 3, 4);             // cabin
      part(t, geo.box, mats.buoy, 11, 27, 0, 22, 1, 1).rotation.z = 0.35; // jib reaching over the water (+x)
    } },
    boat: { label: 'BOAT', w: 3.3, h: 4.6, n: 10, float: true, fixed: true, sink: 0.1, build(t) {
      part(t, geo.box, mats.hull, 0, 0.5, 0, 2.2, 1.2, 6);
      part(t, geo.box, mats.trim, 0, 1.8, -0.6, 1.6, 1.4, 2);
    } },
    cargoship: { label: 'CARGO SHIP', w: 16, h: 13, n: 4, far: true, fixed: true, along: true, sink: 0.08, build(t) {
      part(t, geo.box, mats.hull, 0, 1.5, 0, 7, 5, 30);
      part(t, geo.box, mats.trim, 0, 6.5, 10, 5.4, 5, 6);
      [-8, -2, 4].forEach((z, i) => part(t, geo.box, mats.boxes[i], 0, 5.3, z, 5.6, 2.6, 5.4));
    } },
    lighthouse: { label: 'LIGHTHOUSE', w: 4, h: 16, n: 2, far: true, fixed: true, sink: 0.03, build(t) {
      part(t, geo.siloBody, mats.trim, 0, 7, 0, 1, 2, 1);
      part(t, geo.beacon, mats.beacon, 0, 14.6, 0, 3, 3, 3);
    } },
    dock: { label: 'PIER', w: 7, h: 2.6, n: 4, far: true, fixed: true, sink: 0.2, build(t) {
      part(t, geo.box, mats.timber, 0, 0.9, 0, 3, 0.3, 13);
      [-5, 0, 5].forEach((z) => part(t, geo.box, mats.timber, 1.2, 0.2, z, 0.3, 2, 0.3));
    } },

    /* --- ground: fortified field --- */
    trench: { label: 'TRENCH', w: 5.2, h: 1.2, n: 5, fixed: true, across: true, build(t) {
      part(t, geo.berm, mats.earth, 0, 0.1, 1.5, 1, 0.7, 1);
      part(t, geo.berm, mats.earth, 0, 0.1, -1.5, 1, 0.6, 1).rotation.y = Math.PI;
      part(t, geo.box, mats.burnt, 0, 0.03, 0, 9, 0.06, 1.8);     // the dug-out floor
      [-3.6, -1.2, 1.2, 3.6].forEach((x) => part(t, geo.box, mats.timber, x, 0.5, -0.8, 0.14, 1, 0.14));
      part(t, geo.box, mats.timber, 0, 0.9, -0.8, 7.6, 0.12, 0.12);
      for (let i = 0; i < 6; i++) part(t, geo.bag, mats.sandbag, -2.6 + i * 1.0, 0.75 + (i % 2) * 0.05, 1.5).rotation.y = rand(-0.2, 0.2);
    } },
    hedgehog: { label: 'HEDGEHOG', w: 1.4, h: 1.5, n: 16, fixed: true, build(t) {
      const g = new THREE.Group();
      part(g, geo.box, mats.rust, 0, 0, 0, 2.3, 0.16, 0.16);
      part(g, geo.box, mats.rust, 0, 0, 0, 0.16, 2.3, 0.16);
      part(g, geo.box, mats.rust, 0, 0, 0, 0.16, 0.16, 2.3);
      g.rotation.set(0.62, 0, 0.62);
      g.position.y = 0.75;
      t.add(g);
    } },
    crater: { label: 'CRATER', w: 2.5, h: 0.6, n: 12, build(t) {
      part(t, geo.craterRim, mats.earth, 0, 0.05, 0, 1, 0.6, 1);
      part(t, geo.craterPit, mats.burnt, 0, 0.04, 0);
    } },
    wreck: { label: 'VEHICLE', w: 3.3, h: 2.4, n: 4, fixed: true, build(t) {
      const g = new THREE.Group();
      part(g, geo.box, mats.burnt, 0, 0.95, 0, 2.4, 1.1, 5);
      part(g, geo.box, mats.rust, 0, 1.9, 0.8, 2.2, 0.9, 1.8);
      [[-1.3, 1.6], [1.3, 1.6], [-1.3, -1.6], [1.3, -1.6]].forEach(([x, z]) => part(g, geo.wheel, mats.dark, x, 0.5, z));
      g.rotation.z = 0.07;
      t.add(g);
    } },
    deadtree: { label: 'DEAD TREE', w: 1.7, h: 5.2, n: 14, build(t) {
      part(t, geo.deadTrunk, mats.deadwood, 0, 2.5, 0).rotation.z = rand(-0.12, 0.12);
      part(t, geo.branch, mats.deadwood, 0.5, 3.4, 0, 0.8, 0.8, 0.8).rotation.z = -0.9;
      part(t, geo.branch, mats.deadwood, -0.4, 2.6, 0.1, 0.7, 0.6, 0.7).rotation.z = 1;
    } },
    block: { label: 'BARRIER', w: 1.6, h: 1.0, n: 10, fixed: true, build(t) {
      part(t, geo.box, mats.concrete, 0, 0.5, 0, 2.4, 1, 1);
      part(t, geo.box, mats.concrete, 0, 1.05, 0, 1.6, 0.1, 0.5);
    } },
    wire: { label: 'WIRE', w: 3.7, h: 1.3, n: 5, fixed: true, across: true, build(t) {
      [-3, 0, 3].forEach((x) => part(t, geo.box, mats.timber, x, 0.65, 0, 0.1, 1.3, 0.1));
      for (let i = 0; i < 9; i++) part(t, geo.coil, mats.steel, -3 + i * 0.75, 0.55, 0);
    } },
    dugout: { label: 'DUGOUT', w: 4.8, h: 2.2, n: 3, far: true, fixed: true, build(t) {
      part(t, geo.mound, mats.earth, 0, 0, 0, 1, 0.5, 1);
      part(t, geo.box, mats.timber, 0, 0.7, 3.3, 3, 1.4, 0.3);
      part(t, geo.box, mats.burnt, 0, 0.9, 3.36, 1.7, 0.35, 0.3);
    } },
    barricade: { label: 'BARRICADE', w: 1.7, h: 1.7, n: 8, fixed: true, across: true, build(t) {
      part(t, geo.box, mats.timber, 0, 0.9, 0, 3, 0.2, 0.2);
      [-1.2, 0, 1.2].forEach((x) => part(t, geo.box, mats.timber, x, 0.8, 0, 0.16, 1.6, 0.16).rotation.x = 0.5);
    } },
    shelter: { label: 'SHELTER', w: 3.2, h: 3.2, n: 4, far: true, fixed: true, build(t) {
      part(t, geo.gable, mats.sandbag, 0, 1, 0, 4, 2, 2.6);
    } },
    supply: { label: 'SUPPLY CRATE', w: 1.1, h: 1.1, n: 10, fixed: true, build(t) {
      part(t, geo.box, mats.wood, 0, 0.5, 0, 1.2, 1, 1.2);
    } },
    sandbags: { label: 'SANDBAGS', w: 2.6, h: 1.2, n: 8, fixed: true, across: true, build(t) {
      for (let i = 0; i < 10; i++) part(t, geo.bag, mats.sandbag, -2 + (i % 5) * 1.0 + (i > 4 ? 0.5 : 0), i > 4 ? 0.48 : 0.16, 0);
    } },
  };

  /* ----- environments: what each platform meets, and how it moves ----- */
  const ENV = {
    air: {
      alt: 2.9, speed: 17, margin: 1.8, limit: 12, field: 30, straight: [18, 38],
      len: (delta) => clamp(delta * 9, 45, 75),
      blockers: ['pine', 'pine', 'pine', 'tree', 'tree', 'mast'],
      scatter: [['pine', 6], ['tree', 18], ['rock', 16], ['hay', 20]],
      extras(s0, s1) {
        if (Math.random() < 0.45) {
          scatter('house', s0, s1);
          if (Math.random() < 0.6) scatter('barn', s0, s1);
          if (Math.random() < 0.5) scatter('silo', s0, s1);
        }
        if (Math.random() < 0.15) scatter('mast', s0, s1);
        if (Math.random() < 0.2) scatter('windmill', s0, s1);
        if (freeFields.length && Math.random() < 0.7) {
          const f = freeFields.pop(), side = Math.random() < 0.5 ? -1 : 1;
          f.scale.set(rand(18, 38), 1, (s1 - s0) * rand(0.8, 1.3));
          f.userData.s = (s0 + s1) / 2;
          f.position.x = side * rand(24, 46);
          f.material.color.set(pick(CROPS));
          f.visible = true;
        }
      },
    },
    sea: {
      alt: 1.7, speed: 10, margin: 1.6, limit: 13, field: 34, straight: [14, 30],
      len: (delta) => clamp(delta * 7, 30, 55),
      // two locations: open water with a heavy swell, and the sheltered approach to a port
      locs: {
        open: {
          amp: 1,
          blockers: ['debris', 'log', 'container', 'barrel', 'boat', 'debris'],
          scatter: [['debris', 20], ['log', 30], ['barrel', 26], ['buoy', 60], ['boat', 80]],
          extras(s0, s1) {
            if (Math.random() < 0.15) scatter('cargoship', s0, s1);
            if (Math.random() < 0.12) scatter('lighthouse', s0, s1);
          },
        },
        port: {
          amp: 0.35,
          blockers: ['boat', 'buoy', 'container', 'boat', 'debris', 'buoy'],
          scatter: [['buoy', 18], ['boat', 20], ['container', 45], ['debris', 34], ['barrel', 40]],
          extras(s0, s1) {
            if (Math.random() < 0.6) placeCrane(s0, s1);
            if (Math.random() < 0.6) scatter('port', s0, s1);
            if (Math.random() < 0.7) scatter('cargoship', s0, s1);
            if (Math.random() < 0.5) scatter('dock', s0, s1);
            if (Math.random() < 0.25) scatter('lighthouse', s0, s1);
          },
        },
      },
    },
    ground: {
      alt: 1.3, speed: 7, margin: 1.2, limit: 10, field: 26, straight: [10, 22],
      len: (delta) => clamp(delta * 6, 22, 46),
      blockers: ['trench', 'hedgehog', 'crater', 'wire', 'wreck', 'block', 'barricade', 'sandbags'],
      scatter: [['hedgehog', 13], ['crater', 14], ['deadtree', 9], ['block', 24], ['barricade', 26], ['supply', 20], ['sandbags', 24]],
      extras(s0, s1) {
        if (Math.random() < 0.3) scatter('dugout', s0, s1);
        if (Math.random() < 0.4) scatter('shelter', s0, s1);
        if (Math.random() < 0.25) scatter('wreck', s0, s1);
      },
    },
  };
  let loc = window.fnavLoc === 'port' ? 'port' : 'open';
  // an environment's settings, with those of the chosen location laid over them
  const resolve = (name) => Object.assign({ amp: 1 }, ENV[name], ENV[name].locs ? ENV[name].locs[loc] : null);
  let envName = ENV[window.fnavEnv] ? window.fnavEnv : 'air', cfg = resolve(envName);

  const DEPTH = 190;
  const objects = [];
  const free = {};
  Object.keys(CLASSES).forEach((type) => {
    free[type] = [];
    for (let i = 0; i < CLASSES[type].n; i++) {
      const t = new THREE.Group();
      t.userData = { type, cls: CLASSES[type] };
      CLASSES[type].build(t);
      t.visible = false;
      free[type].push(t);
      objects.push(t);
      scene.add(t);
    }
  });
  const take = (type) => free[type].pop();
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
        const ready = [];
        scenes.filter(Boolean).forEach((sc) => (spec.set ? split(sc) : [sc]).forEach((n) => ready.push(prepare(n, cls, spec.fit, spec.pivot))));
        if (!ready.length) return;
        objects.forEach((o) => {
          if (o.userData.type !== type) return;
          while (o.children.length) o.remove(o.children[0]);
          o.add(pick(ready).clone());
        });
        if (!raf) render();
      });
    });
  })();

  // crop fields beside the route: striped planes in a few crop colours
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
  const CROPS = [0xc9a94a, 0x5f8f3a, 0x6b4a32, 0xd8c23a, 0x7fa04a];
  const fieldGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const fields = [], freeFields = [];
  for (let i = 0; i < 7; i++) {
    const f = new THREE.Mesh(fieldGeo, std(0xffffff, { map: rowTex, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    f.receiveShadow = true;
    f.visible = false;
    f.position.y = 0.03;
    fields.push(f); freeFields.push(f);
    scene.add(f);
  }

  /* ----- route.
     s = distance along the track. The route is a chain of waypoints {s, x} joined by
     quintic ease curves, so lateral velocity and acceleration are zero at every joint
     and the motion is smooth by construction. Each manoeuvre is generated around a
     "blocker" obstacle standing on the line the platform was following, so the turn has
     a visible reason. Everything else is placed clear of the route and of each other. ----- */
  let dist = 0, time = 0, manoeuvreNext = true;
  const wp = [{ s: -10, x: 0 }, { s: 40, x: 0 }];
  // order 0 = position, 1 = slope dx/ds, 2 = curvature d2x/ds2
  function route(s, order) {
    let i = wp.length - 2;
    while (i > 0 && wp[i].s > s) i--;
    const a = wp[i], b = wp[i + 1], L = b.s - a.s, d = b.x - a.x;
    const t = clamp((s - a.s) / L, 0, 1);
    if (order === 1) return d * 30 * t * t * (1 - t) * (1 - t) / L;
    if (order === 2) return d * 60 * t * (1 - t) * (1 - 2 * t) / (L * L);
    return a.x + d * t * t * t * (10 - 15 * t + 6 * t * t);
  }
  const pathX = (s) => route(s, 0);

  // is a footprint of radius w at (x, s) clear of the route, across its whole depth?
  const clear = (x, s, w) => {
    for (let ds = -6; ds <= 6; ds += 3) if (Math.abs(x - pathX(s + ds)) < w + cfg.margin) return false;
    return true;
  };
  // does it touch anything already standing? (no house inside a tree, no crate inside a pier)
  const overlaps = (x, s, w) => objects.some((o) => o.visible &&
    Math.hypot(x - o.position.x, s - o.userData.s) < w + o.userData.w + 0.8);

  function put(o, x, s, scale, block, side) {
    const c = o.userData.cls;
    o.scale.setScalar(scale);
    o.rotation.set(0, c.face ? (side > 0 ? 0 : Math.PI)
      : c.across ? rand(-0.25, 0.25)
      : c.along ? rand(-0.12, 0.12) + (Math.random() < 0.5 ? 0 : Math.PI)
      : c.far ? rand(-0.5, 0.5) + (Math.random() < 0.5 ? 0 : Math.PI / 2)
      : rand(0, Math.PI * 2), 0);
    o.position.set(x, 0, dist - s);
    Object.assign(o.userData, { s, w: c.w * scale, h: c.h * scale, block: !!block, conf: rand(0.84, 0.95), phase: rand(0, 6) });
    o.visible = true;
  }

  function scatter(type, s0, s1) {
    const o = take(type);
    if (!o) return;
    const c = o.userData.cls, scale = c.fixed ? 1 : rand(0.8, 1.35), w = c.w * scale;
    for (let i = 0; i < 16; i++) {
      const s = rand(s0, s1), px = pathX(s), side = Math.random() < 0.5 ? -1 : 1;
      const x = c.far ? px + side * (w + cfg.margin + rand(7, 26))        // yards, piers, dugouts sit back
        : c.low || Math.random() < 0.5 ? rand(-cfg.field, cfg.field)
        : px + side * (w + cfg.margin + rand(0.3, 5));                    // obstacles flanking the route
      if (!c.low && !clear(x, s, w)) continue;
      if (overlaps(x, s, w)) continue;
      put(o, x, s, scale, false, side);
      return;
    }
    release(o);
  }

  // the port crane stands on the left at mid distance, its jib turned towards the route
  function placeCrane(s0, s1) {
    const o = take('crane');
    if (!o) return; // the only one is already in view
    for (let i = 0; i < 16; i++) {
      const s = rand(s0, s1), x = pathX(s) - rand(32, 42);
      if (overlaps(x, s, o.userData.cls.w)) continue;
      put(o, x, s, 1, false, -1);
      o.rotation.y = rand(-0.3, 0.3);
      return;
    }
    release(o);
  }

  function populate(s0, s1) {
    const len = s1 - s0;
    cfg.scatter.forEach(([type, per]) => {
      for (let i = Math.floor(len / per + Math.random()); i > 0; i--) scatter(type, s0, s1);
    });
    cfg.extras(s0, s1);
  }

  function extend() {
    while (wp[wp.length - 1].s < dist + DEPTH) {
      const a = wp[wp.length - 1];
      const blocker = manoeuvreNext && (take(pick(cfg.blockers)) || take(cfg.blockers[0]));
      if (blocker) {
        const c = blocker.userData.cls, scale = c.fixed ? 1 : rand(0.9, 1.35), w = c.w * scale;
        // sidestep far enough to clear the blocker, over a distance long enough to stay gentle
        const delta = (w + cfg.margin) / 0.8 + rand(0.5, 2);
        let dir = Math.random() < 0.5 ? -1 : 1;
        if (Math.abs(a.x + dir * delta) > cfg.limit) dir = -dir;
        const L = cfg.len(delta);
        wp.push({ s: a.s + L, x: a.x + dir * delta });
        put(blocker, a.x, a.s + L * rand(0.85, 1), scale, true, dir);
        populate(a.s, a.s + L);
      } else {
        const L = rand(cfg.straight[0], cfg.straight[1]);
        wp.push({ s: a.s + L, x: a.x });
        populate(a.s, a.s + L);
      }
      manoeuvreNext = !manoeuvreNext;
    }
    while (wp.length > 2 && wp[1].s < dist - 10) wp.shift();
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
  let vx = 0, ax = 0, roll = 0, W = 1, H = 1, tracked = 0;
  const GROUND = { air: [0x7f8f63, 0x26302a], ground: [0x6e5f47, 0x231e18] };
  function applyLook() {
    const sea = envName === 'sea';
    const horizon = day ? (sea ? 0xc3dbe6 : 0xcfdfea) : 0x16203a;
    skyMat.uniforms.top.value.set(day ? 0x3f86d6 : 0x04060d);
    skyMat.uniforms.bottom.value.set(horizon);
    scene.fog.color.set(horizon);
    scene.fog.density = day ? 0.011 : 0.016;
    renderer.toneMappingExposure = day ? 1.0 : 1.25;
    hemi.color.set(day ? 0xffffff : 0x7f95ff);
    hemi.groundColor.set(day ? 0x7c8468 : 0x07090d);
    hemi.intensity = day ? 0.85 : 0.45;
    sun.color.set(day ? 0xfff0d2 : 0xa9bcff);
    sun.intensity = day ? 1.5 : 0.55;
    head.intensity = day ? 0 : 1.7;
    mats.glass.emissiveIntensity = day ? 0 : 1.3;
    ground.visible = !sea;
    water.visible = sea;
    ridge.visible = !sea;                       // open horizon at sea
    if (!sea) groundMat.color.set(GROUND[envName][day ? 0 : 1]);
    waterMat.color.set(day ? 0x1d5a6c : 0x0a222c);
    waterMat.envMap = SKY_ENV[day ? 'day' : 'night'];
    waterMat.envMapIntensity = day ? 1 : 0.7;
    waterMat.needsUpdate = true;
    ridgeMat.color.set(day ? 0x9fb3c4 : 0x0c1222);
    disc.material.color.set(day ? 0xfff0c0 : 0xe6ecff);
    halo.material.color.set(day ? 0xffd9a0 : 0x8fa6ff);
    disc.scale.setScalar(day ? 1.5 : 0.8);
    stars.visible = !day;
    dustMat.color.set(day || sea ? 0xffffff : 0xfff0a0);
    dustMat.opacity = day ? 0.35 : sea ? 0.4 : 0.8;
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
    seaAmp = cfg.amp;
    loadModels(name);
    objects.forEach((o) => { if (o.visible) release(o); });
    fields.forEach((f) => { if (f.visible) { f.visible = false; freeFields.push(f); } });
    const x = clamp(camera.position.x, -cfg.limit * 0.5, cfg.limit * 0.5);
    wp.length = 0;
    wp.push({ s: dist - 10, x }, { s: dist + 30, x });
    manoeuvreNext = true;
    vx = ax = roll = 0;
    populate(dist + 20, dist + 30);
    extend();
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
    const x = pathX(dist);
    vx = route(dist, 1) * speed;
    ax = route(dist, 2) * speed * speed;
    let y = cfg.alt, pitch = 0, tilt = 0, down = 0.3;
    if (envName === 'air') {
      y += Math.sin(time * 0.4) * 0.12;
      tilt = -Math.atan(ax / 9.81);                        // banks into the turn
    } else if (envName === 'sea') {
      y += wave(x, dist, time);                            // heaves, pitches and rolls with the swell
      pitch = Math.atan((wave(x, dist + 1.5, time) - wave(x, dist - 1.5, time)) / 3) * 0.7;
      tilt = Math.atan((wave(x + 1, dist, time) - wave(x - 1, dist, time)) / 2) * 0.7 + Math.atan(ax / 9.81) * 0.3;
      down = 0.12;
    } else {
      y += Math.sin(dist * 1.3) * 0.03 + Math.sin(dist * 3.1) * 0.015; // rough ground under the wheels
      pitch = Math.sin(dist * 1.7) * 0.012;
      tilt = Math.sin(dist * 0.9) * 0.015 + Math.sin(dist * 2.3) * 0.008;
      down = 0.08;
    }
    roll += (tilt - roll) * 0.08;
    camera.position.set(x, y, 0);
    camera.lookAt(x + vx / speed * 30, y - down, -30);
    camera.rotateX(pitch);
    camera.rotateZ(roll);
    return y;
  }

  function update(dt) {
    time += dt;
    speed = cfg.speed * (1 + Math.sin(time * 0.12) * 0.08);
    dist += speed * dt;
    extend();
    const y = pose();
    const sea = envName === 'sea';

    groundTex.offset.y += speed * dt / TILE;
    if (sea) {
      // the surface follows the camera sideways in whole cells; heights come from world coordinates
      const cell = WSIZE / WSEG, p = waterGeo.attributes.position, nrm = waterGeo.attributes.normal, col = waterGeo.attributes.color;
      water.position.x = Math.round(camera.position.x / cell) * cell;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i) + water.position.x, s = dist - (p.getZ(i) + water.position.z);
        let h = 0, hx = 0, hs = 0; // height and its slopes across / along
        for (const q of WAVES) {
          const ph = q.kx * x + q.ks * s + q.w * time + q.ph, c = q.a * Math.cos(ph);
          h += q.a * Math.sin(ph); hx += c * q.kx; hs += c * q.ks;
        }
        h *= seaAmp; hx *= seaAmp; hs *= seaAmp;
        const inv = 1 / Math.hypot(hx, 1, hs);
        p.setY(i, h);
        nrm.setXYZ(i, -hx * inv, inv, hs * inv);   // exact normal -> smooth highlights
        const c = 0.82 + clamp(h, -0.4, 0.9) * 0.4;  // crests catch more light than troughs
        col.setXYZ(i, c, c, c);
      }
      p.needsUpdate = nrm.needsUpdate = col.needsUpdate = true;
      rippleTex.offset.set(time * 0.02 + water.position.x / 10, dist / 10 + time * 0.03);
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
      if (o.position.z > 8 + (u.cls.far ? u.w : 0)) release(o);
    }
    for (const f of fields) {
      if (!f.visible) continue;
      f.position.z = dist - f.userData.s;
      if (f.position.z - f.scale.z / 2 > 8) { f.visible = false; freeFields.push(f); }
    }
    for (let i = 0; i < DUST; i++) {
      dustPos[i * 3 + 2] += speed * dt;
      dustPos[i * 3] += Math.sin(time + i) * dt * 0.3;
      if (dustPos[i * 3 + 2] > 5) { dustPos[i * 3 + 2] -= 95; dustPos[i * 3] = camera.position.x + rand(-30, 30); }
    }
    dustGeo.attributes.position.needsUpdate = true;

    spdEl.textContent = Math.round(speed * 3.6);
    altEl.textContent = sea ? Math.abs(y - cfg.alt).toFixed(1)
      : envName === 'ground' ? Math.abs(roll * 57.3).toFixed(1)
      : y.toFixed(1);
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
      const s = toScreen(p.x, p.y, p.z);
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
      const s = toScreen(x, sea ? wave(x, dist + d, time) + 0.15 : 0.05, -d);
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
      // a threat is anything the route had to bend around, or that stands right beside it
      const threat = !u.cls.low && (u.block || Math.abs(o.position.x - pathX(u.s)) < u.w + cfg.margin + 2.5);
      const col = threat ? colors.accent : colors.ink;
      h2.globalAlpha = clamp((95 - d) / 20, 0, 1) * (threat ? 1 : 0.6);
      h2.strokeStyle = h2.fillStyle = col;
      h2.lineWidth = threat ? 1.5 : 1;
      // corner brackets
      const c = Math.min(12, (x1 - x0) / 3, (y1 - y0) / 3);
      h2.beginPath();
      [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]].forEach(([x, y, sx, sy]) => {
        h2.moveTo(x + sx * c, y); h2.lineTo(x, y); h2.lineTo(x, y + sy * c);
      });
      h2.stroke();
      if (x1 - x0 > 26) {
        const conf = Math.min(0.99, u.conf + (1 - d / 95) * 0.08);
        const action = u.cls.low ? 'OVERFLY' : threat ? 'AVOID' : 'TRACK';
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

  seaAmp = cfg.amp;
  loadModels(envName);
  extend();
  applyLook();
})();
