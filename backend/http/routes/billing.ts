/**
 * Abonnement : état, Checkout, retour vérifié, portail de facturation,
 * webhook Stripe signé. Le webhook n'utilise ni cookie ni Origin : sa seule
 * authentification est la signature Stripe sur le corps brut.
 */
import { Hono, type Context } from 'hono';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { AppError } from '../../core/errors.js';
import { merchantAccess } from '../../billing/access.js';
import { httpStripeApi, stripeConfig, verifyStripeSignature, type StripeApi } from '../../billing/stripe.js';
import { parseStripeEvent, processStripeEvent, startCheckout, syncCheckoutSession } from '../../billing/service.js';
import type { AuthenticatedPrincipal } from '../../auth/session.js';
import { originCheck } from '../origin.js';
import { dbPool } from '../gates.js';
import { asMerchant } from './merchant.js';
import type { AppEnvBindings } from '../types.js';

export const billingRoutes = new Hono<AppEnvBindings>();

type C = Context<AppEnvBindings>;

let apiOverride: StripeApi | undefined;
/** Tests uniquement : remplace le client HTTP Stripe. */
export function setStripeApiForTests(api: StripeApi | undefined): void {
  apiOverride = api;
}

function stripe(): { api: StripeApi; priceId: string; webhookSecret: string } | undefined {
  const config = stripeConfig();
  if (!config) return undefined;
  return { api: apiOverride ?? httpStripeApi(config), priceId: config.priceId, webhookSecret: config.webhookSecret };
}

/** Exécute fn dans une nouvelle transaction authentifiée du même commerce. */
function runner(c: C, principal: AuthenticatedPrincipal) {
  return <T>(fn: (client: PoolClient) => Promise<T>) => asMerchant(c, async (client, p) => {
    if (p.merchantId !== principal.merchantId) throw new AppError('AUTH_FORBIDDEN');
    return fn(client);
  });
}

billingRoutes.get('/billing/status', async (c) => {
  const access = await asMerchant(c, (client, principal) => merchantAccess(client, principal.merchantId));
  return c.json({ ...access, stripeConfigured: stripeConfig() !== undefined, priceLabel: '20 € / mois' });
});

billingRoutes.post('/billing/checkout', originCheck, async (c) => {
  const s = stripe();
  if (!s) throw new AppError('SERVICE_UNAVAILABLE', { userMessage: 'Le paiement en ligne n’est pas encore configuré.' });
  const origin = c.get('config').auth.appOrigin;
  if (!origin) throw new AppError('SERVICE_UNAVAILABLE');
  const principal = await asMerchant(c, async (_client, p) => p);
  if (principal.role !== 'owner') throw new AppError('AUTH_FORBIDDEN');
  const result = await startCheckout(dbPool(c), s.api, { merchantId: principal.merchantId, priceId: s.priceId, origin },
    runner(c, principal));
  if (result.status === 'already_active') return c.json({ redirect: null, reason: 'already_active' }, 409);
  return c.json({ redirect: result.url });
});

billingRoutes.post('/billing/sync', originCheck, async (c) => {
  const s = stripe();
  if (!s) throw new AppError('SERVICE_UNAVAILABLE');
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw new AppError('VALIDATION_FAILED'); }
  const body = z.strictObject({ sessionId: z.string().regex(/^cs_[A-Za-z0-9_]{1,200}$/) }).safeParse(raw);
  if (!body.success) throw new AppError('VALIDATION_FAILED');
  const principal = await asMerchant(c, async (_client, p) => p);
  const outcome = await syncCheckoutSession(s.api, principal.merchantId, body.data.sessionId, runner(c, principal));
  if (outcome === 'mismatch') throw new AppError('AUTH_FORBIDDEN');
  return c.json({ synced: outcome === 'applied', pending: outcome === 'pending' });
});

billingRoutes.post('/billing/portal', originCheck, async (c) => {
  const s = stripe();
  if (!s) throw new AppError('SERVICE_UNAVAILABLE');
  const origin = c.get('config').auth.appOrigin;
  if (!origin) throw new AppError('SERVICE_UNAVAILABLE');
  const customer = await asMerchant(c, async (client, principal) => {
    if (principal.role !== 'owner') throw new AppError('AUTH_FORBIDDEN');
    const r = await client.query<{ stripe_customer_id: string | null }>(
      'select stripe_customer_id from taply.merchant_subscriptions where merchant_id = $1', [principal.merchantId]);
    return r.rows[0]?.stripe_customer_id ?? null;
  });
  if (!customer) return c.json({ redirect: null, reason: 'no_customer' }, 409);
  const portal = await s.api.createPortalSession(customer, `${origin}/dashboard/#/abonnement`);
  return c.json({ redirect: portal.url });
});

billingRoutes.post('/billing/webhook', async (c) => {
  const s = stripe();
  if (!s) throw new AppError('SERVICE_UNAVAILABLE');
  const rawBody = await c.req.text();
  if (!verifyStripeSignature(rawBody, c.req.header('stripe-signature'), s.webhookSecret)) {
    c.get('log').warn('billing.webhook.bad_signature', {});
    throw new AppError('AUTH_INVALID');
  }
  const event = parseStripeEvent(rawBody);
  if (!event) throw new AppError('VALIDATION_FAILED');
  const outcome = await processStripeEvent(dbPool(c), s.api, event, c.get('log'));
  return c.json({ received: true, outcome });
});
