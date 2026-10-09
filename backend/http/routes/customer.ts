/**
 * API client publique /api/c/* — carte de fidélité sans compte.
 *
 * Aucune donnée personnelle demandée. L'identité anonyme est un cookie
 * HttpOnly (taply_cid) ; le commerce est toujours résolu côté serveur
 * (lien public exact, puce NFC authentifiée, ou lien identité→carte).
 * Aucune de ces routes ne crédite un passage, SAUF /c/nfc/tap qui exige un
 * message SUN cryptographiquement valide et un compteur jamais consommé.
 * Toutes les mutations : POST + vérification Origin exacte.
 */
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { PoolClient } from 'pg';
import QRCode from 'qrcode';
import { z } from 'zod';
import { AppError } from '../../core/errors.js';
import { withTx } from '../../db/tenant-context.js';
import { resolvePublicEnrollmentLink } from '../../db/lookup.js';
import {
  IDENTITY_COOKIE, IDENTITY_NONCE_COOKIE, IDENTITY_SESSION_DAYS, NONCE_TTL_SECONDS,
  ensureIdentity, formatRecoveryCode, isOpaqueToken, issueRecoveryCode, newOpaqueToken,
  recoverIdentity, resolveIdentity, revokeCurrentSession, revokeRecoveryCode,
} from '../../customer/identity.js';
import {
  cardHistory, cardView, chooseReward, enrollCard, findIdentityCard, identityCardRefs,
  presentCardQr, publicProgramView,
} from '../../customer/cards.js';
import { canOperate, merchantAccess } from '../../billing/access.js';
import { clientIp, hashClientIp } from '../../security/rate-limit.js';
import { handleNfcTap, nfcKeyConfig } from '../../nfc/tap.js';
import { getSessionCookie } from '../../auth/cookie.js';
import { originCheck } from '../origin.js';
import { checkCustomerApi, dbPool, secureCookies } from '../gates.js';
import type { AppEnvBindings } from '../types.js';

export const customerRoutes = new Hono<AppEnvBindings>();

const publicCode = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
const membershipParam = z.uuid();

type C = Context<AppEnvBindings>;

function ipHash(c: C): string {
  return hashClientIp(clientIp((name) => c.req.header(name)));
}

function writeIdentityCookie(c: C, raw: string): void {
  setCookie(c, IDENTITY_COOKIE, raw, {
    path: '/api', httpOnly: true, sameSite: 'Lax',
    secure: secureCookies(c.get('config').appEnv), maxAge: IDENTITY_SESSION_DAYS * 86_400,
  });
}

function ensureNonceCookie(c: C): void {
  if (isOpaqueToken(getCookie(c, IDENTITY_NONCE_COOKIE))) return;
  setCookie(c, IDENTITY_NONCE_COOKIE, newOpaqueToken(), {
    path: '/api', httpOnly: true, sameSite: 'Lax',
    secure: secureCookies(c.get('config').appEnv), maxAge: NONCE_TTL_SECONDS,
  });
}

async function json<T>(c: C, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw new AppError('VALIDATION_FAILED'); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED');
  return parsed.data;
}

async function setMerchant(client: PoolClient, merchantId: string): Promise<void> {
  await client.query('select set_config($1, $2, true)', ['app.merchant_id', merchantId]);
}

/** Commerce d'une carte appartenant à l'identité, sinon undefined. */
async function ownedCardMerchant(client: PoolClient, identityId: string, membershipId: string): Promise<string | undefined> {
  const result = await client.query<{ merchant_id: string }>(
    `select merchant_id from taply.identity_memberships where identity_id = $1 and membership_id = $2`,
    [identityId, membershipId],
  );
  return result.rows[0]?.merchant_id;
}

async function qrSvg(token: string): Promise<string> {
  return QRCode.toString(token, { type: 'svg', margin: 2, width: 360, errorCorrectionLevel: 'M' });
}

/** Programme d'un QR commerçant (lecture seule) + carte de ce navigateur si elle existe. */
customerRoutes.get('/c/program', async (c) => {
  checkCustomerApi(c);
  const code = c.req.query('code') ?? '';
  if (!publicCode.safeParse(code).success) throw new AppError('NOT_FOUND');
  const pool = dbPool(c);
  const target = await resolvePublicEnrollmentLink(pool, code);
  if (!target) throw new AppError('NOT_FOUND');
  const data = await withTx(pool, async (client) => {
    await setMerchant(client, target.merchantId);
    const program = await publicProgramView(client, target.merchantId, target.programId);
    if (!program) return undefined;
    const access = await merchantAccess(client, target.merchantId);
    const identity = await resolveIdentity(client, getCookie(c, IDENTITY_COOKIE));
    const membershipId = identity ? await findIdentityCard(client, identity.identityId, target.programId) : undefined;
    const card = membershipId ? await cardView(client, target.merchantId, membershipId) : undefined;
    return { program, card: card ?? null, enrollmentOpen: canOperate(access.level),
      identity: identity ? { hasRecoveryCode: identity.hasRecoveryCode } : null };
  });
  if (!data) throw new AppError('NOT_FOUND');
  if (!data.identity) ensureNonceCookie(c);
  return c.json(data);
});

