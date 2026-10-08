-- Phase 4 : changement de version de règle lors du rollover APRÈS
-- remise manuelle du cadeau. Aucune modification des migrations gelées.
-- La FK composite (current_rule_version_id, program_id, merchant_id)
-- dans memberships empêche un rollover vers une autre boutique/programme.
-- La règle active et le cycle sont lus et mis à jour par LoyaltyService
-- dans une seule transaction avec verrouillage, contrôle employé et idempotence.
grant update (current_rule_version_id, updated_at)
  on taply.memberships to taply_app;

create policy update_tenant on taply.memberships
  for update to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid)
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
