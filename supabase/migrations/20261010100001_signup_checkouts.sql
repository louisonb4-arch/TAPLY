-- Parcours « paiement d'abord » : un visiteur paie l'abonnement Stripe
-- AVANT d'avoir un compte. Le paiement attend ici d'être rattaché.
--
-- Rattachement : uniquement au premier login (ou suivant) d'un compte dont
-- l'e-mail est CONFIRMÉ par Supabase et identique à l'e-mail du paiement,
-- relu auprès de Stripe. L'e-mail n'est jamais stocké en clair : seule son
-- empreinte SHA-256 (domaine séparé) sert à retrouver le paiement.
--
-- Accès (rôle taply_app, RLS forcée) par l'identifiant exact de la session
-- Checkout (webhook signé, page de retour) ou par l'empreinte exacte de
-- l'e-mail confirmé (login). Aucune énumération possible.

create table taply.signup_checkouts (
  checkout_session_id text primary key check (checkout_session_id ~ '^cs_[A-Za-z0-9_]{1,200}$'),
  email_hash text not null check (email_hash ~ '^[0-9a-f]{64}$'),
  stripe_customer_id text not null check (stripe_customer_id ~ '^cus_[A-Za-z0-9]{1,64}$'),
  stripe_subscription_id text not null check (stripe_subscription_id ~ '^sub_[A-Za-z0-9]{1,64}$'),
  status text not null default 'paid' check (status in ('paid', 'claimed', 'duplicate')),
  merchant_id uuid references taply.merchants (id) on delete restrict,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  constraint signup_checkouts_subscription_key unique (stripe_subscription_id),
  constraint signup_checkouts_claim_consistent check (
    (status = 'paid' and merchant_id is null and claimed_at is null)
    or (status in ('claimed', 'duplicate') and merchant_id is not null and claimed_at is not null)
  )
);

create index signup_checkouts_email_idx on taply.signup_checkouts (email_hash) where status = 'paid';

alter table taply.signup_checkouts enable row level security;
alter table taply.signup_checkouts force row level security;

grant select on taply.signup_checkouts to taply_app;
grant insert (checkout_session_id, email_hash, stripe_customer_id, stripe_subscription_id)
  on taply.signup_checkouts to taply_app;
grant update (status, merchant_id, claimed_at) on taply.signup_checkouts to taply_app;

create policy session_select on taply.signup_checkouts for select to taply_app
  using (checkout_session_id = nullif(current_setting('app.checkout_session_id', true), ''));
create policy session_insert on taply.signup_checkouts for insert to taply_app
  with check (checkout_session_id = nullif(current_setting('app.checkout_session_id', true), '')
              and status = 'paid' and merchant_id is null);
create policy email_select on taply.signup_checkouts for select to taply_app
  using (email_hash = nullif(current_setting('app.checkout_email_hash', true), ''));
-- Rattachement : même empreinte d'e-mail ET commerce de la session en cours.
create policy email_claim on taply.signup_checkouts for update to taply_app
  using (email_hash = nullif(current_setting('app.checkout_email_hash', true), '') and status = 'paid')
  with check (email_hash = nullif(current_setting('app.checkout_email_hash', true), '')
              and merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

alter table taply.signup_checkouts owner to taply_owner;
