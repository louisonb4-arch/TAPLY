# Taply SaaS V1 — Architecture

Branche : `feat/taply-saas-v1-20261009`. Date : 10 octobre 2026.

## Services

| Rôle | Service retenu | Remarque |
|---|---|---|
| Site, espace commerçant, carte client | Fichiers statiques servis par Vercel (`dist/`, liste blanche `scripts/build-static.mjs`) | HTML/CSS/JS vanilla, aucune donnée de démonstration |
| Backend (règles métier, crypto NFC, webhooks Stripe) | **Une** Vercel Function Hono (`api/index.ts`) | Le brief mentionnait Render : aucun service Render n'existe ni n'est configuré. Le backend Vercel existant a été conservé (règle « ne pas remplacer un service configuré »). |
| Base de données | Supabase PostgreSQL 17, schéma privé `taply`, rôle `taply_app` (NOSUPERUSER, NOBYPASSRLS) via Transaction Pooler | RLS activée **et forcée** sur les 36 tables |
| Authentification commerçant | Supabase Auth (mot de passe, e-mail confirmé) → session opaque Taply (cookie `__Host-` HttpOnly) | Aucun JWT ni clé Supabase dans le navigateur |
| Identité client | Identité anonyme Taply (cookie HttpOnly `taply_cid`, hash en base) | Pas de compte Supabase anonyme : le navigateur ne parle jamais à Supabase directement, RLS applique les droits par GUC posées par le serveur |
| Paiement | Stripe Checkout + portail + webhooks signés | Client HTTP minimal sans dépendance (`backend/billing/stripe.ts`) |

Pourquoi pas les sessions anonymes Supabase : elles exposeraient un JWT `authenticated` au navigateur et imposeraient des politiques RLS sur le rôle `authenticated` partagé avec les commerçants. Ici, aucun rôle Data API n'a accès au schéma `taply` (révoqué en migration 0001) ; seul le backend, avec `taply_app`, y accède, et chaque transaction pose explicitement `app.merchant_id` et/ou `app.identity_id`.

## Moteur de fidélité unique

`backend/loyalty/credit.ts → creditVisitAsActor()` est l'unique chemin d'écriture d'un passage, pour les deux modes :

- **Mode A — QR personnel** : employé connecté + appareil approuvé + PIN (ou fenêtre de déverrouillage de 15 min) → `POST /api/loyalty/card/lookup` (lecture, aucun crédit) → `POST /api/loyalty/scan` (crédit, `purchaseConfirmed: true`).
- **Mode B — NFC NTAG 424 DNA** : la puce ouvre `/t?e=…&c=…` (page statique, aucun crédit en GET) → la page envoie `POST /api/c/nfc/tap` → vérification SUN (AES-CMAC, PICCData chiffrées) → compteur consommé atomiquement → identité/carte créées si première visite → même moteur de crédit.

Invariants appliqués dans la même transaction PostgreSQL : verrou `FOR UPDATE` sur l'état de la carte, délai de 2 h calculé avec `now()` du serveur de base, carte bloquée tant qu'une récompense n'est pas remise, idempotence (`idempotency_requests`), ledger immuable (`visit_ledger` : pas d'UPDATE/DELETE pour `taply_app`), acteur obligatoire (employé **ou** puce, contrainte SQL).

## Programme, versions, récompenses

- Contrat = `program_rule_versions.rules` : `{ threshold: 3..10, rewards: [{key, title}] }` (1 à 5 récompenses).
- Chaque carte épingle la version de son cycle (`memberships.current_rule_version_id`) : un changement de seuil ou de récompenses ne s'applique qu'au cycle suivant ; aucune progression n'est perdue.
- Brouillon libre avant publication ; après publication, une nouvelle version au plus tous les 30 jours (contrôle applicatif `decideRuleChange` + trigger `guard_rule_version_contract_v1` en base).
- Nom, ville, couleurs, conditions affichées : modifiables à tout moment (`terms_version` incrémentée).
- Récompense : seuil atteint → `reward_pending` ; le client choisit (`reward_claims`, statut `awaiting_handover`) ; l'employé scanne et confirme → `redemption_ledger` (unique par carte et par cycle) + claim `handed_over` (définitif, RLS) + cycle suivant.

## Identité anonyme et cartes

`customer_identities` (aucune donnée personnelle) → `identity_sessions` (hash du cookie, sessions multiples) → `identity_memberships` (une carte par identité et par programme, cartes chez plusieurs commerces).

