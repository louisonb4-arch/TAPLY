import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (name: string) => readFileSync(root + name, 'utf8');

describe('UI Taply — aucun retour silencieux aux données fictives', () => {
  it('logo Taply officiel cohérent dans toutes les en-têtes', () => {
    // Le mot-symbole + petit accent vert en SVG proviennent de la nav
    // principale (index.html). Aucune substitution par « Taply. » ou « Taply’ ».
    const canonicalMark = 'M4.6 0h4.9L6 10.6C5 13.6 3.4 15.3 0 16l.8-2.3c1.6-.8 2.4-2 2.4-3.6V0Z';
    for (const file of [
      'index.html', 'connexion.html', 'creer-compte.html',
      'join.html', 'dashboard/index.html',
      'mentions-legales.html', 'cgu.html', 'cgv.html',
      'cookies.html', 'confidentialite.html', '404.html',
    ]) {
      const html = read(file);
      const markPosition = html.indexOf(canonicalMark);
      expect(markPosition, file).toBeGreaterThan(0);
      const logo = html.slice(Math.max(0,markPosition - 150),markPosition + canonicalMark.length + 20);
      expect(logo, file).toContain('Taply');
      expect(logo, file).toContain('<svg');
      expect(logo, file).not.toContain('Taply.');
      expect(logo, file).not.toContain('Taply’');
    }
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
