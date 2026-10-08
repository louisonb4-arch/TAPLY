-- Phase 4 — QR Wallet opaque par membership, sans retoucher les migrations
-- précédemment certifiées. On ne stocke jamais le jeton brut affiché
-- dans le Wallet : uniquement SHA-256(domain || token) hexadécimal.
--
-- La copie du QR/screenshot reste possible : hashing at rest n'est pas
-- un anti-replay. Les crédits exigent une validation d'employé authentifié
-- sur appareil approuvé et les verrous/cooldown/idempotence métier.
create table taply.wallet_qr_tokens (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null,
  merchant_id uuid not null,
  token_hash text not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint wallet_qr_tokens_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint wallet_qr_tokens_membership_merchant_fkey
    foreign key (membership_id, merchant_id)
    references taply.memberships (id, merchant_id)
    on delete restrict
);

-- Un même hash ne correspond jamais à plusieurs identités.
create unique index wallet_qr_tokens_token_hash_key
  on taply.wallet_qr_tokens (token_hash);

-- Un seul QR actif par membership ; rotation = révocation puis insertion
-- dans UNE transaction autorisée, jamais réactivation d'un ancien jeton.
create unique index wallet_qr_tokens_one_active_per_membership
  on taply.wallet_qr_tokens (membership_id)
  where revoked_at is null;

create index wallet_qr_tokens_merchant_id_idx
  on taply.wallet_qr_tokens (merchant_id);

alter table taply.wallet_qr_tokens enable row level security;
alter table taply.wallet_qr_tokens force row level security;

-- Sécurité en profondeur : accès strictement tenant, jamais anonyme.
grant select on taply.wallet_qr_tokens to taply_app;
grant insert (membership_id, merchant_id, token_hash)
  on taply.wallet_qr_tokens to taply_app;
grant update (revoked_at)
  on taply.wallet_qr_tokens to taply_app;

create policy select_tenant on taply.wallet_qr_tokens
  for select to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

create policy insert_tenant on taply.wallet_qr_tokens
  for insert to taply_app
  with check (
    merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid
    and revoked_at is null
  );

-- Transition irréversible vers "révoqué" pour ce rôle :
-- aucun utilisateur applicatif ne peut remettre revoked_at à NULL.
create policy revoke_tenant on taply.wallet_qr_tokens
  for update to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid)
  with check (
    merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid
    and revoked_at is not null
  );

alter table taply.wallet_qr_tokens owner to taply_owner;
