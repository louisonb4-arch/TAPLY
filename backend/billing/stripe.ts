/**
 * Client Stripe minimal (fetch, form-encoded) + vérification des webhooks.
 *
 * - Clé secrète uniquement côté serveur (STRIPE_SECRET_KEY), jamais
 *   journalisée ni renvoyée.
 * - Webhook : signature HMAC-SHA256 « t.payload » (en-tête Stripe-Signature),
 *   comparaison à temps constant, tolérance 5 minutes contre le rejeu.
 * - L'état d'un abonnement est toujours RELU via l'API (source de vérité),
 *   jamais déduit du contenu d'un événement ni d'une page de retour.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface StripeConfig {
  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly priceId: string;
}

export function stripeConfig(env: Readonly<Record<string, string | undefined>> = process.env): StripeConfig | undefined {
  const secretKey = env['STRIPE_SECRET_KEY'];
  const webhookSecret = env['STRIPE_WEBHOOK_SECRET'];
  const priceId = env['STRIPE_PRICE_ID'];
  if (!secretKey || !/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(secretKey)) return undefined;
  if (!webhookSecret || !/^whsec_[A-Za-z0-9+/=]+$/.test(webhookSecret)) return undefined;
  if (!priceId || !/^price_[A-Za-z0-9]+$/.test(priceId)) return undefined;
  return { secretKey, webhookSecret, priceId };
}

export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** Vérifie l'en-tête Stripe-Signature sur le corps BRUT. */
export function verifyStripeSignature(
  rawBody: string, header: string | undefined, secret: string, nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!header || header.length > 2000) return false;
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2);
    if (key === 't' && value && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    if (key === 'v1' && value && /^[0-9a-f]{64}$/.test(value)) signatures.push(value);
  }
  if (timestamp === undefined || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest();
  return signatures.some((sig) => {
    const candidate = Buffer.from(sig, 'hex');
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
}

/** Signature de test (même algorithme), pour les tests et l'outillage local. */
export function signStripePayload(rawBody: string, secret: string, timestamp: number): string {
  const sig = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

export interface StripeSubscription {
  readonly id: string;
  readonly customer: string;
  readonly status: string;
  readonly metadata: Record<string, string>;
  readonly priceId: string | null;
  readonly currentPeriodEnd: number | null;
  readonly cancelAtPeriodEnd: boolean;
}

export interface StripeCheckoutSession {
  readonly id: string;
  readonly url: string | null;
  readonly status: string | null;
  readonly clientReferenceId: string | null;
  readonly customer: string | null;
  readonly subscription: string | null;
  readonly expiresAt: number | null;
}

/** Interface injectable (tests : faux client ; prod : HTTP). */
export interface StripeApi {
  createCheckoutSession(params: Record<string, string>, idempotencyKey: string): Promise<StripeCheckoutSession>;
  retrieveCheckoutSession(id: string): Promise<StripeCheckoutSession>;
  retrieveSubscription(id: string): Promise<StripeSubscription>;
  createPortalSession(customer: string, returnUrl: string): Promise<{ url: string }>;
}

export class StripeApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Stripe API error ${status}`);
    this.name = 'StripeApiError';
    this.status = status;
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function idOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id;
  }
  return null;
}

export function toSubscription(raw: Record<string, unknown>): StripeSubscription {
  const items = (raw['items'] as { data?: Record<string, unknown>[] } | undefined)?.data ?? [];
  const firstItem = items[0] ?? {};
  // Selon la version d'API, current_period_end est sur l'abonnement ou sur l'item.
  const periodEnd = typeof raw['current_period_end'] === 'number' ? raw['current_period_end']
    : typeof firstItem['current_period_end'] === 'number' ? firstItem['current_period_end'] : null;
  return {
    id: str(raw['id']) ?? '',
    customer: idOf(raw['customer']) ?? '',
    status: str(raw['status']) ?? '',
    metadata: (raw['metadata'] && typeof raw['metadata'] === 'object' ? raw['metadata'] : {}) as Record<string, string>,
    priceId: idOf((firstItem['price'] as unknown)) ,
    currentPeriodEnd: periodEnd as number | null,
    cancelAtPeriodEnd: raw['cancel_at_period_end'] === true,
  };
}

function toCheckout(raw: Record<string, unknown>): StripeCheckoutSession {
  return {
    id: str(raw['id']) ?? '',
    url: str(raw['url']),
    status: str(raw['status']),
    clientReferenceId: str(raw['client_reference_id']),
    customer: idOf(raw['customer']),
    subscription: idOf(raw['subscription']),
    expiresAt: typeof raw['expires_at'] === 'number' ? raw['expires_at'] : null,
  };
}

export function httpStripeApi(config: StripeConfig, fetchImpl: typeof fetch = fetch): StripeApi {
  async function call(method: 'GET' | 'POST', path: string, form?: Record<string, string>, idempotencyKey?: string) {
    const headers: Record<string, string> = { Authorization: `Bearer ${config.secretKey}` };
    if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const response = await fetchImpl(`https://api.stripe.com${path}`, {
      method, headers, ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new StripeApiError(response.status);
    return (await response.json()) as Record<string, unknown>;
  }
  const safeId = (id: string, prefix: string) => {
    if (!new RegExp(`^${prefix}_[A-Za-z0-9_]{1,200}$`).test(id)) throw new StripeApiError(400);
    return encodeURIComponent(id);
  };
  return {
    createCheckoutSession: async (params, key) => toCheckout(await call('POST', '/v1/checkout/sessions', params, key)),
    retrieveCheckoutSession: async (id) => toCheckout(await call('GET', `/v1/checkout/sessions/${safeId(id, 'cs')}`)),
    retrieveSubscription: async (id) => toSubscription(await call('GET', `/v1/subscriptions/${safeId(id, 'sub')}`)),
    createPortalSession: async (customer, returnUrl) => {
      const raw = await call('POST', '/v1/billing_portal/sessions', { customer, return_url: returnUrl });
      const url = str(raw['url']);
      if (!url) throw new StripeApiError(502);
      return { url };
    },
  };
}
