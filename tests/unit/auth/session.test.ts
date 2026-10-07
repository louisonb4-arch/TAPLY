/**
 * Transactions Auth (withAuthenticatedTx / resolveMerchantUserByAuthId /
 * createLoginSession / revokeSession) — faux client pg, en mémoire,
 * pilotable par scénario. Les propriétés réelles (RLS, policies, vraie
 * concurrence) ne se prouvent que contre taply-staging, comme pour
 * TenantContext.
 */

import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { AuthInvalidCredentialsError, SessionInvalidError } from '../../../backend/auth/errors.js';
import {
  createLoginSession,
  resolveMerchantUserByAuthId,
  revokeSession,
  withAuthenticatedTx,
} from '../../../backend/auth/session.js';
import { hashSessionToken } from '../../../backend/auth/token.js';

const MERCHANT_ID = '11111111-1111-4111-8111-111111111111';
const MERCHANT_USER_ID = '22222222-2222-4222-8222-222222222222';
const AUTH_USER_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';

interface Scenario {
  readonly session?: { merchant_user_id: string; auth_user_id: string; id?: string };
  readonly merchantUser?: { id: string; merchant_id: string; role: string; status: string };
}

function fakeClient(calls: string[], scenario: Scenario) {
  const client = {
    query: async (text: string, values?: readonly unknown[]) => {
      calls.push(values === undefined ? text : `${text} :: ${JSON.stringify(values)}`);

      if (text.startsWith('select id, merchant_user_id, auth_user_id')) {
        return { rows: scenario.session ? [{ id: scenario.session.id ?? SESSION_ID, ...scenario.session }] : [] };
      }
      if (text.startsWith('select id, merchant_id, role, status')) {
        return { rows: scenario.merchantUser ? [scenario.merchantUser] : [] };
      }
      if (text.startsWith('update taply.merchant_sessions')) {
        return { rows: [] };
      }
      if (text.startsWith('insert into taply.merchant_sessions')) {
        return { rows: [{ id: SESSION_ID }] };
      }
      return { rows: [] };
    },
    release: () => {
      calls.push('release');
    },
  };
  return client as unknown as PoolClient;
}

function fakePool(client: PoolClient): Pool {
  return { connect: async () => client } as unknown as Pool;
}

describe('withAuthenticatedTx', () => {
  it('ordre des GUC : session_token_hash → auth_user_id → merchant_id, puis touch, puis callback', async () => {
    const calls: string[] = [];
    const client = fakeClient(calls, {
      session: { merchant_user_id: MERCHANT_USER_ID, auth_user_id: AUTH_USER_ID },
      merchantUser: { id: MERCHANT_USER_ID, merchant_id: MERCHANT_ID, role: 'owner', status: 'active' },
    });
    const pool = fakePool(client);

    const principal = await withAuthenticatedTx(pool, 'raw-token', 7_200, async (_c, p) => p);

    expect(principal).toEqual({
      sessionId: SESSION_ID,
      merchantId: MERCHANT_ID,
      merchantUserId: MERCHANT_USER_ID,
      authUserId: AUTH_USER_ID,
      role: 'owner',
    });

    expect(calls[0]).toBe('begin');
    expect(calls[1]).toContain('"app.session_token_hash"');
    expect(calls[1]).toContain(hashSessionToken('raw-token'));
    expect(calls[2]).toContain('select id, merchant_user_id, auth_user_id');
    expect(calls[3]).toContain('"app.auth_user_id"');
    expect(calls[3]).toContain(AUTH_USER_ID);
    expect(calls[4]).toContain('select id, merchant_id, role, status');
    expect(calls[5]).toContain('"app.merchant_id"');
    expect(calls[5]).toContain(MERCHANT_ID);
    expect(calls[6]).toContain('update taply.merchant_sessions');
    expect(calls.at(-2)).toBe('commit');
    expect(calls.at(-1)).toBe('release');
  });

  it('session introuvable/expirée/révoquée (filtrée par la requête) → SessionInvalidError, rollback', async () => {
    const calls: string[] = [];
    const client = fakeClient(calls, {});
    const pool = fakePool(client);

    await expect(withAuthenticatedTx(pool, 'raw-token', 7_200, async () => 'jamais atteint')).rejects.toThrow(
      SessionInvalidError,
    );
    expect(calls).toEqual(['begin', expect.stringContaining('app.session_token_hash'), expect.stringContaining('select id, merchant_user_id, auth_user_id'), 'rollback', 'release']);
  });

  it('merchant_user absent ou désactivé → SessionInvalidError (jamais distingué)', async () => {
    const calls: string[] = [];
    const client = fakeClient(calls, {
      session: { merchant_user_id: MERCHANT_USER_ID, auth_user_id: AUTH_USER_ID },
      merchantUser: { id: MERCHANT_USER_ID, merchant_id: MERCHANT_ID, role: 'staff', status: 'disabled' },
    });
    const pool = fakePool(client);

    await expect(withAuthenticatedTx(pool, 'raw-token', 7_200, async () => 'jamais atteint')).rejects.toThrow(
      SessionInvalidError,
    );
  });

  it('touch: idle_expires_at borné par absolute_expires_at (LEAST côté SQL, paramètre idleSeconds transmis)', async () => {
    const calls: string[] = [];
    const client = fakeClient(calls, {
      session: { merchant_user_id: MERCHANT_USER_ID, auth_user_id: AUTH_USER_ID },
      merchantUser: { id: MERCHANT_USER_ID, merchant_id: MERCHANT_ID, role: 'owner', status: 'active' },
    });
    const pool = fakePool(client);

    await withAuthenticatedTx(pool, 'raw-token', 1_234, async () => 'ok');

    const touchCall = calls.find((c) => c.includes('update taply.merchant_sessions'));
    expect(touchCall).toContain('least(now() + make_interval');
    expect(touchCall).toContain('1234');
  });
});

