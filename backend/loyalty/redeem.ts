/**
 * redeemReward — remise manuelle de récompense, côté serveur.
 *
 * Reçoit un PoolClient DÉJÀ dans une transaction authentifiée
 * (withAuthenticatedTx) et un principal dérivé côté serveur.
 * N'ouvre jamais de transaction interne, n'émet aucune requête externe.
 *
 * NON ACTIVABLE EN PRODUCTION avant :
 *   - PIN employé + device approval
 *   - QR Wallet vérifié et appareil approuvé
 *   - Tests PostgreSQL réels (RLS, verrous, contraintes)
 */

import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AuthenticatedPrincipal } from '../auth/session.js';
import { runIdempotent } from '../db/idempotency.js';
import { decideRedeem } from './rules.js';
import { isValidThreshold } from './rules.js';
import type { MembershipState, ProgramRules, RedeemDenialReason, RuleVersionInfo } from './types.js';
import { parseStoredContract } from './program-rules.js';

// ── Types d'entrée / sortie ─────────────────────────────────────────

export interface RedeemRewardParams {
  readonly membershipId: string;
  readonly idempotencyKey: string;
  readonly expectedCycleNumber: number;
  /** Récompense choisie au comptoir si le client n'a pas encore choisi. */
  readonly rewardKey?: string;
}

export type RedeemRewardResult =
  | {
      readonly redeemed: true;
      readonly completedCycle: number;
      readonly newCycleNumber: number;
      readonly nextThreshold: number;
      readonly redeemedAt: string;
      readonly reward?: { readonly key: string; readonly title: string };
    }
  | {
      readonly redeemed: false;
      readonly reason: RedeemRewardDenialReason;
    };

export type RedeemRewardDenialReason =
  | RedeemDenialReason
  | { readonly kind: 'unauthorized_role' }
  | { readonly kind: 'membership_not_found' }
  | { readonly kind: 'program_inactive' }
  | { readonly kind: 'merchant_not_active' }
  | { readonly kind: 'invalid_request' }
  | { readonly kind: 'cycle_mismatch'; readonly currentCycle: number }
  | { readonly kind: 'no_active_rule_version' }
  | { readonly kind: 'reward_choice_required'; readonly options: readonly { key: string; title: string }[] }
  | { readonly kind: 'reward_choice_mismatch'; readonly chosen: { key: string; title: string } }
  | { readonly kind: 'reward_unknown' };

// ── Fingerprint déterministe ────────────────────────────────────────

function computeFingerprint(merchantId: string, membershipId: string, expectedCycleNumber: number, rewardKey?: string): string {
  const base = `${merchantId}:${membershipId}:${expectedCycleNumber}`;
  return createHash('sha256').update(rewardKey === undefined ? base : `${base}:${rewardKey}`).digest('hex');
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
  readonly active_rule_version_id: string | null;
  readonly active_rules: unknown | null;
  readonly legacy_reward_title?: string | null;
}

