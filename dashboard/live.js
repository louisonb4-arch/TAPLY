/* Taply dashboard LIVE — toutes les données proviennent des routes API authentifiées.
 * Aucune donnée inventée, aucun jeton/PIN/session dans localStorage.
 * Les fonctions non livrées sont annoncées comme indisponibles, jamais simulées.
 */
(() => {
  'use strict';
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const view = $('#view');
  const s = { principal: null, identity: null, merchant: null, programs: [], customers: [], security: null, homeData: null, error: null,
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
        ${name === 'pin' ? 'inputmode="numeric" pattern="[0-9]{6,10}" minlength="6" maxlength="10"' : ''}
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
    s.merchant = null;
    s.programs = [];
    s.customers = [];
    s.security = null;
    s.homeData = null;
    s.customersError = null;
    s.securityError = null;
    s.principal = await api('auth/me');
    try { s.merchant = await api('loyalty/merchant'); } catch (_) {}
    if (s.principal.role !== 'owner') {
      try { s.identity = await api('loyalty/identity'); } catch (_) {}
      return;
    }
    const results = await Promise.allSettled([
      api('loyalty/overview'), api('loyalty/customers'),
      api('loyalty/security'), api('loyalty/identity'), api('loyalty/home'),
    ]);
    if (results[0].status === 'fulfilled') s.programs = results[0].value.programs;
    else s.error = results[0].reason.message;
    if (results[1].status === 'fulfilled') s.customers = results[1].value.customers;
    else s.customersError = results[1].reason.message;
    if (results[2].status === 'fulfilled') s.security = results[2].value;
    else s.securityError = results[2].reason.message;
    if (results[3].status === 'fulfilled') s.identity = results[3].value;
    if (results[4].status === 'fulfilled') s.homeData = results[4].value;
  }
  async function refresh() {
    s.error = null; await load(); render();
  }
  const program = () => s.programs[0];
  function home() {
    const h = s.homeData;
    if (!h) return header('Accueil', 'Votre programme de fidélité') +
      msg('Accueil temporairement indisponible', 'Les données de démarrage ne peuvent pas être chargées. Réessayez dans un instant.') +
      link('Modifier le programme', 'parametres/carte');
    const labels = {
      program: { title: 'Vérifier ma carte', detail: 'La carte commune à tous vos clients', route: 'carte' },
      staff_device: { title: 'Approuver un appareil', detail: 'Sécuriser les validations au comptoir', route: 'parametres/integrations' },
      first_card: { title: 'Inscrire un premier client', detail: 'Une même carte, un identifiant différent par client', route: 'inscription' },
      first_visit: { title: 'Valider une première visite', detail: 'Après achat, sur un appareil approuvé', route: 'scan' },
    };
    const steps = h.onboarding.steps.map(step => {
      const item = labels[step.id];
      if (!item) return '';
      return `<div class="row" style="padding:1rem 0;border-bottom:1px solid #e8e8e4;gap:1rem;align-items:center">
        <span aria-label="${step.completed ? 'Terminé' : 'À faire'}" style="min-width:1.8rem;font-weight:700;color:${step.completed ? '#34853e' : '#636a65'}">${step.completed ? '✓' : '○'}</span>
        <span class="row__main"><strong>${esc(item.title)}</strong><small>${esc(item.detail)}</small></span>
        ${step.completed ? '<span>Terminé</span>' : link('Commencer', item.route)}</div>`;
    }).join('');
    const cards = [
      ['Cartes inscrites', h.stats.cardsRegistered],
      ['Visites validées', h.stats.visitsValidated],
      ['Récompenses en attente', h.stats.rewardsPending],
      ['Récompenses remises', h.stats.rewardsRedeemed],
    ].map(([label, value]) => `<div class="card kpi"><span class="kpi__label">${esc(label)}</span>
      <strong class="kpi__value">${esc(value)}</strong></div>`).join('');
    const activities = h.recentActivity.map(item => `<p style="margin:.7rem 0">
      ${esc(fmt(item.happenedAt))} — ${item.kind === 'visit' ? 'Visite validée' : 'Récompense remise'}</p>`).join('');
    const current = h.program;
    return header('Bienvenue sur Taply', 'Voici les prochaines étapes pour utiliser votre programme de fidélité.') +
      `<section class="card" data-onboarding style="padding:1.5rem">
        <div class="row" style="justify-content:space-between;gap:1rem;align-items:center">
          <h2 style="margin:0">Démarrage de votre commerce</h2>
          <strong>${esc(h.onboarding.completed)} / ${esc(h.onboarding.total)} étapes</strong>
        </div>
        <p>Terminez les étapes utiles pour accueillir vos premiers clients.</p>
        <progress value="${esc(h.onboarding.completed)}" max="${esc(h.onboarding.total)}" style="width:100%;accent-color:#34853e"></progress>
        ${steps}
      </section>
      <section class="kpis" aria-label="Statistiques du commerce" style="margin-top:1.2rem">${cards}</section>
      <section class="grid" style="margin-top:1.2rem">
        <div class="card" style="padding:1.5rem"><h2>Programme actuel</h2>
          ${current ? `<p><strong>${esc(current.name)}</strong> — ${current.status === 'active' ? 'Actif' : 'En pause'}</p>
            <p>${esc(current.threshold ?? '—')} passages pour obtenir une récompense</p>` :
            '<p>Aucun programme configuré.</p>'}
          ${link('Voir ma carte', 'carte')}
        </div>
        <div class="card" style="padding:1.5rem"><h2>Sécurité au comptoir</h2>
          <p>${esc(h.devices.usableCount)} appareil(s) approuvé(s) et utilisable(s).</p>
          <p>Le statut physique du présentoir NFC n’est pas encore vérifiable automatiquement.</p>
          ${link('Gérer les appareils', 'parametres/integrations')}
        </div>
      </section>
      <section class="card" style="padding:1.5rem;margin-top:1.2rem">
        <h2>Activité récente</h2>
        ${activities || '<p>Aucune activité pour le moment. Les visites et les récompenses apparaîtront ici après validation.</p>'}
      </section>`;
  }
  function customers() {
    if (s.customersError) return header('Clients', 'Données réelles uniquement') +
      msg('Liste indisponible', s.customersError);
    const rows = s.customers.map(c => `<li class="row" style="padding:1rem;border-bottom:1px solid #e5e5e5">
      <span class="row__main"><strong>${esc(c.firstName)}</strong>
        <small>${esc(c.programName)} · ${esc(plural(c.visitCount, 'passage'))} / ${esc(c.threshold ?? '—')}
        ${c.rewardPending ? ' · 🎁 Cadeau en attente' : ''}</small></span>
      <span class="row__end">${esc(fmt(c.lastVisitAt))}</span></li>`).join('');
    return header('Clients', 'Chaque client possède son propre identifiant lié à la même carte du commerce.') +
      `<section class="card card--flush"><ul class="list">${rows || '<li class="row">Aucun client inscrit pour le moment.</li>'}</ul></section>` +
      `<div style="margin-top:1rem">${link('Inscrire un client au comptoir', 'inscription')}</div>`;
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
      `<div class="grid">${link('Ma carte', 'carte')}
        ${link('Règles de fidélité', 'parametres/carte')}
        ${link('Statistiques', 'statistiques')}
        ${link('Appareils et sécurité', 'parametres/integrations')}</div>`;
  }
  /**
   * La carte « commerce » est le programme commun déjà provisionné.
   * Aucun prénom, inscription ni jeton personnel n'est émis sur cette page.
   */
  function cardTemplate() {
    const model = s.homeData?.program || s.programs.find(p => p.status === 'active') || s.programs[0];
    if (!model) return header('Ma carte', 'La carte commune à vos clients') +
      msg('Aucun programme trouvé', 'Votre programme de fidélité est indisponible. Rechargez la page ou contactez le support.');
    const name = s.merchant?.name || 'Mon commerce';
    const threshold = Number.isInteger(model.threshold) && model.threshold >= 3 && model.threshold <= 10
      ? model.threshold : null;
    const stamps = threshold === null ? '' : Array.from({ length: threshold }, () =>
      '<span class="merchant-card-stamp" aria-hidden="true"></span>').join('');
    return header('Ma carte de fidélité', 'La même carte pour tous vos clients. Seul leur identifiant et leur progression changent.') +
      `<section class="merchant-template card" aria-label="Modèle de la carte du commerce">
        <div>
          <div class="merchant-template__visual" aria-label="Aperçu illustratif, non utilisable comme carte client">
            <span class="merchant-template__eyebrow">CARTE DE FIDÉLITÉ</span>
            <strong class="merchant-template__name">${esc(name)}</strong>
            <span class="merchant-template__program">${esc(model.name)}</span>
            <div class="merchant-template__stamps" aria-label="${threshold === null ? 'Seuil indisponible' : threshold + ' passages nécessaires'}">${stamps}</div>
            <div class="merchant-template__bottom">
              <small>Modèle du commerce</small><small>Taply</small>
            </div>
          </div>
          <p class="merchant-template__note">Aperçu illustratif de la carte du commerce. Les cartes Wallet natives ne sont pas encore émises dans cette version.</p>
        </div>
        <div class="merchant-template__content">
          <span class="badge ${model.status === 'active' ? '' : 'badge--muted'}">${model.status === 'active' ? 'Programme actif' : 'Programme en pause'}</span>
          <h2>Une carte, tous vos clients.</h2>
          <p>Ce modèle appartient à votre commerce. Vous le configurez une seule fois. Chaque client inscrit reçoit sa propre carte liée à ce programme, avec un identifiant sécurisé et un compteur de passages indépendant.</p>
          <div class="merchant-template__info">
            <div><span>Passages requis</span><strong>${esc(threshold ?? 'À configurer')}</strong></div>
            <div><span>Identifiant client</span><strong>Unique pour chacun</strong></div>
          </div>
          ${link('Modifier les règles de la carte', 'parametres/carte')}
        </div>
      </section>
      <section class="card" style="margin-top:1rem;padding:1.5rem">
        <h2>Comment les clients obtiennent-ils cette carte ?</h2>
        <p>Le programme est identique pour tous. Lorsqu’un client s’inscrit, Taply lui attribue un identifiant et un QR personnel distincts. Scanner le présentoir public ne crédite pas automatiquement une visite : la validation reste faite par votre équipe.</p>
        <div style="margin-top:1rem">${link('Voir les clients inscrits', 'clients')}</div>
      </section>`;
  }

  function configCard() {
    return header('Règles de ma carte', 'Ces paramètres définissent le programme commun à tous vos clients. Le seuil ne peut changer qu’une fois tous les 30 jours.') +
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
        <p>L’appareil utilisé maintenant sera associé automatiquement à votre compte propriétaire.</p>
        ${field('ownerEmail', 'Adresse e-mail de connexion', 'email')}
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
    return header('Inscrire un client', 'Le modèle de carte est déjà créé pour le commerce. Cette action attribue un identifiant unique à un client.') +
      `<div class="card" style="margin-bottom:1rem"><p>Inscription manuelle au comptoir : actuellement, un prénom est requis pour la fiche client. L’inscription automatique par le présentoir est un parcours distinct en préparation.</p>
      ${link('Voir la carte du commerce', 'carte')}</div>
      <form data-action="register" class="card" style="padding:1.5rem">
      ${field('firstName', 'Prénom du client (inscription manuelle)')}
      <label style="display:grid;gap:.4rem">Programme
        <select class="input" name="programId" required>
          ${s.programs.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}
        </select></label>
      ${field('pin', 'PIN de l’appareil', 'password')}
      <label><input type="checkbox" name="privacyAccepted" required> Le client accepte le traitement des données de fidélité.</label>
      <label><input type="checkbox" name="customerPresent" required> Le client est présent.</label>
      ${btn('Inscrire ce client')}</form>
      ${msg('Remise au client', 'Le QR personnel doit être remis directement au client. La création de pass Wallet natif reste en attente des comptes émetteurs.')}`;
  }
  function noFeature(page) {
    if (page === 'notifications') return header('Notifications', 'Préférences seulement') +
      msg('Envoi non activé', 'Les notifications réelles et les emails ne sont pas encore implémentés. Activez les préférences dans Paramètres > Carte.');
    return header('À venir', 'Module non encore connecté') +
      msg('Fonction indisponible', 'Cette page ne présente aucune donnée fictive. Elle sera activée après certification.');
  }
  function render() {
    const name = s.merchant?.name || 'Espace de fidélité';
    $$('[data-merchant-name]').forEach(node => { node.textContent = name; });
    $$('[data-merchant-city]').forEach(node => { node.textContent = 'Compte vérifié'; });
    $$('[data-merchant-logo]').forEach(node => { node.textContent = name.slice(0,1).toUpperCase(); });
    $$('[data-merchant-initial]').forEach(node => { node.textContent = name.slice(0,1).toUpperCase(); });
    $$('[data-nfc-status]').forEach(node => { node.textContent = 'Non configuré'; });
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
      accueil: home, carte: cardTemplate, clients: customers, recompenses: rewards, statistiques: stats,
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
        return { message: 'Client inscrit : identifiant et QR personnel générés. Aucun passage crédité automatiquement.', qrToken: x.qrToken };
      }
      case 'activate-staff': {
        if (!/^[0-9]{6,10}$/.test(pin)) throw new Error('PIN à 6–10 chiffres requis.');
        await api('loyalty/devices/activate', { pairingToken:value('pairingToken'), pin });
        return 'Appareil employé activé.';
      }
      case 'pair-device': {
        if (!/^[0-9]{6,10}$/.test(pin)) {
          throw new Error('Choisissez un code PIN contenant uniquement 6 à 10 chiffres.');
        }
        // Le backend dérive automatiquement l'identité du propriétaire depuis sa session.
        const x = await api('loyalty/devices/approve', {
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