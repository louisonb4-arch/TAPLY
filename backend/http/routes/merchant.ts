/**
 * Espace commerçant : configuration du programme, tableau de bord,
 * comptoir (lecture de carte), supports NFC.
 *
 * Toujours : cookie de session HttpOnly + RLS tenant ; mutations avec
 * Origin exacte. Les écritures contractuelles et opérationnelles exigent
 * le rôle propriétaire et/ou un appareil approuvé (PIN ou fenêtre de
 * déverrouillage), et un abonnement autorisant l'opération.
 */
import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { PoolClient } from 'pg';
import QRCode from 'qrcode';
import { z } from 'zod';
import { AppError } from '../../core/errors.js';
import { getSessionCookie } from '../../auth/cookie.js';
import { SessionInvalidError } from '../../auth/errors.js';
import { withAuthenticatedTx, type AuthenticatedPrincipal } from '../../auth/session.js';
import { DEVICE_UNLOCK_MINUTES, authorizeStaffAction } from '../../auth/staff-device.js';
import {
  publishMerchantSetup, readMerchantSetup, saveMerchantSetup, updateAppearance,
  updatePreferences, updateProgramContract,
} from '../../loyalty/merchant-setup.js';
import { MAX_REWARDS } from '../../loyalty/program-rules.js';
import {
  counterCardView, customerHistory, customerList, dashboardStats, nfcTagEvents, nfcTagsView, rewardsBoard,
} from '../../loyalty/merchant-views.js';
import { resolveWalletQrToken } from '../../loyalty/qr-token.js';
import { canOperate, merchantAccess } from '../../billing/access.js';
import { cancelPairing, openPairing, setTagStatus } from '../../nfc/admin.js';
import { nfcKeyConfig } from '../../nfc/tap.js';
import { originCheck } from '../origin.js';
import { checkLoyalty, dbPool } from '../gates.js';
import type { AppEnvBindings } from '../types.js';

export const merchantRoutes = new Hono<AppEnvBindings>();
export const DEVICE_COOKIE = 'taply_staff_device';

type C = Context<AppEnvBindings>;

const pin = z.string().regex(/^\d{6,10}$/);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const rewardTitle = z.string().trim().min(2).max(120);

async function json<T>(c: C, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw new AppError('VALIDATION_FAILED'); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED');
  return parsed.data;
}

export async function asMerchant<T>(
  c: C, fn: (client: PoolClient, principal: AuthenticatedPrincipal) => Promise<T>,
): Promise<T> {
  checkLoyalty(c);
  const token = getSessionCookie(c, c.get('config').appEnv);
  if (!token) throw new AppError('AUTH_REQUIRED');
  try {
    return await withAuthenticatedTx(dbPool(c), token, c.get('config').auth.sessionIdleSeconds, fn);
  } catch (error) {
    if (error instanceof SessionInvalidError) throw new AppError('AUTH_REQUIRED');
    throw error;
  }
}

function ownerOnly(principal: AuthenticatedPrincipal): void {
  if (principal.role !== 'owner') throw new AppError('AUTH_FORBIDDEN');
}

function appOrigin(c: C): string {
  const origin = c.get('config').auth.appOrigin;
  if (!origin) throw new AppError('SERVICE_UNAVAILABLE');
  return origin;
}

// ── Tableau de bord ─────────────────────────────────────────────────

merchantRoutes.get('/loyalty/dashboard', async (c) => {
  const data = await asMerchant(c, async (client, principal) => {
    const stats = await dashboardStats(client, principal);
    const access = await merchantAccess(client, principal.merchantId);
    const merchant = await client.query<{ name: string; city: string | null }>(
      'select name, city from taply.merchants where id = $1', [principal.merchantId]);
    return { ...stats, billing: access, merchant: merchant.rows[0] ?? null, role: principal.role };
  });
  return c.json(data);
});

// ── Programme : brouillon, publication, contrat, apparence ──────────

merchantRoutes.get('/loyalty/setup', async (c) => {
  const origin = appOrigin(c);
  const setup = await asMerchant(c, async (client, principal) => {
    ownerOnly(principal);
    const data = await readMerchantSetup(client, principal, origin);
    if (!data) return undefined;
    return { ...data, billing: await merchantAccess(client, principal.merchantId),
      nfcAvailable: nfcKeyConfig() !== undefined };
  });
  if (!setup) throw new AppError('NOT_FOUND');
  return c.json(setup);
});

const draftSchema = z.strictObject({
  threshold: z.number().int().min(3).max(10),
  rewards: z.array(rewardTitle).min(1).max(MAX_REWARDS),
  rewardTerms: z.string().trim().max(2000),
  cardColor: hexColor,
  textColor: hexColor,
});

