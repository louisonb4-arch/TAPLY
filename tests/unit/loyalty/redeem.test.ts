/**
 * Tests unitaires de redeemReward — client PG mock.
 *
 * Vérifient l'ordre SQL, le verrouillage (FOR UPDATE OF s, m),
 * l'idempotence, les refus métier, le rollover de version et
 * la conservation du cooldown global (last_credited_at).
 * Ne certifient PAS la RLS — seuls des tests PostgreSQL réels le font.
 */

import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { AuthenticatedPrincipal } from '../../../backend/auth/session.js';
import type { RedeemRewardResult } from '../../../backend/loyalty/redeem.js';
import { redeemReward } from '../../../backend/loyalty/redeem.js';

// ── Helpers ─────────────────────────────────────────────────────────

const DB_NOW = '2026-10-08T12:00:00.000Z';
const MEMBER_UUID = '00000000-0000-4000-8000-000000000001';
const REQUEST_UUID = '00000000-0000-4000-8000-000000000002';
const ACTIVE_RULE_ID = '00000000-0000-4000-8000-000000000099';
const LAST_VISIT = '2026-10-08T09:00:00.000Z';

function makePrincipal(overrides?: Partial<AuthenticatedPrincipal>): AuthenticatedPrincipal {
  return {
    sessionId: 'sess-1',
    merchantId: 'merchant-1',
    merchantUserId: 'mu-1',
    authUserId: 'auth-1',
    role: 'staff',
    ...overrides,
  };
}

interface StateRowOverrides {
  visit_count?: number;
  reward_pending?: boolean;
  last_credited_at?: Date | string | null;
  cycle_number?: number;
  membership_status?: string;
  program_status?: string;
  merchant_status?: string;
  pinned_rules?: unknown;
  pinned_rule_created_at?: Date | string;
  db_now?: Date | string;
  active_rule_version_id?: string | null;
  active_rules?: unknown | null;
}

function makeStateRow(overrides?: StateRowOverrides) {
  return {
    visit_count: 5,
    reward_pending: true,
    last_credited_at: LAST_VISIT,
    cycle_number: 1,
    membership_status: 'active',
    program_status: 'active',
    merchant_status: 'active',
    pinned_rules: { threshold: 5 },
    pinned_rule_created_at: '2026-09-01T00:00:00.000Z',
    db_now: DB_NOW,
    active_rule_version_id: ACTIVE_RULE_ID,
    active_rules: { threshold: 5 },
    ...overrides,
  };
}

interface IdempotencyStore {
  id: string;
  merchant_id: string;
  operation: string;
  idempotency_key: string;
  request_fingerprint: string;
  status: string;
  response: unknown;
}

