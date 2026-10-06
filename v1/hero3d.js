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
  // every model gets its own material set: during a flip each one is cut by its own clipping plane
  const sets = [];
  function makeMats() {
    const clip = [new T.Plane(new T.Vector3(-1, 0, 0), 99)];
    const c = { clippingPlanes: clip };
    const s = {
      clip,
      wire: new T.LineBasicMaterial({ transparent: true, opacity: 0.3, depthWrite: false, ...c }),
      edge: new T.LineBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false, ...c }),
      glass: new T.MeshBasicMaterial({ transparent: true, opacity: 0.05, depthWrite: false, side: T.DoubleSide, ...c }),
      module: new T.MeshStandardMaterial({ roughness: 0.55, metalness: 0.2, ...c }),
      accent: new T.MeshBasicMaterial({ ...c }),
      line: new T.LineBasicMaterial({ ...c }),
      dash: new T.LineDashedMaterial({ dashSize: 0.05, gapSize: 0.05, transparent: true, opacity: 0.9, ...c }),
    };
    sets.push(s);
    return s;
  }
  let M; // the set the builders below draw with
  // the scanner: a thin orange sheet that sweeps across the scene during a flip
  const scanFill = new T.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: T.DoubleSide, blending: T.AdditiveBlending });
  const scanEdge = new T.LineBasicMaterial({ transparent: true, opacity: 0 });
  const applyColors = () => {
    const fg = new T.Color(css('--fg') || '#e9e6d6'), acc = new T.Color(css('--accent') || '#ff5b1f');
    sets.forEach((s) => {
      s.wire.color.copy(fg); s.edge.color.copy(fg); s.glass.color.copy(fg);
      s.module.color.set(0x23271f); // the module stays dark and solid in both themes
      s.accent.color.copy(acc); s.line.color.copy(acc); s.dash.color.copy(acc);
    });
    scanFill.color.copy(acc); scanEdge.color.copy(acc);
    render();
  };

  // a see-through part: faint surface + dense wire + crisp outline
  const xray = (geo, wire = true) => {
    const g = new T.Group();
    g.add(new T.Mesh(geo, M.glass));
    if (wire) g.add(new T.LineSegments(new T.WireframeGeometry(geo), M.wire));
    g.add(new T.LineSegments(new T.EdgesGeometry(geo, 25), M.edge));
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
    const body = new T.Mesh(new T.BoxGeometry(0.2, 0.08, 0.26), M.module);
    m.add(body);
    m.add(new T.LineSegments(new T.EdgesGeometry(body.geometry), M.line));
    m.add(at(new T.Mesh(new T.CylinderGeometry(0.05, 0.055, 0.02, 24), M.accent), 0, 0.05, 0));
    const cone = new T.LineSegments(new T.BufferGeometry().setFromPoints([
      new T.Vector3(-0.03, 0.06, 0), new T.Vector3(-0.32, 0.75, 0),
      new T.Vector3(0.03, 0.06, 0), new T.Vector3(0.32, 0.75, 0),
    ]), M.dash);
    cone.computeLineDistances();
    m.add(cone);
    return m;
  }

  /* ---------- UAV: straight wing with dihedral, tip fins, pod, pusher prop ---------- */
  function buildUav() {
    const g = new T.Group();
    // one continuous wing through the centre: tapered, slightly swept, with dihedral
    const span = 1.25, root = 0.36, tip = 0.22, dihedral = 0.09;
    const wing = warp(new T.BoxGeometry(2 * span, 0.035, 1, 20, 1, 2), (p) => {
      const u = Math.abs(p.x) / span;                    // 0 at the centre, 1 at a tip
      p.set(p.x, p.y * (1 - 0.5 * u) + u * span * dihedral, p.z * (root + (tip - root) * u) + u * 0.1);
    });
    g.add(xray(wing));
    // tip fins: standing on the very tips, within the tip chord, leaning outwards a little
    [-1, 1].forEach((side) => {
      const fin = xray(warp(new T.BoxGeometry(0.02, 0.22, 0.2, 1, 3, 2), (p) => {
        p.z += (p.y + 0.11) * 0.35;                       // swept back towards the top
        p.x += side * (p.y + 0.11) * 0.15;                // leaning outwards
      }));
      fin.position.set(side * (span - 0.01), span * dihedral + 0.11, 0.1);
      g.add(fin);
    });
    // pod: a lathed fuselage sitting on the wing centre, the wing passes through it
    const prof = [[0, -0.42], [0.05, -0.39], [0.1, -0.3], [0.13, -0.15], [0.135, 0.05], [0.12, 0.2], [0.08, 0.3], [0.03, 0.34], [0, 0.34]]
      .map(([r, y]) => new T.Vector2(r, y));
    const podGeo = new T.LatheGeometry(prof, 14).rotateX(Math.PI / 2);
    podGeo.scale(1.25, 0.95, 1);
    g.add(at(xray(podGeo), 0, 0.03, 0.02));
    g.add(at(xray(new T.SphereGeometry(0.04, 10, 6), false), 0, 0.0, -0.36));   // nose camera, set into the pod
    g.add(at(xray(new T.CylinderGeometry(0.035, 0.045, 0.08, 10).rotateX(Math.PI / 2), false), 0, 0.03, 0.4));
    g.add(at(new T.LineSegments(new T.EdgesGeometry(new T.CircleGeometry(0.17, 28)), M.wire), 0, 0.03, 0.45));
    const blade = at(xray(new T.BoxGeometry(0.34, 0.012, 0.03), false), 0, 0.03, 0.45);
    g.add(blade);
    const module = at(makeModule(), 0, 0.2, -0.04);   // on top of the pod
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
  const list = (box.dataset.models || 'uav').split(/\s+/).filter((k) => BUILD[k]).map((k) => {
    M = makeMats();
    const m = BUILD[k]();
    m.clip = M.clip[0];
    // the model's outline in its own space, for placing the callouts beside it
    m.g.updateMatrixWorld(true);
    m.box = new T.Box3();
    m.g.children.forEach((c) => { if (c !== m.module) m.box.expandByObject(c); });
    m.box.expandByObject(m.module.children[0]);
    m.box.translate(m.g.position.clone().negate());
    m.g.scale.setScalar(m.size || 1);
    return m;
  });
  list.forEach((m, i) => { m.g.visible = !i; scene.add(m.g); });
  renderer.localClippingEnabled = true;
  const glowTex = (() => { // a horizontal fade: clear - solid - clear
    const c = document.createElement('canvas');
    c.width = 64; c.height = 1;
    const g = c.getContext('2d'), grd = g.createLinearGradient(0, 0, 64, 0);
    grd.addColorStop(0, 'rgba(255,255,255,0)'); grd.addColorStop(0.5, 'rgba(255,255,255,1)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 64, 1);
    return new T.CanvasTexture(c);
  })();
  scanFill.map = glowTex;
  const scan = new T.Group();
  scan.add(new T.Mesh(new T.PlaneGeometry(0.5, 2.6), scanFill));          // glow band
  scan.add(new T.LineSegments(new T.BufferGeometry().setFromPoints([new T.Vector3(0, -1.3, 0.01), new T.Vector3(0, 1.3, 0.01)]), scanEdge)); // core
  scan.position.y = 0.2;
  scan.visible = false;
  scene.add(scan);
  // flip: the sheet sweeps across (dir = +1 left to right, -1 back); the new model shows on the
  // side it has passed, the old one on the side still ahead of it. p runs 0 -> 1 over FLIP s.
  const FLIP = 1.5, R = 1.9; // the scan sweep, seconds
  let cur = 0, from = -1, dir = 1, p = 1;

  scene.add(new T.HemisphereLight(0xffffff, 0x222222, 0.9));
  const key = new T.DirectionalLight(0xffffff, 0.8);
  key.position.set(-2, 3, 2);
  scene.add(key);

  // callouts pinned to the current model's module
  const pins = [...box.querySelectorAll('[data-pin]')];
  const PIN = { sensor: new T.Vector3(0, 0.78, 0) };
  const EDGES = [[0, -0.04, 0.13], [0, -0.04, -0.13], [0.1, -0.04, 0], [-0.1, -0.04, 0]].map((a) => new T.Vector3(...a));
  const v = new T.Vector3();
  const lead = box.querySelector('.xray__lead');
  // a dot on the module where the leader line starts
  const dot = lead && lead.ownerSVGElement.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'circle'));
  if (dot) { dot.setAttribute('class', 'xray__dot'); dot.setAttribute('r', '3'); }
  const texts = pins.map((el) => {
    const nodes = [], walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) nodes.push({ n: walk.currentNode, s: walk.currentNode.nodeValue });
    return { nodes, len: nodes.reduce((a, x) => a + x.s.length, 0) };
  });
  // show the first f (0..1) of a callout's letters, with a caret while it is half-typed
  // typing in: the first f of the letters, a caret where typing has got to.
  // erasing (out): letters go from the start, left to right; the rest keeps its place
  // (blank cells stand in for the erased letters; the font is monospaced)
  const BLANK = '\u00a0', CARET = '\u258d';
  function typeTo(t, f, out) {
    const shown = Math.round(t.len * f), gone = t.len - shown, caret = f > 0 && f < 1;
    let c = 0;
    t.nodes.forEach((x) => {
      let s = '';
      for (const ch of x.s) {
        if (out) s += c < gone ? (caret && c === gone - 1 ? CARET : BLANK) : ch; // erased from the left
        else s += c < shown ? ch : caret && c === shown ? CARET : '';           // typed from the left
        c++;
      }
      x.n.nodeValue = s;
    });
  }
  // fix every label at its full width first, so typing never moves it
  pins.forEach((el) => { const i = el.querySelector('i'); if (i && i.offsetWidth) i.style.width = i.offsetWidth + 1 + 'px'; });
  // the order things go: sensor label, the leader line, the module label
  const ORDER = { sensor: 0, lead: 1, module: 2 };
  // fullW: width of the fully typed module label; since: seconds since the last flip settled
  let fullW = (box.querySelector('.xray__pin--module i') || {}).offsetWidth || 120, since = 0;
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  function callouts() {
    const out = p < 1;
    const f = (k) => reduced ? 1 : out
      ? clamp01(1 - (p - k * 0.048) / 0.3)          // erase, one after another, over ~0.45 s each
      : clamp01((since - 0.05 - k * 0.12) / 0.22); // type back in, one after another
    pins.forEach((el, i) => typeTo(texts[i], f(ORDER[el.dataset.pin]), out));
    if (lead) {
      const len = lead.getTotalLength ? lead.getTotalLength() : 0;
      lead.style.strokeDasharray = len;
      lead.style.strokeDashoffset = len * (1 - f(ORDER.lead));
      if (dot) dot.style.opacity = f(ORDER.lead) > 0 ? 1 : 0;
    }
    return out;
  }

  // flipping between models: arrows, dots, swipe, arrow keys
  const ui = box.closest('figure') || box; // the arrows and dots sit under the canvas
  const nameEl = ui.querySelector('.xray__name');
  const dots = [...ui.querySelectorAll('.xray__dots i')];
  function show(i, d = 1) {
    const next = (i + list.length) % list.length;
    if (next !== cur) { from = cur; cur = next; dir = d; p = reduced ? 1 : 0; }
    if (nameEl) nameEl.textContent = list[cur].name;
    dots.forEach((dt, j) => dt.classList.toggle('is-on', j === cur));
    if (reduced || !raf) render();
  }
  // left alone, the models flip by themselves every few seconds; a manual flip or the pointer
  // resting on the model holds that off
  const AUTO = 5;
  let idle = 0, hover = false;
  const byHand = (i, d) => { idle = -AUTO; show(i, d); };
  box.addEventListener('pointerenter', () => { hover = true; });
  box.addEventListener('pointerleave', () => { hover = false; });
  ui.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => byHand(cur + +b.dataset.step, +b.dataset.step)));
  if (list.length > 1) {
    let sx = null;
    box.addEventListener('pointerdown', (e) => { if (!e.target.closest('button')) sx = e.clientX; });
    box.addEventListener('pointerup', (e) => {
      if (sx !== null && Math.abs(e.clientX - sx) > 40) byHand(cur + (e.clientX < sx ? 1 : -1), e.clientX < sx ? 1 : -1);
      sx = null;
    });
    box.tabIndex = 0;
    box.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); byHand(cur + 1, 1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); byHand(cur - 1, -1); }
    });
  }

  let W = 1, H = 1, raf = 0, visible = true, t = 0, last = 0;
  function layout() {
    W = box.clientWidth; H = box.clientHeight;
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    // keep the whole model in view on narrow screens
    camera.position.z = (W / H < 1.4 ? 3.7 * 1.4 / (W / H) : 3.7) * (W < 520 ? 0.86 : 1); // phones: a bit closer
    camera.updateProjectionMatrix();
  }
  const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2); // ease-in-out, cubic
  const corner = new T.Vector3();
  function outline(m) { // the model's outline on screen
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? m.box.max.x : m.box.min.x, i & 2 ? m.box.max.y : m.box.min.y, i & 4 ? m.box.max.z : m.box.min.z);
      m.g.localToWorld(corner).project(camera);
      const x = (corner.x + 1) / 2 * W, y = (1 - corner.y) / 2 * H;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    return { x0, x1, y0, y1 };
  }
  function render() {
    const e = ease(Math.min(1, p)), flipping = p < 1;
    const s = dir > 0 ? -R + 2 * R * e : R - 2 * R * e; // where the sheet is
    list.forEach((m, j) => {
      const isCur = j === cur, isFrom = j === from && flipping;
      m.g.visible = isCur || isFrom;
      if (!m.g.visible) return;
      m.g.rotation.y = (m.yaw || 0) - 0.55 + (reduced ? 0 : Math.sin(t * 0.25) * 0.45);
      m.g.rotation.x = 0.08;
      m.g.rotation.z = reduced ? 0 : Math.sin(t * 0.5) * 0.03;
      if (m.spin) m.spin.rotation.z = t * 30;
      // the new model on the side the sheet has passed, the old one ahead of it
      const behind = isCur ? dir : -dir;
      if (!flipping) m.clip.set(corner.set(-1, 0, 0), 99);
      else m.clip.set(corner.set(-behind, 0, 0), behind * s);
    });
    scan.visible = flipping;
    if (flipping) {
      scan.position.x = s;
      scan.quaternion.copy(camera.quaternion); // face the viewer
      const a = Math.min(1, Math.sin(Math.PI * e) * 2.5);
      scanFill.opacity = 0.35 * a;
      scanEdge.opacity = a;
    }
    renderer.render(scene, camera);

    // callouts: beside the model's outline so they never cover it; frozen during a flip
    if (callouts()) return;
    const m = list[cur];
    m.g.updateMatrixWorld(true);
    const o = outline(m);
    const sen = m.module.localToWorld(v.set(0, m.sensorY || 0.78, 0)).project(camera);
    const sx = (sen.x + 1) / 2 * W, sy = Math.max((1 - sen.y) / 2 * H, 22);
    const label = box.querySelector('.xray__pin--module i');
    // the full width of the module label, so a half-typed label does not shift the layout
    if (label && texts[pins.findIndex((el) => el.dataset.pin === 'module')].nodes.every((x) => x.n.nodeValue === x.s)) fullW = label.offsetWidth;
    const lw = fullW;
    if (label) label.style.width = lw + 'px'; // fixed box: letters appear left to right
    // the leader starts from the middle of one of the module's lower edges: the leftmost one
    // when the label sits to the left, the lowest one when it sits underneath
    const left = o.x0 - 20 - lw >= 16;
    let mx = 0, my = 0, best = -Infinity;
    EDGES.forEach((e) => {
      m.module.localToWorld(v.copy(e)).project(camera);
      const x = (v.x + 1) / 2 * W, y = (1 - v.y) / 2 * H, score = left ? -x : y;
      if (score > best) { best = score; mx = x; my = y; }
    });
    let lx, ly, path;
    if (left) {                                // room on the left: level with the module
      lx = o.x0 - 20; ly = Math.min(Math.max(my, o.y0 + 16), H - 28);
      path = `M${mx} ${my}L${lx + 34} ${ly}H${lx + 6}`;
    } else {                                   // otherwise centred under the model
      lx = Math.min(Math.max(mx + lw / 2, lw + 4), W - 4); ly = Math.min(o.y1 + 30, H - 26);
      path = `M${mx} ${my}V${ly - 18}`;
    }
    pins.forEach((el) => {
      const [x, y] = el.dataset.pin === 'sensor' ? [sx, sy] : [lx, ly];
      el.style.transform = `translate(${x}px, ${y}px)`;
    });
    if (dot) { dot.setAttribute('cx', mx); dot.setAttribute('cy', my); }
    if (lead) {
      lead.setAttribute('d', path);
    }
  }
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    t += dt;
    if (list.length > 1 && !hover && p >= 1 && (idle += dt) > AUTO) { idle = 0; show(cur + 1, 1); }
    if (p < 1) { p = Math.min(1, p + dt / FLIP); since = 0; } else since += dt;
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
  show(0, 1);
  applyColors();
  box.classList.add('is-on'); // hide the drawn fallback
  run();
})();
