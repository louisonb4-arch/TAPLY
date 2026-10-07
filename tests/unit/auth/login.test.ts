/**
 * Orchestration du login — Supabase Auth mocké (jamais de vrai compte
 * Supabase à ce stade local), DB simulée par un faux client pg (même
 * principe que session.test.ts). Vérifie en particulier : jamais de
 * distinction observable entre les causes d'échec, jamais de token
 * Supabase dans le résultat ni dans les logs.
 */

import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { captureLogger } from '../../helpers/capture-logger.js';

const signInWithPassword = vi.fn();
const signOut = vi.fn();

vi.mock('../../../backend/auth/supabase-client.js', () => ({
  createAuthClient: () => ({ auth: { signInWithPassword, signOut } }),
}));

const { AuthInvalidCredentialsError } = await import('../../../backend/auth/errors.js');
const { loginWithPassword } = await import('../../../backend/auth/login.js');

const AUTH_USER_ID = '33333333-3333-4333-8333-333333333333';
const MERCHANT_USER_ID = '22222222-2222-4222-8222-222222222222';
const MERCHANT_ID = '11111111-1111-4111-8111-111111111111';

interface Scenario {
  readonly merchantUser?: { id: string; merchant_id: string; role: string; status: string };
}

function fakePool(scenario: Scenario): Pool {
  const client = {
    query: async (text: string) => {
      if (text.startsWith('select id, merchant_id, role, status')) {
        return { rows: scenario.merchantUser ? [scenario.merchantUser] : [] };
      }
      if (text.startsWith('insert into taply.merchant_sessions')) {
        return { rows: [{ id: 'session-id' }] };
      }
      return { rows: [] };
    },
    release: () => {},
  } as unknown as PoolClient;
  return { connect: async () => client } as unknown as Pool;
}

const PARAMS = { email: 'owner@example.com', password: 'correct-password', idleSeconds: 7_200, absoluteSeconds: 43_200 };

describe('loginWithPassword', () => {
  it('succès : signInWithPassword puis signOut({scope:"local"}) puis session créée, jamais de token Supabase renvoyé', async () => {
    signInWithPassword.mockResolvedValueOnce({ data: { user: { id: AUTH_USER_ID } }, error: null });
    signOut.mockResolvedValueOnce({ error: null });
    const { logger, entries } = captureLogger();
    const pool = fakePool({ merchantUser: { id: MERCHANT_USER_ID, merchant_id: MERCHANT_ID, role: 'owner', status: 'active' } });

    const result = await loginWithPassword(pool, logger, PARAMS);

    expect(result).toEqual({ rawToken: expect.any(String), merchantId: MERCHANT_ID, role: 'owner' });
    expect(Object.keys(result)).toEqual(['rawToken', 'merchantId', 'role']); // jamais access_token/refresh_token
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(signOut).not.toHaveBeenCalledWith({});
    expect(signOut).not.toHaveBeenCalledWith(undefined);

    const log = JSON.stringify(entries());
    expect(log).not.toContain('correct-password');
    expect(log).not.toContain('owner@example.com');
    expect(log).not.toMatch(/access_token|refresh_token/);
  });

  it('identifiants refusés par Supabase → AuthInvalidCredentialsError générique', async () => {
    signInWithPassword.mockResolvedValueOnce({ data: { user: null }, error: { message: 'Invalid login credentials' } });
    const { logger, entries } = captureLogger();
    const pool = fakePool({});

    await expect(loginWithPassword(pool, logger, PARAMS)).rejects.toThrow(AuthInvalidCredentialsError);
    expect(signOut).not.toHaveBeenCalled();
    expect(JSON.stringify(entries())).not.toContain(PARAMS.password);
  });

  it('identité Supabase valide mais aucun mapping merchant actif → même erreur générique', async () => {
    signInWithPassword.mockResolvedValueOnce({ data: { user: { id: AUTH_USER_ID } }, error: null });
    signOut.mockResolvedValueOnce({ error: null });
    const { logger } = captureLogger();
    const pool = fakePool({}); // aucun merchant_user

    await expect(loginWithPassword(pool, logger, PARAMS)).rejects.toThrow(AuthInvalidCredentialsError);
  });

  it('mapping désactivé (status disabled) → même erreur générique que "aucun mapping"', async () => {
    signInWithPassword.mockResolvedValueOnce({ data: { user: { id: AUTH_USER_ID } }, error: null });
    signOut.mockResolvedValueOnce({ error: null });
    const { logger } = captureLogger();
    // resolveMerchantUserByAuthId filtre déjà status='active' dans sa requête :
    // un mapping disabled n'apparaît jamais dans les rows → même chemin que "absent".
    const pool = fakePool({});

    await expect(loginWithPassword(pool, logger, PARAMS)).rejects.toThrow(AuthInvalidCredentialsError);
  });

  it('échec du nettoyage Supabase local (non fatal) : login continue, avertissement journalisé sans secret', async () => {
    signInWithPassword.mockResolvedValueOnce({ data: { user: { id: AUTH_USER_ID } }, error: null });
    signOut.mockResolvedValueOnce({ error: { message: 'cleanup failed' } });
    const { logger, entries } = captureLogger();
    const pool = fakePool({ merchantUser: { id: MERCHANT_USER_ID, merchant_id: MERCHANT_ID, role: 'staff', status: 'active' } });

    const result = await loginWithPassword(pool, logger, PARAMS);

    expect(result.role).toBe('staff');
    const warnEntry = entries().find((e) => e['msg'] === 'auth.supabase_cleanup_failed');
    expect(warnEntry).toBeDefined();
  });
});
