/**
 * QR PUBLIC = pré-inscription seulement, jamais un passage.
 * QR éphémère 10 minutes -> employé authentifié + appareil + PIN + achat
 * confirme la présence, crée Wallet QR personnel et crédite le 1er passage.
 *
 * Protection anti-abus en preview: quota DB par commerce (20 / 10 min),
 * transaction sérialisée par advisory lock. Un anti-bot/WAF externe sera
 * obligatoire AVANT d'autoriser une inscription anonyme en production.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { AuthenticatedPrincipal } from '../auth/session.js';
import { resolvePublicEnrollmentLink } from '../db/lookup.js';
import { withTenantTx } from '../db/tenant-context.js';
import { registerCustomer } from './operations.js';
import { creditVisit } from './credit.js';

const nameSchema = z.string().trim().regex(/^[\p{L}\p{M}][\p{L}\p{M}\s.'’-]{0,39}$/u);
const startSchema = z.strictObject({
  publicToken: z.string().min(16).max(512),
  firstName: nameSchema,
  privacyAccepted: z.literal(true),
});
const claimSchema = z.strictObject({
  claimToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  idempotencyKey: z.uuid(),
});
const MAX_PENDING_PER_MERCHANT_10MIN = 20;

function hashClaim(raw: string): string {
  return createHash('sha256').update('taply:enrollment-claim:v1:' + raw).digest('hex');
}

export type PreparedEnrollment =
  | { status: 'prepared'; claimToken: string; expiresInSeconds: 600 }
  | { status: 'not_found' }
  | { status: 'rate_limited' };

export async function preparePublicEnrollment(
  pool: Pool,
  input: { publicToken: string; firstName: string; privacyAccepted: true },
): Promise<PreparedEnrollment> {
  const parsed = startSchema.safeParse(input);
  if (!parsed.success) return { status: 'not_found' };
  const target = await resolvePublicEnrollmentLink(pool, parsed.data.publicToken);
  if (!target) return { status: 'not_found' };

  return withTenantTx(pool, target.merchantId, async (client) => {
    // Mutex tenant : deux requêtes simultanées ne contournent pas le quota.
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',
      ['taply:pending:' + target.merchantId]);
    await client.query(`delete from taply.pending_enrollments
      where merchant_id=$1 and expires_at < now()`, [target.merchantId]);

    const active = await client.query(`select p.id from taply.loyalty_programs p
      join taply.merchants m on m.id=p.merchant_id
      join taply.locations l on l.id=$3 and l.merchant_id=p.merchant_id
      where p.id=$1 and p.merchant_id=$2 and p.status='active'
        and m.status='active' and l.status='active'`,
      [target.programId, target.merchantId, target.locationId]);
    if (active.rowCount !== 1) return { status: 'not_found' };

    const count = await client.query<{ n: number }>(`select count(*)::integer as n
      from taply.pending_enrollments where merchant_id=$1
        and created_at > now() - interval '10 minutes'`, [target.merchantId]);
    if ((count.rows[0]?.n ?? MAX_PENDING_PER_MERCHANT_10MIN) >= MAX_PENDING_PER_MERCHANT_10MIN) {
      return { status: 'rate_limited' };
    }

    const raw = randomBytes(32).toString('base64url');
    await client.query(`insert into taply.pending_enrollments
      (merchant_id,program_id,location_id,claim_hash,first_name,expires_at)
      values($1,$2,$3,$4,$5,now()+interval '10 minutes')`,
      [target.merchantId, target.programId, target.locationId,
        hashClaim(raw), parsed.data.firstName]);
    return { status: 'prepared', claimToken: raw, expiresInSeconds: 600 };
  });
}

export type ConfirmedEnrollment =
  | { status: 'confirmed'; membershipId: string; qrToken: string;
      firstVisitCredited: true; visitCount: number; rewardUnlocked: boolean }
  | { status: 'not_found' };

export async function confirmPublicEnrollment(
  client: PoolClient,
  principal: AuthenticatedPrincipal,
  input: { claimToken: string; idempotencyKey: string },
): Promise<ConfirmedEnrollment> {
  if (!['owner', 'staff'].includes(principal.role)) return { status: 'not_found' };
  const parsed = claimSchema.safeParse(input);
  if (!parsed.success) return { status: 'not_found' };
  // DELETE ... RETURNING atomique: un seul employé peut consommer ce claim.
  // Si le crédit de passage échoue, la transaction ROLLBACK restaure la ligne.
  const result = await client.query<{
    id: string; program_id: string; first_name: string;
  }>(`delete from taply.pending_enrollments e
      using taply.loyalty_programs p, taply.merchants m
      where e.claim_hash=$1 and e.merchant_id=$2 and e.expires_at>now()
        and p.id=e.program_id and p.merchant_id=e.merchant_id
        and m.id=e.merchant_id
        and p.status='active' and m.status='active'
      returning e.id,e.program_id,e.first_name`,
    [hashClaim(parsed.data.claimToken), principal.merchantId]);
  const row = result.rows[0];
  if (!row) return { status: 'not_found' };

  const customer = await registerCustomer(client, principal, {
    firstName: row.first_name, programId: row.program_id,
    privacyAccepted: true, idempotencyKey: randomUUID(),
  });
  if (!customer?.qrToken) throw new Error('Failed to activate prepared membership');
  const credited = await creditVisit(client, principal, {
    membershipId: customer.membershipId, source: 'QR_EMPLOYEE',
    idempotencyKey: parsed.data.idempotencyKey,
  });
  if (!credited.credited) throw new Error('Initial visit credit failed');

  return {
    status: 'confirmed', membershipId: customer.membershipId,
    qrToken: customer.qrToken, firstVisitCredited: true,
    visitCount: credited.visitCount, rewardUnlocked: credited.rewardUnlocked,
  };
}
