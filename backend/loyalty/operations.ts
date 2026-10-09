/**
 * Fonctionnement V1 : inscription encadrée au comptoir, QR personnel,
 * état de fidélité et options. Jamais de premier crédit automatique.
 *
 * Toute mutation appelée UNIQUEMENT via une session authentifiée + appareil
 * approuvé + PIN, dans la transaction d'origine (RLS active).
 */
import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AuthenticatedPrincipal } from '../auth/session.js';
import { runIdempotent } from '../db/idempotency.js';
import { generateWalletQrToken, hashWalletQrToken } from './qr-token.js';
import { isValidThreshold } from './rules.js';

const FIRST_NAME = /^[\p{L}\p{M}][\p{L}\p{M}\s.'’-]{0,39}$/u;
const registerSchema = z.strictObject({
  firstName: z.string().trim().regex(FIRST_NAME),
  programId: z.uuid(),
  idempotencyKey: z.uuid(),
  privacyAccepted: z.literal(true),
});

export interface RegisterCustomerRequest {
  firstName: string;
  programId: string;
  idempotencyKey: string;
  privacyAccepted: true;
}

export async function registerCustomer(
  client: PoolClient,
  principal: AuthenticatedPrincipal,
  input: RegisterCustomerRequest,
): Promise<{ customerId: string; membershipId: string; qrToken?: string } | undefined> {
  if (!['owner', 'staff'].includes(principal.role) || !registerSchema.safeParse(input).success) return undefined;
  const target = await client.query<{ id: string; rule_id: string }>(
    `select p.id, v.id as rule_id from taply.loyalty_programs p
       join taply.merchants m on m.id=p.merchant_id
       join taply.program_rule_versions v
         on v.program_id=p.id and v.merchant_id=p.merchant_id and v.is_active=true
      where p.id=$1 and p.merchant_id=$2 and p.status='active'
        and m.status='active'`,
    [input.programId, principal.merchantId],
  );
  const program = target.rows[0];
  if (!program) return undefined;
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([principal.merchantId, input.programId, input.firstName]))
    .digest('hex');
  let qrToken: string | undefined;
  const recorded = await runIdempotent<{ customerId: string; membershipId: string }>(
    client,
    { merchantId: principal.merchantId, operation: 'staff_register_customer',
      idempotencyKey: input.idempotencyKey, fingerprint },
    async () => {
      const customerId = randomUUID();
      const membershipId = randomUUID();
      const raw = generateWalletQrToken();
      const customer = await client.query(
        `insert into taply.customers(id,merchant_id) values($1,$2)`,
        [customerId, principal.merchantId],
      );
      if (customer.rowCount !== 1) throw new Error('Failed to register customer');
      const profile = await client.query(
        `insert into taply.customer_profiles(customer_id,merchant_id,first_name)
          values($1,$2,$3)`,
        [customerId, principal.merchantId, input.firstName],
      );
      if (profile.rowCount !== 1) throw new Error('Failed to register customer profile');
      const membership = await client.query(
        `insert into taply.memberships
           (id,merchant_id,customer_id,program_id,current_rule_version_id)
         values ($1,$2,$3,$4,$5)`,
        [membershipId, principal.merchantId, customerId, program.id, program.rule_id],
      );
      if (membership.rowCount !== 1) throw new Error('Failed to register membership');
      const state = await client.query(
        `insert into taply.membership_states(membership_id,merchant_id) values($1,$2)`,
        [membershipId, principal.merchantId],
      );
      if (state.rowCount !== 1) throw new Error('Failed to create loyalty state');
      const qr = await client.query(
        `insert into taply.wallet_qr_tokens(membership_id,merchant_id,token_hash)
           values($1,$2,$3)`,
        [membershipId, principal.merchantId, hashWalletQrToken(raw)],
      );
      if (qr.rowCount !== 1) throw new Error('Failed to issue loyalty QR');
      qrToken = raw; // NEVER store plaintext in idempotency_requests.
      return { customerId, membershipId };
    },
  );
  return { ...recorded, ...(qrToken === undefined ? {} : { qrToken }) };
}

