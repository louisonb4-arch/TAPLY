/**
 * Banc de démonstration et de test navigateur, 100 % LOCAL (127.0.0.1).
 *
 * - PostgreSQL en mémoire (PGlite) avec TOUTES les migrations du dépôt,
 *   rôle taply_app et RLS forcée : la vraie application Hono tourne dessus.
 * - Un commerce de test est créé via la RPC d'inscription réelle ; Supabase
 *   Auth n'est pas joignable ici : la route /__dev/session ouvre une session
 *   commerçant (cookie HttpOnly) sans mot de passe. Ces routes /__dev/*
 *   n'existent QUE dans ce script, jamais dans backend/ ni sur Vercel.
 * - /__dev/tap simule un téléphone qui lit une puce NTAG 424 DNA programmée
 *   avec les clés Taply (même cryptographie qu'une vraie puce).
 *
 * Données de test locales, perdues à l'arrêt. Usage : npm run dev:e2e
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { buildStatic } from './build-static.mjs';
import { createTestDb } from '../tests/helpers/pglite-db.js';
import { simulateSunUrlParams } from '../tests/helpers/ntag424-sim.js';

const PORT = Number(process.env['PORT'] ?? 4600);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PIN = '482915'; // PIN de l'appareil de test local (valeur de fixture).
const MASTER_HEX = randomBytes(32).toString('hex');
const TAG_UID = Buffer.from('04A1B2C3D4E5F6', 'hex');

Object.assign(process.env, {
  APP_ENV: 'test',
  APP_ORIGIN: ORIGIN,
  TAPLY_LOYALTY_PREVIEW: 'enabled',
  TAPLY_QR_ANONYMOUS_V1: 'enabled',
  TAPLY_BILLING_MODE: process.env['TAPLY_BILLING_MODE'] ?? 'disabled',
  TAPLY_STAFF_PIN_PEPPER: 'local-e2e-pepper-' + randomBytes(16).toString('hex'),
  TAPLY_NFC_MASTER_KEY: MASTER_HEX,
  LOG_LEVEL: 'warn',
});

const { loadConfig } = await import('../backend/core/config.js');
const { createApp } = await import('../backend/http/app.js');
const { createLogger } = await import('../backend/core/logger.js');
const { hashSessionToken } = await import('../backend/auth/token.js');
const { derivePin } = await import('../backend/auth/staff-device.js');
const { deriveTagKeys } = await import('../backend/nfc/keys.js');

buildStatic({ log: () => undefined });
const db = await createTestDb();

async function merchant(name: string, email: string) {
  const authId = randomUUID();
  await db.admin(`insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, $2, now(), $3::jsonb)`,
    [authId, email, JSON.stringify({ taply_onboarding_v1: true, taply_business_name: name })]);
  await db.admin(`select set_config('request.jwt.claim.sub', $1, false)`, [authId]);
  await db.admin('select public.taply_complete_merchant_signup_v1()');
  await db.admin(`select set_config('request.jwt.claim.sub', '', false)`);
  const [owner] = await db.admin<{ id: string; merchant_id: string }>(
    'select id, merchant_id from taply.merchant_users where auth_user_id = $1', [authId]);
  const device = randomBytes(32).toString('base64url');
  const salt = randomBytes(16).toString('hex');
  await db.admin(`insert into taply.staff_devices (merchant_id, merchant_user_id, token_hash, pin_salt, pin_verifier)
    values ($1, $2, $3, $4, $5)`, [owner!.merchant_id, owner!.id,
    createHash('sha256').update('taply:staff:device:v1:' + device).digest('hex'), salt, await derivePin(PIN, salt)]);
  return { authId, ownerId: owner!.id, merchantId: owner!.merchant_id, device };
}

const shops = { owner: await merchant('Café Lumière', 'cafe@taply.local'), other: await merchant('Boulangerie Nord', 'nord@taply.local') };
let counter = 100;

const api = createApp({ config: loadConfig(process.env), logger: createLogger({ level: 'warn' }), dbPool: db.pool });
const app = new Hono();
app.route('/', api as unknown as Hono);

app.get('/__dev/session', async (c) => {
  const who = c.req.query('as') === 'other' ? shops.other : shops.owner;
  const raw = randomBytes(32).toString('base64url');
  await db.admin(`insert into taply.merchant_sessions
      (merchant_id, merchant_user_id, auth_user_id, token_hash, idle_expires_at, absolute_expires_at)
    values ($1, $2, $3, $4, now() + interval '12 hours', now() + interval '12 hours')`,
  [who.merchantId, who.ownerId, who.authId, hashSessionToken(raw)]);
  setCookie(c, 'taply_session', raw, { path: '/', httpOnly: true, sameSite: 'Lax' });
  setCookie(c, 'taply_staff_device', who.device, { path: '/api/loyalty', httpOnly: true, sameSite: 'Strict' });
  return c.redirect('/dashboard/');
});
/** Simule la lecture de la puce par un téléphone : redirige vers l'URL SUN réelle. */
app.get('/__dev/tap', (c) => {
  const keys = deriveTagKeys(Buffer.from(MASTER_HEX, 'hex'), TAG_UID, 1);
  const ctr = c.req.query('replay') === '1' ? counter : ++counter;
  const { e, c: mac } = simulateSunUrlParams({ sdmMetaReadKey: keys.sdmMetaReadKey, sdmFileReadKey: keys.sdmFileReadKey, uid: TAG_UID, readCtr: ctr });
  return c.redirect(`/t?e=${e}&c=${mac}`);
});
/** Avance l'horloge des cartes de 3 h (démonstration du délai de 2 h). */
app.get('/__dev/rewind', async (c) => {
  await db.admin(`update taply.membership_states set last_credited_at = last_credited_at - interval '3 hours'
    where last_credited_at is not null`);
  return c.text('Délai de 2 h écoulé pour toutes les cartes (local).');
});
app.get('/t', (c) => c.html(readFileSync(join('dist', 't.html'), 'utf8')));
app.use('*', serveStatic({ root: 'dist' }));
app.notFound((c) => c.html(readFileSync(join('dist', '404.html'), 'utf8'), 404));

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, () => {
  console.log(`dev:e2e prêt sur ${ORIGIN}`);
  console.log(`  commerçant : ${ORIGIN}/__dev/session   (PIN appareil de test : ${PIN})`);
  console.log(`  NFC simulé : ${ORIGIN}/__dev/tap        délai : ${ORIGIN}/__dev/rewind`);
});
