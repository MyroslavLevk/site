/* Onboard-view simulation: an autonomous drone flies through terrain without GPS,
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

  /* ----- obstacles: five classes, pooled and recycled ----- */
  const std = (color, extra) => new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.95 }, extra));
  const mats = {
    bark: std(0x4a3526),
    pine: [0x2f5a3a, 0x27503a, 0x3a6a3f].map((c) => std(c, { flatShading: true })),
    leaf: [0x4f7a34, 0x5d8a3a].map((c) => std(c, { flatShading: true })),
    rock: std(0x7b7f85, { flatShading: true }),
    steel: std(0x8c9299, { metalness: 0.7, roughness: 0.45 }),
    concrete: std(0x9a9a96),
    dark: std(0x2a2c30),
    beacon: new THREE.MeshBasicMaterial({ color: 0xff3030, fog: false }),
  };
  const geo = {
    trunk: new THREE.CylinderGeometry(0.18, 0.3, 2.4, 7),
    tiers: [[1.6, 2.4, 2.4], [1.3, 2.2, 3.6], [1.0, 2.0, 4.7], [0.65, 1.8, 5.7]] // radius, height, y
      .map(([r, h, y]) => ({ g: new THREE.ConeGeometry(r, h, 9), y })),
    oakTrunk: new THREE.CylinderGeometry(0.25, 0.4, 3.2, 7),
    crown: new THREE.IcosahedronGeometry(1.7, 1),
    rock: new THREE.DodecahedronGeometry(0.9, 0),
    mast: new THREE.BoxGeometry(0.4, 18, 0.4),
    arm: new THREE.BoxGeometry(3.2, 0.16, 0.16),
    beacon: new THREE.SphereGeometry(0.2, 8, 8),
    hall: new THREE.BoxGeometry(5, 3.6, 4),
    annex: new THREE.BoxGeometry(2.4, 2.2, 3),
    door: new THREE.BoxGeometry(1, 2, 0.1),
  };
  const part = (parent, g, m, x, y, z) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const pick = (a) => a[Math.floor(Math.random() * a.length)];

  // label, half-width the planner must clear, height, model builder
  const CLASSES = {
    pine: { label: 'PINE', w: 1.6, h: 6.6, build(t) {
      part(t, geo.trunk, mats.bark, 0, 1.2, 0);
      const m = pick(mats.pine);
      geo.tiers.forEach(({ g, y }) => part(t, g, m, 0, y, 0));
    } },
    tree: { label: 'TREE', w: 2.4, h: 6.2, build(t) {
      part(t, geo.oakTrunk, mats.bark, 0, 1.6, 0);
      const m = pick(mats.leaf);
      part(t, geo.crown, m, 0, 4.3, 0);
      part(t, geo.crown, m, 1.0, 3.7, 0.4).scale.setScalar(0.7);
      part(t, geo.crown, m, -0.9, 3.9, -0.5).scale.setScalar(0.75);
    } },
    rock: { label: 'ROCK', w: 1.2, h: 1.0, build(t) {
      part(t, geo.rock, mats.rock, 0, 0.4, 0).scale.set(1.3, 0.75, 1);
    } },
    mast: { label: 'MAST', w: 1.7, h: 18.4, build(t) {
      part(t, geo.mast, mats.steel, 0, 9, 0);
      part(t, geo.arm, mats.steel, 0, 14, 0);
      part(t, geo.arm, mats.steel, 0, 16.5, 0);
      part(t, geo.beacon, mats.beacon, 0, 18.2, 0).add(glow(0xff3030, 3));
    } },
    structure: { label: 'STRUCTURE', w: 3.9, h: 3.6, build(t) {
      part(t, geo.hall, mats.concrete, 0, 1.8, 0);
      part(t, geo.annex, mats.concrete, 3.4, 1.1, 0.3);
      part(t, geo.door, mats.dark, -1, 1, 2.01);
    } },
  };
  const DEPTH = 190, FIELD = 26, CRUISE_ALT = 2.9;
  const objects = [];
  const spawn = (type, n) => {
    for (let i = 0; i < n; i++) {
      const t = new THREE.Group();
      t.userData.cls = CLASSES[type];
      CLASSES[type].build(t);
      place(t, -rand(40, DEPTH));
      objects.push(t);
      scene.add(t);
    }
  };
  function place(t, z) {
    const c = t.userData.cls;
    const fixed = c === CLASSES.mast || c === CLASSES.structure;
    const s = fixed ? 1 : rand(0.8, 1.45);
    t.scale.setScalar(s);
    t.rotation.y = fixed ? rand(-0.3, 0.3) : rand(0, Math.PI * 2);
    t.position.set(rand(-FIELD, FIELD), 0, z);
    t.userData.w = c.w * s;   // crown / foliage width counts, not just the trunk
    t.userData.h = c.h * s;
    t.userData.avoid = t.userData.h > CRUISE_ALT - 1.2; // low objects are overflown
    t.userData.conf = rand(0.84, 0.95);
  }
  spawn('pine', 34); spawn('tree', 14); spawn('rock', 16); spawn('mast', 3); spawn('structure', 4);

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
    colors = { accent: s.getPropertyValue('--accent').trim(), ink: day ? '#0a0b0d' : '#f2f1ec' };
    if (!raf) render();
  }
  document.addEventListener('themechange', applyTheme);

  /* ----- autopilot ----- */
  let speed = 18, dist = 0, time = 0, last = 0, raf = 0, visible = false;
  let goal = 0, s1 = 0, s2 = 0, s3 = 0, planT = 0, vx = 0, ax = 0, roll = 0, W = 1, H = 1, tracked = 0;
  camera.position.set(0, CRUISE_ALT, 0);

  // cost of holding lateral position x over the next ~8 seconds of flight
  function costAt(x) {
    let cost = Math.abs(x) * 0.03 + Math.abs(x - camera.position.x) * 0.1;
    for (const o of objects) {
      const d = -o.position.z;
      if (!o.userData.avoid || d < -2 || d > 150) continue;
      const gap = Math.abs(x - o.position.x) - (o.userData.w + 1.6); // 1.6 = airframe + margin
      const near = 1 / (1 + d / 30);
      cost += gap < 0 ? 120 * near : 4 * Math.exp(-gap) * near;
    }
    return cost;
  }
  // The planner commits: it keeps the current route unless another one is clearly better.
  function plan() {
    let best = goal, bestCost = costAt(goal) - 2.5;
    for (let x = -15; x <= 15; x += 0.5) {
      const c = costAt(x);
      if (c < bestCost) { bestCost = c; best = x; }
    }
    goal = best;
  }

  function update(dt) {
    time += dt;
    speed = 17 + Math.sin(time * 0.12) * 1.5;
    dist += speed * dt;
    planT -= dt;
    if (planT <= 0) { planT = 0.3; plan(); }

    // Flight path: the route decision passes through three cascaded low-pass filters,
    // so position, velocity AND acceleration are all continuous. The result is the
    // long S-curve a real airframe flies, with no snaps and no overshoot.
    const TAU = 0.95, k = 1 - Math.exp(-dt / TAU);
    s1 += (goal - s1) * k;
    s2 += (s1 - s2) * k;
    s3 += (s2 - s3) * k;
    camera.position.x = s3;
    vx = (s2 - s3) / TAU;
    ax = (s1 - 2 * s2 + s3) / (TAU * TAU);
    camera.position.y = CRUISE_ALT + Math.sin(time * 0.4) * 0.12;
    // bank angle follows lateral acceleration (coordinated turn); nose follows the velocity vector
    roll += (-Math.atan(ax / 9.81) - roll) * Math.min(1, dt * 2.5);
    camera.lookAt(camera.position.x + vx / speed * 30, camera.position.y - 0.3, -30);
    camera.rotateZ(roll);
    camera.fov = 62;
    camera.updateProjectionMatrix();

    groundTex.offset.y += speed * dt / TILE;
    for (const o of objects) {
      o.position.z += speed * dt;
      if (o.position.z > 8) place(o, o.position.z - DEPTH);
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
    h2.setLineDash([6, 6]);
    h2.beginPath();
    let pen = false;
    for (let d = 4; d <= 46; d += 3) {
      const k = Math.min(1, d / 30), ease = k * k * (3 - 2 * k);
      const s = toScreen(camera.position.x + (s1 - camera.position.x) * ease, 0.05, -d);
      if (!s) continue;
      if (pen) h2.lineTo(s[0], s[1]); else { h2.moveTo(s[0], s[1]); pen = true; }
    }
    h2.stroke();
    h2.setLineDash([]);

    // detections
    tracked = 0;
    for (const o of objects) {
      const d = -o.position.z;
      if (d < 4 || d > 95) continue;
      const a = toScreen(o.position.x - o.userData.w, 0, o.position.z);
      const b = toScreen(o.position.x + o.userData.w, o.userData.h, o.position.z);
      if (!a || !b) continue;
      const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]);
      const y0 = Math.max(Math.min(a[1], b[1]), -20), y1 = Math.max(a[1], b[1]);
      if (x1 < 0 || x0 > W) continue;
      tracked++;
      const threat = o.userData.avoid && Math.abs(o.position.x - camera.position.x) < o.userData.w + 2.2;
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
        const conf = Math.min(0.99, o.userData.conf + (1 - d / 95) * 0.08);
        const action = !o.userData.avoid ? 'OVERFLY' : threat ? 'AVOID' : 'TRACK';
        h2.fillText(`${o.userData.cls.label} ${(conf * 100).toFixed(0)}%  ${d.toFixed(0)}m`, x0, Math.max(12, y0 - 16));
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

  applyTheme();
})();