function fakeClient(
  stateRow: ReturnType<typeof makeStateRow> | null,
  opts?: {
    idemStore?: Map<string, IdempotencyStore>;
    insertRedemptionRowCount?: number;
    updateStateRowCount?: number;
    updateMembershipRowCount?: number;
  },
) {
  const queries: Array<{ text: string; values: readonly unknown[] }> = [];
  const idemStore = opts?.idemStore ?? new Map<string, IdempotencyStore>();
  let nextIdemId = 1;

  const client = {
    queries,
    query: async (text: string, values: readonly unknown[] = []) => {
      queries.push({ text: text.trim(), values: [...values] });

      // ── runIdempotent: INSERT claim ──────────────────────────────
      if (text.includes('insert into taply.idempotency_requests')) {
        const [merchantId, operation, idempotencyKey, fingerprint] = values as [string, string, string, string];
        const key = `${merchantId}:${operation}:${idempotencyKey}`;
        if (idemStore.has(key)) return { rows: [] };
        const row: IdempotencyStore = {
          id: String(nextIdemId++),
          merchant_id: merchantId,
          operation,
          idempotency_key: idempotencyKey,
          request_fingerprint: fingerprint,
          status: 'pending',
          response: null,
        };
        idemStore.set(key, row);
        return { rows: [{ id: row.id }] };
      }

      // ── runIdempotent: UPDATE finalize ──────────────────────────
      if (text.includes('update taply.idempotency_requests')) {
        const [id, response] = values as [string, string];
        for (const row of idemStore.values()) {
          if (row.id === id) {
            row.status = 'completed';
            row.response = JSON.parse(response);
          }
        }
        return { rows: [] };
      }

      // ── runIdempotent: SELECT replay ────────────────────────────
      if (text.includes('select request_fingerprint, response') && text.includes('idempotency_requests')) {
        const [merchantId, operation, idempotencyKey] = values as [string, string, string];
        const key = `${merchantId}:${operation}:${idempotencyKey}`;
        const row = idemStore.get(key);
        return {
          rows: row === undefined ? [] : [{ request_fingerprint: row.request_fingerprint, response: row.response }],
        };
      }

      // ── Choix de récompense du cycle (aucun dans ces scénarios) ─
      if (text.includes('from taply.reward_claims')) {
        return { rows: [] };
      }

      // ── STATE_QUERY (SELECT ... FOR UPDATE OF s, m) ─────────────
      if (text.includes('membership_states') && text.includes('for update of s')) {
        return { rows: stateRow === null ? [] : [stateRow] };
      }

      // ── INSERT redemption_ledger ────────────────────────────────
      if (text.includes('insert into taply.redemption_ledger')) {
        return { rows: [], rowCount: opts?.insertRedemptionRowCount ?? 1 };
      }

      // ── UPDATE membership_states ────────────────────────────────
      if (text.includes('update taply.membership_states')) {
        return { rows: [], rowCount: opts?.updateStateRowCount ?? 1 };
      }

      // ── UPDATE memberships ──────────────────────────────────────
      if (text.includes('update taply.memberships')) {
        return { rows: [], rowCount: opts?.updateMembershipRowCount ?? 1 };
      }

      throw new Error(`Requête SQL inattendue dans le faux client : ${text}`);
    },
  };
  return client as unknown as PoolClient & { queries: typeof queries };
}

const baseParams = { membershipId: MEMBER_UUID, idempotencyKey: REQUEST_UUID, expectedCycleNumber: 1 };

// ── Tests ───────────────────────────────────────────────────────────

