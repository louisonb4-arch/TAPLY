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
  ['/api/loyalty/enrollment/confirm', { claimToken: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq', idempotencyKey: '00000000-0000-4000-8000-000000000002', pin: '123456', customerPresent: true, purchaseConfirmed: true }],
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

it('refuse la pré-inscription publique si VERCEL_ENV=production même avec APP_ENV=test', async () => {
  vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
  vi.stubEnv('VERCEL_ENV', 'production');
  const res = await app('test').request('/api/loyalty/enrollment/prepare', {
    method: 'POST',
    headers: { Origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({
      publicToken: 'AAAAAAAAAAAAAAAAAAAAAA',
      firstName: 'Juliette',
      privacyAccepted: true,
    }),
  });
  expect(res.status).toBe(503);
});

it('GET identity: refus sans session même lorsque preview est activée', async () => {
  vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
  const res = await app('test').request('/api/loyalty/identity');
  expect(res.status).toBe(401);
});

it('GET identity: production désactivée', async () => {
  vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
  const res = await app('production').request('/api/loyalty/identity');
  expect(res.status).toBe(503);
});

describe('GET /api/loyalty/security', () => {
  it('est désactivé par défaut', async () => {
    const res = await app('test').request('/api/loyalty/security');
    expect(res.status).toBe(503);
  });

  it('refuse sans session même en mode preview', async () => {
    vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
    const res = await app('test').request('/api/loyalty/security');
    expect(res.status).toBe(401);
  });

  it('est interdit sur Vercel Production même si APP_ENV=test', async () => {
    vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
    vi.stubEnv('VERCEL_ENV', 'production');
    const res = await app('test').request('/api/loyalty/security');
    expect(res.status).toBe(503);
  });
});

describe('GET /api/loyalty/customers', () => {
  it('reste désactivé si preview non activée', async () => {
    const res = await app('test').request('/api/loyalty/customers');
    expect(res.status).toBe(503);
  });
  it('exige une session authentifiée', async () => {
    vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
    const res = await app('test').request('/api/loyalty/customers');
    expect(res.status).toBe(401);
  });
  it('n’est jamais exposé en production', async () => {
    vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
    const res = await app('production').request('/api/loyalty/customers');
    expect(res.status).toBe(503);
  });
});

describe('GET /api/loyalty/merchant', () => {
  it('ne divulgue aucune identité commerçant hors preview', async () => {
    expect((await app('test').request('/api/loyalty/merchant')).status).toBe(503);
  });
  it('exige une session serveur en preview', async () => {
    vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
    expect((await app('test').request('/api/loyalty/merchant')).status).toBe(401);
  });
  it('ne peut pas être activé sur la production Vercel', async () => {
    vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
    vi.stubEnv('VERCEL_ENV', 'production');
    expect((await app('test').request('/api/loyalty/merchant')).status).toBe(503);
  });
});

describe('GET /api/loyalty/home — privacy and feature gates', () => {
  it('is disabled unless preview enabled', async () => {
    expect((await app('test').request('/api/loyalty/home')).status).toBe(503);
  });

  it('requires a server session when preview is enabled', async () => {
    vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
    const response = await app('test').request('/api/loyalty/home');
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('AUTH_REQUIRED');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('cannot be enabled in production', async () => {
    vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
    const response = await app('production').request('/api/loyalty/home');
    expect(response.status).toBe(503);
  });

  it('also rejects Vercel production even when APP_ENV=test', async () => {
    vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
    vi.stubEnv('VERCEL_ENV', 'production');
    const response = await app('test').request('/api/loyalty/home');
    expect(response.status).toBe(503);
  });
});

describe('POST /api/loyalty/devices/approve — activation de son propre appareil', () => {
  const post = (body: unknown) => app('test').request('/api/loyalty/devices/approve', {
    method: 'POST',
    headers: { Origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('accepte le contrat sans identifiant technique, puis exige la session', async () => {
    vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
    const res = await post({ ownerEmail: 'owner@taply.test', ownerPassword: 'secret-not-shared' });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('AUTH_REQUIRED');
  });

  it('rejette un identifiant explicite invalide avant toute authentification', async () => {
    vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
    const res = await post({ ownerEmail: 'owner@taply.test', ownerPassword: 'secret-not-shared', targetMerchantUserId: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });

  it('reste inactif en production même sans identifiant technique', async () => {
    vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
    const res = await app('production').request('/api/loyalty/devices/approve', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ ownerEmail: 'owner@taply.test', ownerPassword: 'secret-not-shared' }),
    });
    expect(res.status).toBe(503);
  });
});

describe('API client /c/* et configuration : portes, CSRF, validation', () => {
  it('refuse l’API client publique avant activation explicite', async () => {
    vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
    const a = await app('test').request('/api/c/program?code=' + 'A'.repeat(32));
    expect(a.status).toBe(503);
    const b = await app('test').request('/api/c/enroll', {
      method:'POST',headers:{Origin:ORIGIN,'content-type':'application/json'},
      body:JSON.stringify({publicToken:'A'.repeat(32)}),
    });
    expect(b.status).toBe(503);
  });

  it('refuse l’API client en production même si les flags preview sont activés', async () => {
    vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
    vi.stubEnv('TAPLY_QR_ANONYMOUS_V1', 'enabled');
    for (const path of ['/api/c/program?code=' + 'A'.repeat(32), '/api/c/cards']) {
      const response = await app('production').request(path);
      expect(response.status).toBe(503);
    }
  });

  it('production : ouverture uniquement avec la décision explicite TAPLY_PRODUCTION_RELEASE', async () => {
    vi.stubEnv('TAPLY_PRODUCTION_RELEASE', 'yes');
    expect((await app('production').request('/api/c/cards')).status).toBe(503);
  });

  it('rejette un code public invalide sans interroger la base', async () => {
    vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
    vi.stubEnv('TAPLY_QR_ANONYMOUS_V1', 'enabled');
    const response = await app('test').request('/api/c/program?code=invalid');
    expect(response.status).toBe(404);
  });

  it('interdit toute mutation client sans Origin exacte (CSRF)', async () => {
    vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
    vi.stubEnv('TAPLY_QR_ANONYMOUS_V1', 'enabled');
    for (const [path, body] of [
      ['/api/c/enroll', { publicToken: 'A'.repeat(32) }],
      ['/api/c/recover', { recoveryCode: 'ABCDE-FGHJK-LMNPQ-RSTUV' }],
      ['/api/c/nfc/tap', { e: '0'.repeat(32), c: '0'.repeat(16) }],
      ['/api/c/recovery', {}],
    ] as const) {
      const response = await app('test').request(path, {
        method:'POST',headers:{Origin:'https://evil.invalid','content-type':'application/json'},
        body:JSON.stringify(body),
      });
      expect(response.status).toBe(403);
    }
  });

  it('le GET d’une URL de puce ne crédite rien : aucune route GET NFC', async () => {
    vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
    vi.stubEnv('TAPLY_QR_ANONYMOUS_V1', 'enabled');
    const response = await app('test').request('/api/c/nfc/tap?e=' + '0'.repeat(32) + '&c=' + '0'.repeat(16));
    expect(response.status).toBe(404);
  });

  it('NFC indisponible sans clé maître serveur', async () => {
    vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
    vi.stubEnv('TAPLY_QR_ANONYMOUS_V1', 'enabled');
    vi.stubEnv('TAPLY_NFC_MASTER_KEY', '');
    const response = await app('test').request('/api/c/nfc/tap', {
      method:'POST',headers:{Origin:ORIGIN,'content-type':'application/json'},
      body:JSON.stringify({ e: '0'.repeat(32), c: '0'.repeat(16) }),
    });
    expect(response.status).toBe(503);
  });

  it('refuse la configuration commerçante sans session', async () => {
    vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
    for (const path of ['/api/loyalty/setup', '/api/loyalty/dashboard', '/api/loyalty/nfc', '/api/billing/status']) {
      const res = await app('test').request(path);
      expect(res.status).toBe(401);
    }
  });

  it('refuse la publication sans session', async () => {
    vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
    const response = await app('test').request('/api/loyalty/setup/publish', {
      method:'POST',headers:{Origin:ORIGIN,'content-type':'application/json'},body:'{}',
    });
    expect(response.status).toBe(401);
  });

  it('refuse un PATCH sans Origin, un seuil hors 3–10 et une liste de récompenses vide', async () => {
    vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
    const payload={threshold:2,rewards:['Un café offert'],rewardTerms:'Conditions',
      cardColor:'#10241A',textColor:'#FFFFFF'};
    const csrf = await app('test').request('/api/loyalty/setup', {
      method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(payload),
    });
    expect(csrf.status).toBe(403);
    for (const bad of [payload, { ...payload, threshold: 11 }, { ...payload, threshold: 5, rewards: [] },
      { ...payload, threshold: 5, rewards: ['a','b','c','d','e','f'] }]) {
      const invalid = await app('test').request('/api/loyalty/setup', {
        method:'PATCH',headers:{Origin:ORIGIN,'content-type':'application/json'},
        body:JSON.stringify(bad),
      });
      expect(invalid.status).toBe(400);
    }
  });

  it('webhook Stripe indisponible sans configuration, sans fuite', async () => {
    const response = await app('test').request('/api/billing/webhook', { method: 'POST', body: '{}' });
    expect(response.status).toBe(503);
  });
});
