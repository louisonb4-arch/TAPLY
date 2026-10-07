-- current_rule_version_id « pingle » la version de règles du cycle en
-- cours : un client en cycle actif garde l'ancienne règle même si une
-- nouvelle version devient active ailleurs ; seul un futur rollover de
-- cycle (LoyaltyService, pas construit ici) ré-pointe cette colonne.
-- La FK composite à 3 colonnes empêche physiquement de pointer une version
-- appartenant à un autre programme ou à un autre merchant.
create table taply.memberships (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null,
  customer_id uuid not null,
  program_id uuid not null,
  current_rule_version_id uuid not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memberships_customer_program_key unique (customer_id, program_id),
  constraint memberships_id_merchant_id_key unique (id, merchant_id),
  constraint memberships_customer_merchant_fkey
    foreign key (customer_id, merchant_id)
    references taply.customers (id, merchant_id)
    on delete restrict,
  constraint memberships_program_merchant_fkey
    foreign key (program_id, merchant_id)
    references taply.loyalty_programs (id, merchant_id)
    on delete restrict,
  constraint memberships_rule_version_program_merchant_fkey
    foreign key (current_rule_version_id, program_id, merchant_id)
    references taply.program_rule_versions (id, program_id, merchant_id)
    on delete restrict
);

create index memberships_merchant_id_idx on taply.memberships (merchant_id);
create index memberships_program_id_idx on taply.memberships (program_id);
create index memberships_current_rule_version_id_idx on taply.memberships (current_rule_version_id);

alter table taply.memberships enable row level security;
alter table taply.memberships force row level security;

-- SELECT + INSERT seulement : le rollover de cycle (UPDATE de
-- current_rule_version_id) est une responsabilité du futur LoyaltyService,
-- pas de cette phase — pas de grant UPDATE tant que ce code n'existe pas.
grant select, insert on taply.memberships to taply_app;

create policy select_tenant on taply.memberships
  for select to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

create policy insert_tenant on taply.memberships
  for insert to taply_app
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

alter table taply.memberships owner to taply_owner;
