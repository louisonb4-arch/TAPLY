-- Racine du tenant. Jamais exposée à une résolution publique : le lookup
-- pré-tenant passe uniquement par taply.public_enrollment_links.
--
-- Créée avec le rôle de migration (postgres) ; ownership transféré
-- explicitement à la fin via ALTER TABLE ... OWNER TO — pas de SET ROLE.
create table taply.merchants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null,
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint merchants_slug_key unique (slug)
);

alter table taply.merchants enable row level security;
alter table taply.merchants force row level security;

-- Lecture seule pour taply_app en Phase 2 : aucune route n'écrit encore sur
-- cette table (provisioning fait hors-bande, via une connexion élevée).
grant select on taply.merchants to taply_app;

create policy select_tenant on taply.merchants
  for select to taply_app
  using (id = nullif(current_setting('app.merchant_id', true), '')::uuid);

-- Transfert d'ownership explicite — dernier statement. Les index associés
-- suivent automatiquement (comportement documenté d'ALTER TABLE OWNER TO).
alter table taply.merchants owner to taply_owner;
