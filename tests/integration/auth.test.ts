/**
 * Flux HTTP complets (login/me/logout) — DB simulée par un faux client pg
 * en mémoire (jamais de vraie connexion), Supabase Auth mocké (jamais de
 * vrai compte créé). Aucune écriture distante.
 */

import type { Pool, PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const AUTH_USER_ID = '33333333-3333-4333-8333-333333333333';
const MERCHANT_USER_ID = '22222222-2222-4222-8222-222222222222';
const MERCHANT_ID = '11111111-1111-4111-8111-111111111111';
const APP_ORIGIN = 'https://app.taply.test';

interface FakeMerchantUser {
  id: string;
  merchant_id: string;
  auth_user_id: string;
  role: string;
  status: string;
}
interface FakeSession {
  id: string;
  merchant_id: string;
  merchant_user_id: string;
  auth_user_id: string;
  token_hash: string;
  idle_expires_at: number;
  absolute_expires_at: number;
  revoked_at: number | null;
}

let merchantUsers: FakeMerchantUser[] = [];
let sessions: FakeSession[] = [];
let nextId = 1;

function hash(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function seedSessionForAuthUser(opts: { idleMs?: number; absoluteMs?: number; revoked?: boolean } = {}) {
  const rawToken = `raw-${nextId++}`;
  sessions.push({
    id: `session-${nextId}`,
    merchant_id: MERCHANT_ID,
    merchant_user_id: MERCHANT_USER_ID,
    auth_user_id: AUTH_USER_ID,
    token_hash: hash(rawToken),
    idle_expires_at: Date.now() + (opts.idleMs ?? 60_000),
    absolute_expires_at: Date.now() + (opts.absoluteMs ?? 120_000),
    revoked_at: opts.revoked ? Date.now() - 1_000 : null,
  });
  return rawToken;
}

function fakeQuery(text: string, values: readonly unknown[] = []) {
  if (text === 'begin' || text === 'commit' || text === 'rollback') return { rows: [] };
  if (text.startsWith('select set_config')) return { rows: [] };

  if (text.includes('from taply.merchant_users') && text.includes('where auth_user_id = $1 and status')) {
    const [authUserId] = values as [string];
    const row = merchantUsers.find((u) => u.auth_user_id === authUserId && u.status === 'active');
    return { rows: row ? [row] : [] };
  }

  if (text.includes('from taply.merchant_users') && text.includes('where id = $1 and auth_user_id = $2')) {
    const [id, authUserId] = values as [string, string];
    const row = merchantUsers.find((u) => u.id === id && u.auth_user_id === authUserId);
    return { rows: row ? [row] : [] };
  }

  if (text.includes('from taply.merchant_sessions') && text.includes('token_hash = $1') && text.includes('revoked_at is null')) {
    const [tokenHash] = values as [string];
    const now = Date.now();
    const row = sessions.find(
      (s) => s.token_hash === tokenHash && s.revoked_at === null && s.idle_expires_at > now && s.absolute_expires_at > now,
    );
    return { rows: row ? [row] : [] };
  }

  if (text.startsWith('insert into taply.merchant_sessions')) {
    const [merchantId, merchantUserId, authUserId, tokenHash, idleSeconds, absoluteSeconds] = values as [
      string,
      string,
      string,
      string,
      number,
      number,
    ];
    const id = `session-${nextId++}`;
    sessions.push({
      id,
      merchant_id: merchantId,
      merchant_user_id: merchantUserId,
      auth_user_id: authUserId,
      token_hash: tokenHash,
      idle_expires_at: Date.now() + idleSeconds * 1_000,
      absolute_expires_at: Date.now() + absoluteSeconds * 1_000,
      revoked_at: null,
    });
    return { rows: [{ id }] };
  }

  if (text.startsWith('update taply.merchant_sessions') && text.includes('last_seen_at')) {
    const [id] = values as [string];
    const session = sessions.find((s) => s.id === id);
    if (session) session.idle_expires_at = Math.min(Date.now() + 60_000, session.absolute_expires_at);
    return { rows: [] };
  }

  if (text.startsWith('update taply.merchant_sessions') && text.includes('revoked_at = now()')) {
    const [tokenHash] = values as [string];
    const session = sessions.find((s) => s.token_hash === tokenHash && s.revoked_at === null);
    if (session) session.revoked_at = Date.now();
    return { rows: [] };
  }

  throw new Error(`requête inattendue dans le faux client : ${text}`);
}

function fakePool(): Pool {
  const client = { query: async (text: string, values?: readonly unknown[]) => fakeQuery(text, values), release: () => {} } as unknown as PoolClient;
  return { connect: async () => client } as unknown as Pool;
}

vi.mock('../../backend/db/pool.js', () => ({ getPool: () => fakePool() }));

const signInWithPassword = vi.fn();
const signOut = vi.fn();
vi.mock('../../backend/auth/supabase-client.js', () => ({
  createAuthClient: () => ({ auth: { signInWithPassword, signOut } }),
}));

const { loadConfig } = await import('../../backend/core/config.js');
const { createApp } = await import('../../backend/http/app.js');
const { captureLogger } = await import('../helpers/capture-logger.js');

function setup() {
  const { logger } = captureLogger();
  const config = loadConfig({ NODE_ENV: 'test', APP_ORIGIN });
  return createApp({ config, logger });
}

function cookieHeaderFrom(res: Response): string {
  const setCookie = res.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0] ?? '';
}

beforeEach(() => {
  merchantUsers = [{ id: MERCHANT_USER_ID, merchant_id: MERCHANT_ID, auth_user_id: AUTH_USER_ID, role: 'owner', status: 'active' }];
  sessions = [];
  signInWithPassword.mockReset();
  signOut.mockReset();
  signOut.mockResolvedValue({ error: null });
});

describe('POST /api/auth/login', () => {
  it('identifiants valides → 200, cookie posé, corps minimal', async () => {
    signInWithPassword.mockResolvedValueOnce({ data: { user: { id: AUTH_USER_ID } }, error: null });
    const app = setup();

    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: APP_ORIGIN },
      body: JSON.stringify({ email: 'owner@example.com', password: 'correct' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: true, merchantId: MERCHANT_ID, role: 'owner' });
    expect(res.headers.get('set-cookie')).toMatch(/taply_session=/);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('mauvais identifiants → 401 AUTH_INVALID générique', async () => {
    signInWithPassword.mockResolvedValueOnce({ data: { user: null }, error: { message: 'bad credentials' } });
    const app = setup();

    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: APP_ORIGIN },
      body: JSON.stringify({ email: 'owner@example.com', password: 'wrong' }),
    });

    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('AUTH_INVALID');
  });

  it('aucun mapping merchant actif → même 401 AUTH_INVALID (pas de distinction)', async () => {
    merchantUsers = [];
    signInWithPassword.mockResolvedValueOnce({ data: { user: { id: AUTH_USER_ID } }, error: null });
    const app = setup();

    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: APP_ORIGIN },
      body: JSON.stringify({ email: 'owner@example.com', password: 'correct' }),
    });

    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('AUTH_INVALID');
  });

  it('mapping désactivé → même 401 AUTH_INVALID', async () => {
    merchantUsers = [{ id: MERCHANT_USER_ID, merchant_id: MERCHANT_ID, auth_user_id: AUTH_USER_ID, role: 'staff', status: 'disabled' }];
    signInWithPassword.mockResolvedValueOnce({ data: { user: { id: AUTH_USER_ID } }, error: null });
    const app = setup();

    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: APP_ORIGIN },
      body: JSON.stringify({ email: 'owner@example.com', password: 'correct' }),
    });

    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('AUTH_INVALID');
  });

  it('Origin absente → 403 ORIGIN_REJECTED (login-CSRF)', async () => {
    const app = setup();
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'correct' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ORIGIN_REJECTED');
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it('Origin incorrecte → 403 ORIGIN_REJECTED', async () => {
    const app = setup();
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'correct' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/auth/me', () => {
  it('session valide → 200 avec principal minimal', async () => {
    const rawToken = seedSessionForAuthUser();
    const app = setup();

    const res = await app.request('/api/auth/me', { headers: { cookie: `taply_session=${rawToken}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: true, merchantId: MERCHANT_ID, role: 'owner' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('staff : le rôle exact est renvoyé', async () => {
    merchantUsers = [{ id: MERCHANT_USER_ID, merchant_id: MERCHANT_ID, auth_user_id: AUTH_USER_ID, role: 'staff', status: 'active' }];
    const rawToken = seedSessionForAuthUser();
    const app = setup();

    const res = await app.request('/api/auth/me', { headers: { cookie: `taply_session=${rawToken}` } });
    expect((await res.json() as { role: string }).role).toBe('staff');
  });

  it('cookie absent → 401 AUTH_REQUIRED', async () => {
    const app = setup();
    const res = await app.request('/api/auth/me');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('AUTH_REQUIRED');
  });

  it('session expirée (idle) → 401 AUTH_REQUIRED', async () => {
    const rawToken = seedSessionForAuthUser({ idleMs: -1_000 });
    const app = setup();
    const res = await app.request('/api/auth/me', { headers: { cookie: `taply_session=${rawToken}` } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('AUTH_REQUIRED');
  });

  it('session révoquée → 401 AUTH_REQUIRED', async () => {
    const rawToken = seedSessionForAuthUser({ revoked: true });
    const app = setup();
    const res = await app.request('/api/auth/me', { headers: { cookie: `taply_session=${rawToken}` } });
    expect(res.status).toBe(401);
  });

  it('jeton inconnu → 401 AUTH_REQUIRED, jamais une erreur serveur', async () => {
    const app = setup();
    const res = await app.request('/api/auth/me', { headers: { cookie: 'taply_session=ce-jeton-n-existe-pas' } });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('session valide → 200, cookie effacé, session revoked (me échoue ensuite)', async () => {
    const rawToken = seedSessionForAuthUser();
    const app = setup();

    const res = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: { origin: APP_ORIGIN, cookie: `taply_session=${rawToken}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ loggedOut: true });
    expect(cookieHeaderFrom(res)).toBe('taply_session=');
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');

    const me = await app.request('/api/auth/me', { headers: { cookie: `taply_session=${rawToken}` } });
    expect(me.status).toBe(401);
  });

  it('idempotent : sans cookie → 200 quand même, pas de fuite d’existence de session', async () => {
    const app = setup();
    const res = await app.request('/api/auth/logout', { method: 'POST', headers: { origin: APP_ORIGIN } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ loggedOut: true });
  });

  it('Origin absente → 403 ORIGIN_REJECTED', async () => {
    const app = setup();
    const res = await app.request('/api/auth/logout', { method: 'POST' });
    expect(res.status).toBe(403);
  });
});
