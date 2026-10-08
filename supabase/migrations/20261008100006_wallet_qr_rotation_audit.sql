-- Historique immuable de remplacement de QR Wallet.
-- L'ancien token est révoqué dans la même transaction avant émission du nouveau.
create table taply.wallet_qr_rotations (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null,
  merchant_id uuid not null,
  performed_by uuid not null,
  old_hash text,
  new_hash text not null,
  created_at timestamptz not null default now(),
  constraint wallet_qr_rotations_membership_fkey
    foreign key (membership_id, merchant_id)
    references taply.memberships(id,merchant_id) on delete restrict,
  constraint wallet_qr_rotations_performer_fkey
    foreign key (performed_by, merchant_id)
    references taply.merchant_users(id,merchant_id) on delete restrict,
  constraint wallet_qr_rotations_hash_shape check
    ((old_hash is null or old_hash ~ '^[0-9a-f]{64}$')
      and new_hash ~ '^[0-9a-f]{64}$')
);
create index wallet_qr_rotations_membership_idx
  on taply.wallet_qr_rotations(membership_id);
create index wallet_qr_rotations_merchant_idx
  on taply.wallet_qr_rotations(merchant_id);

alter table taply.wallet_qr_rotations enable row level security;
alter table taply.wallet_qr_rotations force row level security;
grant select on taply.wallet_qr_rotations to taply_app;
grant insert(membership_id, merchant_id, performed_by, old_hash, new_hash)
  on taply.wallet_qr_rotations to taply_app;
create policy select_tenant on taply.wallet_qr_rotations for select to taply_app
  using (merchant_id=nullif(current_setting('app.merchant_id',true),'')::uuid);
create policy insert_tenant on taply.wallet_qr_rotations for insert to taply_app
  with check (merchant_id=nullif(current_setting('app.merchant_id',true),'')::uuid);
alter table taply.wallet_qr_rotations owner to taply_owner;
