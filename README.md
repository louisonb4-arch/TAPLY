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

## Backend (phase 1 — socle)

API Hono en TypeScript strict, servie par **une seule Vercel Function** (`api/index.ts`). Le site statique n'est jamais servi par Hono.

```
api/index.ts                 Vercel Function (export default { fetch })
backend/core/                config (zod), erreurs, logger structuré, masquage des secrets
backend/http/                app Hono (/api/*), requestId, en-têtes de sécurité, routes
scripts/build-static.mjs     copie la LISTE BLANCHE du site public dans dist/
tests/unit|integration       vitest
tests/visual                 non-régression visuelle avant/après (Playwright)
```

- **Routage Vercel** (`vercel.json`) : `framework: null` (pas de détection Hono), `outputDirectory: dist`, puis : fichiers statiques → `/api/*` vers la Function → tout le reste en **404** (`404.html`).
- **Pourquoi `dist/`** : avec le preset « Other », Vercel sert tout le dossier de sortie ; servir la racine exposerait `backend/`, `tests/`, `tsconfig.json`… `dist/` ne contient que la liste blanche (`PUBLIC_ENTRIES`). **Tout nouveau fichier public doit y être ajouté** (un test échoue sinon).
- **Ne jamais créer de dossier `public/`** à la racine.
- Endpoint : `GET /api/health` → `{ status, service, time, requestId }`, en-tête `X-Request-Id`.

Commandes :

```bash
npm install
npm run typecheck      # tsc strict (backend, scripts, tests visuels)
npm test               # unitaires + intégration (vitest)
```

### Développement local

| Commande | Ce qui tourne | URL |
|---|---|---|
| `npm run dev:api` | API seule : la vraie app Hono via `api/index.ts` | http://127.0.0.1:3000/api/health |
| `npm run dev` | build `dist/` puis site + API sur la même origine, même routage que `vercel.json` (statique → `/api/*` → 404 `404.html`) | http://127.0.0.1:3000/ |
| `npm run build:static` | reconstruit `dist/` (repart toujours d'un dossier vide) | — |

- `PORT=4000 npm run dev:api` pour changer de port. Écoute uniquement sur `127.0.0.1`.
- Rechargement automatique de l'API (`node --watch`). En mode `dev`, une modification du site demande de relancer (le site est servi depuis `dist/`).
- Aucune compilation : Node 24 exécute le TypeScript directement (suppression native des types, `erasableSyntaxOnly` dans `tsconfig.json`) ; `scripts/dev-ts-hooks.mjs` résout les imports `./x.js` vers `./x.ts`.
- Seule dépendance ajoutée : `@hono/node-server` (adaptateur Node officiel de Hono, devDependency, aucune dépendance propre). Jamais utilisé par Vercel.
- `vercel dev` n'est pas utilisé : il n'émule pas la Function quand `buildCommand`/`outputDirectory` sont définis.

### Non-régression visuelle

Compare deux versions servies en direct, **au pixel près (tolérance 0)** :

```bash
SITE_DIR=/chemin/vers/version-de-reference PORT=4410 node --import ./scripts/dev-ts-hooks.mjs scripts/dev-server.ts
PORT=4411 npm run dev
BEFORE_URL=http://127.0.0.1:4410 AFTER_URL=http://127.0.0.1:4411 npm run test:visual
```
