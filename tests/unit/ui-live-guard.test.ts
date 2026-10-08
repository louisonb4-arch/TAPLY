import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (name: string) => readFileSync(root + name, 'utf8');

describe('UI Taply — aucun retour silencieux aux données fictives', () => {
  it('section marketing : dashboard existant, aucun faux écran ou notifications anciennes', () => {
    const html = read('index.html');
    expect(html).toContain('id="dashboard-commercant"');
    expect(html).toContain('Piloter votre fidélité,');
    expect(html).toContain('mesurer</span> ce qui compte.');
    expect(html).toContain('images/dashboard-real-demo-preview.png');
    expect(html).toContain('données de démonstration');
    expect(html).not.toContain('section notify');
    const mainJs = read('js/main.js');
    expect(mainJs).toContain("const dashboardStory = $('[data-dashboard-story]')");
    expect(mainJs).toContain("addEventListener('scroll', requestMac, { passive: true })");
  });
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

  it('le QR public ne transmet jamais un jeton personnel dans les URLs ni le stockage', () => {
    const join = read('join.html');
    expect(join).toContain("fetch('/api/loyalty/enrollment/prepare'");
    expect(join).toContain('claimToken = data.claimToken');
    expect(join).not.toMatch(/localStorage|sessionStorage/);
    expect(join).toContain('Aucune visite n');
  });
  it('la page réelle exige auth/me et refuse le mode démo/localStorage', () => {
    const live = read('dashboard/live.js');
    expect(live).toContain("api('auth/me')");
    expect(live).toContain("api('loyalty/overview')");
    expect(live).toContain("api('loyalty/customers')");
    expect(live).not.toMatch(/\b(?:localStorage|sessionStorage)\.(?:getItem|setItem|removeItem)|\bTAPLY_DEMO\b/);
    expect(live).toContain('Aucune donnée fictive affichée');
  });
});
