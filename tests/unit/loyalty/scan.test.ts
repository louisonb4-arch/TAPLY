/**
 * Tests unitaires de scanWalletQrAndCredit — mocks statiques.
 *
 * Vérifient :
 *   - Rôle refusé → zéro SELECT
 *   - Mauvais token → qr_invalid générique, zéro mutation
 *   - Mauvais merchant (cross-tenant) → qr_invalid générique
 *   - Bon token → membershipId résolu côté serveur transmis à creditVisit
 *   - Refus délai et cadeau conservés depuis creditVisit
 *   - Idempotence si même scan rejoué
 *   - Aucun secret loggé (jeton brut absent des queries SQL)
 *
 * Ne certifient PAS la RLS — seuls des tests PostgreSQL réels le font.
 */

import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedPrincipal } from '../../../backend/auth/session.js';
import type { CreditVisitResult } from '../../../backend/loyalty/credit.js';
import { scanWalletQrAndCredit } from '../../../backend/loyalty/scan.js';

// ── Mock modules ─────────────────────────────────────────────────────

vi.mock('../../../backend/loyalty/qr-token.js', () => ({
  resolveWalletQrToken: vi.fn(),
}));

vi.mock('../../../backend/loyalty/credit.js', () => ({
  creditVisit: vi.fn(),
}));

import { resolveWalletQrToken } from '../../../backend/loyalty/qr-token.js';
import { creditVisit } from '../../../backend/loyalty/credit.js';

const mockResolve = vi.mocked(resolveWalletQrToken);
const mockCredit = vi.mocked(creditVisit);

// ── Helpers ──────────────────────────────────────────────────────────

const VALID_TOKEN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq';
const IDEM_KEY = '00000000-0000-4000-8000-000000000042';
const MEMBERSHIP_UUID = '00000000-0000-4000-8000-000000000001';
const DB_NOW = '2026-10-08T12:00:00.000Z';

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

function fakeClient() {
  const queries: Array<{ text: string; values: readonly unknown[] }> = [];
  const client = {
    queries,
    query: async (text: string, values: readonly unknown[] = []) => {
      queries.push({ text: text.trim(), values: [...values] });
      return { rows: [] };
    },
  };
  return client as unknown as PoolClient & { queries: typeof queries };
}

const creditedResult: CreditVisitResult = {
  credited: true,
  visitCount: 1,
  rewardUnlocked: false,
  cycleNumber: 1,
  creditedAt: DB_NOW,
};

beforeEach(() => {
  mockResolve.mockReset();
  mockCredit.mockReset();
});

// ── Tests ────────────────────────────────────────────────────────────

