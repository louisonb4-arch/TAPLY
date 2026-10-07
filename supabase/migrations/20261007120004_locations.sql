create table taply.locations (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references taply.merchants (id) on delete restrict,
  name text not null,
  slug text not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint locations_merchant_slug_key unique (merchant_id, slug),
  -- Cible de FK composite pour les enfants (public_enrollment_links, …) :
  -- prouve physiquement qu'une location appartient à CE merchant.
  constraint locations_id_merchant_id_key unique (id, merchant_id)
);

create index locations_merchant_id_idx on taply.locations (merchant_id);

alter table taply.locations enable row level security;
alter table taply.locations force row level security;

-- Lecture seule pour taply_app en Phase 2 (pas de route de gestion encore).
grant select on taply.locations to taply_app;

create policy select_tenant on taply.locations
  for select to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

alter table taply.locations owner to taply_owner;
