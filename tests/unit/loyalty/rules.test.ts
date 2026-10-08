/**
 * Tests unitaires du moteur de règles fidélité Taply V1.
 *
 * Couverture : frontières seuil (3, 10), cooldown 2 h exact,
 * délai 30 jours exact, progression 9→10, cadeau bloqué,
 * remise + nouveau cycle, timestamps futurs, membership inactive.
 */

import { describe, expect, it } from 'vitest';
import {
  decideRedeem,
  decideRuleChange,
  decideVisitCredit,
  isTimestampValid,
  isValidThreshold,
  stateAfterRedeem,
  stateAfterVisit,
} from '../../../backend/loyalty/rules.js';
import type { MembershipState, RuleVersionInfo } from '../../../backend/loyalty/types.js';
import { VISIT_COOLDOWN_MS, RULE_CHANGE_DELAY_MS } from '../../../backend/loyalty/types.js';

// ── Helpers ─────────────────────────────────────────────────────────

const T0 = '2026-06-01T12:00:00.000Z';
const T0_MS = Date.parse(T0);

function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function freshMembership(overrides: Partial<MembershipState> = {}): MembershipState {
  return { visitCount: 0, lastVisitAt: null, rewardPending: false, ...overrides };
}

function ruleInfo(threshold: number, createdAt: string = T0): RuleVersionInfo {
  return { pinnedRules: { threshold }, activeRuleCreatedAt: createdAt };
}

// ── isValidThreshold ────────────────────────────────────────────────

describe('isValidThreshold', () => {
  it('accepte 3 (borne basse)', () => expect(isValidThreshold(3)).toBe(true));
  it('accepte 10 (borne haute)', () => expect(isValidThreshold(10)).toBe(true));
  it('accepte 7 (milieu)', () => expect(isValidThreshold(7)).toBe(true));
  it('refuse 2 (sous borne)', () => expect(isValidThreshold(2)).toBe(false));
  it('refuse 11 (sur borne)', () => expect(isValidThreshold(11)).toBe(false));
  it('refuse 0', () => expect(isValidThreshold(0)).toBe(false));
  it('refuse négatif', () => expect(isValidThreshold(-1)).toBe(false));
  it('refuse décimal', () => expect(isValidThreshold(3.5)).toBe(false));
  it('refuse NaN', () => expect(isValidThreshold(NaN)).toBe(false));
  it('refuse Infinity', () => expect(isValidThreshold(Infinity)).toBe(false));
});

// ── isTimestampValid ────────────────────────────────────────────────

describe('isTimestampValid', () => {
  it('accepte un timestamp passé', () => {
    expect(isTimestampValid('2026-06-01T11:00:00.000Z', T0)).toBe(true);
  });
  it('accepte un timestamp égal à now', () => {
    expect(isTimestampValid(T0, T0)).toBe(true);
  });
  it('refuse un timestamp futur (même +1 ms)', () => {
    expect(isTimestampValid(addMs(T0, 1), T0)).toBe(false);
  });
  it('refuse un ISO invalide', () => {
    expect(isTimestampValid('pas-une-date', T0)).toBe(false);
  });
});

// ── decideVisitCredit ───────────────────────────────────────────────

