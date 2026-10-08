import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const login = readFileSync(resolve(process.cwd(), 'connexion.html'), 'utf8');
const prefix = 'https://taply-staging-louisondu44000-7822.vercel.app';

describe('Connexion commerçant — pont explicite vers la préproduction', () => {
  it('remplace le lien de démonstration par la vraie inscription', () => {
    expect(login).toContain('Pas encore de compte ?');
    expect(login).toContain('Créer un compte</a>');
    expect(login).not.toContain('Demander une démo');
    expect(login).toContain(prefix + '/creer-compte.html');
  });
  it('ne demande ni identifiants ni mot de passe dans un faux formulaire public', () => {
    expect(login).not.toContain('data-login');
    expect(login).not.toContain('type="password"');
    expect(login).not.toContain("window.TAPLY_DEMO");
    expect(login).not.toContain('n\'importe quel e-mail');
  });
  it('fournit une connexion réelle pilotée sur le domaine Supabase de test', () => {
    expect(login).toContain(prefix + '/connexion.html');
    expect(login).toContain('Version d’essai');
    expect(login).toContain('environnement Supabase de test');
  });
});
