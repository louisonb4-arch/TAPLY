/* Taply — espace commerçant (données réelles uniquement).
 * Toutes les données viennent des routes API authentifiées (cookie HttpOnly).
 * Aucune donnée inventée, aucun jeton/PIN/session dans le stockage du navigateur.
 * Une fonction non disponible est annoncée comme telle, jamais simulée.
 */
(() => {
  'use strict';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const view = $('#view');
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = new Intl.NumberFormat('fr-FR');
  const num = (n) => nf.format(n ?? 0);
  const ico = (id, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#d-${id}"/></svg>`;
  const plural = (n, one, many) => `${num(n)} ${n > 1 ? many : one}`;
  const fmt = (v) => v ? new Date(v).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
  const fmtDate = (v) => v ? new Date(v).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
  const fmtTime = (v) => v ? new Date(v).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—';
  const ago = (v) => {
    if (!v) return '—';
    const m = Math.round((Date.now() - new Date(v).getTime()) / 60000);
    return m < 1 ? "À l'instant" : m < 60 ? `Il y a ${m} min` : m < 1440 ? `Il y a ${Math.round(m / 60)} h` : `Il y a ${Math.round(m / 1440)} j`;
  };
  const uuid = () => crypto.randomUUID();
  const route = () => location.hash.replace(/^#\/?/, '') || 'accueil';

  const s = {
    me: null, dash: null, setup: null, error: null,
    cache: {}, scan: { stream: null, raf: 0, card: null, token: null, keys: {} }, unlockedUntil: 0,
  };

  /* ---- API ------------------------------------------------------------- */
  async function api(path, body, method = 'POST') {
    const options = { credentials: 'same-origin', cache: 'no-store' };
    if (body !== undefined) {
      options.method = method;
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(body);
    }
    const res = await fetch('/api/' + path, options);
    if (res.status === 401) {
      location.replace('../connexion.html');
      throw new Error('Session expirée.');
    }
    let data = null;
    try { data = await res.json(); } catch (_) { /* corps vide */ }
    if (!res.ok && !(data && (res.status === 409 || res.status === 422 || res.status === 402 || res.status === 404))) {
      const err = new Error(data?.error?.message || (res.status === 503 ? 'Service non activé sur cet environnement.' : 'Opération impossible. Réessayez.'));
      err.status = res.status;
      throw err;
    }
    if (data && typeof data === 'object') data._status = res.status;
    return data;
  }

  /* ---- Composants ------------------------------------------------------ */
  function toast(msg, kind = 'ok') {
    const host = $('[data-toasts]');
    const t = document.createElement('div');
    t.className = 'toast' + (kind === 'error' ? ' toast--error' : '');
    t.innerHTML = ico(kind === 'error' ? 'x' : 'check');
    t.append(document.createTextNode(msg));
    host.append(t);
    setTimeout(() => { t.classList.add('is-out'); setTimeout(() => t.remove(), 300); }, 3600);
  }
  function confirmSheet({ title, text, ok }) {
    const d = $('[data-sheet]');
    $('[data-sheet-title]', d).textContent = title;
    $('[data-sheet-text]', d).textContent = text;
    $('[data-sheet-ok]', d).textContent = ok;
    return new Promise((resolve) => {
      d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true });
      d.returnValue = '';
      d.showModal();
    });
  }
  const head = (title, sub, actions = '') => `<div class="page-head"><div><h1>${esc(title)}</h1>${sub ? `<p>${esc(sub)}</p>` : ''}</div>${actions ? `<div class="page-head__actions">${actions}</div>` : ''}</div>`;
  const panel = (title, body, extra = '') => `<section class="card panel"${extra}><h2 class="panel__title">${esc(title)}</h2>${body}</section>`;
  const note = (text, kind = '') => `<p class="note${kind ? ' note--' + kind : ''}">${text}</p>`;
  const link = (text, r, cls = 'btn btn--ghost btn--sm') => `<a class="${cls}" href="#/${r}">${esc(text)} ${ico('arrow')}</a>`;
  const kpi = (icon, label, value, sub) => `<div class="card kpi"><span class="kpi__icon">${ico(icon)}</span>
    <span class="kpi__label">${esc(label)}</span><span class="kpi__value">${esc(value)}</span><span class="kpi__sub">${esc(sub)}</span></div>`;

  function luminance(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return 0;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
      .map((c) => (c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4));
    return .2126 * r + .7152 * g + .0722 * b;
  }
  function applyBrand(color) {
    const root = document.documentElement.style;
    const usable = /^#[0-9a-f]{6}$/i.test(color || '') && luminance(color) < .35;
    root.setProperty('--brand', usable ? color : '#0B1712');
    root.setProperty('--brand-hover', usable ? color : '#13241C');
  }

  function cardPreview({ name, threshold, filled = 0, reward, bg, fg, foot }) {
    const total = Math.max(3, Math.min(10, threshold || 5));
    const stamps = Array.from({ length: total }, (_, i) => `<i class="${i < filled ? 'on' : ''}"></i>`).join('');
    return `<div class="lc" data-theme="custom" style="--card-bg:${esc(bg || '#10241A')};--card-fg:${esc(fg || '#FFFFFF')}" role="img"
      aria-label="Carte de fidélité ${esc(name)} : ${filled} passages sur ${total}">
      <div class="lc__head"><strong class="lc__name">${esc(name)}</strong><span class="lc__kind">Carte fidélité</span></div>
      <div class="lc__stamps">${stamps}</div>
      <div class="lc__foot"><strong>${filled} / ${total} passages</strong><span>${esc(foot ?? (reward ? 'Puis : ' + reward : ''))}</span></div>
    </div>`;
  }

  function chart(host, points) {
    if (!host || !points.length) return;
    const draw = () => {
      const W = host.clientWidth, H = host.clientHeight;
      if (!W) return;
      const m = { l: 30, r: 8, t: 10, b: 24 };
      const iw = W - m.l - m.r, ih = H - m.t - m.b;
      const maxV = Math.max(4, ...points.map((p) => p.visits));
      const step = Math.ceil(maxV / 4);
      const max = step * 4;
      const n = points.length;
      const x = (i) => m.l + (n === 1 ? iw / 2 : (iw * i) / (n - 1));
      const y = (v) => m.t + ih - (v / max) * ih;
      let svg = `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">`;
      for (let v = 0; v <= max; v += step) {
        svg += `<line class="${v ? 'grid-line' : 'base-line'}" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
        svg += `<text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
      }
      points.forEach((p, i) => {
        if (i % Math.max(1, Math.ceil(n / (W < 480 ? 4 : 7))) === 0) {
          const d = new Date(p.day + 'T12:00');
          svg += `<text x="${x(i)}" y="${H - 5}" text-anchor="middle">${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}</text>`;
        }
      });
      const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.visits).toFixed(1)}`).join('');
      svg += `<defs><linearGradient id="vg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#2F8A1F" stop-opacity=".22"/><stop offset="1" stop-color="#2F8A1F" stop-opacity="0"/></linearGradient></defs>`;
      svg += `<path fill="url(#vg)" d="${line}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z"/><path class="line" d="${line}"/>`;
      points.forEach((p, i) => { if (p.visits) svg += `<circle cx="${x(i)}" cy="${y(p.visits)}" r="3" fill="#2F8A1F"/>`; });
      host.innerHTML = svg + '</svg>';
    };
    draw();
    const table = `<table class="sr-only"><caption>Passages par jour</caption><tbody>${points.map((p) => `<tr><td>${esc(p.day)}</td><td>${p.visits}</td></tr>`).join('')}</tbody></table>`;
    host.insertAdjacentHTML('afterend', table);
    new ResizeObserver(draw).observe(host);
  }

  /* ---- Chargement ------------------------------------------------------ */
  async function load() {
    s.me = await api('auth/me');
    const [dash, setup] = await Promise.allSettled([
      api('loyalty/dashboard'),
      s.me.role === 'owner' ? api('loyalty/setup') : Promise.resolve(null),
    ]);
    s.dash = dash.status === 'fulfilled' ? dash.value : null;
    s.setup = setup.status === 'fulfilled' ? setup.value : null;
    s.error = dash.status === 'rejected' ? dash.reason.message : null;
    applyBrand(s.setup?.cardColor);
  }
  async function refresh() { s.cache = {}; await load(); render(); }
  async function cached(key, path) {
    if (!s.cache[key]) s.cache[key] = await api(path);
    return s.cache[key];
  }

  /* ---- Bandeaux --------------------------------------------------------- */
  function billingBanner() {
    const b = s.dash?.billing;
    if (!b) return '';
    if (b.mode === 'disabled') return note(`${ico('help')} Préproduction : la facturation Stripe n’est pas appliquée sur cet environnement.`, 'info');
    if (b.level === 'full') return b.cancelAtPeriodEnd ? note(`Votre abonnement se termine le ${fmtDate(b.currentPeriodEnd)}. ${link('Gérer', 'abonnement', 'link')}`, 'warn') : '';
    if (b.level === 'grace') return note(`Paiement en échec : mettez à jour votre moyen de paiement pour éviter l’interruption. ${link('Régulariser', 'abonnement', 'link')}`, 'warn');
    if (b.level === 'setup_only') return note(`Activez votre abonnement (20 € / mois) pour publier votre carte et valider des passages. ${link('S’abonner', 'abonnement', 'link')}`, 'warn');
    return note(`Abonnement inactif : votre espace est en lecture seule. Les cartes de vos clients restent consultables. ${link('Réactiver', 'abonnement', 'link')}`, 'danger');
  }

  /* ---- Accueil ---------------------------------------------------------- */
  function home() {
    if (!s.dash) return head('Accueil', '') + panel('Données indisponibles', note(esc(s.error || 'Réessayez dans un instant.')));
    const st = s.dash.stats;
    const setup = s.setup;
    const billingOk = ['full', 'grace'].includes(s.dash.billing.level);
    const steps = [
      { done: billingOk, title: 'Activer l’abonnement', detail: '20 € / mois, sans engagement', r: 'abonnement' },
      { done: Boolean(setup && setup.rewards.length && setup.threshold), title: 'Définir la fidélité', detail: 'Passages et récompenses', r: 'demarrage' },
      { done: Boolean(setup?.published), title: 'Publier et afficher le QR', detail: 'Vos clients obtiennent leur carte en le scannant', r: 'demarrage' },
      { done: st.visits > 0, title: 'Valider un premier passage', detail: 'Scanner le QR personnel d’un client', r: 'scanner' },
    ];
    const done = steps.filter((x) => x.done).length;
    const checklist = done === steps.length ? '' : `<section class="card panel" aria-labelledby="onb">
      <div class="section-title"><h2 id="onb" class="panel__title">Démarrage</h2><strong>${done} / ${steps.length}</strong></div>
      <progress class="progress" value="${done}" max="${steps.length}"></progress>
      <ul class="list">${steps.map((x) => `<li class="row">
        <span class="check${x.done ? ' check--on' : ''}" aria-label="${x.done ? 'Terminé' : 'À faire'}">${x.done ? ico('check') : ''}</span>
        <span class="row__main"><strong>${esc(x.title)}</strong><small>${esc(x.detail)}</small></span>
        <span class="row__end">${x.done ? 'Fait' : link('Commencer', x.r)}</span></li>`).join('')}</ul></section>`;
    const activity = s.dash.recentActivity.map((a) => `<li class="row">
      <span class="avatar avatar--code" aria-hidden="true">${esc(a.card.slice(0, 2))}</span>
      <span class="row__main"><strong>Carte ${esc(a.card)}</strong><small>${{
        visit_qr: 'Passage validé au comptoir', visit_nfc: 'Passage NFC automatique', reward: 'Récompense remise : ' + (a.detail || ''), card: 'Nouvelle carte',
      }[a.kind] || esc(a.kind)}</small></span><span class="row__end">${esc(ago(a.at))}</span></li>`).join('');
    const total14 = s.dash.visitsByDay.reduce((a, p) => a + p.visits, 0);
    const name = s.dash.merchant?.name || 'votre commerce';
    return `<div class="hello"><span class="hello__logo hello__logo--initial" aria-hidden="true">${esc(name.slice(0, 1).toUpperCase())}</span>
        <div><h1>Bonjour ${esc(name)}</h1><p>${esc(new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }))}</p></div></div>
      ${billingBanner()}${checklist}
      <section class="kpis" aria-label="Indicateurs">
        ${kpi('users', 'Cartes actives', num(st.activeCards30d), `${plural(st.cards, 'carte', 'cartes')} au total`)}
        ${kpi('check', 'Passages (30 j)', num(st.visits30d), `${plural(st.visits, 'passage', 'passages')} au total`)}
        ${kpi('gift', 'Récompenses à remettre', num(st.rewardsUnlocked - st.rewardsHandedOver), `${num(st.rewardsAwaitingChoice)} en attente du choix client`)}
        ${kpi('trophy', 'Récompenses remises', num(st.rewardsHandedOver), `${plural(st.rewardsUnlocked, 'obtenue', 'obtenues')} au total`)}
      </section>
      <div class="home-grid" style="margin-top:1.25rem">
        <section class="card chart-card"><div class="chart-card__head"><h2 class="chart-card__title">${ico('trend')}Passages sur 14 jours</h2>
          <p class="chart-card__total"><small>Total</small><strong>${num(total14)}</strong></p></div>
          <div class="chart" data-chart aria-label="Passages par jour sur 14 jours"></div></section>
        <div class="mini-cards">
          <a class="card mini" href="#/carte"><span class="mini__icon">${ico('card')}</span><small>Programme</small>
            <strong>${setup?.threshold ? `${setup.threshold} passages = ${esc(setup.rewards.map((r) => r.title).join(' ou '))}` : 'À configurer'}</strong>
            <span class="link">Voir ma carte ${ico('arrow')}</span></a>
          <a class="card mini" href="#/supports"><span class="mini__icon">${ico('nfc')}</span><small>QR & présentoirs NFC</small>
            <strong>${setup?.published ? 'QR commerçant actif' : 'QR non publié'}</strong>
            <small>${setup ? plural(setup.activeNfcTags, 'puce NFC active', 'puces NFC actives') : ''}</small></a>
          <a class="card mini" href="#/scanner" style="grid-column:1/-1"><span class="mini__icon">${ico('camera')}</span><small>Comptoir</small>
            <strong>Scanner une carte client</strong><span class="link">Ouvrir le scanner ${ico('arrow')}</span></a>
        </div>
        <section class="card card--flush span-2"><div class="section-title" style="padding:1.1rem 1.1rem 0"><h2 style="font-size:inherit">Activité récente</h2>${link('Clients', 'clients', 'link')}</div>
          <ul class="list">${activity || '<li class="empty">Aucune activité pour le moment. Les cartes, passages et récompenses apparaîtront ici.</li>'}</ul></section>
      </div>`;
  }

  /* ---- Démarrage (onboarding en 5 étapes) ------------------------------ */
  const wizard = { step: 1, draft: null };
  const PALETTE = ['#10241A', '#0B1712', '#42200C', '#1F3A5F', '#5B1E3A', '#8A3B12', '#2E4A2E', '#3A3A3A'];
  function draftFromSetup() {
    const x = s.setup;
    return {
      merchantName: s.dash?.merchant?.name || x.merchantName, city: s.dash?.merchant?.city || '',
      threshold: x.threshold || 5, rewards: x.rewards.length ? x.rewards.map((r) => r.title) : [''],
      rewardTerms: x.rewardTerms || `Un passage est validé par achat, au comptoir. Deux passages sont séparés d’au moins 2 heures. La récompense est offerte une fois par carte complétée et n’est pas échangeable contre de l’argent.`,
      cardColor: x.cardColor, textColor: x.textColor,
      notify: x.preferences.notifyRewardUnlocked,
    };
  }
  function onboarding() {
    if (!s.setup) return head('Créer ma carte', '') + panel('Configuration indisponible', note('Seul le propriétaire du commerce peut configurer le programme.'));
    if (!wizard.draft) wizard.draft = draftFromSetup();
    const d = wizard.draft;
    const published = s.setup.published;
    const labels = ['Commerce', 'Fidélité', 'Apparence', 'Options', 'Publication'];
    const nav = `<ol class="wizard" aria-label="Étapes">${labels.map((l, i) => `<li${i + 1 === wizard.step ? ' aria-current="step"' : ''}${i + 1 < wizard.step ? ' class="is-done"' : ''}><button type="button" data-step="${i + 1}" ${published && i < 4 ? '' : ''}><span>${i + 1}</span>${l}</button></li>`).join('')}</ol>`;
    let body = '';
    if (wizard.step === 1) {
      body = panel('Votre commerce', `<p class="muted">Ces informations apparaissent sur la carte de vos clients. Modifiables à tout moment.</p>
        <form data-form="w1" class="grid"><div class="field"><label for="w-name">Nom affiché</label><input class="input" id="w-name" name="merchantName" maxlength="80" required value="${esc(d.merchantName)}"></div>
        <div class="field"><label for="w-city">Ville (facultatif)</label><input class="input" id="w-city" name="city" maxlength="80" value="${esc(d.city)}"></div>
        <div class="wizard__actions"><button class="btn btn--brand" type="submit">Continuer ${ico('arrow')}</button></div></form>`);
    } else if (wizard.step === 2) {
      body = panel('Votre programme de fidélité', published
        ? note(`Programme publié le ${fmtDate(s.setup.publishedAt)}. Les conditions se modifient depuis ${link('Ma carte', 'carte', 'link')} (au plus une fois tous les 30 jours).`, 'info')
        : `<form data-form="w2" class="grid">
          <div class="field"><span class="label">Nombre de passages pour une récompense</span>
            <div class="seg seg--wrap" role="group" aria-label="Nombre de passages">${[3, 4, 5, 6, 7, 8, 9, 10].map((n) => `<button type="button" data-threshold="${n}" aria-pressed="${n === d.threshold}">${n}</button>`).join('')}</div></div>
          <div class="field"><span class="label">Récompenses proposées (le client choisit)</span>
            <div class="rewards-edit" data-rewards>${d.rewards.map((r, i) => `<div class="rewards-edit__row"><input class="input" name="reward" maxlength="120" placeholder="Ex. : un café offert" value="${esc(r)}" required aria-label="Récompense ${i + 1}">${d.rewards.length > 1 ? `<button type="button" class="icon-btn" data-remove-reward="${i}" aria-label="Retirer">${ico('x')}</button>` : ''}</div>`).join('')}</div>
            ${d.rewards.length < 5 ? `<button type="button" class="btn btn--ghost btn--sm" data-add-reward>${ico('plus')} Ajouter une récompense</button>` : ''}</div>
          <div class="field"><label for="w-terms">Conditions affichées au client</label><textarea class="textarea" id="w-terms" name="rewardTerms" rows="4" maxlength="2000">${esc(d.rewardTerms)}</textarea></div>
          ${note('Après publication, le nombre de passages et les récompenses ne peuvent changer qu’une fois tous les 30 jours. Les clients en cours gardent leurs conditions jusqu’à leur récompense.', 'info')}
          <div class="wizard__actions"><button class="btn btn--ghost" type="button" data-step="1">Retour</button><button class="btn btn--brand" type="submit">Enregistrer et continuer ${ico('arrow')}</button></div></form>`);
    } else if (wizard.step === 3) {
      body = `<div class="split">${panel('Apparence de la carte', `<form data-form="w3" class="grid">
          <div class="field"><span class="label">Couleur de la carte</span><div class="swatches">${PALETTE.map((c) => `<label><input type="radio" name="cardColor" value="${c}" ${c.toLowerCase() === d.cardColor.toLowerCase() ? 'checked' : ''} aria-label="${c}"><span style="background:${c}"></span></label>`).join('')}
            <label class="swatch-custom">Autre <input type="color" name="customColor" value="${esc(d.cardColor)}"></label></div></div>
          <div class="field"><span class="label">Texte</span><div class="seg" role="group" aria-label="Couleur du texte">
            <button type="button" data-text="#FFFFFF" aria-pressed="${d.textColor.toUpperCase() === '#FFFFFF'}">Clair</button>
            <button type="button" data-text="#0B1712" aria-pressed="${d.textColor.toUpperCase() !== '#FFFFFF'}">Foncé</button></div></div>
          <div class="wizard__actions"><button class="btn btn--ghost" type="button" data-step="2">Retour</button><button class="btn btn--brand" type="submit">Enregistrer et continuer ${ico('arrow')}</button></div></form>`)}
        <div class="preview" data-preview>${cardPreview({ name: d.merchantName, threshold: d.threshold, filled: Math.min(2, d.threshold), reward: d.rewards.filter(Boolean).join(' ou '), bg: d.cardColor, fg: d.textColor })}
          <p class="muted">Aperçu : ce que voit le client sur son téléphone.</p></div></div>`;
    } else if (wizard.step === 4) {
      body = panel('Options (facultatives)', `<form data-form="w4" class="grid">
          <label class="toggle-row"><span><strong>Notifier le client quand sa récompense est prête</strong><small>Uniquement s’il l’autorise sur sa carte. L’envoi n’est pas encore actif dans cette version.</small></span>
            <span class="switch"><input type="checkbox" aria-label="Notifier le client quand sa récompense est prête" name="notify" ${d.notify ? 'checked' : ''}><span></span></span></label>
          <div class="toggle-row toggle-row--static"><span><strong>Passage automatique par NFC</strong><small>Activable dans « QR & NFC » une fois vos présentoirs reçus et associés. Le scan du QR personnel reste toujours disponible.</small></span>${ico('nfc')}</div>
          <div class="wizard__actions"><button class="btn btn--ghost" type="button" data-step="3">Retour</button><button class="btn btn--brand" type="submit">Continuer ${ico('arrow')}</button></div></form>`);
    } else {
      const billingOk = ['full', 'grace'].includes(s.setup.billing.level);
      body = panel(published ? 'Votre carte est en ligne' : 'Publier votre carte', published
        ? `<div class="qr-block"><img src="/api/loyalty/setup/qr.svg" alt="QR code de votre commerce" width="220" height="220">
            <div><p>Affichez ce QR au comptoir : vos clients le scannent avec l’appareil photo et obtiennent leur carte, sans application ni inscription.</p>
            <p class="muted">Scanner ce QR ne valide jamais de passage : l’équipe valide au comptoir, ou le présentoir NFC.</p>
            <div class="btn-row"><a class="btn btn--brand" href="/api/loyalty/setup/qr.svg?download=1" download="taply-qr-commerce.svg">${ico('download')} Télécharger le QR</a>${link('Aller au tableau de bord', 'accueil')}</div></div></div>`
        : `<p>Récapitulatif : <strong>${d.threshold} passages</strong> → ${esc(d.rewards.filter(Boolean).join(' ou '))}.</p>
          ${billingOk ? '' : note(`La publication nécessite un abonnement actif. ${link('Activer l’abonnement', 'abonnement', 'link')}`, 'warn')}
          ${note('Vérifiez vos conditions : après publication, elles ne pourront changer qu’une fois tous les 30 jours.', 'info')}
          <div class="wizard__actions"><button class="btn btn--ghost" type="button" data-step="4">Retour</button>
          <button class="btn btn--brand" type="button" data-publish ${billingOk ? '' : 'disabled'}>Publier ma carte</button></div>`);
    }
    return head('Créer ma carte', 'Cinq étapes, environ deux minutes. Vos réglages sont enregistrés à chaque étape.') + nav + body;
  }

  /* ---- Ma carte (programme) ------------------------------------------- */
  function programPage() {
    const x = s.setup;
    if (!x) return head('Ma carte', '') + panel('Indisponible', note('Réservé au propriétaire.'));
    const lock = x.contract;
    const contractForm = !x.published ? note(`Programme en brouillon. ${link('Terminer la configuration', 'demarrage', 'link')}`, 'info')
      : lock.canChangeNow ? `<form data-form="contract" class="grid">
          <div class="field"><span class="label">Passages</span><div class="seg seg--wrap" role="group" aria-label="Passages">${[3, 4, 5, 6, 7, 8, 9, 10].map((n) => `<button type="button" data-cthreshold="${n}" aria-pressed="${n === x.threshold}">${n}</button>`).join('')}</div><input type="hidden" name="threshold" value="${x.threshold}"></div>
          <div class="field"><label for="c-rew">Récompenses (une par ligne, 5 maximum)</label><textarea class="textarea" id="c-rew" name="rewards" rows="4">${esc(x.rewards.map((r) => r.title).join('\n'))}</textarea></div>
          <div class="field"><label for="c-why">Motif (facultatif, visible dans l’historique)</label><input class="input" id="c-why" name="reason" maxlength="200"></div>
          <button class="btn btn--brand" type="submit">Enregistrer une nouvelle version</button></form>`
        : note(`Prochaine modification possible le <strong>${fmtDate(lock.lockedUntil)}</strong> (une modification tous les 30 jours).`, 'info');
    return head('Ma carte', 'Une carte commune à tous vos clients ; chacun a sa propre progression.') + billingBanner() +
      `<div class="split"><div class="preview">${cardPreview({ name: s.dash?.merchant?.name || x.merchantName, threshold: x.threshold, filled: 0, reward: x.rewards.map((r) => r.title).join(' ou '), bg: x.cardColor, fg: x.textColor })}
        <p class="muted">${x.published ? `Publiée le ${fmtDate(x.publishedAt)} · ${plural(x.cardsCount, 'carte client', 'cartes clients')}` : 'Brouillon non publié'}</p></div>
      ${panel('Conditions de fidélité', `<dl class="facts"><div><dt>Passages</dt><dd>${esc(x.threshold)}</dd></div><div><dt>Récompenses</dt><dd>${esc(x.rewards.map((r) => r.title).join(' · ') || '—')}</dd></div>
        <div><dt>Délai entre deux passages</dt><dd>2 heures</dd></div></dl>${contractForm}`)}</div>
      ${panel('Apparence et informations', `<form data-form="appearance" class="grid two">
        <div class="field"><label for="a-name">Nom affiché</label><input class="input" id="a-name" name="merchantName" maxlength="80" required value="${esc(s.dash?.merchant?.name || x.merchantName)}"></div>
        <div class="field"><label for="a-city">Ville</label><input class="input" id="a-city" name="city" maxlength="80" value="${esc(s.dash?.merchant?.city || '')}"></div>
        <div class="field"><label for="a-bg">Couleur de carte</label><input class="input" type="color" id="a-bg" name="cardColor" value="${esc(x.cardColor)}"></div>
        <div class="field"><label for="a-fg">Couleur du texte</label><input class="input" type="color" id="a-fg" name="textColor" value="${esc(x.textColor)}"></div>
        <div class="field span-2"><label for="a-terms">Conditions affichées</label><textarea class="textarea" id="a-terms" name="rewardTerms" rows="3" maxlength="2000">${esc(x.rewardTerms)}</textarea></div>
        <div class="span-2"><button class="btn btn--brand" type="submit">Enregistrer</button></div></form>`)}
      ${panel('Historique des versions', `<ul class="list">${x.versions.map((v) => `<li class="row"><span class="badge${v.active ? ' badge--solid' : ' badge--muted'}">v${v.versionNo}</span>
        <span class="row__main"><strong>${esc(v.threshold)} passages → ${esc(v.rewards.join(' ou ') || '—')}</strong><small>${esc(v.reason || '')}</small></span><span class="row__end">${esc(fmt(v.createdAt))}</span></li>`).join('')}</ul>`)}`;
  }

  /* ---- Clients ---------------------------------------------------------- */
  async function customersPage(q = '') {
    const data = await api('loyalty/customers' + (q ? '?q=' + encodeURIComponent(q) : ''));
    const rows = data.customers.map((c) => `<li><a class="row" href="#/clients/${esc(c.membershipId)}">
      <span class="avatar avatar--code" aria-hidden="true">${esc(c.code.slice(0, 2))}</span>
      <span class="row__main"><strong>Carte ${esc(c.code)}</strong><small>${c.visits} / ${esc(c.threshold ?? '—')} passages · cycle ${c.cycleNumber} · ${plural(c.totalVisits, 'passage', 'passages')} au total</small></span>
      <span class="row__end">${c.rewardPending ? `<span class="badge">${ico('gift')} ${esc(c.chosenReward || 'Récompense prête')}</span>` : ''}<span class="hide-sm">${esc(ago(c.lastVisitAt || c.joinedAt))}</span>${ico('chev')}</span></a></li>`).join('');
    return head('Clients', 'Cartes anonymes : aucun nom, e-mail ni téléphone. Le code correspond à celui affiché sur la carte du client.') +
      `<form class="search" data-form="search" role="search"><label class="sr-only" for="q">Rechercher un code carte</label>${ico('search')}
        <input id="q" name="q" class="input" placeholder="Code carte (ex. 3F9A1C)" value="${esc(q)}" autocomplete="off"></form>
      <section class="card card--flush"><ul class="list">${rows || `<li class="empty">${q ? 'Aucune carte ne correspond.' : 'Aucune carte pour le moment : affichez votre QR au comptoir.'}</li>`}</ul></section>`;
  }
  async function customerDetail(id) {
    const [{ history }, list] = await Promise.all([api(`loyalty/customers/${id}/history`), api('loyalty/customers')]);
    const c = list.customers.find((x) => x.membershipId === id);
    if (!c) return head('Carte introuvable', '') + link('Retour aux clients', 'clients');
    const labels = { visit_qr: 'Passage validé au comptoir', visit_nfc: 'Passage NFC automatique', reward: 'Récompense remise' };
    return `<a class="back" href="#/clients">${ico('back')} Clients</a>` + head('Carte ' + c.code, `Inscrite le ${fmtDate(c.joinedAt)}`) +
      `<div class="split">${cardPreview({ name: s.dash?.merchant?.name || '', threshold: c.threshold, filled: c.visits, reward: c.chosenReward, bg: s.setup?.cardColor, fg: s.setup?.textColor, foot: c.rewardPending ? 'Récompense prête' : `Cycle ${c.cycleNumber}` })}
      ${panel('Historique', `<ul class="list">${history.map((h) => `<li class="row"><span class="hist-icon${h.kind === 'reward' ? ' hist-icon--gift' : ''}">${ico(h.kind === 'reward' ? 'gift' : h.kind === 'visit_nfc' ? 'nfc' : 'check')}</span>
        <span class="row__main"><strong>${esc(labels[h.kind] || h.kind)}${h.detail ? ' · ' + esc(h.detail) : ''}</strong><small>Cycle ${h.cycle}</small></span><span class="row__end">${esc(fmt(h.at))}</span></li>`).join('') || '<li class="empty">Aucun passage.</li>'}</ul>`)}</div>`;
  }

  /* ---- Récompenses ------------------------------------------------------ */
  async function rewardsPage() {
    const r = await api('loyalty/rewards');
    return head('Récompenses', 'Débloquées par vos clients, remises au comptoir après scan de leur carte.') +
      panel('À remettre', `<ul class="list">${r.pending.map((p) => `<li><a class="row" href="#/clients/${esc(p.membershipId)}">
        <span class="hist-icon hist-icon--gift">${ico('gift')}</span><span class="row__main"><strong>Carte ${esc(p.code)}</strong>
        <small>${p.chosenReward ? 'Choix du client : ' + esc(p.chosenReward) : 'Le client n’a pas encore choisi'} · débloquée ${esc(ago(p.unlockedAt))}</small></span>${ico('chev')}</a></li>`).join('') || '<li class="empty">Aucune récompense en attente.</li>'}</ul>
        ${note('Pour remettre : scannez le QR personnel du client dans le Scanner, puis confirmez la remise. Une récompense ne peut être remise qu’une fois.')}`) +
      panel('Remises récentes', `<ul class="list">${r.handedOver.map((h) => `<li class="row"><span class="hist-icon">${ico('check')}</span>
        <span class="row__main"><strong>${esc(h.reward || 'Récompense')}</strong><small>Carte ${esc(h.code)} · cycle ${h.cycle}</small></span><span class="row__end">${esc(fmt(h.at))}</span></li>`).join('') || '<li class="empty">Aucune remise pour le moment.</li>'}</ul>`);
  }

  /* ---- Scanner ---------------------------------------------------------- */
  function scannerPage() {
    const unlocked = s.unlockedUntil > Date.now();
    return head('Scanner', 'Scannez le QR personnel du client. Rien n’est crédité tant que vous ne confirmez pas.') + billingBanner() +
      `<div class="scanner${unlocked ? '' : ' scanner--locked'}">
        <section class="card scanner__cam">
          <div class="cam" data-cam><video playsinline muted data-video></video><div class="cam__frame" aria-hidden="true"></div>
            <p class="cam__hint" data-cam-hint>${unlocked ? 'Caméra arrêtée.' : 'Déverrouillez l’appareil pour scanner.'}</p></div>
          <div class="btn-row">${unlocked ? `<button class="btn btn--brand" type="button" data-cam-start>${ico('camera')} Démarrer la caméra</button>
            <button class="btn btn--ghost" type="button" data-cam-stop hidden>Arrêter</button>` : ''}</div>
          <details class="manual"><summary>Lecteur externe ou saisie manuelle</summary><form data-form="manual" class="grid">
            <input class="input" name="token" placeholder="Code du QR client" autocomplete="off" required><button class="btn btn--ghost btn--sm" type="submit">Lire</button></form></details>
        </section>
        <section class="card scanner__side" data-scan-panel>${unlocked ? scanPanel() : unlockForm()}</section>
      </div>`;
  }
  function unlockForm() {
    return `<h2 class="panel__title">Déverrouiller cet appareil</h2><p class="muted">Code PIN de l’appareil approuvé. Il reste déverrouillé 15 minutes.</p>
      <form data-form="unlock" class="grid"><input class="input" name="pin" type="password" inputmode="numeric" pattern="[0-9]{6,10}" minlength="6" maxlength="10" autocomplete="off" required aria-label="Code PIN">
      <button class="btn btn--brand" type="submit">Déverrouiller</button></form>
      <p class="muted">Appareil pas encore approuvé ? ${link('Approuver cet appareil', 'parametres', 'link')}</p>`;
  }
  function scanPanel() {
    const c = s.scan.card;
    if (!c) return `<h2 class="panel__title">En attente d’un QR</h2><p class="muted">Demandez au client d’afficher sa carte Taply (« Afficher mon QR »). Le QR personnel change à chaque affichage et expire après 15 minutes.</p>`;
    const total = c.threshold || 0;
    const stamps = Array.from({ length: total }, (_, i) => `<i class="${i < c.visits ? 'on' : ''}"></i>`).join('');
    let action = '';
    if (!c.active) action = note('Carte désactivée.', 'danger');
    else if (c.rewardPending) {
      action = c.chosenReward
        ? `<p>Le client a choisi : <strong>${esc(c.chosenReward.title)}</strong></p>`
        : `<div class="field"><span class="label">Récompense remise</span><div class="seg seg--wrap" role="group">${c.rewards.map((r, i) => `<button type="button" data-reward-key="${esc(r.key)}" aria-pressed="${i === 0 && c.rewards.length === 1}">${esc(r.title)}</button>`).join('')}</div></div>`;
      action += `<button class="btn btn--ok btn--block" type="button" data-redeem>${ico('gift')} Confirmer la remise</button>`;
    } else if (c.nextVisitAllowedAt) {
      action = note(`Délai de 2 h : prochain passage possible à <strong>${fmtTime(c.nextVisitAllowedAt)}</strong>.`, 'warn');
    } else {
      action = `<button class="btn btn--ok btn--block" type="button" data-credit>${ico('check')} Achat constaté — valider le passage</button>`;
    }
    return `<div class="scan-card"><p class="scan-card__code">Carte ${esc(c.code)}</p>
      <p class="scan-card__count"><strong>${c.visits}</strong> / ${total} passages</p><div class="lc__stamps lc__stamps--ink">${stamps}</div>
      <p class="muted">Cycle ${c.cycleNumber} · dernier passage ${esc(c.lastVisitAt ? fmt(c.lastVisitAt) : 'aucun')}</p></div>
      ${action}<button class="btn btn--ghost btn--block" type="button" data-scan-reset>Scanner une autre carte</button>`;
  }
  function stopCamera() {
    cancelAnimationFrame(s.scan.raf);
    s.scan.stream?.getTracks().forEach((t) => t.stop());
    s.scan.stream = null;
    const start = $('[data-cam-start]'), stop = $('[data-cam-stop]');
    if (start) start.hidden = false;
    if (stop) stop.hidden = true;
  }
  async function loadJsQR() {
    if (window.jsQR) return window.jsQR;
    await new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      sc.src = 'vendor/jsQR.js';
      sc.onload = resolve; sc.onerror = reject;
      document.head.append(sc);
    });
    return window.jsQR;
  }
  async function startCamera() {
    const video = $('[data-video]'), hint = $('[data-cam-hint]');
    if (!navigator.mediaDevices?.getUserMedia) { hint.textContent = 'Caméra indisponible sur cet appareil : utilisez la saisie manuelle.'; return; }
    try {
      s.scan.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch (err) {
      hint.textContent = err.name === 'NotAllowedError' ? 'Accès à la caméra refusé. Autorisez-la dans les réglages du navigateur.' : 'Caméra indisponible.';
      return;
    }
    video.srcObject = s.scan.stream;
    await video.play();
    hint.textContent = 'Visez le QR du client.';
    $('[data-cam-start]').hidden = true; $('[data-cam-stop]').hidden = false;
    let detector = null;
    if ('BarcodeDetector' in window) {
      try { if ((await window.BarcodeDetector.getSupportedFormats()).includes('qr_code')) detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch (_) { detector = null; }
    }
    const jsQR = detector ? null : await loadJsQR();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let busy = false;
    const tick = async () => {
      if (!s.scan.stream) return;
      if (!busy && video.readyState >= 2) {
        busy = true;
        try {
          let value = null;
          if (detector) value = (await detector.detect(video))[0]?.rawValue || null;
          else {
            const w = Math.min(640, video.videoWidth), h = Math.round(video.videoHeight * (w / video.videoWidth));
            canvas.width = w; canvas.height = h;
            ctx.drawImage(video, 0, 0, w, h);
            value = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' })?.data || null;
          }
          if (value && /^[A-Za-z0-9_-]{43}$/.test(value)) { stopCamera(); navigator.vibrate?.(60); await lookup(value); return; }
          if (value) hint.textContent = 'Ce QR n’est pas une carte Taply personnelle.';
        } finally { busy = false; }
      }
      s.scan.raf = requestAnimationFrame(tick);
    };
    tick();
  }
  async function lookup(token) {
    const res = await api('loyalty/card/lookup', { qrToken: token });
    if (res._status === 404) { toast('QR invalide ou expiré : demandez au client de rafraîchir sa carte.', 'error'); return; }
    s.scan.card = res.card; s.scan.token = token;
    s.scan.keys = { credit: uuid(), redeem: uuid() };
    $('[data-scan-panel]').innerHTML = scanPanel();
  }

  /* ---- QR & NFC --------------------------------------------------------- */
  let pairPoll = 0;
  async function supportsPage() {
    const nfc = s.me.role === 'owner' ? await api('loyalty/nfc') : null;
    const x = s.setup;
    const status = { active: 'Active', disabled: 'Désactivée', compromised: 'Compromise', retired: 'Remplacée' };
    const tags = nfc?.tags.map((t) => `<li class="row"><span class="hist-icon${t.status === 'active' ? '' : ' hist-icon--off'}">${ico('nfc')}</span>
      <span class="row__main"><strong>${esc(t.label)} <span class="badge${t.status === 'active' ? '' : ' badge--muted'}">${status[t.status] || t.status}</span></strong>
      <small>Puce …${esc(t.uidSuffix)} · ${plural(t.credits30d, 'passage', 'passages')} sur 30 j · ${t.denied24h ? `${t.denied24h} refus 24 h · ` : ''}dernière lecture ${esc(ago(t.lastReadAt))}</small></span>
      <span class="row__end">${t.status === 'active' ? `<button class="btn btn--ghost btn--sm" data-tag="${t.id}" data-tag-status="disabled">Désactiver</button>` : ''}
        ${t.status === 'disabled' ? `<button class="btn btn--ghost btn--sm" data-tag="${t.id}" data-tag-status="active">Réactiver</button>` : ''}
        ${['active', 'disabled'].includes(t.status) ? `<button class="btn btn--ghost btn--sm" data-tag="${t.id}" data-tag-replace="${esc(t.label)}">Remplacer</button>
        <button class="btn btn--ghost btn--sm" data-tag="${t.id}" data-tag-status="compromised">Signaler perdue/volée</button>` : ''}</span></li>`).join('') || '';
    const pairing = nfc?.pairing ? `<div class="pairing" role="status"><span class="pairing__pulse" aria-hidden="true">${ico('nfc')}</span>
        <div><strong>Appairage en cours : « ${esc(nfc.pairing.label)} »</strong><p>Avec CE téléphone (connecté à votre compte), approchez la puce NFC du dos de l’appareil. La première lecture valide l’associe à votre commerce. Fenêtre ouverte jusqu’à ${fmtTime(nfc.pairing.expiresAt)}.</p>
        <button class="btn btn--ghost btn--sm" type="button" data-pair-cancel>Annuler</button></div></div>` : '';
    return head('QR & présentoirs NFC', 'Le QR commerçant sert à obtenir la carte. Le NFC valide automatiquement un passage.') +
      panel('QR commerçant', x?.published ? `<div class="qr-block"><img src="/api/loyalty/setup/qr.svg" alt="QR code du commerce" width="200" height="200"><div>
          <p>À afficher au comptoir, en vitrine ou sur les tables. Il ne crédite jamais de passage.</p><p class="muted mono">${esc(x.enrollmentUrl)}</p>
          <div class="btn-row"><a class="btn btn--brand" href="/api/loyalty/setup/qr.svg?download=1" download="taply-qr-commerce.svg">${ico('download')} Télécharger (SVG)</a></div></div></div>`
        : note(`Publiez votre carte pour activer le QR. ${link('Créer ma carte', 'demarrage', 'link')}`, 'info')) +
      (nfc ? panel('Présentoirs NFC (NTAG 424 DNA)', `${nfc.serverKeysConfigured ? '' : note('Clés NFC serveur non configurées sur cet environnement : appairage impossible.', 'warn')}
        <label class="toggle-row"><span><strong>Passage automatique par NFC</strong><small>Le client approche son téléphone du présentoir : la puce authentifiée valide un passage (délai de 2 h par carte). Le scan du QR reste disponible.</small></span>
          <span class="switch"><input type="checkbox" aria-label="Passage automatique par NFC" data-nfc-auto ${x?.preferences.nfcAutoEnabled ? 'checked' : ''} ${x?.activeNfcTags ? '' : 'disabled'}><span></span></span></label>
        ${pairing}<ul class="list list--wrap">${tags || '<li class="empty">Aucun présentoir associé.</li>'}</ul>
        ${nfc.pairing ? '' : `<form data-form="pair" class="inline-form"><input class="input" name="label" maxlength="60" placeholder="Nom du présentoir (ex. Comptoir)" required>
          <button class="btn btn--brand" type="submit" ${nfc.serverKeysConfigured ? '' : 'disabled'}>${ico('plus')} Associer une puce</button></form>`}
        ${note('Une puce perdue ou volée doit être signalée : elle est bloquée immédiatement et définitivement.')}`) : '');
  }

  /* ---- Abonnement ------------------------------------------------------- */
  async function billingPage() {
    const b = await api('billing/status');
    const labels = { none: 'Aucun abonnement', incomplete: 'Paiement en attente', incomplete_expired: 'Paiement expiré', trialing: 'Essai en cours',
      active: 'Actif', past_due: 'Paiement en échec', canceled: 'Résilié', unpaid: 'Impayé', paused: 'Suspendu' };
    const operating = ['active', 'trialing', 'past_due'].includes(b.status);
    return head('Abonnement', 'Une offre unique, sans engagement.') +
      `<section class="card plan"><div><p class="plan__name">Taply</p><p class="plan__price"><strong>20 €</strong> / mois</p>
        <ul class="plan__list"><li>${ico('check')} Carte de fidélité sans application ni inscription client</li><li>${ico('check')} QR commerçant + validation au comptoir</li>
        <li>${ico('check')} Passage automatique NFC (présentoirs NTAG 424 DNA)</li><li>${ico('check')} Tableau de bord et historique</li></ul></div>
        <div class="plan__status"><span class="badge${operating ? ' badge--solid' : ' badge--muted'}">${esc(labels[b.status] || b.status)}</span>
        ${b.currentPeriodEnd ? `<p class="muted">${b.cancelAtPeriodEnd ? 'Se termine le' : 'Prochain renouvellement le'} ${fmtDate(b.currentPeriodEnd)}</p>` : ''}
        ${b.mode === 'disabled' ? note('Préproduction : facturation non appliquée.', 'info') : ''}
        ${!b.stripeConfigured ? note('Paiement en ligne non configuré sur cet environnement.', 'warn') : operating
          ? `<button class="btn btn--ghost" type="button" data-portal>Gérer la facturation</button>`
          : `<button class="btn btn--brand" type="button" data-checkout>S’abonner — 20 € / mois</button>${b.status !== 'none' ? '<button class="btn btn--ghost" type="button" data-portal>Factures et moyen de paiement</button>' : ''}`}
        <p class="muted">Paiement sécurisé par Stripe. L’accès est activé dès la confirmation du paiement par Stripe.</p></div></section>`;
  }

  /* ---- Notifications ---------------------------------------------------- */
  function notificationsPage() {
    const p = s.setup?.preferences;
    if (!p) return head('Notifications', '') + panel('Indisponible', note('Réservé au propriétaire.'));
    return head('Notifications', 'Facultatives : la carte fonctionne sans.') + panel('Préférences', `<form data-form="prefs" class="grid">
      <label class="toggle-row"><span><strong>Récompense prête</strong><small>Prévenir le client lorsqu’il atteint le seuil (s’il a autorisé les notifications sur sa carte).</small></span>
        <span class="switch"><input type="checkbox" aria-label="Récompense prête" name="notifyRewardUnlocked" ${p.notifyRewardUnlocked ? 'checked' : ''}><span></span></span></label>
      <label class="toggle-row"><span><strong>Messages du commerce</strong><small>Autoriser l’envoi d’annonces aux clients ayant donné leur accord.</small></span>
        <span class="switch"><input type="checkbox" aria-label="Messages du commerce" name="notificationsEnabled" ${p.notificationsEnabled ? 'checked' : ''}><span></span></span></label>
      <button class="btn btn--brand" type="submit">Enregistrer</button></form>
      ${note('L’envoi effectif des notifications n’est pas encore actif dans cette version : vos préférences sont enregistrées et les événements sont mis en file, sans envoi.', 'info')}`);
  }

  /* ---- Paramètres ------------------------------------------------------- */
  function settingsPage() {
    return head('Paramètres', 'Compte, appareil de validation et sécurité') +
      `<nav class="btn-row quick-links" aria-label="Autres sections">${[['Créer ma carte', 'demarrage'], ['Récompenses', 'recompenses'], ['QR & NFC', 'supports'],
        ['Abonnement', 'abonnement'], ['Notifications', 'notifications']].map(([l, r]) => `<a class="btn-chip" href="#/${r}">${esc(l)}</a>`).join('')}</nav>` +
      panel('Compte', `<dl class="facts"><div><dt>Commerce</dt><dd>${esc(s.dash?.merchant?.name || '—')}</dd></div>
        <div><dt>Rôle</dt><dd>${s.me.role === 'owner' ? 'Propriétaire' : 'Employé'}</dd></div></dl>
        <div class="btn-row"><a class="btn btn--ghost btn--sm" href="../mot-de-passe-oublie.html">Changer mon mot de passe</a>
        <button class="btn btn--ghost btn--sm" type="button" data-logout>${ico('logout')} Se déconnecter</button></div>`) +
      (s.me.role === 'owner' ? panel('Approuver cet appareil pour valider les passages', `<p class="muted">Confirmez votre mot de passe et choisissez un code PIN (6 à 10 chiffres) propre à cet appareil. Aucun secret n’est conservé dans le navigateur.</p>
        <form data-form="pair-device" class="grid two"><div class="field"><label for="p-mail">E-mail</label><input class="input" id="p-mail" name="ownerEmail" type="email" autocomplete="username" required></div>
        <div class="field"><label for="p-pass">Mot de passe</label><input class="input" id="p-pass" name="ownerPassword" type="password" autocomplete="current-password" required></div>
        <div class="field"><label for="p-pin">Nouveau PIN</label><input class="input" id="p-pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{6,10}" minlength="6" maxlength="10" required></div>
        <div class="field" style="align-self:end"><button class="btn btn--brand" type="submit">Approuver cet appareil</button></div></form>`) : '') +
      panel('Documents', `<div class="btn-row"><a class="btn-chip" href="../cgv.html" target="_blank" rel="noopener">CGV</a><a class="btn-chip" href="../cgu.html" target="_blank" rel="noopener">CGU</a><a class="btn-chip" href="../confidentialite.html" target="_blank" rel="noopener">Confidentialité</a></div>`);
  }

  /* ---- Rendu ------------------------------------------------------------ */
  async function render() {
    const path = route();
    const root = path.split('/')[0];
    if (root !== 'scanner') stopCamera();
    clearInterval(pairPoll);
    const name = s.dash?.merchant?.name || 'Mon commerce';
    $$('[data-merchant-name]').forEach((n) => { n.textContent = name; });
    $$('[data-merchant-city]').forEach((n) => { n.textContent = s.dash?.merchant?.city || (s.me?.role === 'owner' ? 'Propriétaire' : 'Employé'); });
    $$('[data-merchant-logo], [data-merchant-initial]').forEach((n) => { n.textContent = name.slice(0, 1).toUpperCase(); });
    $$('[data-nfc-status]').forEach((n) => { n.textContent = s.setup ? (s.setup.activeNfcTags ? plural(s.setup.activeNfcTags, 'puce active', 'puces actives') : 'Aucune puce') : '—'; });
    $('[data-crumb]').textContent = 'Espace commerçant';
    $$('[data-nav]').forEach((n) => n.setAttribute('aria-current', n.dataset.nav.split(' ').includes(root) ? 'page' : 'false'));
    if (!s.me) { view.textContent = 'Vérification de votre session…'; return; }
    try {
      // Données fraîches à chaque affichage : un passage validé ailleurs
      // (comptoir, présentoir NFC, autre appareil) doit apparaître ici.
      if (root === 'accueil') s.dash = await api('loyalty/dashboard');
      if (s.me.role === 'owner' && ['carte', 'supports', 'notifications', 'accueil'].includes(root)) {
        s.setup = await api('loyalty/setup');
      }
      let html;
      switch (root) {
        case 'accueil': html = home(); break;
        case 'demarrage': html = onboarding(); break;
        case 'carte': html = programPage(); break;
        case 'clients': html = path.split('/')[1] ? await customerDetail(path.split('/')[1]) : await customersPage(); break;
        case 'recompenses': html = await rewardsPage(); break;
        case 'scanner': html = scannerPage(); break;
        case 'supports': html = await supportsPage(); break;
        case 'abonnement': html = await billingPage(); break;
        case 'notifications': html = notificationsPage(); break;
        case 'parametres': html = settingsPage(); break;
        default: html = head('Page introuvable', '') + link('Accueil', 'accueil');
      }
      view.innerHTML = html;
      if (path !== render.lastPath) { scrollTo(0, 0); render.lastPath = path; }
      if (root === 'accueil' && s.dash) chart($('[data-chart]'), s.dash.visitsByDay);
      if (root === 'supports' && $('.pairing')) {
        const before = s.setup?.activeNfcTags ?? 0;
        pairPoll = setInterval(async () => {
          const n = await api('loyalty/nfc');
          if (!n.pairing) { clearInterval(pairPoll); s.setup = await api('loyalty/setup'); toast(s.setup.activeNfcTags > before ? 'Présentoir associé.' : 'Fenêtre d’appairage fermée.'); render(); }
        }, 3000);
      }
    } catch (err) {
      view.innerHTML = head('Erreur', '') + panel('Chargement impossible', note(esc(err.message), 'danger'));
    }
  }

  /* ---- Actions ---------------------------------------------------------- */
  async function guarded(button, fn) {
    if (button) button.disabled = true;
    try { await fn(); } catch (err) { toast(err.message, 'error'); } finally { if (button) button.disabled = false; }
  }

  view.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.step) { wizard.step = Number(t.dataset.step); render(); return; }
    if (t.dataset.threshold) { wizard.draft.threshold = Number(t.dataset.threshold); render(); return; }
    if (t.dataset.cthreshold) {
      $$('[data-cthreshold]').forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
      $('[name="threshold"]', t.form).value = t.dataset.cthreshold; return;
    }
    if (t.hasAttribute('data-add-reward')) { syncRewards(); wizard.draft.rewards.push(''); render(); return; }
    if (t.dataset.removeReward) { syncRewards(); wizard.draft.rewards.splice(Number(t.dataset.removeReward), 1); render(); return; }
    if (t.dataset.text) { wizard.draft.textColor = t.dataset.text; render(); return; }
    if (t.hasAttribute('data-publish')) return guarded(t, async () => {
      if (!await confirmSheet({ title: 'Publier votre carte ?', text: 'Vos clients pourront l’obtenir en scannant votre QR. Les conditions ne pourront ensuite changer qu’une fois tous les 30 jours.', ok: 'Publier' })) return;
      const r = await api('loyalty/setup/publish', {});
      if (!r.published) throw new Error(r.reason === 'subscription_required' ? 'Abonnement requis pour publier.' : 'Configuration incomplète.');
      toast('Carte publiée : votre QR est prêt.'); await refresh();
    });
    if (t.hasAttribute('data-cam-start')) return guarded(t, startCamera);
    if (t.hasAttribute('data-cam-stop')) { stopCamera(); return; }
    if (t.hasAttribute('data-scan-reset')) { s.scan.card = null; $('[data-scan-panel]').innerHTML = scanPanel(); startCamera(); return; }
    if (t.dataset.rewardKey) { $$('[data-reward-key]').forEach((b) => b.setAttribute('aria-pressed', String(b === t))); return; }
    if (t.hasAttribute('data-credit')) return guarded(t, async () => {
      const r = await api('loyalty/scan', { qrToken: s.scan.token, idempotencyKey: s.scan.keys.credit, purchaseConfirmed: true });
      if (r.credited) { toast(r.rewardUnlocked ? 'Passage validé — récompense débloquée !' : `Passage validé : ${r.visitCount} passage(s).`); s.cache = {}; }
      else toast({ cooldown_active: 'Délai de 2 h non écoulé.', reward_pending: 'Récompense en attente de remise.', qr_invalid: 'QR expiré.', subscription_inactive: 'Abonnement inactif.' }[r.reason?.kind] || 'Passage refusé.', 'error');
      await lookup(s.scan.token);
    });
    if (t.hasAttribute('data-redeem')) return guarded(t, async () => {
      const c = s.scan.card;
      const chosen = $('[data-reward-key][aria-pressed="true"]')?.dataset.rewardKey;
      if (!c.chosenReward && !chosen) throw new Error('Choisissez la récompense remise.');
      const r = await api('loyalty/redeem', { qrToken: s.scan.token, idempotencyKey: s.scan.keys.redeem, expectedCycleNumber: c.cycleNumber,
        giftHandedOver: true, ...(c.chosenReward ? {} : { rewardKey: chosen }) });
      if (r.redeemed) { toast(`Remise enregistrée : ${r.reward?.title || 'récompense'}. Nouveau cycle.`); s.cache = {}; }
      else toast({ reward_choice_mismatch: 'Le client a choisi une autre récompense.', no_reward_pending: 'Aucune récompense en attente.', cycle_mismatch: 'Carte déjà mise à jour.' }[r.reason?.kind] || 'Remise refusée.', 'error');
      await lookup(s.scan.token);
    });
    if (t.hasAttribute('data-checkout')) return guarded(t, async () => {
      const r = await api('billing/checkout', {});
      if (r.redirect) location.assign(r.redirect); else toast('Abonnement déjà actif.');
    });
    if (t.hasAttribute('data-portal')) return guarded(t, async () => {
      const r = await api('billing/portal', {});
      if (r.redirect) location.assign(r.redirect); else toast('Aucun compte de facturation pour le moment.', 'error');
    });
    if (t.hasAttribute('data-pair-cancel')) return guarded(t, async () => { await api('loyalty/nfc/pairing/cancel', {}); render(); });
    if (t.dataset.tagStatus) return guarded(t, async () => {
      const st = t.dataset.tagStatus;
      if (st === 'compromised' && !await confirmSheet({ title: 'Signaler la puce perdue ou volée ?', text: 'Elle sera bloquée définitivement. Toute lecture sera refusée.', ok: 'Bloquer la puce' })) return;
      const r = await api(`loyalty/nfc/tags/${t.dataset.tag}/status`, { status: st });
      if (!r.updated) throw new Error('Changement impossible.');
      s.setup = await api('loyalty/setup'); toast('Présentoir mis à jour.'); render();
    });
    if (t.dataset.tagReplace) return guarded(t, async () => {
      await api('loyalty/nfc/pairing', { label: t.dataset.tagReplace, replacesTagId: t.dataset.tag });
      toast('Approchez la nouvelle puce : l’ancienne sera retirée.'); render();
    });
    if (t.hasAttribute('data-logout')) return logout();
  });

  view.addEventListener('change', (e) => {
    const el = e.target;
    if (el.name === 'cardColor' && wizard.draft) { wizard.draft.cardColor = el.value; render(); }
    if (el.name === 'customColor' && wizard.draft) { wizard.draft.cardColor = el.value; render(); }
    if (el.hasAttribute('data-nfc-auto')) guarded(null, async () => {
      const p = s.setup.preferences;
      const r = await api('loyalty/program/preferences', { nfcAutoEnabled: el.checked, notifyRewardUnlocked: p.notifyRewardUnlocked, notificationsEnabled: p.notificationsEnabled }, 'PATCH');
      if (r.saved === false) { el.checked = false; throw new Error('Associez d’abord au moins un présentoir actif.'); }
      s.setup = await api('loyalty/setup'); toast(el.checked ? 'Passage automatique NFC activé.' : 'Passage automatique NFC désactivé.');
    });
  });

  function syncRewards() {
    if (!wizard.draft) return;
    const inputs = $$('[name="reward"]');
    if (inputs.length) wizard.draft.rewards = inputs.map((i) => i.value);
  }

  view.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-form]');
    if (!form) return;
    e.preventDefault();
    const f = new FormData(form);
    const v = (k) => String(f.get(k) ?? '').trim();
    const button = $('button[type=submit]', form);
    const d = wizard.draft;
    const saveDraft = () => api('loyalty/setup', { threshold: d.threshold, rewards: d.rewards.map((r) => r.trim()).filter(Boolean),
      rewardTerms: d.rewardTerms, cardColor: d.cardColor, textColor: d.textColor }, 'PATCH');
    const saveAppearance = () => api('loyalty/program/appearance', { merchantName: d.merchantName, city: d.city || null,
      rewardTerms: d.rewardTerms, cardColor: d.cardColor, textColor: d.textColor }, 'PATCH');
    guarded(button, async () => {
      switch (form.dataset.form) {
        case 'w1': {
          d.merchantName = v('merchantName'); d.city = v('city');
          await saveAppearance(); toast('Commerce enregistré.');
          s.dash = await api('loyalty/dashboard'); wizard.step = 2; break;
        }
        case 'w2': {
          syncRewards(); d.rewardTerms = v('rewardTerms');
          const r = await saveDraft();
          if (!r.saved) throw new Error(r.reason === 'duplicate_rewards' ? 'Deux récompenses identiques.' : 'Programme déjà publié.');
          toast('Programme enregistré.'); s.setup = await api('loyalty/setup'); wizard.step = 3; break;
        }
        case 'w3': {
          await saveAppearance();
          toast('Apparence enregistrée.'); s.setup = await api('loyalty/setup'); applyBrand(d.cardColor); wizard.step = 4; break;
        }
        case 'w4': {
          d.notify = f.has('notify');
          const p = s.setup.preferences;
          await api('loyalty/program/preferences', { nfcAutoEnabled: p.nfcAutoEnabled, notifyRewardUnlocked: d.notify, notificationsEnabled: p.notificationsEnabled }, 'PATCH');
          s.setup = await api('loyalty/setup'); wizard.step = 5; break;
        }
        case 'contract': {
          const rewards = v('rewards').split('\n').map((x) => x.trim()).filter(Boolean);
          if (!await confirmSheet({ title: 'Enregistrer une nouvelle version ?', text: 'Les clients en cours gardent leurs conditions jusqu’à leur récompense. Prochaine modification possible dans 30 jours.', ok: 'Confirmer' })) return;
          const r = await api('loyalty/program/contract', { threshold: Number(v('threshold')), rewards, ...(v('reason') ? { reason: v('reason') } : {}) }, 'PUT');
          if (r.status === 'too_soon') throw new Error('Modification possible à partir du ' + fmtDate(r.allowedAfter) + '.');
          if (r.status !== 'updated' && r.status !== 'unchanged') throw new Error('Conditions invalides.');
          toast(r.status === 'unchanged' ? 'Aucun changement.' : 'Nouvelle version enregistrée.'); await refresh(); return;
        }
        case 'appearance': {
          await api('loyalty/program/appearance', { merchantName: v('merchantName'), city: v('city') || null, rewardTerms: v('rewardTerms'),
            cardColor: v('cardColor'), textColor: v('textColor') }, 'PATCH');
          toast('Informations enregistrées.'); await refresh(); return;
        }
        case 'prefs': {
          const p = s.setup.preferences;
          await api('loyalty/program/preferences', { nfcAutoEnabled: p.nfcAutoEnabled, notifyRewardUnlocked: f.has('notifyRewardUnlocked'), notificationsEnabled: f.has('notificationsEnabled') }, 'PATCH');
          toast('Préférences enregistrées.'); s.setup = await api('loyalty/setup'); break;
        }
        case 'search': location.hash = '#/clients'; view.innerHTML = await customersPage(v('q')); return;
        case 'unlock': {
          await api('loyalty/devices/unlock', { pin: v('pin') });
          s.unlockedUntil = Date.now() + 15 * 60 * 1000; toast('Appareil déverrouillé pour 15 minutes.'); break;
        }
        case 'manual': await lookup(v('token')); return;
        case 'pair': {
          await api('loyalty/nfc/pairing', { label: v('label') });
          toast('Approchez maintenant la puce de ce téléphone.'); break;
        }
        case 'pair-device': {
          const pin = v('pin');
          if (!/^\d{6,10}$/.test(pin)) throw new Error('Le PIN doit contenir 6 à 10 chiffres.');
          const x = await api('loyalty/devices/approve', { ownerEmail: v('ownerEmail'), ownerPassword: String(f.get('ownerPassword') || '') });
          await api('loyalty/devices/activate', { pairingToken: x.pairingToken, pin });
          form.reset(); toast('Appareil approuvé. Conservez votre PIN.'); return;
        }
        default: return;
      }
      render();
    });
  });

  async function logout() {
    try { await api('auth/logout', {}); } catch (_) { /* déjà déconnecté */ }
    location.replace('../connexion.html');
  }
  $$('.side__out').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); logout(); }));
  addEventListener('hashchange', render);

  async function start() {
    view.textContent = 'Vérification de votre session…';
    try { await load(); } catch (_) { view.textContent = 'Connexion indisponible. Rechargez la page.'; return; }
    const params = new URLSearchParams(location.search);
    if (params.get('checkout') === 'success' && /^cs_[A-Za-z0-9_]+$/.test(params.get('session_id') || '')) {
      try {
        const r = await api('billing/sync', { sessionId: params.get('session_id') });
        toast(r.synced ? 'Abonnement activé, merci !' : 'Paiement en cours de confirmation par Stripe…');
        await load();
      } catch (_) { toast('Confirmation du paiement en attente : elle arrivera automatiquement.', 'error'); }
    }
    if (params.has('checkout')) history.replaceState(null, '', location.pathname + location.hash);
    if (s.me.role === 'owner' && s.setup && !s.setup.published && route() === 'accueil' && !s.dash?.stats.cards) location.hash = '#/demarrage';
    render();
  }
  start();
})();
