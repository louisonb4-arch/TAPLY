/**
 * Politique d'accès explicite selon le statut d'abonnement Stripe.
 *
 * Le statut vient UNIQUEMENT de merchant_subscriptions, écrit par les
 * webhooks signés (jamais par la page de succès Stripe).
 *
 *   active, trialing            → full       : tout est permis
 *   past_due                    → grace      : opérations permises, alerte
 *   none, incomplete            → setup_only : configuration, pas de
 *                                              publication ni d'opération client
 *   unpaid, canceled, paused,
 *   incomplete_expired          → read_only  : consultation seule ; les cartes
 *                                              restent lisibles par les clients
 *
 * TAPLY_BILLING_MODE=disabled (préproduction sans clés Stripe) → full,
 * signalé comme tel à l'interface. En production le mode est toujours
 * « enforced », quelle que soit la variable.
 */
import type { PoolClient } from 'pg';

export type SubscriptionStatus =
  | 'none' | 'incomplete' | 'incomplete_expired' | 'trialing' | 'active'
  | 'past_due' | 'canceled' | 'unpaid' | 'paused';

export type AccessLevel = 'full' | 'grace' | 'setup_only' | 'read_only';
export type BillingMode = 'enforced' | 'disabled';

const STATUSES: readonly SubscriptionStatus[] = [
  'none', 'incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused',
];

export function isSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value);
}

export function billingMode(env: Readonly<Record<string, string | undefined>> = process.env): BillingMode {
  if (env['VERCEL_ENV'] === 'production' || env['APP_ENV'] === 'production') return 'enforced';
  return env['TAPLY_BILLING_MODE'] === 'enforced' ? 'enforced' : 'disabled';
}

export function accessForStatus(status: SubscriptionStatus, mode: BillingMode): AccessLevel {
  if (mode === 'disabled') return 'full';
  switch (status) {
    case 'active':
    case 'trialing':
      return 'full';
    case 'past_due':
      return 'grace';
    case 'none':
    case 'incomplete':
      return 'setup_only';
    case 'unpaid':
    case 'canceled':
    case 'paused':
    case 'incomplete_expired':
      return 'read_only';
  }
}

/** Opérations sur les clients (inscription, passage, remise, publication). */
export function canOperate(level: AccessLevel): boolean {
  return level === 'full' || level === 'grace';
}

export interface MerchantAccess {
  readonly mode: BillingMode;
  readonly status: SubscriptionStatus;
  readonly level: AccessLevel;
  readonly currentPeriodEnd: string | null;
  readonly cancelAtPeriodEnd: boolean;
}

/** Lecture sous RLS tenant (app.merchant_id déjà posé par l'appelant). */
export async function merchantAccess(client: PoolClient, merchantId: string): Promise<MerchantAccess> {
  const mode = billingMode();
  const result = await client.query<{ status: string; current_period_end: Date | string | null; cancel_at_period_end: boolean }>(
    `select status, current_period_end, cancel_at_period_end
       from taply.merchant_subscriptions where merchant_id = $1`,
    [merchantId],
  );
  const row = result.rows[0];
  const status: SubscriptionStatus = row !== undefined && isSubscriptionStatus(row.status) ? row.status : 'none';
  return {
    mode,
    status,
    level: accessForStatus(status, mode),
    currentPeriodEnd: row?.current_period_end ? new Date(row.current_period_end).toISOString() : null,
    cancelAtPeriodEnd: row?.cancel_at_period_end ?? false,
  };
}
