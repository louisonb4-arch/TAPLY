-- Phase 3A — session opaque Taply (jamais un token/JWT Supabase exposé au
-- navigateur). Le token BRUT n'est jamais stocké : seule une empreinte
-- SHA-256 hex (64 caractères) l'est, vérifiée par CHECK.
--
-- Pas de FK simple merchant_id → merchants : la FK composite à 3 colonnes
-- ci-dessous (merchant_user_id, merchant_id, auth_user_id) vers
-- merchant_users suffit et prouve plus — merchant_users garantit déjà que
-- son propre merchant_id référence un vrai merchant. Même principe que
-- memberships/program_rule_versions dans les migrations certifiées.
create table taply.merchant_sessions (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null,
  merchant_user_id uuid not null,
  auth_user_id uuid not null,
  token_hash text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  reauthenticated_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint merchant_sessions_token_hash_key unique (token_hash),
  constraint merchant_sessions_token_hash_shape check (token_hash ~ '^[0-9a-f]{64}$'),
  -- Empêche physiquement un mélange identité/tenant : la session ne peut
  -- pointer que vers un merchant_user qui appartient bien à CE merchant
  -- ET à CETTE identité auth à la fois.
  constraint merchant_sessions_user_merchant_auth_fkey
    foreign key (merchant_user_id, merchant_id, auth_user_id)
    references taply.merchant_users (id, merchant_id, auth_user_id)
    on delete restrict
);

create index merchant_sessions_merchant_id_idx on taply.merchant_sessions (merchant_id);
create index merchant_sessions_merchant_user_id_idx on taply.merchant_sessions (merchant_user_id);

alter table taply.merchant_sessions enable row level security;
alter table taply.merchant_sessions force row level security;

grant select, insert on taply.merchant_sessions to taply_app;
-- UPDATE colonne par colonne : seules les colonnes qu'un touch/logout/
-- reauth légitime modifie réellement (backend/auth/session.ts). Jamais
-- token_hash, jamais les colonnes d'identité/tenant, jamais created_at.
grant update (last_seen_at, idle_expires_at, reauthenticated_at, revoked_at, updated_at)
  on taply.merchant_sessions to taply_app;
-- Pas de DELETE : la révocation passe par revoked_at, jamais une
-- suppression physique (traçabilité).

-- Lookup pré-TenantContext, même principe que public_enrollment_links et
-- merchant_users.auth_user_lookup : filtre applicatif explicite
-- (`WHERE token_hash = $1`, backend/auth/session.ts) ET cette policy
-- l'exige indépendamment — session active, non révoquée, non expirée
-- (idle ET absolue), sinon aucune ligne.
create policy session_token_lookup on taply.merchant_sessions
  for select to taply_app
  using (
    token_hash = nullif(current_setting('app.session_token_hash', true), '')
    and revoked_at is null
    and idle_expires_at > now()
    and absolute_expires_at > now()
  );

-- Création : uniquement pour SA PROPRE identité, dans SON PROPRE merchant
-- déjà résolu — jamais une session au nom de quelqu'un d'autre. La FK
-- composite ci-dessus est une seconde barrière indépendante : même si
-- cette policy avait un trou, impossible de référencer un merchant_user
-- qui ne correspond pas exactement à (merchant_id, auth_user_id).
create policy insert_own_session on taply.merchant_sessions
  for insert to taply_app
  with check (
    merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid
    and auth_user_id = nullif(current_setting('app.auth_user_id', true), '')::uuid
  );

-- Mise à jour : uniquement LA session exacte identifiée par son propre
-- jeton (touch/logout/reauth) — jamais une autre ligne, même avec le
-- grant colonne par colonne.
create policy update_own_session on taply.merchant_sessions
  for update to taply_app
  using (token_hash = nullif(current_setting('app.session_token_hash', true), ''))
  with check (token_hash = nullif(current_setting('app.session_token_hash', true), ''));

alter table taply.merchant_sessions owner to taply_owner;
