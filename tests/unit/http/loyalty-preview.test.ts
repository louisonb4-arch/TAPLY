import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../backend/core/config.js';
import { createApp } from '../../../backend/http/app.js';
import { captureLogger } from '../../helpers/capture-logger.js';

afterEach(() => vi.unstubAllEnvs());

const ORIGIN = 'https://taply.example';

function app(env: 'test' | 'production') {
  const { logger } = captureLogger();
  return createApp({ config: loadConfig({ APP_ENV: env, APP_ORIGIN: ORIGIN }), logger });
}

const cases = [
  ['/api/loyalty/scan', { qrToken: 'fake', idempotencyKey: '00000000-0000-4000-8000-000000000001', pin: '123456', purchaseConfirmed: true }],
  ['/api/loyalty/redeem', { qrToken: 'fake', idempotencyKey: '00000000-0000-4000-8000-000000000001', pin: '123456', giftHandedOver: true, expectedCycleNumber: 1 }],
  ['/api/loyalty/devices/approve', { targetMerchantUserId: '00000000-0000-4000-8000-000000000001', ownerEmail: 'owner@taply.test', ownerPassword: 'bad' }],
  ['/api/loyalty/devices/activate', { pairingToken: 'fake', pin: '123456' }],
  ['/api/loyalty/customers/register', { firstName: 'Elodie', programId: '00000000-0000-4000-8000-000000000001', idempotencyKey: '00000000-0000-4000-8000-000000000002', privacyAccepted: true, customerPresent: true, pin: '123456' }],
  ['/api/loyalty/card/status', { qrToken: 'fake', pin: '123456' }],
  ['/api/loyalty/programs/update', { programId: '00000000-0000-4000-8000-000000000001', status: 'active', notificationsEnabled: false, pin: '123456' }],
  ['/api/loyalty/devices/revoke', { deviceId: '00000000-0000-4000-8000-000000000001', pin: '123456' }],
  ['/api/loyalty/cards/rotate', { membershipId: '00000000-0000-4000-8000-000000000001', idempotencyKey: '00000000-0000-4000-8000-000000000002', pin: '123456', customerPresent: true, identityVerifiedInPerson: true }],
] as const;

describe('Loyalty API est fail-closed', () => {
  for (const [path, body] of cases) {
    it(`refuse ${path} en preview non activée, sans interroger de DB`, async () => {
      const res = await app('test').request(path, {
        method: 'POST',
        headers: { Origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SERVICE_UNAVAILABLE');
    });

    it(`refuse ${path} en production même quand le flag est accidentellement activé`, async () => {
      vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
      const res = await app('production').request(path, {
        method: 'POST',
        headers: { Origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(503);
    });

    it(`refuse ${path} avec Origin incorrecte (CSRF)`, async () => {
      vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
      const res = await app('test').request(path, {
        method: 'POST',
        headers: { Origin: 'https://evil.example', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ORIGIN_REJECTED');
    });

    it(`refuse ${path} sans session même en preview`, async () => {
      vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
      const res = await app('test').request(path, {
        method: 'POST',
        headers: { Origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('AUTH_REQUIRED');
    });
  }
});
