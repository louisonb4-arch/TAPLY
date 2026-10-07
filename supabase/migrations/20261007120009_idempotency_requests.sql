-- status: 'failed' délibérément absent. Sous l'invariant « claim + mutation
-- métier + finalize dans UNE seule transaction », toute erreur fait un
-- ROLLBACK complet (y compris le claim) — aucun scénario de Phase 2 ne
-- committe durablement un statut d'échec. 'pending' reste la valeur
-- transitoire entre l'INSERT de claim et l'UPDATE de finalize, dans la même
-- transaction ; une ligne commise reste donc toujours vue en 'completed'.
create table taply.idempotency_requests (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references taply.merchants (id) on delete restrict,
  operation text not null,
  idempotency_key text not null,
  request_fingerprint text not null,
  status text not null default 'pending' check (status in ('pending', 'completed')),
  response jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint idempotency_requests_merchant_operation_key_key
    unique (merchant_id, operation, idempotency_key)
);

create index idempotency_requests_merchant_id_idx on taply.idempotency_requests (merchant_id);

alter table taply.idempotency_requests enable row level security;
alter table taply.idempotency_requests force row level security;

grant select, insert on taply.idempotency_requests to taply_app;
-- UPDATE colonne par colonne : seules les 3 colonnes que runIdempotent
-- finalise réellement (backend/db/idempotency.ts) sont modifiables.
-- merchant_id, operation, idempotency_key, request_fingerprint et
-- created_at restent immuables pour taply_app après l'INSERT de claim —
-- même avec le rôle applicatif, même sous la policy update_tenant.
grant update (status, response, updated_at) on taply.idempotency_requests to taply_app;

create policy select_tenant on taply.idempotency_requests
  for select to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

create policy insert_tenant on taply.idempotency_requests
  for insert to taply_app
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

create policy update_tenant on taply.idempotency_requests
  for update to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid)
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

alter table taply.idempotency_requests owner to taply_owner;
