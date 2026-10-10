import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read=(f:string)=>readFileSync(join(process.cwd(),f),'utf8');
const SITE=['index.html','connexion.html','creer-compte.html','activer.html','404.html','cgu.html','cgv.html','confidentialite.html','cookies.html','mentions-legales.html'];

describe('Espace Taply sans offres de démonstration',()=>{
  it('aucune demande ni contenu fictif dans le tunnel marketing',()=>{
    for(const f of SITE){
      expect(read(f).toLowerCase(),f).not.toMatch(/demander une démo|voir la démo|démo personnalisée|#demo|data-form|data-newsletter|data-video-open/);
    }
    expect(read('index.html')).toContain('id="inscription"');
    expect(read('index.html')).not.toContain('class="newsletter"');
    expect(read('index.html')).toContain('Créer un compte');
  });
  it('inscription et connexion réellement branchées au serveur, sans fallback fictif',()=>{
    expect(read('connexion.html')).toContain('href="creer-compte.html"');
    expect(read('connexion.html')).toContain("fetch('/api/auth/login'");
    // Paiement d'abord : Stripe via le serveur, puis compte (même e-mail) ; inscription seule toujours possible.
    expect(read('creer-compte.html')).toContain('src="js/merchant-signup.js"');
    expect(read('activer.html')).toContain('src="js/merchant-signup.js"');
    expect(read('js/merchant-signup.js')).toContain("postJson('/api/auth/signup'");
    expect(read('js/merchant-signup.js')).toContain("postJson('/api/billing/start')");
    expect(read('js/merchant-signup.js')).not.toMatch(/localStorage|sessionStorage|sk_(test|live)|rk_(test|live)/);
    expect(read('dashboard/live.js')).toContain("api('auth/me')");
    expect(read('dashboard/live.js')).not.toContain('window.TAPLY_DEMO');
  });
  it('préserve le bandeau de consentement aux cookies',()=>{
    expect(read('css/styles.css')).toContain('.cookie {');
    expect(read('index.html')).toContain('data-cookie');
  });
});