merchantRoutes.patch('/loyalty/setup', originCheck, async (c) => {
  const body = await json(c, draftSchema);
  const status = await asMerchant(c, (client, principal) => {
    ownerOnly(principal);
    return saveMerchantSetup(client, principal, body);
  });
  if (status === 'not_found') throw new AppError('NOT_FOUND');
  if (status === 'locked') return c.json({ saved: false, reason: 'published' }, 409);
  if (status === 'invalid') return c.json({ saved: false, reason: 'duplicate_rewards' }, 422);
  return c.json({ saved: true });
});

merchantRoutes.post('/loyalty/setup/publish', originCheck, async (c) => {
  const result = await asMerchant(c, async (client, principal) => {
    ownerOnly(principal);
    if (!canOperate((await merchantAccess(client, principal.merchantId)).level)) return 'billing' as const;
    return publishMerchantSetup(client, principal);
  });
  if (result === 'billing') return c.json({ published: false, reason: 'subscription_required' }, 402);
  if (result === 'not_found') throw new AppError('NOT_FOUND');
  if (result !== 'published') return c.json({ published: false, reason: 'incomplete' }, 422);
  return c.json({ published: true });
});

merchantRoutes.get('/loyalty/setup/qr.svg', async (c) => {
  const origin = appOrigin(c);
  const setup = await asMerchant(c, (client, principal) => {
    ownerOnly(principal);
    return readMerchantSetup(client, principal, origin);
  });
  if (!setup?.enrollmentUrl) throw new AppError('NOT_FOUND');
  const svg = await QRCode.toString(setup.enrollmentUrl, { type: 'svg', errorCorrectionLevel: 'H', margin: 3, width: 640 });
  c.header('Content-Type', 'image/svg+xml; charset=utf-8');
  if (c.req.query('download') === '1') c.header('Content-Disposition', 'attachment; filename="taply-qr-commerce.svg"');
  return c.body(svg);
});

merchantRoutes.put('/loyalty/program/contract', originCheck, async (c) => {
  const body = await json(c, z.strictObject({
    threshold: z.number().int().min(3).max(10),
    rewards: z.array(rewardTitle).min(1).max(MAX_REWARDS),
    reason: z.string().trim().max(200).optional(),
  }));
  const result = await asMerchant(c, (client, principal) => {
    ownerOnly(principal);
    return updateProgramContract(client, principal, {
      threshold: body.threshold, rewards: body.rewards, ...(body.reason ? { reason: body.reason } : {}),
    });
  });
  switch (result.status) {
    case 'updated': return c.json(result);
    case 'unchanged': return c.json(result);
    case 'too_soon': return c.json(result, 409);
    case 'not_published': return c.json(result, 409);
    case 'invalid': return c.json(result, 422);
    case 'not_found': throw new AppError('NOT_FOUND');
  }
});

merchantRoutes.patch('/loyalty/program/appearance', originCheck, async (c) => {
  const body = await json(c, z.strictObject({
    merchantName: z.string().trim().min(2).max(80).refine((n) => !/[\x00-\x1F\x7F]/.test(n)),
    city: z.string().trim().max(80).transform((v) => v || null).nullable(),
    rewardTerms: z.string().trim().max(2000),
    cardColor: hexColor,
    textColor: hexColor,
  }));
  const status = await asMerchant(c, (client, principal) => {
    ownerOnly(principal);
    return updateAppearance(client, principal, body);
  });
  if (status === 'not_found') throw new AppError('NOT_FOUND');
  return c.json({ saved: true });
});

merchantRoutes.patch('/loyalty/program/preferences', originCheck, async (c) => {
  const body = await json(c, z.strictObject({
    nfcAutoEnabled: z.boolean(), notifyRewardUnlocked: z.boolean(), notificationsEnabled: z.boolean(),
  }));
  const status = await asMerchant(c, (client, principal) => {
    ownerOnly(principal);
    return updatePreferences(client, principal, body);
  });
  if (status === 'not_found') throw new AppError('NOT_FOUND');
  if (status === 'nfc_requires_active_tag') return c.json({ saved: false, reason: status }, 409);
  return c.json({ saved: true });
});

// ── Clients et récompenses ──────────────────────────────────────────

merchantRoutes.get('/loyalty/customers', async (c) => {
  const search = c.req.query('q');
  const customers = await asMerchant(c, (client, principal) => customerList(client, principal, search));
  return c.json({ customers, limit: 100 });
});