/** Crée la carte (0 passage). Aucun passage n'est jamais attribué ici. */
customerRoutes.post('/c/enroll', originCheck, async (c) => {
  checkCustomerApi(c);
  const body = await json(c, z.strictObject({ publicToken: publicCode }));
  const pool = dbPool(c);
  const target = await resolvePublicEnrollmentLink(pool, body.publicToken);
  if (!target) throw new AppError('NOT_FOUND');
  const ip = ipHash(c);
  const result = await withTx(pool, async (client) => {
    await setMerchant(client, target.merchantId);
    const program = await publicProgramView(client, target.merchantId, target.programId);
    if (!program) return { status: 'not_published' as const };
    if (!canOperate((await merchantAccess(client, target.merchantId)).level)) return { status: 'closed' as const };
    const ensured = await ensureIdentity(client, getCookie(c, IDENTITY_COOKIE), getCookie(c, IDENTITY_NONCE_COOKIE), ip);
    if (ensured.status === 'rate_limited') return { status: 'rate_limited' as const };
    const enrolled = await enrollCard(client, {
      identityId: ensured.identity.identityId, merchantId: target.merchantId, programId: target.programId, ipHash: ip,
    });
    const token = ensured.status === 'existing' ? undefined : ensured.rawToken;
    if (!('membershipId' in enrolled)) return { status: enrolled.status, token };
    const card = await cardView(client, target.merchantId, enrolled.membershipId);
    return { status: enrolled.status, card, token };
  });
  if ('token' in result && result.token) writeIdentityCookie(c, result.token);
  if (result.status === 'rate_limited') throw new AppError('RATE_LIMITED');
  if (result.status === 'not_published' || result.status === 'closed') {
    throw new AppError('SERVICE_UNAVAILABLE', { userMessage: 'Ce programme n’accepte pas de nouvelles cartes pour le moment.' });
  }
  if (!('card' in result) || !result.card) throw new AppError('INTERNAL_ERROR');
  return c.json({ created: result.status === 'created', card: result.card });
});

/** Toutes les cartes de ce navigateur (plusieurs commerces). */
customerRoutes.get('/c/cards', async (c) => {
  checkCustomerApi(c);
  const data = await withTx(dbPool(c), async (client) => {
    const identity = await resolveIdentity(client, getCookie(c, IDENTITY_COOKIE));
    if (!identity) return undefined;
    const cards = [];
    for (const ref of await identityCardRefs(client, identity.identityId)) {
      await setMerchant(client, ref.merchantId);
      const card = await cardView(client, ref.merchantId, ref.membershipId);
      if (card) cards.push(card);
    }
    return { cards, hasRecoveryCode: identity.hasRecoveryCode };
  });
  if (!data) return c.json({ cards: [], hasRecoveryCode: false, identity: false });
  return c.json({ ...data, identity: true });
});

customerRoutes.get('/c/cards/:id', async (c) => {
  checkCustomerApi(c);
  const id = membershipParam.safeParse(c.req.param('id'));
  if (!id.success) throw new AppError('NOT_FOUND');
  const data = await withTx(dbPool(c), async (client) => {
    const identity = await resolveIdentity(client, getCookie(c, IDENTITY_COOKIE));
    if (!identity) return undefined;
    const merchantId = await ownedCardMerchant(client, identity.identityId, id.data);
    if (!merchantId) return undefined;
    await setMerchant(client, merchantId);
    const card = await cardView(client, merchantId, id.data);
    if (!card) return undefined;
    return { card, history: await cardHistory(client, merchantId, id.data) };
  });
  if (!data) throw new AppError('NOT_FOUND');
  return c.json(data);
});

/** QR personnel temporaire (15 min). Le présenter ne crédite rien. */
customerRoutes.post('/c/cards/:id/qr', originCheck, async (c) => {
  checkCustomerApi(c);
  const id = membershipParam.safeParse(c.req.param('id'));
  if (!id.success) throw new AppError('NOT_FOUND');
  const data = await withTx(dbPool(c), async (client) => {
    const identity = await resolveIdentity(client, getCookie(c, IDENTITY_COOKIE));
    if (!identity) return undefined;
    const merchantId = await ownedCardMerchant(client, identity.identityId, id.data);
    if (!merchantId) return undefined;
    await setMerchant(client, merchantId);
    return presentCardQr(client, merchantId, id.data);
  });
  if (!data) throw new AppError('NOT_FOUND');
  return c.json({ ...data, qrSvg: await qrSvg(data.qrToken) });
});

