-- Phase 3A — identité d'authentification → identité métier merchant.
--
-- Supabase Auth reste la seule source de vérité pour l'identité
-- d'authentification (email/mot de passe, etc.) — cette table ne stocke
-- ni email, ni mot de passe, ni PII de profil. Elle fait uniquement le
-- pont : « cet auth_user_id a le droit d'agir pour ce merchant, avec ce
-- rôle ».
--
-- V1 simplifié : une identité Supabase Auth appartient à UN seul merchant
-- (UNIQUE(auth_user_id)). Pas de multi-merchant par identité pour
-- l'instant — pas justifié par un besoin réel actuel.
--
-- FK vers auth.users(id) : pattern officiellement documenté et supporté
-- par Supabase (ex. leurs propres exemples « profiles » référencent
-- auth.users(id) de la même façon).
--
-- ON DELETE RESTRICT, pas CASCADE. Suppression d'une identité
-- d'authentification est une opération de cycle de vie applicatif
-- contrôlée, jamais un side-effect implicite de la base. Avec CASCADE,
-- supprimer auth.users entraînerait un cascade vers merchant_users — mais
-- merchant_sessions référence merchant_users en ON DELETE RESTRICT (une
-- session active bloque la suppression de son merchant_user) : avec une
-- session active, delete auth.users échouerait quand même, juste plus
-- tard dans la chaîne, avec une erreur moins claire (conflit entre
-- CASCADE côté auth.users et RESTRICT côté merchant_sessions). RESTRICT
-- ici rend l'exigence explicite et immédiate : un futur flux de
-- suppression de compte devra, dans cet ordre : 1) révoquer/supprimer les
-- sessions Taply concernées, 2) supprimer le mapping merchant_user,
-- 3) supprimer l'identité Supabase Auth. Pas de trigger, pas de
-- SECURITY DEFINER, pas de flux de suppression construit ici — seulement
-- la contrainte qui empêche un cascade implicite de faire ce travail.
create table taply.merchant_users (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references taply.merchants (id) on delete restrict,
  auth_user_id uuid not null references auth.users (id) on delete restrict,
  role text not null check (role in ('owner', 'staff')),
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint merchant_users_auth_user_id_key unique (auth_user_id),
  -- Cible de FK composite pour merchant_sessions : prouve que la session
  -- pointe vers le MÊME merchant_user, merchant et identité auth à la fois
  -- — pas seulement un merchant_user_id isolé.
  constraint merchant_users_id_merchant_auth_key unique (id, merchant_id, auth_user_id)
);

create index merchant_users_merchant_id_idx on taply.merchant_users (merchant_id);

alter table taply.merchant_users enable row level security;
alter table taply.merchant_users force row level security;

-- Lecture seule, et uniquement la ligne de l'identité authentifiée elle-
-- même — jamais de liste. L'administration des merchant_users (créer un
-- staff, désactiver un owner, etc.) est un futur flux contrôlé séparé,
-- pas construit ici : pas de grant INSERT/UPDATE/DELETE à taply_app.
grant select on taply.merchant_users to taply_app;

-- Résolution pré-TenantContext : avant qu'on connaisse le merchant, on
-- sait seulement quel auth_user_id vient de s'authentifier auprès de
-- Supabase Auth. Deux couches indépendantes, comme pour le lookup public
-- (voir public_enrollment_links) : le backend filtre explicitement
-- `WHERE auth_user_id = $1` (backend/auth/*), ET cette policy l'exige
-- indépendamment — sans le GUC exact, aucune ligne, quelle que soit la
-- requête émise par taply_app sur cette table.
create policy auth_user_lookup on taply.merchant_users
  for select to taply_app
  using (
    status = 'active'
    and auth_user_id = nullif(current_setting('app.auth_user_id', true), '')::uuid
  );

alter table taply.merchant_users owner to taply_owner;
