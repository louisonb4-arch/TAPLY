/**
 * creditVisit — crédite un passage validé côté serveur.
 *
 * Reçoit un PoolClient DÉJÀ dans une transaction authentifiée
 * (withAuthenticatedTx) et un principal dérivé côté serveur.
 * N'ouvre jamais de transaction interne, n'émet aucune requête externe.
 * Aucune mutation par QR public — source V1 : QR_EMPLOYEE uniquement.
 *
 * NON ACTIVABLE EN PRODUCTION avant :
 *   - PIN + device approval sur validation employé
 *   - QR Wallet vérifié, PIN employé et appareil approuvé (hash != anti-replay)
 *   - Tests PostgreSQL réels (RLS, verrous, contraintes)
 *   - Validation RLS staging (les mocks ne certifient pas RLS)
 */

import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AuthenticatedPrincipal } from '../auth/session.js';
import { runIdempotent } from '../db/idempotency.js';
import { decideVisitCredit } from './rules.js';
import { isValidThreshold } from './rules.js';
import type { MembershipState, ProgramRules, RuleVersionInfo, VisitDenialReason } from './types.js';

// ── Types d'entrée / sortie ─────────────────────────────────────────

/** Source de crédit autorisée V1. */
export type CreditSource = 'QR_EMPLOYEE';

export interface CreditVisitParams {
  readonly membershipId: string;
  readonly source: CreditSource;
  readonly idempotencyKey: string;
}

export type CreditVisitResult =
  | {
      readonly credited: true;
      readonly visitCount: number;
      readonly rewardUnlocked: boolean;
      readonly cycleNumber: number;
      readonly creditedAt: string;
    }
  | {
      readonly credited: false;
      readonly reason: CreditVisitDenialReason;
    };

export type CreditVisitDenialReason =
  | VisitDenialReason
  | { readonly kind: 'unauthorized_role' }
  | { readonly kind: 'membership_not_found' }
  | { readonly kind: 'program_inactive' }
  | { readonly kind: 'merchant_not_active' }
  | { readonly kind: 'invalid_request' };

// ── Fingerprint déterministe ────────────────────────────────────────

function computeFingerprint(merchantId: string, membershipId: string, source: CreditSource): string {
  return createHash('sha256').update(`${merchantId}:${membershipId}:${source}`).digest('hex');
}

// ── Requête d'état jointe ───────────────────────────────────────────

interface StateRow {
  readonly visit_count: number;
  readonly reward_pending: boolean;
  readonly last_credited_at: Date | string | null;
  readonly cycle_number: number;
  readonly membership_status: string;
  readonly program_status: string;
  readonly merchant_status: string;
  readonly pinned_rules: unknown;
  readonly pinned_rule_created_at: Date | string;
  readonly db_now: Date | string;
}

const STATE_QUERY = `
  select
    s.visit_count,
    s.reward_pending,
    s.last_credited_at,
    s.cycle_number,
    m.status   as membership_status,
    lp.status  as program_status,
    mer.status as merchant_status,
    pin.rules  as pinned_rules,
    pin.created_at as pinned_rule_created_at,
    now()      as db_now
  from taply.membership_states s
  join taply.memberships m
    on m.id = s.membership_id
   and m.merchant_id = s.merchant_id
  join taply.program_rule_versions pin
    on pin.id = m.current_rule_version_id
   and pin.merchant_id = m.merchant_id
   and pin.program_id = m.program_id
  join taply.loyalty_programs lp
    on lp.id = m.program_id
   and lp.merchant_id = m.merchant_id
  join taply.merchants mer
    on mer.id = m.merchant_id
  where s.membership_id = $1
    and s.merchant_id = $2
    and m.merchant_id = $2
  for update of s
` as const;

// ── Parsing défensif des rules JSON ─────────────────────────────────

function parseProgramRules(raw: unknown): ProgramRules | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj['threshold'] !== 'number') return null;
  if (!isValidThreshold(obj['threshold'])) return null;
  return { threshold: obj['threshold'] };
}

// ── Fonction principale ─────────────────────────────────────────────

// Les types TypeScript ne protègent pas une frontière HTTP à l'exécution.
const creditRequestSchema = z.object({
  membershipId: z.uuid(),
  idempotencyKey: z.uuid(),
  source: z.literal('QR_EMPLOYEE'),
});

