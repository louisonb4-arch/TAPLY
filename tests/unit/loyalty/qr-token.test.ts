/**
 * Tests unitaires de qr-token — client PG mock.
 *
 * Vérifient : génération, entropie, domain-separated hashing, validation
 * format, résolution avec filtres SQL explicites, isolation cross-tenant,
 * absence de jeton brut dans SQL/résultats, et refus sur états inactifs.
 * Ne certifient PAS la RLS — seuls des tests PostgreSQL réels le font.
 */

import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { AuthenticatedPrincipal } from '../../../backend/auth/session.js';
import {
  generateWalletQrToken,
  hashWalletQrToken,
  isValidWalletQrToken,
  isWalletQrTokenHashShape,
  resolveWalletQrToken,
} from '../../../backend/loyalty/qr-token.js';

// ── Helpers ─────────────────────────────────────────────────────────

function makePrincipal(overrides?: Partial<AuthenticatedPrincipal>): AuthenticatedPrincipal {
  return {
    sessionId: 'sess-1',
    merchantId: 'merchant-1',
    merchantUserId: 'mu-1',
    authUserId: 'auth-1',
    role: 'owner',
    ...overrides,
  };
}

const MEMBERSHIP_UUID = '00000000-0000-4000-8000-000000000099';

function fakeClient(resolveRow: { membership_id: string } | null) {
  const queries: Array<{ text: string; values: readonly unknown[] }> = [];

  const client = {
    queries,
    query: async (text: string, values: readonly unknown[] = []) => {
      queries.push({ text: text.trim(), values: [...values] });

      if (text.includes('taply.wallet_qr_tokens')) {
        return { rows: resolveRow === null ? [] : [resolveRow] };
      }

      throw new Error(`Unexpected SQL in fake client: ${text}`);
    },
  };
  return client as unknown as PoolClient & { queries: typeof queries };
}

// ── Generation ──────────────────────────────────────────────────────

