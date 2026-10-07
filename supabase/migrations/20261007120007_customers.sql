-- Aucune colonne PII en Phase 2 : différé jusqu'à ce qu'un besoin réel
-- (contact, lien Wallet, …) le justifie, avec sa propre migration.
create table taply.customers (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references taply.merchants (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customers_id_merchant_id_key unique (id, merchant_id)
);

create index customers_merchant_id_idx on taply.customers (merchant_id);

alter table taply.customers enable row level security;
alter table taply.customers force row level security;

-- SELECT + INSERT : seule table (avec memberships et idempotency_requests)
-- réellement écrite par le runtime en Phase 2 (enrollment anonyme — A1).
grant select, insert on taply.customers to taply_app;

create policy select_tenant on taply.customers
  for select to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

create policy insert_tenant on taply.customers
  for insert to taply_app
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

alter table taply.customers owner to taply_owner;