function toValidIso(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export async function creditVisit(
  client: PoolClient,
  principal: AuthenticatedPrincipal,
  params: CreditVisitParams,
): Promise<CreditVisitResult> {
  // ── Vérification rôle (owner ou staff) ────────────────────────────
  if (principal.role !== 'owner' && principal.role !== 'staff') {
    return { credited: false, reason: { kind: 'unauthorized_role' } };
  }

  if (!creditRequestSchema.safeParse(params).success) {
    return { credited: false, reason: { kind: 'invalid_request' } };
  }

  const fingerprint = computeFingerprint(principal.merchantId, params.membershipId, params.source);

  return runIdempotent<CreditVisitResult>(
    client,
    {
      merchantId: principal.merchantId,
      operation: 'credit_visit',
      idempotencyKey: params.idempotencyKey,
      fingerprint,
    },
    async () => {
      // ── Lecture état + verrou ────────────────────────────────────────
      const stateResult = await client.query<StateRow>(STATE_QUERY, [
        params.membershipId,
        principal.merchantId,
      ]);
      const row = stateResult.rows[0];
      if (row === undefined) {
        return { credited: false, reason: { kind: 'membership_not_found' } };
      }

      // ── Vérification statuts applicatifs (pas uniquement RLS) ───────
      if (row.merchant_status !== 'active') {
        return { credited: false, reason: { kind: 'merchant_not_active' } };
      }
      if (row.program_status !== 'active') {
        return { credited: false, reason: { kind: 'program_inactive' } };
      }
      if (row.membership_status !== 'active') {
        return { credited: false, reason: { kind: 'membership_inactive' } };
      }

      // ── Parsing rules JSON défensif ─────────────────────────────────
      const pinnedRules = parseProgramRules(row.pinned_rules);
      if (pinnedRules === null) {
        return { credited: false, reason: { kind: 'invalid_state' } };
      }

      // ── Construction état pour décision ─────────────────────────────
      const dbNow = toValidIso(row.db_now);
      const lastVisitAt = toValidIso(row.last_credited_at);
      const pinnedCreatedAt = toValidIso(row.pinned_rule_created_at);
      if (
        dbNow === null || pinnedCreatedAt === null ||
        (row.last_credited_at !== null && lastVisitAt === null) ||
        !Number.isInteger(row.cycle_number) || row.cycle_number < 1
      ) {
        return { credited: false, reason: { kind: 'invalid_state' } };
      }

      const membership: MembershipState = {
        visitCount: row.visit_count,
        lastVisitAt,
        rewardPending: row.reward_pending,
      };
      const ruleInfo: RuleVersionInfo = {
        pinnedRules,
        activeRuleCreatedAt: pinnedCreatedAt,
      };

      // ── Décision pure ───────────────────────────────────────────────
      const decision = decideVisitCredit(membership, ruleInfo, dbNow, dbNow, true);

      if (!decision.allowed) {
        return { credited: false, reason: decision.reason };
      }

      // ── Mutations : UPDATE état + INSERT ledger ─────────────────────
      const updated = await client.query(
        `update taply.membership_states
         set visit_count = $1,
             reward_pending = $2,
             last_credited_at = now(),
             updated_at = now()
         where membership_id = $3
           and merchant_id = $4`,
        [decision.newVisitCount, decision.rewardUnlocked, params.membershipId, principal.merchantId],
      );
      if (updated.rowCount !== 1) throw new Error('loyalty state update failed');

      const inserted = await client.query(
        `insert into taply.visit_ledger
           (membership_id, merchant_id, cycle_number, source, idempotency_key, performed_by)
         values ($1, $2, $3, $4, $5, $6)`,
        [params.membershipId, principal.merchantId, row.cycle_number, params.source, params.idempotencyKey, principal.merchantUserId],
      );
      if (inserted.rowCount !== 1) throw new Error('loyalty ledger insert failed');

      return {
        credited: true,
        visitCount: decision.newVisitCount,
        rewardUnlocked: decision.rewardUnlocked,
        cycleNumber: row.cycle_number,
        creditedAt: dbNow,
      };
    },
  );
}
