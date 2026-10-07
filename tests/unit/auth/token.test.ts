import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateSessionToken, hashSessionToken, isTokenHashShape } from '../../../backend/auth/token.js';

describe('generateSessionToken', () => {
  it('256 bits d’entropie minimum (32 octets), encodés base64url', () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/); // base64url : jamais +, /, =
    expect(Buffer.from(token, 'base64url').byteLength).toBe(32);
  });

  it('deux appels donnent deux jetons différents', () => {
    expect(generateSessionToken()).not.toBe(generateSessionToken());
  });
});

describe('hashSessionToken', () => {
  it('déterministe : même entrée → même empreinte', () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
  });

  it('empreinte SHA-256 hex exacte (vecteur connu)', () => {
    const expected = createHash('sha256').update('exemple', 'utf8').digest('hex');
    expect(hashSessionToken('exemple')).toBe(expected);
  });

  it('toujours 64 caractères hex, jamais le jeton brut lui-même', () => {
    const token = generateSessionToken();
    const hash = hashSessionToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(token);
    expect(hash).not.toContain(token);
  });
});

describe('isTokenHashShape', () => {
  it('accepte exactement 64 caractères hex minuscules', () => {
    expect(isTokenHashShape(hashSessionToken('x'))).toBe(true);
  });

  it.each(['', 'abc', 'G'.repeat(64), 'A'.repeat(64), '0'.repeat(63), '0'.repeat(65)])(
    'refuse %s',
    (value) => {
      expect(isTokenHashShape(value)).toBe(false);
    },
  );
});
