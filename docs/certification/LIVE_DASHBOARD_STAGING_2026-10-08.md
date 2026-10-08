# Taply — Dashboard connecté à Supabase Staging (2026-10-08)

## Verdict

**PASS — tableau de bord V1 connecté pour lecture et authentification en préproduction. NO-GO production.**

- Supabase project ref : `jfkcrpbrdrzwhjtkdmxx` / `taply-staging`.
- Origine stable Vercel Preview : `https://taply-staging-louisondu44000-7822.vercel.app`.
- PR GitHub `feature/roll-in-love-loyalty-qr-v1` : reste draft.
- Aucun déploiement Production, aucune fusion dans main, aucun paiement.

## Préflight et migration

- Projet Supabase contenait 10 tables métier sur les migrations 1–13, **zéro ligne** dans les dix tables avant la migration. Contrôle SQL direct, pas d'estimation seule.
- Avant migration, un instantané local des **13 migrations SQL versionnées**, avec empreintes SHA-256, et un manifest des compteurs a été conservé sur le Mac à `/tmp/taply-staging-baseline-20261008/`. **Ce n'est PAS une sauvegarde physique Supabase ni une garantie de restauration**.
- Supabase Backup API : pas de sauvegarde physique accessible, PITR désactivé. Avant production, activer et exercer une vraie procédure de sauvegarde/restauration.
- Après revue additive et `supabase db push --dry-run`, 8 migrations ont été appliquées **uniquement sur staging**, code de sortie 0.
- `supabase migration list --linked` : **21 locales / 21 distantes**.
- `supabase db lint --linked --schema taply --fail-on error` : aucune erreur.

## Configuration Vercel Preview

- `TAPLY_LOYALTY_PREVIEW=enabled` : exclusivement pour `Preview`.
- `TAPLY_STAFF_PIN_PEPPER` : secret cryptographique aléatoire, exclusivement pour `Preview`, jamais dans Git.
- Les variables Auth et DB Preview préexistantes sont conservées. Origin CSRF de la préproduction inchangée.
- Vercel CLI `vercel deploy --yes` : déploiement Preview READY, alias stable pointé vers cette version. Aucun `--prod`.
- Accès anonyme aux routes propriétaires `/api/loyalty/{overview,merchant,security}` : HTTP 401 (pas 200). Health : 200, dashboard statique : 200.

## Vrais tests HTTPS contre Vercel + Supabase

Un compte Supabase Auth **QA temporaire** déjà créé et confirmé a été rattaché par opération administrative à une boutique et un programme de test. Aucun commerce réel ni donnée client réel.

| Contrôle | Résultat |
|---|---|
| Authentification Taply `POST /api/auth/login` | 200, rôle owner |
| `GET /api/auth/me` | 200, bon rôle et bon merchant |
| `GET /api/loyalty/merchant` | 200, nom exact de la boutique stockée en DB |
| `GET /api/loyalty/overview` | 200, programme exact et seuil = 5 |
| `GET /api/loyalty/customers` | 200, liste vide réelle, aucun client fictif |
| `GET /api/loyalty/security` | 200, structures devices/recentActivity/unusualVelocity |
| `GET /api/loyalty/identity` | 200 |
| `POST /api/auth/logout` puis `GET /api/auth/me` | 200 puis 401 |
| Navigateur Chromium mobile 390px | Login, accueil, clients, règles, historique PASS ; 0 JS error |
| Navigateur Chromium desktop 1440px | Identique PASS ; 0 JS error |
| Tests TS/Vitest locaux | 499 réussis |
| CI PostgreSQL 17 isolé | Vérifier la dernière action GitHub pour certification dynamique |

## Non testé sur le Supabase hébergé

- Aucune écriture d'un vrai passage, pas de création de QR ou remise réelle via le nouveau Preview dans ce contrôle. Les flux d'écriture ont été certifiés **sur PostgreSQL 17 isolé**, pas dans le parcours staging par navigateur.
- Le test propriétaire utilise un compte à boîte e-mail temporaire : **non adapté au lancement** et à supprimer/remplacer lorsqu'un compte permanent est prêt.
- Ni scanner caméra, ni NFC physique, ni Apple Wallet/Google Wallet, ni mise à jour de pass en 10 s, ni notifications réellement distribuées.
- Inscription autonome d'un commerçant, gestion des commerçants, RGPD, WAF, sauvegarde/restauration et pentest à finaliser.

## Comptes de test

Une seule boutique QA + mapping propriétaire + programme de test restent en staging pour la démonstration. L'email temporaire et les identifiants sont dans un fichier privé local `/tmp/taply_mail_auth_qa_20261008.json` **hors du dépôt** : ne jamais les copier dans les journaux, les captures ou la PR. Le compte n'est pas à utiliser comme propriétaire réel.

## Suite

1. Configurer l'adresse e-mail **permanente** du vrai propriétaire et le provisioning commerçant sûr; ne pas dépendre du compte QA.
2. E2E écritures en staging (création client avec consentement, approbation appareil, PIN, double scan anti-fraude, cadeaux), puis nettoyage borné des fixtures.
3. Wallet natifs et parcours QR/NFC, notifications, RGPD, rate limit et restauration Supabase.
4. Procéder à une validation humaine avant fusion main / production.
