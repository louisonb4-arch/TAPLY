import { describe, expect, it } from 'vitest';
import { REDACTED, isSensitiveKey, redact, redactString } from '../../backend/core/redact.js';

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwicm9sZSI6ImF1dGhlbnRpY2F0ZWQifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const TAPLY_TOKEN = 'TP1.k2.abcdefGHIJKLmnopqrstuvwxyz0123456789_-ABCD';

describe('isSensitiveKey', () => {
  it.each([
    'password',
    'newPassword',
    'access_token',
    'refresh_token',
    'refreshToken',
    'Authorization',
    'cookie',
    'set-cookie',
    'apiKey',
    'x-api-key',
    'client_secret',
    'privateKey',
    'DATABASE_URL',
    'connectionString',
    'session',
    'sessionId',
    'TOKEN_KEYRING',
    'key',
    'otp',
    'signature',
  ])('%s est sensible', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(['requestId', 'method', 'path', 'status', 'durationMs', 'merchantId', 'code', 'monkey'])(
    "%s n'est pas sensible",
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );
});

describe('redactString', () => {
  it('masque les JWT', () => {
    expect(redactString(`jeton=${JWT} fin`)).toBe('jeton=[REDACTED_JWT] fin');
  });

  it('masque Bearer / ApplePass / Basic', () => {
    expect(redactString('Authorization: Bearer abcdef0123456789xyz')).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redactString('ApplePass 0123456789abcdef0123')).toBe(`ApplePass ${REDACTED}`);
    expect(redactString('Basic dXNlcjpwYXNzd29yZA==')).toBe(`Basic ${REDACTED}`);
  });

  it('ne garde que le préfixe des jetons Taply', () => {
    const out = redactString(`scan ${TAPLY_TOKEN} ok`);
    expect(out).toBe('scan TP1.k2.abcdef… ok');
    expect(out).not.toContain('GHIJKL');
  });

  it('masque les valeurs des cookies Taply', () => {
    const out = redactString('cookie: __Host-taply_sid=SECRETVALUE123; theme=dark');
    expect(out).toBe(`cookie: __Host-taply_sid=${REDACTED}; theme=dark`);
  });

  it("masque le mot de passe d'une URL de connexion", () => {
    const out = redactString('postgres://taply_app.ref:S3cr3t!@aws-0-eu.pooler.supabase.com:6543/postgres');
    expect(out).toBe(`postgres://taply_app.ref:${REDACTED}@aws-0-eu.pooler.supabase.com:6543/postgres`);
  });

  it('masque les paramètres de requête sensibles', () => {
    const out = redactString('/api/auth/confirm?token_hash=abc123&type=invite&access_token=zzz');
    expect(out).toBe(`/api/auth/confirm?token_hash=${REDACTED}&type=invite&access_token=${REDACTED}`);
  });

  it('masque les blocs PEM', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';
    expect(redactString(`cle: ${pem}`)).toBe('cle: [REDACTED_PEM]');
  });

  it('tronque les chaînes très longues', () => {
    const out = redactString('a'.repeat(10_000));
    expect(out.length).toBeLessThan(4_100);
    expect(out.endsWith('…[truncated]')).toBe(true);
  });

  it('laisse intact un texte ordinaire', () => {
    expect(redactString('GET /api/health 200')).toBe('GET /api/health 200');
  });
});

describe('redact', () => {
  it('masque par clé, récursivement, sans modifier l’entrée', () => {
    const input = {
      user: { email: 'a@b.fr', password: 'hunter2' },
      headers: { authorization: 'Bearer xyz', 'x-request-id': 'r1' },
      list: [{ refresh_token: 'rt' }, 'ok'],
    };
    const snapshot = structuredClone(input);
    const out = redact(input) as typeof input;
    expect(out.user.password).toBe(REDACTED);
    expect(out.user.email).toBe('a@b.fr');
    expect(out.headers.authorization).toBe(REDACTED);
    expect(out.headers['x-request-id']).toBe('r1');
    expect((out.list[0] as { refresh_token: string }).refresh_token).toBe(REDACTED);
    expect(input).toEqual(snapshot);
  });

  it('masque par motif dans les valeurs non sensibles', () => {
    const out = redact({ note: `token ${JWT}` }) as { note: string };
    expect(out.note).toBe('token [REDACTED_JWT]');
  });

  it('gère les références circulaires et la profondeur', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a['self'] = a;
    expect(redact(a)).toEqual({ name: 'a', self: '[Circular]' });

    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 20; i += 1) deep = { next: deep };
    expect(JSON.stringify(redact(deep))).toContain('[MaxDepth]');
  });

  it('sérialise les erreurs en masquant message, stack et cause', () => {
    const error = new Error(`échec avec ${JWT}`, { cause: { password: 'p' } });
    const out = redact(error) as { name: string; message: string; stack: string; cause: { password: string } };
    expect(out.name).toBe('Error');
    expect(out.message).toBe('échec avec [REDACTED_JWT]');
    expect(out.stack).not.toContain(JWT);
    expect(out.cause.password).toBe(REDACTED);
  });

  it('masque les en-têtes Headers sensibles', () => {
    const headers = new Headers({ Cookie: '__Host-taply_sid=abc', 'Content-Type': 'application/json' });
    const out = redact({ headers }) as { headers: Record<string, string> };
    expect(out.headers['cookie']).toBe(REDACTED);
    expect(out.headers['content-type']).toBe('application/json');
  });

  it('gère les types primitifs et binaires', () => {
    expect(redact(42)).toBe(42);
    expect(redact(10n)).toBe('10');
    expect(redact(new Uint8Array(4))).toBe('[binary 4 bytes]');
    expect(redact(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01T00:00:00.000Z');
  });
});
