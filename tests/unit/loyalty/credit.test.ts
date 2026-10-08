/**
 * Tests unitaires de creditVisit — client PG mock.
 *
 * Ces tests vérifient l'ordre SQL, le verrouillage (FOR UPDATE OF s),
 * l'idempotence, les refus métier et l'absence de mutations interdites.
 * Ils ne certifient PAS la RLS — seuls des tests PostgreSQL réels le font.
 */

import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { AuthenticatedPrincipal } from '../../../backend/auth/session.js';
import type { CreditVisitResult } from '../../../backend/loyalty/credit.js';
import { creditVisit } from '../../../backend/loyalty/credit.js';

// ── Helpers ─────────────────────────────────────────────────────────

const DB_NOW = '2026-10-08T12:00:00.000Z';
const MEMBER_UUID = '00000000-0000-4000-8000-000000000001';
const REQUEST_UUID = '00000000-0000-4000-8000-000000000002';
const TWO_HOURS_AGO = '2026-10-08T09:59:59.000Z';
const RECENT = '2026-10-08T11:30:00.000Z'; // < 2h ago → cooldown

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
}

function makeStateRow(overrides?: StateRowOverrides) {
  return {
    visit_count: 0,
    reward_pending: false,
    last_credited_at: null,
    cycle_number: 1,
    membership_status: 'active',
    program_status: 'active',
    merchant_status: 'active',
    pinned_rules: { threshold: 5 },
    pinned_rule_created_at: '2026-09-01T00:00:00.000Z',
    db_now: DB_NOW,
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

/**
 * Faux client PG qui simule les requêtes émises par creditVisit + runIdempotent.
 * Enregistre toutes les requêtes pour vérification d'ordre et de contenu.
 */
function fakeClient(stateRow: ReturnType<typeof makeStateRow> | null, opts?: { idemStore?: Map<string, IdempotencyStore>; updateRowCount?: number; insertRowCount?: number }) {
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

      // ── STATE_QUERY (SELECT ... FOR UPDATE OF s) ────────────────
      if (text.includes('membership_states') && text.includes('for update of s')) {
        return { rows: stateRow === null ? [] : [stateRow] };
      }

      // ── UPDATE membership_states ────────────────────────────────
      if (text.includes('update taply.membership_states')) {
        return { rows: [], rowCount: opts?.updateRowCount ?? 1 };
      }

      // ── INSERT visit_ledger ─────────────────────────────────────
      if (text.includes('insert into taply.visit_ledger')) {
        return { rows: [], rowCount: opts?.insertRowCount ?? 1 };
      }

      throw new Error(`Requête SQL inattendue dans le faux client : ${text}`);
    },
  };
  return client as unknown as PoolClient & { queries: typeof queries };
}

const baseParams = { membershipId: MEMBER_UUID, source: 'QR_EMPLOYEE' as const, idempotencyKey: REQUEST_UUID };

// ── Tests ───────────────────────────────────────────────────────────

