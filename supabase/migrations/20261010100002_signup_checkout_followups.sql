-- Suivi des paiements « sans compte » (tâche planifiée quotidienne) :
--   - rappel e-mail au payeur 48 h après le paiement si l'espace n'est pas
--     créé (reminder_sent_at) ;
--   - dossier signalé à 14 jours pour annulation et remboursement manuels
--     (flagged_at) ;
--   - dossier clos (status 'canceled') si l'abonnement Stripe est déjà
--     terminé (remboursé/annulé depuis Stripe) : plus aucun rappel.
--
-- La tâche n'agit que dans le contexte app.signup_job = 'followup-v1', posé
-- par le serveur uniquement pour la route protégée par CRON_SECRET, et ne
-- voit que les paiements non rattachés.

alter table taply.signup_checkouts
  add column reminder_sent_at timestamptz,
  add column flagged_at timestamptz;

alter table taply.signup_checkouts drop constraint signup_checkouts_status_check;
alter table taply.signup_checkouts add constraint signup_checkouts_status_check
  check (status in ('paid', 'claimed', 'duplicate', 'canceled'));

alter table taply.signup_checkouts drop constraint signup_checkouts_claim_consistent;
alter table taply.signup_checkouts add constraint signup_checkouts_claim_consistent check (
  (status in ('paid', 'canceled') and merchant_id is null and claimed_at is null)
  or (status in ('claimed', 'duplicate') and merchant_id is not null and claimed_at is not null)
);

grant update (reminder_sent_at, flagged_at) on taply.signup_checkouts to taply_app;

-- 'canceled' visible aussi : PostgreSQL vérifie la ligne mise à jour contre
-- les politiques SELECT (un dossier clos ne doit pas « disparaître »).
create policy followup_select on taply.signup_checkouts for select to taply_app
  using (current_setting('app.signup_job', true) = 'followup-v1' and status in ('paid', 'canceled'));
create policy followup_update on taply.signup_checkouts for update to taply_app
  using (current_setting('app.signup_job', true) = 'followup-v1' and status = 'paid')
  with check (current_setting('app.signup_job', true) = 'followup-v1'
              and status in ('paid', 'canceled') and merchant_id is null);

create index signup_checkouts_followup_idx on taply.signup_checkouts (created_at) where status = 'paid';
