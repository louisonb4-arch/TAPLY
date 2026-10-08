-- Parcours client de démonstration : prénom minimal + consentement explicite.
-- Migration additive. Toutes les opérations passent par un employé approuvé.
-- AUCUN onboarding public sans anti-abus ni confirmation en comptoir.

create table taply.customer_profiles (
  customer_id uuid primary key,
  merchant_id uuid not null,
  first_name text not null check (length(first_name) between 1 and 40),
  privacy_accepted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint customer_profiles_customer_merchant_fkey
    foreign key (customer_id, merchant_id)
    references taply.customers (id, merchant_id) on delete restrict
);
create index customer_profiles_merchant_idx on taply.customer_profiles(merchant_id);
alter table taply.customer_profiles enable row level security;
alter table taply.customer_profiles force row level security;
grant select on taply.customer_profiles to taply_app;
grant insert (customer_id, merchant_id, first_name) on taply.customer_profiles to taply_app;
create policy select_tenant on taply.customer_profiles for select to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
create policy insert_tenant on taply.customer_profiles for insert to taply_app
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
alter table taply.customer_profiles owner to taply_owner;

-- Options du programme : notifications désactivées par défaut.
create table taply.program_preferences (
  merchant_id uuid not null,
  program_id uuid not null,
  notifications_enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint program_preferences_pkey primary key (program_id),
  constraint program_preferences_program_merchant_fkey
    foreign key (program_id, merchant_id)
    references taply.loyalty_programs (id, merchant_id) on delete restrict
);
create index program_preferences_merchant_idx on taply.program_preferences(merchant_id);
alter table taply.program_preferences enable row level security;
alter table taply.program_preferences force row level security;
grant select on taply.program_preferences to taply_app;
grant insert (merchant_id, program_id, notifications_enabled) on taply.program_preferences to taply_app;
grant update (notifications_enabled, updated_at) on taply.program_preferences to taply_app;
create policy select_tenant on taply.program_preferences for select to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
create policy insert_tenant on taply.program_preferences for insert to taply_app
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
create policy update_tenant on taply.program_preferences for update to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid)
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
alter table taply.program_preferences owner to taply_owner;

-- Le propriétaire peut suspendre un programme; l'autorisation rôle est vérifiée serveur.
grant update (status, updated_at) on taply.loyalty_programs to taply_app;
create policy update_tenant on taply.loyalty_programs for update to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid)
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

-- Versions immuables (rules/version_no jamais modifiables), activation séparée.
grant insert (id, merchant_id, program_id, version_no, rules, is_active)
  on taply.program_rule_versions to taply_app;
grant update (is_active) on taply.program_rule_versions to taply_app;
create policy insert_tenant on taply.program_rule_versions for insert to taply_app
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
create policy update_tenant on taply.program_rule_versions for update to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid)
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