- Première visite concurrente : nonce de 256 bits (cookie 20 min) + verrou consultatif → une seule identité.
- Code de secours facultatif : 100 bits, hash SHA-256 seul en base, usage unique (renouvelé à chaque récupération), révocable ; 10 essais/h par IP et 1 000/h au total ; la récupération déconnecte les autres appareils.
- QR personnel web : jeton 256 bits, haché en base, renouvelé à chaque affichage, valable 15 min.

## Accès selon l'abonnement (`backend/billing/access.ts`)

| Statut Stripe | Niveau | Effet |
|---|---|---|
| `active`, `trialing` | full | tout |
| `past_due` | grace | tout + bandeau de régularisation |
| `none`, `incomplete` | setup_only | configuration, pas de publication ni d'opération client |
| `canceled`, `unpaid`, `paused`, `incomplete_expired` | read_only | consultation ; les cartes clients restent lisibles |

`TAPLY_BILLING_MODE=disabled` (préproduction sans clés Stripe) donne `full` avec bandeau ; en production le mode est toujours appliqué.

## Portes d'activation (variables d'environnement)

| Variable | Rôle |
|---|---|
| `TAPLY_LOYALTY_PREVIEW=enabled` | API commerçant en préproduction |
| `TAPLY_QR_ANONYMOUS_V1=enabled` | API client `/api/c/*` en préproduction |
| `TAPLY_PRODUCTION_RELEASE=v1-approved` | Seule manière d'ouvrir l'API en production (décision explicite) |
| `TAPLY_NFC_MASTER_KEY` | 64 hex, secret maître des clés NTAG (Vercel « sensitive ») |
| `TAPLY_NFC_KEY_VERSION` | Version de clés (défaut 1) |
| `TAPLY_BILLING_MODE` | `enforced` / `disabled` (ignoré en production) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID` | Facturation |
| `TAPLY_RATE_LIMIT_PEPPER` | Poivre des empreintes IP (repli : `TAPLY_STAFF_PIN_PEPPER`) |

## Routes principales

Client (public, cookie anonyme) : `GET /api/c/program?code=`, `POST /api/c/enroll`, `GET /api/c/cards`, `GET /api/c/cards/:id`, `POST /api/c/cards/:id/qr`, `POST /api/c/cards/:id/reward`, `POST /api/c/recovery`, `POST /api/c/recovery/revoke`, `POST /api/c/recover`, `POST /api/c/forget`, `POST /api/c/nfc/tap`.

Commerçant (session) : `GET /api/loyalty/dashboard`, `GET|PATCH /api/loyalty/setup`, `POST /api/loyalty/setup/publish`, `GET /api/loyalty/setup/qr.svg`, `PUT /api/loyalty/program/contract`, `PATCH /api/loyalty/program/appearance`, `PATCH /api/loyalty/program/preferences`, `GET /api/loyalty/customers[/:id/history]`, `GET /api/loyalty/rewards`, `POST /api/loyalty/devices/unlock`, `POST /api/loyalty/card/lookup`, `POST /api/loyalty/scan`, `POST /api/loyalty/redeem`, `GET /api/loyalty/nfc`, `POST /api/loyalty/nfc/pairing[/cancel]`, `POST /api/loyalty/nfc/tags/:id/status`, `GET /api/loyalty/nfc/tags/:id/events`.

Facturation : `GET /api/billing/status`, `POST /api/billing/checkout`, `POST /api/billing/sync`, `POST /api/billing/portal`, `POST /api/billing/webhook`.

Auth : `POST /api/auth/signup|login|logout`, `GET /api/auth/me`, `POST /api/auth/password/forgot`, `POST /api/auth/password/reset`, `POST /api/auth/confirmation/resend`.

## Migrations ajoutées

| Version | Contenu |
|---|---|
| 20261009100001 | Réconciliation staging : `program_publications` absente (dérive de version 100010), retrait des droits/policies pilotes |
| 20261009100002 | Contrat versionné, verrou 30 j (trigger), `reward_claims`, ledger enrichi, ville du commerce, QR temporaire, déverrouillage d'appareil |
| 20261009100003 | Identités anonymes, sessions, liens identité→carte, limitation de débit |
| 20261009100004 | Puces NFC, appairage, journal des lectures, acteur NFC du ledger, préférences NFC |
| 20261009100005 | Abonnements Stripe, idempotence des événements, abonnements Web Push, file de notifications |

Retour arrière d'urgence (destructif, non exécuté) : `supabase/rollback/20261009_saas_v1_down.sql`.