merchantRoutes.get('/loyalty/customers/:id/history', async (c) => {
  const id = z.uuid().safeParse(c.req.param('id'));
  if (!id.success) throw new AppError('NOT_FOUND');
  const history = await asMerchant(c, (client, principal) => customerHistory(client, principal, id.data));
  if (!history) throw new AppError('NOT_FOUND');
  return c.json({ history });
});

merchantRoutes.get('/loyalty/rewards', async (c) => {
  return c.json(await asMerchant(c, (client, principal) => rewardsBoard(client, principal)));
});

// ── Comptoir ─────────────────────────────────────────────────────────

merchantRoutes.post('/loyalty/devices/unlock', originCheck, async (c) => {
  const body = await json(c, z.strictObject({ pin }));
  const ok = await asMerchant(c, (client, principal) =>
    authorizeStaffAction(client, principal, getCookie(c, DEVICE_COOKIE), body.pin));
  if (!ok) throw new AppError('AUTH_FORBIDDEN', { userMessage: 'Appareil non approuvé ou code PIN incorrect.' });
  return c.json({ unlocked: true, minutes: DEVICE_UNLOCK_MINUTES });
});

/** Lecture d'une carte scannée : vérifie, affiche, NE crédite PAS. */
merchantRoutes.post('/loyalty/card/lookup', originCheck, async (c) => {
  const body = await json(c, z.strictObject({ qrToken: z.string().min(1).max(128), pin: pin.optional() }));
  const result = await asMerchant(c, async (client, principal) => {
    if (!await authorizeStaffAction(client, principal, getCookie(c, DEVICE_COOKIE), body.pin)) {
      return { authorized: false as const };
    }
    const membershipId = await resolveWalletQrToken(client, principal, body.qrToken);
    if (!membershipId) return { authorized: true as const, card: undefined };
    return { authorized: true as const, card: await counterCardView(client, principal, membershipId) };
  });
  if (!result.authorized) throw new AppError('AUTH_FORBIDDEN', { userMessage: 'Déverrouillez cet appareil avec votre code PIN.' });
  if (!result.card) return c.json({ found: false, reason: 'qr_invalid_or_expired' }, 404);
  return c.json({ found: true, card: result.card });
});

// ── Supports NFC ─────────────────────────────────────────────────────

merchantRoutes.get('/loyalty/nfc', async (c) => {
  const data = await asMerchant(c, (client, principal) => {
    ownerOnly(principal);
    return nfcTagsView(client, principal);
  });
  return c.json({ ...data, serverKeysConfigured: nfcKeyConfig() !== undefined });
});

merchantRoutes.post('/loyalty/nfc/pairing', originCheck, async (c) => {
  const body = await json(c, z.strictObject({
    label: z.string().trim().min(1).max(60), replacesTagId: z.uuid().optional(),
  }));
  if (!nfcKeyConfig()) throw new AppError('SERVICE_UNAVAILABLE', { userMessage: 'Clés NFC serveur non configurées.' });
  const result = await asMerchant(c, (client, principal) =>
    openPairing(client, principal, { label: body.label, ...(body.replacesTagId ? { replacesTagId: body.replacesTagId } : {}) }));
  if (result === 'forbidden') throw new AppError('AUTH_FORBIDDEN');
  if (result === 'not_found') throw new AppError('NOT_FOUND');
  return c.json({ pairing: true, ...result });
});

merchantRoutes.post('/loyalty/nfc/pairing/cancel', originCheck, async (c) => {
  await asMerchant(c, (client, principal) => {
    ownerOnly(principal);
    return cancelPairing(client, principal);
  });
  return c.json({ cancelled: true });
});

merchantRoutes.post('/loyalty/nfc/tags/:id/status', originCheck, async (c) => {
  const id = z.uuid().safeParse(c.req.param('id'));
  if (!id.success) throw new AppError('NOT_FOUND');
  const body = await json(c, z.strictObject({ status: z.enum(['active', 'disabled', 'compromised', 'retired']) }));
  const result = await asMerchant(c, (client, principal) => setTagStatus(client, principal, id.data, body.status));
  if (result === 'forbidden') throw new AppError('AUTH_FORBIDDEN');
  if (result === 'not_found') throw new AppError('NOT_FOUND');
  if (result === 'invalid_transition') return c.json({ updated: false, reason: result }, 409);
  return c.json({ updated: true });
});

merchantRoutes.get('/loyalty/nfc/tags/:id/events', async (c) => {
  const id = z.uuid().safeParse(c.req.param('id'));
  if (!id.success) throw new AppError('NOT_FOUND');
  const events = await asMerchant(c, (client, principal) => {
    ownerOnly(principal);
    return nfcTagEvents(client, principal, id.data);
  });
  return c.json({ events });
});
