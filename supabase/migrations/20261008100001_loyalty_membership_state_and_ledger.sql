-- Phase 4 — Persistance fidélité : état courant + journaux de passages et
-- remises. Support QR validé par employé et NFC certifié sans rework futur.
--
-- Aucune table gelée (0001–0013) n'est modifiée.
--
-- Trois tables :
--   membership_states  : état courant unique par membership (1:1)
--   visit_ledger       : journal IMMUTABLE de passages crédités
--   redemption_ledger  : journal IMMUTABLE de remises effectuées
--
-- La sécurité transactionnelle complète (SELECT FOR UPDATE + runIdempotent
-- + vérification staff roles) est la responsabilité du futur LoyaltyService,
-- pas de cette migration. Cette migration pose les contraintes structurelles
-- et les gardes FK/RLS/GRANT qui empêchent les corruptions physiques.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. membership_states — état courant par membership, cycle inclus
-- ═══════════════════════════════════════════════════════════════════════
--
-- membership_id est PK : exactement un état par membership (1:1).
-- visit_count borné [0, 10] = MAX_THRESHOLD du moteur de règles.
-- reward_pending doit être cohérent avec visit_count == threshold du cycle,
-- mais cette cohérence est applicative (LoyaltyService), pas DDL — la base
-- ne connaît pas le threshold dynamique de la version de règles épinglée.
-- cycle_number démarre à 1, incrémenté à chaque remise (redeem).
-- last_credited_at nullable : horodatage du dernier crédit GLOBAL à la membership,
-- conservé au rollover (ne pas réinitialiser lors de la remise du cadeau).
create table taply.membership_states (
  membership_id uuid not null,
  merchant_id uuid not null,
  visit_count integer not null default 0,
  reward_pending boolean not null default false,
  last_credited_at timestamptz,
  cycle_number integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint membership_states_pkey primary key (membership_id),
  constraint membership_states_visit_count_range check (visit_count >= 0 and visit_count <= 10),
  constraint membership_states_cycle_number_positive check (cycle_number >= 1),
  -- FK composite : prouve que la membership appartient bien à CE merchant.
  constraint membership_states_membership_merchant_fkey
    foreign key (membership_id, merchant_id)
    references taply.memberships (id, merchant_id)
    on delete restrict
);

create index membership_states_merchant_id_idx on taply.membership_states (merchant_id);

alter table taply.membership_states enable row level security;
alter table taply.membership_states force row level security;

-- SELECT + INSERT + UPDATE colonne par colonne. Pas de DELETE — l'état
-- est géré par cycle (reset via UPDATE), jamais supprimé physiquement.
-- INSERT ne permet que la création d'un état 0/false/1 horodaté par
-- PostgreSQL : les compteurs ne peuvent pas être préremplis à l'inscription.
grant select on taply.membership_states to taply_app;
grant insert (membership_id, merchant_id) on taply.membership_states to taply_app;
-- UPDATE limité aux colonnes que le LoyaltyService modifie réellement :
-- visit_count, reward_pending, last_credited_at, cycle_number, updated_at.
-- membership_id, merchant_id et created_at restent immuables pour taply_app.
grant update (visit_count, reward_pending, last_credited_at, cycle_number, updated_at)
  on taply.membership_states to taply_app;

create policy select_tenant on taply.membership_states
  for select to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

create policy insert_tenant on taply.membership_states
  for insert to taply_app
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

create policy update_tenant on taply.membership_states
  for update to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid)
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

