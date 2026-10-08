-- TAPLY QR V1 / LOT 1 : publication sécurisée d'un programme.
-- Migration STRICTEMENT ADDITIVE. Aucun programme existant n'est publié
-- implicitement et aucun compteur, QR individuel ou profil n'est touché.
--
-- Le statut 'active' dans taply.loyalty_programs est une disponibilité
-- métier historique; l'adhésion publique QR V1 devra en plus exiger
-- program_publications.published_at IS NOT NULL.
create table taply.program_publications (
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

create index program_publications_merchant_id_idx
  on taply.program_publications (merchant_id);

alter table taply.program_publications enable row level security;
alter table taply.program_publications force row level security;

-- Autorise seulement la connexion serveur applicative scindée par tenant.
-- Aucun GRANT accordé à anon/authenticated ni à PUBLIC.
grant select on taply.program_publications to taply_app;
grant insert (program_id, merchant_id, reward_title, reward_terms, card_color, text_color)
  on taply.program_publications to taply_app;
grant update (reward_title, reward_terms, card_color, text_color,
              published_at, terms_version, updated_at)
  on taply.program_publications to taply_app;

create policy program_publications_select_tenant on taply.program_publications
  for select to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

create policy program_publications_insert_tenant on taply.program_publications
  for insert to taply_app
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

create policy program_publications_update_tenant on taply.program_publications
  for update to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid)
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

alter table taply.program_publications owner to taply_owner;
