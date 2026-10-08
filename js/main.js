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

  /* ---- MacBook : ouverture réversible synchronisée au scroll ----------- */
  const dashboardStory = $('[data-dashboard-story]');
  if (dashboardStory) {
    const mac = $('[data-macbook]', dashboardStory);
    const desktop = matchMedia('(min-width: 1024px)');
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let pending = false;
    const updateMac = () => {
      pending = false;
      // Mobile et mouvement réduit : écran ouvert et entièrement lisible.
      let progress = 1;
      if (desktop.matches && !motion.matches) {
        const top = dashboardStory.getBoundingClientRect().top;
        const start = innerHeight * .83;
        const end = -innerHeight * .3;
        progress = Math.max(0, Math.min(1, (start - top) / (start - end)));
      }
      mac.style.setProperty('--mac-progress', progress.toFixed(4));
      mac.style.setProperty('--mac-angle', (-76 * (1 - progress)).toFixed(2) + 'deg');
    };
    const requestMac = () => {
      if (!pending) { pending = true; requestAnimationFrame(updateMac); }
    };
    addEventListener('scroll', requestMac, { passive: true });
    addEventListener('resize', requestMac);
    desktop.addEventListener('change', requestMac);
    motion.addEventListener('change', requestMac);
    updateMac();
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

  /* ---- Vidéo de démo (modale) ----------------------------------------- */
  const modal = $('[data-video]');
  if (modal && typeof modal.showModal === 'function') {
    const slot = $('[data-video-slot]', modal);
    let mounted = false;
    const mount = () => {
      if (mounted || !CONFIG.demoVideo) return;
      mounted = true;
      const isEmbed = /youtube|vimeo/.test(CONFIG.demoVideo);
      const el = document.createElement(isEmbed ? 'iframe' : 'video');
      if (isEmbed) {
        el.src = CONFIG.demoVideo + (CONFIG.demoVideo.includes('?') ? '&' : '?') + 'autoplay=1';
        el.allow = 'autoplay; fullscreen; picture-in-picture';
        el.title = 'Vidéo de démonstration Taply';
      } else {
        Object.assign(el, { src: CONFIG.demoVideo, controls: true, autoplay: true, playsInline: true });
        if (CONFIG.demoPoster) el.poster = CONFIG.demoPoster;
      }
      slot.replaceChildren(el);
    };
    $$('[data-video-open]').forEach(btn => btn.addEventListener('click', e => {
      e.preventDefault();
      mount();
      modal.showModal();
    }));
    const closeModal = () => {
      modal.close();
      const v = $('video', modal); if (v) v.pause();
      const f = $('iframe', modal); if (f) { mounted = false; slot.replaceChildren(); }
    };
    $('[data-video-close]', modal).addEventListener('click', closeModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
    modal.addEventListener('cancel', e => { e.preventDefault(); closeModal(); });
  }

  /* ---- Anti-spam (complément du filtre serveur, ex. Formspree) -------- */
  // Robot = champ piège rempli, ou envoi moins de 3 s après l'ouverture de la page.
  const pageOpenedAt = Date.now();
  const looksLikeBot = f => {
    const trap = f.querySelector('[name="_gotcha"]');
    return (trap && trap.value) || Date.now() - pageOpenedAt < 3000;
  };

  /* ---- Formulaire de démo --------------------------------------------- */
  const form = $('[data-form]');
  if (form) {
    const emailOk = v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
    const check = input => {
      const field = input.closest('.field');
      let ok = input.type === 'checkbox' ? input.checked
             : input.type === 'email' ? emailOk(input.value.trim())
             : input.value.trim().length > 1;
      if (!input.required && input.type !== 'checkbox') ok = true;
      if (field) field.classList.toggle('has-error', !ok);
      const err = document.getElementById(`${input.id}-err`);
      if (err) {
        err.classList.toggle('is-shown', !ok);
        input.setAttribute('aria-invalid', String(!ok));
        if (!ok) input.setAttribute('aria-describedby', err.id); else input.removeAttribute('aria-describedby');
      }
      return ok;
    };
    const required = $$('input[required]', form);
    required.forEach(i => i.addEventListener(i.type === 'checkbox' ? 'change' : 'blur', () => {
      if (i.value || i.type === 'checkbox') check(i);
    }));

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const results = required.map(check);
      const firstBad = required[results.indexOf(false)];
      if (firstBad) { firstBad.focus(); return; }

      const btn = $('button[type="submit"]', form);
      btn.disabled = true;
      try {
        if (CONFIG.formEndpoint && !looksLikeBot(form)) {
          const res = await fetch(CONFIG.formEndpoint, { method: 'POST', body: new FormData(form), headers: { Accept: 'application/json' } });
          if (!res.ok) throw new Error(res.status);
        }
        btn.hidden = true;
        $('.form__done', form).hidden = false;
        form.reset();
      } catch (err) {
        btn.disabled = false;
        alert("L'envoi a échoué. Réessayez ou écrivez-nous directement.");
      }
    });
  }

  /* ---- Newsletter ------------------------------------------------------ */
  const nl = $('[data-newsletter]');
  if (nl) {
    const msg = $('.newsletter__msg', nl);
    nl.addEventListener('submit', async e => {
      e.preventDefault();
      const input = $('input', nl);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(input.value.trim())) {
        msg.textContent = 'Indiquez un e-mail valide.';
        input.focus();
        return;
      }
      if (CONFIG.newsletterEndpoint && !looksLikeBot(nl)) {
        try { await fetch(CONFIG.newsletterEndpoint, { method: 'POST', body: new FormData(nl) }); }
        catch (_) { msg.textContent = 'Inscription impossible pour le moment.'; return; }
      }
      msg.textContent = 'Merci ! Première lettre bientôt dans votre boîte.';
      nl.reset();
    });
  }

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