describe('creditVisit', () => {
  // ── Cas nominal : premier passage 0→1 ─────────────────────────────
  it('crédite un premier passage (0→1) et retourne visitCount=1', async () => {
    const client = fakeClient(makeStateRow());
    const principal = makePrincipal();

    const result = await creditVisit(client, principal, baseParams);

    expect(result).toEqual({
      credited: true,
      visitCount: 1,
      rewardUnlocked: false,
      cycleNumber: 1,
      creditedAt: DB_NOW,
    });
  });

  // ── Ordre SQL : SELECT FOR UPDATE avant mutations ─────────────────
  it('émet SELECT FOR UPDATE avant UPDATE et INSERT', async () => {
    const client = fakeClient(makeStateRow());
    const result = await creditVisit(client, makePrincipal(), baseParams);
    expect((result as { credited: boolean }).credited).toBe(true);

    const sqlTexts = client.queries.map((q) => q.text);
    const selectIdx = sqlTexts.findIndex((t) => t.includes('for update of s'));
    const updateIdx = sqlTexts.findIndex((t) => t.includes('update taply.membership_states'));
    const insertIdx = sqlTexts.findIndex((t) => t.includes('insert into taply.visit_ledger'));

    expect(selectIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(selectIdx);
    expect(insertIdx).toBeGreaterThan(updateIdx);
  });

  // ── Reward unlocked au seuil ──────────────────────────────────────
  it('débloque récompense quand visitCount atteint threshold', async () => {
    const client = fakeClient(makeStateRow({ visit_count: 4, last_credited_at: TWO_HOURS_AGO }));
    const result = await creditVisit(client, makePrincipal(), baseParams);

    expect(result).toMatchObject({ credited: true, visitCount: 5, rewardUnlocked: true });
  });

  // ── Idempotence : même opération replay ───────────────────────────
  it('replay idempotent : même clé+fingerprint retourne même résultat sans re-exécuter', async () => {
    const idemStore = new Map<string, IdempotencyStore>();
    const client1 = fakeClient(makeStateRow(), { idemStore });
    const first = await creditVisit(client1, makePrincipal(), baseParams);
    expect((first as { credited: boolean }).credited).toBe(true);

    // Second appel — même client mock avec store partagé
    const client2 = fakeClient(makeStateRow(), { idemStore });
    const second = await creditVisit(client2, makePrincipal(), baseParams);

    expect(second).toEqual(first);

    // Vérifier qu'aucune mutation n'a été émise au second appel
    const secondMutations = client2.queries.filter(
      (q) => q.text.includes('update taply.membership_states') || q.text.includes('insert into taply.visit_ledger'),
    );
    expect(secondMutations).toHaveLength(0);
  });

  // ── Refus : rôle non autorisé ─────────────────────────────────────
  it('refuse si rôle non owner/staff', async () => {
    const client = fakeClient(makeStateRow());
    const principal = makePrincipal({ role: 'viewer' as never });

    const result = await creditVisit(client, principal, baseParams);

    expect(result).toEqual({ credited: false, reason: { kind: 'unauthorized_role' } });
    // Aucune requête SQL émise
    expect(client.queries).toHaveLength(0);
  });

  // ── Refus : cooldown actif ────────────────────────────────────────
  it('refuse si cooldown non expiré', async () => {
    const client = fakeClient(makeStateRow({ visit_count: 2, last_credited_at: RECENT }));
    const result = await creditVisit(client, makePrincipal(), baseParams);

    expect(result).toMatchObject({ credited: false, reason: { kind: 'cooldown_active' } });
  });

  // ── Refus : reward_pending ────────────────────────────────────────
  it('refuse si récompense déjà disponible', async () => {
    const client = fakeClient(
      makeStateRow({ visit_count: 5, reward_pending: true, last_credited_at: TWO_HOURS_AGO }),
    );
    const result = await creditVisit(client, makePrincipal(), baseParams);

    expect(result).toMatchObject({ credited: false, reason: { kind: 'reward_pending' } });
  });

  // ── Refus : membership inactive ───────────────────────────────────
  it('refuse si membership inactive', async () => {
    const client = fakeClient(makeStateRow({ membership_status: 'inactive' }));
    const result = await creditVisit(client, makePrincipal(), baseParams);

    expect(result).toMatchObject({ credited: false, reason: { kind: 'membership_inactive' } });
  });

  // ── Refus : programme inactif ─────────────────────────────────────
  it('refuse si programme inactif', async () => {
    const client = fakeClient(makeStateRow({ program_status: 'paused' }));
    const result = await creditVisit(client, makePrincipal(), baseParams);

    expect(result).toMatchObject({ credited: false, reason: { kind: 'program_inactive' } });
  });

  // ── Refus : merchant non actif ────────────────────────────────────
  it('refuse si merchant non actif', async () => {
    const client = fakeClient(makeStateRow({ merchant_status: 'suspended' }));
    const result = await creditVisit(client, makePrincipal(), baseParams);

    expect(result).toMatchObject({ credited: false, reason: { kind: 'merchant_not_active' } });
  });

  // ── Refus : membership non trouvée ────────────────────────────────
  it('refuse si membership absente (mauvais merchant ou inexistante)', async () => {
    const client = fakeClient(null);
    const result = await creditVisit(client, makePrincipal(), baseParams);

    expect(result).toMatchObject({ credited: false, reason: { kind: 'membership_not_found' } });
  });

  // ── Refus : rules JSON invalide ───────────────────────────────────
  it('refuse si pinned_rules JSON invalide', async () => {
    const client = fakeClient(makeStateRow({ pinned_rules: { threshold: 'NaN' } }));
    const result = await creditVisit(client, makePrincipal(), baseParams);

    expect(result).toMatchObject({ credited: false, reason: { kind: 'invalid_state' } });
  });

  it('refuse si pinned_rules threshold hors bornes', async () => {
    const client = fakeClient(makeStateRow({ pinned_rules: { threshold: 99 } }));
    const result = await creditVisit(client, makePrincipal(), baseParams);

    expect(result).toMatchObject({ credited: false, reason: { kind: 'invalid_state' } });
  });

  // ── Aucune injection de timestamp client ──────────────────────────
  it('utilise db_now pour la décision, jamais un timestamp client', async () => {
    const client = fakeClient(makeStateRow());
    await creditVisit(client, makePrincipal(), baseParams);

    // Vérifier qu'aucun paramètre SQL n'est un timestamp ISO string
    // provenant des params d'entrée (qui n'en contiennent pas par design)
    const updateQuery = client.queries.find((q) => q.text.includes('update taply.membership_states'));
    expect(updateQuery).toBeDefined();
    // last_credited_at = now() dans le SQL, pas un paramètre
    // Les seuls paramètres sont: visitCount (number), rewardUnlocked (boolean), membershipId, merchantId
    expect(updateQuery!.values).toHaveLength(4);
    expect(typeof updateQuery!.values[0]).toBe('number');
    expect(typeof updateQuery!.values[1]).toBe('boolean');
  });

  // ── Pas de mutation sur refus ─────────────────────────────────────
  it('aucune mutation SQL en cas de refus cooldown', async () => {
    const client = fakeClient(makeStateRow({ visit_count: 1, last_credited_at: RECENT }));
    await creditVisit(client, makePrincipal(), baseParams);

    const mutations = client.queries.filter(
      (q) => q.text.includes('update taply.membership_states') || q.text.includes('insert into taply.visit_ledger'),
    );
    expect(mutations).toHaveLength(0);
  });

  // ── Owner autorisé ────────────────────────────────────────────────
  it('accepte rôle owner', async () => {
    const client = fakeClient(makeStateRow());
    const result = await creditVisit(client, makePrincipal({ role: 'owner' }), baseParams);

    expect((result as { credited: boolean }).credited).toBe(true);
  });

  // ── INSERT visit_ledger avec source QR_EMPLOYEE ───────────────────
  it('insère dans visit_ledger avec source QR_EMPLOYEE et idempotency_key', async () => {
    const client = fakeClient(makeStateRow());
    await creditVisit(client, makePrincipal(), baseParams);

    const insertQuery = client.queries.find((q) => q.text.includes('insert into taply.visit_ledger'));
    expect(insertQuery).toBeDefined();
    expect(insertQuery!.values).toContain('QR_EMPLOYEE');
    expect(insertQuery!.values).toContain(REQUEST_UUID);
    expect(insertQuery!.values).toContain(MEMBER_UUID);
    expect(insertQuery!.values).toContain('merchant-1');
  });
});

describe('creditVisit : contrôles runtime supplémentaires', () => {
  it('accepte les Date retournées par le vrai driver pg', async () => {
    const client = fakeClient(makeStateRow({
      visit_count: 1,
      last_credited_at: new Date(TWO_HOURS_AGO),
      pinned_rule_created_at: new Date('2026-09-01T00:00:00.000Z'),
      db_now: new Date(DB_NOW),
    }));
    const result = await creditVisit(client, makePrincipal(), baseParams);
    expect(result).toMatchObject({ credited: true, visitCount: 2, creditedAt: DB_NOW });
  });

  it('refuse une source forgée NFC même via un cast TypeScript', async () => {
    const client = fakeClient(makeStateRow());
    const result = await creditVisit(client, makePrincipal(), {
      ...baseParams,
      source: 'NFC' as never,
    });
    expect(result).toEqual({ credited: false, reason: { kind: 'invalid_request' } });
    expect(client.queries).toHaveLength(0);
  });

  it('refuse un identifiant ou une clé idempotence invalide avant SQL', async () => {
    for (const params of [
      { ...baseParams, membershipId: 'mem-1' },
      { ...baseParams, idempotencyKey: 'same-key' },
    ]) {
      const client = fakeClient(makeStateRow());
      expect(await creditVisit(client, makePrincipal(), params)).toEqual({
        credited: false, reason: { kind: 'invalid_request' },
      });
      expect(client.queries).toHaveLength(0);
    }
  });

  it('refuse un now PostgreSQL ou une dernière visite invalide', async () => {
    for (const overrides of [{ db_now: new Date('invalid') }, { last_credited_at: new Date('invalid') }]) {
      const client = fakeClient(makeStateRow(overrides));
      expect(await creditVisit(client, makePrincipal(), baseParams)).toEqual({
        credited: false, reason: { kind: 'invalid_state' },
      });
      expect(client.queries.some((q) => q.text.includes('insert into taply.visit_ledger'))).toBe(false);
    }
  });

  it('refuse un cycle non entier', async () => {
    const client = fakeClient(makeStateRow({ cycle_number: 0 }));
    expect(await creditVisit(client, makePrincipal(), baseParams)).toEqual({
      credited: false, reason: { kind: 'invalid_state' },
    });
  });

  it('joint la version épinglée au même programme, sans se fier à RLS seule', async () => {
    const client = fakeClient(makeStateRow());
    await creditVisit(client, makePrincipal(), baseParams);
    const lock = client.queries.find((q) => q.text.includes('for update of s'));
    expect(lock?.text).toMatch(/pin\.program_id\s*=\s*m\.program_id/);
    expect(lock?.text).toMatch(/s\.merchant_id\s*=\s*\$2/);
  });
});


describe('creditVisit : cohérence du nombre de lignes mutées', () => {
  it('échoue si UPDATE compteur ne modifie aucune ligne (rollback attendu du caller)', async () => {
    const client = fakeClient(makeStateRow(), { updateRowCount: 0 });
    await expect(creditVisit(client, makePrincipal(), baseParams)).rejects.toThrow('loyalty state update failed');
    expect(client.queries.some((q) => q.text.includes('insert into taply.visit_ledger'))).toBe(false);
  });

  it('échoue si INSERT journal ne modifie aucune ligne (rollback attendu du caller)', async () => {
    const client = fakeClient(makeStateRow(), { insertRowCount: 0 });
    await expect(creditVisit(client, makePrincipal(), baseParams)).rejects.toThrow('loyalty ledger insert failed');
  });
});
