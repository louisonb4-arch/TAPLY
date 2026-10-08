# Taply — Section « Dashboard commerçant » avec MacBook au scroll

## Objectif et portée
- Remplace **uniquement** l'ancienne section marketing « Notifications personnalisées » entre « Avantages » et « Tarifs », par une présentation du dashboard commerçant.
- Fond blanc et typographie Taply (Satoshi, noir, vert, gris), même structure éditoriale que les sections voisines.
- Titre approuvé « Piloter votre fidélité, mesurer ce qui compte », 3 bénéfices, MacBook en CSS 3D.
- L'écran utilise `images/dashboard-real-demo-preview.png`, capture réelle du dashboard Taply existant sur `taply-theta.vercel.app/dashboard/#/accueil`. **Il contient des données de démonstration, pas des performances réelles.** La légende marketing le précise.
- Le capot s'ouvre de manière réversible au défilement, synchronisée au scroll par `requestAnimationFrame`, et reste ouvert en mobile / `prefers-reduced-motion`.
- Aucune bibliothèque externe ajoutée. Aucun changement aux routes API, à l'authentification, aux tables Supabase ou à l'infrastructure.

## Contrôles
- `npm run check` et `npm run build:static`.
- `TAPLY_TEST_SITE_URL=<serveur local> playwright test dashboard-story.spec.ts` : 8 tests navigateur desktop+mobile (texte, image, ouverture et retour, réduction des animations, zéro scroll horizontal).
- Page connexion en branche de développement : `Pas encore de compte ? Créer un compte` et `creer-compte.html` existent déjà. **Ce parcours n'est pas porté sur la branche `main` de production.**
- Le commit est destiné à une **préproduction contrôlée** avant décision sur la production.
