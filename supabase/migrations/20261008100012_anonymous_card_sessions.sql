-- QR V1 / anonymised loyalty cards. All tokens stored hashed.
-- No name/email/phone, no biometric/device fingerprint, no public SELECT.
create table taply.anonymous_card_sessions (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null,
  program_id uuid not null,
  membership_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint anon_sessions_membership_merchant_fk
    foreign key (membership_id,merchant_id) references taply.memberships(id,merchant_id),
  constraint anon_sessions_program_merchant_fk
    foreign key (program_id,merchant_id) references taply.loyalty_programs(id,merchant_id)
);
create index anon_sessions_merchant_program_idx
  on taply.anonymous_card_sessions(merchant_id,program_id,created_at);
create index anon_sessions_expiry_idx on taply.anonymous_card_sessions(expires_at);

alter table taply.anonymous_card_sessions enable row level security;
alter table taply.anonymous_card_sessions force row level security;
grant select, insert on taply.anonymous_card_sessions to taply_app;
grant update (revoked_at) on taply.anonymous_card_sessions to taply_app;
create policy anon_sessions_select_tenant on taply.anonymous_card_sessions
  for select to taply_app using
  (merchant_id=nullif(current_setting('app.merchant_id',true),'')::uuid);
create policy anon_sessions_insert_tenant on taply.anonymous_card_sessions
  for insert to taply_app with check
  (merchant_id=nullif(current_setting('app.merchant_id',true),'')::uuid);
create policy anon_sessions_update_tenant on taply.anonymous_card_sessions
  for update to taply_app using
  (merchant_id=nullif(current_setting('app.merchant_id',true),'')::uuid)
  with check (merchant_id=nullif(current_setting('app.merchant_id',true),'')::uuid);
alter table taply.anonymous_card_sessions owner to taply_owner;

create table taply.card_recovery_secrets (
  membership_id uuid primary key,
  merchant_id uuid not null,
  program_id uuid not null,
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recovery_membership_merchant_fk
    foreign key (membership_id,merchant_id) references taply.memberships(id,merchant_id),
  constraint recovery_program_merchant_fk
    foreign key (program_id,merchant_id) references taply.loyalty_programs(id,merchant_id)
);
create index recovery_merchant_program_idx
  on taply.card_recovery_secrets(merchant_id,program_id);
alter table taply.card_recovery_secrets enable row level security;
alter table taply.card_recovery_secrets force row level security;
grant select,insert on taply.card_recovery_secrets to taply_app;
grant update (code_hash,updated_at) on taply.card_recovery_secrets to taply_app;
create policy recovery_select_tenant on taply.card_recovery_secrets
  for select to taply_app using
  (merchant_id=nullif(current_setting('app.merchant_id',true),'')::uuid);
create policy recovery_insert_tenant on taply.card_recovery_secrets
  for insert to taply_app with check
  (merchant_id=nullif(current_setting('app.merchant_id',true),'')::uuid);
create policy recovery_update_tenant on taply.card_recovery_secrets
  for update to taply_app using
  (merchant_id=nullif(current_setting('app.merchant_id',true),'')::uuid)
  with check (merchant_id=nullif(current_setting('app.merchant_id',true),'')::uuid);
alter table taply.card_recovery_secrets owner to taply_owner;

-- Coarse per-program recovery budget, safely serialized in the application.
-- No IP, user-agent or device fingerprint is collected.
create table taply.recovery_attempt_buckets (
  merchant_id uuid not null,
  program_id uuid not null,
  window_start timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0),
  primary key (merchant_id,program_id,window_start),
  constraint recovery_bucket_program_merchant_fk
    foreign key (program_id,merchant_id) references taply.loyalty_programs(id,merchant_id)
);
alter table taply.recovery_attempt_buckets enable row level security;
alter table taply.recovery_attempt_buckets force row level security;
grant select,insert on taply.recovery_attempt_buckets to taply_app;
grant update (attempts) on taply.recovery_attempt_buckets to taply_app;
create policy recovery_bucket_select_tenant on taply.recovery_attempt_buckets
  for select to taply_app using
  (merchant_id=nullif(current_setting('app.merchant_id',true),'')::uuid);
create policy recovery_bucket_insert_tenant on taply.recovery_attempt_buckets
  for insert to taply_app with check
  (merchant_id=nullif(current_setting('app.merchant_id',true),'')::uuid);
create policy recovery_bucket_update_tenant on taply.recovery_attempt_buckets
  for update to taply_app using
  (merchant_id=nullif(current_setting('app.merchant_id',true),'')::uuid)
  with check (merchant_id=nullif(current_setting('app.merchant_id',true),'')::uuid);
alter table taply.recovery_attempt_buckets owner to taply_owner;
