/* ==========================================================================
   TAPLY — Interactions
   Chaque module est indépendant et ne fait rien si ses éléments sont absents
   (le même fichier sert aux pages légales).
   ========================================================================== */
(() => {
  'use strict';

  const CONFIG = window.TAPLY_CONFIG || { images: {} };
  const $  = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => [...c.querySelectorAll(s)];
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- Année du copyright --------------------------------------------- */
  $$('[data-year]').forEach(el => { el.textContent = new Date().getFullYear(); });

  /* ---- Images : remplace les placeholders selon config.js -------------- */
  const loadMedia = fig => {
    const src = CONFIG.images && CONFIG.images[fig.dataset.img];
    if (!src || fig.querySelector('img')) return;
    // data-media : ne charge l'image que si la media query correspond (ex. desktop)
    if (fig.dataset.media) {
      const mq = matchMedia(fig.dataset.media);
      if (!mq.matches) { mq.addEventListener('change', () => loadMedia(fig), { once: true }); return; }
    }
    const img = new Image();
    img.alt = fig.dataset.alt || '';
    img.decoding = 'async';
    // pas de lazy si le cadre est masqué jusqu'au chargement (data-flag) : le navigateur ne le chargerait jamais
    if (!fig.hasAttribute('data-eager') && !fig.dataset.flag) img.loading = 'lazy';
    else img.fetchPriority = 'high';
    img.addEventListener('load', () => {
      fig.classList.add('is-loaded');
      if (fig.dataset.flag) document.documentElement.classList.add(fig.dataset.flag);
      // data-var : expose l'image en variable CSS sur la section (ex. fond flouté du hero)
      if (fig.dataset.var) fig.parentElement.style.setProperty(fig.dataset.var, `url("${new URL(src, location.href).href}")`);
    }, { once: true });
    img.addEventListener('error', () => console.warn(`[Taply] Image introuvable : ${src}`), { once: true });
    // Version 800 px automatique pour les petits écrans (fichier « nom-800.webp » à côté de l'original)
    const small = /\.webp$/.test(src) && !/-800\.webp$/.test(src) && fig.dataset.small !== 'none' ? src.replace(/\.webp$/, '-800.webp') : '';
    if (small) {
      img.srcset = `${small} 800w, ${src} 1672w`;
      img.sizes = fig.dataset.sizes || '100vw';
    }
    img.src = src;
    fig.prepend(img);
  };
  $$('[data-img]').forEach(loadMedia);

  if (CONFIG.heroDevice === false) document.documentElement.classList.add('html-device-off');

  /* ---- Navigation : fond au scroll, masquage en descente --------------- */
  const nav = $('[data-nav]');
  if (nav && !document.body.classList.contains('legal-page')) {
    let lastY = scrollY;
    let ticking = false;
    const update = () => {
      const y = scrollY;
      nav.classList.toggle('is-solid', y > 40);
      nav.classList.toggle('is-hidden', y > 640 && y > lastY + 4 && !document.body.classList.contains('menu-open'));
      if (y < lastY - 4 || y < 640) nav.classList.remove('is-hidden');
      lastY = y;
      ticking = false;
    };
    addEventListener('scroll', () => { if (!ticking) { requestAnimationFrame(update); ticking = true; } }, { passive: true });
    update();
    nav.addEventListener('focusin', () => nav.classList.remove('is-hidden'));

    // lien actif selon la section visible
    const links = $$('.nav__links a');
    const sections = links.map(a => $(a.getAttribute('href'))).filter(Boolean);
    if ('IntersectionObserver' in window && sections.length) {
      const io = new IntersectionObserver(entries => {
        entries.forEach(e => {
          if (!e.isIntersecting) return;
          links.forEach(a => {
            if (a.getAttribute('href') === `#${e.target.id}`) a.setAttribute('aria-current', 'true');
            else a.removeAttribute('aria-current');
          });
        });
      }, { rootMargin: '-45% 0px -50% 0px' });
      sections.forEach(s => io.observe(s));
    }
  }

  /* ---- Menu mobile ----------------------------------------------------- */
  const menu = $('[data-menu]');
  const openBtn = $('[data-menu-open]');
  if (menu && openBtn) {
    const focusables = () => $$('a, button', menu);
    const open = () => {
      menu.hidden = false;
      document.body.classList.add('menu-open');
      document.body.style.overflow = 'hidden';
      openBtn.setAttribute('aria-expanded', 'true');
      requestAnimationFrame(() => requestAnimationFrame(() => menu.classList.add('is-open')));
      focusables()[0].focus();
    };
    const close = (returnFocus = true) => {
      menu.classList.remove('is-open');
      document.body.classList.remove('menu-open');
      document.body.style.overflow = '';
      openBtn.setAttribute('aria-expanded', 'false');
      setTimeout(() => { menu.hidden = true; }, reduceMotion ? 0 : 350);
      if (returnFocus) openBtn.focus();
    };
    openBtn.addEventListener('click', open);
    $('[data-menu-close]', menu).addEventListener('click', () => close());
    $$('a', menu).forEach(a => a.addEventListener('click', () => close(false)));
    menu.addEventListener('keydown', e => {
      if (e.key === 'Escape') close();
      if (e.key !== 'Tab') return;
      const f = focusables(); const first = f[0]; const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    matchMedia('(min-width: 1024px)').addEventListener('change', e => { if (e.matches && !menu.hidden) close(false); });
  }

  /* ---- Révélations au scroll ------------------------------------------ */
  const reveals = $$('[data-reveal]');
  if (!('IntersectionObserver' in window) || reduceMotion) {
    reveals.forEach(el => el.classList.add('is-in'));
  } else {
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: .08 });
    reveals.forEach(el => io.observe(el));
  }

  /* ---- iPhone Wallet : apparition pilotée par le scroll ------------- */
  const scrub = $('[data-scrub]');
  if (scrub) {
    const section = scrub.closest('section');
    if (reduceMotion) section.style.setProperty('--p', 1);
    else {
      const easeOut = t => 1 - Math.pow(1 - t, 3);
      let raf = 0;
      const update = () => {
        raf = 0;
        const r = scrub.getBoundingClientRect();
        // 0 quand le haut de l'iPhone atteint 88 % de l'écran, 1 quand il atteint 8 % du haut
        const start = innerHeight * .88, end = innerHeight * .08;
        const t = Math.min(1, Math.max(0, (start - r.top) / (start - end)));
        section.style.setProperty('--p', easeOut(t).toFixed(4));
      };
      const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
      addEventListener('scroll', onScroll, { passive: true });
      addEventListener('resize', onScroll);
      update();
    }
  }

  /* ---- Carte "Comment ça marche" : se remplit étape par étape ----------- */
  const howCard = $('[data-how-card]');
  if (howCard && 'IntersectionObserver' in window) {
    const label = $('[data-how-label]', howCard);
    const labels = { 1: 'Tap', 2: 'Visite enregistrée', 3: 'Café offert' };
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (!e.isIntersecting) return;
        const step = e.target.dataset.step;
        howCard.dataset.step = step;
        if (label) label.textContent = labels[step];
      });
    }, { rootMargin: '-40% 0px -45% 0px' });
    $$('.step[data-step]').forEach(s => io.observe(s));
  }

  /* ---- Accordéon FAQ (un seul ouvert à la fois) ------------------------ */
  $$('[data-accordion]').forEach(acc => {
    const items = $$('.acc', acc);
    items.forEach(item => {
      const btn = $('.acc__q', item);
      btn.addEventListener('click', () => {
        const willOpen = btn.getAttribute('aria-expanded') !== 'true';
        items.forEach(other => {
          other.classList.remove('is-open');
          $('.acc__q', other).setAttribute('aria-expanded', 'false');
        });
        item.classList.toggle('is-open', willOpen);
        btn.setAttribute('aria-expanded', String(willOpen));
      });
    });
  });

  /* ---- Cookies (consentement stocké localement) ------------------------ */
  const banner = $('[data-cookie]');
  if (banner) {
    const KEY = 'taply-consent';
    const read = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch (_) { return null; } };
    const save = analytics => {
      try { localStorage.setItem(KEY, JSON.stringify({ analytics, date: Date.now() })); } catch (_) {}
      banner.hidden = true;
      document.dispatchEvent(new CustomEvent('taply:consent', { detail: { analytics } }));
      // Brancher ici le script de mesure d'audience si analytics === true.
    };
    const prefs = $('[data-cookie-prefs]', banner);
    const toggle = $('[data-cookie-analytics]', banner);
    const btnSave = $('[data-cookie-save]', banner);
    const btnCustom = $('[data-cookie-custom]', banner);
    const showPrefs = () => {
      const stored = read();
      toggle.checked = !!(stored && stored.analytics);
      prefs.hidden = false; btnSave.hidden = false; btnCustom.hidden = true;
    };
    if (!read()) banner.hidden = false;
    $('[data-cookie-accept]', banner).addEventListener('click', () => save(true));
    $('[data-cookie-refuse]', banner).addEventListener('click', () => save(false));
    btnCustom.addEventListener('click', showPrefs);
    btnSave.addEventListener('click', () => save(toggle.checked));
    $$('[data-cookie-open]').forEach(b => b.addEventListener('click', () => {
      banner.hidden = false; showPrefs(); toggle.focus();
    }));
  }
})();
