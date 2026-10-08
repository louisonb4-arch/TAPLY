/**
 * Routes expérimentales de fidélité. Désactivées par défaut et
 * systématiquement interdites en production. NO PAYMENTS.
 *
 * Toutes les mutations: Origin exacte + cookie session HttpOnly + RLS;
 * crédit/remise nécessitent EN PLUS cookie device approuvé + PIN correct
 * + confirmation humaine. Les échecs PIN sont COMMIT sans lever d'erreur
 * à l'intérieur de la transaction (verrouillage effectif).
 */
import { Hono } from 'hono';
import type { Pool } from 'pg';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { AppError } from '../../core/errors.js';
import { getPool } from '../../db/pool.js';
import { getSessionCookie } from '../../auth/cookie.js';
import { SessionInvalidError } from '../../auth/errors.js';
import { withAuthenticatedTx, type AuthenticatedPrincipal } from '../../auth/session.js';
import { createAuthClient } from '../../auth/supabase-client.js';
import { activateStaffDevice, authorizeStaffAction, createStaffDevicePairing } from '../../auth/staff-device.js';
import { scanWalletQrAndCredit } from '../../loyalty/scan.js';
import { resolveWalletQrToken } from '../../loyalty/qr-token.js';
import { redeemReward } from '../../loyalty/redeem.js';
import { registerCustomer, getLoyaltyCard, merchantOverview, updateMerchantProgram } from '../../loyalty/operations.js';
import { rotateWalletQr } from '../../loyalty/rotation.js';
import { originCheck } from '../origin.js';
import type { AppEnvBindings } from '../types.js';

export const loyaltyRoutes = new Hono<AppEnvBindings>();
const DEVICE_COOKIE = 'taply_staff_device';

const scanSchema = z.strictObject({
  qrToken: z.string().min(1).max(128),
  idempotencyKey: z.uuid(),
  pin: z.string().regex(/^\d{6,10}$/),
  purchaseConfirmed: z.literal(true),
});
const redeemSchema = z.strictObject({
  qrToken: z.string().min(1).max(128),
  idempotencyKey: z.uuid(),
  expectedCycleNumber: z.number().int().min(1).max(1_000_000),
  pin: z.string().regex(/^\d{6,10}$/),
  giftHandedOver: z.literal(true),
});
const approveSchema = z.strictObject({
  targetMerchantUserId: z.uuid(),
  ownerEmail: z.email().max(255),
  ownerPassword: z.string().min(1).max(512),
});
const activateSchema = z.strictObject({
  pairingToken: z.string().min(1).max(128),
  pin: z.string().regex(/^\d{6,10}$/),
});

function checkPreview(c: { get(name: 'config'): { appEnv: string } }): void {
  if (c.get('config').appEnv === 'production' || process.env['TAPLY_LOYALTY_PREVIEW'] !== 'enabled') {
    throw new AppError('SERVICE_UNAVAILABLE');
  }
}

async function parseBody<T>(c: { req: { json(): Promise<unknown> } }, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw new AppError('VALIDATION_FAILED'); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED');
  return parsed.data;
}

async function authenticated<T>(
  c: { get(name: 'config'): { appEnv: string; auth: { sessionIdleSeconds: number } }; get(name: 'dbPool'): Pool | undefined },
  token: string | undefined,
  fn: Parameters<typeof withAuthenticatedTx<T>>[3],
): Promise<T> {
  if (!token) throw new AppError('AUTH_REQUIRED');
  try {
    return await withAuthenticatedTx(c.get('dbPool') ?? getPool(), token, c.get('config').auth.sessionIdleSeconds, fn);
  } catch (err) {
    if (err instanceof SessionInvalidError) throw new AppError('AUTH_REQUIRED');
    throw err;
  }
}

async function ownerPasswordValid(
  principal: AuthenticatedPrincipal,
  email: string,
  password: string,
): Promise<boolean> {
  const auth = createAuthClient();
  try {
    const { data, error } = await auth.auth.signInWithPassword({ email, password });
    return !error && data.user?.id === principal.authUserId;
  } finally {
    await auth.auth.signOut({ scope: 'local' }).catch(() => {});
  }
}

loyaltyRoutes.post('/loyalty/devices/approve', originCheck, async (c) => {
  checkPreview(c);
  const body = await parseBody(c, approveSchema);
  const cookie = getSessionCookie(c, c.get('config').appEnv);
  const result = await authenticated(c, cookie, async (client, principal) => {
    if (principal.role !== 'owner') return undefined;
    if (!await ownerPasswordValid(principal, body.ownerEmail, body.ownerPassword)) return undefined;
    return createStaffDevicePairing(client, principal, body.targetMerchantUserId);
  });
  if (!result) throw new AppError('AUTH_FORBIDDEN');
  return c.json({ pairingToken: result, expiresInSeconds: 300 }, 200);
});

