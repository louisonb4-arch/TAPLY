-- Supports NFC NTAG 424 DNA (Secure Dynamic Messaging / SUN).
--
-- Aucune clé en base : les clés AES de chaque puce sont dérivées côté
-- serveur depuis un secret maître (variable d'environnement) et l'UID.
-- La base conserve l'identité de la puce (UID), son rattachement au
-- commerce, son statut et le dernier compteur SDM consommé (anti-rejeu).
--
-- Anti-rejeu : une lecture n'est acceptée que si son compteur est
-- STRICTEMENT supérieur à last_read_ctr, avancé atomiquement
-- (UPDATE ... WHERE last_read_ctr < $ctr) dans la même transaction que le
-- crédit. Index unique partiel en seconde barrière.

create table taply.nfc_tags (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null,
  program_id uuid not null,
  location_id uuid not null,
  uid_hex text not null check (uid_hex ~ '^[0-9A-F]{14}$'),
  label text not null check (length(btrim(label)) between 1 and 60),
  key_version smallint not null default 1 check (key_version between 1 and 255),
  status text not null default 'active'
    check (status in ('active', 'disabled', 'compromised', 'retired')),
  last_read_ctr integer not null default -1 check (last_read_ctr between -1 and 16777215),
  last_read_at timestamptz,
  verified_at timestamptz not null default now(),
  replaces_tag_id uuid,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint nfc_tags_uid_key unique (uid_hex),
  constraint nfc_tags_id_merchant_key unique (id, merchant_id),
  constraint nfc_tags_program_merchant_fkey
    foreign key (program_id, merchant_id)
    references taply.loyalty_programs (id, merchant_id) on delete restrict,
  constraint nfc_tags_location_merchant_fkey
    foreign key (location_id, merchant_id)
    references taply.locations (id, merchant_id) on delete restrict,
  constraint nfc_tags_created_by_fkey
    foreign key (created_by, merchant_id)
    references taply.merchant_users (id, merchant_id) on delete restrict,
  constraint nfc_tags_replaces_fkey
    foreign key (replaces_tag_id, merchant_id)
    references taply.nfc_tags (id, merchant_id) on delete restrict
);

create index nfc_tags_merchant_idx on taply.nfc_tags (merchant_id, status);

alter table taply.nfc_tags enable row level security;
alter table taply.nfc_tags force row level security;

grant select on taply.nfc_tags to taply_app;
grant insert (merchant_id, program_id, location_id, uid_hex, label, key_version,
              last_read_ctr, last_read_at, replaces_tag_id, created_by)
  on taply.nfc_tags to taply_app;
grant update (label, status, last_read_ctr, last_read_at, updated_at) on taply.nfc_tags to taply_app;

create policy select_tenant on taply.nfc_tags for select to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
-- Résolution pré-tenant : UID exact issu d'un message SUN déchiffré.
create policy uid_lookup on taply.nfc_tags for select to taply_app
  using (uid_hex = nullif(current_setting('app.nfc_uid_lookup', true), ''));
create policy insert_tenant on taply.nfc_tags for insert to taply_app
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
create policy update_tenant on taply.nfc_tags for update to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid)
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

alter table taply.nfc_tags owner to taply_owner;

-- Mode appairage : le propriétaire ouvre une fenêtre de 10 minutes ; la
-- première lecture SUN valide d'un UID inconnu, faite avec SA session,
-- rattache la puce à son commerce.
create table taply.nfc_pairings (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null,
  program_id uuid not null,
  label text not null check (length(btrim(label)) between 1 and 60),
  replaces_tag_id uuid,
  created_by uuid not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  tag_id uuid,
  created_at timestamptz not null default now(),
  constraint nfc_pairings_program_fkey foreign key (program_id, merchant_id)
    references taply.loyalty_programs (id, merchant_id) on delete restrict,
  constraint nfc_pairings_created_by_fkey foreign key (created_by, merchant_id)
    references taply.merchant_users (id, merchant_id) on delete restrict,
  constraint nfc_pairings_replaces_fkey foreign key (replaces_tag_id, merchant_id)
    references taply.nfc_tags (id, merchant_id) on delete restrict,
  constraint nfc_pairings_tag_fkey foreign key (tag_id, merchant_id)
    references taply.nfc_tags (id, merchant_id) on delete restrict
);

create index nfc_pairings_merchant_idx on taply.nfc_pairings (merchant_id, expires_at desc);

