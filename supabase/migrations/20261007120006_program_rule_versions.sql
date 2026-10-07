-- `rules` reste opaque en Phase 2 : lu/écrit par le futur LoyaltyService,
-- jamais ici. Au plus une version active par programme (index partiel).
create table taply.program_rule_versions (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null,
  program_id uuid not null,
  version_no integer not null,
  rules jsonb not null,
  is_active boolean not null default false,
  effective_from timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint program_rule_versions_program_version_key unique (program_id, version_no),
  -- Cible de FK composite à 3 colonnes pour memberships.current_rule_version_id :
  -- prouve qu'une version de règles appartient au même programme ET au même
  -- merchant que la membership qui la pointe.
  constraint program_rule_versions_id_program_merchant_key unique (id, program_id, merchant_id),
  constraint program_rule_versions_program_merchant_fkey
    foreign key (program_id, merchant_id)
    references taply.loyalty_programs (id, merchant_id)
    on delete restrict
);

create unique index program_rule_versions_one_active_per_program
  on taply.program_rule_versions (program_id)
  where is_active;

create index program_rule_versions_merchant_id_idx on taply.program_rule_versions (merchant_id);

alter table taply.program_rule_versions enable row level security;
alter table taply.program_rule_versions force row level security;

-- Lecture seule pour taply_app en Phase 2 (pas de rules engine encore).
grant select on taply.program_rule_versions to taply_app;

create policy select_tenant on taply.program_rule_versions
  for select to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

alter table taply.program_rule_versions owner to taply_owner;
