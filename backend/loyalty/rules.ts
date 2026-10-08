/**
 * Moteur de règles fidélité Taply V1 — fonctions de décision pures.
 *
 * Aucun effet de bord, aucune dépendance externe, aucun accès réseau.
 * Le contrôle d'idempotence (dédoublonnage transactionnel) et la
 * validation de présence (QR employé / NFC) sont des responsabilités
 * de la couche appelante — ce module ne les remplace pas.
 *
 * AVERTISSEMENT : ces vérifications ne constituent PAS une sécurité
 * suffisante sans transaction DB avec verrou et idempotency server-side.
 */

import type {
  MembershipState,
  ProgramRules,
  RedeemDecision,
  RuleChangeDenialReason,
  RuleChangeDecision,
  RuleVersionInfo,
  VisitDecision,
} from './types.js';

import {
  MAX_FUTURE_DRIFT_MS,
  MAX_THRESHOLD,
  MIN_THRESHOLD,
  RULE_CHANGE_DELAY_MS,
  VISIT_COOLDOWN_MS,
} from './types.js';

// ── Validation d'entrée ─────────────────────────────────────────────

/** Vérifie qu'un seuil est un entier dans [MIN_THRESHOLD, MAX_THRESHOLD]. */
export function isValidThreshold(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_THRESHOLD && value <= MAX_THRESHOLD;
}

/**
 * Vérifie que le timestamp n'est pas dans le futur par rapport à `now`.
 * Rejette aussi les valeurs invalides (NaN).
 */
export function isTimestampValid(eventIso: string, nowIso: string): boolean {
  const eventMs = Date.parse(eventIso);
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(eventMs) || Number.isNaN(nowMs)) return false;
  return eventMs <= nowMs + MAX_FUTURE_DRIFT_MS;
}

// ── Décision : crédit de visite ─────────────────────────────────────

/**
 * Décide si un crédit de visite est autorisé.
 *
 * Invariants :
 * - Membership active obligatoire.
 * - Timestamp futur rejeté.
 * - Cooldown 2 h strict depuis dernière visite CRÉDITÉE (refus ne modifie rien).
 * - Passage bloqué si récompense déjà disponible.
 * - Seuil épinglé du cycle en cours (pas la règle active globale).
 * - Récompense débloquée lorsque visitCount + 1 == threshold.
 */
export function decideVisitCredit(
  membership: MembershipState,
  rule: RuleVersionInfo,
  eventAt: string,
  now: string,
  membershipActive: boolean,
): VisitDecision {
  if (!membershipActive) {
    return { allowed: false, reason: { kind: 'membership_inactive' } };
  }

  // ── Validate timestamps ────────────────────────────────────────────
  const eventMs = Date.parse(eventAt);
  const nowMs = Date.parse(now);
  if (Number.isNaN(eventMs) || Number.isNaN(nowMs)) {
    return { allowed: false, reason: { kind: 'invalid_timestamp' } };
  }
  if (eventMs > nowMs + MAX_FUTURE_DRIFT_MS) {
    return { allowed: false, reason: { kind: 'future_timestamp' } };
  }

  // ── Validate pinned threshold ──────────────────────────────────────
  const threshold = rule.pinnedRules.threshold;
  if (!isValidThreshold(threshold)) {
    return { allowed: false, reason: { kind: 'invalid_state' } };
  }

  // ── Validate membership state coherence ────────────────────────────
  const { visitCount, lastVisitAt, rewardPending } = membership;

  if (!Number.isInteger(visitCount) || visitCount < 0 || visitCount > threshold) {
    return { allowed: false, reason: { kind: 'invalid_state' } };
  }
  if (rewardPending !== (visitCount === threshold)) {
    return { allowed: false, reason: { kind: 'invalid_state' } };
  }
  if (visitCount > 0 && lastVisitAt === null) {
    return { allowed: false, reason: { kind: 'invalid_state' } };
  }
  if (lastVisitAt !== null) {
    const lastMs = Date.parse(lastVisitAt);
    if (Number.isNaN(lastMs) || lastMs > nowMs + MAX_FUTURE_DRIFT_MS) {
      return { allowed: false, reason: { kind: 'invalid_state' } };
    }
  }

  // ── Business rules (existing behavior) ─────────────────────────────
  if (rewardPending) {
    return { allowed: false, reason: { kind: 'reward_pending' } };
  }

  // Cooldown strict : 2 h entre deux crédits
  if (lastVisitAt !== null) {
    const lastMs = Date.parse(lastVisitAt);
    if (eventMs - lastMs < VISIT_COOLDOWN_MS) {
      const retryAt = new Date(lastMs + VISIT_COOLDOWN_MS).toISOString();
      return { allowed: false, reason: { kind: 'cooldown_active', retryAfter: retryAt } };
    }
  }

  const newCount = visitCount + 1;
  const rewardUnlocked = newCount >= threshold;

  return { allowed: true, newVisitCount: newCount, rewardUnlocked };
}

