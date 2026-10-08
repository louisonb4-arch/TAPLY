# Taply QR V1 — état de livraison (préproduction uniquement)

Date : 2026-10-08. Branche `feat/taply-qr-v1-20261008`.

## Fonctionnalités codées

- Merchant `#/demarrage`: établissement prérempli, 5–10 passages, récompense/conditions, couleurs, sauvegarde et publication, QR SVG propriétaire et téléchargement.
- Token QR public : généré au provisioning et backfill compte existant; inactif jusqu'à la publication (migration 10011). Même lien pour NFC et impression.
- Public `join.html?code=...` : affichage programme, adhésion anonyme sans prénom/e-mail/téléphone, 0 passage, retour sur même navigateur via cookie HttpOnly, QR personnel généré à la présentation, code de récupération facultatif.
- Séparation carte commerce / client, PIN & approbation d'appareil toujours requis pour enregistrer un achat. Aucun passage attribué au scan public.
- Tables dédiées pour publication, sessions anonymes, récupération et tentatives, FORCE RLS par tenant et champs strictement limités.

## Validation exécutée

- `npm run check` : **547 PASS / 0 FAIL** (dont test PostgreSQL PGlite local réel pour migrations 10010–10012, publication, inscription, QR, récupération, isolation et révocation).
- `node scripts/qr-v1-browser-smoke.mjs` : formulaires merchant/client desktop + mobile, zéro erreur JS, pas de débordement; mocks explicites pour API navigateur.
- Supabase staging `jfkcrpbrdrzwhjtkdmxx`: migrations 10011/10012 appliquées; historique distant concordant. Migration 10010 déjà présente avant cette étape.
- Drapeau `TAPLY_QR_ANONYMOUS_V1=enabled` ajouté à Vercel Preview uniquement. Publication / création anonymes impossibles en production avec le double verrou `APP_ENV/VERCEL_ENV`.

## Points qui restent avant production

- Tests bout en bout authentifiés sur staging avec un compte commerçant réel et un mobile client réel. Les tests API locaux ne remplacent pas cette validation.
- Sécurité publique : WAF/défi adaptatif contre inscriptions distribuées, limites et rétention de données, politique de confidentialité, demande de suppression de carte.
- Concurrence navigateur sans cookie : un même visiteur qui déclenche deux premières requêtes simultanément peut encore avoir deux adhésions. Renforcer la déduplication serveur avant production.
- Mot de récupération : 100 bits, secret affiché une fois, rotation à récupération; WAF recommandé pour contrecarrer l'épuisement délibéré du quota commun.
- Wallet natif, notifications et personnalisation du logo hors du lot QR Web.
- L'export de sauvegarde via Supabase CLI demande Docker, indisponible sur le Mac. Aucun point PITR vérifié ; les migrations appliquées sont uniquement additives.
- Render : aucun déploiement ni connecteur direct vérifié; API Taply actuelle déployée sur Vercel.

## Invariants de sécurité

- Public QR token non secret : inscription seulement.
- Staff QR client 256 bits : présentation seulement; visites toujours appareil approuvé, PIN, confirmation achat, délai serveur 2h et idempotence.
- Cookies client indépendants par programme, Secure sur Preview/Production, HttpOnly, SameSite Strict. Code de récupération jamais stocké en clair.
- Routes QR expérimentales explicitement désactivées dans la production via checkPreview.
- Ne pas modifier les données client ni migrer la production sans nouvelle certification.

## Fin de lot

Le parcours en préproduction doit être testé par le commerçant : `dashboard/#/demarrage` puis télécharger QR, l'ouvrir depuis un autre navigateur et confirmer carte à 0/7 et récupération. N'activer production qu'après traitements des points ci-dessus.