alter table taply.membership_states owner to taply_owner;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. visit_ledger — journal IMMUTABLE de passages crédités
-- ═══════════════════════════════════════════════════════════════════════
--
-- Chaque ligne = un passage validé (employé QR ou NFC certifié) crédité
-- sur un cycle donné. AUCUN passage par QR public (scan libre) — ce
-- n'est pas un canal de crédit valide.
--
-- idempotency_key : identifiant stable d'opération issu d'une action
-- authentifiée et autorisée (employé ou preuve NFC vérifiée), validé par
-- le serveur. Une valeur non fiable envoyée par un client ne constitue
-- jamais une autorisation de crédit.
-- L'unicité (membership_id, idempotency_key) empêche le double-crédit
-- d'une même opération, indépendamment de toute logique applicative.
--
-- credited_at : timestamp serveur (now()), pas un timestamp client.
-- Le LoyaltyService doit utiliser une horloge serveur de confiance pour
-- la décision de cooldown et pour l'événement enregistré.
create table taply.visit_ledger (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null,
  merchant_id uuid not null,
  cycle_number integer not null,
  source text not null check (source in ('QR_EMPLOYEE', 'NFC')),
  credited_at timestamptz not null default now(),
  idempotency_key text not null,
  constraint visit_ledger_cycle_number_positive check (cycle_number >= 1),
  -- Unicité : une opération ne crédite qu'une seule fois.
  constraint visit_ledger_membership_idempotency_key unique (membership_id, idempotency_key),
  -- FK composite tenant.
  constraint visit_ledger_membership_merchant_fkey
    foreign key (membership_id, merchant_id)
    references taply.memberships (id, merchant_id)
    on delete restrict
);

create index visit_ledger_merchant_id_idx on taply.visit_ledger (merchant_id);
create index visit_ledger_membership_id_idx on taply.visit_ledger (membership_id);

alter table taply.visit_ledger enable row level security;
alter table taply.visit_ledger force row level security;

-- SELECT + INSERT seulement. AUCUN UPDATE, AUCUN DELETE — journal immutable.
-- INSERT colonne par colonne : taply_app ne peut pas forger credited_at
-- ni l'identifiant UUID ; les valeurs sont produites par PostgreSQL.
grant select on taply.visit_ledger to taply_app;
grant insert (membership_id, merchant_id, cycle_number, source, idempotency_key)
  on taply.visit_ledger to taply_app;

create policy select_tenant on taply.visit_ledger
  for select to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

create policy insert_tenant on taply.visit_ledger
  for insert to taply_app
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

alter table taply.visit_ledger owner to taply_owner;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. redemption_ledger — journal IMMUTABLE de remises effectuées
-- ═══════════════════════════════════════════════════════════════════════
--
-- Chaque ligne = une remise de récompense pour un cycle donné.
-- L'unicité (membership_id, cycle_number) empêche physiquement le
-- double-redeem sur le même cycle — aucune logique applicative ne
-- peut contourner cette contrainte.
create table taply.redemption_ledger (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null,
  merchant_id uuid not null,
  cycle_number integer not null,
  redeemed_at timestamptz not null default now(),
  constraint redemption_ledger_cycle_number_positive check (cycle_number >= 1),
  -- Unicité : une seule remise par membership + cycle.
  constraint redemption_ledger_membership_cycle_key unique (membership_id, cycle_number),
  -- FK composite tenant.
  constraint redemption_ledger_membership_merchant_fkey
    foreign key (membership_id, merchant_id)
    references taply.memberships (id, merchant_id)
    on delete restrict
);

create index redemption_ledger_merchant_id_idx on taply.redemption_ledger (merchant_id);
create index redemption_ledger_membership_id_idx on taply.redemption_ledger (membership_id);

alter table taply.redemption_ledger enable row level security;
alter table taply.redemption_ledger force row level security;

-- SELECT + INSERT seulement. AUCUN UPDATE, AUCUN DELETE — journal immutable.
-- INSERT colonne par colonne : redeemed_at est systématiquement créé
-- par PostgreSQL ; taply_app ne peut pas antidater une remise.
grant select on taply.redemption_ledger to taply_app;
grant insert (membership_id, merchant_id, cycle_number)
  on taply.redemption_ledger to taply_app;

create policy select_tenant on taply.redemption_ledger
  for select to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

create policy insert_tenant on taply.redemption_ledger
  for insert to taply_app
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

alter table taply.redemption_ledger owner to taply_owner;
