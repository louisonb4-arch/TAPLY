/**
 * Liste commerçant, lecture seule. 50 dernières cartes maximum.
 * Chaque jointure inclut merchant_id ; RLS force une seconde frontière.
 * Jamais de QR/token, email ou données sensibles du client en sortie.
 */
import type { PoolClient } from 'pg';
import type { AuthenticatedPrincipal } from '../auth/session.js';
import { isValidThreshold } from './rules.js';

interface CustomerRow {
  id: string;
  first_name: string;
  program_id: string;
  program_name: string;
  visit_count: number;
  reward_pending: boolean;
  cycle_number: number;
  last_credited_at: Date | null;
  created_at: Date;
  rules: { threshold?: number };
}
export async function merchantCustomers(client: PoolClient, principal: AuthenticatedPrincipal) {
  if (principal.role !== 'owner') return undefined;
  const result = await client.query<CustomerRow>(
    `select m.id, coalesce(profile.first_name, 'Client') as first_name,
       m.program_id, p.name as program_name, s.visit_count, s.reward_pending,
       s.cycle_number, s.last_credited_at, m.created_at, v.rules
     from taply.memberships m
     join taply.loyalty_programs p on p.id=m.program_id and p.merchant_id=m.merchant_id
     join taply.membership_states s on s.membership_id=m.id and s.merchant_id=m.merchant_id
     join taply.program_rule_versions v on v.id=m.current_rule_version_id
       and v.program_id=m.program_id and v.merchant_id=m.merchant_id
     left join taply.customer_profiles profile on profile.customer_id=m.customer_id
       and profile.merchant_id=m.merchant_id
     where m.merchant_id=$1
     order by m.created_at desc, m.id desc limit 50`,
    [principal.merchantId],
  );
  return result.rows.map(row => ({
    membershipId: row.id, firstName: row.first_name,
    programId: row.program_id, programName: row.program_name,
    visitCount: row.visit_count, rewardPending: row.reward_pending,
    cycleNumber: row.cycle_number, lastVisitAt: row.last_credited_at,
    joinedAt: row.created_at,
    threshold: isValidThreshold(row.rules?.threshold ?? -1) ? row.rules.threshold ?? null : null,
  }));
}
