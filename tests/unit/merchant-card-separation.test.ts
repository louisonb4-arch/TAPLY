import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(new URL('../../' + name, import.meta.url), 'utf8');

describe('Carte unique par commerce, identifiants propres aux clients', () => {
  it('propose la carte commune dans les menus desktop et mobile', () => {
    const html = read('dashboard/index.html');
    expect((html.match(/href="#\/carte" data-nav="carte"/g) ?? []).length).toBe(2);
    expect(html).toContain('>Ma carte</a>');
  });

  it('la vue modèle n’exige aucun prénom et ne crée pas de carte client', () => {
    const js = read('dashboard/live.js');
    const template = js.slice(js.indexOf('  function cardTemplate() {'), js.indexOf('  function configCard() {'));
    expect(template).toContain("s.homeData?.program");
    expect(template).toContain('Identifiant client');
    expect(template).not.toContain('firstName');
    expect(template).not.toContain("api('loyalty/");
    expect(template).not.toContain('data-action="register"');
    expect(js).not.toContain("return header('Créer une carte'");
  });

  it('distingue explicitement inscription de client et règles du commerce', () => {
    const js = read('dashboard/live.js');
    expect(js).toContain("return header('Inscrire un client'");
    expect(js).toContain("return header('Règles de ma carte'");
    expect(js).toContain("first_card: { title: 'Inscrire un premier client'");
    expect(js).toContain("route: 'inscription'");
    expect(js).toContain("carte: cardTemplate");
    expect(js).toContain("api('loyalty/customers/register'");
  });
});
