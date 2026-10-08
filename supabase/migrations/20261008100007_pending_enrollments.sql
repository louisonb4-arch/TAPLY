-- Le QR PUBLIC sert uniquement à préparer l'inscription. Il n'accorde
-- AUCUN passage, AUCUNE récompense et AUCUN QR Wallet personnel.
-- L'employé autorisé confirme au comptoir dans une transaction séparée.
create table taply.pending_enrollments (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null,
  program_id uuid not null,
  location_id uuid not null,
  claim_hash text not null unique,
  first_name text not null check(length(first_name) between 1 and 40),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint pending_enrollments_hash_shape check(claim_hash ~ '^[0-9a-f]{64}$'),
  constraint pending_enrollments_program_merchant_fkey
    foreign key (program_id, merchant_id)
    references taply.loyalty_programs(id, merchant_id) on delete restrict,
  constraint pending_enrollments_location_merchant_fkey
    foreign key (location_id, merchant_id)
    references taply.locations(id, merchant_id) on delete restrict
);
create index pending_enrollments_merchant_created_idx
  on taply.pending_enrollments(merchant_id, created_at desc);
create index pending_enrollments_expires_idx
  on taply.pending_enrollments(expires_at);
alter table taply.pending_enrollments enable row level security;
alter table taply.pending_enrollments force row level security;
grant select, insert, delete on taply.pending_enrollments to taply_app;
create policy select_tenant on taply.pending_enrollments for select to taply_app
  using (merchant_id=nullif(current_setting('app.merchant_id',true),'')::uuid);
create policy insert_tenant on taply.pending_enrollments for insert to taply_app
  with check (merchant_id=nullif(current_setting('app.merchant_id',true),'')::uuid);
create policy delete_tenant on taply.pending_enrollments for delete to taply_app
  using (merchant_id=nullif(current_setting('app.merchant_id',true),'')::uuid);
alter table taply.pending_enrollments owner to taply_owner;