interface ClaimRow {
  readonly id: string;
  readonly reward_key: string;
  readonly reward_title: string;
  readonly status: string;
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
    now()      as db_now,
    active.id    as active_rule_version_id,
    active.rules as active_rules,
    (select pub.reward_title from taply.program_publications pub
      where pub.program_id = m.program_id and pub.merchant_id = m.merchant_id) as legacy_reward_title
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
  left join taply.program_rule_versions active
    on active.program_id = m.program_id
   and active.merchant_id = m.merchant_id
   and active.is_active = true
  where s.membership_id = $1
    and s.merchant_id = $2
    and m.merchant_id = $2
  for update of s, m
` as const;

// ── Parsing défensif des rules JSON ─────────────────────────────────

function parseProgramRules(raw: unknown): ProgramRules | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj['threshold'] !== 'number') return null;
  if (!isValidThreshold(obj['threshold'])) return null;
  return { threshold: obj['threshold'] };
}

// ── Validation Zod runtime ──────────────────────────────────────────

const redeemRequestSchema = z.object({
  membershipId: z.uuid(),
  idempotencyKey: z.uuid(),
  expectedCycleNumber: z.number().int().positive(),
  rewardKey: z.string().regex(/^[a-z0-9_-]{1,32}$/).optional(),
});

function toValidIso(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// ── Fonction principale ─────────────────────────────────────────────

export async function redeemReward(
  client: PoolClient,
  principal: AuthenticatedPrincipal,
  params: RedeemRewardParams,
): Promise<RedeemRewardResult> {
  // ── Vérification rôle (owner ou staff) ────────────────────────────
  if (principal.role !== 'owner' && principal.role !== 'staff') {
    return { redeemed: false, reason: { kind: 'unauthorized_role' } };
  }

  if (!redeemRequestSchema.safeParse(params).success) {
    return { redeemed: false, reason: { kind: 'invalid_request' } };
  }

  const fingerprint = computeFingerprint(principal.merchantId, params.membershipId, params.expectedCycleNumber, params.rewardKey);

  return runIdempotent<RedeemRewardResult>(
    client,
    {
      merchantId: principal.merchantId,
      operation: 'redeem_reward',
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
        return { redeemed: false, reason: { kind: 'membership_not_found' } };
      }

      // ── Vérification statuts applicatifs ────────────────────────────
      if (row.merchant_status !== 'active') {
        return { redeemed: false, reason: { kind: 'merchant_not_active' } };
      }
      if (row.program_status !== 'active') {
        return { redeemed: false, reason: { kind: 'program_inactive' } };
      }
      if (row.membership_status !== 'active') {
        return { redeemed: false, reason: { kind: 'membership_inactive' } };
      }

      // ── Parsing rules JSON défensif ─────────────────────────────────
      const pinnedRules = parseProgramRules(row.pinned_rules);
      if (pinnedRules === null) {
        return { redeemed: false, reason: { kind: 'invalid_state' } };
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
        return { redeemed: false, reason: { kind: 'invalid_state' } };
      }

      // ── Vérification cycle attendu ──────────────────────────────────
      if (row.cycle_number !== params.expectedCycleNumber) {
        return { redeemed: false, reason: { kind: 'cycle_mismatch', currentCycle: row.cycle_number } };
      }

      // ── Vérification version active pour prochain cycle ─────────────
      if (row.active_rule_version_id === null) {
        return { redeemed: false, reason: { kind: 'no_active_rule_version' } };
      }
      const activeRules = parseProgramRules(row.active_rules);
      if (activeRules === null) {
        return { redeemed: false, reason: { kind: 'no_active_rule_version' } };
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
      const decision = decideRedeem(membership, ruleInfo, dbNow, true);

      if (!decision.allowed) {
        return { redeemed: false, reason: decision.reason };
      }

      // ── Mutations ───────────────────────────────────────────────────
      const completedCycle = row.cycle_number;
      const newCycleNumber = completedCycle + 1;

      // ── Récompense : choix du client, sinon choix au comptoir ───────
      const contract = parseStoredContract(row.pinned_rules, row.legacy_reward_title ?? null);
      const claimResult = await client.query<ClaimRow>(
        `select id, reward_key, reward_title, status from taply.reward_claims
          where membership_id = $1 and merchant_id = $2 and cycle_number = $3
          for update`,
        [params.membershipId, principal.merchantId, completedCycle],
      );
      let claim = claimResult.rows[0];
      if (claim !== undefined && claim.status !== 'awaiting_handover') {
        // Cycle déjà soldé : l'état et le ledger auraient dû le refléter.
        return { redeemed: false, reason: { kind: 'invalid_state' } };
      }
      let reward: { key: string; title: string } | undefined;
      if (claim !== undefined) {
        if (params.rewardKey !== undefined && params.rewardKey !== claim.reward_key) {
          return { redeemed: false, reason: { kind: 'reward_choice_mismatch',
            chosen: { key: claim.reward_key, title: claim.reward_title } } };
        }
        reward = { key: claim.reward_key, title: claim.reward_title };
      } else if (contract !== null && contract.rewards.length > 0) {
        const options = contract.rewards.map((r) => ({ key: r.key, title: r.title }));
        const key = params.rewardKey ?? (options.length === 1 ? options[0]?.key : undefined);
        if (key === undefined) {
          return { redeemed: false, reason: { kind: 'reward_choice_required', options } };
        }
        const option = options.find((o) => o.key === key);
        if (option === undefined) return { redeemed: false, reason: { kind: 'reward_unknown' } };
        const createdClaim = await client.query<ClaimRow>(
          `insert into taply.reward_claims
             (membership_id, merchant_id, cycle_number, reward_key, reward_title, chosen_by)
           values ($1, $2, $3, $4, $5, 'staff')
           returning id, reward_key, reward_title, status`,
          [params.membershipId, principal.merchantId, completedCycle, option.key, option.title],
        );
        claim = createdClaim.rows[0];
        if (claim === undefined) throw new Error('reward claim insert failed');
        reward = option;
      }

      // Horodatage serveur (now()) ; une seule remise par cycle (contrainte unique).
      const inserted = await client.query(
        `insert into taply.redemption_ledger
           (membership_id, merchant_id, cycle_number, performed_by, reward_key, reward_title, claim_id)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [params.membershipId, principal.merchantId, completedCycle, principal.merchantUserId,
          reward?.key ?? null, reward?.title ?? null, claim?.id ?? null],
      );
      if (inserted.rowCount !== 1) throw new Error('redemption ledger insert failed');

      if (claim !== undefined) {
        const handed = await client.query(
          `update taply.reward_claims
              set status = 'handed_over', handed_over_at = now(), handed_over_by = $3
            where id = $1 and merchant_id = $2 and status = 'awaiting_handover'`,
          [claim.id, principal.merchantId, principal.merchantUserId],
        );
        if (handed.rowCount !== 1) throw new Error('reward claim handover failed');
      }

      // UPDATE membership_states — reset cycle, SANS toucher last_credited_at
      const updatedState = await client.query(
        `update taply.membership_states
         set visit_count = 0,
             reward_pending = false,
             cycle_number = $1,
             updated_at = now()
         where membership_id = $2
           and merchant_id = $3`,
        [newCycleNumber, params.membershipId, principal.merchantId],
      );
      if (updatedState.rowCount !== 1) throw new Error('loyalty state update failed');

      // UPDATE memberships — rollover vers version active
      const updatedMembership = await client.query(
        `update taply.memberships
         set current_rule_version_id = $1,
             updated_at = now()
         where id = $2
           and merchant_id = $3`,
        [row.active_rule_version_id, params.membershipId, principal.merchantId],
      );
      if (updatedMembership.rowCount !== 1) throw new Error('membership rule version update failed');

      return {
        redeemed: true,
        completedCycle,
        newCycleNumber,
        nextThreshold: activeRules.threshold,
        redeemedAt: dbNow,
        ...(reward === undefined ? {} : { reward }),
      };
    },
  );
}
