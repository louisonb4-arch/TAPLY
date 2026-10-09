-- Programme de fidélité V1 complet :
--   - plusieurs récompenses par programme, portées par la version de règles
--     (rules.rewards) : un client en cycle garde ses conditions (seuil ET
--     récompenses) jusqu'à la fin du cycle, via memberships.current_rule_version_id ;
--   - verrou contractuel de 30 jours après publication, vérifié en base
--     (défense en profondeur ; la décision applicative reste rules.ts) ;
--   - choix de récompense par le client puis remise confirmée par l'équipe
--     (reward_claims), une seule par cycle ;
--   - historique de remise enrichi (récompense choisie) ;
--   - édition non contractuelle du commerce (nom, ville) ;
--   - QR personnel temporaire (expires_at) et déverrouillage d'appareil.

-- ── Versions de règles : auteur et motif ────────────────────────────
alter table taply.program_rule_versions
  add column created_by uuid,
  add column change_reason text check (change_reason is null or length(change_reason) <= 200);
grant insert (created_by, change_reason) on taply.program_rule_versions to taply_app;

-- ── Publication : date du dernier changement contractuel ────────────
alter table taply.program_publications
  add column contract_changed_at timestamptz;
grant update (contract_changed_at) on taply.program_publications to taply_app;
update taply.program_publications
   set contract_changed_at = published_at
 where published_at is not null and contract_changed_at is null;

-- Une nouvelle version de règles d'un programme PUBLIÉ n'est acceptée que si
-- le dernier changement contractuel date d'au moins 30 jours. Avant
-- publication (brouillon, aucune carte possible), l'édition est libre.
create function taply.guard_rule_version_contract_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  locked_since timestamptz;
begin
  select pub.contract_changed_at into locked_since
    from taply.program_publications pub
   where pub.program_id = new.program_id
     and pub.merchant_id = new.merchant_id
     and pub.published_at is not null;
  if locked_since is not null and locked_since > pg_catalog.now() - interval '30 days' then
    raise sqlstate 'P0001' using message = 'contract_locked';
  end if;
  return new;
end
$$;

revoke all on function taply.guard_rule_version_contract_v1() from public;

create trigger guard_rule_version_contract_v1
  before insert on taply.program_rule_versions
  for each row execute function taply.guard_rule_version_contract_v1();

-- ── Choix et remise de récompense ───────────────────────────────────
create table taply.reward_claims (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null,
  merchant_id uuid not null,
  cycle_number integer not null check (cycle_number >= 1),
  reward_key text not null check (reward_key ~ '^[a-z0-9_-]{1,32}$'),
  reward_title text not null check (length(btrim(reward_title)) between 2 and 120),
  chosen_by text not null check (chosen_by in ('customer', 'staff')),
  chosen_at timestamptz not null default now(),
  status text not null default 'awaiting_handover'
    check (status in ('awaiting_handover', 'handed_over')),
  handed_over_at timestamptz,
  handed_over_by uuid,
  created_at timestamptz not null default now(),
  constraint reward_claims_membership_cycle_key unique (membership_id, cycle_number),
  constraint reward_claims_id_merchant_key unique (id, merchant_id),
  constraint reward_claims_membership_merchant_fkey
    foreign key (membership_id, merchant_id)
    references taply.memberships (id, merchant_id) on delete restrict,
  constraint reward_claims_handover_by_fkey
    foreign key (handed_over_by, merchant_id)
    references taply.merchant_users (id, merchant_id) on delete restrict,
  constraint reward_claims_handover_consistency check (
    (status = 'awaiting_handover' and handed_over_at is null and handed_over_by is null)
    or (status = 'handed_over' and handed_over_at is not null and handed_over_by is not null)
  )
);

create index reward_claims_merchant_status_idx on taply.reward_claims (merchant_id, status, chosen_at desc);

alter table taply.reward_claims enable row level security;
alter table taply.reward_claims force row level security;

grant select on taply.reward_claims to taply_app;
grant insert (membership_id, merchant_id, cycle_number, reward_key, reward_title, chosen_by)
  on taply.reward_claims to taply_app;
grant update (reward_key, reward_title, chosen_by, chosen_at, status, handed_over_at, handed_over_by)
  on taply.reward_claims to taply_app;

create policy select_tenant on taply.reward_claims for select to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
create policy insert_tenant on taply.reward_claims for insert to taply_app
  with check (
    merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid
    and status = 'awaiting_handover'
  );
-- Une récompense remise est définitive : aucune mise à jour possible ensuite.
create policy update_awaiting_tenant on taply.reward_claims for update to taply_app
  using (
    merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid
    and status = 'awaiting_handover'
  )
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

alter table taply.reward_claims owner to taply_owner;

alter table taply.redemption_ledger
  add column reward_key text check (reward_key is null or reward_key ~ '^[a-z0-9_-]{1,32}$'),
  add column reward_title text check (reward_title is null or length(btrim(reward_title)) between 2 and 120),
  add column claim_id uuid;
alter table taply.redemption_ledger
  add constraint redemption_ledger_claim_key unique (claim_id),
  add constraint redemption_ledger_claim_fkey
    foreign key (claim_id, merchant_id)
    references taply.reward_claims (id, merchant_id) on delete restrict;
grant insert (reward_key, reward_title, claim_id) on taply.redemption_ledger to taply_app;

-- ── Commerce : informations non contractuelles ──────────────────────
alter table taply.merchants
  add column city text check (city is null or length(btrim(city)) between 1 and 80);
grant update (name, city, updated_at) on taply.merchants to taply_app;
create policy update_tenant on taply.merchants for update to taply_app
  using (id = nullif(current_setting('app.merchant_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.merchant_id', true), '')::uuid);
alter table taply.merchants
  add constraint merchants_name_length check (length(btrim(name)) between 2 and 80) not valid;

-- ── QR personnel temporaire (carte web) ─────────────────────────────
alter table taply.wallet_qr_tokens add column expires_at timestamptz;
grant insert (expires_at) on taply.wallet_qr_tokens to taply_app;

-- ── Appareil employé : déverrouillage limité dans le temps ──────────
alter table taply.staff_devices add column unlocked_until timestamptz;
grant update (unlocked_until) on taply.staff_devices to taply_app;
