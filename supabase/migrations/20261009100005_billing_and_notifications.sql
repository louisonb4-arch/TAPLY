-- Abonnement Stripe (offre unique 20 €/mois) et notifications.
--
-- Facturation : l'état d'un commerce n'est JAMAIS déduit de la page de
-- succès Stripe. Seuls les webhooks signés (puis relecture de la
-- souscription via l'API Stripe) écrivent merchant_subscriptions.
-- stripe_events garantit qu'un événement rejoué n'est traité qu'une fois.

create table taply.merchant_subscriptions (
  merchant_id uuid primary key references taply.merchants (id) on delete restrict,
  stripe_customer_id text check (stripe_customer_id is null or stripe_customer_id ~ '^cus_[A-Za-z0-9]{1,64}$'),
  stripe_subscription_id text check (stripe_subscription_id is null or stripe_subscription_id ~ '^sub_[A-Za-z0-9]{1,64}$'),
  status text not null default 'none' check (status in (
    'none', 'incomplete', 'incomplete_expired', 'trialing', 'active',
    'past_due', 'canceled', 'unpaid', 'paused'
  )),
  price_id text check (price_id is null or price_id ~ '^price_[A-Za-z0-9]{1,64}$'),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  checkout_session_id text check (checkout_session_id is null or checkout_session_id ~ '^cs_[A-Za-z0-9_]{1,200}$'),
  checkout_expires_at timestamptz,
  stripe_state_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint merchant_subscriptions_customer_key unique (stripe_customer_id),
  constraint merchant_subscriptions_subscription_key unique (stripe_subscription_id)
);

alter table taply.merchant_subscriptions enable row level security;
alter table taply.merchant_subscriptions force row level security;

grant select on taply.merchant_subscriptions to taply_app;
grant insert (merchant_id, stripe_customer_id, checkout_session_id, checkout_expires_at)
  on taply.merchant_subscriptions to taply_app;
grant update (stripe_customer_id, stripe_subscription_id, status, price_id, current_period_end,
              cancel_at_period_end, checkout_session_id, checkout_expires_at,
              stripe_state_at, updated_at)
  on taply.merchant_subscriptions to taply_app;

create policy select_tenant on taply.merchant_subscriptions for select to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
-- Webhook : résolution du commerce par l'identifiant client Stripe exact.
create policy stripe_customer_lookup on taply.merchant_subscriptions for select to taply_app
  using (stripe_customer_id = nullif(current_setting('app.stripe_customer_lookup', true), ''));
create policy insert_tenant on taply.merchant_subscriptions for insert to taply_app
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
create policy update_tenant on taply.merchant_subscriptions for update to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid)
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

alter table taply.merchant_subscriptions owner to taply_owner;

create table taply.stripe_events (
  id text primary key check (id ~ '^evt_[A-Za-z0-9]{1,64}$'),
  type text not null check (length(type) between 3 and 80),
  stripe_created_at timestamptz not null,
  merchant_id uuid,
  outcome text not null default 'received' check (outcome in ('received', 'applied', 'ignored', 'unmatched')),
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

alter table taply.stripe_events enable row level security;
alter table taply.stripe_events force row level security;

grant select on taply.stripe_events to taply_app;
grant insert (id, type, stripe_created_at) on taply.stripe_events to taply_app;
grant update (merchant_id, outcome, processed_at) on taply.stripe_events to taply_app;

create policy event_exact on taply.stripe_events for select to taply_app
  using (id = nullif(current_setting('app.stripe_event_id', true), ''));
create policy event_exact_insert on taply.stripe_events for insert to taply_app
  with check (id = nullif(current_setting('app.stripe_event_id', true), ''));
create policy event_exact_update on taply.stripe_events for update to taply_app
  using (id = nullif(current_setting('app.stripe_event_id', true), ''))
  with check (id = nullif(current_setting('app.stripe_event_id', true), ''));

alter table taply.stripe_events owner to taply_owner;

-- ── Notifications (facultatives, jamais requises pour la carte) ─────
-- Abonnement Web Push d'une identité anonyme, sur consentement explicite.
create table taply.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null references taply.customer_identities (id) on delete restrict,
  endpoint_hash text not null check (endpoint_hash ~ '^[0-9a-f]{64}$'),
  endpoint text not null check (endpoint ~ '^https://' and length(endpoint) <= 1024),
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{80,100}$'),
  auth_secret text not null check (auth_secret ~ '^[A-Za-z0-9_-]{16,32}$'),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint push_subscriptions_endpoint_key unique (endpoint_hash)
);

alter table taply.push_subscriptions enable row level security;
alter table taply.push_subscriptions force row level security;

grant select on taply.push_subscriptions to taply_app;
grant insert (identity_id, endpoint_hash, endpoint, p256dh, auth_secret) on taply.push_subscriptions to taply_app;
grant update (revoked_at) on taply.push_subscriptions to taply_app;

create policy identity_select on taply.push_subscriptions for select to taply_app
  using (identity_id = nullif(current_setting('app.identity_id', true), '')::uuid);
create policy identity_insert on taply.push_subscriptions for insert to taply_app
  with check (identity_id = nullif(current_setting('app.identity_id', true), '')::uuid);
create policy identity_update on taply.push_subscriptions for update to taply_app
  using (identity_id = nullif(current_setting('app.identity_id', true), '')::uuid)
  with check (identity_id = nullif(current_setting('app.identity_id', true), '')::uuid);

alter table taply.push_subscriptions owner to taply_owner;

-- File d'événements métier à notifier. dedupe_key unique : un même
-- événement (carte, cycle, type) n'est jamais mis en file deux fois.
create table taply.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null,
  membership_id uuid not null,
  kind text not null check (kind in ('reward_unlocked', 'reward_handed_over', 'visit_credited')),
  dedupe_key text not null check (length(dedupe_key) between 8 and 200),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 20),
  constraint notification_outbox_dedupe_key unique (dedupe_key),
  constraint notification_outbox_membership_fkey foreign key (membership_id, merchant_id)
    references taply.memberships (id, merchant_id) on delete restrict
);

create index notification_outbox_pending_idx on taply.notification_outbox (merchant_id, created_at)
  where sent_at is null;

alter table taply.notification_outbox enable row level security;
alter table taply.notification_outbox force row level security;

grant select on taply.notification_outbox to taply_app;
grant insert (merchant_id, membership_id, kind, dedupe_key) on taply.notification_outbox to taply_app;
grant update (sent_at, attempts) on taply.notification_outbox to taply_app;

create policy select_tenant on taply.notification_outbox for select to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
create policy insert_tenant on taply.notification_outbox for insert to taply_app
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
create policy update_tenant on taply.notification_outbox for update to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid)
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

alter table taply.notification_outbox owner to taply_owner;
