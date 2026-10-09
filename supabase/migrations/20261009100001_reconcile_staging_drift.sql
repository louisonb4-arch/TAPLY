-- Réconciliation de dérive (constat d'audit du 2026-10-09).
--
-- Sur taply-staging, la version 20261008100010 enregistrée dans
-- supabase_migrations.schema_migrations correspond à une migration
-- « owner_public_link » d'une branche pilote, PAS à program_publications.
-- Le CLI considérait donc program_publications comme appliquée alors que la
-- table n'existait pas : publication du programme et carte publique
-- échouaient sur staging.
--
-- Cette migration est idempotente :
--   - base créée depuis ce dépôt : program_publications existe déjà → no-op ;
--   - staging : crée la table, ses droits et ses policies, puis retire les
--     droits/policies pilotes (INSERT direct de taply_app sur locations et
--     public_enrollment_links) que ce code n'utilise jamais — la création
--     de location/lien passe par le trigger SECURITY DEFINER de 100011.

create table if not exists taply.program_publications (
  program_id uuid primary key,
  merchant_id uuid not null,
  reward_title text,
  reward_terms text not null default '',
  card_color text not null default '#10241A',
  text_color text not null default '#FFFFFF',
  published_at timestamptz,
  terms_version integer not null default 1 check (terms_version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint program_publications_program_merchant_fkey
    foreign key (program_id, merchant_id)
    references taply.loyalty_programs (id, merchant_id) on delete restrict,
  constraint program_publications_reward_title_check
    check (reward_title is null or length(btrim(reward_title)) between 3 and 120),
  constraint program_publications_reward_terms_check
    check (length(reward_terms) <= 2000),
  constraint program_publications_color_check
    check (card_color ~ '^#[0-9A-Fa-f]{6}$'
       and text_color ~ '^#[0-9A-Fa-f]{6}$'),
  constraint program_publications_published_has_reward_check
    check (published_at is null or reward_title is not null)
);

create index if not exists program_publications_merchant_id_idx
  on taply.program_publications (merchant_id);

alter table taply.program_publications enable row level security;
alter table taply.program_publications force row level security;

grant select on taply.program_publications to taply_app;
grant insert (program_id, merchant_id, reward_title, reward_terms, card_color, text_color)
  on taply.program_publications to taply_app;
grant update (reward_title, reward_terms, card_color, text_color,
              published_at, terms_version, updated_at)
  on taply.program_publications to taply_app;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'taply'
      and tablename = 'program_publications'
      and policyname = 'program_publications_select_tenant') then
    create policy program_publications_select_tenant on taply.program_publications
      for select to taply_app
      using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'taply'
      and tablename = 'program_publications'
      and policyname = 'program_publications_insert_tenant') then
    create policy program_publications_insert_tenant on taply.program_publications
      for insert to taply_app
      with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'taply'
      and tablename = 'program_publications'
      and policyname = 'program_publications_update_tenant') then
    create policy program_publications_update_tenant on taply.program_publications
      for update to taply_app
      using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid)
      with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
  end if;
end
$$;

alter table taply.program_publications owner to taply_owner;

-- Retrait de la dérive pilote (absente du dépôt, jamais utilisée par ce code).
drop policy if exists insert_owner_location on taply.locations;
drop policy if exists insert_owner_public_link on taply.public_enrollment_links;
drop policy if exists select_owner_public_link on taply.public_enrollment_links;
revoke insert on taply.locations from taply_app;
revoke insert on taply.public_enrollment_links from taply_app;
