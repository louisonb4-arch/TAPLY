/**
 * Types et constantes du moteur de fidélité Taply V1.
 *
 * Récompense unique, seuil entier 3–10, cooldown 2 h entre crédits,
 * changement de règle possible seulement après 30 jours.
 * Toutes les décisions sont pures et immuables — aucun effet de bord.
 */

// ── Constantes ──────────────────────────────────────────────────────

export const MIN_THRESHOLD = 3;
export const MAX_THRESHOLD = 10;

/** Cooldown strict entre deux crédits de visite (ms). */
export const VISIT_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 h

/** Délai minimum entre deux changements de règles (ms). */
export const RULE_CHANGE_DELAY_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

/** Tolérance max pour horloge future (0 — aucune tolérance). */
export const MAX_FUTURE_DRIFT_MS = 0;

// ── Types métier ────────────────────────────────────────────────────

export interface ProgramRules {
  /** Nombre de visites pour débloquer la récompense (3–10). */
  readonly threshold: number;
}

export interface MembershipState {
  /** Nombre de visites créditées dans le cycle en cours. */
  readonly visitCount: number;
  /** ISO timestamp de la dernière visite créditée (null si aucune). */
  readonly lastVisitAt: string | null;
  /** true si la récompense est disponible mais non encore remise. */
  readonly rewardPending: boolean;
}

export interface RuleVersionInfo {
  /** Seuil épinglé pour le cycle en cours. */
  readonly pinnedRules: ProgramRules;
  /** ISO timestamp de création de la version de règle active. */
  readonly activeRuleCreatedAt: string;
}

// ── Raisons de refus (union discriminée) ────────────────────────────

export type VisitDenialReason =
  | { readonly kind: 'cooldown_active'; readonly retryAfter: string }
  | { readonly kind: 'reward_pending' }
  | { readonly kind: 'future_timestamp' }
  | { readonly kind: 'invalid_timestamp' }
  | { readonly kind: 'invalid_state' }
  | { readonly kind: 'membership_inactive' };

export type RuleChangeDenialReason =
  | { readonly kind: 'threshold_out_of_range'; readonly min: number; readonly max: number }
  | { readonly kind: 'change_too_soon'; readonly allowedAfter: string }
  | { readonly kind: 'invalid_timestamp' };

export type RedeemDenialReason =
  | { readonly kind: 'no_reward_pending' }
  | { readonly kind: 'invalid_timestamp' }
  | { readonly kind: 'invalid_state' }
  | { readonly kind: 'membership_inactive' };

// ── Résultats de décision ───────────────────────────────────────────

export type VisitDecision =
  | { readonly allowed: true; readonly newVisitCount: number; readonly rewardUnlocked: boolean }
  | { readonly allowed: false; readonly reason: VisitDenialReason };

export type RuleChangeDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: RuleChangeDenialReason };

export type RedeemDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: RedeemDenialReason };