alter table taply.nfc_pairings enable row level security;
alter table taply.nfc_pairings force row level security;

grant select on taply.nfc_pairings to taply_app;
grant insert (merchant_id, program_id, label, replaces_tag_id, created_by, expires_at)
  on taply.nfc_pairings to taply_app;
grant update (consumed_at, tag_id) on taply.nfc_pairings to taply_app;

create policy select_tenant on taply.nfc_pairings for select to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
create policy insert_tenant on taply.nfc_pairings for insert to taply_app
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
create policy update_tenant on taply.nfc_pairings for update to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid)
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

alter table taply.nfc_pairings owner to taply_owner;

-- Journal des lectures (acceptées ET refusées après authentification MAC).
create table taply.nfc_tap_events (
  id uuid primary key default gen_random_uuid(),
  tag_id uuid not null,
  merchant_id uuid not null,
  read_ctr integer not null check (read_ctr between 0 and 16777215),
  outcome text not null check (outcome in (
    'credited', 'enrolled_credited', 'paired',
    'denied_replay', 'denied_cooldown', 'denied_reward_pending', 'denied_tag_inactive',
    'denied_nfc_disabled', 'denied_program_unavailable', 'denied_risk', 'denied_billing'
  )),
  identity_id uuid,
  membership_id uuid,
  idempotency_key uuid,
  ip_hash text check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint nfc_tap_events_tag_fkey foreign key (tag_id, merchant_id)
    references taply.nfc_tags (id, merchant_id) on delete restrict,
  constraint nfc_tap_events_membership_fkey foreign key (membership_id, merchant_id)
    references taply.memberships (id, merchant_id) on delete restrict
);

-- Un compteur ne peut être CONSOMMÉ qu'une seule fois par puce.
create unique index nfc_tap_events_consumed_ctr_key
  on taply.nfc_tap_events (tag_id, read_ctr) where outcome <> 'denied_replay';
create index nfc_tap_events_merchant_idx on taply.nfc_tap_events (merchant_id, created_at desc);
create index nfc_tap_events_tag_idx on taply.nfc_tap_events (tag_id, created_at desc);

alter table taply.nfc_tap_events enable row level security;
alter table taply.nfc_tap_events force row level security;

grant select on taply.nfc_tap_events to taply_app;
grant insert (tag_id, merchant_id, read_ctr, outcome, identity_id, membership_id, idempotency_key, ip_hash)
  on taply.nfc_tap_events to taply_app;

create policy select_tenant on taply.nfc_tap_events for select to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
create policy insert_tenant on taply.nfc_tap_events for insert to taply_app
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

alter table taply.nfc_tap_events owner to taply_owner;

-- ── Ledger de passages : acteur = employé (QR) OU puce (NFC) ────────
alter table taply.visit_ledger add column nfc_tag_id uuid;
alter table taply.visit_ledger
  add constraint visit_ledger_nfc_tag_fkey
  foreign key (nfc_tag_id, merchant_id)
  references taply.nfc_tags (id, merchant_id) on delete restrict;
alter table taply.visit_ledger drop constraint visit_ledger_employee_required;
alter table taply.visit_ledger
  add constraint visit_ledger_actor_required check (
    (source = 'QR_EMPLOYEE' and performed_by is not null and nfc_tag_id is null)
    or (source = 'NFC' and nfc_tag_id is not null and performed_by is null)
  ) not valid;
grant insert (nfc_tag_id) on taply.visit_ledger to taply_app;
create index visit_ledger_nfc_tag_idx on taply.visit_ledger (merchant_id, nfc_tag_id, credited_at)
  where nfc_tag_id is not null;
-- Le délai de 2 h se lit sur l'état de la carte ; cet index sert les
-- contrôles de vélocité (passages récents par commerce).
create index visit_ledger_merchant_time_idx on taply.visit_ledger (merchant_id, credited_at desc);

-- ── Préférences du programme ────────────────────────────────────────
alter table taply.program_preferences
  add column nfc_auto_enabled boolean not null default false,
  add column notify_reward_unlocked boolean not null default true,
  add column notify_visit_credited boolean not null default false;
grant insert (nfc_auto_enabled, notify_reward_unlocked, notify_visit_credited)
  on taply.program_preferences to taply_app;
grant update (nfc_auto_enabled, notify_reward_unlocked, notify_visit_credited)
  on taply.program_preferences to taply_app;
