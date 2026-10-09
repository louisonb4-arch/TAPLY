-- Identité client anonyme Taply (aucune donnée personnelle).
--
-- Une identité = un identifiant technique aléatoire, porté par un cookie
-- HttpOnly dont seul le hash SHA-256 est stocké (identity_sessions). Une
-- identité possède plusieurs cartes, chez plusieurs commerces
-- (identity_memberships). Un code de récupération facultatif (hash seul,
-- jamais en clair) permet de rattacher l'identité à un nouveau navigateur.
--
-- Ces tables ne sont PAS tenant-scoped : RLS par identité (GUC
-- app.identity_id posé par le serveur après vérification du cookie), et
-- recherches exactes par hash (app.identity_session_hash,
-- app.identity_nonce_hash, app.identity_recovery_hash). Aucun commerçant
-- n'a de chemin vers ces tables : les cartes restent lues côté commerce via
-- memberships (RLS tenant).

create table taply.customer_identities (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'active' check (status in ('active', 'revoked')),
  recovery_hash text check (recovery_hash is null or recovery_hash ~ '^[0-9a-f]{64}$'),
  recovery_created_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_identities_recovery_hash_key unique (recovery_hash),
  constraint customer_identities_recovery_consistency
    check ((recovery_hash is null) = (recovery_created_at is null))
);

alter table taply.customer_identities enable row level security;
alter table taply.customer_identities force row level security;

grant select on taply.customer_identities to taply_app;
grant insert (id) on taply.customer_identities to taply_app;
grant update (status, recovery_hash, recovery_created_at, updated_at)
  on taply.customer_identities to taply_app;

create policy identity_self_select on taply.customer_identities for select to taply_app
  using (id = nullif(current_setting('app.identity_id', true), '')::uuid);
create policy identity_recovery_lookup on taply.customer_identities for select to taply_app
  using (
    status = 'active'
    and recovery_hash = nullif(current_setting('app.identity_recovery_hash', true), '')
  );
create policy identity_self_insert on taply.customer_identities for insert to taply_app
  with check (id = nullif(current_setting('app.identity_id', true), '')::uuid and status = 'active');
create policy identity_self_update on taply.customer_identities for update to taply_app
  using (id = nullif(current_setting('app.identity_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.identity_id', true), '')::uuid);

alter table taply.customer_identities owner to taply_owner;

create table taply.identity_sessions (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null references taply.customer_identities (id) on delete restrict,
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  creation_nonce_hash text check (creation_nonce_hash is null or creation_nonce_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  constraint identity_sessions_token_hash_key unique (token_hash),
  constraint identity_sessions_creation_nonce_key unique (creation_nonce_hash)
);

create index identity_sessions_identity_idx on taply.identity_sessions (identity_id);

alter table taply.identity_sessions enable row level security;
alter table taply.identity_sessions force row level security;

grant select on taply.identity_sessions to taply_app;
grant insert (identity_id, token_hash, creation_nonce_hash, expires_at)
  on taply.identity_sessions to taply_app;
grant update (last_seen_at, expires_at, revoked_at) on taply.identity_sessions to taply_app;

create policy session_token_lookup on taply.identity_sessions for select to taply_app
  using (token_hash = nullif(current_setting('app.identity_session_hash', true), ''));
create policy session_nonce_lookup on taply.identity_sessions for select to taply_app
  using (creation_nonce_hash = nullif(current_setting('app.identity_nonce_hash', true), ''));
create policy session_identity_select on taply.identity_sessions for select to taply_app
  using (identity_id = nullif(current_setting('app.identity_id', true), '')::uuid);
create policy session_identity_insert on taply.identity_sessions for insert to taply_app
  with check (identity_id = nullif(current_setting('app.identity_id', true), '')::uuid);
create policy session_identity_update on taply.identity_sessions for update to taply_app
  using (identity_id = nullif(current_setting('app.identity_id', true), '')::uuid)
  with check (identity_id = nullif(current_setting('app.identity_id', true), '')::uuid);

alter table taply.identity_sessions owner to taply_owner;

-- Lien identité → carte. Une carte par identité et par programme (PK).
create table taply.identity_memberships (
  identity_id uuid not null references taply.customer_identities (id) on delete restrict,
  merchant_id uuid not null,
  program_id uuid not null,
  membership_id uuid not null,
  created_at timestamptz not null default now(),
  constraint identity_memberships_pkey primary key (identity_id, program_id),
  constraint identity_memberships_membership_key unique (membership_id),
  constraint identity_memberships_membership_fkey
    foreign key (membership_id, merchant_id)
    references taply.memberships (id, merchant_id) on delete restrict,
  constraint identity_memberships_program_fkey
    foreign key (program_id, merchant_id)
    references taply.loyalty_programs (id, merchant_id) on delete restrict
);

create index identity_memberships_merchant_idx on taply.identity_memberships (merchant_id);

alter table taply.identity_memberships enable row level security;
alter table taply.identity_memberships force row level security;

grant select on taply.identity_memberships to taply_app;
grant insert (identity_id, merchant_id, program_id, membership_id)
  on taply.identity_memberships to taply_app;

create policy identity_select on taply.identity_memberships for select to taply_app
  using (identity_id = nullif(current_setting('app.identity_id', true), '')::uuid);
-- Insertion uniquement quand le serveur a posé LES DEUX contextes.
create policy identity_tenant_insert on taply.identity_memberships for insert to taply_app
  with check (
    identity_id = nullif(current_setting('app.identity_id', true), '')::uuid
    and merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid
  );

alter table taply.identity_memberships owner to taply_owner;

-- Limitation de débit publique (création d'identités, récupération, NFC).
-- Clé = hash domaine-séparé (jamais d'IP en clair). Fenêtres courtes.
create table taply.public_rate_buckets (
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null,
  hits integer not null default 0 check (hits >= 0),
  constraint public_rate_buckets_pkey primary key (key_hash, window_start)
);

create index public_rate_buckets_window_idx on taply.public_rate_buckets (window_start);

alter table taply.public_rate_buckets enable row level security;
alter table taply.public_rate_buckets force row level security;

grant select, insert on taply.public_rate_buckets to taply_app;
grant update (hits) on taply.public_rate_buckets to taply_app;
grant delete on taply.public_rate_buckets to taply_app;

create policy rate_key_select on taply.public_rate_buckets for select to taply_app
  using (key_hash = nullif(current_setting('app.rate_key_hash', true), ''));
create policy rate_key_insert on taply.public_rate_buckets for insert to taply_app
  with check (key_hash = nullif(current_setting('app.rate_key_hash', true), ''));
create policy rate_key_update on taply.public_rate_buckets for update to taply_app
  using (key_hash = nullif(current_setting('app.rate_key_hash', true), ''))
  with check (key_hash = nullif(current_setting('app.rate_key_hash', true), ''));
-- Purge des fenêtres échues de la MÊME clé uniquement.
create policy rate_key_purge on taply.public_rate_buckets for delete to taply_app
  using (
    key_hash = nullif(current_setting('app.rate_key_hash', true), '')
    and window_start < now() - interval '1 day'
  );

alter table taply.public_rate_buckets owner to taply_owner;