describe('decideVisitCredit', () => {
  const rule3 = ruleInfo(3);
  const rule10 = ruleInfo(10);

  it('1er crédit autorisé (seuil 3)', () => {
    const d = decideVisitCredit(freshMembership(), rule3, T0, T0, true);
    expect(d).toEqual({ allowed: true, newVisitCount: 1, rewardUnlocked: false });
  });

  it('atteint seuil 3 → récompense débloquée', () => {
    const m = freshMembership({ visitCount: 2, lastVisitAt: addMs(T0, -VISIT_COOLDOWN_MS) });
    const d = decideVisitCredit(m, rule3, T0, T0, true);
    expect(d).toEqual({ allowed: true, newVisitCount: 3, rewardUnlocked: true });
  });

  it('progression 9→10 avec seuil 10 → récompense débloquée', () => {
    const m = freshMembership({ visitCount: 9, lastVisitAt: addMs(T0, -VISIT_COOLDOWN_MS) });
    const d = decideVisitCredit(m, rule10, T0, T0, true);
    expect(d).toEqual({ allowed: true, newVisitCount: 10, rewardUnlocked: true });
  });

  it('refuse si membership inactive', () => {
    const d = decideVisitCredit(freshMembership(), rule3, T0, T0, false);
    expect(d).toEqual({ allowed: false, reason: { kind: 'membership_inactive' } });
  });

  it('refuse si timestamp futur', () => {
    const d = decideVisitCredit(freshMembership(), rule3, addMs(T0, 1000), T0, true);
    expect(d).toEqual({ allowed: false, reason: { kind: 'future_timestamp' } });
  });

  it('refuse si récompense déjà disponible', () => {
    const m = freshMembership({ visitCount: 3, rewardPending: true, lastVisitAt: T0 });
    const d = decideVisitCredit(m, rule3, addMs(T0, VISIT_COOLDOWN_MS), addMs(T0, VISIT_COOLDOWN_MS), true);
    expect(d).toEqual({ allowed: false, reason: { kind: 'reward_pending' } });
  });

  // ── Cooldown 2 h ──

  it('refuse à cooldown - 1 ms (1 ms trop tôt)', () => {
    const lastVisit = T0;
    const eventAt = addMs(T0, VISIT_COOLDOWN_MS - 1);
    const d = decideVisitCredit(
      freshMembership({ visitCount: 1, lastVisitAt: lastVisit }),
      rule3,
      eventAt,
      eventAt,
      true,
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason.kind).toBe('cooldown_active');
  });

  it('accepte à exactement 2 h de cooldown', () => {
    const lastVisit = T0;
    const eventAt = addMs(T0, VISIT_COOLDOWN_MS);
    const d = decideVisitCredit(
      freshMembership({ visitCount: 1, lastVisitAt: lastVisit }),
      rule3,
      eventAt,
      eventAt,
      true,
    );
    expect(d.allowed).toBe(true);
  });

  it('refus ne modifie pas la dernière visite (vérification implicite par état)', () => {
    const m = freshMembership({ visitCount: 1, lastVisitAt: T0 });
    const tooSoon = addMs(T0, VISIT_COOLDOWN_MS - 1);
    const d = decideVisitCredit(m, rule3, tooSoon, tooSoon, true);
    expect(d.allowed).toBe(false);
    // L'état membership reste inchangé (pas de mutation)
    expect(m.lastVisitAt).toBe(T0);
  });

  it('utilise le seuil épinglé, pas un hypothétique seuil global', () => {
    // Seuil épinglé = 5, même si on pourrait imaginer un seuil global différent
    const pinnedRule = ruleInfo(5);
    const m = freshMembership({ visitCount: 4, lastVisitAt: addMs(T0, -VISIT_COOLDOWN_MS) });
    const d = decideVisitCredit(m, pinnedRule, T0, T0, true);
    expect(d).toEqual({ allowed: true, newVisitCount: 5, rewardUnlocked: true });
  });
});

// ── decideRuleChange ────────────────────────────────────────────────

describe('decideRuleChange', () => {
  it('refuse seuil 2 (sous minimum)', () => {
    const d = decideRuleChange({ threshold: 2 }, T0, addMs(T0, RULE_CHANGE_DELAY_MS));
    expect(d).toEqual({
      allowed: false,
      reason: { kind: 'threshold_out_of_range', min: 3, max: 10 },
    });
  });

  it('refuse seuil 11 (sur maximum)', () => {
    const d = decideRuleChange({ threshold: 11 }, T0, addMs(T0, RULE_CHANGE_DELAY_MS));
    expect(d).toEqual({
      allowed: false,
      reason: { kind: 'threshold_out_of_range', min: 3, max: 10 },
    });
  });

  it('refuse seuil décimal', () => {
    const d = decideRuleChange({ threshold: 5.5 }, T0, addMs(T0, RULE_CHANGE_DELAY_MS));
    expect(d.allowed).toBe(false);
  });

  it('refuse si 30 jours pas encore écoulés (- 1 ms)', () => {
    const now = addMs(T0, RULE_CHANGE_DELAY_MS - 1);
    const d = decideRuleChange({ threshold: 5 }, T0, now);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason.kind).toBe('change_too_soon');
  });

  it('accepte à exactement 30 jours', () => {
    const now = addMs(T0, RULE_CHANGE_DELAY_MS);
    const d = decideRuleChange({ threshold: 5 }, T0, now);
    expect(d).toEqual({ allowed: true });
  });

  it('accepte seuil 3 (borne basse) après délai', () => {
    const now = addMs(T0, RULE_CHANGE_DELAY_MS);
    const d = decideRuleChange({ threshold: 3 }, T0, now);
    expect(d).toEqual({ allowed: true });
  });

  it('accepte seuil 10 (borne haute) après délai', () => {
    const now = addMs(T0, RULE_CHANGE_DELAY_MS);
    const d = decideRuleChange({ threshold: 10 }, T0, now);
    expect(d).toEqual({ allowed: true });
  });
});

// ── decideRedeem ────────────────────────────────────────────────────

