/**
 * Parcours « paiement d'abord » : abonnement payé sur Stripe AVANT la
 * création du compte, puis rattaché au commerce.
 *
 * Invariants :
 *   - un paiement n'est rattaché qu'à un compte dont l'e-mail est CONFIRMÉ
 *     (Supabase) et identique à l'e-mail du payeur relu auprès de Stripe :
 *     connaître l'identifiant de session ne suffit pas à s'approprier un
 *     paiement ;
 *   - l'e-mail n'est jamais stocké en clair (empreinte à domaine séparé) ;
 *   - un commerce ayant déjà un abonnement en vigueur ne reçoit jamais un
 *     second abonnement : le paiement est marqué « duplicate » et journalisé
 *     pour remboursement manuel ;
 *   - webhook et page de retour enregistrent le même paiement de façon
 *     idempotente (clé primaire = session Checkout).
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withTx } from '../db/tenant-context.js';
import type { Logger } from '../core/logger.js';
import { applySubscription } from './service.js';
import type { StripeApi } from './stripe.js';

export const SIGNUP_FLOW = 'signup';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function checkoutEmailHash(email: string): string {
  return createHash('sha256').update('taply:checkout-email:v1:' + normalizeEmail(email)).digest('hex');
}

/** Paramètres Checkout du parcours sans compte (aucun client Stripe imposé). */
export function signupCheckoutParams(input: { priceId: string; origin: string }): Record<string, string> {
  return {
    mode: 'subscription',
    'line_items[0][price]': input.priceId,
    'line_items[0][quantity]': '1',
    'metadata[taply_flow]': SIGNUP_FLOW,
    'subscription_data[metadata][taply_flow]': SIGNUP_FLOW,
    success_url: `${input.origin}/activer.html?paiement={CHECKOUT_SESSION_ID}`,
    cancel_url: `${input.origin}/creer-compte.html?paiement=annule`,
    locale: 'fr',
    allow_promotion_codes: 'true',
    billing_address_collection: 'required',
    'tax_id_collection[enabled]': 'true',
  };
}

export type RecordOutcome =
  | { readonly status: 'paid'; readonly email: string }
  | { readonly status: 'pending' }
  | { readonly status: 'invalid' };

/**
 * Relit la session auprès de Stripe et, si elle est payée et issue du
 * parcours sans compte, enregistre le paiement en attente de rattachement.
 */
export async function recordSignupCheckout(pool: Pool, stripe: StripeApi, sessionId: string, log: Logger): Promise<RecordOutcome> {
  const session = await stripe.retrieveCheckoutSession(sessionId);
  if (session.flow !== SIGNUP_FLOW || session.clientReferenceId !== null) return { status: 'invalid' };
  if (session.status !== 'complete' || !session.subscription || !session.customer || !session.customerEmail) {
    return { status: 'pending' };
  }
  const subscriptionId = session.subscription;
  const customerId = session.customer;
  const email = normalizeEmail(session.customerEmail);
  await withTx(pool, async (client) => {
    await client.query('select set_config($1, $2, true)', ['app.checkout_session_id', session.id]);
    // Sans cible : webhook et page de retour simultanés peuvent heurter la
    // clé primaire OU l'unicité de l'abonnement ; les deux = même paiement.
    const inserted = await client.query(
      `insert into taply.signup_checkouts (checkout_session_id, email_hash, stripe_customer_id, stripe_subscription_id)
       values ($1, $2, $3, $4) on conflict do nothing`,
      [session.id, checkoutEmailHash(email), customerId, subscriptionId],
    );
    if (inserted.rowCount === 1) log.info('billing.signup_checkout.recorded', {});
  });
  return { status: 'paid', email };
}

export type ClaimOutcome = 'claimed' | 'duplicate' | 'email_mismatch' | 'rejected';

/**
 * Rattache au commerce les paiements en attente correspondant à l'e-mail
 * confirmé du propriétaire qui vient de se connecter.
 */
export async function claimSignupCheckouts(
  pool: Pool, stripe: StripeApi, input: { merchantId: string; confirmedEmail: string }, log: Logger,
): Promise<ClaimOutcome[]> {
  const email = normalizeEmail(input.confirmedEmail);
  const emailHash = checkoutEmailHash(email);
  const pending = await withTx(pool, async (client) => {
    await client.query('select set_config($1, $2, true)', ['app.checkout_email_hash', emailHash]);
    const r = await client.query<{ checkout_session_id: string }>(
      `select checkout_session_id from taply.signup_checkouts
        where email_hash = $1 and status = 'paid' order by created_at limit 5`, [emailHash]);
    return r.rows.map((row) => row.checkout_session_id);
  });

  const outcomes: ClaimOutcome[] = [];
  for (const sessionId of pending) {
    // Source de vérité : la session et l'abonnement relus chez Stripe.
    const session = await stripe.retrieveCheckoutSession(sessionId);
    if (!session.customerEmail || normalizeEmail(session.customerEmail) !== email || !session.subscription) {
      log.warn('billing.signup_checkout.email_mismatch', { merchantId: input.merchantId });
      outcomes.push('email_mismatch');
      continue;
    }
    const sub = await stripe.retrieveSubscription(session.subscription);
    const outcome = await withTx(pool, async (client) => {
      await client.query('select set_config($1, $2, true)', ['app.checkout_email_hash', emailHash]);
      await client.query('select set_config($1, $2, true)', ['app.merchant_id', input.merchantId]);
      // Verrou : deux logins simultanés ne rattachent pas deux fois.
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', ['taply:signup-claim:' + sessionId]);
      const still = await client.query(
        `select 1 from taply.signup_checkouts where checkout_session_id = $1 and status = 'paid'`, [sessionId]);
      if (still.rowCount !== 1) return null;
      const applied = await applySubscription(client, input.merchantId, sub, { replaceInactiveCustomer: true });
      const status = applied === 'applied' ? 'claimed' : 'duplicate';
      await client.query(
        `update taply.signup_checkouts set status = $2, merchant_id = $3, claimed_at = now()
          where checkout_session_id = $1 and status = 'paid'`,
        [sessionId, status, input.merchantId],
      );
      return { status, applied } as const;
    });
    if (outcome === null) continue;
    if (outcome.status === 'claimed') {
      log.info('billing.signup_checkout.claimed', { merchantId: input.merchantId, status: sub.status });
      outcomes.push('claimed');
    } else {
      // Remboursement manuel : abonnement en double ou incohérent.
      log.warn('billing.signup_checkout.duplicate', { merchantId: input.merchantId, reason: outcome.applied });
      outcomes.push(outcome.applied === 'invalid' ? 'rejected' : 'duplicate');
    }
  }
  return outcomes;
}
