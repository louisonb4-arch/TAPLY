/**
 * Abonnement Taply (offre unique) : Checkout, portail, synchronisation.
 *
 * Invariants :
 *   - un commerce = au plus un client Stripe et un abonnement suivi ;
 *   - aucun abonnement créé si un abonnement actif/en essai/en retard existe ;
 *   - double clic / rechargement : session Checkout ouverte réutilisée +
 *     clé d'idempotence Stripe par fenêtre de 10 minutes ;
 *   - l'accès n'est accordé qu'à partir d'un état RELU depuis l'API Stripe
 *     (webhook signé, ou retour Checkout vérifié côté serveur) ;
 *   - un événement Stripe rejoué n'est appliqué qu'une fois (stripe_events) ;
 *   - un événement ne peut pas rattacher un client Stripe différent de celui
 *     déjà associé au commerce.
 */
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { withTx } from '../db/tenant-context.js';
import type { Logger } from '../core/logger.js';
import { isSubscriptionStatus, type SubscriptionStatus } from './access.js';
import type { StripeApi, StripeSubscription } from './stripe.js';

const merchantUuid = z.uuid();
const OPERATING: readonly SubscriptionStatus[] = ['active', 'trialing', 'past_due'];

interface SubRow {
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  status: string;
  checkout_session_id: string | null;
  checkout_open: boolean;
}

async function readSub(client: PoolClient, merchantId: string): Promise<SubRow | undefined> {
  const result = await client.query<SubRow>(
    `select stripe_customer_id, stripe_subscription_id, status, checkout_session_id,
            coalesce(checkout_expires_at > now() + interval '5 minutes', false) as checkout_open
       from taply.merchant_subscriptions where merchant_id = $1 for update`,
    [merchantId],
  );
  return result.rows[0];
}

export type CheckoutResult =
  | { readonly status: 'redirect'; readonly url: string }
  | { readonly status: 'already_active' };

export async function startCheckout(
  pool: Pool, stripe: StripeApi, input: { merchantId: string; priceId: string; origin: string },
  run: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>,
): Promise<CheckoutResult> {
  const before = await run(async (client) => readSub(client, input.merchantId));
  if (before && isSubscriptionStatus(before.status) && OPERATING.includes(before.status)) {
    return { status: 'already_active' };
  }
  if (before?.checkout_open && before.checkout_session_id) {
    const open = await stripe.retrieveCheckoutSession(before.checkout_session_id);
    if (open.status === 'open' && open.url) return { status: 'redirect', url: open.url };
  }
  const bucket = Math.floor(Date.now() / 600_000);
  const params: Record<string, string> = {
    mode: 'subscription',
    'line_items[0][price]': input.priceId,
    'line_items[0][quantity]': '1',
    client_reference_id: input.merchantId,
    'metadata[merchant_id]': input.merchantId,
    'subscription_data[metadata][merchant_id]': input.merchantId,
    success_url: `${input.origin}/dashboard/?checkout=success&session_id={CHECKOUT_SESSION_ID}#/abonnement`,
    cancel_url: `${input.origin}/dashboard/?checkout=cancel#/abonnement`,
    locale: 'fr',
    allow_promotion_codes: 'true',
    billing_address_collection: 'required',
    'tax_id_collection[enabled]': 'true',
  };
  if (before?.stripe_customer_id) params['customer'] = before.stripe_customer_id;
  const session = await stripe.createCheckoutSession(params, `taply-checkout-${input.merchantId}-${bucket}`);
  if (!session.url) throw new Error('Stripe checkout session without URL');
  await run(async (client) => {
    await client.query(
      `insert into taply.merchant_subscriptions (merchant_id, checkout_session_id, checkout_expires_at)
       values ($1, $2, to_timestamp($3))
       on conflict (merchant_id) do update set
         checkout_session_id = excluded.checkout_session_id,
         checkout_expires_at = excluded.checkout_expires_at, updated_at = now()`,
      [input.merchantId, session.id, session.expiresAt ?? Math.floor(Date.now() / 1000) + 3600],
    );
  });
  return { status: 'redirect', url: session.url };
}