export async function getLoyaltyCard(
  client: PoolClient,
  principal: AuthenticatedPrincipal,
  qrToken: string,
): Promise<{ visitCount: number; rewardPending: boolean; cycleNumber: number;
  threshold: number; firstName: string } | undefined> {
  const { resolveWalletQrToken } = await import('./qr-token.js');
  const id = await resolveWalletQrToken(client, principal, qrToken);
  if (!id) return undefined;
  const r = await client.query<{
    visit_count: number; reward_pending: boolean; cycle_number: number;
    rules: { threshold: number }; first_name: string;
  }>(`select s.visit_count,s.reward_pending,s.cycle_number,v.rules,
       coalesce(profile.first_name, 'Client') as first_name
     from taply.membership_states s
     join taply.memberships m on m.id=s.membership_id and m.merchant_id=s.merchant_id
     join taply.program_rule_versions v on v.id=m.current_rule_version_id
       and v.merchant_id=m.merchant_id
     left join taply.customer_profiles profile on profile.customer_id=m.customer_id
       and profile.merchant_id=m.merchant_id
     where s.membership_id=$1 and s.merchant_id=$2`, [id, principal.merchantId]);
  const row = r.rows[0];
  if (!row || !isValidThreshold(row.rules.threshold)) return undefined;
  return {
    visitCount: row.visit_count, rewardPending: row.reward_pending,
    cycleNumber: row.cycle_number, threshold: row.rules.threshold, firstName: row.first_name,
  };
}

export async function merchantOverview(client: PoolClient, principal: AuthenticatedPrincipal) {
  const programs = await client.query<{
    id: string; name: string; status: string; rules: { threshold: number };
    notifications_enabled: boolean; total_members: number; pending_rewards: number;
  }>(`select p.id,p.name,p.status,v.rules,
       coalesce(pref.notifications_enabled,false) as notifications_enabled,
       (select count(*)::integer from taply.memberships ms
          where ms.program_id=p.id and ms.merchant_id=p.merchant_id) as total_members,
       (select count(*)::integer from taply.memberships ms
          join taply.membership_states s on s.membership_id=ms.id
            and s.merchant_id=ms.merchant_id
          where ms.program_id=p.id and ms.merchant_id=p.merchant_id
            and s.reward_pending=true) as pending_rewards
      from taply.loyalty_programs p
      left join taply.program_rule_versions v on v.program_id=p.id
        and v.merchant_id=p.merchant_id and v.is_active=true
      left join taply.program_preferences pref on pref.program_id=p.id
        and pref.merchant_id=p.merchant_id
      where p.merchant_id=$1 order by p.created_at`, [principal.merchantId]);
  return programs.rows.map(p => ({
    id: p.id, name: p.name, status: p.status,
    threshold: p.rules?.threshold ?? null,
    notificationsEnabled: p.notifications_enabled,
    totalMembers: p.total_members, pendingRewards: p.pending_rewards,
  }));
}

export async function updateMerchantProgram(
  client: PoolClient,
  principal: AuthenticatedPrincipal,
  input: { programId: string; status: 'active' | 'paused'; notificationsEnabled: boolean;
    threshold?: number },
): Promise<{ ok: true; nextThreshold: number } | { ok: false; reason: string }> {
  if (principal.role !== 'owner') return { ok: false, reason: 'forbidden' };
  const program = await client.query<{ id: string; status: string }>(
    `select id,status from taply.loyalty_programs
     where id=$1 and merchant_id=$2 and status <> 'archived' for update`,
    [input.programId, principal.merchantId],
  );
  if (!program.rows[0]) return { ok: false, reason: 'not_found' };
  const active = await client.query<{
    id: string; version_no: number; threshold: number; created_at: Date | string;
  }>(`select id, version_no, (rules->>'threshold')::integer as threshold, created_at
      from taply.program_rule_versions where program_id=$1 and merchant_id=$2
        and is_active=true`,
    [input.programId, principal.merchantId]);
  const version = active.rows[0];
  if (!version || !isValidThreshold(version.threshold)) return { ok: false, reason: 'invalid_state' };
  if (input.threshold !== undefined && input.threshold !== version.threshold) {
    // Un seul chemin de modification contractuelle (seuil + récompenses,
    // verrou 30 jours, versions) : merchant-setup.updateProgramContract.
    return { ok: false, reason: 'use_contract_update' };
  }
  await client.query(
    `update taply.loyalty_programs set status=$1,updated_at=now()
      where id=$2 and merchant_id=$3`,
    [input.status, input.programId, principal.merchantId],
  );
  await client.query(
    `insert into taply.program_preferences(merchant_id,program_id,notifications_enabled)
     values($1,$2,$3)
     on conflict(program_id) do update set
       notifications_enabled=excluded.notifications_enabled, updated_at=now()`,
    [principal.merchantId, input.programId, input.notificationsEnabled],
  );
  return { ok: true, nextThreshold: input.threshold ?? version.threshold };
}
