# Taply QR V1 — plan de développement et contrat de certification

État : **préparation technique**. Branche `feat/taply-qr-v1-20261008`. Pas de changement distant autorisé avant tests, migration review et vérification de staging. Le cahier des charges produit validé est la source fonctionnelle.

## Résultat visé

1 carte-modèle / commerce et 1 QR public de recrutement par commerce, générés automatiquement et associés au programme. Le commerçant vérifie le nom, choisit 5 à 10 passages et une récompense textuelle, peut personnaliser sa carte, relit les conditions puis publie. Le commerçant n'inscrit pas manuellement les clients.
Un client ouvre le QR/NFC commun, accepte les conditions, clique 1 fois, reçoit une adhésion **anonyme** à **0 passage** et un QR personnel, sans prénom, e-mail, téléphone ni compte. Retrouver la carte dans le même navigateur sans doublon ; code de récupération facultatif à usage contrôlé.

## Audit repo effectué 2026-10-08

- `supabase/migrations/20261008100009_merchant_self_onboarding.sql` : RPC de création marchande crée commerce+owner+programme **active**, seuil **5**, sans établissement ni QR public. Nécessite versionnement sûr du RPC de provisioning.
- `20261007120004_locations.sql` : `locations` a `merchant_id`, `slug` unique par commerçant et `status`; rôle `taply_app` a seulement SELECT. Le lien QR public exige un établissement réel.
- `20261007120010_public_enrollment_links.sql` : `public_enrollment_links` a `public_token` en clair et `merchant_id`, `location_id`, `program_id`; son SELECT est limité par `app.lookup_token`/RLS. Pas de grants de création/rotation. Jeton documenté à 160 bits, mais génération self-service absente.
- `backend/db/lookup.ts` : résolution pré-tenant via `withTx`, `set_config('app.lookup_token')` puis WHERE paramétré. Conserver ce modèle ou le migrer avec audit complet des grants/RLS.
- `20261008100005_customer_profile_and_program_preferences.sql` : `customer_profiles.first_name NOT NULL` mais la table `customers` et `memberships` peut supporter une adhésion sans profil. **Ne pas inventer de prénom** ni forcer de profil.
- `backend/loyalty/enrollment.ts` : l'ancien prepare exige `firstName`, et confirm crée une carte puis crédite le **premier passage**. Ne pas réutiliser cette route pour la nouvelle adhésion anonyme immédiate à zéro.
- `backend/loyalty/qr-token.ts` : QR personnel aléatoire 256 bits, hash SHA-256 séparé par domaine, résolution sur tenant. Présentation, **jamais une authentification client**.
- `credit.ts`, `redeem.ts`, `staff-device.ts` : logique transactionnelle, idempotence, appareils/PIN, délai anti-fraude à maintenir.
- `dashboard/live.js` : `#/carte` affiche le modèle et `#/inscription` reste une inscription manuelle; UI cible doit prioriser setup/QR.

## Jalons et critères GO

### L1 — Publication marchande et QR public (premier lot)
- Ajouter de manière *additive* des métadonnées de publication (`reward_title` obligatoire avant publication, `terms` versionnés, `published_at` nullable, thème par défaut) liées au programme. Une seule source de vérité pour « publié ».
- Nouveau provisioning *idempotent* : établissement principal réel, lien public généré avec CSPRNG ≥160 bits, statut **inactive** jusqu'à publication. Ne pas publier le programme par le simple défaut `status=active`. Contrôle sous transaction et rôle minimisé.
- Compatibilité : comptes déjà créés non publiés si récompense absente, sans désactivation destructrice de leur historique ; état calculé par programme / publication, pas via UI.
- Contrat `GET /api/merchant/setup`, `PATCH /api/merchant/program`, `POST /api/merchant/program/publish`, `GET /api/merchant/enrollment-qr` ; authentification `owner` depuis session HttpOnly, Origin obligatoire pour POST/PATCH, RLS, validation stricte; lecture token QR uniquement pour propriétaire.
- GET public limité aux nom/conditions/seuil/récompense publiés ; interdit lecture token voisin, accès dashboard ou modification.
- QR HTTPS unique par marchand pour NFC et impression ; rotation volontaire future avec réédition obligatoire. Attention aux fuites par logs de chemin et Referer.
- Tests gates publication, zero leaks, isolation inter-marchands, concurrence provisioning, nouveau vs compte existant, migration sûre.