/** Applique l'état relu d'un abonnement au commerce (transaction tenant fournie). */
export async function applySubscription(
  client: PoolClient, merchantId: string, sub: StripeSubscription,
  options: { readonly replaceInactiveCustomer?: boolean } = {},
): Promise<'applied' | 'customer_mismatch' | 'duplicate_subscription' | 'invalid'> {
  if (!isSubscriptionStatus(sub.status) || !/^sub_/.test(sub.id) || !/^cus_/.test(sub.customer)) return 'invalid';
  const current = await readSub(client, merchantId);
  const currentOperating = current !== undefined && isSubscriptionStatus(current.status) && OPERATING.includes(current.status);
  // Parcours « paiement d'abord » : un nouveau client Stripe peut remplacer
  // celui d'un abonnement terminé, jamais celui d'un abonnement en vigueur.
  if (current?.stripe_customer_id && current.stripe_customer_id !== sub.customer
      && !(options.replaceInactiveCustomer === true && !currentOperating)) return 'customer_mismatch';
  if (current?.stripe_subscription_id && current.stripe_subscription_id !== sub.id
      && isSubscriptionStatus(current.status) && OPERATING.includes(current.status)
      && sub.status !== 'canceled' && sub.status !== 'incomplete_expired') {
    // Un second abonnement ne remplace jamais un abonnement en vigueur.
    return 'duplicate_subscription';
  }
  if (current?.stripe_subscription_id && current.stripe_subscription_id !== sub.id
      && (sub.status === 'canceled' || sub.status === 'incomplete_expired')) {
    // Fin d'un autre abonnement (doublon résilié) : sans effet sur l'abonnement suivi.
    return 'applied';
  }
  await client.query(
    `insert into taply.merchant_subscriptions (merchant_id, stripe_customer_id)
     values ($1, $2) on conflict (merchant_id) do nothing`,
    [merchantId, sub.customer],
  );
  await client.query(
    `update taply.merchant_subscriptions set
       stripe_customer_id = $2, stripe_subscription_id = $3, status = $4, price_id = $5,
       current_period_end = case when $6::bigint is null then null else to_timestamp($6::bigint) end,
       cancel_at_period_end = $7, stripe_state_at = now(), updated_at = now(),
       checkout_session_id = case when $4 in ('active', 'trialing') then null else checkout_session_id end,
       checkout_expires_at = case when $4 in ('active', 'trialing') then null else checkout_expires_at end
     where merchant_id = $1`,
    [merchantId, sub.customer, sub.id, sub.status, sub.priceId && /^price_/.test(sub.priceId) ? sub.priceId : null,
      sub.currentPeriodEnd, sub.cancelAtPeriodEnd],
  );
  return 'applied';
}

/** Retour de Checkout : vérifié auprès de Stripe, jamais cru sur parole. */
export async function syncCheckoutSession(
  stripe: StripeApi, merchantId: string, sessionId: string,
  run: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>,
): Promise<'applied' | 'pending' | 'mismatch'> {
  const session = await stripe.retrieveCheckoutSession(sessionId);
  if (session.clientReferenceId !== merchantId) return 'mismatch';
  if (session.status !== 'complete' || !session.subscription) return 'pending';
  const sub = await stripe.retrieveSubscription(session.subscription);
  const outcome = await run((client) => applySubscription(client, merchantId, sub));
  return outcome === 'applied' ? 'applied' : 'mismatch';
}

interface StripeEvent {
  id: string;
  type: string;
  created: number;
  object: Record<string, unknown>;
}

export function parseStripeEvent(rawBody: string): StripeEvent | undefined {
  let data: unknown;
  try { data = JSON.parse(rawBody); } catch { return undefined; }
  const parsed = z.object({
    id: z.string().regex(/^evt_[A-Za-z0-9]{1,64}$/),
    type: z.string().min(3).max(80),
    created: z.number().int().positive(),
    data: z.object({ object: z.record(z.string(), z.unknown()) }),
  }).safeParse(data);
  if (!parsed.success) return undefined;
  return { id: parsed.data.id, type: parsed.data.type, created: parsed.data.created, object: parsed.data.data.object };
}

const HANDLED = new Set([
  'checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'customer.subscription.paused', 'customer.subscription.resumed',
  'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.payment_succeeded',
]);

