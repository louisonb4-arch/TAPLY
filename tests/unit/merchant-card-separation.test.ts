import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(new URL('../../' + name, import.meta.url), 'utf8');

describe('Carte unique par commerce, identifiants propres aux clients', () => {
  it('propose la carte commune dans les menus desktop et mobile', () => {
    const html = read('dashboard/index.html');
    expect((html.match(/href="#\/carte" data-nav="carte"/g) ?? []).length).toBe(2);
    expect(html).toContain('>Ma carte</a>');
  });

  it('la carte commune ne demande aucune donnée client et ne crée aucune carte', () => {
    const js = read('dashboard/live.js');
    const page = js.slice(js.indexOf('  function programPage() {'), js.indexOf('  /* ---- Clients'));
    expect(page).toContain('Une carte commune à tous vos clients');
    expect(page).not.toContain('firstName');
    expect(page).not.toContain("api('loyalty/customers/register'");
    expect(js).not.toContain('customers/register');
  });

  it('le commerçant n’inscrit jamais de client à la main : inscription par le client via le QR', () => {
    const js = read('dashboard/live.js');
    expect(js).toContain("case 'demarrage': html = onboarding()");
    expect(js).toContain("case 'carte': html = programPage()");
    expect(js).toContain('Cartes anonymes : aucun nom, e-mail ni téléphone');
  });
});