// ── Décision : changement de règles ─────────────────────────────────

/**
 * Décide si un changement de règles est autorisé.
 *
 * Invariants :
 * - Seuil dans [3, 10], entier.
 * - 30 jours minimum depuis la création de la version active.
 */
export function decideRuleChange(
  newRules: ProgramRules,
  currentVersionCreatedAt: string,
  now: string,
): RuleChangeDecision {
  if (!isValidThreshold(newRules.threshold)) {
    const reason: RuleChangeDenialReason = {
      kind: 'threshold_out_of_range',
      min: MIN_THRESHOLD,
      max: MAX_THRESHOLD,
    };
    return { allowed: false, reason };
  }

  const createdMs = Date.parse(currentVersionCreatedAt);
  const nowMs = Date.parse(now);
  if (Number.isNaN(createdMs) || Number.isNaN(nowMs)) {
    return { allowed: false, reason: { kind: 'invalid_timestamp' } };
  }
  if (nowMs - createdMs < RULE_CHANGE_DELAY_MS) {
    const allowedAfter = new Date(createdMs + RULE_CHANGE_DELAY_MS).toISOString();
    return { allowed: false, reason: { kind: 'change_too_soon', allowedAfter } };
  }

  return { allowed: true };
}

// ── Décision : remise de récompense ─────────────────────────────────

/**
 * Décide si la remise de récompense (redeem) est autorisée.
 * Opération distincte du crédit : remet à zéro le cycle.
 *
 * Invariants :
 * - Membership active obligatoire.
 * - Récompense effectivement disponible (rewardPending = true).
 *
 * Après remise (responsabilité de l'appelant) :
 * - visitCount → 0, rewardPending → false.
 * - Le cooldown global (lastVisitAt) est CONSERVÉ.
 * - current_rule_version_id peut être mis à jour vers la version active.
 */
export function decideRedeem(
  membership: MembershipState,
  rule: RuleVersionInfo,
  now: string,
  membershipActive: boolean,
): RedeemDecision {
  if (!membershipActive) {
    return { allowed: false, reason: { kind: 'membership_inactive' } };
  }
  if (!membership.rewardPending) {
    return { allowed: false, reason: { kind: 'no_reward_pending' } };
  }
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    return { allowed: false, reason: { kind: 'invalid_timestamp' } };
  }
  const threshold = rule.pinnedRules.threshold;
  const lastVisitMs = membership.lastVisitAt === null ? NaN : Date.parse(membership.lastVisitAt);
  if (
    !isValidThreshold(threshold) ||
    !Number.isInteger(membership.visitCount) ||
    membership.visitCount !== threshold ||
    !Number.isFinite(lastVisitMs) ||
    lastVisitMs > nowMs
  ) {
    return { allowed: false, reason: { kind: 'invalid_state' } };
  }
  return { allowed: true };
}

/**
 * Produit le nouvel état membership après une remise validée.
 * Le cooldown global (lastVisitAt) est conservé.
 */
export function stateAfterRedeem(membership: MembershipState): MembershipState {
  return {
    visitCount: 0,
    lastVisitAt: membership.lastVisitAt,
    rewardPending: false,
  };
}

/**
 * Produit le nouvel état membership après un crédit de visite validé.
 */
export function stateAfterVisit(
  decision: Extract<VisitDecision, { allowed: true }>,
  eventAt: string,
): MembershipState {
  return {
    visitCount: decision.newVisitCount,
    lastVisitAt: eventAt,
    rewardPending: decision.rewardUnlocked,
  };
}