describe('decideRedeem', () => {
  it('autorise si reward pending + membership active', () => {
    const m = freshMembership({ visitCount: 5, rewardPending: true, lastVisitAt: T0 });
    expect(decideRedeem(m, ruleInfo(5), T0, true)).toEqual({ allowed: true });
  });

  it('refuse si pas de reward pending', () => {
    const m = freshMembership({ visitCount: 2 });
    expect(decideRedeem(m, ruleInfo(5), T0, true)).toEqual({ allowed: false, reason: { kind: 'no_reward_pending' } });
  });

  it('refuse si membership inactive', () => {
    const m = freshMembership({ visitCount: 5, rewardPending: true });
    expect(decideRedeem(m, ruleInfo(5), T0, false)).toEqual({ allowed: false, reason: { kind: 'membership_inactive' } });
  });
});

// ── stateAfterRedeem ────────────────────────────────────────────────

describe('stateAfterRedeem', () => {
  it('remet visitCount à 0, conserve lastVisitAt, rewardPending false', () => {
    const m = freshMembership({ visitCount: 5, rewardPending: true, lastVisitAt: T0 });
    const after = stateAfterRedeem(m);
    expect(after).toEqual({ visitCount: 0, lastVisitAt: T0, rewardPending: false });
  });

  it('cooldown global conservé après remise (lastVisitAt intact)', () => {
    const lastVisit = '2026-06-01T14:00:00.000Z';
    const m = freshMembership({ visitCount: 3, rewardPending: true, lastVisitAt: lastVisit });
    const after = stateAfterRedeem(m);
    expect(after.lastVisitAt).toBe(lastVisit);
  });
});

// ── stateAfterVisit ─────────────────────────────────────────────────

describe('stateAfterVisit', () => {
  it('met à jour visitCount et lastVisitAt', () => {
    const eventAt = '2026-06-01T15:00:00.000Z';
    const after = stateAfterVisit({ allowed: true, newVisitCount: 2, rewardUnlocked: false }, eventAt);
    expect(after).toEqual({ visitCount: 2, lastVisitAt: eventAt, rewardPending: false });
  });

  it('marque rewardPending true quand rewardUnlocked', () => {
    const eventAt = '2026-06-01T15:00:00.000Z';
    const after = stateAfterVisit({ allowed: true, newVisitCount: 3, rewardUnlocked: true }, eventAt);
    expect(after.rewardPending).toBe(true);
  });
});

// ── Cycle complet ───────────────────────────────────────────────────

describe('cycle complet (seuil 3)', () => {
  const rule = ruleInfo(3);

  it('3 visites → cadeau → remise → nouveau cycle à 0', () => {
    let m = freshMembership();
    let now = T0;

    // Visite 1
    let d = decideVisitCredit(m, rule, now, now, true);
    expect(d.allowed).toBe(true);
    if (d.allowed) m = stateAfterVisit(d, now);

    // Visite 2
    now = addMs(now, VISIT_COOLDOWN_MS);
    d = decideVisitCredit(m, rule, now, now, true);
    expect(d.allowed).toBe(true);
    if (d.allowed) m = stateAfterVisit(d, now);

    // Visite 3 → récompense
    now = addMs(now, VISIT_COOLDOWN_MS);
    d = decideVisitCredit(m, rule, now, now, true);
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.rewardUnlocked).toBe(true);
      m = stateAfterVisit(d, now);
    }

    // Tentative visite 4 → bloquée (reward pending)
    const now4 = addMs(now, VISIT_COOLDOWN_MS);
    const d4 = decideVisitCredit(m, rule, now4, now4, true);
    expect(d4.allowed).toBe(false);
    if (!d4.allowed) expect(d4.reason.kind).toBe('reward_pending');

    // Remise
    const r = decideRedeem(m, rule, now, true);
    expect(r.allowed).toBe(true);
    m = stateAfterRedeem(m);
    expect(m.visitCount).toBe(0);
    expect(m.rewardPending).toBe(false);

    // Cooldown conservé après remise : visite trop tôt = refus
    const tooSoon = addMs(now, VISIT_COOLDOWN_MS - 1);
    const d5 = decideVisitCredit(m, rule, tooSoon, tooSoon, true);
    expect(d5.allowed).toBe(false);

    // Visite OK après cooldown
    const okTime = addMs(now, VISIT_COOLDOWN_MS);
    const d6 = decideVisitCredit(m, rule, okTime, okTime, true);
    expect(d6.allowed).toBe(true);
    if (d6.allowed) expect(d6.newVisitCount).toBe(1);
  });
});

// ── Revue de sécurité : refus sur données incohérentes ─────────────

