import { describe, expect, it } from 'vitest';
import {
  generateMerchantEnrollmentToken,
  hashMerchantEnrollmentToken,
  isMerchantEnrollmentToken,
  merchantEnrollmentUrl,
} from '../../../backend/loyalty/public-enrollment-token.js';

describe('Taply QR public — droits minimaux et 192 bits aléatoires', () => {
  it('produit le format 24 octets / 32 caractères base64url', () => {
    for (let i = 0; i < 20; i += 1) {
      const token = generateMerchantEnrollmentToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(Buffer.from(token, 'base64url')).toHaveLength(24);
      expect(isMerchantEnrollmentToken(token)).toBe(true);
    }
  });

  it('produit des tokens différents par commerce', () => {
    const tokens = Array.from({ length: 200 }, () => generateMerchantEnrollmentToken());
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('n’accepte pas les jetons tronqués ou un UUID / URL prévisible', () => {
    for (const value of [null, '', 'abc', 'A'.repeat(43), '../../admin', '0'.repeat(36)]) {
      expect(isMerchantEnrollmentToken(value)).toBe(false);
    }
  });

  it('sépare le hash du token brut et rejette un input mal formé', () => {
    const t = generateMerchantEnrollmentToken();
    const h = hashMerchantEnrollmentToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(t);
    expect(() => hashMerchantEnrollmentToken('invalid')).toThrow();
  });

  it('forme uniquement un lien HTTPS depuis un origin configuré, jamais Host', () => {
    const t = generateMerchantEnrollmentToken();
    expect(merchantEnrollmentUrl('https://app.taply.example/', t))
      .toBe('https://app.taply.example/j/' + t);
    for (const origin of ['http://app.taply.example/', 'https://user:pass@app.taply.example/',
      'https://app.taply.example/a', 'https://app.taply.example/?redirect=evil',
      'https://app.taply.example/#fragment']) {
      expect(() => merchantEnrollmentUrl(origin, t)).toThrow();
    }
  });
});