loyaltyRoutes.post('/loyalty/devices/activate', originCheck, async (c) => {
  checkPreview(c);
  const body = await parseBody(c, activateSchema);
  const cookie = getSessionCookie(c, c.get('config').appEnv);
  const device = await authenticated(c, cookie, (client, principal) =>
    activateStaffDevice(client, principal, body.pairingToken, body.pin));
  if (!device) throw new AppError('AUTH_FORBIDDEN');

  setCookie(c, DEVICE_COOKIE, device.rawDeviceToken, {
    path: '/api/loyalty', httpOnly: true, sameSite: 'Strict',
    secure: c.get('config').appEnv === 'staging',
    maxAge: 30 * 24 * 3600,
  });
  return c.json({ deviceId: device.deviceId, approved: true }, 200);
});

loyaltyRoutes.post('/loyalty/scan', originCheck, async (c) => {
  checkPreview(c);
  const body = await parseBody(c, scanSchema);
  const cookie = getSessionCookie(c, c.get('config').appEnv);
  const deviceToken = getCookie(c, DEVICE_COOKIE);
  const operation = await authenticated(c, cookie, async (client, principal) => {
    const authorized = await authorizeStaffAction(client, principal, deviceToken, body.pin);
    if (!authorized) return { authorized: false as const };
    const result = await scanWalletQrAndCredit(client, principal, body.qrToken, body.idempotencyKey);
    return { authorized: true as const, result };
  });
  if (!operation.authorized) throw new AppError('AUTH_FORBIDDEN');
  return c.json(operation.result);
});

loyaltyRoutes.post('/loyalty/redeem', originCheck, async (c) => {
  checkPreview(c);
  const body = await parseBody(c, redeemSchema);
  const cookie = getSessionCookie(c, c.get('config').appEnv);
  const deviceToken = getCookie(c, DEVICE_COOKIE);
  const operation = await authenticated(c, cookie, async (client, principal) => {
    const authorized = await authorizeStaffAction(client, principal, deviceToken, body.pin);
    if (!authorized) return { authorized: false as const };
    const membershipId = await resolveWalletQrToken(client, principal, body.qrToken);
    if (!membershipId) return { authorized: true as const, result: { redeemed: false as const, reason: { kind: 'qr_invalid' as const } } };
    const result = await redeemReward(client, principal, {
      membershipId,
      idempotencyKey: body.idempotencyKey,
      expectedCycleNumber: body.expectedCycleNumber,
    });
    return { authorized: true as const, result };
  });
  if (!operation.authorized) throw new AppError('AUTH_FORBIDDEN');
  return c.json(operation.result);
});

const registerSchema = z.strictObject({
  firstName: z.string().trim().min(1).max(40),
  programId: z.uuid(),
  idempotencyKey: z.uuid(),
  privacyAccepted: z.literal(true),
  customerPresent: z.literal(true),
  pin: z.string().regex(/^\d{6,10}$/),
});
const statusSchema = z.strictObject({
  qrToken: z.string().min(1).max(128),
  pin: z.string().regex(/^\d{6,10}$/),
});
const programSchema = z.strictObject({
  programId: z.uuid(),
  status: z.enum(['active', 'paused']),
  notificationsEnabled: z.boolean(),
  threshold: z.number().int().min(3).max(10).optional(),
  pin: z.string().regex(/^\d{6,10}$/),
});

loyaltyRoutes.get('/loyalty/overview', async (c) => {
  checkPreview(c);
  const cookie = getSessionCookie(c, c.get('config').appEnv);
  const operation = await authenticated(c, cookie, async (client, principal) => {
    if (principal.role !== 'owner') return undefined;
    return merchantOverview(client, principal);
  });
  if (operation === undefined) throw new AppError('AUTH_FORBIDDEN');
  return c.json({ programs: operation });
});

// Staff at counter creates the card; no public anonymous endpoint until a
// durable anti-abuse solution, individual consent and ownership recovery exist.
// No visit is credited on registration.
loyaltyRoutes.post('/loyalty/customers/register', originCheck, async (c) => {
  checkPreview(c);
  const body = await parseBody(c, registerSchema);
  const cookie = getSessionCookie(c, c.get('config').appEnv);
  const rawDeviceToken = getCookie(c, DEVICE_COOKIE);
  const operation = await authenticated(c, cookie, async (client, principal) => {
    if (!await authorizeStaffAction(client, principal, rawDeviceToken, body.pin)) {
      return { authorized: false as const };
    }
    const result = await registerCustomer(client, principal, {
      firstName: body.firstName,
      programId: body.programId,
      idempotencyKey: body.idempotencyKey,
      privacyAccepted: body.privacyAccepted,
    });
    return { authorized: true as const, result };
  });
  if (!operation.authorized) throw new AppError('AUTH_FORBIDDEN');
  if (!operation.result) throw new AppError('VALIDATION_FAILED');
  return c.json(operation.result, 201);
});

