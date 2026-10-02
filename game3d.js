/* Onboard-view simulation: an autonomous drone flies low over farmland without GPS,
   classifies obstacles and routes around them. Requires global THREE (r128). */
(() => {
  const box = document.getElementById('game');
  const cv = document.getElementById('gameCanvas');
  const hud = document.getElementById('hudCanvas');
  const h2 = hud.getContext('2d');
  const el = (id) => document.getElementById(id);
  const spdEl = el('spd'), altEl = el('alt'), objEl = el('obj'), distEl = el('dist'), modeEl = el('navMode');
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
  for (let i = 0; i < 16; i++) {
    const m = new THREE.Mesh(new THREE.ConeGeometry(rand(60, 110), rand(30, 75), 5), ridgeMat);
    m.position.set(-420 + i * 56 + rand(-15, 15), 0, -380 + rand(-20, 20));
    m.rotation.y = rand(0, 3);
    scene.add(m);
  }

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

  /* ----- materials and geometry ----- */
  const std = (color, extra) => new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.95 }, extra));
  const mats = {
    bark: std(0x3f2d20),
    pine: [0x2a5236, 0x234a34, 0x35623b, 0x1f4030].map((c) => std(c, { flatShading: true })),
    leaf: [0x4f7a34, 0x5d8a3a, 0x436b2e].map((c) => std(c, { flatShading: true })),
    rock: std(0x7b7f85, { flatShading: true }),
    steel: std(0x8c9299, { metalness: 0.7, roughness: 0.45 }),
    lattice: std(0x8c9299, { metalness: 0.7, roughness: 0.45, wireframe: true }),
    // farmhouse walls and roofs come in several colours; each house picks a pair
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
    box: new THREE.BoxGeometry(1, 1, 1), // walls, doors, windows: scaled per use
    // triangular prism, ridge along x: apex at y = 1, eaves at y = -0.5, z = +-0.866
    gable: new THREE.CylinderGeometry(1, 1, 1, 3).rotateZ(Math.PI / 2).rotateX(-Math.PI / 2),
    siloBody: new THREE.CylinderGeometry(1.4, 1.4, 7, 16),
    siloDome: new THREE.SphereGeometry(1.4, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    bale: new THREE.CylinderGeometry(0.7, 0.7, 1.2, 14).rotateZ(Math.PI / 2),
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
     w = radius the route must clear (crown / walls, not just the trunk); h = height;
     low = flown over, never avoided; far = kept well away from the route (farmyards);
     fixed = no random scale. ----- */
  const CLASSES = {
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
    mast: { label: 'PYLON', w: 2.2, h: 18.4, n: 3, fixed: true, build(t) {
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
      part(t, geo.box, mats.dark, 1.6, 4.2, -0.6, 0.5, 1.4, 0.5);           // chimney
      part(t, geo.box, mats.dark, -1.5, 1, 2.11, 1, 2, 0.08);               // door
      part(t, geo.box, mats.glass, 0.2, 1.7, 2.11, 1, 1, 0.08);             // windows
      part(t, geo.box, mats.glass, 1.7, 1.7, 2.11, 1, 1, 0.08);
      part(t, geo.box, mats.glass, 2.71, 1.7, 0, 0.08, 1, 1.2);
      part(t, geo.box, mats.glass, -2.71, 1.7, 0, 0.08, 1, 1.2);
    } },
    barn: { label: 'BARN', w: 5.0, h: 7.2, n: 2, far: true, fixed: true, build(t) {
      part(t, geo.box, mats.barn, 0, 2, 0, 7.5, 4, 5.5);
      roof(t, mats.barnRoof, 0, 4, 7.5, 5.5, 3.2);
      part(t, geo.box, mats.trim, 0, 1.6, 2.76, 2.8, 3.2, 0.08);            // door frame
      part(t, geo.box, mats.dark, 0, 1.5, 2.79, 2.3, 2.9, 0.08);            // door
      part(t, geo.box, mats.trim, -2.6, 2.4, 2.76, 0.9, 0.9, 0.08);
      part(t, geo.box, mats.trim, 2.6, 2.4, 2.76, 0.9, 0.9, 0.08);
    } },
    silo: { label: 'SILO', w: 1.8, h: 8.4, n: 2, far: true, fixed: true, build(t) {
      part(t, geo.siloBody, mats.silo, 0, 3.5, 0);
      part(t, geo.siloDome, mats.silo, 0, 7, 0);
    } },
  };

  const DEPTH = 190, FIELD = 30, CRUISE_ALT = 2.9, MARGIN = 1.8; // margin = airframe half-span + safety
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
     s = distance along the flight. The route is a chain of waypoints {s, x} joined by
     quintic ease curves, so lateral velocity and acceleration are zero at every joint
     and the motion is smooth by construction. Each manoeuvre is generated around a
     "blocker" obstacle standing on the line the drone was flying, so the turn has a
     visible reason. Everything else is placed clear of the route and of each other. ----- */
  let dist = 0, manoeuvreNext = true;
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
    for (let ds = -6; ds <= 6; ds += 3) if (Math.abs(x - pathX(s + ds)) < w + MARGIN) return false;
    return true;
  };
  // does it touch anything already standing? (no house inside a tree, no rock inside a barn)
  const overlaps = (x, s, w) => objects.some((o) => o.visible &&
    Math.hypot(x - o.position.x, s - o.userData.s) < w + o.userData.w + 0.8);

  function put(o, x, s, scale, block) {
    const c = o.userData.cls;
    o.scale.setScalar(scale);
    o.rotation.y = c.far ? rand(-0.5, 0.5) + (Math.random() < 0.5 ? 0 : Math.PI / 2) : rand(0, Math.PI * 2);
    o.position.set(x, 0, dist - s);
    Object.assign(o.userData, { s, w: c.w * scale, h: c.h * scale, block: !!block, conf: rand(0.84, 0.95) });
    o.visible = true;
  }

  function scatter(type, s0, s1) {
    const o = take(type);
    if (!o) return;
    const c = o.userData.cls, scale = c.fixed ? 1 : rand(0.8, 1.35), w = c.w * scale;
    for (let i = 0; i < 16; i++) {
      const s = rand(s0, s1), px = pathX(s), side = Math.random() < 0.5 ? -1 : 1;
      const x = c.far ? px + side * rand(w + MARGIN + 7, FIELD)          // farmyards sit back from the route
        : c.low || Math.random() < 0.5 ? rand(-FIELD, FIELD)
        : px + side * (w + MARGIN + rand(0.3, 5));                       // trees flanking the route
      if (!c.low && !clear(x, s, w)) continue;
      if (overlaps(x, s, w)) continue;
      put(o, x, s, scale);
      return;
    }
    release(o);
  }

  function populate(s0, s1) {
    const len = s1 - s0;
    const count = (per) => Math.floor(len / per + Math.random());
    for (let i = count(6); i > 0; i--) scatter('pine', s0, s1);
    for (let i = count(18); i > 0; i--) scatter('tree', s0, s1);
    for (let i = count(16); i > 0; i--) scatter('rock', s0, s1);
    for (let i = count(20); i > 0; i--) scatter('hay', s0, s1);
    if (Math.random() < 0.45) {                                           // a farmyard: house, maybe barn and silo
      scatter('house', s0, s1);
      if (Math.random() < 0.6) scatter('barn', s0, s1);
      if (Math.random() < 0.5) scatter('silo', s0, s1);
    }
    if (Math.random() < 0.15) scatter('mast', s0, s1);
    if (freeFields.length && Math.random() < 0.7) {
      const f = freeFields.pop(), side = Math.random() < 0.5 ? -1 : 1;
      f.scale.set(rand(18, 38), 1, len * rand(0.8, 1.3));
      f.userData.s = (s0 + s1) / 2;
      f.position.x = side * rand(24, 46);
      f.material.color.set(pick(CROPS));
      f.visible = true;
    }
  }

  function extend() {
    while (wp[wp.length - 1].s < dist + DEPTH) {
      const a = wp[wp.length - 1];
      const blocker = manoeuvreNext && (take(pick(['pine', 'pine', 'pine', 'tree', 'tree', 'mast'])) || take('pine'));
      if (blocker) {
        const c = blocker.userData.cls, scale = c.fixed ? 1 : rand(0.9, 1.35), w = c.w * scale;
        // sidestep far enough to clear the blocker, over a distance long enough to stay gentle
        const delta = (w + MARGIN) / 0.8 + rand(0.5, 2);
        let dir = Math.random() < 0.5 ? -1 : 1;
        if (Math.abs(a.x + dir * delta) > 12) dir = -dir;
        const L = clamp(delta * 9, 45, 75);
        wp.push({ s: a.s + L, x: a.x + dir * delta });
        put(blocker, a.x, a.s + L * rand(0.85, 1), scale, true);
        populate(a.s, a.s + L);
      } else {
        const L = rand(18, 38);
        wp.push({ s: a.s + L, x: a.x });
        populate(a.s, a.s + L);
      }
      manoeuvreNext = !manoeuvreNext;
    }
    while (wp.length > 2 && wp[1].s < dist - 10) wp.shift();
  }

  /* ----- drifting particles: fireflies at night, pollen by day ----- */
  const DUST = 260;
  const dustPos = new Float32Array(DUST * 3);
  for (let i = 0; i < DUST; i++) dustPos.set([rand(-30, 30), rand(0.3, 9), rand(-90, 5)], i * 3);
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dustMat = new THREE.PointsMaterial({ map: glowTex, size: 0.22, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  scene.add(new THREE.Points(dustGeo, dustMat));

  /* ----- theme: night flies on StarNav, day on SolarNav ----- */
  let colors = {}, day = false;
  let speed = 17, time = 0, last = 0, raf = 0, visible = false;
  let vx = 0, ax = 0, roll = 0, W = 1, H = 1, tracked = 0;
  function applyTheme() {
    day = root.dataset.theme === 'light';
    const horizon = day ? 0xcfdfea : 0x16203a;
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
    groundMat.color.set(day ? 0x7f8f63 : 0x26302a);
    ridgeMat.color.set(day ? 0x9fb3c4 : 0x0c1222);
    disc.material.color.set(day ? 0xfff0c0 : 0xe6ecff);
    halo.material.color.set(day ? 0xffd9a0 : 0x8fa6ff);
    disc.scale.setScalar(day ? 1.5 : 0.8);
    stars.visible = !day;
    dustMat.color.set(day ? 0xffffff : 0xfff0a0);
    dustMat.opacity = day ? 0.35 : 0.8;
    modeEl.textContent = day ? 'SOLARNAV' : 'STARNAV';
    const s = getComputedStyle(root);
    colors = { accent: s.getPropertyValue('--accent').trim(), ink: day ? '#161a12' : '#e9e6d6' };
    if (!raf) render();
  }
  document.addEventListener('themechange', applyTheme);

  /* ----- flight ----- */
  function update(dt) {
    time += dt;
    speed = 17 + Math.sin(time * 0.12) * 1.5;
    dist += speed * dt;
    extend();

    // The drone follows the route exactly; nothing that must be avoided is ever placed on it.
    camera.position.x = pathX(dist);
    vx = route(dist, 1) * speed;
    ax = route(dist, 2) * speed * speed;
    camera.position.y = CRUISE_ALT + Math.sin(time * 0.4) * 0.12;
    // bank angle follows lateral acceleration (coordinated turn); nose follows the velocity vector
    roll += (-Math.atan(ax / 9.81) - roll) * Math.min(1, dt * 2.5);
    camera.lookAt(camera.position.x + vx / speed * 30, camera.position.y - 0.3, -30);
    camera.rotateZ(roll);

    groundTex.offset.y += speed * dt / TILE;
    for (const o of objects) {
      if (!o.visible) continue;
      o.position.z = dist - o.userData.s;
      if (o.position.z > 8) release(o);
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
    altEl.textContent = camera.position.y.toFixed(1);
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

    // planned route on the ground
    h2.globalAlpha = 0.9;
    h2.lineWidth = 1.5;
    h2.setLineDash([6, 6]);
    h2.beginPath();
    let pen = false;
    for (let d = 4; d <= 90; d += 3) {
      const s = toScreen(pathX(dist + d), 0.05, -d);
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
      if (d < 4 || d > 95) continue;
      const a = toScreen(o.position.x - u.w, 0, o.position.z);
      const b = toScreen(o.position.x + u.w, u.h, o.position.z);
      if (!a || !b) continue;
      const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]);
      const y0 = Math.max(Math.min(a[1], b[1]), -20), y1 = Math.max(a[1], b[1]);
      if (x1 < 0 || x0 > W) continue;
      tracked++;
      // a threat is anything the route had to bend around, or that stands right beside it
      const threat = !u.cls.low && (u.block || Math.abs(o.position.x - pathX(u.s)) < u.w + MARGIN + 2.5);
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
        h2.fillText(`${u.cls.label} ${(conf * 100).toFixed(0)}%  ${d.toFixed(0)}m`, x0, Math.max(12, y0 - 16));
        h2.fillText(action, x0, Math.max(24, y0 - 5));
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

  // only run the loop while the banner is on screen and the tab is visible
  function setRunning() {
    const run = visible && !document.hidden && !reduced;
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

  camera.position.set(0, CRUISE_ALT, 0);
  camera.lookAt(0, CRUISE_ALT - 0.3, -30);
  extend();
  applyTheme();
})();
