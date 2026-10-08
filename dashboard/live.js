/* Taply dashboard LIVE — toutes les données proviennent des routes API authentifiées.
 * Aucune donnée de démonstration, aucun jeton/PIN/session dans localStorage.
 * Les fonctions non livrées sont annoncées comme indisponibles, jamais simulées.
 */
(() => {
  'use strict';
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const view = $('#view');
  const s = { principal: null, identity: null, programs: [], customers: [], security: null, error: null,
    customersError: null, securityError: null };
  const esc = x => String(x ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const plural = (n, label) => n + ' ' + label + (n > 1 ? 's' : '');
  const fmt = value => value ? new Date(value).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
  const ico = name => `<svg aria-hidden="true" style="width:1.1em;height:1.1em"><use href="#d-${name}"/></svg>`;
  const msg = (title, explanation) => `<section class="card" style="padding:1.7rem">
    <h2 style="margin:0 0 .65rem">${esc(title)}</h2><p>${esc(explanation)}</p></section>`;
  const header = (title, subtitle) => `<div class="page-head"><div><h1>${esc(title)}</h1>
    <p>${esc(subtitle)}</p></div></div>`;
  const btn = (label) => `<button class="btn btn--brand" type="submit">${esc(label)}</button>`;
  const field = (name, label, type = 'text', value = '') =>
    `<label style="display:grid;gap:.4rem;margin-block:.8rem">${esc(label)}
       <input class="input" name="${esc(name)}" type="${esc(type)}" value="${esc(value)}"
        autocomplete="off" required></label>`;
  const nav = () => location.hash.replace(/^#\/?/, '') || 'accueil';
  const link = (text, route) => `<a class="btn btn--ghost" href="#/${route}">${esc(text)} ${ico('arrow')}</a>`;
  async function api(path, body) {
    const options = { credentials:'same-origin', cache:'no-store' };
    if (body !== undefined) {
      options.method = 'POST';
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(body);
    }
    const response = await fetch('/api/' + path, options);
    if (response.status === 401) {
      location.replace('../connexion.html');
      throw new Error('session-expired');
    }
    if (!response.ok) {
      const error = new Error(response.status === 503 ? 'Service non activé en préproduction.' :
        response.status === 403 ? 'Accès refusé.' :
        response.status === 409 ? 'Modification refusée : vérifiez les règles du programme.' :
        'Opération impossible. Réessayez plus tard.');
      error.status = response.status;
      throw error;
    }
    return response.json();
  }
  async function load() {
    // Effacer toute ancienne donnée AVANT de vérifier la nouvelle session.
    s.principal = null;
    s.identity = null;
    s.programs = [];
    s.customers = [];
    s.security = null;
    s.customersError = null;
    s.securityError = null;
    s.principal = await api('auth/me');
    if (s.principal.role !== 'owner') {
      try { s.identity = await api('loyalty/identity'); } catch (_) {}
      return;
    }
    const results = await Promise.allSettled([
      api('loyalty/overview'), api('loyalty/customers'),
      api('loyalty/security'), api('loyalty/identity'),
    ]);
    if (results[0].status === 'fulfilled') s.programs = results[0].value.programs;
    else s.error = results[0].reason.message;
    if (results[1].status === 'fulfilled') s.customers = results[1].value.customers;
    else s.customersError = results[1].reason.message;
    if (results[2].status === 'fulfilled') s.security = results[2].value;
    else s.securityError = results[2].reason.message;
    if (results[3].status === 'fulfilled') s.identity = results[3].value;
  }
  async function refresh() {
    s.error = null; await load(); render();
  }
  const program = () => s.programs[0];
  function home() {
    const total = s.programs.reduce((n, p) => n + p.totalMembers, 0);
    const pending = s.programs.reduce((n, p) => n + p.pendingRewards, 0);
    return header('Accueil', 'Données réelles de votre programme de fidélité') +
      `<section class="kpis" aria-label="Indicateurs réels">
        <div class="card kpi"><span class="kpi__label">Cartes inscrites</span><strong class="kpi__value">${total}</strong></div>
        <div class="card kpi"><span class="kpi__label">Récompenses en attente</span><strong class="kpi__value">${pending}</strong></div>
        <div class="card kpi"><span class="kpi__label">Programmes actifs</span><strong class="kpi__value">${s.programs.filter(p => p.status === 'active').length}</strong></div>
      </section><section class="grid" style="margin-top:1.25rem">
        <div class="card" style="padding:1.5rem"><h2>Actions au comptoir</h2>
          <p>Une visite est créditée seulement après validation avec un appareil approuvé et un code PIN.</p>
          ${link('Valider une visite', 'scan')} ${link('Confirmer une pré-inscription', 'confirmation')}
          ${link('Créer une carte', 'inscription')}</div>
        <div class="card" style="padding:1.5rem"><h2>Programme de fidélité</h2>
          ${s.programs.map(p => `<p><strong>${esc(p.name)}</strong> — ${esc(p.status)} —
           ${esc(p.threshold)} passages requis</p>`).join('') || '<p>Aucun programme actif enregistré.</p>'}
          ${link('Modifier les règles', 'parametres/carte')}</div></section>`;
  }
  function customers() {
    if (s.customersError) return header('Clients', 'Données réelles uniquement') +
      msg('Liste indisponible', s.customersError);
    const rows = s.customers.map(c => `<li class="row" style="padding:1rem;border-bottom:1px solid #e5e5e5">
      <span class="row__main"><strong>${esc(c.firstName)}</strong>
        <small>${esc(c.programName)} · ${esc(plural(c.visitCount, 'passage'))} / ${esc(c.threshold ?? '—')}
        ${c.rewardPending ? ' · 🎁 Cadeau en attente' : ''}</small></span>
      <span class="row__end">${esc(fmt(c.lastVisitAt))}</span></li>`).join('');
    return header('Clients', '50 dernières cartes au maximum · informations issues de Supabase') +
      `<section class="card card--flush"><ul class="list">${rows || '<li class="row">Aucune carte enregistrée.</li>'}</ul></section>`;
  }
  function rewards() {
    return header('Récompenses', 'Récompenses réellement en attente par programme') +
      s.programs.map(p => msg(p.name, plural(p.pendingRewards, 'récompense') + ' en attente. ' +
        'Seuil actuel : ' + p.threshold + ' passages.')).join('') +
      msg('Remise en main propre', 'Au comptoir, l’employé doit confirmer que le cadeau a bien été remis.') +
      link('Valider une récompense', 'cadeau');
  }
  function stats() {
    if (!s.security) return msg('Statistiques', 'Historique non disponible : ' + (s.securityError || 'accès non autorisé.'));
    const visits = s.security.recentActivity.filter(x => x.kind === 'visit').length;
    const gifts = s.security.recentActivity.filter(x => x.kind === 'reward').length;
    return header('Statistiques', 'Historique récent, limité aux 100 derniers événements') +
      `<section class="kpis"><div class="card kpi"><span class="kpi__label">Passages récents</span>
        <strong class="kpi__value">${visits}</strong></div><div class="card kpi">
        <span class="kpi__label">Cadeaux remis récemment</span><strong class="kpi__value">${gifts}</strong>
        </div></section>` +
      (s.security.unusualVelocity.length ? s.security.unusualVelocity.map(x =>
        msg('Activité à vérifier', x.visitsIn10Minutes + ' passages en 10 minutes pour l’employé ' +
          x.merchantUserId.slice(0, 8) + '…')).join('') :
        msg('Surveillance des abus', 'Aucun pic de passages signalé sur les 10 dernières minutes.')) +
      `<section class="card" style="padding:1.5rem"><h2>Dernières opérations</h2>
        ${s.security.recentActivity.slice(0, 30).map(x => `<p>${esc(fmt(x.happenedAt))} —
          ${x.kind === 'visit' ? 'Passage' : 'Cadeau remis'} · Carte ${esc(x.membershipId.slice(0, 8))}…
          · Employé ${esc((x.performedBy || 'inconnu').slice(0, 8))}…</p>`).join('') || '<p>Historique vide.</p>'}
      </section>`;
  }
  function settings() {
    return header('Paramètres', 'Compte commerçant et appareils autorisés') +
      msg('Compte', 'Rôle : ' + (s.principal?.role === 'owner' ? 'propriétaire' : 'employé') +
        ' · Commerce : ' + (s.principal?.merchantId || '—')) +
      `<div class="grid">${link('Règles de fidélité', 'parametres/carte')}
        ${link('Appareils et sécurité', 'parametres/integrations')}</div>`;
  }
  function configCard() {
    return header('Carte de fidélité', 'Les changements de seuil sont autorisés au maximum une fois tous les 30 jours') +
      s.programs.map(p => `<form data-action="program" class="card" style="padding:1.5rem;margin-bottom:1rem">
        <h2>${esc(p.name)}</h2><input type="hidden" name="programId" value="${esc(p.id)}">
        <label style="display:grid;gap:.5rem">Nombre de passages requis (3 à 10)
          <input class="input" name="threshold" type="number" min="3" max="10"
          value="${p.threshold || 10}" required></label>
        <label style="display:grid;gap:.5rem;margin-block:1rem">État du programme
          <select class="input" name="status"><option value="active" ${p.status === 'active' ? 'selected' : ''}>Actif</option>
          <option value="paused" ${p.status === 'paused' ? 'selected' : ''}>En pause</option></select></label>
        <label><input type="checkbox" name="notificationsEnabled" ${p.notificationsEnabled ? 'checked' : ''}>
          Autoriser les notifications (l’envoi réel n’est pas encore actif)</label>
        ${field('pin', 'Code PIN de votre appareil approuvé', 'password')}
        ${btn('Enregistrer les changements')}</form>`).join('') +
      link('Activer cet appareil', 'parametres/integrations');
  }
  function devicePage() {
    const devices = s.security?.devices || [];
    return header('Appareils et sécurité', 'Seul le propriétaire peut approuver un appareil') +
      `<form data-action="pair-device" class="card" style="padding:1.5rem">
        <h2>Activer mon appareil</h2><p>Revérifiez votre mot de passe propriétaire et choisissez un PIN de 6 à 10 chiffres.
        Aucune information secrète n’est conservée dans le navigateur.</p>
        ${field('targetMerchantUserId', 'Identifiant employé (laisser vide pour votre propre appareil)', 'text', s.identity?.merchantUserId || '')}
        ${field('ownerEmail', 'Email propriétaire', 'email')}
        ${field('ownerPassword', 'Mot de passe propriétaire', 'password')}
        ${field('pin', 'Nouveau PIN (6–10 chiffres)', 'password')}
        ${btn('Approuver cet appareil')}</form>
      <section class="card" style="padding:1.5rem;margin-top:1rem"><h2>Appareils enregistrés</h2>
      ${devices.map(x => `<p>${esc(x.id.slice(0, 8))}… · ${x.revokedAt ? 'Révoqué' : 'Actif'}
         · ${esc(x.failedAttempts)} mauvais PIN · dernière utilisation : ${esc(fmt(x.lastUsedAt))}</p>`).join('') || '<p>Aucun appareil pour le moment.</p>'}</section>`;
  }
  function staffDevicePage() {
    return header('Activer mon appareil', 'Saisissez le code d’invitation remis par le propriétaire') +
      `<form data-action="activate-staff" class="card" style="padding:1.5rem">
      ${field('pairingToken', 'Code d’invitation (valide 5 minutes)')}
      ${field('pin', 'Votre PIN personnel (6–10 chiffres)', 'password')}
      ${btn('Activer cet appareil')}</form>`;
  }
  function scanPage() {
    return header('Valider un passage', 'Présence du client et achat vérifiés par l’employé') +
      `<form data-action="scan" class="card" style="padding:1.5rem">
        ${field('qrToken', 'Jeton QR personnel du client (saisie de test)')}
        ${field('pin', 'Code PIN de l’appareil', 'password')}
        <label><input type="checkbox" name="purchaseConfirmed" required> Je confirme avoir constaté l’achat en personne.</label>
        ${btn('Créditer un passage')}</form>
        ${msg('Lecteur QR', 'Le scanner par caméra et le NFC restent à intégrer. Aucune validation autonome sur QR public.')}`;
  }
  function confirmPage() {
    return header('Pré-inscription client', 'Le passage n’est crédité qu’après présence et achat confirmés') +
      `<form data-action="confirm" class="card" style="padding:1.5rem">
      ${field('claimToken', 'Code de pré-inscription de 10 minutes')}
      ${field('pin', 'PIN de l’appareil approuvé', 'password')}
      <label><input type="checkbox" name="customerPresent" required> Le client est présent.</label>
      <label><input type="checkbox" name="purchaseConfirmed" required> L’achat a été vérifié en personne.</label>
      ${btn('Activer la carte et créditer le premier passage')}</form>`;
  }
  function giftPage() {
    return header('Remettre une récompense', 'Vérifiez la carte et le cycle avant de remettre le cadeau') +
      `<form data-action="redeem" class="card" style="padding:1.5rem">
      ${field('qrToken', 'Jeton QR personnel (saisie de test)')}
      ${field('expectedCycleNumber', 'Numéro du cycle', 'number', 1)}
      ${field('pin', 'Code PIN de l’appareil', 'password')}
      <label><input type="checkbox" name="giftHandedOver" required> Cadeau réellement remis au client.</label>
      ${btn('Confirmer la remise')}</form>`;
  }
  function registerPage() {
    return header('Créer une carte', 'Au comptoir, avec le consentement et la présence du client') +
      `<form data-action="register" class="card" style="padding:1.5rem">
      ${field('firstName', 'Prénom du client')}
      <label style="display:grid;gap:.4rem">Programme
        <select class="input" name="programId" required>
          ${s.programs.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}
        </select></label>
      ${field('pin', 'PIN de l’appareil', 'password')}
      <label><input type="checkbox" name="privacyAccepted" required> Le client accepte le traitement des données de fidélité.</label>
      <label><input type="checkbox" name="customerPresent" required> Le client est présent.</label>
      ${btn('Créer la carte')}</form>
      ${msg('Remise au client', 'Le QR personnel doit être remis directement au client. La création de pass Wallet natif reste en attente des comptes émetteurs.')}`;
  }
  function noFeature(page) {
    if (page === 'notifications') return header('Notifications', 'Préférences seulement') +
      msg('Envoi non activé', 'Les notifications réelles et les emails ne sont pas encore implémentés. Activez les préférences dans Paramètres > Carte.');
    return header('À venir', 'Module non encore connecté') +
      msg('Fonction indisponible', 'Cette page ne présente aucune donnée fictive. Elle sera activée après certification.');
  }
  function render() {
    const path = nav(), root = path.split('/')[0];
    $('[data-crumb]').textContent = 'Espace commerçant · ' + path.replaceAll('/', ' › ');
    $$('[data-nav]').forEach(node => node.setAttribute('aria-current',
      node.dataset.nav.split(' ').includes(root) ? 'page' : 'false'));
    if (s.error) { view.innerHTML = header('Connexion au service', 'Aucune donnée fictive affichée') +
      msg('Fonctionnalité non disponible', s.error) + link('Retour aux paramètres', 'parametres'); return; }
    if (!s.principal) { view.textContent = 'Vérification de votre session…'; return; }
    if (s.principal.role !== 'owner') {
      const routes = { scan: scanPage, cadeau: giftPage, confirmation: confirmPage,
        'parametres/integrations': staffDevicePage };
      view.innerHTML = (routes[path] || (() => header('Espace employé', 'Compte authentifié') +
        msg('Identifiant employé', s.identity?.merchantUserId || 'Non disponible') +
        link('Activer mon appareil', 'parametres/integrations') +
        link('Valider une visite', 'scan') + link('Confirmer un client', 'confirmation') +
        link('Remettre un cadeau', 'cadeau')))();
      return;
    }
    const routes = {
      accueil: home, clients: customers, recompenses: rewards, statistiques: stats,
      parametres: settings, 'parametres/carte': configCard,
      'parametres/integrations': devicePage,
      'parametres/etablissement': settings,
      scan: scanPage, cadeau: giftPage, confirmation: confirmPage, inscription: registerPage
    };
    view.innerHTML = (routes[path] || (() => noFeature(path)))();
  }
  async function doAction(form) {
    const f = new FormData(form);
    const value = name => String(f.get(name) || '').trim();
    const pin = value('pin');
    const uuid = () => crypto.randomUUID();
    switch (form.dataset.action) {
      case 'scan': {
        const x = await api('loyalty/scan', {
          qrToken:value('qrToken'), pin, idempotencyKey:uuid(), purchaseConfirmed:true
        });
        return x.credited ? 'Passage crédité. Total actuel : ' + x.visitCount : 'Crédit refusé : ' + (x.reason?.kind || 'règle de fidélité');
      }
      case 'confirm': {
        const x = await api('loyalty/enrollment/confirm', {
          claimToken:value('claimToken'), pin, idempotencyKey:uuid(),
          customerPresent:true, purchaseConfirmed:true,
        });
        return { message: x.firstVisitCredited ?
          'Premier passage enregistré. Remettez ce QR personnel directement au client.' :
          'Confirmation non terminée.', qrToken:x.qrToken };
      }
      case 'redeem': {
        const x = await api('loyalty/redeem', {
          qrToken:value('qrToken'), pin, idempotencyKey:uuid(),
          expectedCycleNumber:Number(value('expectedCycleNumber')), giftHandedOver:true
        });
        return x.redeemed ? 'Récompense remise et enregistrée.' : 'Remise refusée : ' + (x.reason?.kind || 'cycle non valide');
      }
      case 'program': {
        const x = await api('loyalty/programs/update', {
          programId:value('programId'), pin, threshold:Number(value('threshold')),
          status:value('status'), notificationsEnabled:f.has('notificationsEnabled')
        });
        return x.updated ? 'Programme mis à jour.' : 'Modification refusée.';
      }
      case 'register': {
        const x = await api('loyalty/customers/register', {
          firstName:value('firstName'), programId:value('programId'),
          pin, idempotencyKey:uuid(), privacyAccepted:true, customerPresent:true
        });
        // QR brut uniquement dans la réponse HTTP et ce DOM éphémère, jamais stocké.
        return { message: 'Carte créée, 0 passage crédité automatiquement.', qrToken: x.qrToken };
      }
      case 'activate-staff': {
        if (!/^[0-9]{6,10}$/.test(pin)) throw new Error('PIN à 6–10 chiffres requis.');
        await api('loyalty/devices/activate', { pairingToken:value('pairingToken'), pin });
        return 'Appareil employé activé.';
      }
      case 'pair-device': {
        if (!/^[0-9]{6,10}$/.test(pin) || !s.identity?.merchantUserId) {
          throw new Error('PIN invalide ou identifiant employé indisponible.');
        }
        const x = await api('loyalty/devices/approve', {
          targetMerchantUserId:value('targetMerchantUserId') || s.identity.merchantUserId,
          ownerEmail:value('ownerEmail'), ownerPassword:value('ownerPassword')
        });
        await api('loyalty/devices/activate', { pairingToken:x.pairingToken, pin });
        return 'Cet appareil est maintenant approuvé. Conservez votre PIN.';
      }
      default: throw new Error('Action indisponible');
    }
  }
  view.addEventListener('submit', async e => {
    const form = e.target.closest('[data-action]');
    if (!form) return;
    e.preventDefault();
    const button = $('button[type=submit]', form);
    button.disabled = true;
    try {
      const result = await doAction(form);
      form.reset();
      await refresh();
      const feedback = document.createElement('p');
      feedback.setAttribute('role', 'status');
      feedback.textContent = typeof result === 'string' ? result : result.message;
      view.prepend(feedback);
      if (typeof result !== 'string' && result.qrToken) {
        const oneTime = document.createElement('p');
        oneTime.setAttribute('role', 'status');
        oneTime.style.overflowWrap = 'anywhere';
        oneTime.textContent = 'Jeton personnel à remettre directement au client (visible une seule fois) : ' + result.qrToken;
        feedback.after(oneTime);
      }
    } catch (err) {
      const feedback = document.createElement('p');
      feedback.setAttribute('role', 'alert');
      feedback.textContent = err.message;
      form.prepend(feedback);
    } finally { button.disabled = false; }
  });
  $$('.side__out').forEach(a => a.addEventListener('click', async e => {
    e.preventDefault();
    try { await api('auth/logout', {}); } catch (_) {}
    location.replace('../connexion.html');
  }));
  addEventListener('hashchange', render);
  view.textContent = 'Vérification de votre session…';
  load().then(render).catch(() => { view.textContent = 'Connexion indisponible. Rechargez la page.'; });
})();