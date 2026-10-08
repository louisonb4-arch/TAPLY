/* ==========================================================================
   TAPLY — Espace commerçant (prototype front, sans serveur)
   Routage par hash (#/accueil, #/clients/lea-d…). L'état de démo est
   conservé dans le navigateur (localStorage) : réinitialisable depuis
   Paramètres. Brancher une API = remplacer load()/save() et data.js.
   ========================================================================== */
(() => {
  'use strict';

  const DEMO = window.TAPLY_DEMO;
  const KEY = 'taply-dashboard-demo-v1';
  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => [...c.querySelectorAll(s)];
  const view = $('#view');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- État ------------------------------------------------------------ */
  const clone = o => JSON.parse(JSON.stringify(o));
  const fresh = () => {
    const s = clone({ merchant: DEMO.merchant, clients: DEMO.clients, rewards: DEMO.rewards, sent: DEMO.sent, activity: DEMO.activity });
    s.clients.forEach(c => { c.log = buildLog(c); });
    return s;
  };
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || fresh(); } catch (_) { return fresh(); } };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) { toast("Stockage du navigateur plein : modification non conservée."); } };
  let state = load();

  function buildLog(c) {
    const log = [];
    let ago = c.last;
    for (let i = 0; i < Math.min(c.visits, 6); i++) {
      if (i === 1 && c.used) log.push({ type: 'reward', label: 'Récompense utilisée', detail: 'Brunch offert', ago: ago + 4 });
      log.push({ type: 'visit', label: 'Visite', ago });
      ago += 9 + (i * 5) % 13;
    }
    return log;
  }

  /* ---- Utilitaires ----------------------------------------------------- */
  const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const nf = new Intl.NumberFormat('fr-FR');
  const num = n => nf.format(n);
  const ico = (id, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#d-${id}"/></svg>`;
  const initials = name => name.split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase();
  const tone = id => 'avatar--' + 'abcd'[[...id].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 4];
  const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const plural = (n, one, many) => `${num(n)} ${n > 1 ? many : one}`;
  const agoMin = m => m < 1 ? "À l'instant" : m < 60 ? `Il y a ${m} min` : m < 1440 ? `Il y a ${Math.round(m / 60)} h` : `Il y a ${Math.round(m / 1440)} j`;
  const agoDays = d => d === 0 ? "aujourd'hui" : d === 1 ? 'hier' : d < 30 ? `il y a ${d} jours` : d < 60 ? 'il y a 1 mois' : `il y a ${Math.round(d / 30)} mois`;
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const dateFr = (iso, o = { day: 'numeric', month: 'short', year: 'numeric' }) => new Date(iso.length === 10 ? iso + 'T12:00' : iso).toLocaleDateString('fr-FR', o);
  const client = id => state.clients.find(c => c.id === id);
  const delta = (v, suffix = 'vs mois dernier') => `<span class="delta${v < 0 ? ' delta--down' : ''}">${ico('up')}${v > 0 ? '+' : ''}${v} %</span>`;

  function toast(msg) {
    const host = $('[data-toasts]');
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = ico('check');
    t.append(document.createTextNode(msg));
    host.append(t);
    setTimeout(() => { t.classList.add('is-out'); setTimeout(() => t.remove(), 300); }, 2800);
  }

  function confirmSheet({ title, text, ok }) {
    const d = $('[data-sheet]');
    $('[data-sheet-title]', d).textContent = title;
    $('[data-sheet-text]', d).textContent = text;
    $('[data-sheet-ok]', d).textContent = ok;
    return new Promise(resolve => {
      d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true });
      d.returnValue = '';
      d.showModal();
    });
  }

  const readImage = (file, cb) => {
    if (!file || !file.type.startsWith('image/')) return toast('Choisissez une image (JPG, PNG, WebP).');
    if (file.size > 4e6) return toast('Image trop lourde (4 Mo maximum).');
    const r = new FileReader();
    r.onload = () => cb(r.result);
    r.readAsDataURL(file);
  };

  /* ---- Composants ------------------------------------------------------ */
  const kpi = (icon, label, value, d, sub) => `
    <div class="card kpi">
      <span class="kpi__icon">${ico(icon)}</span>
      <span class="kpi__label">${label}</span>
      <span class="kpi__value">${value}${d != null ? delta(d) : ''}</span>
      <span class="kpi__sub">${sub}</span>
    </div>`;

  const loyaltyCard = ({ filled, total, theme, reward, footLeft, footRight }) => {
    const m = state.merchant;
    const stamps = Array.from({ length: total }, (_, i) => `<i class="${i < filled ? 'on' : ''}"></i>`).join('');
    return `
      <div class="lc" data-theme="${esc(theme || m.card.theme)}" style="--stamp:url('${esc(m.stamp)}')" role="img" aria-label="Carte de fidélité ${esc(m.name)} : ${filled} visites sur ${total}">
        <div class="lc__head"><img class="lc__logo" src="${esc(m.logo)}" alt=""><span class="lc__kind">Carte fidélité</span></div>
        <div class="lc__stamps">${stamps}</div>
        <div class="lc__foot"><strong>${footLeft ?? `${filled} visite${filled > 1 ? 's' : ''} sur ${total}`}</strong><span>${footRight ?? (filled >= total ? 'Récompense disponible !' : `Encore ${total - filled} visite${total - filled > 1 ? 's' : ''}<br>avant ${esc(reward || 'votre récompense')}`)}</span></div>
      </div>`;
  };

  const rewardImg = (r, style = '') => r.photo
    ? `<span class="reward__img" style="${style}"><img src="${esc(r.photo)}" alt=""></span>`
    : `<span class="reward__img tone-${esc(r.tone || 'latte')}" style="${style}">${ico('gift')}</span>`;

  /* ---- Graphiques (SVG, un seul axe, une seule série) ------------------ */
  function niceScale(maxV, steps = 3) {
    const raw = maxV / steps;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(s => s >= raw);
    return { max: step * steps, step };
  }

  function chart(host, { type, points, fmtX, fmtTip, unit }) {
    const NS = 'http://www.w3.org/2000/svg';
    const tip = document.createElement('div');
    tip.className = 'tip'; tip.hidden = true;
    let idx = -1;

    // Vue tableau (accessibilité) : mêmes valeurs que le graphique
    const table = document.createElement('table');
    table.className = 'sr-only';
    table.innerHTML = `<caption>${esc(host.getAttribute('aria-label'))}</caption><thead><tr><th scope="col">Période</th><th scope="col">${esc(unit)}</th></tr></thead>`;
    const tb = document.createElement('tbody');
    points.forEach(p => { const tr = tb.insertRow(); tr.insertCell().textContent = fmtTip(p.d); tr.insertCell().textContent = num(p.v); });
    table.append(tb);

    function draw() {
      const W = host.clientWidth, H = host.clientHeight;
      if (!W) return;
      const m = { l: 34, r: 8, t: 10, b: 26 };
      const iw = W - m.l - m.r, ih = H - m.t - m.b;
      const { max, step } = niceScale(Math.max(...points.map(p => p.v)));
      const n = points.length;
      const band = iw / n;
      const x = i => type === 'bar' ? m.l + band * i + band / 2 : m.l + (n === 1 ? iw / 2 : (iw * i) / (n - 1));
      const y = v => m.t + ih - (v / max) * ih;

      let s = `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">`;
      for (let v = 0; v <= max; v += step) {
        s += `<line class="${v ? 'grid-line' : 'base-line'}" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
        s += `<text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${num(v)}</text>`;
      }
      const every = Math.max(1, Math.ceil(n / (W < 480 ? 4 : 6)));
      points.forEach((p, i) => {
        if (i % every === 0 || (type === 'line' && i === n - 1 && (n - 1) % every > every / 2))
          s += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(fmtX(p.d))}</text>`;
      });
      if (type === 'line') {
        const gid = 'g' + Math.random().toString(36).slice(2, 7);
        const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
        s += `<defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#2F8A1F" stop-opacity=".22"/><stop offset="1" stop-color="#2F8A1F" stop-opacity="0"/></linearGradient></defs>`;
        s += `<path fill="url(#${gid})" d="${line}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z"/><path class="line" d="${line}"/>`;
        s += `<line class="cross" y1="${m.t}" y2="${y(0)}" x1="-9" x2="-9"/><circle class="dot" r="5" cx="-9" cy="-9"/>`;
      } else {
        const bw = Math.max(3, Math.min(28, band - 2 * Math.max(2, band * .18)));
        points.forEach((p, i) => {
          const h = Math.max(2, y(0) - y(p.v)), bx = x(i) - bw / 2, by = y(0) - h, r = Math.min(4, bw / 2, h);
          s += `<path class="bar" data-i="${i}" d="M${bx},${y(0)}V${by + r}Q${bx},${by} ${bx + r},${by}H${bx + bw - r}Q${bx + bw},${by} ${bx + bw},${by + r}V${y(0)}Z"/>`;
        });
      }
      s += '</svg>';
      host.innerHTML = s;
      host.append(tip, table);

      const show = i => {
        idx = Math.max(0, Math.min(n - 1, i));
        const p = points[idx];
        const cx = x(idx), cy = y(p.v);
        tip.hidden = false;
        tip.innerHTML = '';
        const strong = document.createElement('strong'); strong.textContent = `${num(p.v)} ${unit}`;
        const lab = document.createElement('span'); lab.textContent = fmtTip(p.d);
        tip.append(strong, lab);
        tip.style.left = Math.min(W - 60, Math.max(60, cx)) + 'px';
        tip.style.top = cy + 'px';
        host.classList.add('is-hovering');
        if (type === 'line') {
          const cl = $('.cross', host); cl.setAttribute('x1', cx); cl.setAttribute('x2', cx);
          const dot = $('.dot', host); dot.setAttribute('cx', cx); dot.setAttribute('cy', cy);
        } else {
          $$('.bar', host).forEach(b => b.classList.toggle('is-active', +b.dataset.i === idx));
        }
      };
      const hide = () => {
        tip.hidden = true; host.classList.remove('is-hovering'); idx = -1;
        if (type === 'line') { $('.dot', host).setAttribute('cx', -9); const cl = $('.cross', host); cl.setAttribute('x1', -9); cl.setAttribute('x2', -9); }
      };
      host.onpointermove = e => {
        const rx = e.clientX - host.getBoundingClientRect().left;
        show(type === 'bar' ? Math.floor((rx - m.l) / band) : Math.round(((rx - m.l) / iw) * (n - 1)));
      };
      host.onpointerleave = hide;
      host.onkeydown = e => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); show((idx < 0 ? (e.key === 'ArrowRight' ? -1 : n) : idx) + (e.key === 'ArrowRight' ? 1 : -1)); }
        if (e.key === 'Escape') hide();
      };
      host.onblur = hide;
    }
    host.tabIndex = 0;
    host.setAttribute('role', 'group');
    draw();
    const ro = new ResizeObserver(() => draw());
    ro.observe(host);
    return () => ro.disconnect();
  }

  /* ---- Pages ----------------------------------------------------------- */
  const fmtDay = d => new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  const fmtDayLong = d => cap(new Date(d).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }));
  const fmtMonth = d => new Date(d).toLocaleDateString('fr-FR', { month: 'short' });
  const fmtMonthLong = d => cap(new Date(d).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }));

  const pages = {};
  let cleanup = [];

  // ACCUEIL
  pages.accueil = () => {
    const m = state.merchant, p = DEMO.periods['30j'];
    return {
      title: 'Accueil',
      html: `
        <div class="hello">
          <span class="hello__logo"><img src="${esc(m.logo)}" alt=""></span>
          <div><h1>Bonjour ${esc(m.name)} !</h1><p>Voici un aperçu de votre activité · ${fmtDayLong(DEMO.today).toLowerCase()}</p></div>
        </div>
        <section class="kpis" aria-label="Indicateurs clés">
          ${kpi('users', "Visites aujourd'hui", num(DEMO.today_.visits), DEMO.today_.visitsDelta, 'vs hier')}
          ${kpi('heart', 'Clients fidèles', num(DEMO.totals.loyal), 12, 'vs mois dernier')}
          ${kpi('gift', 'Récompenses débloquées', num(p.rewards), p.rewardsDelta, 'vs mois dernier')}
          ${kpi('chart', 'Taux de retour', p.returnRate + ' %', p.returnDelta, 'vs mois dernier')}
        </section>
        <div class="home-grid" style="margin-top:1.25rem">
          <section class="card chart-card" aria-labelledby="c-visits">
            <div class="chart-card__head">
              <h2 class="chart-card__title" id="c-visits">${ico('trend')}Visites sur 30 jours</h2>
              <p class="chart-card__total"><small>Total</small><strong>${num(p.visits)}</strong> ${delta(p.visitsDelta)}</p>
            </div>
            <div class="chart" data-chart aria-label="Visites par jour sur les 30 derniers jours"></div>
          </section>
          <div class="mini-cards">
            <a class="card mini" href="#/parametres/carte">
              <span class="mini__icon">${ico('gift')}</span>
              <small>Programme de fidélité</small>
              <strong>${m.card.visits} visites = ${esc(m.card.reward)}</strong>
              <span class="link">Modifier le programme ${ico('arrow')}</span>
            </a>
            <a class="card mini" href="#/parametres/integrations">
              <span class="mini__icon">${ico('nfc')}</span>
              <small>Présentoir Taply (NFC)</small>
              <strong style="color:var(--ok);display:flex;align-items:center;gap:.5rem"><i class="dot dot--ok" aria-hidden="true"></i>${esc(m.nfc.status)}</strong>
              <small>Dernière connexion ${esc(m.nfc.lastSeen)}</small>
            </a>
            <a class="card mini" href="#/notifications" style="grid-column:1/-1">
              <span class="mini__icon">${ico('send')}</span>
              <small>Notifications</small>
              <strong>Prévenez vos ${num(DEMO.totals.clients)} clients d'une nouveauté</strong>
              <span class="link">Écrire un message ${ico('arrow')}</span>
            </a>
          </div>
          <section class="card card--flush span-2" aria-labelledby="t-act">
            <div class="section-title" style="padding:1.1rem 1.1rem 0"><h2 id="t-act" style="font-size:inherit">Activité récente</h2><a href="#/clients">Voir tout ${ico('arrow')}</a></div>
            <ul class="list">
              ${state.activity.map(a => { const c = client(a.who); return c ? `
                <li><a class="row" href="#/clients/${c.id}">
                  <span class="avatar ${tone(c.id)}" aria-hidden="true">${initials(c.name)}</span>
                  <span class="row__main"><strong>${esc(c.name)}</strong><small>${esc(a.what)}${a.reward ? ' 🎁' : ''}</small></span>
                  <span class="row__end">${agoMin(a.ago)}</span>
                </a></li>` : ''; }).join('')}
            </ul>
          </section>
        </div>`,
      mount() {
        cleanup.push(chart($('[data-chart]'), { type: 'line', points: p.points, fmtX: fmtDay, fmtTip: fmtDayLong, unit: 'visites' }));
      }
    };
  };

  // CLIENTS
  pages.clients = () => {
    const filters = { tous: `Tous (${num(DEMO.totals.clients)})`, fideles: `Fidèles (${num(DEMO.totals.loyal)})`, recents: 'Récents' };
    let f = 'tous', q = '';
    const rows = () => {
      let list = [...state.clients];
      if (f === 'fideles') list = list.filter(c => c.loyal);
      if (f === 'recents') list = list.filter(c => c.last <= 7).sort((a, b) => a.last - b.last);
      else list.sort((a, b) => b.visits - a.visits);
      if (q) list = list.filter(c => norm(c.name).includes(norm(q)));
      if (!list.length) return `<li class="empty">Aucun client ne correspond à « ${esc(q)} ».</li>`;
      return list.map(c => `
        <li><a class="row" href="#/clients/${c.id}">
          <span class="avatar ${tone(c.id)}" aria-hidden="true">${initials(c.name)}</span>
          <span class="row__main"><strong>${esc(c.name)}</strong><small>${plural(c.visits, 'visite', 'visites')}<span class="hide-sm"> · dernière ${agoDays(c.last)}</span></small></span>
          <span class="row__end">${c.loyal ? '<span class="badge">Fidèle</span>' : ''}${ico('chev')}</span>
        </a></li>`).join('');
    };
    return {
      title: 'Clients',
      html: `
        <div class="page-head"><div><h1>Clients</h1><p>${esc(state.merchant.name)} · ${num(DEMO.totals.clients)} clients au total</p></div></div>
        <div class="grid" style="margin-bottom:1rem">
          <div class="search">${ico('search')}<label class="sr-only" for="q">Rechercher un client</label><input class="input" id="q" type="search" placeholder="Rechercher un client" autocomplete="off"></div>
          <div class="seg" role="group" aria-label="Filtrer les clients">${Object.entries(filters).map(([k, v]) => `<button type="button" data-f="${k}" aria-pressed="${k === f}">${v}</button>`).join('')}</div>
        </div>
        <section class="card card--flush"><ul class="list" data-rows>${rows()}</ul></section>
        <p class="demo-note">${state.clients.length} clients affichés sur ${num(DEMO.totals.clients)} · données de démonstration</p>`,
      mount() {
        const list = $('[data-rows]');
        $('#q').addEventListener('input', e => { q = e.target.value.trim(); list.innerHTML = rows(); });
        $$('[data-f]').forEach(b => b.addEventListener('click', () => {
          f = b.dataset.f;
          $$('[data-f]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
          list.innerHTML = rows();
        }));
      }
    };
  };

  // FICHE CLIENT
  pages.client = id => {
    const c = client(id);
    if (!c) return pages.notfound();
    const goal = state.merchant.card.visits;
    const filled = Math.min(c.cardVisits, goal);
    return {
      title: c.name, nav: 'clients',
      html: `
        <a class="back" href="#/clients">${ico('back')}Clients</a>
        <div class="client-grid">
          <div class="stack">
            <div class="client-head">
              <span class="avatar avatar--lg ${tone(c.id)}" aria-hidden="true">${initials(c.name)}</span>
              <div>
                <h1>${esc(c.name)}</h1>
                ${c.loyal ? '<span class="badge badge--solid">Fidèle</span>' : '<span class="badge badge--muted">Occasionnel</span>'}
                <small>Membre depuis le ${dateFr(c.since)}</small>
                <small>Dernière visite ${agoDays(c.last)}</small>
              </div>
            </div>
            <div class="client-stats">
              <div class="card">${ico('users')}<strong>${c.visits}</strong><small>Visites</small></div>
              <div class="card">${ico('gift')}<strong>${c.rewards}</strong><small>Récompenses débloquées</small></div>
              <div class="card">${ico('star')}<strong>${c.used}</strong><small>Récompenses utilisées</small></div>
            </div>
            ${loyaltyCard({ filled, total: goal, reward: state.merchant.card.reward })}
            <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(12rem,1fr))">
              <button class="btn btn--brand" type="button" data-add>${ico('plus')}Ajouter une visite</button>
              ${filled >= goal ? `<button class="btn btn--ok" type="button" data-redeem>${ico('gift')}Valider la récompense</button>` : ''}
            </div>
          </div>
          <section class="card card--flush" aria-labelledby="t-hist">
            <div class="section-title" style="padding:1.1rem 1.1rem 0"><h2 id="t-hist" style="font-size:inherit">Historique des visites</h2><span class="muted" style="font-size:.85rem">${esc(c.email)}</span></div>
            <ul class="list">
              ${c.log.map(l => `
                <li class="row">
                  <span class="hist-icon${l.type === 'reward' ? ' hist-icon--gift' : ''}">${ico(l.type === 'reward' ? 'gift' : 'check')}</span>
                  <span class="row__main"><strong>${esc(l.label)}</strong><small>${cap(agoDays(l.ago))}</small></span>
                  <span class="row__end">${l.type === 'reward' ? esc(l.detail) : '<span class="plus1">+1</span>'}</span>
                </li>`).join('')}
            </ul>
          </section>
        </div>`,
      mount() {
        $('[data-add]').addEventListener('click', () => {
          c.visits++; c.cardVisits++; c.last = 0;
          c.log.unshift({ type: 'visit', label: 'Visite', ago: 0 });
          state.activity.unshift({ who: c.id, what: 'Visite enregistrée', ago: 0 });
          const unlocked = c.cardVisits === state.merchant.card.visits;
          if (unlocked) { c.rewards++; state.activity.unshift({ who: c.id, what: 'Récompense débloquée', ago: 0, reward: true }); }
          save(); render();
          toast(unlocked ? `Récompense débloquée pour ${c.name} !` : `Visite ajoutée pour ${c.name}`);
        });
        const r = $('[data-redeem]');
        if (r) r.addEventListener('click', () => {
          c.cardVisits = 0; c.used++;
          c.log.unshift({ type: 'reward', label: 'Récompense utilisée', detail: state.merchant.card.reward, ago: 0 });
          state.activity.unshift({ who: c.id, what: 'Récompense utilisée', ago: 0, reward: true });
          save(); render();
          toast('Récompense validée — la carte repart à zéro');
        });
      }
    };
  };

  // RÉCOMPENSES
  pages.recompenses = () => {
    let tab = 'on';
    const count = on => state.rewards.filter(r => r.active === on).length;
    const list = () => {
      const items = state.rewards.filter(r => r.active === (tab === 'on'));
      if (!items.length) return `<li class="empty">${tab === 'on' ? 'Aucune récompense active.' : 'Aucune récompense inactive.'}</li>`;
      return items.map(r => `
        <li class="reward" data-id="${r.id}">
          ${rewardImg(r)}
          <div class="reward__main"><strong>${esc(r.name)}</strong><span>${plural(r.visits, 'visite', 'visites')}</span></div>
          <label class="switch"><input type="checkbox" ${r.active ? 'checked' : ''} aria-label="${r.active ? 'Désactiver' : 'Activer'} ${esc(r.name)}"><span></span></label>
        </li>`).join('');
    };
    return {
      title: 'Récompenses',
      html: `
        <div class="page-head"><div><h1>Récompenses</h1><p>Ce que vos clients débloquent en revenant.</p></div>
          <div class="page-head__actions"><a class="fab" href="#/recompenses/nouvelle" aria-label="Ajouter une récompense">${ico('plus')}</a></div></div>
        <div class="seg" role="group" aria-label="Filtrer les récompenses" style="margin-bottom:1rem;max-width:26rem">
          <button type="button" data-t="on" aria-pressed="true">Actives (<span data-c="on">${count(true)}</span>)</button>
          <button type="button" data-t="off" aria-pressed="false">Inactives (<span data-c="off">${count(false)}</span>)</button>
        </div>
        <ul class="grid rewards-list" data-list>${list()}</ul>
        <a class="btn btn--brand btn--block" href="#/recompenses/nouvelle" style="margin-top:1.25rem;max-width:26rem">${ico('plus')}Ajouter une récompense</a>`,
      mount() {
        const ul = $('[data-list]');
        $$('[data-t]').forEach(b => b.addEventListener('click', () => {
          tab = b.dataset.t;
          $$('[data-t]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
          ul.innerHTML = list();
        }));
        ul.addEventListener('change', e => {
          const li = e.target.closest('[data-id]');
          const r = state.rewards.find(x => x.id === li.dataset.id);
          r.active = e.target.checked;
          e.target.setAttribute('aria-label', `${r.active ? 'Désactiver' : 'Activer'} ${r.name}`);
          li.classList.toggle('is-off', r.active !== (tab === 'on'));
          $('[data-c="on"]').textContent = count(true);
          $('[data-c="off"]').textContent = count(false);
          save();
          toast(r.active ? `« ${r.name} » activée` : `« ${r.name} » désactivée`);
        });
      }
    };
  };

  // NOUVELLE RÉCOMPENSE
  pages.nouvelle = () => {
    const draft = { name: '', visits: 10, description: '', photo: '' };
    return {
      title: 'Nouvelle récompense', nav: 'recompenses',
      html: `
        <a class="back" href="#/recompenses">${ico('back')}Récompenses</a>
        <div class="page-head"><h1>Nouvelle récompense</h1></div>
        <div class="form-grid">
          <form class="card stack" data-form novalidate>
            <div class="field"><span class="label">Photo</span>
              <div class="photo-pick">
                <div data-photo></div>
                <label class="file-btn">${ico('camera')}<span data-photo-label>Ajouter une photo</span><input type="file" accept="image/*" data-file></label>
              </div>
            </div>
            <div class="field" data-f-name><label for="rn">Nom de la récompense</label><input class="input" id="rn" name="name" placeholder="Ex. Brunch offert" maxlength="40" required><p class="field__err" hidden>Donnez un nom à la récompense.</p></div>
            <div class="field"><span class="label" id="rv-l">Nombre de visites nécessaires</span>
              <div class="stepper" role="group" aria-labelledby="rv-l"><output data-v aria-live="polite"></output>
                <button type="button" data-step="-1" aria-label="Une visite de moins">${ico('minus')}</button>
                <button type="button" data-step="1" aria-label="Une visite de plus">${ico('plus')}</button></div>
            </div>
            <div class="field"><label for="rd">Description <span class="muted">(optionnelle)</span></label><textarea class="textarea" id="rd" maxlength="160" placeholder="Ex. Un brunch au choix sur notre carte"></textarea><span class="field__count" data-count>0/160</span></div>
            <button class="btn btn--brand btn--block" type="submit">Créer la récompense ${ico('arrow')}</button>
          </form>
          <aside class="stack">
            <p class="section-title" style="margin:0">Aperçu côté client</p>
            <div data-preview></div>
            <p class="muted" style="font-size:.9rem">La récompense apparaît sur la carte Wallet de vos clients et se débloque automatiquement.</p>
          </aside>
        </div>`,
      mount() {
        const paint = () => {
          $('[data-v]').textContent = plural(draft.visits, 'visite', 'visites');
          $('[data-step="-1"]').disabled = draft.visits <= 1;
          $('[data-step="1"]').disabled = draft.visits >= 50;
          $('[data-photo]').innerHTML = draft.photo
            ? `<div class="photo-pick__img"><img src="${esc(draft.photo)}" alt="Photo de la récompense"><button type="button" class="photo-pick__x" data-rm aria-label="Retirer la photo">${ico('x')}</button></div>`
            : `<div class="photo-pick__img tone-brunch" style="display:grid;place-items:center">${ico('gift')}</div>`;
          $('[data-photo-label]').textContent = draft.photo ? 'Changer la photo' : 'Ajouter une photo';
          const rm = $('[data-rm]'); if (rm) rm.onclick = () => { draft.photo = ''; paint(); };
          $('[data-preview]').innerHTML = loyaltyCard({ filled: Math.min(3, draft.visits), total: Math.min(draft.visits, 15), reward: draft.name || 'votre récompense' })
            + `<div class="card reward" style="margin-top:.75rem;box-shadow:none">${rewardImg({ photo: draft.photo, tone: 'brunch' })}<div class="reward__main"><strong>${esc(draft.name || 'Nom de la récompense')}</strong><span>${plural(draft.visits, 'visite', 'visites')}${draft.description ? ' · ' + esc(draft.description) : ''}</span></div></div>`;
        };
        paint();
        $$('[data-step]').forEach(b => b.addEventListener('click', () => { draft.visits = Math.max(1, Math.min(50, draft.visits + +b.dataset.step)); paint(); }));
        $('#rn').addEventListener('input', e => { draft.name = e.target.value.trim(); $('[data-f-name]').classList.remove('has-error'); $('[data-f-name] .field__err').hidden = true; paint(); });
        $('#rd').addEventListener('input', e => { draft.description = e.target.value; $('[data-count]').textContent = `${e.target.value.length}/160`; paint(); });
        $('[data-file]').addEventListener('change', e => readImage(e.target.files[0], url => { draft.photo = url; paint(); }));
        $('[data-form]').addEventListener('submit', e => {
          e.preventDefault();
          if (!draft.name) { $('[data-f-name]').classList.add('has-error'); $('[data-f-name] .field__err').hidden = false; $('#rn').focus(); return; }
          state.rewards.unshift({ id: 'r' + Date.now(), name: draft.name, visits: draft.visits, active: true, photo: draft.photo, tone: 'brunch', description: draft.description });
          save();
          location.hash = '#/recompenses';
          toast(`« ${draft.name} » créée et activée`);
        });
      }
    };
  };

  // NOTIFICATIONS
  pages.notifications = () => {
    const aud = [
      { k: 'all', label: 'Tous les clients', n: DEMO.totals.clients },
      { k: 'loyal', label: 'Clients fidèles', n: DEMO.totals.loyal },
      { k: 'inactive', label: 'Inactifs depuis 30 j', n: DEMO.totals.inactive }
    ];
    const draft = { a: 'all', text: '', img: '', email: false };
    const sentList = () => state.sent.map(s => `
      <li class="row" style="align-items:flex-start">
        <span class="hist-icon">${ico('send')}</span>
        <span class="row__main"><strong style="font-size:.92rem">${esc(s.text)}</strong><small>${esc(s.audience)} · ${num(s.count)} clients · ${s.ago === 'maintenant' ? "à l'instant" : 'il y a ' + esc(s.ago)}</small></span>
        <span class="row__end">${s.opened != null ? `<span class="badge">Ouverte ${s.opened} %</span>` : '<span class="badge badge--muted">Envoyée</span>'}</span>
      </li>`).join('');
    return {
      title: 'Notifications',
      html: `
        <div class="page-head"><div><h1>Envoyer une notification</h1><p>Vos clients la reçoivent sur l'écran de leur téléphone.</p></div></div>
        <div class="notif-grid">
          <form class="card stack" data-form novalidate>
            <div class="field"><span class="label" id="aud-l">Destinataires</span>
              <div class="seg seg--wrap" role="group" aria-labelledby="aud-l">${aud.map(x => `<button type="button" data-a="${x.k}" aria-pressed="${x.k === draft.a}">${x.label} (${num(x.n)})</button>`).join('')}</div>
            </div>
            <div class="field" data-f-msg><label for="msg">Message</label>
              <textarea class="textarea" id="msg" maxlength="160" placeholder="Ex. Nouveau brunch dispo ce week-end ! Venez découvrir notre nouvelle carte 😋"></textarea>
              <span class="field__count" data-count>0/160</span><p class="field__err" hidden>Écrivez votre message.</p></div>
            <div class="field"><span class="label">Image <span class="muted">(optionnelle)</span></span><div class="photo-pick" data-img></div></div>
            <label class="row" style="padding:0;border:0;min-height:3rem;cursor:pointer"><span class="row__main"><strong>Envoyer aussi par e-mail</strong><small>Aux clients qui ont accepté de recevoir vos offres</small></span><span class="switch"><input type="checkbox" data-email><span></span></span></label>
            <button class="btn btn--brand btn--block" type="submit">Envoyer la notification ${ico('arrow')}</button>
          </form>
          <div class="stack sticky">
            <section aria-label="Aperçu sur l'écran de verrouillage" class="notif-prev">
              <p class="notif-prev__date">${fmtDayLong(DEMO.today)}</p>
              <p class="notif-prev__time">9:41</p>
              <div class="push" style="margin-top:1.5rem">
                <span class="push__icon"><img src="${esc(state.merchant.logo)}" alt=""></span>
                <div><div class="push__head"><strong>${esc(state.merchant.name)}</strong><small>maintenant</small></div><div class="push__body" data-pv></div><div data-pv-img></div></div>
              </div>
            </section>
            <section class="card card--flush" aria-labelledby="t-sent">
              <h2 class="section-title" id="t-sent" style="padding:1.1rem 1.1rem 0">Envoyées récemment</h2>
              <ul class="list" data-sent>${sentList()}</ul>
            </section>
          </div>
        </div>`,
      mount() {
        const paint = () => {
          $('[data-pv]').textContent = draft.text || 'Votre message apparaîtra ici.';
          $('[data-pv-img]').innerHTML = draft.img ? `<img class="push__img" src="${esc(draft.img)}" alt="">` : '';
          $('[data-img]').innerHTML = draft.img
            ? `<div class="photo-pick__img"><img src="${esc(draft.img)}" alt="Image jointe"><button type="button" class="photo-pick__x" data-rm aria-label="Retirer l'image">${ico('x')}</button></div>`
            : `<label class="drop">${ico('plus')}<span>Ajouter une image</span><input type="file" accept="image/*" data-file aria-label="Ajouter une image"></label>`;
          const f = $('[data-file]'); if (f) f.onchange = e => readImage(e.target.files[0], url => { draft.img = url; paint(); });
          const rm = $('[data-rm]'); if (rm) rm.onclick = () => { draft.img = ''; paint(); };
        };
        paint();
        $$('[data-a]').forEach(b => b.addEventListener('click', () => { draft.a = b.dataset.a; $$('[data-a]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); }));
        $('#msg').addEventListener('input', e => { draft.text = e.target.value; $('[data-count]').textContent = `${e.target.value.length}/160`; $('[data-f-msg] .field__err').hidden = true; paint(); });
        $('[data-email]').addEventListener('change', e => { draft.email = e.target.checked; });
        $('[data-form]').addEventListener('submit', async e => {
          e.preventDefault();
          if (!draft.text.trim()) { $('[data-f-msg] .field__err').hidden = false; $('#msg').focus(); return; }
          const a = aud.find(x => x.k === draft.a);
          const ok = await confirmSheet({ title: `Envoyer à ${num(a.n)} clients ?`, text: `« ${draft.text.trim()} » s'affichera sur leur téléphone${draft.email ? ' et sera aussi envoyé par e-mail' : ''}.`, ok: 'Envoyer' });
          if (!ok) return;
          state.sent.unshift({ text: draft.text.trim(), audience: a.label, count: a.n, ago: 'maintenant', opened: null });
          save();
          toast(`Notification envoyée à ${num(a.n)} clients`);
          render();
        });
      }
    };
  };

  // STATISTIQUES
  pages.statistiques = () => {
    let per = '30j';
    const names = { '7j': '7 jours', '30j': '30 jours', '12m': '12 mois' };
    const kpis = p => `
      ${kpi('users', 'Visites totales', num(p.visits), p.visitsDelta, 'vs période précédente')}
      ${kpi('heart', 'Clients actifs', num(p.active), p.activeDelta, 'vs période précédente')}
      ${kpi('gift', 'Récompenses débloquées', num(p.rewards), p.rewardsDelta, 'vs période précédente')}
      ${kpi('chart', 'Taux de retour', p.returnRate + ' %', p.returnDelta, 'vs période précédente')}`;
    const top = [...state.clients].sort((a, b) => b.visits - a.visits)[0];
    return {
      title: 'Statistiques',
      html: `
        <div class="page-head"><div><h1>Statistiques</h1><p>Suivez les performances de votre programme de fidélité.</p></div></div>
        <div class="seg" role="group" aria-label="Période" style="max-width:24rem;margin-bottom:1rem">${Object.entries(names).map(([k, v]) => `<button type="button" data-p="${k}" aria-pressed="${k === per}">${v}</button>`).join('')}</div>
        <section class="kpis" data-kpis aria-label="Indicateurs de la période">${kpis(DEMO.periods[per])}</section>
        <div class="stats-grid" style="margin-top:1.25rem">
          <section class="card chart-card" aria-labelledby="c-bars">
            <div class="chart-card__head"><h2 class="chart-card__title" id="c-bars">${ico('trend')}<span data-ct>Visites sur 30 jours</span></h2></div>
            <div class="chart" data-chart aria-label="Visites sur la période"></div>
          </section>
          <div class="stack">
            <a class="card row" href="#/clients/${top.id}" style="border-radius:var(--r-card);border:1px solid var(--d-line)">
              <span class="trophy">${ico('trophy')}</span>
              <span class="row__main"><small>Client le plus fidèle</small><strong style="font-size:1.15rem;font-weight:700">${esc(top.name)}</strong><small>${plural(top.visits, 'visite', 'visites')} au total</small></span>
              <span class="row__end">${ico('chev')}</span>
            </a>
            <section class="card card--flush" aria-labelledby="t-top">
              <h2 class="section-title" id="t-top" style="padding:1.1rem 1.1rem 0">Récompenses les plus utilisées</h2>
              <ol class="list">
                ${state.rewards.filter(r => r.active).slice(0, 3).map((r, i) => `<li class="row">${rewardImg(r, 'width:3rem;border-radius:10px')}<span class="row__main"><strong>${esc(r.name)}</strong><small>${plural(r.visits, 'visite', 'visites')}</small></span><span class="row__end"><strong style="color:var(--c-ink);font-size:1rem">${[38, 17, 7][i] ?? 0}</strong>&nbsp;utilisées</span></li>`).join('')}
              </ol>
            </section>
          </div>
        </div>`,
      mount() {
        let stop = () => {};
        const paint = () => {
          const p = DEMO.periods[per];
          $('[data-kpis]').innerHTML = kpis(p);
          $('[data-ct]').textContent = `Visites sur ${names[per]}`;
          const host = $('[data-chart]');
          host.setAttribute('aria-label', `Visites ${p.unit === 'month' ? 'par mois' : 'par jour'} sur les ${names[per]}`);
          stop();
          stop = chart(host, { type: 'bar', points: p.points, unit: 'visites',
            fmtX: p.unit === 'month' ? fmtMonth : (per === '7j' ? d => cap(new Date(d).toLocaleDateString('fr-FR', { weekday: 'short' })) : fmtDay),
            fmtTip: p.unit === 'month' ? fmtMonthLong : fmtDayLong });
        };
        paint();
        cleanup.push(() => stop());
        $$('[data-p]').forEach(b => b.addEventListener('click', () => { per = b.dataset.p; $$('[data-p]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); paint(); }));
      }
    };
  };

  // PARAMÈTRES
  pages.parametres = () => {
    const item = (href, icon, title, sub, ok) => `
      <li><a class="row" href="${href}"${href.startsWith('#') ? '' : ' data-soon'}>
        <span class="set-icon${ok ? ' set-icon--ok' : ''}">${ico(icon)}</span>
        <span class="row__main"><strong>${title}</strong><small>${sub}</small></span>
        <span class="row__end">${ico('chev')}</span></a></li>`;
    return {
      title: 'Paramètres',
      html: `
        <div class="page-head"><h1>Paramètres</h1></div>
        <div class="grid" style="max-width:44rem">
          <section class="card card--flush"><ul class="list">
            ${item('#/parametres/etablissement', 'store', "Informations de l'établissement", 'Nom, adresse, catégorie…')}
            ${item('#/parametres/carte', 'card', 'Ma carte de fidélité', 'Apparence, visites, récompense…')}
            ${item('#/recompenses', 'gift', 'Récompenses', 'Gérer vos offres et avantages', true)}
            ${item('#/notifications', 'bell', 'Notifications clients', 'Messages, rappels, nouveautés')}
            ${item('#/parametres/integrations', 'link', 'Intégrations', 'Apple Wallet, Google Wallet, présentoir', true)}
            ${item('soon:equipe', 'team', 'Équipe', 'Gérer les accès')}
            ${item('soon:aide', 'help', 'Aide & support', "Centre d'aide, nous contacter", true)}
          </ul></section>
          <section class="card card--flush"><ul class="list">
            <li><a class="row" href="../index.html" target="_blank" rel="noopener"><span class="set-icon">${ico('arrow')}</span><span class="row__main"><strong>Voir le site Taply</strong><small>Ouvre un nouvel onglet</small></span></a></li>
            <li><button class="row" type="button" data-reset><span class="set-icon">${ico('reset')}</span><span class="row__main"><strong>Réinitialiser la démo</strong><small>Remet les données d'exemple</small></span></button></li>
            <li><a class="row" href="../connexion.html"><span class="set-icon">${ico('logout')}</span><span class="row__main"><strong>Se déconnecter</strong></span></a></li>
          </ul></section>
        </div>`,
      mount() {
        $$('[data-soon]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); toast('Bientôt disponible dans votre espace'); }));
        $('[data-reset]').addEventListener('click', async () => {
          if (!(await confirmSheet({ title: 'Réinitialiser la démo ?', text: 'Vos modifications (récompenses, visites, messages) seront remplacées par les données d’exemple.', ok: 'Réinitialiser' }))) return;
          try { localStorage.removeItem(KEY); } catch (_) {}
          state = fresh(); chrome(); render(); toast('Démo réinitialisée');
        });
      }
    };
  };

  // MON ÉTABLISSEMENT
  pages.etablissement = () => {
    const m = state.merchant;
    const cats = ['Café', 'Boulangerie', 'Restaurant / Brunch', 'Salon', 'Boutique', 'Autre'];
    let logo = m.logo;
    return {
      title: 'Mon établissement', nav: 'parametres',
      html: `
        <a class="back" href="#/parametres">${ico('back')}Paramètres</a>
        <div class="page-head"><div><h1>Mon établissement</h1><p>Personnalisez les informations de votre établissement qui apparaissent sur Taply.</p></div></div>
        <form class="card stack" data-form novalidate style="max-width:44rem">
          <div class="photo-pick">
            <span class="hello__logo" style="width:6.5rem;height:6.5rem" data-logo><img src="${esc(logo)}" alt="Logo actuel"></span>
            <label class="file-btn">${ico('camera')}Changer le logo<input type="file" accept="image/*" data-file></label>
          </div>
          <div class="form-grid">
            <div class="field" data-f-name><label for="sn">Nom de l'établissement</label><input class="input" id="sn" value="${esc(m.name)}" maxlength="40" required><p class="field__err" hidden>Le nom est obligatoire.</p></div>
            <div class="field"><label for="sc">Catégorie</label><select class="select" id="sc">${cats.map(c => `<option${c === m.category ? ' selected' : ''}>${c}</option>`).join('')}</select></div>
            <div class="field full"><label for="sa">Adresse</label><input class="input" id="sa" value="${esc(m.address)}" autocomplete="street-address"></div>
            <div class="field full"><label for="sd">Description</label><textarea class="textarea" id="sd" maxlength="160">${esc(m.description)}</textarea><span class="field__count" data-count>${m.description.length}/160</span></div>
          </div>
          <button class="btn btn--brand" type="submit" style="justify-self:start">Enregistrer ${ico('check')}</button>
        </form>`,
      mount() {
        $('[data-file]').addEventListener('change', e => readImage(e.target.files[0], url => { logo = url; $('[data-logo]').innerHTML = `<img src="${esc(url)}" alt="Nouveau logo" style="width:100%;height:100%;object-fit:cover">`; }));
        $('#sd').addEventListener('input', e => { $('[data-count]').textContent = `${e.target.value.length}/160`; });
        $('[data-form]').addEventListener('submit', e => {
          e.preventDefault();
          const name = $('#sn').value.trim();
          if (!name) { $('[data-f-name] .field__err').hidden = false; $('#sn').focus(); return; }
          Object.assign(m, { name, category: $('#sc').value, address: $('#sa').value.trim(), description: $('#sd').value, logo });
          const city = m.address.match(/\d{5}\s+(.+)$/); if (city) m.city = `${city[1]}, France`;
          save(); chrome(); toast('Informations enregistrées');
        });
      }
    };
  };

  // MA CARTE
  pages.carte = () => {
    const m = state.merchant;
    const draft = { ...m.card };
    const themes = { creme: '#FFEEDC', terracotta: '#F3D9C7', brun: '#42200C', taply: '#0E1D16' };
    return {
      title: 'Ma carte de fidélité', nav: 'parametres',
      html: `
        <a class="back" href="#/parametres">${ico('back')}Paramètres</a>
        <div class="page-head"><div><h1>Ma carte de fidélité</h1><p>Ce que vos clients voient dans leur Wallet.</p></div></div>
        <div class="form-grid">
          <div class="stack"><div data-preview></div><p class="muted" style="font-size:.9rem">Aperçu avec un client à 4 visites.</p></div>
          <form class="card stack" data-form>
            <div class="field"><span class="label" id="cv-l">Visites pour obtenir la récompense</span>
              <div class="stepper" role="group" aria-labelledby="cv-l"><output data-v aria-live="polite"></output>
                <button type="button" data-step="-1" aria-label="Une visite de moins">${ico('minus')}</button>
                <button type="button" data-step="1" aria-label="Une visite de plus">${ico('plus')}</button></div></div>
            <div class="field"><label for="cr">Récompense</label><input class="input" id="cr" value="${esc(draft.reward)}" maxlength="30"></div>
            <fieldset class="field" style="border:0;padding:0;margin:0"><legend class="label" style="margin-bottom:.45rem">Couleur de la carte</legend>
              <div class="swatches">${Object.entries(themes).map(([k, c]) => `<label><input type="radio" name="th" value="${k}" ${k === draft.theme ? 'checked' : ''} aria-label="${cap(k)}"><span style="background:${c}"></span></label>`).join('')}</div>
            </fieldset>
            <button class="btn btn--brand" type="submit" style="justify-self:start">Enregistrer ${ico('check')}</button>
          </form>
        </div>`,
      mount() {
        const paint = () => {
          $('[data-v]').textContent = plural(draft.visits, 'visite', 'visites');
          $('[data-step="-1"]').disabled = draft.visits <= 3;
          $('[data-step="1"]').disabled = draft.visits >= 15;
          $('[data-preview]').innerHTML = loyaltyCard({ filled: 4, total: draft.visits, theme: draft.theme, reward: draft.reward });
        };
        paint();
        $$('[data-step]').forEach(b => b.addEventListener('click', () => { draft.visits = Math.max(3, Math.min(15, draft.visits + +b.dataset.step)); paint(); }));
        $('#cr').addEventListener('input', e => { draft.reward = e.target.value.trim() || '1 café offert'; paint(); });
        $$('input[name="th"]').forEach(r => r.addEventListener('change', () => { draft.theme = r.value; paint(); }));
        $('[data-form]').addEventListener('submit', e => { e.preventDefault(); m.card = { ...draft }; save(); toast('Carte mise à jour'); });
      }
    };
  };

  // INTÉGRATIONS
  pages.integrations = () => ({
    title: 'Intégrations', nav: 'parametres',
    html: `
      <a class="back" href="#/parametres">${ico('back')}Paramètres</a>
      <div class="page-head"><div><h1>Intégrations</h1><p>Où vos clients retrouvent leur carte.</p></div></div>
      <section class="card card--flush" style="max-width:44rem"><ul class="list">
        <li class="row"><span class="set-icon set-icon--ok">${ico('wallet')}</span><span class="row__main"><strong>Apple Wallet</strong><small>Cartes ajoutées automatiquement après inscription</small></span><span class="row__end"><span class="badge">Connecté</span></span></li>
        <li class="row"><span class="set-icon set-icon--ok">${ico('wallet')}</span><span class="row__main"><strong>Google Wallet</strong><small>Pour les clients sur Android</small></span><span class="row__end"><span class="badge">Connecté</span></span></li>
        <li class="row"><span class="set-icon set-icon--ok">${ico('nfc')}</span><span class="row__main"><strong>Présentoir Taply (NFC)</strong><small>Dernière connexion ${esc(state.merchant.nfc.lastSeen)}</small></span><span class="row__end"><span class="badge"><i class="dot dot--ok" aria-hidden="true"></i>${esc(state.merchant.nfc.status)}</span></span></li>
      </ul></section>`
  });

  pages.notfound = () => ({ title: 'Page introuvable', html: `<div class="empty stack" style="justify-items:center"><h1>Page introuvable</h1><a class="btn btn--brand" href="#/accueil">Retour à l'accueil</a></div>` });

  /* ---- Routage --------------------------------------------------------- */
  const routes = [
    [/^accueil$/, () => pages.accueil(), 'accueil'],
    [/^clients$/, () => pages.clients(), 'clients'],
    [/^clients\/([\w-]+)$/, id => pages.client(id), 'clients'],
    [/^recompenses$/, () => pages.recompenses(), 'recompenses'],
    [/^recompenses\/nouvelle$/, () => pages.nouvelle(), 'recompenses'],
    [/^notifications$/, () => pages.notifications(), 'notifications'],
    [/^statistiques$/, () => pages.statistiques(), 'statistiques'],
    [/^parametres$/, () => pages.parametres(), 'parametres'],
    [/^parametres\/etablissement$/, () => pages.etablissement(), 'parametres'],
    [/^parametres\/carte$/, () => pages.carte(), 'parametres'],
    [/^parametres\/integrations$/, () => pages.integrations(), 'parametres']
  ];

  let lastPath = null;
  function render() {
    const path = location.hash.replace(/^#\/?/, '') || 'accueil';
    let page, nav = '';
    for (const [re, fn, n] of routes) {
      const mt = path.match(re);
      if (mt) { page = fn(mt[1]); nav = n; break; }
    }
    if (!page) { page = pages.notfound(); }
    cleanup.forEach(f => f && f()); cleanup = [];
    view.innerHTML = page.html;
    page.mount && page.mount();

    document.title = `${page.title} — Taply`;
    $('[data-crumb]').textContent = `Espace commerçant · ${page.title}`;
    $$('[data-nav]').forEach(a => {
      if (a.dataset.nav.split(' ').includes(nav)) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    if (path !== lastPath) {
      scrollTo({ top: 0, behavior: 'instant' });
      if (lastPath !== null) view.focus({ preventScroll: true });
      lastPath = path;
    }
  }

  // En-tête & barre latérale aux couleurs du commerce
  function chrome() {
    const m = state.merchant;
    $$('[data-merchant-name]').forEach(e => { e.textContent = m.name; });
    $$('[data-merchant-city]').forEach(e => { e.textContent = m.city; });
    $$('[data-merchant-logo]').forEach(e => { e.innerHTML = `<img src="${esc(m.logo)}" alt="">`; });
    $$('[data-merchant-initial]').forEach(e => { e.textContent = m.name.charAt(0).toUpperCase(); });
    $$('[data-nfc-status]').forEach(e => { e.textContent = m.nfc.status; });
  }

  chrome();
  addEventListener('hashchange', render);
  if (!location.hash) history.replaceState(null, '', '#/accueil');
  render();
})();
