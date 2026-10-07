-- Support de lookup public pré-tenant : résout public_token → merchant_id,
-- location_id, program_id. Table volontairement minimale — aucune colonne
-- métier privée — pour qu'un SELECT * accidentel sur la ligne autorisée ne
-- révèle rien de plus que ce que l'appelant savait déjà (le jeton).
--
-- Sécurité par construction, pas par grant de colonne : la policy
-- public_token_lookup exige l'égalité exacte avec un jeton à 160 bits
-- d'entropie (généré côté Node, jamais par la base) — sans le jeton, zéro
-- ligne, quelle que soit la requête. Aucun flag « is_public », aucun
-- listing global possible.
--
-- Les FK composites prouvent que la location et le programme appartiennent
-- bien à CE merchant — impossible de construire un lien qui mélange des
-- parents de merchants différents.
create table taply.public_enrollment_links (
  id uuid primary key default gen_random_uuid(),
  public_token text not null,
  merchant_id uuid not null,
  location_id uuid not null,
  program_id uuid not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint public_enrollment_links_public_token_key unique (public_token),
  constraint public_enrollment_links_location_merchant_fkey
    foreign key (location_id, merchant_id)
    references taply.locations (id, merchant_id)
    on delete restrict,
  constraint public_enrollment_links_program_merchant_fkey
    foreign key (program_id, merchant_id)
    references taply.loyalty_programs (id, merchant_id)
    on delete restrict
);

create index public_enrollment_links_merchant_id_idx on taply.public_enrollment_links (merchant_id);

alter table taply.public_enrollment_links enable row level security;
alter table taply.public_enrollment_links force row level security;

-- Lecture seule pour taply_app : la création/désactivation de liens est une
-- action d'administration (hors-bande en Phase 2, pas de route de gestion
-- encore) — pas de grant INSERT/UPDATE tant que ce code n'existe pas.
grant select on taply.public_enrollment_links to taply_app;

-- SEULE policy SELECT : aucun code Phase 2 ne gère/liste cette table sous
-- TenantContext (pas de route de gestion merchant encore) — pas de policy
-- `select_tenant` tant que cet usage n'existe pas réellement. Résolution
-- publique pré-tenant : jeton exact uniquement, combiné à un `WHERE
-- public_token = $1` applicatif (backend/db/lookup.ts) — RLS reste la
-- garantie même si ce WHERE venait à manquer.
create policy public_token_lookup on taply.public_enrollment_links
  for select to taply_app
  using (
    status = 'active'
    and public_token = nullif(current_setting('app.lookup_token', true), '')
  );

alter table taply.public_enrollment_links owner to taply_owner;
