/* Taply — carte de fidélité du client (sans compte, sans donnée personnelle).
 * L'identité est un cookie HttpOnly posé par le serveur : ce script n'a accès
 * à aucun jeton, et rien n’est conservé dans le stockage du navigateur.
 * Modes : join (QR du commerce), cards (mes cartes), tap (présentoir NFC).
 */
(() => {
  'use strict';
  const $ = (sel, root = document) => root.querySelector(sel);
  const app = $('#app');
  const mode = document.body.dataset.mode;
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const time = (v) => new Date(v).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const day = (v) => new Date(v).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
  const sameDay = (v) => new Date(v).toDateString() === new Date().toDateString();
  const when = (v) => (sameDay(v) ? 'à ' + time(v) : 'le ' + day(v) + ' à ' + time(v));
  let qrTimer = 0;
  let qrUrl = null;

  async function api(path, body) {
    const opt = { credentials: 'same-origin', cache: 'no-store' };
    if (body !== undefined) {
      opt.method = 'POST';
      opt.headers = { 'Content-Type': 'application/json' };
      opt.body = JSON.stringify(body);
    }
    const res = await fetch('/api/c/' + path, opt);
    let data = null;
    try { data = await res.json(); } catch (_) { /* vide */ }
    return { ok: res.ok, status: res.status, data };
  }
  function toast(text) {
    const t = $('[data-toast]');
    t.textContent = text; t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
  }
  function fail(message) {
    app.innerHTML = `<section class="c-panel c-panel--center"><h1 class="c-title">Oups</h1><p>${esc(message)}</p>
      <a class="c-btn c-btn--ghost" href="carte.html">Voir mes cartes</a></section>`;
  }
  const errorText = (status) => status === 429 ? 'Trop de tentatives. Réessayez dans quelques minutes.'
    : status === 503 ? 'Ce service n’est pas disponible pour le moment.'
    : 'Cette carte ou ce programme est indisponible.';

  /* ---- Carte -------------------------------------------------------- */
  function stamps(card) {
    return Array.from({ length: card.threshold }, (_, i) => `<i class="${i < card.visits ? 'on' : ''}"${i < card.visits ? ' aria-hidden="true"' : ''}></i>`).join('');
  }
  function cardVisual(card) {
    const left = card.threshold - card.visits;
    const status = card.rewardPending
      ? (card.claim ? `Récompense choisie : ${card.claim.title}` : 'Récompense débloquée !')
      : `Encore ${left} passage${left > 1 ? 's' : ''}`;
    return `<div class="c-card" style="--card-bg:${esc(card.cardColor)};--card-fg:${esc(card.textColor)}"
        role="img" aria-label="Carte ${esc(card.merchantName)} : ${card.visits} passages sur ${card.threshold}">
      <div class="c-card__head"><strong>${esc(card.merchantName)}</strong><span>${esc(card.city || 'Carte fidélité')}</span></div>
      <div class="c-card__stamps">${stamps(card)}</div>
      <div class="c-card__foot"><strong>${card.visits} / ${card.threshold}</strong><span>${esc(status)}</span></div>
      <span class="c-card__code">N° ${esc(card.shortCode)}</span>
    </div>`;
  }
  function rewardBlock(card) {
    if (!card.rewardPending) return '';
    if (card.claim) {
      return `<section class="c-panel c-panel--reward"><p class="c-eyebrow">Récompense prête</p><h2>${esc(card.claim.title)}</h2>
        <p>Présentez votre QR au comptoir : l’équipe confirme la remise et votre carte repart à zéro.</p>
        ${card.rewards.length > 1 ? '<button class="c-btn c-btn--ghost c-btn--sm" type="button" data-change-reward>Changer de récompense</button>' : ''}</section>`;
    }
    return `<section class="c-panel c-panel--reward"><p class="c-eyebrow">Bravo, carte complète !</p><h2>Choisissez votre récompense</h2>
      <div class="c-choices">${card.rewards.map((r) => `<button class="c-choice" type="button" data-choose="${esc(r.key)}">${esc(r.title)}</button>`).join('')}</div>
      <p class="c-muted">Votre carte est en pause jusqu’à la remise : aucun nouveau passage n’est compté avant.</p></section>`;
  }
  function cardScreen(card, { history = [], intro = '', hideNext = false } = {}) {
    clearInterval(qrTimer);
    const next = card.nextVisitAllowedAt && !card.rewardPending && !hideNext
      ? `<p class="c-info">Prochain passage possible ${esc(when(card.nextVisitAllowedAt))} (2 h minimum entre deux passages).</p>` : '';
    const labels = { visit_qr: 'Passage validé au comptoir', visit_nfc: 'Passage validé (NFC)', reward: 'Récompense remise' };
    app.innerHTML = `${intro}${cardVisual(card)}${rewardBlock(card)}${next}
      <section class="c-panel c-qr" data-qr-panel>
        <button class="c-btn" type="button" data-show-qr>Afficher mon QR</button>
        <p class="c-muted">À présenter au comptoir. Il change à chaque affichage et ne fonctionne que 15 minutes.</p>
      </section>
      ${history.length ? `<section class="c-panel"><h2 class="c-h2">Historique</h2><ul class="c-history">${history.map((h) =>
        `<li><span>${esc(labels[h.kind] || h.kind)}${h.detail ? ' · ' + esc(h.detail) : ''}</span><time>${esc(day(h.at))}</time></li>`).join('')}</ul></section>` : ''}
      ${recoveryPanel()}`;
    app.dataset.card = card.membershipId;
    app.dataset.snapshot = snapshotOf(card);
  }
  function snapshotOf(card) {
    return JSON.stringify([card.visits, card.cycleNumber, card.rewardPending, card.claim?.key ?? null]);
  }
  async function showQr() {
    const id = app.dataset.card;
    const r = await api(`cards/${id}/qr`, {});
    if (!r.ok) { toast(errorText(r.status)); return; }
    if (qrUrl) URL.revokeObjectURL(qrUrl);
    qrUrl = URL.createObjectURL(new Blob([r.data.qrSvg], { type: 'image/svg+xml' }));
    const panel = $('[data-qr-panel]');
    panel.innerHTML = `<img class="c-qr__img" src="${qrUrl}" alt="Mon QR personnel à présenter au comptoir">
      <p class="c-qr__timer" data-qr-timer></p><button class="c-btn c-btn--ghost c-btn--sm" type="button" data-show-qr>Actualiser</button>`;
    const expires = new Date(r.data.expiresAt).getTime();
    clearInterval(qrTimer);
    const tick = () => {
      const s = Math.max(0, Math.round((expires - Date.now()) / 1000));
      const el = $('[data-qr-timer]');
      if (!el) return clearInterval(qrTimer);
      el.textContent = s ? `Valable encore ${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s` : 'QR expiré : actualisez-le.';
      if (!s) { clearInterval(qrTimer); $('.c-qr__img')?.classList.add('is-expired'); }
    };
    tick();
    qrTimer = setInterval(tick, 1000);
    // Pendant l'affichage du QR, la carte se met à jour dès que le comptoir valide.
    pollCard(id, r.data.expiresAt);
  }
  let pollTimer = 0;
  function pollCard(id, until) {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      if (Date.now() > new Date(until).getTime()) return clearInterval(pollTimer);
      if (document.hidden) return;
      const r = await api(`cards/${id}`);
      if (!r.ok) return;
      const prev = app.dataset.snapshot;
      if (snapshotOf(r.data.card) === prev) return;
      clearInterval(pollTimer);
      cardScreen(r.data.card, { history: r.data.history });
      toast(r.data.card.cycleNumber > JSON.parse(prev)[1] ? 'Récompense remise. Nouvelle carte commencée !' : 'Carte mise à jour.');
    }, 4000);
  }

  /* ---- Récupération -------------------------------------------------- */
  let hasRecovery = false;
  function recoveryPanel() {
    return `<section class="c-panel c-recovery"><h2 class="c-h2">Ne perdez pas vos cartes</h2>
      <p class="c-muted">Vos cartes sont liées à ce navigateur, sans compte. Si vous changez de téléphone ou effacez vos données, seul un code de secours permet de les retrouver.</p>
      <div data-recovery-out></div>
      <div class="c-row">${hasRecovery
        ? '<button class="c-btn c-btn--ghost c-btn--sm" type="button" data-recovery-new>Renouveler mon code</button><button class="c-btn c-btn--ghost c-btn--sm" type="button" data-recovery-revoke>Désactiver le code</button>'
        : '<button class="c-btn c-btn--ghost c-btn--sm" type="button" data-recovery-new>Créer mon code de secours</button>'}</div></section>`;
  }
  function showSecret(code, title) {
    $('[data-recovery-out]').innerHTML = `<div class="c-secret"><p><strong>${esc(title)}</strong></p>
      <p class="c-secret__code">${esc(code)}</p><p class="c-muted">Notez-le ou faites une capture d’écran : il ne sera plus jamais affiché. Ne le partagez pas.</p>
      <button class="c-btn c-btn--ghost c-btn--sm" type="button" data-copy="${esc(code)}">Copier</button></div>`;
  }
  function recoverForm() {
    return `<details class="c-panel c-details"><summary>J’ai déjà une carte</summary><div><p class="c-muted">Saisissez votre code de secours pour retrouver vos cartes sur ce téléphone. Vos autres appareils seront déconnectés.</p>
      <form data-recover class="c-form"><label class="sr-only" for="rc">Code de secours</label>
      <input id="rc" name="code" maxlength="40" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXXX-XXXXX-XXXXX-XXXXX" required>
      <button class="c-btn" type="submit">Retrouver mes cartes</button></form></div></details>`;
  }

  /* ---- Modes ---------------------------------------------------------- */
  async function joinMode() {
    const code = new URLSearchParams(location.search).get('code') || '';
    if (!/^[A-Za-z0-9_-]{32}$/.test(code)) return fail('QR du commerce invalide. Scannez à nouveau le QR affiché au comptoir.');
    const r = await api('program?code=' + encodeURIComponent(code));
    if (!r.ok) return fail(errorText(r.status));
    const { program, card, enrollmentOpen, identity } = r.data;
    hasRecovery = Boolean(identity?.hasRecoveryCode);
    document.title = program.merchantName + ' — Ma carte Taply';
    if (card) return cardScreen(card);
    const rewards = program.rewards.map((x) => x.title);
    app.innerHTML = `<section class="c-hero" style="--card-bg:${esc(program.cardColor)};--card-fg:${esc(program.textColor)}">
        <p class="c-eyebrow">Carte de fidélité</p><h1 class="c-title">${esc(program.merchantName)}</h1>
        <p class="c-offer"><strong>${program.threshold} passages</strong> = ${esc(rewards.length > 1 ? rewards.slice(0, -1).join(', ') + ' ou ' + rewards.at(-1) : rewards[0])}</p></section>
      <section class="c-panel">
        ${enrollmentOpen ? `<button class="c-btn c-btn--lg" type="button" data-enroll>Obtenir ma carte</button>
          <p class="c-muted">Rien à remplir : ni nom, ni e-mail, ni téléphone, ni application. Votre carte démarre à 0 passage&nbsp;; chaque passage est validé au comptoir${program.nfcAutoEnabled ? ' ou en approchant votre téléphone du présentoir Taply' : ''}.</p>`
          : '<p>Ce commerce n’accepte pas de nouvelles cartes pour le moment.</p>'}
        ${program.terms ? `<details class="c-terms"><summary>Conditions du programme</summary><p>${esc(program.terms)}</p></details>` : ''}
        <p class="c-muted">En obtenant votre carte, un identifiant aléatoire et vos passages sont enregistrés pour ce programme. <a href="confidentialite.html">En savoir plus</a>.</p>
      </section>${recoverForm()}`;
    app.dataset.code = code;
  }
  async function cardsMode() {
    const id = location.hash.slice(1);
    if (/^[0-9a-f-]{36}$/.test(id)) {
      const r = await api('cards/' + id);
      if (!r.ok) return fail('Carte introuvable sur ce téléphone.');
      const list = await api('cards');
      hasRecovery = Boolean(list.data?.hasRecoveryCode);
      return cardScreen(r.data.card, { history: r.data.history, intro: '<a class="c-back" href="carte.html">← Mes cartes</a>' });
    }
    const r = await api('cards');
    if (!r.ok) return fail(errorText(r.status));
    hasRecovery = Boolean(r.data.hasRecoveryCode);
    const cards = r.data.cards;
    app.innerHTML = `<h1 class="c-title">Mes cartes</h1>${cards.length ? `<ul class="c-list">${cards.map((c) => `<li><a href="carte.html#${esc(c.membershipId)}" class="c-list__item" style="--card-bg:${esc(c.cardColor)};--card-fg:${esc(c.textColor)}">
        <span class="c-list__dot" aria-hidden="true"></span><span><strong>${esc(c.merchantName)}</strong><small>${c.rewardPending ? 'Récompense prête' : `${c.visits} / ${c.threshold} passages`}</small></span><span aria-hidden="true">›</span></a></li>`).join('')}</ul>${recoveryPanel()}`
      : `<section class="c-panel"><p>Aucune carte sur ce téléphone. Scannez le QR d’un commerce Taply pour obtenir votre carte.</p></section>${recoverForm()}`}`;
  }
  async function tapMode() {
    const params = new URLSearchParams(location.search);
    const e = params.get('e') || '', c = params.get('c') || '';
    // L'URL de la puce est à usage unique : on la retire de l'historique tout de suite.
    history.replaceState(null, '', location.pathname);
    if (!/^[0-9A-Fa-f]{32}$/.test(e) || !/^[0-9A-Fa-f]{16}$/.test(c)) return fail('Lecture NFC incomplète. Approchez à nouveau votre téléphone du présentoir.');
    app.innerHTML = '<section class="c-panel c-panel--center"><span class="c-pulse" aria-hidden="true"></span><p>Validation de votre passage…</p></section>';
    let r;
    try { r = await api('nfc/tap', { e, c }); } catch (_) {
      app.innerHTML = `<section class="c-panel c-panel--center"><p>Connexion impossible.</p><button class="c-btn" type="button" data-retry>Réessayer</button></section>`;
      app.dataset.e = e; app.dataset.c = c; return;
    }
    const d = r.data || {};
    if (d.status === 'paired') {
      app.innerHTML = `<section class="c-panel c-panel--center c-panel--ok"><h1 class="c-title">Présentoir associé</h1><p>« ${esc(d.label)} » est maintenant lié à votre commerce.</p>
        <a class="c-btn" href="dashboard/#/supports">Retour au tableau de bord</a></section>`; return;
    }
    if (d.card) {
      const list = await api('cards');
      hasRecovery = Boolean(list.data?.hasRecoveryCode);
    }
    const msg = {
      credited: d.firstVisit ? ['Bienvenue !', 'Votre carte est créée et votre premier passage est validé.']
        : d.rewardUnlocked ? ['Carte complète !', 'Votre récompense est débloquée : choisissez-la ci-dessous.'] : ['Passage validé !', ''],
      already_processed: ['Déjà enregistré', 'Ce passage a bien été pris en compte.'],
    }[d.status];
    if (msg && d.card) {
      return cardScreen(d.card, { intro: `<section class="c-panel c-panel--ok c-panel--center"><span class="c-check" aria-hidden="true">✓</span><h1 class="c-title">${esc(msg[0])}</h1>${msg[1] ? `<p>${esc(msg[1])}</p>` : ''}</section>` });
    }
    const denied = {
      cooldown: ['Passage déjà validé récemment', d.retryAfter ? `Prochain passage possible ${when(d.retryAfter)}.` : 'Deux passages doivent être séparés de 2 heures.'],
      reward_pending: ['Votre récompense vous attend', 'Choisissez-la puis présentez votre QR au comptoir.'],
      replay: ['Lecture déjà utilisée', 'Approchez à nouveau votre téléphone du présentoir.'],
      invalid: ['Présentoir non reconnu', 'Cette lecture n’est pas authentique. Présentez votre QR au comptoir.'],
      unknown_tag: ['Présentoir non reconnu', 'Ce présentoir n’est pas associé à un commerce Taply.'],
      tag_inactive: ['Présentoir désactivé', 'Présentez votre QR au comptoir pour valider votre passage.'],
      nfc_disabled: ['Validation au comptoir', 'Ce commerce valide les passages en scannant votre QR.'],
      risk: ['Validation au comptoir', 'Pour ce passage, présentez votre QR à l’équipe.'],
      billing: ['Indisponible', 'Ce programme est momentanément suspendu.'],
      program_unavailable: ['Indisponible', 'Ce programme n’est pas disponible pour le moment.'],
      rate_limited: ['Trop de tentatives', 'Patientez quelques minutes.'],
    }[d.reason] || ['Passage non validé', errorText(r.status)];
    const intro = `<section class="c-panel c-panel--warn c-panel--center"><h1 class="c-title">${esc(denied[0])}</h1><p>${esc(denied[1])}</p></section>`;
    if (d.card) return cardScreen(d.card, { intro, hideNext: d.reason === 'cooldown' });
    app.innerHTML = intro + '<a class="c-btn c-btn--ghost" href="carte.html">Mes cartes</a>';
  }

  /* ---- Interactions --------------------------------------------------- */
  app.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    b.disabled = true;
    try {
      if (b.hasAttribute('data-enroll')) {
        const r = await api('enroll', { publicToken: app.dataset.code });
        if (!r.ok) return toast(r.data?.error?.message || errorText(r.status));
        cardScreen(r.data.card, { intro: '<section class="c-panel c-panel--ok c-panel--center"><span class="c-check" aria-hidden="true">✓</span><h1 class="c-title">Votre carte est prête</h1><p>Aucun passage n’a été ajouté : il sera validé lors de votre prochain achat.</p></section>' });
      } else if (b.hasAttribute('data-show-qr')) {
        await showQr();
      } else if (b.dataset.choose) {
        const r = await api(`cards/${app.dataset.card}/reward`, { rewardKey: b.dataset.choose });
        if (!r.ok || !r.data.chosen) return toast('Choix impossible pour le moment.');
        cardScreen(r.data.card);
        toast('Récompense choisie : ' + r.data.reward.title);
      } else if (b.hasAttribute('data-change-reward')) {
        const r = await api(`cards/${app.dataset.card}`);
        if (r.ok) cardScreen({ ...r.data.card, claim: null }, { history: r.data.history });
      } else if (b.hasAttribute('data-recovery-new')) {
        const r = await api('recovery', {});
        if (!r.ok) return toast(errorText(r.status));
        hasRecovery = true;
        showSecret(r.data.recoveryCode, 'Votre code de secours');
      } else if (b.hasAttribute('data-recovery-revoke')) {
        const r = await api('recovery/revoke', {});
        if (r.ok) { hasRecovery = false; toast('Code de secours désactivé.'); $('.c-recovery').outerHTML = recoveryPanel(); }
      } else if (b.dataset.copy) {
        try { await navigator.clipboard.writeText(b.dataset.copy); toast('Code copié.'); } catch (_) { toast('Sélectionnez le code pour le copier.'); }
      } else if (b.hasAttribute('data-retry')) {
        history.replaceState(null, '', location.pathname + '?e=' + app.dataset.e + '&c=' + app.dataset.c);
        await tapMode();
      }
    } finally { b.disabled = false; }
  });
  app.addEventListener('submit', async (ev) => {
    const form = ev.target.closest('[data-recover]');
    if (!form) return;
    ev.preventDefault();
    const button = $('button', form);
    button.disabled = true;
    const r = await api('recover', { recoveryCode: form.code.value.trim() });
    button.disabled = false;
    if (!r.ok) return toast(r.status === 429 ? errorText(429) : 'Code incorrect.');
    app.innerHTML = '';
    if (mode === 'join') await joinMode(); else await cardsMode();
    hasRecovery = true;
    const out = $('[data-recovery-out]');
    if (out) showSecret(r.data.newRecoveryCode, 'Cartes retrouvées. Votre NOUVEAU code de secours (l’ancien ne fonctionne plus) :');
  });
  addEventListener('hashchange', () => { if (mode === 'cards') cardsMode(); });
  addEventListener('pagehide', () => { if (qrUrl) URL.revokeObjectURL(qrUrl); });

  ({ join: joinMode, cards: cardsMode, tap: tapMode }[mode] || cardsMode)().catch(() => fail('Connexion impossible. Vérifiez votre réseau.'));
})();
