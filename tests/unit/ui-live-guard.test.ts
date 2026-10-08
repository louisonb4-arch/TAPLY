import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (name: string) => readFileSync(root + name, 'utf8');

describe('UI Taply — aucun retour silencieux aux données fictives', () => {
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