describe('refus fail-closed sur données invalides', () => {
  it('refuse un événement horodaté invalide', () => {
    const d = decideVisitCredit(freshMembership(), ruleInfo(3), 'invalid-date', T0, true);
    expect(d).toEqual({ allowed: false, reason: { kind: 'invalid_timestamp' } });
  });

  it('refuse une horloge serveur invalide', () => {
    const d = decideVisitCredit(freshMembership(), ruleInfo(3), T0, 'invalid-date', true);
    expect(d).toEqual({ allowed: false, reason: { kind: 'invalid_timestamp' } });
  });

  it('refuse un seuil épinglé corrompu', () => {
    const d = decideVisitCredit(freshMembership(), ruleInfo(11), T0, T0, true);
    expect(d).toEqual({ allowed: false, reason: { kind: 'invalid_state' } });
  });

  it.each([-1, 1.5, NaN, 4])('refuse un compteur invalide %s', (visitCount) => {
    const d = decideVisitCredit(
      freshMembership({ visitCount, lastVisitAt: T0 }), ruleInfo(3), T0, T0, true,
    );
    expect(d).toEqual({ allowed: false, reason: { kind: 'invalid_state' } });
  });

  it('refuse un compteur au seuil sans récompense débloquée', () => {
    const d = decideVisitCredit(
      freshMembership({ visitCount: 3, lastVisitAt: T0, rewardPending: false }),
      ruleInfo(3), T0, T0, true,
    );
    expect(d).toEqual({ allowed: false, reason: { kind: 'invalid_state' } });
  });

  it('refuse une récompense débloquée avant le seuil', () => {
    const d = decideVisitCredit(
      freshMembership({ visitCount: 2, lastVisitAt: T0, rewardPending: true }),
      ruleInfo(3), T0, T0, true,
    );
    expect(d).toEqual({ allowed: false, reason: { kind: 'invalid_state' } });
  });

  it('refuse un compteur positif sans dernière visite', () => {
    const d = decideVisitCredit(freshMembership({ visitCount: 1 }), ruleInfo(3), T0, T0, true);
    expect(d).toEqual({ allowed: false, reason: { kind: 'invalid_state' } });
  });

  it('refuse une dernière visite illisible', () => {
    const d = decideVisitCredit(
      freshMembership({ visitCount: 1, lastVisitAt: 'invalid-date' }),
      ruleInfo(3), T0, T0, true,
    );
    expect(d).toEqual({ allowed: false, reason: { kind: 'invalid_state' } });
  });

  it('refuse une dernière visite dans le futur', () => {
    const d = decideVisitCredit(
      freshMembership({ visitCount: 1, lastVisitAt: addMs(T0, 1) }),
      ruleInfo(3), T0, T0, true,
    );
    expect(d).toEqual({ allowed: false, reason: { kind: 'invalid_state' } });
  });

  it('refuse un horodatage de règle invalide', () => {
    const d = decideRuleChange({ threshold: 5 }, 'invalid-date', addMs(T0, RULE_CHANGE_DELAY_MS));
    expect(d).toEqual({ allowed: false, reason: { kind: 'invalid_timestamp' } });
  });

  it('refuse une horloge serveur invalide au changement de seuil', () => {
    const d = decideRuleChange({ threshold: 5 }, T0, 'invalid-date');
    expect(d).toEqual({ allowed: false, reason: { kind: 'invalid_timestamp' } });
  });
});

describe('remise antifraude : état du cycle épinglé', () => {
  const pending = freshMembership({ visitCount: 5, lastVisitAt: T0, rewardPending: true });

  it('refuse un cadeau dont le compteur ne correspond pas au seuil du cycle', () => {
    expect(decideRedeem(pending, ruleInfo(6), T0, true)).toEqual({
      allowed: false, reason: { kind: 'invalid_state' },
    });
  });

  it('refuse un seuil épinglé corrompu lors de la remise', () => {
    expect(decideRedeem(pending, ruleInfo(11), T0, true)).toEqual({
      allowed: false, reason: { kind: 'invalid_state' },
    });
  });

  it('refuse un cadeau disponible avec une dernière visite manquante', () => {
    const m = freshMembership({ visitCount: 5, rewardPending: true });
    expect(decideRedeem(m, ruleInfo(5), T0, true)).toEqual({
      allowed: false, reason: { kind: 'invalid_state' },
    });
  });

  it('refuse une remise avec une horloge serveur invalide', () => {
    expect(decideRedeem(pending, ruleInfo(5), 'bad-date', true)).toEqual({
      allowed: false, reason: { kind: 'invalid_timestamp' },
    });
  });

  it('refuse une dernière visite illisible ou future', () => {
    for (const lastVisitAt of ['bad-date', addMs(T0, 1)]) {
      const m = freshMembership({ visitCount: 5, lastVisitAt, rewardPending: true });
      expect(decideRedeem(m, ruleInfo(5), T0, true)).toEqual({
        allowed: false, reason: { kind: 'invalid_state' },
      });
    }
  });
});