customerRoutes.post('/c/cards/:id/reward', originCheck, async (c) => {
  checkCustomerApi(c);
  const id = membershipParam.safeParse(c.req.param('id'));
  if (!id.success) throw new AppError('NOT_FOUND');
  const body = await json(c, z.strictObject({ rewardKey: z.string().regex(/^[a-z0-9_-]{1,32}$/) }));
  const data = await withTx(dbPool(c), async (client) => {
    const identity = await resolveIdentity(client, getCookie(c, IDENTITY_COOKIE));
    if (!identity) return undefined;
    const merchantId = await ownedCardMerchant(client, identity.identityId, id.data);
    if (!merchantId) return undefined;
    await setMerchant(client, merchantId);
    const result = await chooseReward(client, merchantId, id.data, body.rewardKey);
    return { result, card: await cardView(client, merchantId, id.data) };
  });
  if (!data || data.result.status === 'not_found') throw new AppError('NOT_FOUND');
  if (data.result.status !== 'chosen') {
    return c.json({ chosen: false, reason: data.result.status, card: data.card }, 409);
  }
  return c.json({ chosen: true, reward: data.result.reward, card: data.card });
});

/** Code de récupération facultatif : créé/renouvelé, affiché une seule fois. */
customerRoutes.post('/c/recovery', originCheck, async (c) => {
  checkCustomerApi(c);
  const code = await withTx(dbPool(c), async (client) => {
    const identity = await resolveIdentity(client, getCookie(c, IDENTITY_COOKIE));
    if (!identity) return undefined;
    return issueRecoveryCode(client, identity);
  });
  if (!code) throw new AppError('AUTH_REQUIRED');
  return c.json({ recoveryCode: formatRecoveryCode(code), shownOnce: true });
});

customerRoutes.post('/c/recovery/revoke', originCheck, async (c) => {
  checkCustomerApi(c);
  const ok = await withTx(dbPool(c), async (client) => {
    const identity = await resolveIdentity(client, getCookie(c, IDENTITY_COOKIE));
    if (!identity) return false;
    await revokeRecoveryCode(client, identity);
    return true;
  });
  if (!ok) throw new AppError('AUTH_REQUIRED');
  return c.json({ revoked: true });
});

customerRoutes.post('/c/recover', originCheck, async (c) => {
  checkCustomerApi(c);
  const body = await json(c, z.strictObject({ recoveryCode: z.string().min(20).max(40) }));
  const result = await withTx(dbPool(c), (client) => recoverIdentity(client, body.recoveryCode, ipHash(c)));
  if (result.status === 'rate_limited') throw new AppError('RATE_LIMITED');
  if (result.status !== 'recovered') {
    throw new AppError('AUTH_INVALID', { userMessage: 'Code de récupération incorrect.' });
  }
  writeIdentityCookie(c, result.rawToken);
  return c.json({ recovered: true, newRecoveryCode: formatRecoveryCode(result.newRecoveryCode) });
});

/** « Oublier cet appareil » : la carte reste récupérable avec le code. */
customerRoutes.post('/c/forget', originCheck, async (c) => {
  checkCustomerApi(c);
  await withTx(dbPool(c), async (client) => {
    const identity = await resolveIdentity(client, getCookie(c, IDENTITY_COOKIE));
    if (identity) await revokeCurrentSession(client, identity);
  });
  deleteCookie(c, IDENTITY_COOKIE, { path: '/api', secure: secureCookies(c.get('config').appEnv) });
  return c.json({ forgotten: true });
});

/**
 * Lecture NFC : seule route publique pouvant créditer un passage, et
 * uniquement par POST explicite avec une preuve SUN valide et neuve.
 */
customerRoutes.post('/c/nfc/tap', originCheck, async (c) => {
  checkCustomerApi(c);
  const keys = nfcKeyConfig();
  if (!keys) throw new AppError('SERVICE_UNAVAILABLE', { userMessage: 'Le NFC n’est pas encore activé.' });
  const body = await json(c, z.strictObject({ e: z.string().max(64), c: z.string().max(32) }));
  const config = c.get('config');
  const result = await handleNfcTap(dbPool(c), keys, {
    e: body.e,
    c: body.c,
    identityToken: getCookie(c, IDENTITY_COOKIE),
    identityNonce: getCookie(c, IDENTITY_NONCE_COOKIE),
    merchantSessionToken: getSessionCookie(c, config.appEnv),
    sessionIdleSeconds: config.auth.sessionIdleSeconds,
    ipHash: ipHash(c),
  });
  if ('identityToken' in result && result.identityToken) writeIdentityCookie(c, result.identityToken);
  const { identityToken: _omit, ...publicResult } = result as typeof result & { identityToken?: string };
  c.get('log').info('nfc.tap', { status: result.status, reason: 'reason' in result ? result.reason : null });
  return c.json(publicResult, result.status === 'denied' && result.reason === 'rate_limited' ? 429 : 200);
});
