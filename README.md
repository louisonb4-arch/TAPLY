# Taply — site vitrine

HTML/CSS/JS vanilla, sans build. Aperçu local : `python3 -m http.server 4330` puis http://localhost:4330

## Remplacer les images
1. Déposer les fichiers dans `images/`.
2. Renseigner le chemin dans `js/config.js` → `images.hero = "images/hero.jpg"`, etc.
   Vide = placeholder affiché. Formats conseillés indiqués en commentaire.
3. Si la photo hero montre déjà le téléphone : `heroDevice: false`.
4. Vidéo démo : `demoVideo` (mp4 local ou URL embed YouTube/Vimeo).
5. OG / favicon : `images/og.jpg` (1200×630), `images/favicon.svg`, `images/apple-touch-icon.png` (180×180).

## Modifier l'identité
Tout est dans `css/tokens.css` (couleurs, typo, espacements, rayons, ombres, mouvement).

## En ligne
- Production : https://taply-theta.vercel.app (Vercel, compte louisondu44000-7822) — redéployer : `npx vercel deploy --prod`
- GitHub : https://github.com/louisonb4-arch/TAPLY
- Lighthouse prod (2026-10-04) : mobile 92 / desktop 98 en performance, 100 en accessibilité, bonnes pratiques et SEO.
- Domaine définitif : remplacer `taply-theta.vercel.app` dans index.html (canonical, og:*), sitemap.xml et robots.txt.
- Images : chaque photo `x.webp` a une version `x-800.webp` servie aux petits écrans.

## À confirmer avant mise en ligne
- Domaine (canonical / og:url), e-mail `contact@taply.fr`, URLs réseaux sociaux
- Section Notifications : chiffre « 248 » et messages = exemples fictifs (commerce « Le Comptoir »)
- Compatibilité téléphones (FAQ), prix du badge au-delà des 50 premiers
- Pages légales : champs `[…]` surlignés en vert
- Formulaires : `formEndpoint` / `newsletterEndpoint` dans config.js (sinon envoi simulé)

## Espace commerçant (prototype)
- `connexion.html` : page de connexion (lien « Connexion » dans la nav du site). **Aucune authentification réelle** : n'importe quel identifiant ouvre la démo.
- `dashboard/` : tableau de bord (Accueil, Clients, fiche client, Récompenses, Nouvelle récompense, Notifications, Statistiques, Paramètres, Mon établissement, Ma carte, Intégrations).
  - Données de démo (Roll in Love, chiffres fictifs) : `dashboard/data.js` — à remplacer par l'API.
  - Les modifications faites dans la démo sont gardées dans le navigateur (localStorage) ; « Réinitialiser la démo » dans Paramètres.
  - Couleurs du commerce connecté : variables `--brand*` en haut de `dashboard/dashboard.css`.
  - Non indexé (`noindex`).