### L2 — Carte client anonyme
- `GET /api/public/j/:token` aucune écriture; `POST /api/public/j/:token/enroll` limité (IP/commerce/temps, défi adaptatif), retour carte existante si session client valide, sinon création atomique d'un `customers` sans `customer_profiles`, `memberships`, `membership_states` à **0**, QR personnel hashé distinct.
- Cookie anonyme Secure HttpOnly SameSite différent du cookie employé ; session issue d'un token aléatoire hashé, révocable, scindée par commerce ; TTL étudié; protection CSRF/Origin.
- Idempotence serveur, rate-limit transactionnel, aucune visite automatique, aucune carte duplicative sous double POST de même session/idempotency.

### L3 — Accès carte et récupération
- Lire la carte via session anonyme uniquement; pas d'exposition QR secret, profil ou historique d'autres adhésions.
- Générer facultativement code de récupération aléatoire (20 caractères Base32 non ambigu, ≥100 bits), stocké sous hash/HMAC séparé, affiché une fois, jamais loggé.
- Rotation atomique à la récupération, invalidation du précédent, limitation d'essais, réponses génériques. Pas de récupération par simple QR client ou UUID.
- Suppression/révocation du compte client compatible conservation réglementaire ; politiques rétention/consentement revues.

### L4 — Écrans prêts pour les commerces
- Setup 5 écrans, progression persistée : commerce prérempli, seuil+récompense, apparence optionnelle, conditions/publication, présentoir QR+PIN.
- Client mobile : page commerce, 1 CTA, carte web, bouton récupération facultatif, interface de retour. Apple/Google Wallet natifs et notifications explicitement hors V1.
- Aucun nom de client lors de « créer ma carte »; 0 donnée fictive.

### L5 — Certification staging
- `npm run check`, build, tests DB sur migration locale / base de test, tests RLS positifs/négatifs, concurrency, abus, reprise, expiration, accessibilité, navigateur iOS/Android.
- 2 vrais commerces isolés, premier QR jamais actif avant publication, nouveaux adhérents 0 passage, visite uniquement employee+device+PIN+achat confirmé.
- Stage *après* revue du diff SQL et backup; vérifier absence d'impact sur l'environnement vitrine/production. **Pas de déploiement Render/production automatique**.

## Risques bloquants à traiter avant migrations

1. Évolution de la fonction de signup `SECURITY DEFINER` : Search path verrouillé, privilèges minimaux; zéro possibilité de choisir l'identité merchant depuis un paramètre client.
2. `public_enrollment_links` en clair : le jeton est public mais non devinable; choisir hash lookup ou stockage actuel borné sans casser RLS `app.lookup_token`. Pas de token dans journaux.
3. `RULE_CHANGE_DELAY` 30 jours dans `operations.ts` : dissocier explicitement config initiale **avant publication** de changement post-publication, sans réécrire les règles de memberships déjà épinglées.
4. Valeur de récompense non encore persistée ni versionnée ; figer la promesse d'une adhésion à une version de politique/règles ou protéger la modification.
5. Les contrôles NFC/PIN et les sessions commercants doivent rester intacts ; QR public ne crédite pas de passages.
6. Render : accès direct non vérifié depuis Claude Code. Le dépôt actuel est déployé en préproduction via Vercel. Éviter tout changement Render par supposition.

## Résumé opérationnel

**L0 audit réalisé**, aucun changement de tables/client live ni déploiement. Débuter L1 sur une branche isolée, puis exécuter L2→L5 seulement avec evidence gates. Le développement sécurisé complet n'est **pas encore** terminé par cette préparation.
