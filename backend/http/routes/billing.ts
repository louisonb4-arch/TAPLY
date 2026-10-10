/**
 * Abonnement : état, Checkout, retour vérifié, portail de facturation,
 * webhook Stripe signé. Le webhook n'utilise ni cookie ni Origin : sa seule
 * authentification est la signature Stripe sur le corps brut.
 */
import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { AppError } from '../../core/errors.js';
import { merchantAccess } from '../../billing/access.js';
import { httpStripeApi, stripeConfig, stripeConfigProblems, verifyStripeSignature, type StripeApi } from '../../billing/stripe.js';
import { parseStripeEvent, processStripeEvent, startCheckout, syncCheckoutSession } from '../../billing/service.js';
import {
  claimSignupCheckouts, recordSignupCheckout, signupCheckoutParams, SIGNUP_FLOW,
} from '../../billing/signup-checkout.js';
import { withTx } from '../../db/tenant-context.js';
import { clientIp, consumeRateLimit, hashClientIp } from '../../security/rate-limit.js';
import type { AuthenticatedPrincipal } from '../../auth/session.js';
import { originCheck } from '../origin.js';
import { dbPool, loyaltyEnabled } from '../gates.js';
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

// ── Parcours « paiement d'abord » (visiteur sans compte) ─────────────
const SIGNUP_START_PER_IP_HOUR = 10;
const SIGNUP_START_GLOBAL_HOUR = 500;
const SIGNUP_LOOKUP_PER_IP_HOUR = 60;

async function publicRateLimit(c: C, scope: string, perIp: number, global?: number): Promise<void> {
  const ipHash = hashClientIp(clientIp((name) => c.req.header(name)));
  const allowed = await withTx(dbPool(c), async (client) => {
    if (!(await consumeRateLimit(client, `${scope}:ip:${ipHash}`, perIp, 3600))) return false;
    return global === undefined || consumeRateLimit(client, `${scope}:global`, global, 3600);
  });
  if (!allowed) throw new AppError('RATE_LIMITED');
}

/** Démarre un abonnement sans compte : redirection directe vers Stripe. */
billingRoutes.post('/billing/start', originCheck, async (c) => {
  const cfg = c.get('config');
  if (!loyaltyEnabled(cfg.appEnv)) throw new AppError('SERVICE_UNAVAILABLE');
  const s = stripe();
  if (!s || !cfg.auth.appOrigin) {
    throw new AppError('SERVICE_UNAVAILABLE', { userMessage: 'Le paiement en ligne n’est pas encore disponible.' });
  }
  await publicRateLimit(c, 'billing-start', SIGNUP_START_PER_IP_HOUR, SIGNUP_START_GLOBAL_HOUR);
  const session = await s.api.createCheckoutSession(
    signupCheckoutParams({ priceId: s.priceId, origin: cfg.auth.appOrigin }), `taply-signup-${randomUUID()}`);
  if (!session.url) throw new AppError('SERVICE_UNAVAILABLE');
  return c.json({ redirect: session.url });
});

/**
 * Retour de Stripe : le paiement est relu chez Stripe puis mémorisé. L'e-mail
 * renvoyé sert seulement à pré-remplir le formulaire : le rattachement
 * exigera de toute façon que ce même e-mail soit confirmé.
 */
billingRoutes.get('/billing/start/:sessionId', async (c) => {
  const s = stripe();
  if (!s) throw new AppError('SERVICE_UNAVAILABLE');
  const sessionId = c.req.param('sessionId');
  if (!/^cs_[A-Za-z0-9_]{1,200}$/.test(sessionId)) throw new AppError('NOT_FOUND');
  await publicRateLimit(c, 'billing-start-lookup', SIGNUP_LOOKUP_PER_IP_HOUR);
  let outcome;
  try {
    outcome = await recordSignupCheckout(dbPool(c), s.api, sessionId, c.get('log'));
  } catch {
    throw new AppError('NOT_FOUND');
  }
  if (outcome.status === 'invalid') throw new AppError('NOT_FOUND');
  return c.json(outcome.status === 'paid' ? { paid: true, email: outcome.email } : { paid: false });
});

/**
 * Appelé après un login réussi : rattache les paiements « sans compte » dont
 * l'e-mail est celui, confirmé, du propriétaire. N'échoue jamais le login.
 */
export async function claimPaidSignupOnLogin(
  c: C, input: { merchantId: string; role: string; confirmedEmail: string | null },
): Promise<void> {
  const s = stripe();
  if (!s || input.role !== 'owner' || !input.confirmedEmail) return;
  try {
    await claimSignupCheckouts(dbPool(c), s.api, { merchantId: input.merchantId, confirmedEmail: input.confirmedEmail },
      c.get('log'));
  } catch (error) {
    c.get('log').warn('billing.signup_checkout.claim_failed', {
      merchantId: input.merchantId, error: error instanceof Error ? error.name : 'unknown' });
  }
}

billingRoutes.post('/billing/webhook', async (c) => {
  const s = stripe();
  if (!s) {
    c.get('log').warn('billing.stripe.not_configured', { problems: stripeConfigProblems() });
    throw new AppError('SERVICE_UNAVAILABLE');
  }
  const rawBody = await c.req.text();
  if (!verifyStripeSignature(rawBody, c.req.header('stripe-signature'), s.webhookSecret)) {
    c.get('log').warn('billing.webhook.bad_signature', {});
    throw new AppError('AUTH_INVALID');
  }
  const event = parseStripeEvent(rawBody);
  if (!event) throw new AppError('VALIDATION_FAILED');
  if (event.type === 'checkout.session.completed') {
    const meta = event.object['metadata'] as Record<string, unknown> | null | undefined;
    const sessionId = event.object['id'];
    if (meta?.['taply_flow'] === SIGNUP_FLOW && typeof sessionId === 'string' && /^cs_[A-Za-z0-9_]{1,200}$/.test(sessionId)) {
      // Paiement sans compte : mémorisé (idempotent) en attente de rattachement.
      await recordSignupCheckout(dbPool(c), s.api, sessionId, c.get('log'));
    }
  }
  const outcome = await processStripeEvent(dbPool(c), s.api, event, c.get('log'));
  return c.json({ received: true, outcome });
});
