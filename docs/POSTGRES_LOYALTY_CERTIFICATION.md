# Certification PostgreSQL du moteur de fidélité (PR en brouillon)

## Objectif

Les tests unitaires utilisent des mocks et ne certifient ni RLS ni transactions PostgreSQL.
La certification dynamique se trouve dans `scripts/certification/loyalty-postgres.mjs`.
Elle charge **toutes les migrations réelles**, puis appelle **creditVisit** et
**redeemReward** sur PostgreSQL 17 en tant que rôle non-superuser `taply_app`.

## Isolation obligatoire

L'action `.github/workflows/loyalty-postgres.yml` crée pour le job un
**nouveau PostgreSQL 17 jetable**, accessible seulement sur
`127.0.0.1:54329` depuis le runner. Aucune connexion à Supabase, staging
ou production. Les rôles de test et la table `auth.users` sont créés
**uniquement dans ce cluster** afin de simuler les prérequis Supabase.

Le script refuse de modifier une cible lorsque :
- la confirmation explicite `TAPLY_PG_CERT_ACK=isolated-postgres-cluster`
  manque ;
- le host n'est pas loopback, le port n'est pas 54329, la base n'est pas
  `taply_cert`, l'utilisateur n'est pas `postgres` ou la version n'est pas
  PostgreSQL 17 ;
- les schémas `taply` ou `auth`, un des rôles prévus, ou des tables
  `public` préexistent.

**Ne jamais** rediriger ce port vers un PostgreSQL contenant des données
réelles. Les rôles PostgreSQL sont globaux au cluster, donc une simple
base temporaire sur un cluster partagé ne suffit pas.

## Exécution

La certification s'exécute à chaque mise à jour pertinente de la PR
ciblant `main`, ou manuellement via GitHub Actions. Le job lance :
1. `npm ci --ignore-scripts` ;
2. `npm run check` (TypeScript et unitaires) ;
3. `npm run db:loyalty:cert` (PostgreSQL réel, isolé).

Pour une exécution locale, il faut démarrer **son propre cluster
PostgreSQL 17 jetable** et le publier uniquement sur 127.0.0.1:54329
avec une base vide `taply_cert`. Aucun outil sur le Mac n'est installé
automatiquement.

## Vérifications attendues

- Chargement des migrations SQL non modifiées, y compris DO $$ et rôles.
- `FORCE ROW LEVEL SECURITY`, rôle sans BYPASSRLS et GRANT minimaux.
- Absence de visibilité sans contexte tenant ou depuis un autre merchant.
- Absence de fuite du contexte de transaction après COMMIT.
- Crédit, idempotence, refus pendant cooldown, seuil et récompense en attente.
- Remise unique, cycle incrémenté, version de règles active épinglée au
  nouveau cycle, cooldown conservé.
- Deux crédits et deux remises concurrents depuis des connexions distinctes.
- ROLLBACK de l'état, du ledger et de la clé idempotente.
- Interdiction réelle des DELETE/UPDATE sur les journaux.

Les changements d'heure opérés par l'administrateur du **cluster
jetable** servent uniquement à créer des fixtures sans attendre deux heures.

## Restent NON certifiés

Ce job valide désormais aussi le PIN et les appareils employés,
les routes HTTP authentifiées sur base PostgreSQL jetable, l'accès aux
clients, et les journaux propriétaires en RLS. En revanche, il **ne prouve
pas le comportement du Supabase hébergé**, ni une présence physique ou
un achat réellement observé, ni le NFC matériel, ni le Wallet natif,
ni un déploiement complet E2E sur téléphone. Aucun QR public seul ne doit
créditer un passage.

**Interdit de passer la PR en Ready ou de fusionner tant que ces garde-fous
et les vérifications staging n'ont pas été validés séparément.**
