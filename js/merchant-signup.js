/**
 * Espace commerçant : démarrage du paiement Stripe sans compte et
 * formulaire de création du compte. Partagé par creer-compte.html et
 * activer.html. Aucun secret ni jeton côté navigateur : le serveur
 * redirige vers Stripe et Supabase envoie l'e-mail de confirmation.
 */
(() => {
  'use strict';

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  async function postJson(path, body) {
    return fetch(path, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  }

  /** Bouton « Payer et commencer » : redirection directe vers Stripe. */
  function initStart(button, { onUnavailable, error }) {
    button.addEventListener('click', async () => {
      if (error) error.hidden = true;
      button.disabled = true;
      try {
        const res = await postJson('/api/billing/start');
        if (res.status === 503) { onUnavailable?.(); button.disabled = false; return; }
        if (!res.ok) {
          throw new Error(res.status === 429
            ? 'Trop de tentatives. Réessayez dans quelques minutes.'
            : 'Le paiement n’a pas pu démarrer. Réessayez.');
        }
        const data = await res.json();
        if (typeof data.redirect !== 'string' || !data.redirect.startsWith('https://')) throw new Error('Réponse inattendue.');
        window.location.assign(data.redirect);
      } catch (err) {
        if (error) { error.textContent = err.message; error.hidden = false; }
        button.disabled = false;
      }
    });
  }

  /** Formulaire de création du compte (nom du commerce, e-mail, mot de passe). */
  function initSignup(form, { error, result, resultEmail }) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.hidden = true;
      const field = (name) => form.elements.namedItem(name);
      const email = field('email').value.trim();
      const businessName = field('businessName').value.trim();
      const password = field('password').value;
      const passwordConfirm = field('passwordConfirm').value;
      const termsAccepted = field('termsAccepted').checked;
      if (businessName.length < 2 || businessName.length > 80 || !EMAIL_RE.test(email) ||
          password.length < 12 || password.length > 128 || password !== passwordConfirm || !termsAccepted) {
        error.textContent = password !== passwordConfirm
          ? 'Les mots de passe ne correspondent pas.'
          : 'Vérifiez les champs, le mot de passe (12 caractères minimum) et les conditions.';
        error.hidden = false;
        return;
      }
      const button = form.querySelector('button[type=submit]');
      button.disabled = true;
      try {
        const res = await postJson('/api/auth/signup', { businessName, email, password, termsAccepted });
        if (!res.ok) {
          throw new Error(res.status === 429 ? 'Trop de demandes. Réessayez dans quelques minutes.'
            : res.status === 503 ? 'Les inscriptions sont temporairement indisponibles.'
            : 'Inscription impossible. Réessayez.');
        }
        field('password').value = '';
        field('passwordConfirm').value = '';
        if (resultEmail) resultEmail.textContent = email;
        form.hidden = true;
        result.hidden = false;
        result.focus?.();
      } catch (err) {
        field('password').value = '';
        field('passwordConfirm').value = '';
        error.textContent = err.message;
        error.hidden = false;
        button.disabled = false;
      }
    });
  }

  /** Relit le paiement auprès du serveur (qui le relit chez Stripe). */
  async function lookupPayment(sessionId) {
    const res = await fetch('/api/billing/start/' + encodeURIComponent(sessionId), {
      credentials: 'same-origin', cache: 'no-store',
    });
    if (res.status === 404) return { state: 'unknown' };
    if (!res.ok) return { state: 'error' };
    const data = await res.json();
    return data.paid === true && typeof data.email === 'string'
      ? { state: 'paid', email: data.email } : { state: 'pending' };
  }

  window.TaplySignup = Object.freeze({ initStart, initSignup, lookupPayment });
})();
