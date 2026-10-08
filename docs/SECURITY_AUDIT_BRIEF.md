# TAPLY — Brief pour audit offensif autorisé et corrections guidées

## Périmètre et règles

Audit du dépôt GitHub `louisonb4-arch/TAPLY`, branche
`feature/roll-in-love-loyalty-qr-v1`, PR #1 **draft**.

Ne travailler que sur des environnements **locaux ou PostgreSQL jetable**.
Pas de requête offensive contre le site production, un client réel, un
commerce réel, Supabase existant ni un serveur tiers sans autorisation
explicite supplémentaire. Aucun secret ou donnée réelle dans les prompts,
traces, rapports ou PR. Aucune migration ni déploiement automatique.
Pas de merge ; modification uniquement sur la branche de développement.

L'audit est **source-first** : analyser le vrai code et vérifier le
comportement dynamique avant de conclure. Chaque FAIL doit inclure une
reproduction sûre, une preuve, un impact, le code exact et une proposition
de correction minimale, suivie d'un test de non-régression. Un PASS n'est
pas accepté uniquement sur la base de tests unitaires mockés.

## Actifs sensibles

- Sessions commerçants : cookie HttpOnly `taply_session`,
  mapping Supabase Auth → `merchant_users`, révocation et expiration.
- Staff : invitation 5 min, propriétaire réauthentifié, cookie d'appareil,
  PIN `scrypt` avec pepper, compteur et verrouillage, révocation.
- Client : nom/prénom minimal, jeton QR Wallet opaque, token hash-only,
  rotation, consentement.
- Fidélité : `membership_states`, ledgers immuables, acteur
  `performed_by`, cooldown 2 h, cycles de récompenses, versions de règles.
- Public : `public_enrollment_links` et `pending_enrollments`,
  limite anti-spam par commerce, claim de dix minutes.

## Scénarios prioritaires

1. **Cross-tenant** : essayer d'accéder ou de muter une carte, un programme,
   une session, une invitation, un appareil ou un claim d'un autre commerce.
   Vérifier la barrière applicative ET FORCE RLS.
2. **Fraude de passage** : QR présentoir utilisé comme QR Wallet, QR
   personnel copié, deux scans concurrents, rejoués avec même et différentes
   clés, timestamp client forgé, cooldown avant/après remise.
3. **Double récompense** : remise simultanée, replays avec ancien cycle,
   ROLLBACK entre insert ledger/reset/rollover, re-remise après timeout.
4. **Staff** : mauvais PIN 5x puis bon PIN, vol/rejeu de cookie appareil,
   appareil désactivé, invitation expirée/réutilisée, mauvais destinataire,
   revalidation propriétaire contournée, role staff voulant modifier seuil.
5. **Pré-inscription** : spam concurrent 25+, épuisement du quota
   par un adversaire, tokens expirés, préinscription volée, confirmée 2x,
   confirmation par autre commerce, PII des claims expirés.
6. **Auth/HTTP** : Origin absente/null/autre schéma/port, CSRF,
   cookies SameSite/Secure/Path, sessions expirées/révoquées,
   JSON invalide, paramètres supplémentaires, corps volumineux,
   brute force login, DoS CPU `scrypt`.
7. **SQL** : injections, paramètres non typés, opportunités d'élévation
   via GRANT, policies permissives superposées, GUC transaction-local
   et fuite de contexte pool, role `taply_app` BYPASSRLS.
8. **Confidentialité** : QR brut et credentials absents des logs, URLs,
   réponses non autorisées, tables d'idempotence, caches et erreurs ;
   XSS avec prénom ; suppression/export et rétention des données.
9. **Approvisionnement** : verrouillage des versions npm, advisories,
   artefacts CI, dépendances vulnérables, secrets et configurations
   de staging distinctes de production.
10. **Performance** : latence de mutation, attente des verrous,
    débits de pool, concurrents, erreurs 429, simulation déconnexion DB.

## Barrières à maintenir

- Aucune mutation production. `main` inchangé. PR reste draft.
- Test PostgreSQL réel obligatoire, `npm run check` OK,
  `git diff --check` OK, audit RLS et droits DB.
- `TAPLY_LOYALTY_PREVIEW` ne fonctionne pas en production ; vérifier
  aussi `VERCEL_ENV=production` même si APP_ENV est erroné.
- Un simple QR ou une case « achat confirmé » ne prouvent pas l'achat ;
  contrôles humains/employé autorisé et futur rapprochement avec caisse.
- Aucun prix, abonnement ou paiement à développer dans cet audit.

## Format de restitution

Pour chaque vulnérabilité : identifiant, sévérité, scénario, impact,
préconditions, chemins et lignes du code, test reproductible isolé,
correctif, test de non-régression, état corrigé/non corrigé et risques
résiduels. Séparer clairement les fonctionnalités absentes (Wallet natif,
notifications réelles, dashboard actuel en localStorage, WAF externe,
RGPD) des failles démontrées dans les fonctionnalités existantes.
