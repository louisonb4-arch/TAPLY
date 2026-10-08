-- Approbation d'appareil à double contrôle : owner authentifié + staff authentifié.
-- N'utilise aucun PIN en clair ni jeton d'appareil brut en base.
-- Les PIN à faible entropie sont hashés avec scrypt et un secret serveur (pepper).
-- Nouveaux objets seulement : ne change pas les 16 migrations certifiées.

alter table taply.merchant_users
  add constraint merchant_users_id_merchant_id_pairing_key unique (id, merchant_id);

create table taply.staff_device_pairings (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null,
  merchant_user_id uuid not null,
  created_by uuid not null,
  approval_hash text not null unique check (approval_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint staff_device_pairing_target_fkey
    foreign key (merchant_user_id, merchant_id)
    references taply.merchant_users (id, merchant_id) on delete restrict,
  constraint staff_device_pairing_owner_fkey
    foreign key (created_by, merchant_id)
    references taply.merchant_users (id, merchant_id) on delete restrict
);
create index staff_device_pairings_merchant_idx
  on taply.staff_device_pairings (merchant_id);
alter table taply.staff_device_pairings enable row level security;
alter table taply.staff_device_pairings force row level security;
grant select on taply.staff_device_pairings to taply_app;
grant insert (merchant_id, merchant_user_id, created_by, approval_hash, expires_at)
  on taply.staff_device_pairings to taply_app;
grant update (consumed_at) on taply.staff_device_pairings to taply_app;
create policy select_tenant on taply.staff_device_pairings for select to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
create policy insert_tenant on taply.staff_device_pairings for insert to taply_app
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
create policy update_tenant on taply.staff_device_pairings for update to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid)
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
alter table taply.staff_device_pairings owner to taply_owner;

create table taply.staff_devices (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null,
  merchant_user_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  pin_salt text not null check (pin_salt ~ '^[0-9a-f]{32}$'),
  pin_verifier text not null check (pin_verifier ~ '^[0-9a-f]{128}$'),
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 10),
  locked_until timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint staff_devices_user_merchant_fkey
    foreign key (merchant_user_id, merchant_id)
    references taply.merchant_users (id, merchant_id) on delete restrict
);
create index staff_devices_user_merchant_idx
  on taply.staff_devices (merchant_id, merchant_user_id);
alter table taply.staff_devices enable row level security;
alter table taply.staff_devices force row level security;
grant select on taply.staff_devices to taply_app;
grant insert (merchant_id, merchant_user_id, token_hash, pin_salt, pin_verifier)
  on taply.staff_devices to taply_app;
grant update (failed_attempts, locked_until, revoked_at, last_used_at)
  on taply.staff_devices to taply_app;
create policy select_tenant on taply.staff_devices for select to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
create policy insert_tenant on taply.staff_devices for insert to taply_app
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
create policy update_tenant on taply.staff_devices for update to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid)
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
alter table taply.staff_devices owner to taply_owner;
