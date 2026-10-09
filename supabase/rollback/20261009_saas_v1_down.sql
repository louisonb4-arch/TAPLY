-- RETOUR ARRIÈRE D'URGENCE — migrations 20261009100002 → 20261009100005.
--
-- NE PAS EXÉCUTER sans décision explicite : DESTRUCTIF (supprime cartes
-- anonymes, puces NFC, abonnements suivis, file de notifications créés
-- après la mise en service). Sauvegarde préalable obligatoire.
-- La migration 20261009100001 (réconciliation program_publications) est
-- conservée : elle remet staging en conformité avec le dépôt.
--
-- Exécution (après sauvegarde) : supabase db query --linked -f supabase/rollback/20261009_saas_v1_down.sql
begin;

-- 100005 : facturation et notifications
drop table if exists taply.notification_outbox;
drop table if exists taply.push_subscriptions;
drop table if exists taply.stripe_events;
drop table if exists taply.merchant_subscriptions;

-- 100004 : NFC
alter table taply.program_preferences
  drop column if exists nfc_auto_enabled,
  drop column if exists notify_reward_unlocked,
  drop column if exists notify_visit_credited;
drop index if exists taply.visit_ledger_merchant_time_idx;
drop index if exists taply.visit_ledger_nfc_tag_idx;
alter table taply.visit_ledger drop constraint if exists visit_ledger_actor_required;
alter table taply.visit_ledger drop constraint if exists visit_ledger_nfc_tag_fkey;
delete from taply.visit_ledger where source = 'NFC';
alter table taply.visit_ledger drop column if exists nfc_tag_id;
alter table taply.visit_ledger
  add constraint visit_ledger_employee_required check (performed_by is not null) not valid;
drop table if exists taply.nfc_tap_events;
drop table if exists taply.nfc_pairings;
drop table if exists taply.nfc_tags;

-- 100003 : identités anonymes
drop table if exists taply.public_rate_buckets;
drop table if exists taply.identity_memberships;
drop table if exists taply.identity_sessions;
drop table if exists taply.customer_identities;

-- 100002 : contrat, récompenses, commerce
alter table taply.staff_devices drop column if exists unlocked_until;
alter table taply.wallet_qr_tokens drop column if exists expires_at;
alter table taply.merchants drop constraint if exists merchants_name_length;
drop policy if exists update_tenant on taply.merchants;
revoke update (name, city, updated_at) on taply.merchants from taply_app;
alter table taply.merchants drop column if exists city;
alter table taply.redemption_ledger drop constraint if exists redemption_ledger_claim_fkey;
alter table taply.redemption_ledger drop constraint if exists redemption_ledger_claim_key;
alter table taply.redemption_ledger
  drop column if exists claim_id,
  drop column if exists reward_title,
  drop column if exists reward_key;
drop table if exists taply.reward_claims;
drop trigger if exists guard_rule_version_contract_v1 on taply.program_rule_versions;
drop function if exists taply.guard_rule_version_contract_v1();
alter table taply.program_publications drop column if exists contract_changed_at;
alter table taply.program_rule_versions
  drop column if exists change_reason,
  drop column if exists created_by;

delete from supabase_migrations.schema_migrations
 where version in ('20261009100002', '20261009100003', '20261009100004', '20261009100005');

commit;
