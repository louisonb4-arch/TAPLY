-- Traçabilité anti-fraude : chaque NOUVEAU passage et chaque remise
-- enregistrent l'identifiant de l'employé authentifié (ou propriétaire).
-- Les lignes anciennes éventuelles ne sont jamais modifiées, d'où NOT VALID.
-- PostgreSQL applique les contraintes NOT VALID sur TOUS les nouveaux INSERT.
alter table taply.visit_ledger add column performed_by uuid;
alter table taply.redemption_ledger add column performed_by uuid;

alter table taply.visit_ledger
  add constraint visit_ledger_employee_required
  check (performed_by is not null) not valid;
alter table taply.redemption_ledger
  add constraint redemption_ledger_employee_required
  check (performed_by is not null) not valid;

alter table taply.visit_ledger
  add constraint visit_ledger_employee_merchant_fkey
  foreign key (performed_by, merchant_id)
  references taply.merchant_users(id,merchant_id) on delete restrict not valid;
alter table taply.redemption_ledger
  add constraint redemption_ledger_employee_merchant_fkey
  foreign key (performed_by, merchant_id)
  references taply.merchant_users(id,merchant_id) on delete restrict not valid;

grant insert(performed_by) on taply.visit_ledger to taply_app;
grant insert(performed_by) on taply.redemption_ledger to taply_app;

create index visit_ledger_employee_idx on taply.visit_ledger(merchant_id,performed_by,credited_at);
create index redemption_ledger_employee_idx on taply.redemption_ledger(merchant_id,performed_by,redeemed_at);