function refs(event: StripeEvent): { subscriptionId: string | null; customerId: string | null; merchantHint: string | null } {
  const o = event.object;
  const id = (v: unknown) => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' ? (v as { id: string }).id : null);
  const meta = (o['metadata'] && typeof o['metadata'] === 'object' ? o['metadata'] : {}) as Record<string, unknown>;
  if (event.type.startsWith('checkout.session.')) {
    return { subscriptionId: id(o['subscription']), customerId: id(o['customer']),
      merchantHint: typeof o['client_reference_id'] === 'string' ? o['client_reference_id'] : null };
  }
  if (event.type.startsWith('customer.subscription.')) {
    return { subscriptionId: id(o['id']), customerId: id(o['customer']),
      merchantHint: typeof meta['merchant_id'] === 'string' ? meta['merchant_id'] : null };
  }
  const parent = o['parent'] as { subscription_details?: { subscription?: unknown } } | undefined;
  return { subscriptionId: id(o['subscription']) ?? id(parent?.subscription_details?.subscription),
    customerId: id(o['customer']), merchantHint: null };
}

export type WebhookOutcome = 'applied' | 'duplicate' | 'ignored' | 'unmatched';

export async function processStripeEvent(
  pool: Pool, stripe: StripeApi, event: StripeEvent, log: Logger,
): Promise<WebhookOutcome> {
  const seen = await withTx(pool, async (client) => {
    await client.query('select set_config($1, $2, true)', ['app.stripe_event_id', event.id]);
    const r = await client.query<{ processed_at: Date | null }>('select processed_at from taply.stripe_events where id = $1', [event.id]);
    return r.rows[0]?.processed_at != null;
  });
  if (seen) return 'duplicate';

  const ref = refs(event);
  const relevant = HANDLED.has(event.type) && ref.subscriptionId !== null;
  // Source de vérité : l'abonnement relu, pas le contenu de l'événement.
  const sub = relevant && ref.subscriptionId ? await stripe.retrieveSubscription(ref.subscriptionId) : undefined;

  return withTx(pool, async (client) => {
    await client.query('select set_config($1, $2, true)', ['app.stripe_event_id', event.id]);
    const inserted = await client.query(
      `insert into taply.stripe_events (id, type, stripe_created_at) values ($1, $2, to_timestamp($3))
       on conflict (id) do nothing`,
      [event.id, event.type, event.created],
    );
    if (inserted.rowCount === 0) {
      const done = await client.query<{ processed_at: Date | null }>('select processed_at from taply.stripe_events where id = $1 for update', [event.id]);
      if (done.rows[0]?.processed_at != null) return 'duplicate' as const;
    }
    const finish = async (outcome: 'applied' | 'ignored' | 'unmatched', merchantId: string | null) => {
      await client.query(
        `update taply.stripe_events set outcome = $2, merchant_id = $3, processed_at = now() where id = $1`,
        [event.id, outcome, merchantId],
      );
      return outcome;
    };
    if (!sub) return finish('ignored', null);

    // Commerce : métadonnée posée à la création du Checkout (relue sur
    // l'abonnement), sinon client Stripe déjà associé.
    let merchantId: string | null = null;
    const hint = sub.metadata['merchant_id'] ?? ref.merchantHint;
    if (hint && merchantUuid.safeParse(hint).success) merchantId = hint;
    if (merchantId === null && sub.customer) {
      await client.query('select set_config($1, $2, true)', ['app.stripe_customer_lookup', sub.customer]);
      const r = await client.query<{ merchant_id: string }>(
        'select merchant_id from taply.merchant_subscriptions where stripe_customer_id = $1', [sub.customer]);
      merchantId = r.rows[0]?.merchant_id ?? null;
    }
    if (merchantId === null) {
      log.warn('billing.webhook.unmatched', { eventId: event.id, type: event.type });
      return finish('unmatched', null);
    }
    await client.query('select set_config($1, $2, true)', ['app.merchant_id', merchantId]);
    const exists = await client.query('select 1 from taply.merchants where id = $1', [merchantId]);
    if (exists.rowCount !== 1) return finish('unmatched', null);
    const applied = await applySubscription(client, merchantId, sub);
    if (applied !== 'applied') {
      log.warn('billing.webhook.rejected', { eventId: event.id, merchantId, reason: applied });
      return finish('ignored', merchantId);
    }
    log.info('billing.subscription.updated', { merchantId, status: sub.status, eventType: event.type });
    return finish('applied', merchantId);
  });
}
