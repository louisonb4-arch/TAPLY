import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const read = (file: string) => readFileSync(join(ROOT,file),'utf8');
const PAGES=['index.html','connexion.html','404.html','cgu.html','cgv.html',
  'confidentialite.html','mentions-legales.html','cookies.html','dashboard/index.html'];
const signup='https://taply-staging-louisondu44000-7822.vercel.app/creer-compte.html';

describe('Site Taply sans tunnel de démonstration', () => {
  it('aucune proposition, section, modale, ancre ou formulaire de démo sur les pages publiques', () => {
    for(const page of PAGES) {
      const html=read(page);
      expect(html.toLowerCase(),page).not.toMatch(/demander une démo|voir la démo|démonstration|démo personnalisée|#demo|data-video-open|data-form|data-newsletter/);
    }
    expect(read('index.html')).toContain('id="inscription"');
    expect(read('index.html')).toContain('Créer un compte');
    expect(read('index.html')).not.toContain('data-video');
    expect(read('index.html')).not.toContain('class="newsletter"');
  });
  it('tous les CTA commerciaux aboutissent à la vraie création de compte', () => {
    for(const file of ['index.html','404.html','cgu.html','cgv.html','confidentialite.html','cookies.html','mentions-legales.html']) {
      const html=read(file);
      expect(html,file).toContain(signup);
      expect(html,file).not.toContain('href="index.html#demo"');
    }
    expect(read('connexion.html')).toContain(signup);
  });
  it('aucun faux retour de formulaire ni vidéo fictive dans le JavaScript public', () => {
    for(const file of ['js/config.js','js/main.js']) {
      const js=read(file);
      expect(js,file).not.toMatch(/demoVideo|demoPoster|formEndpoint|newsletterEndpoint|data-video-open|data-form|data-newsletter/);
    }
  });
  it('ancien dashboard factice retiré, accès réel uniquement derrière authentification', () => {
    const dashboard=read('dashboard/index.html');
    expect(dashboard).toContain('/dashboard/#/accueil');
    expect(dashboard).toContain('taply-staging-');
    expect(readdirSync(join(ROOT,'dashboard')).sort()).toEqual(['index.html']);
    expect(dashboard).not.toContain('TAPLY_DEMO');
  });
  it('conserve les obligations d’information et une capture marketing honnête', () => {
    expect(read('index.html')).toContain('chiffres illustratifs');
    expect(read('index.html')).toContain('images/dashboard-interface.png');
    expect(read('css/styles.css')).toContain('.cookie {');
    expect(read('css/styles.css')).toContain('.switch input:checked + span');
  });
});