describe('redeemReward', () => {
  // ── Cas nominal : cadeau disponible, remise réussie ─────────────
  it('remet le cadeau et retourne le nouveau cycle', async () => {
    const client = fakeClient(makeStateRow());
    const result = await redeemReward(client, makePrincipal(), baseParams);

    expect(result).toEqual({
      redeemed: true,
      completedCycle: 1,
      newCycleNumber: 2,
      nextThreshold: 5,
      redeemedAt: DB_NOW,
    });
  });

  // ── Ordre SQL : SELECT FOR UPDATE avant toutes mutations ────────
  it('émet SELECT FOR UPDATE OF s, m avant INSERT et UPDATEs', async () => {
    const client = fakeClient(makeStateRow());
    const result = await redeemReward(client, makePrincipal(), baseParams);
    expect((result as { redeemed: boolean }).redeemed).toBe(true);

    const sqlTexts = client.queries.map((q) => q.text);
    const selectIdx = sqlTexts.findIndex((t) => t.includes('for update of s'));
    const insertIdx = sqlTexts.findIndex((t) => t.includes('insert into taply.redemption_ledger'));
    const updateStateIdx = sqlTexts.findIndex((t) => t.includes('update taply.membership_states'));
    const updateMembershipIdx = sqlTexts.findIndex((t) => t.includes('update taply.memberships'));

    expect(selectIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(selectIdx);
    expect(updateStateIdx).toBeGreaterThan(insertIdx);
    expect(updateMembershipIdx).toBeGreaterThan(updateStateIdx);
  });

  // ── 2e remise refusée (rewardPending=false après 1re remise) ────
  it('refuse une 2e remise sur le même cycle (no_reward_pending)', async () => {
    const client = fakeClient(makeStateRow({ visit_count: 0, reward_pending: false }));
    const result = await redeemReward(client, makePrincipal(), baseParams);

    expect(result).toMatchObject({ redeemed: false, reason: { kind: 'no_reward_pending' } });
  });

  // ── Rollover avec changement de seuil ───────────────────────────
  it('rollover vers un nouveau seuil quand la version active change', async () => {
    const client = fakeClient(makeStateRow({
      pinned_rules: { threshold: 5 },
      active_rules: { threshold: 8 },
    }));
    const result = await redeemReward(client, makePrincipal(), baseParams);

    expect(result).toMatchObject({
      redeemed: true,
      completedCycle: 1,
      newCycleNumber: 2,
      nextThreshold: 8,
    });
  });

  // ── Cooldown global conservé (last_credited_at non touché) ──────
  it('ne modifie pas last_credited_at dans UPDATE membership_states', async () => {
    const client = fakeClient(makeStateRow());
    await redeemReward(client, makePrincipal(), baseParams);

    const updateQuery = client.queries.find((q) => q.text.includes('update taply.membership_states'));
    expect(updateQuery).toBeDefined();
    expect(updateQuery!.text).not.toMatch(/last_credited_at/);
  });

  // ── Statut inactif ──────────────────────────────────────────────
  it('refuse si membership inactive', async () => {
    const client = fakeClient(makeStateRow({ membership_status: 'inactive' }));
    const result = await redeemReward(client, makePrincipal(), baseParams);

    expect(result).toMatchObject({ redeemed: false, reason: { kind: 'membership_inactive' } });
  });

  it('refuse si merchant non actif', async () => {
    const client = fakeClient(makeStateRow({ merchant_status: 'suspended' }));
    const result = await redeemReward(client, makePrincipal(), baseParams);

    expect(result).toMatchObject({ redeemed: false, reason: { kind: 'merchant_not_active' } });
  });

  it('refuse si programme inactif', async () => {
    const client = fakeClient(makeStateRow({ program_status: 'paused' }));
    const result = await redeemReward(client, makePrincipal(), baseParams);

    expect(result).toMatchObject({ redeemed: false, reason: { kind: 'program_inactive' } });
  });

  // ── Mauvaise membership / tenant ────────────────────────────────
  it('refuse si membership absente (mauvais merchant ou inexistante)', async () => {
    const client = fakeClient(null);
    const result = await redeemReward(client, makePrincipal(), baseParams);

    expect(result).toMatchObject({ redeemed: false, reason: { kind: 'membership_not_found' } });
  });

  // ── Manque version active ───────────────────────────────────────
  it('refuse si aucune version active pour le prochain cycle', async () => {
    const client = fakeClient(makeStateRow({ active_rule_version_id: null, active_rules: null }));
    const result = await redeemReward(client, makePrincipal(), baseParams);

    expect(result).toMatchObject({ redeemed: false, reason: { kind: 'no_active_rule_version' } });
  });

  it('refuse si la version active a des rules invalides', async () => {
    const client = fakeClient(makeStateRow({ active_rules: { threshold: 99 } }));
    const result = await redeemReward(client, makePrincipal(), baseParams);

    expect(result).toMatchObject({ redeemed: false, reason: { kind: 'no_active_rule_version' } });
  });

  // ── Mauvais cycle (expectedCycleNumber mismatch) ────────────────
  it('refuse si expectedCycleNumber ne correspond pas au cycle actuel', async () => {
    const client = fakeClient(makeStateRow({ cycle_number: 3 }));
    const result = await redeemReward(client, makePrincipal(), {
      ...baseParams,
      expectedCycleNumber: 1,
    });

    expect(result).toMatchObject({ redeemed: false, reason: { kind: 'cycle_mismatch', currentCycle: 3 } });
  });

  // ── Input invalide (Zod) ────────────────────────────────────────
  it('refuse un membershipId non UUID', async () => {
    const client = fakeClient(makeStateRow());
    const result = await redeemReward(client, makePrincipal(), {
      ...baseParams,
      membershipId: 'bad-id',
    });
    expect(result).toEqual({ redeemed: false, reason: { kind: 'invalid_request' } });
    expect(client.queries).toHaveLength(0);
  });

  it('refuse un idempotencyKey non UUID', async () => {
    const client = fakeClient(makeStateRow());
    const result = await redeemReward(client, makePrincipal(), {
      ...baseParams,
      idempotencyKey: 'not-uuid',
    });
    expect(result).toEqual({ redeemed: false, reason: { kind: 'invalid_request' } });
    expect(client.queries).toHaveLength(0);
  });

  it('refuse un expectedCycleNumber non entier positif', async () => {
    for (const bad of [0, -1, 1.5]) {
      const client = fakeClient(makeStateRow());
      const result = await redeemReward(client, makePrincipal(), {
        ...baseParams,
        expectedCycleNumber: bad,
      });
      expect(result).toEqual({ redeemed: false, reason: { kind: 'invalid_request' } });
      expect(client.queries).toHaveLength(0);
    }
  });

  // ── Rôle non autorisé ───────────────────────────────────────────
  it('refuse si rôle non owner/staff', async () => {
    const client = fakeClient(makeStateRow());
    const result = await redeemReward(client, makePrincipal({ role: 'viewer' as never }), baseParams);

    expect(result).toEqual({ redeemed: false, reason: { kind: 'unauthorized_role' } });
    expect(client.queries).toHaveLength(0);
  });

  // ── Owner autorisé ──────────────────────────────────────────────
  it('accepte rôle owner', async () => {
    const client = fakeClient(makeStateRow());
    const result = await redeemReward(client, makePrincipal({ role: 'owner' }), baseParams);

    expect((result as { redeemed: boolean }).redeemed).toBe(true);
  });

  // ── Replay idempotent ───────────────────────────────────────────
  it('replay idempotent : même clé+fingerprint retourne même résultat sans re-exécuter', async () => {
    const idemStore = new Map<string, IdempotencyStore>();
    const client1 = fakeClient(makeStateRow(), { idemStore });
    const first = await redeemReward(client1, makePrincipal(), baseParams);
    expect((first as { redeemed: boolean }).redeemed).toBe(true);

    const client2 = fakeClient(makeStateRow(), { idemStore });
    const second = await redeemReward(client2, makePrincipal(), baseParams);

    expect(second).toEqual(first);

    const secondMutations = client2.queries.filter(
      (q) =>
        q.text.includes('insert into taply.redemption_ledger') ||
        q.text.includes('update taply.membership_states') ||
        q.text.includes('update taply.memberships'),
    );
    expect(secondMutations).toHaveLength(0);
  });

  // ── Verrou FOR UPDATE OF s, m ───────────────────────────────────
  it('verrouille membership_states ET memberships en FOR UPDATE', async () => {
    const client = fakeClient(makeStateRow());
    await redeemReward(client, makePrincipal(), baseParams);

    const lockQuery = client.queries.find((q) => q.text.includes('for update of s'));
    expect(lockQuery).toBeDefined();
    expect(lockQuery!.text).toMatch(/for update of s,\s*m/);
  });

  // ── Pas de mutation sur refus ───────────────────────────────────
  it('aucune mutation SQL en cas de refus no_reward_pending', async () => {
    const client = fakeClient(makeStateRow({ visit_count: 0, reward_pending: false }));
    await redeemReward(client, makePrincipal(), baseParams);

    const mutations = client.queries.filter(
      (q) =>
        q.text.includes('insert into taply.redemption_ledger') ||
        q.text.includes('update taply.membership_states') ||
        q.text.includes('update taply.memberships'),
    );
    expect(mutations).toHaveLength(0);
  });
});

describe('redeemReward : cohérence du nombre de lignes mutées', () => {
  it('échoue si INSERT redemption_ledger ne modifie aucune ligne', async () => {
    const client = fakeClient(makeStateRow(), { insertRedemptionRowCount: 0 });
    await expect(redeemReward(client, makePrincipal(), baseParams)).rejects.toThrow(
      'redemption ledger insert failed',
    );
  });

  it('échoue si UPDATE membership_states ne modifie aucune ligne', async () => {
    const client = fakeClient(makeStateRow(), { updateStateRowCount: 0 });
    await expect(redeemReward(client, makePrincipal(), baseParams)).rejects.toThrow(
      'loyalty state update failed',
    );
  });

  it('échoue si UPDATE memberships ne modifie aucune ligne', async () => {
    const client = fakeClient(makeStateRow(), { updateMembershipRowCount: 0 });
    await expect(redeemReward(client, makePrincipal(), baseParams)).rejects.toThrow(
      'membership rule version update failed',
    );
  });
});
