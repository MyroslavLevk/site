/* "X-ray" platforms: the airframe or hull is see-through (fine wire lines over faint glass), the
   FNAV module on top is the only solid part, with its sky-sensor view cone and two callouts.
   #xray[data-models] lists what to show: "uav" on the home page; "uav usv ugv" on the product
   page, where the arrows, a swipe or the arrow keys flip between them. Shapes after the product
   photos: a straight-wing UAV with tip fins and a pusher prop, a low stealthy boat with a cabin,
   a tracked ground vehicle with a sensor arch. */
(() => {
  const box = document.getElementById('xray');
  if (!box || !window.THREE) return;
  const T = THREE;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cv = box.querySelector('canvas');
  let renderer;
  try {
    renderer = new T.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
  } catch (e) { return; } // no WebGL: the drawn schematic stays
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));

  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 1.5, 3.7);
  camera.lookAt(0, 0.05, 0);

  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const wireMat = new T.LineBasicMaterial({ transparent: true, opacity: 0.3, depthWrite: false });
  const edgeMat = new T.LineBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false });
  const glassMat = new T.MeshBasicMaterial({ transparent: true, opacity: 0.05, depthWrite: false, side: T.DoubleSide });
  const moduleMat = new T.MeshStandardMaterial({ roughness: 0.55, metalness: 0.2 });
  const accentMat = new T.MeshBasicMaterial();
  const accentLine = new T.LineBasicMaterial();
  const dashMat = new T.LineDashedMaterial({ dashSize: 0.05, gapSize: 0.05, transparent: true, opacity: 0.9 });
  const applyColors = () => {
    const fg = new T.Color(css('--fg') || '#e9e6d6'), acc = new T.Color(css('--accent') || '#ff5b1f');
    wireMat.color.copy(fg); edgeMat.color.copy(fg); glassMat.color.copy(fg);
    moduleMat.color.set(0x23271f); // the module stays dark and solid in both themes
    accentMat.color.copy(acc); accentLine.color.copy(acc); dashMat.color.copy(acc);
    render();
  };

  // a see-through part: faint surface + dense wire + crisp outline
  const xray = (geo, wire = true) => {
    const g = new T.Group();
    g.add(new T.Mesh(geo, glassMat));
    if (wire) g.add(new T.LineSegments(new T.WireframeGeometry(geo), wireMat));
    g.add(new T.LineSegments(new T.EdgesGeometry(geo, 25), edgeMat));
    return g;
  };
  // reshape a geometry's vertices in place
  const warp = (geo, fn) => {
    const p = geo.attributes.position, v3 = new T.Vector3();
    for (let i = 0; i < p.count; i++) { fn(v3.fromBufferAttribute(p, i)); p.setXYZ(i, v3.x, v3.y, v3.z); }
    geo.computeVertexNormals();
    return geo;
  };
  const at = (obj, x, y, z) => { obj.position.set(x, y, z); return obj; };

  // the FNAV module: solid, with the sky-sensor lens and its view cone
  function makeModule() {
    const m = new T.Group();
    const body = new T.Mesh(new T.BoxGeometry(0.2, 0.08, 0.26), moduleMat);
    m.add(body);
    m.add(new T.LineSegments(new T.EdgesGeometry(body.geometry), accentLine));
    m.add(at(new T.Mesh(new T.CylinderGeometry(0.05, 0.055, 0.02, 24), accentMat), 0, 0.05, 0));
    const cone = new T.LineSegments(new T.BufferGeometry().setFromPoints([
      new T.Vector3(-0.03, 0.06, 0), new T.Vector3(-0.32, 0.75, 0),
      new T.Vector3(0.03, 0.06, 0), new T.Vector3(0.32, 0.75, 0),
    ]), dashMat);
    cone.computeLineDistances();
    m.add(cone);
    return m;
  }

  /* ---------- UAV: straight wing with dihedral, tip fins, pod, pusher prop ---------- */
  function buildUav() {
    const g = new T.Group();
    const wingHalf = (side) => {
      const span = 1.2, root = 0.36, tip = 0.22;
      const geo = warp(new T.BoxGeometry(span, 0.035, 1, 8, 1, 2), (p) => {
        const u = p.x / span + 0.5;                       // 0 at the root, 1 at the tip
        p.set(side * u * span, p.y * (1 - 0.5 * u), p.z * (root + (tip - root) * u) + u * 0.1);
      });
      const w = xray(geo);
      w.rotation.z = side * 0.09;
      w.position.set(side * 0.08, 0.02, 0);
      const fin = xray(new T.BoxGeometry(0.02, 0.24, 0.17, 1, 3, 2));
      fin.position.set(side * (span + 0.05), 0.12, 0.17);
      fin.rotation.set(0.25, 0, -side * 0.18);
      w.add(fin);
      return w;
    };
    g.add(wingHalf(1), wingHalf(-1));
    const prof = [[0, -0.42], [0.05, -0.39], [0.1, -0.3], [0.13, -0.15], [0.135, 0.05], [0.12, 0.2], [0.08, 0.3], [0.03, 0.34], [0, 0.34]]
      .map(([r, y]) => new T.Vector2(r, y));
    const podGeo = new T.LatheGeometry(prof, 14).rotateX(Math.PI / 2);
    podGeo.scale(1.25, 0.85, 1);
    g.add(at(xray(podGeo), 0, -0.04, 0.02));
    g.add(at(xray(new T.SphereGeometry(0.045, 10, 6), false), 0, -0.09, -0.4));
    g.add(at(xray(new T.CylinderGeometry(0.035, 0.045, 0.08, 10).rotateX(Math.PI / 2), false), 0, -0.02, 0.4));
    g.add(at(new T.LineSegments(new T.EdgesGeometry(new T.CircleGeometry(0.17, 28)), wireMat), 0, -0.02, 0.45));
    const blade = at(xray(new T.BoxGeometry(0.34, 0.012, 0.03), false), 0, -0.02, 0.45);
    g.add(blade);
    const module = at(makeModule(), 0, 0.1, -0.04);
    g.add(module);
    return { g, module, spin: blade, name: 'Fixed-wing UAV' };
  }

  /* ---------- USV: low faceted hull with a sharp bow, cabin, module on the cabin roof ---------- */
  function buildUsv() {
    const g = new T.Group();
    const L = 1.9, B = 0.62, D = 0.26;
    const hull = warp(new T.BoxGeometry(B, D, L, 2, 2, 10), (p) => {
      const u = p.z / L + 0.5;                            // 0 at the bow, 1 at the stern
      const f = Math.min(1, u / 0.38);                    // the bow narrows to a point
      const bottom = p.y < 0;
      p.x *= Math.max(0.02, Math.pow(f, 0.7)) * (bottom ? 0.55 : 1); // chines: narrower bottom
      if (bottom) p.y += (1 - f) * D * 0.55;              // the keel rises towards the bow
      else p.y += (1 - f) * 0.05;                         // a little sheer at the bow
    });
    g.add(xray(hull));
    // cabin: a sloped block aft of midships
    const cabin = warp(new T.BoxGeometry(0.42, 0.17, 0.62, 2, 1, 3), (p) => {
      if (p.y > 0) { p.x *= 0.78; p.z = p.z * 0.8 + 0.03; }
    });
    g.add(at(xray(cabin), 0, D / 2 + 0.085, 0.18));
    // deck hatch
    g.add(at(xray(new T.BoxGeometry(0.26, 0.03, 0.3), false), 0, D / 2 + 0.015, -0.32));
    const module = at(makeModule(), 0, D / 2 + 0.17 + 0.04, 0.16);
    g.add(module);
    g.position.y = -0.05;
    return { g, module, name: 'Uncrewed surface vessel', yaw: Math.PI, size: 0.85 }; // bow towards the viewer
  }

  /* ---------- UGV: tracked hull, road wheels, a sensor arch, module on the deck ---------- */
  function buildUgv() {
    const g = new T.Group();
    const len = 1.2, r = 0.14, tw = 0.18, gap = 0.62;
    // a track: a stadium outline extruded sideways
    const s = new T.Shape();
    s.moveTo(-len / 2 + r, -r);
    s.lineTo(len / 2 - r, -r);
    s.absarc(len / 2 - r, 0, r, -Math.PI / 2, Math.PI / 2, false);
    s.lineTo(-len / 2 + r, r);
    s.absarc(-len / 2 + r, 0, r, Math.PI / 2, Math.PI * 1.5, false);
    const trackGeo = new T.ExtrudeGeometry(s, { depth: tw, bevelEnabled: false, curveSegments: 8 })
      .translate(0, 0, -tw / 2).rotateY(Math.PI / 2);
    [-1, 1].forEach((side) => {
      g.add(at(xray(trackGeo), side * (gap / 2 + tw / 2), r, 0));
      for (let i = 0; i < 4; i++) {
        g.add(at(xray(new T.CylinderGeometry(0.075, 0.075, tw * 0.6, 12).rotateZ(Math.PI / 2), false),
          side * (gap / 2 + tw / 2), r - 0.02, -0.39 + i * 0.26));
      }
    });
    // hull between the tracks, sloped glacis at the front
    const hull = warp(new T.BoxGeometry(gap + 0.06, 0.26, len - 0.1, 2, 1, 4), (p) => {
      if (p.y > 0 && p.z < -0.3) p.z += 0.12;
    });
    g.add(at(xray(hull), 0, r + 0.13, 0));
    // stowage boxes on the sides of the deck
    [-1, 1].forEach((side) => g.add(at(xray(new T.BoxGeometry(0.2, 0.12, 0.34), false), side * 0.33, r + 0.32, 0.16)));
    // sensor arch with a camera block hanging from the top bar
    const archZ = 0.25, archY = r + 0.26;
    [-1, 1].forEach((side) => {
      const post = xray(new T.BoxGeometry(0.045, 0.6, 0.06), false);
      post.position.set(side * 0.3, archY + 0.3, archZ);
      post.rotation.z = side * 0.08;
      g.add(post);
    });
    g.add(at(xray(new T.BoxGeometry(0.72, 0.05, 0.16), false), 0, archY + 0.62, archZ));
    g.add(at(xray(new T.BoxGeometry(0.22, 0.1, 0.12), false), 0, archY + 0.53, archZ));
    [-0.03, 0.03].forEach((x) => g.add(at(xray(new T.CylinderGeometry(0.006, 0.006, 0.2, 5), false), x, archY + 0.74, archZ)));
    const module = at(makeModule(), 0, r + 0.3, -0.34); // forward of the arch, so its view is clear
    g.add(module);
    g.position.y = -0.3;
    return { g, module, name: 'Tracked UGV', yaw: Math.PI, size: 0.78, sensorY: 1.12 }; // label above the arch // front towards the viewer
  }

  const BUILD = { uav: buildUav, usv: buildUsv, ugv: buildUgv };
  const list = (box.dataset.models || 'uav').split(/\s+/).filter((k) => BUILD[k]).map((k) => BUILD[k]());
  list.forEach((m, i) => { m.k = i ? 0 : 1; m.g.visible = !i; scene.add(m.g); });
  let cur = 0;

  scene.add(new T.HemisphereLight(0xffffff, 0x222222, 0.9));
  const key = new T.DirectionalLight(0xffffff, 0.8);
  key.position.set(-2, 3, 2);
  scene.add(key);

  // callouts pinned to the current model's module
  const pins = [...box.querySelectorAll('[data-pin]')];
  const PIN = { sensor: new T.Vector3(0, 0.78, 0), module: new T.Vector3(-0.1, -0.02, 0.1) };
  const v = new T.Vector3();
  const lead = box.querySelector('.xray__lead');

  // flipping between models: arrows, dots, swipe, arrow keys
  const ui = box.closest('figure') || box; // the arrows and dots sit under the canvas
  const nameEl = ui.querySelector('.xray__name');
  const dots = [...ui.querySelectorAll('.xray__dots i')];
  function show(i) {
    cur = (i + list.length) % list.length;
    if (nameEl) nameEl.textContent = list[cur].name;
    dots.forEach((d, j) => d.classList.toggle('is-on', j === cur));
    list.forEach((m, j) => { if (reduced) { m.k = j === cur ? 1 : 0; } m.g.visible = m.k > 0.001 || j === cur; });
    if (reduced || !raf) render();
  }
  // left alone, the models flip by themselves every few seconds; a manual flip or the pointer
  // resting on the model holds that off
  const AUTO = 5;
  let idle = 0, hover = false;
  const byHand = (i) => { idle = -AUTO; show(i); };
  box.addEventListener('pointerenter', () => { hover = true; });
  box.addEventListener('pointerleave', () => { hover = false; });
  ui.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => byHand(cur + +b.dataset.step)));
  if (list.length > 1) {
    let sx = null;
    box.addEventListener('pointerdown', (e) => { if (!e.target.closest('button')) sx = e.clientX; });
    box.addEventListener('pointerup', (e) => {
      if (sx !== null && Math.abs(e.clientX - sx) > 40) byHand(cur + (e.clientX < sx ? 1 : -1));
      sx = null;
    });
    box.tabIndex = 0;
    box.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); byHand(cur + 1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); byHand(cur - 1); }
    });
  }

  let W = 1, H = 1, raf = 0, visible = true, t = 0, last = 0;
  function layout() {
    W = box.clientWidth; H = box.clientHeight;
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    // keep the whole model in view on narrow screens
    camera.position.z = W / H < 1.4 ? 3.7 * 1.4 / (W / H) : 3.7;
    camera.updateProjectionMatrix();
  }
  const ease = (k) => k * k * (3 - 2 * k);
  function render() {
    list.forEach((m, j) => {
      if (!m.g.visible) return;
      const e = ease(m.k);
      m.g.scale.setScalar((0.6 + 0.4 * e) * (m.size || 1));
      m.g.rotation.y = (m.yaw || 0) - 0.55 + (reduced ? 0 : Math.sin(t * 0.25) * 0.45) + (1 - e) * (j === cur ? -1.2 : 1.2);
      m.g.rotation.x = 0.08;
      m.g.rotation.z = reduced ? 0 : Math.sin(t * 0.5) * 0.03;
      m.g.children.forEach((c) => { c.visible = e > 0.02; });
      if (m.spin) m.spin.rotation.z = t * 30;
    });
    renderer.render(scene, camera);
    // callouts: only once the current model has settled
    const m = list[cur], settled = m.k > 0.95;
    m.g.updateMatrixWorld(true);
    const pts = {};
    pins.forEach((el) => {
      v.copy(PIN[el.dataset.pin]);
      if (el.dataset.pin === 'sensor' && m.sensorY) v.y = m.sensorY;
      m.module.localToWorld(v).project(camera);
      const x = (v.x + 1) / 2 * W, y = (1 - v.y) / 2 * H;
      pts[el.dataset.pin] = [x, y];
      el.style.transform = `translate(${x}px, ${y}px)`;
      el.style.visibility = settled ? '' : 'hidden';
    });
    if (lead) {
      lead.style.visibility = settled ? '' : 'hidden';
      if (pts.module) { const [x, y] = pts.module; lead.setAttribute('d', `M${x} ${y}L${x - 30} ${y + 52}H${x - 46}`); }
    }
  }
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    t += dt;
    if (list.length > 1 && !hover && (idle += dt) > AUTO) { idle = 0; show(cur + 1); }
    // the current model grows in, the others shrink away
    list.forEach((m, j) => {
      m.k += ((j === cur ? 1 : 0) - m.k) * (1 - Math.exp(-dt * 5));
      m.g.visible = m.k > 0.001 || j === cur;
    });
    render();
    raf = requestAnimationFrame(frame);
  }
  const run = () => {
    const on = visible && !document.hidden && !reduced;
    if (on && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
    if (!on && raf) { cancelAnimationFrame(raf); raf = 0; }
  };
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; run(); }).observe(box);
  document.addEventListener('visibilitychange', run);
  new ResizeObserver(() => { layout(); render(); }).observe(box);
  document.addEventListener('themechange', applyColors);

  layout();
  show(0);
  applyColors();
  box.classList.add('is-on'); // hide the drawn fallback
  run();
})();
