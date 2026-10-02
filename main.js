(() => {
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ---------- theme ---------- */
  document.getElementById('theme').addEventListener('click', () => {
    const next = root.dataset.theme === 'light' ? 'dark' : 'light';
    root.dataset.theme = next;
    try { localStorage.setItem('fnav-theme', next); } catch (e) {}
    document.dispatchEvent(new CustomEvent('themechange', { detail: next }));
  });

  /* ---------- hero: scroll-driven wordmark (home page only) ---------- */
  const hero = document.getElementById('hero');
  if (hero) {
    const wordmark = document.getElementById('wordmark');
    let ticking = false;

    // size the wordmark so it spans the stage exactly, edge to edge
    const fit = () => {
      // the drone glyph takes the cap height and V width of whatever font the wordmark uses
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.font = `800 100px ${getComputedStyle(wordmark).fontFamily}`;
      const cap = ctx.measureText('N').actualBoundingBoxAscent / 100;
      if (cap > 0) {
        wordmark.style.setProperty('--cap', cap.toFixed(3));
        wordmark.style.setProperty('--vw', (ctx.measureText('V').width / 100).toFixed(3));
      }
      wordmark.style.fontSize = '100px';
      const natural = wordmark.firstElementChild.getBoundingClientRect().width;
      const byWidth = 100 * wordmark.clientWidth / natural;
      const byHeight = innerHeight * 0.38 / 0.74; // never taller than 38% of the screen
      wordmark.style.fontSize = `${Math.min(byWidth, byHeight)}px`;
    };
    const updateHero = () => {
      ticking = false;
      const r = hero.getBoundingClientRect();
      const p = clamp(-r.top / (r.height - innerHeight), 0, 1);
      root.style.setProperty('--p', p.toFixed(4));
    };
    addEventListener('scroll', () => {
      if (!ticking) { ticking = true; requestAnimationFrame(updateHero); }
    }, { passive: true });
    addEventListener('resize', () => { fit(); updateHero(); });
    if (document.fonts) document.fonts.ready.then(fit);
    fit();
    updateHero();
  }

  /* ---------- reveal on scroll ---------- */
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
    });
  }, { threshold: 0.15 });
  document.querySelectorAll('.reveal').forEach((el, i) => {
    el.style.transitionDelay = `${(i % 3) * 80}ms`;
    io.observe(el);
  });

  /* ---------- card spotlight + magnetic button ---------- */
  document.querySelectorAll('[data-spot]').forEach((card) => {
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--my', `${e.clientY - r.top}px`);
    });
  });
  if (!reduced) {
    document.querySelectorAll('[data-magnet]').forEach((btn) => {
      btn.addEventListener('pointermove', (e) => {
        const r = btn.getBoundingClientRect();
        const x = e.clientX - r.left - r.width / 2;
        const y = e.clientY - r.top - r.height / 2;
        btn.style.transform = `translate(${x * 0.2}px, ${y * 0.3}px)`;
      });
      btn.addEventListener('pointerleave', () => { btn.style.transform = ''; });
    });
  }

  /* ---------- contact form: no backend, opens a pre-filled email ---------- */
  const form = document.getElementById('contactForm');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const d = new FormData(form);
      const body = `${d.get('message')}\n\n— ${d.get('name')}${d.get('org') ? `, ${d.get('org')}` : ''}\n${d.get('email')}`;
      location.href = `mailto:office@fnav-systems.com?subject=${encodeURIComponent(d.get('subject'))}&body=${encodeURIComponent(body)}`;
    });
  }

  /* ---------- 3D mini-game: three.js is loaded only when the banner is near ---------- */
  const game = document.getElementById('game');
  if (game) {
    const load = (src) => new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = src; s.onload = ok; s.onerror = fail;
      document.head.appendChild(s);
    });
    const lazy = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      lazy.disconnect();
      load('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js')
        .then(() => load('game3d.js?v=5'))
        .catch(() => { document.getElementById('hint').textContent = '3D engine failed to load'; });
    }, { rootMargin: '600px' });
    lazy.observe(game);
  }
})();
