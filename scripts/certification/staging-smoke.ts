/**
 * Smoke test du déploiement staging (aucune authentification, aucune donnée
 * créée hormis les journaux de refus) : pages, portes d'API, CSRF, et
 * vérification cryptographique SUN côté serveur avec la clé de staging.
 *
 *   STAGING_URL=https://… TAPLY_NFC_MASTER_KEY_FILE=~/.config/taply/nfc-master-staging-v1.hex \
 *   node --import ./scripts/dev-ts-hooks.mjs scripts/certification/staging-smoke.ts
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { deriveTagKeys, parseNfcMasterKey } from '../../backend/nfc/keys.js';
import { simulateSunUrlParams } from '../../tests/helpers/ntag424-sim.js';

const base = process.env['STAGING_URL'] ?? '';
assert.match(base, /^https:\/\/[a-z0-9.-]+$/, 'STAGING_URL https requis');
let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('PASS', name); } catch (e) { console.error('FAIL', name, (e as Error).message); process.exitCode = 1; }
}
const get = (p: string) => fetch(base + p, { redirect: 'manual' });
const post = (p: string, body: unknown, origin: string | null = base) => fetch(base + p, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
});

await check('API vivante', async () => assert.equal((await get('/api/health')).status, 200));
for (const page of ['/', '/join.html', '/carte.html', '/t', '/dashboard/', '/connexion.html', '/creer-compte.html',
  '/mot-de-passe-oublie.html', '/reinitialiser-mot-de-passe.html', '/dashboard/vendor/jsQR.js', '/js/carte.js']) {
  await check(`page ${page}`, async () => assert.equal((await get(page)).status, 200));
}
await check('aucun code serveur publié', async () => {
  for (const p of ['/backend/nfc/keys.ts', '/supabase/migrations/20261009100004_nfc_tags.sql', '/package.json', '/.env']) {
    assert.equal((await get(p)).status, 404, p);
  }
});
await check('API client ouverte, sans identité', async () => {
  const r = await get('/api/c/cards');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { cards: [], hasRecoveryCode: false, identity: false });
});
await check('code public invalide → 404', async () => assert.equal((await get('/api/c/program?code=invalid')).status, 404));
await check('espace commerçant fermé sans session', async () => {
  for (const p of ['/api/loyalty/dashboard', '/api/loyalty/setup', '/api/loyalty/nfc', '/api/billing/status']) {
    assert.equal((await get(p)).status, 401, p);
  }
});
await check('CSRF : mutation sans Origin refusée', async () =>
  assert.equal((await post('/api/c/nfc/tap', { e: '0'.repeat(32), c: '0'.repeat(16) }, null)).status, 403));
await check('CSRF : Origin étrangère refusée', async () =>
  assert.equal((await post('/api/c/enroll', { publicToken: 'A'.repeat(32) }, 'https://evil.example')).status, 403));
await check('GET sur l’API NFC ne crédite rien (route absente)', async () =>
  assert.equal((await get('/api/c/nfc/tap?e=' + '0'.repeat(32) + '&c=' + '0'.repeat(16))).status, 404));
await check('webhook Stripe indisponible sans configuration', async () =>
  assert.equal((await fetch(base + '/api/billing/webhook', { method: 'POST', body: '{}' })).status, 503));

const keyFile = process.env['TAPLY_NFC_MASTER_KEY_FILE'];
if (keyFile) {
  const master = parseNfcMasterKey(readFileSync(keyFile, 'utf8').trim());
  assert.ok(master, 'clé maître illisible');
  const uid = Buffer.from('04' + Buffer.from(String(Date.now())).toString('hex').slice(-12).toUpperCase(), 'hex');
  const keys = deriveTagKeys(master, uid, 1);
  const genuine = simulateSunUrlParams({ sdmMetaReadKey: keys.sdmMetaReadKey, sdmFileReadKey: keys.sdmFileReadKey, uid, readCtr: 7 });
  await check('SUN authentique (clé staging) : MAC vérifiée, puce inconnue → unknown_tag', async () => {
    const r = await post('/api/c/nfc/tap', genuine);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { status: 'denied', reason: 'unknown_tag' });
  });
  await check('SUN falsifié (MAC modifiée) → invalid', async () => {
    const forged = { e: genuine.e, c: (genuine.c[0] === 'A' ? 'B' : 'A') + genuine.c.slice(1) };
    assert.deepEqual(await (await post('/api/c/nfc/tap', forged)).json(), { status: 'denied', reason: 'invalid' });
  });
  await check('SUN chiffré avec une autre clé → invalid', async () => {
    const other = deriveTagKeys(Buffer.alloc(32, 7), uid, 1);
    const p = simulateSunUrlParams({ sdmMetaReadKey: other.sdmMetaReadKey, sdmFileReadKey: other.sdmFileReadKey, uid, readCtr: 8 });
    assert.deepEqual(await (await post('/api/c/nfc/tap', p)).json(), { status: 'denied', reason: 'invalid' });
  });
}
console.log(process.exitCode ? 'SMOKE STAGING ÉCHOUÉ' : `SMOKE STAGING OK : ${passed} vérifications`);