// QR is intentionally never accepted as a URL query parameter: avoids leaking
// bearer tokens into reverse proxy logs, Referer and browser histories.
loyaltyRoutes.post('/loyalty/card/status', originCheck, async (c) => {
  checkPreview(c);
  const body = await parseBody(c, statusSchema);
  const cookie = getSessionCookie(c, c.get('config').appEnv);
  const device = getCookie(c, DEVICE_COOKIE);
  const operation = await authenticated(c, cookie, async (client, principal) => {
    if (!await authorizeStaffAction(client, principal, device, body.pin)) {
      return { authorized: false as const };
    }
    const result = await getLoyaltyCard(client, principal, body.qrToken);
    return { authorized: true as const, result };
  });
  if (!operation.authorized) throw new AppError('AUTH_FORBIDDEN');
  if (!operation.result) throw new AppError('NOT_FOUND');
  return c.json({ card: operation.result });
});

loyaltyRoutes.post('/loyalty/programs/update', originCheck, async (c) => {
  checkPreview(c);
  const body = await parseBody(c, programSchema);
  const cookie = getSessionCookie(c, c.get('config').appEnv);
  const device = getCookie(c, DEVICE_COOKIE);
  const operation = await authenticated(c, cookie, async (client, principal) => {
    if (principal.role !== 'owner') return { authorized: false as const };
    if (!await authorizeStaffAction(client, principal, device, body.pin)) {
      return { authorized: false as const };
    }
    const result = await updateMerchantProgram(client, principal, {
      programId: body.programId,
      status: body.status,
      notificationsEnabled: body.notificationsEnabled,
      ...(body.threshold === undefined ? {} : { threshold: body.threshold }),
    });
    return { authorized: true as const, result };
  });
  if (!operation.authorized) throw new AppError('AUTH_FORBIDDEN');
  if (!operation.result.ok) return c.json({ updated: false, reason: operation.result.reason }, 409);
  return c.json({ updated: true, nextThreshold: operation.result.nextThreshold });
});

const revokeSchema = z.strictObject({
  deviceId: z.uuid(),
  pin: z.string().regex(/^\d{6,10}$/),
});

// Owner can invalidate a stolen device immediately. Revoked cookie is useless.
loyaltyRoutes.post('/loyalty/devices/revoke', originCheck, async (c) => {
  checkPreview(c);
  const body = await parseBody(c, revokeSchema);
  const cookie = getSessionCookie(c, c.get('config').appEnv);
  const deviceToken = getCookie(c, DEVICE_COOKIE);
  const operation = await authenticated(c, cookie, async (client, principal) => {
    if (principal.role !== 'owner') return { authorized: false as const };
    if (!await authorizeStaffAction(client, principal, deviceToken, body.pin)) {
      return { authorized: false as const };
    }
    const updated = await client.query(
      `update taply.staff_devices set revoked_at=now()
       where id=$1 and merchant_id=$2 and revoked_at is null`,
      [body.deviceId, principal.merchantId],
    );
    return { authorized: true as const, revoked: updated.rowCount === 1 };
  });
  if (!operation.authorized) throw new AppError('AUTH_FORBIDDEN');
  return c.json({ revoked: operation.revoked });
});

const rotateSchema = z.strictObject({
  membershipId: z.uuid(),
  idempotencyKey: z.uuid(),
  pin: z.string().regex(/^\d{6,10}$/),
  customerPresent: z.literal(true),
  identityVerifiedInPerson: z.literal(true),
});

// Replaces a compromised/lost card. The old QR stops working immediately.
// Customer identity verification is a human business process, NOT cryptographic.
loyaltyRoutes.post('/loyalty/cards/rotate', originCheck, async (c) => {
  checkPreview(c);
  const body = await parseBody(c, rotateSchema);
  const cookie = getSessionCookie(c, c.get('config').appEnv);
  const deviceToken = getCookie(c, DEVICE_COOKIE);
  const operation = await authenticated(c, cookie, async (client, principal) => {
    if (!await authorizeStaffAction(client, principal, deviceToken, body.pin)) {
      return { authorized: false as const };
    }
    const result = await rotateWalletQr(client, principal, {
      membershipId: body.membershipId,
      idempotencyKey: body.idempotencyKey,
    });
    return { authorized: true as const, result };
  });
  if (!operation.authorized) throw new AppError('AUTH_FORBIDDEN');
  if (!operation.result) throw new AppError('NOT_FOUND');
  return c.json(operation.result);
});