describe('generateWalletQrToken', () => {
  it('produces a base64url string of expected length (43 chars for 32 bytes)', () => {
    const token = generateWalletQrToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('generates distinct tokens on successive calls', () => {
    const tokens = new Set(Array.from({ length: 20 }, () => generateWalletQrToken()));
    expect(tokens.size).toBe(20);
  });

  it('each token passes format validation', () => {
    for (let i = 0; i < 10; i++) {
      expect(isValidWalletQrToken(generateWalletQrToken())).toBe(true);
    }
  });
});

// ── Hashing ─────────────────────────────────────────────────────────

describe('hashWalletQrToken', () => {
  it('returns 64-char lowercase hex (SHA-256)', () => {
    const hash = hashWalletQrToken(generateWalletQrToken());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(isWalletQrTokenHashShape(hash)).toBe(true);
  });

  it('is domain-separated: differs from plain SHA-256 of same input', () => {
    const raw = generateWalletQrToken();
    const walletHash = hashWalletQrToken(raw);
    const plainHash = createHash('sha256').update(raw, 'utf8').digest('hex');
    expect(walletHash).not.toBe(plainHash);
  });

  it('same token always produces same hash (deterministic)', () => {
    const raw = generateWalletQrToken();
    expect(hashWalletQrToken(raw)).toBe(hashWalletQrToken(raw));
  });

  it('different tokens produce different hashes', () => {
    const a = hashWalletQrToken(generateWalletQrToken());
    const b = hashWalletQrToken(generateWalletQrToken());
    expect(a).not.toBe(b);
  });
});

// ── Format validation ───────────────────────────────────────────────

describe('isValidWalletQrToken', () => {
  it('rejects empty string', () => {
    expect(isValidWalletQrToken('')).toBe(false);
  });

  it('rejects too short', () => {
    expect(isValidWalletQrToken('abc')).toBe(false);
  });

  it('rejects too long (44+ chars)', () => {
    expect(isValidWalletQrToken('A'.repeat(44))).toBe(false);
  });

  it('rejects non-base64url characters', () => {
    expect(isValidWalletQrToken('A'.repeat(42) + '+')).toBe(false);
    expect(isValidWalletQrToken('A'.repeat(42) + '=')).toBe(false);
  });

  it('accepts valid generated token', () => {
    expect(isValidWalletQrToken(generateWalletQrToken())).toBe(true);
  });
});

// ── Resolution ──────────────────────────────────────────────────────

describe('resolveWalletQrToken', () => {
  const validToken = generateWalletQrToken();

  it('returns membershipId on exact hash match', async () => {
    const client = fakeClient({ membership_id: MEMBERSHIP_UUID });
    const result = await resolveWalletQrToken(client, makePrincipal(), validToken);
    expect(result).toBe(MEMBERSHIP_UUID);
  });

  it('sends only hash to SQL, never raw token', async () => {
    const client = fakeClient({ membership_id: MEMBERSHIP_UUID });
    await resolveWalletQrToken(client, makePrincipal(), validToken);

    expect(client.queries).toHaveLength(1);
    const query = client.queries[0]!;
    const expectedHash = hashWalletQrToken(validToken);

    // $1 = hash, $2 = merchantId — raw token absent from values
    expect(query.values[0]).toBe(expectedHash);
    expect(query.values[1]).toBe('merchant-1');
    expect(query.values).not.toContain(validToken);
  });

  it('SQL uses parameterized $1/$2, never string interpolation', async () => {
    const client = fakeClient({ membership_id: MEMBERSHIP_UUID });
    await resolveWalletQrToken(client, makePrincipal(), validToken);

    const sql = client.queries[0]!.text;
    expect(sql).toContain('$1');
    expect(sql).toContain('$2');
    // No raw token or merchantId literal embedded in SQL text
    expect(sql).not.toContain(validToken);
    expect(sql).not.toContain('merchant-1');
  });

  it('SQL joins merchant and program for active status checks', async () => {
    const client = fakeClient({ membership_id: MEMBERSHIP_UUID });
    await resolveWalletQrToken(client, makePrincipal(), validToken);

    const sql = client.queries[0]!.text;
    // Explicit joins — not relying on RLS alone
    expect(sql).toMatch(/from\s+taply\.wallet_qr_tokens\s+t/);
    expect(sql).toMatch(/join\s+taply\.memberships\s+m/);
    expect(sql).toMatch(/m\.merchant_id\s*=\s*t\.merchant_id/);
    expect(sql).toMatch(/join\s+taply\.loyalty_programs/);
    expect(sql).toMatch(/join\s+taply\.merchants/);
    expect(sql).toMatch(/for share of t/);
    expect(sql).toContain("m.status = 'active'");
    expect(sql).toContain("lp.status = 'active'");
    expect(sql).toContain("mer.status = 'active'");
  });

  it('SQL filters by merchant_id from principal (tenant isolation)', async () => {
    const client = fakeClient({ membership_id: MEMBERSHIP_UUID });
    await resolveWalletQrToken(client, makePrincipal({ merchantId: 'merchant-X' }), validToken);

    expect(client.queries[0]!.values[1]).toBe('merchant-X');
    expect(client.queries[0]!.text).toContain('m.merchant_id = $2');
  });

  it('SQL checks revoked_at IS NULL', async () => {
    const client = fakeClient({ membership_id: MEMBERSHIP_UUID });
    await resolveWalletQrToken(client, makePrincipal(), validToken);
    expect(client.queries[0]!.text).toContain('t.revoked_at is null');
  });

  // ── No query on invalid format ──────────────────────────────────

  it('emits zero SQL queries for invalid token format', async () => {
    const client = fakeClient({ membership_id: MEMBERSHIP_UUID });

    for (const bad of ['', 'short', 'A'.repeat(44), 'abc+def/ghi=', '<script>']) {
      client.queries.length = 0;
      const result = await resolveWalletQrToken(client, makePrincipal(), bad);
      expect(result).toBeUndefined();
      expect(client.queries).toHaveLength(0);
    }
  });

  // ── Token not found ─────────────────────────────────────────────

  it('returns undefined when token hash not found', async () => {
    const client = fakeClient(null);
    const result = await resolveWalletQrToken(client, makePrincipal(), validToken);
    expect(result).toBeUndefined();
  });

  // ── Cross-tenant isolation ──────────────────────────────────────

  it('different merchants send different merchantId to SQL', async () => {
    const tokenA = generateWalletQrToken();

    const clientA = fakeClient({ membership_id: MEMBERSHIP_UUID });
    await resolveWalletQrToken(clientA, makePrincipal({ merchantId: 'merchant-A' }), tokenA);

    const clientB = fakeClient(null);
    await resolveWalletQrToken(clientB, makePrincipal({ merchantId: 'merchant-B' }), tokenA);

    expect(clientA.queries[0]!.values[1]).toBe('merchant-A');
    expect(clientB.queries[0]!.values[1]).toBe('merchant-B');
    // merchant-B gets no result even with same token hash
    expect(clientB.queries[0]!.values[0]).toBe(clientA.queries[0]!.values[0]);
  });

  // ── Return value has no raw token ───────────────────────────────

  it('return value is membershipId only, never contains raw token', async () => {
    const token = generateWalletQrToken();
    const client = fakeClient({ membership_id: MEMBERSHIP_UUID });
    const result = await resolveWalletQrToken(client, makePrincipal(), token);

    expect(result).toBe(MEMBERSHIP_UUID);
    expect(result).not.toBe(token);
    expect(result).not.toBe(hashWalletQrToken(token));
  });
});
