import { describe, expect, it } from 'vitest';
import { httpStripeApi, STRIPE_API_VERSION, StripeApiError } from '../../../backend/billing/stripe.js';

const config = { secretKey: 'sk_test_abc123', webhookSecret: 'whsec_abc', priceId: 'price_abc' };

function recordingFetch(body: Record<string, unknown>, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe('httpStripeApi', () => {
  it('fige la version d\'API et transmet la clé d\'idempotence', async () => {
    const { calls, impl } = recordingFetch({ id: 'cs_test_1', url: 'https://checkout.stripe.com/x', status: 'open' });
    const api = httpStripeApi(config, impl);
    const session = await api.createCheckoutSession({ mode: 'subscription' }, 'taply-checkout-k');
    expect(session.id).toBe('cs_test_1');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Stripe-Version']).toBe(STRIPE_API_VERSION);
    expect(headers['Idempotency-Key']).toBe('taply-checkout-k');
    expect(calls[0]!.init.body).toBe('mode=subscription');
    expect(calls[0]!.init.body).not.toContain('payment_method_types');
  });

  it('lit current_period_end sur l\'item (API récente)', async () => {
    const { impl } = recordingFetch({
      id: 'sub_1', customer: 'cus_1', status: 'active', metadata: {}, cancel_at_period_end: false,
      items: { data: [{ price: { id: 'price_abc' }, current_period_end: 1_800_000_000 }] },
    });
    const sub = await httpStripeApi(config, impl).retrieveSubscription('sub_1');
    expect(sub.priceId).toBe('price_abc');
    expect(sub.currentPeriodEnd).toBe(1_800_000_000);
  });

  it('refuse un identifiant mal formé sans appeler Stripe', async () => {
    const { calls, impl } = recordingFetch({});
    await expect(httpStripeApi(config, impl).retrieveSubscription('../v1/customers')).rejects.toBeInstanceOf(StripeApiError);
    expect(calls).toHaveLength(0);
  });
});
