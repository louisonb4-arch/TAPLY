/**
 * Vue propriétaire de surveillance anti-fraude — lecture seule, RLS tenant.
 *
 * Ne lit/n'expose jamais les empreintes de PIN, le salt, les hashes de
 * session/appareil, les QR bruts ni les données personnelles des clients.
 * Un pic de passages est un SIGNAL à examiner, pas une preuve de fraude.
 */
import type { PoolClient } from 'pg';
import type { AuthenticatedPrincipal } from '../auth/session.js';

const DEVICE_LIMIT = 100;
const ACTIVITY_LIMIT = 100;
const HIGH_VELOCITY_LIMIT = 15;

interface DeviceRow {
  readonly id: string;
  readonly merchant_user_id: string;
  readonly failed_attempts: number;
  readonly locked_until: Date | null;
  readonly revoked_at: Date | null;
  readonly last_used_at: Date | null;
  readonly created_at: Date;
}
interface ActivityRow {
  readonly id: string;
  readonly kind: 'visit' | 'reward';
  readonly membership_id: string;
  readonly performed_by: string | null;
  readonly happened_at: Date;
}
interface HighVelocityRow {
  readonly merchant_user_id: string;
  readonly count: number;
}

export async function securityOverview(
  client: PoolClient,
  principal: AuthenticatedPrincipal,
): Promise<{
  readonly devices: readonly {
    id: string; merchantUserId: string;
    failedAttempts: number; lockedUntil: Date | null; revokedAt: Date | null;
    lastUsedAt: Date | null; createdAt: Date;
  }[];
  readonly recentActivity: readonly {
    id: string; kind: 'visit' | 'reward'; membershipId: string;
    performedBy: string | null; happenedAt: Date;
  }[];
  readonly unusualVelocity: readonly { merchantUserId: string; visitsIn10Minutes: number }[];
} | undefined> {
  // Aucun SELECT si staff : permissions applicatives en plus de FORCE RLS.
  if (principal.role !== 'owner') return undefined;

  const [deviceRows, activityRows, velocityRows] = await Promise.all([
    client.query<DeviceRow>(
      `select id, merchant_user_id, failed_attempts, locked_until,
              revoked_at, last_used_at, created_at
         from taply.staff_devices
        where merchant_id=$1
        order by created_at desc, id desc
        limit $2`,
      [principal.merchantId, DEVICE_LIMIT],
    ),
    client.query<ActivityRow>(
      `select id, kind, membership_id, performed_by, happened_at
         from (
           select id, 'visit'::text as kind, membership_id, performed_by,
                  credited_at as happened_at
             from taply.visit_ledger where merchant_id=$1
           union all
           select id, 'reward'::text as kind, membership_id, performed_by,
                  redeemed_at as happened_at
             from taply.redemption_ledger where merchant_id=$1
         ) a
        order by happened_at desc, id desc
        limit $2`,
      [principal.merchantId, ACTIVITY_LIMIT],
    ),
    client.query<HighVelocityRow>(
      `select performed_by as merchant_user_id, count(*)::integer as count
         from taply.visit_ledger
        where merchant_id=$1 and performed_by is not null
          and credited_at >= now() - interval '10 minutes'
        group by performed_by
       having count(*) >= $2
        order by count desc, performed_by
        limit 20`,
      [principal.merchantId, HIGH_VELOCITY_LIMIT],
    ),
  ]);

  return {
    devices: deviceRows.rows.map(d => ({
      id: d.id, merchantUserId: d.merchant_user_id,
      failedAttempts: d.failed_attempts,
      lockedUntil: d.locked_until, revokedAt: d.revoked_at,
      lastUsedAt: d.last_used_at, createdAt: d.created_at,
    })),
    recentActivity: activityRows.rows.map(a => ({
      id: a.id, kind: a.kind, membershipId: a.membership_id,
      performedBy: a.performed_by, happenedAt: a.happened_at,
    })),
    unusualVelocity: velocityRows.rows.map(v => ({
      merchantUserId: v.merchant_user_id, visitsIn10Minutes: v.count,
    })),
  };
}