describe('resolveMerchantUserByAuthId', () => {
  it('pose app.auth_user_id puis filtre explicitement par auth_user_id + status actif', async () => {
    const calls: string[] = [];
    const client = fakeClient(calls, {
      merchantUser: { id: MERCHANT_USER_ID, merchant_id: MERCHANT_ID, role: 'owner', status: 'active' },
    });
    const pool = fakePool(client);

    const result = await resolveMerchantUserByAuthId(pool, AUTH_USER_ID);

    expect(result).toEqual({ id: MERCHANT_USER_ID, merchantId: MERCHANT_ID, role: 'owner' });
    expect(calls[0]).toBe('begin');
    expect(calls[1]).toContain('"app.auth_user_id"');
    expect(calls[2]).toContain("status = 'active'");
  });

  it('aucun mapping actif → undefined (jamais une erreur)', async () => {
    const client = fakeClient([], {});
    const result = await resolveMerchantUserByAuthId(fakePool(client), AUTH_USER_ID);
    expect(result).toBeUndefined();
  });

  it('authUserId non-UUID → rejeté avant toute connexion', async () => {
    const calls: string[] = [];
    let connected = false;
    const pool = { connect: async () => { connected = true; return fakeClient(calls, {}); } } as unknown as Pool;

    await expect(resolveMerchantUserByAuthId(pool, 'pas-un-uuid')).rejects.toThrow(AuthInvalidCredentialsError);
    expect(connected).toBe(false);
  });
});

describe('createLoginSession', () => {
  it('pose auth_user_id, merchant_id PUIS session_token_hash avant INSERT ; le token stocké est l’empreinte, jamais le brut', async () => {
    const calls: string[] = [];
    const client = fakeClient(calls, {});
    const pool = fakePool(client);

    const { rawToken, sessionId } = await createLoginSession(pool, {
      merchantId: MERCHANT_ID,
      merchantUserId: MERCHANT_USER_ID,
      authUserId: AUTH_USER_ID,
      idleSeconds: 7_200,
      absoluteSeconds: 43_200,
    });

    expect(sessionId).toBe(SESSION_ID);
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]+$/);

    expect(calls[0]).toBe('begin');
    expect(calls[1]).toContain('"app.auth_user_id"');
    expect(calls[2]).toContain('"app.merchant_id"');
    // Les trois GUC doivent être posés avant l'INSERT, y compris
    // session_token_hash : sous FORCE RLS, `RETURNING id` est filtré par
    // la policy SELECT session_token_lookup, pas seulement par le WITH
    // CHECK de insert_own_session — sans ce troisième GUC, la ligne tout
    // juste insérée est invisible à son propre RETURNING (reproduit en
    // staging réel, Phase 3B2).
    expect(calls[3]).toContain('"app.session_token_hash"');
    expect(calls[3]).toContain(hashSessionToken(rawToken));
    const insertCall = calls[4] ?? '';
    expect(insertCall).toContain('insert into taply.merchant_sessions');
    expect(insertCall).toContain(hashSessionToken(rawToken));
    expect(insertCall).not.toContain(rawToken);
  });
});

describe('revokeSession', () => {
  it('pose app.session_revoke_token_hash (JAMAIS app.session_token_hash) puis UPDATE revoked_at — idempotent par construction (0 ligne = pas d’erreur)', async () => {
    const calls: string[] = [];
    const client = fakeClient(calls, {});
    const rawToken = 'raw-token';
    await revokeSession(fakePool(client), rawToken);

    expect(calls[0]).toBe('begin');
    // Preuve en staging réel (Phase 3B2) : app.session_token_hash est la
    // GUC de l'authentification normale, exigée par session_token_lookup
    // (revoked_at IS NULL) — la réutiliser ici ferait échouer l'UPDATE
    // sous FORCE RLS puisque révoquer rend justement cette condition
    // fausse. La révocation utilise une capacité RLS séparée
    // (session_revoke_lookup / revoke_own_session, migration
    // 20261007120013), jamais la policy d'authentification.
    expect(calls[1]).toContain('"app.session_revoke_token_hash"');
    expect(calls[1]).toContain(hashSessionToken(rawToken));
    expect(calls.some((c) => c.includes('"app.session_token_hash"'))).toBe(false);
    expect(calls[2]).toContain('update taply.merchant_sessions');
    // Le filtre applicatif explicite reste la barrière principale — RLS
    // n'est jamais le seul sélecteur de ligne.
    expect(calls[2]).toContain('where token_hash = $1');
    expect(calls[2]).toContain('revoked_at is null');
    expect(calls[2]).not.toContain(rawToken);
    expect(calls[2]).toContain(hashSessionToken(rawToken));
    expect(calls.at(-2)).toBe('commit');
  });

  it('jamais le jeton brut en base/GUC — uniquement son empreinte SHA-256', async () => {
    const calls: string[] = [];
    const client = fakeClient(calls, {});
    const rawToken = 'un-autre-jeton-tres-secret';
    await revokeSession(fakePool(client), rawToken);

    const joined = calls.join(' | ');
    expect(joined).not.toContain(rawToken);
  });
});
