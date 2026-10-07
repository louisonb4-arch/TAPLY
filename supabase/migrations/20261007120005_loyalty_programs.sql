-- Pas de public_token ici : la résolution publique passe par
-- taply.public_enrollment_links (table dédiée, non énumérable).
create table taply.loyalty_programs (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references taply.merchants (id) on delete restrict,
  name text not null,
  status text not null default 'active' check (status in ('active', 'paused', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint loyalty_programs_id_merchant_id_key unique (id, merchant_id)
);

create index loyalty_programs_merchant_id_idx on taply.loyalty_programs (merchant_id);

alter table taply.loyalty_programs enable row level security;
alter table taply.loyalty_programs force row level security;

-- Lecture seule pour taply_app en Phase 2 (pas de route de gestion encore).
grant select on taply.loyalty_programs to taply_app;

create policy select_tenant on taply.loyalty_programs
  for select to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

alter table taply.loyalty_programs owner to taply_owner;
