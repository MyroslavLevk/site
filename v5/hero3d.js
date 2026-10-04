/* Hero: an "x-ray" fixed-wing drone. The airframe is see-through (fine wire lines over faint
   glass), the FNAV module on its back is the only solid part. It turns slowly, leans towards
   the pointer and carries two callouts pinned to the module. Shape after the product photo:
   straight wing with a little dihedral, fins on the tips, a pod under the centre, pusher prop. */
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

  const drone = new T.Group();
  scene.add(drone);
  // a see-through part: faint surface + dense wire + crisp outline
  const xray = (geo, wire = true) => {
    const g = new T.Group();
    g.add(new T.Mesh(geo, glassMat));
    if (wire) g.add(new T.LineSegments(new T.WireframeGeometry(geo), wireMat));
    g.add(new T.LineSegments(new T.EdgesGeometry(geo, 25), edgeMat));
    return g;
  };

  // wing halves: tapered, slightly swept, with dihedral
  const wingHalf = (side) => {
    const span = 1.2, root = 0.36, tip = 0.22, th = 0.035;
    const geo = new T.BoxGeometry(span, th, 1, 8, 1, 2);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i) / span + 0.5;                 // 0 at the root, 1 at the tip
      const chord = root + (tip - root) * u;
      p.setXYZ(i, side * u * span, p.getY(i) * (1 - 0.5 * u), p.getZ(i) * chord + u * 0.1);
    }
    geo.computeVertexNormals();
    const g = xray(geo);
    g.rotation.z = side * 0.09;
    g.position.set(side * 0.08, 0.02, 0);
    // tip fin, leaning outwards
    const fin = xray(new T.BoxGeometry(0.02, 0.24, 0.17, 1, 3, 2), true);
    fin.position.set(side * (span + 0.05), 0.12, 0.17);
    fin.rotation.set(0.25, 0, -side * 0.18);
    g.add(fin);
    return g;
  };
  drone.add(wingHalf(1), wingHalf(-1));

  // pod: a lathed fuselage under the wing centre, flattened sideways
  const prof = [[0, -0.42], [0.05, -0.39], [0.1, -0.3], [0.13, -0.15], [0.135, 0.05], [0.12, 0.2], [0.08, 0.3], [0.03, 0.34], [0, 0.34]]
    .map(([r, y]) => new T.Vector2(r, y));
  const podGeo = new T.LatheGeometry(prof, 14).rotateX(Math.PI / 2);
  podGeo.scale(1.25, 0.85, 1);
  const pod = xray(podGeo);
  pod.position.set(0, -0.04, 0.02);
  drone.add(pod);
  // nose camera
  const cam = xray(new T.SphereGeometry(0.045, 10, 6), false);
  cam.position.set(0, -0.09, -0.4);
  drone.add(cam);
  // pusher motor and propeller disc
  const motor = xray(new T.CylinderGeometry(0.035, 0.045, 0.08, 10).rotateX(Math.PI / 2), false);
  motor.position.set(0, -0.02, 0.4);
  drone.add(motor);
  const prop = new T.LineSegments(new T.EdgesGeometry(new T.CircleGeometry(0.17, 28)), wireMat);
  prop.position.set(0, -0.02, 0.45);
  drone.add(prop);
  const blade = xray(new T.BoxGeometry(0.34, 0.012, 0.03), false);
  blade.position.copy(prop.position);
  drone.add(blade);

  // the FNAV module: solid, on top of the pod, with the sky-sensor lens and its view cone
  const module = new T.Group();
  const body = new T.Mesh(new T.BoxGeometry(0.2, 0.08, 0.26), moduleMat);
  module.add(body);
  module.add(new T.LineSegments(new T.EdgesGeometry(body.geometry), accentLine));
  const lens = new T.Mesh(new T.CylinderGeometry(0.05, 0.055, 0.02, 24), accentMat);
  lens.position.y = 0.05;
  module.add(lens);
  const cone = new T.BufferGeometry().setFromPoints([
    new T.Vector3(-0.03, 0.06, 0), new T.Vector3(-0.32, 0.75, 0),
    new T.Vector3(0.03, 0.06, 0), new T.Vector3(0.32, 0.75, 0),
  ]);
  const coneLines = new T.LineSegments(cone, dashMat);
  coneLines.computeLineDistances();
  module.add(coneLines);
  module.position.set(0, 0.1, -0.04);
  drone.add(module);

  scene.add(new T.HemisphereLight(0xffffff, 0x222222, 0.9));
  const key = new T.DirectionalLight(0xffffff, 0.8);
  key.position.set(-2, 3, 2);
  scene.add(key);

  // callouts pinned to the module
  const pins = [...box.querySelectorAll('[data-pin]')];
  const PIN = { sensor: new T.Vector3(0, 0.82, -0.04), module: new T.Vector3(-0.1, 0.08, 0.06) };
  const v = new T.Vector3();
  const lead = box.querySelector('.xray__lead');

  let W = 1, H = 1, raf = 0, visible = true, t = 0, last = 0, px = 0, py = 0, tx = 0, ty = 0;
  function layout() {
    W = box.clientWidth; H = box.clientHeight;
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    // keep the whole wingspan in view on narrow screens
    camera.position.z = W / H < 1.4 ? 3.7 * 1.4 / (W / H) : 3.7;
    camera.updateProjectionMatrix();
  }
  function render() {
    drone.rotation.y = -0.55 + (reduced ? 0 : Math.sin(t * 0.25) * 0.45) + px * 0.25;
    drone.rotation.x = 0.08 + py * 0.12;
    drone.rotation.z = reduced ? 0 : Math.sin(t * 0.5) * 0.03;
    drone.position.y = reduced ? 0 : Math.sin(t * 0.8) * 0.03;
    blade.rotation.z = t * 30;
    renderer.render(scene, camera);
    drone.updateMatrixWorld();
    const pts = {};
    pins.forEach((el) => {
      v.copy(PIN[el.dataset.pin]).applyMatrix4(drone.matrixWorld).project(camera);
      const x = (v.x + 1) / 2 * W, y = (1 - v.y) / 2 * H;
      pts[el.dataset.pin] = [x, y];
      el.style.transform = `translate(${x}px, ${y}px)`;
    });
    if (lead && pts.module) {
      const [x, y] = pts.module;
      lead.setAttribute('d', `M${x} ${y}L${x - 30} ${y + 52}H${x - 46}`); // down and to the left, clear of the wing
    }
  }
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    t += dt;
    px += (tx - px) * 0.05; py += (ty - py) * 0.05;
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
  addEventListener('pointermove', (e) => { tx = e.clientX / innerWidth * 2 - 1; ty = e.clientY / innerHeight * 2 - 1; }, { passive: true });
  document.addEventListener('themechange', applyColors);

  layout();
  applyColors();
  box.classList.add('is-on'); // hide the drawn fallback
  run();
})();
