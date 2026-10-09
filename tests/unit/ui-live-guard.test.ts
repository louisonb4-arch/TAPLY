import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (name: string) => readFileSync(root + name, 'utf8');

describe('UI Taply — aucun retour silencieux aux données fictives', () => {
  it('logo Taply officiel cohérent dans toutes les en-têtes', () => {
    // Tous les anciens mots-symboles HTML ont été remplacés par le même
    // logo PNG validé, avec variante contrastée pour les fonds sombres.
    expect(statSync(root + 'images/taply-wordmark-noir.png').size).toBeGreaterThan(1000);
    expect(statSync(root + 'images/taply-wordmark-blanc.png').size).toBeGreaterThan(1000);
    let count = 0;
    for (const file of [
      'index.html', 'connexion.html', 'creer-compte.html',
      'join.html', 'dashboard/index.html',
      'mentions-legales.html', 'cgu.html', 'cgv.html',
      'cookies.html', 'confidentialite.html', '404.html',
    ]) {
      const html = read(file);
      const dark = (html.match(/class="logo__asset logo__asset--dark"/g) || []).length;
      const light = (html.match(/class="logo__asset logo__asset--light"/g) || []).length;
      expect(dark, file).toBeGreaterThan(0);
      expect(light, file).toBe(dark);
      expect(html, file).not.toMatch(/<svg class="logo__tick"/);
      count += dark;
    }
    expect(count).toBe(22);
  });
  it('le dashboard public charge seulement le script connecté', () => {
    const page = read('dashboard/index.html');
    expect(page).toContain('src="live.js"');
    expect(page).not.toContain('src="data.js"');
    expect(page).not.toContain('src="app.js"');
  });
  it('le formulaire de connexion exige une réponse du serveur', () => {
    const login = read('connexion.html');
    expect(login).toContain("fetch('/api/auth/login'");
    expect(login).toContain('if (!res.ok) throw');
    expect(login).not.toContain("location.href = 'dashboard/");
    expect(login).not.toContain("n'importe quel e-mail");
  });

  it('la carte client ne stocke aucun jeton et n’envoie jamais de jeton dans une URL', () => {
    const js = read('js/carte.js');
    expect(js).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(js).not.toMatch(/firstName|prénom|email/i);
    // Le QR personnel n'apparaît que dans une image locale (blob), jamais dans l'URL.
    expect(js).toContain('URL.createObjectURL(new Blob([r.data.qrSvg]');
    // Les paramètres SUN de la puce sont retirés de l'historique dès la lecture.
    expect(js).toContain("history.replaceState(null, '', location.pathname)");
    expect(js).toContain('Aucun passage n’a été ajouté');
    for (const page of ['join.html', 'carte.html', 't.html']) {
      expect(read(page), page).toContain('src="js/carte.js"');
      expect(read(page), page).toContain('name="referrer" content="no-referrer"');
    }
  });
  it('la page réelle exige auth/me et refuse le mode démo/localStorage', () => {
    const live = read('dashboard/live.js');
    expect(live).toContain("api('auth/me')");
    expect(live).toContain("api('loyalty/dashboard')");
    expect(live).toContain("api('loyalty/customers'");
    expect(live).not.toMatch(/\b(?:localStorage|sessionStorage)\.(?:getItem|setItem|removeItem)|\bTAPLY_DEMO\b|data\.demo/);
    expect(live).toContain('Aucune donnée inventée');
    // Le scanner ne crédite qu'après une action explicite de l'employé.
    expect(live).toContain("api('loyalty/card/lookup'");
    expect(live).toContain('Achat constaté — valider le passage');
  });
});