describe('scanWalletQrAndCredit', () => {
  // ── Rôle refusé → zéro SELECT ──────────────────────────────────────
  it('refuse si rôle non owner/staff — zéro requête SQL, zéro appel resolve/credit', async () => {
    const client = fakeClient();
    const principal = makePrincipal({ role: 'viewer' as never });

    const result = await scanWalletQrAndCredit(client, principal, VALID_TOKEN, IDEM_KEY);

    expect(result).toEqual({ credited: false, reason: { kind: 'unauthorized_role' } });
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockCredit).not.toHaveBeenCalled();
    expect(client.queries).toHaveLength(0);
  });

  // ── Mauvais token → qr_invalid générique ───────────────────────────
  it('retourne qr_invalid si resolveWalletQrToken retourne undefined (format invalide)', async () => {
    mockResolve.mockResolvedValue(undefined);
    const client = fakeClient();

    const result = await scanWalletQrAndCredit(client, makePrincipal(), 'bad-token', IDEM_KEY);

    expect(result).toEqual({ credited: false, reason: { kind: 'qr_invalid' } });
    expect(mockResolve).toHaveBeenCalledOnce();
    expect(mockCredit).not.toHaveBeenCalled();
  });

  // ── Mauvais merchant (cross-tenant) → qr_invalid générique ────────
  it('retourne qr_invalid si token existe mais pas pour ce merchant', async () => {
    // resolveWalletQrToken filtre par principal.merchantId — retourne undefined
    mockResolve.mockResolvedValue(undefined);
    const client = fakeClient();
    const principal = makePrincipal({ merchantId: 'merchant-other' });

    const result = await scanWalletQrAndCredit(client, principal, VALID_TOKEN, IDEM_KEY);

    expect(result).toEqual({ credited: false, reason: { kind: 'qr_invalid' } });
    expect(mockResolve).toHaveBeenCalledWith(client, principal, VALID_TOKEN);
    expect(mockCredit).not.toHaveBeenCalled();
  });

  // ── Bon token → membershipId serveur transmis à creditVisit ───────
  it('résout le QR et transmet membershipId côté serveur à creditVisit', async () => {
    mockResolve.mockResolvedValue(MEMBERSHIP_UUID);
    mockCredit.mockResolvedValue(creditedResult);
    const client = fakeClient();
    const principal = makePrincipal();

    const result = await scanWalletQrAndCredit(client, principal, VALID_TOKEN, IDEM_KEY);

    expect(result).toEqual(creditedResult);

    // creditVisit appelé avec membershipId RÉSOLU, pas un paramètre client
    expect(mockCredit).toHaveBeenCalledWith(client, principal, {
      membershipId: MEMBERSHIP_UUID,
      source: 'QR_EMPLOYEE',
      idempotencyKey: IDEM_KEY,
    });
  });

  // ── Owner accepté ─────────────────────────────────────────────────
  it('accepte rôle owner', async () => {
    mockResolve.mockResolvedValue(MEMBERSHIP_UUID);
    mockCredit.mockResolvedValue(creditedResult);
    const client = fakeClient();

    const result = await scanWalletQrAndCredit(
      client, makePrincipal({ role: 'owner' }), VALID_TOKEN, IDEM_KEY,
    );

    expect(result).toMatchObject({ credited: true });
    expect(mockResolve).toHaveBeenCalledOnce();
    expect(mockCredit).toHaveBeenCalledOnce();
  });

  // ── Refus cooldown conservé depuis creditVisit ────────────────────
  it('propage refus cooldown de creditVisit', async () => {
    const cooldownDenial: CreditVisitResult = {
      credited: false,
      reason: { kind: 'cooldown_active', retryAfter: '2026-10-08T14:00:00.000Z' },
    };
    mockResolve.mockResolvedValue(MEMBERSHIP_UUID);
    mockCredit.mockResolvedValue(cooldownDenial);
    const client = fakeClient();

    const result = await scanWalletQrAndCredit(client, makePrincipal(), VALID_TOKEN, IDEM_KEY);

    expect(result).toEqual(cooldownDenial);
  });

  // ── Refus reward_pending conservé depuis creditVisit ──────────────
  it('propage refus reward_pending de creditVisit', async () => {
    const rewardDenial: CreditVisitResult = {
      credited: false,
      reason: { kind: 'reward_pending' },
    };
    mockResolve.mockResolvedValue(MEMBERSHIP_UUID);
    mockCredit.mockResolvedValue(rewardDenial);
    const client = fakeClient();

    const result = await scanWalletQrAndCredit(client, makePrincipal(), VALID_TOKEN, IDEM_KEY);

    expect(result).toEqual(rewardDenial);
  });

  // ── Idempotence : même scan rejoué ────────────────────────────────
  it('idempotence : même token + même clé → même résultat via creditVisit', async () => {
    mockResolve.mockResolvedValue(MEMBERSHIP_UUID);
    // creditVisit gère l'idempotence en interne via runIdempotent
    // On vérifie que scanWalletQrAndCredit transmet la même clé
    mockCredit.mockResolvedValue(creditedResult);
    const client = fakeClient();
    const principal = makePrincipal();

    const first = await scanWalletQrAndCredit(client, principal, VALID_TOKEN, IDEM_KEY);
    const second = await scanWalletQrAndCredit(client, principal, VALID_TOKEN, IDEM_KEY);

    expect(first).toEqual(second);
    // creditVisit appelé deux fois avec même idempotencyKey — c'est lui qui déduplique
    expect(mockCredit).toHaveBeenCalledTimes(2);
    const calls = mockCredit.mock.calls;
    expect(calls[0]![2].idempotencyKey).toBe(calls[1]![2].idempotencyKey);
  });

  // ── Aucun secret loggé : jeton brut absent des queries SQL ────────
  it('jeton brut jamais présent dans les queries SQL du client', async () => {
    mockResolve.mockResolvedValue(MEMBERSHIP_UUID);
    mockCredit.mockResolvedValue(creditedResult);
    const client = fakeClient();

    await scanWalletQrAndCredit(client, makePrincipal(), VALID_TOKEN, IDEM_KEY);

    // scanWalletQrAndCredit lui-même n'émet aucune query directe
    // (resolve et credit sont mockés), donc zéro query au total
    expect(client.queries).toHaveLength(0);

    // Vérifie que le token brut n'est transmis qu'à resolveWalletQrToken
    // qui le hash avant SQL (testé dans qr-token.test.ts)
    const resolveArgs = mockResolve.mock.calls[0]!;
    expect(resolveArgs[2]).toBe(VALID_TOKEN); // brut donné à resolve uniquement

    // creditVisit ne reçoit jamais le token brut
    const creditArgs = mockCredit.mock.calls[0]!;
    const creditParams = creditArgs[2];
    expect(creditParams).not.toHaveProperty('rawQrToken');
    expect(Object.values(creditParams)).not.toContain(VALID_TOKEN);
  });

  // ── Source toujours QR_EMPLOYEE, jamais paramètre externe ─────────
  it('source est toujours QR_EMPLOYEE, jamais un paramètre externe', async () => {
    mockResolve.mockResolvedValue(MEMBERSHIP_UUID);
    mockCredit.mockResolvedValue(creditedResult);

    await scanWalletQrAndCredit(fakeClient(), makePrincipal(), VALID_TOKEN, IDEM_KEY);

    expect(mockCredit.mock.calls[0]![2].source).toBe('QR_EMPLOYEE');
  });

  // ── membershipId jamais fourni par l'appelant ─────────────────────
  it('membershipId résolu depuis QR, jamais accepté en paramètre', async () => {
    mockResolve.mockResolvedValue(MEMBERSHIP_UUID);
    mockCredit.mockResolvedValue(creditedResult);

    // La signature de scanWalletQrAndCredit n'accepte pas membershipId
    // On vérifie que creditVisit reçoit le UUID résolu par resolve
    await scanWalletQrAndCredit(fakeClient(), makePrincipal(), VALID_TOKEN, IDEM_KEY);

    expect(mockCredit.mock.calls[0]![2].membershipId).toBe(MEMBERSHIP_UUID);
  });
});
