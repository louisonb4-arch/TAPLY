/**
 * Lecture NFC NTAG 424 DNA → passage automatique (mode B).
 *
 * Appelé UNIQUEMENT par une requête POST explicite de la page /t (jamais
 * par le GET de l'URL du tag : un aperçu de lien ou un rechargement ne
 * crédite rien).
 *
 * Chaîne de contrôle, dans UNE transaction :
 *   1. message SUN vérifié (AES-CMAC, PICCData chiffrées) — sdm.ts ;
 *   2. puce connue, active, rattachée au commerce (UID authentifié) ;
 *   3. compteur SDM consommé atomiquement : accepté seulement s'il est
 *      strictement supérieur au dernier consommé (rejeu, compteur obsolète
 *      et requêtes concurrentes rejetés) ;
 *   4. commerce : NFC automatique activé, programme publié, abonnement actif ;
 *   5. identité anonyme (créée si première visite) + carte (créée à 0) ;
 *   6. contrôles de risque (vélocité de la puce, inscriptions en rafale) ;
 *   7. moteur de crédit commun (délai 2 h par carte, récompense en attente…).
 * Chaque compteur consommé produit exactement un événement journalisé.
 *
 * Limites (documentées, non masquées) : SUN prouve qu'une puce authentique
 * a produit l'URL, pas que le téléphone est présent au comptoir. Une URL
 * capturée et jamais consommée reste utilisable jusqu'à ce qu'une lecture
 * plus récente de la même puce soit consommée. Le délai de 2 h par carte et
 * les contrôles de vélocité bornent l'impact ; le commerçant peut désactiver
 * une puce ou repasser en validation QR à tout moment.
 */
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTx } from '../db/tenant-context.js';
import { withAuthenticatedTx } from '../auth/session.js';
import { SessionInvalidError } from '../auth/errors.js';
import { verifySunMessage } from './sdm.js';
import { deriveSdmMetaReadKey, deriveTagKeys, parseNfcMasterKey } from './keys.js';
import { ensureIdentity, resolveIdentity, type ResolvedIdentity } from '../customer/identity.js';
import { cardView, enrollCard, findIdentityCard, publicProgramView, type CardView } from '../customer/cards.js';
import { creditVisitAsActor, type CreditVisitResult } from '../loyalty/credit.js';
import { canOperate, merchantAccess } from '../billing/access.js';
import { consumeRateLimit } from '../security/rate-limit.js';

export const NFC_TAPS_PER_IP_10MIN = 40;
/** Au-delà, la puce est probablement relayée : validation au comptoir exigée. */
export const NFC_CREDITS_PER_TAG_PER_MINUTE = 8;
export const NFC_NEW_CARDS_PER_TAG_10MIN = 25;
export const NFC_PAIRING_TTL_MINUTES = 10;

export interface NfcKeyConfig {
  readonly master: Buffer;
  readonly keyVersion: number;
}

export function nfcKeyConfig(env: Readonly<Record<string, string | undefined>> = process.env): NfcKeyConfig | undefined {
  const master = parseNfcMasterKey(env['TAPLY_NFC_MASTER_KEY']);
  if (master === undefined) return undefined;
  const version = Number(env['TAPLY_NFC_KEY_VERSION'] ?? '1');
  if (!Number.isInteger(version) || version < 1 || version > 255) return undefined;
  return { master, keyVersion: version };
}

export type TapDenial =
  | 'invalid' | 'unknown_tag' | 'replay' | 'tag_inactive' | 'nfc_disabled'
  | 'program_unavailable' | 'billing' | 'risk' | 'rate_limited'
  | 'cooldown' | 'reward_pending' | 'not_credited';

export type TapResult =
  | {
      readonly status: 'credited';
      readonly firstVisit: boolean;
      readonly card: CardView;
      readonly rewardUnlocked: boolean;
      readonly identityToken?: string;
    }
  | {
      readonly status: 'denied';
      readonly reason: TapDenial;
      readonly card?: CardView;
      readonly retryAfter?: string;
      readonly merchantName?: string;
      readonly identityToken?: string;
    }
  | { readonly status: 'already_processed'; readonly card?: CardView }
  | { readonly status: 'paired'; readonly label: string };

interface TagRow {
  id: string;
  merchant_id: string;
  program_id: string;
  status: string;
  key_version: number;
}

function proofIdempotencyKey(tagId: string, ctr: number): string {
  const h = createHash('sha256').update(`taply:nfc-credit:v1:${tagId}:${ctr}`).digest('hex');
  // Format UUID (version 4 / variante RFC 4122) dérivé, déterministe par preuve.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h.slice(16, 17), 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function lookupTag(client: PoolClient, uidHex: string): Promise<TagRow | undefined> {
  await client.query('select set_config($1, $2, true)', ['app.nfc_uid_lookup', uidHex]);
  const result = await client.query<TagRow>(
    `select id, merchant_id, program_id, status, key_version
       from taply.nfc_tags where uid_hex = $1`,
    [uidHex],
  );
  return result.rows[0];
}

async function recordEvent(
  client: PoolClient,
  tag: TagRow,
  ctr: number,
  outcome: string,
  extra: { identityId?: string; membershipId?: string; ipHash: string },
): Promise<void> {
  await client.query(
    `insert into taply.nfc_tap_events
       (tag_id, merchant_id, read_ctr, outcome, identity_id, membership_id, idempotency_key, ip_hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tag.id, tag.merchant_id, ctr, outcome, extra.identityId ?? null, extra.membershipId ?? null,
      proofIdempotencyKey(tag.id, ctr), extra.ipHash],
  );
}

export interface TapInput {
  readonly e: unknown;
  readonly c: unknown;
  readonly identityToken: string | undefined;
  readonly identityNonce: string | undefined;
  readonly merchantSessionToken: string | undefined;
  readonly sessionIdleSeconds: number;
  readonly ipHash: string;
}

/** Vérifie le message SUN (aucun accès base). Les clés ne quittent jamais ce module. */
export function verifyTap(keys: NfcKeyConfig, e: unknown, c: unknown) {
  return verifySunMessage({
    e, c,
    sdmMetaReadKey: deriveSdmMetaReadKey(keys.master, keys.keyVersion),
    fileReadKeyForUid: (uidHex) =>
      deriveTagKeys(keys.master, Buffer.from(uidHex, 'hex'), keys.keyVersion).sdmFileReadKey,
  });
}

export async function handleNfcTap(pool: Pool, keys: NfcKeyConfig, input: TapInput): Promise<TapResult> {
  const sun = verifyTap(keys, input.e, input.c);
  if (!sun.ok) return { status: 'denied', reason: 'invalid' };
  const { uidHex, readCtr } = sun;

  const known = await withTx(pool, async (client) => {
    if (!await consumeRateLimit(client, 'nfc-ip:' + input.ipHash, NFC_TAPS_PER_IP_10MIN, 600)) return 'rate_limited' as const;
    return (await lookupTag(client, uidHex)) ?? null;
  });
  if (known === 'rate_limited') return { status: 'denied', reason: 'rate_limited' };
  if (known === null) {
    // Puce authentique mais inconnue : appairage si le propriétaire est connecté.
    if (input.merchantSessionToken === undefined) return { status: 'denied', reason: 'unknown_tag' };
    return pairTag(pool, keys, uidHex, readCtr, input);
  }
  if (known.key_version !== keys.keyVersion) return { status: 'denied', reason: 'unknown_tag' };
  return creditFromTag(pool, uidHex, readCtr, input);
}

async function pairTag(pool: Pool, keys: NfcKeyConfig, uidHex: string, readCtr: number, input: TapInput): Promise<TapResult> {
  try {
    return await withAuthenticatedTx(pool, input.merchantSessionToken ?? '', input.sessionIdleSeconds, async (client, principal) => {
      if (principal.role !== 'owner') return { status: 'denied', reason: 'unknown_tag' } as const;
      const pairing = await client.query<{ id: string; program_id: string; label: string; replaces_tag_id: string | null }>(
        `select id, program_id, label, replaces_tag_id from taply.nfc_pairings
          where merchant_id = $1 and consumed_at is null and expires_at > now()
          order by created_at desc limit 1 for update`,
        [principal.merchantId],
      );
      const open = pairing.rows[0];
      if (open === undefined) return { status: 'denied', reason: 'unknown_tag' } as const;
      if (await lookupTag(client, uidHex)) return { status: 'denied', reason: 'unknown_tag' } as const;
      const location = await client.query<{ id: string }>(
        `select id from taply.locations where merchant_id = $1 and status = 'active' order by created_at limit 1`,
        [principal.merchantId],
      );
      const locationId = location.rows[0]?.id;
      if (locationId === undefined) return { status: 'denied', reason: 'program_unavailable' } as const;
      const inserted = await client.query<{ id: string }>(
        `insert into taply.nfc_tags
           (merchant_id, program_id, location_id, uid_hex, label, key_version, last_read_ctr, last_read_at,
            replaces_tag_id, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, now(), $8, $9) returning id`,
        [principal.merchantId, open.program_id, locationId, uidHex, open.label, keys.keyVersion, readCtr,
          open.replaces_tag_id, principal.merchantUserId],
      );
      const tagId = inserted.rows[0]?.id;
      if (tagId === undefined) throw new Error('nfc tag insert failed');
      await client.query(
        `update taply.nfc_pairings set consumed_at = now(), tag_id = $2 where id = $1 and merchant_id = $3`,
        [open.id, tagId, principal.merchantId],
      );
      if (open.replaces_tag_id !== null) {
        await client.query(
          `update taply.nfc_tags set status = 'retired', updated_at = now()
            where id = $1 and merchant_id = $2 and status <> 'compromised'`,
          [open.replaces_tag_id, principal.merchantId],
        );
      }
      await recordEvent(client, { id: tagId, merchant_id: principal.merchantId, program_id: open.program_id,
        status: 'active', key_version: keys.keyVersion }, readCtr, 'paired', { ipHash: input.ipHash });
      return { status: 'paired', label: open.label } as const;
    });
  } catch (error) {
    if (error instanceof SessionInvalidError) return { status: 'denied', reason: 'unknown_tag' };
    throw error;
  }
}

async function riskTooHigh(client: PoolClient, tag: TagRow, newCard: boolean): Promise<boolean> {
  const recent = await client.query<{ credits: number; cards: number }>(
    `select
       (select count(*)::integer from taply.visit_ledger
         where merchant_id = $1 and nfc_tag_id = $2 and credited_at > now() - interval '1 minute') as credits,
       (select count(*)::integer from taply.nfc_tap_events
         where merchant_id = $1 and tag_id = $2 and outcome = 'enrolled_credited'
           and created_at > now() - interval '10 minutes') as cards`,
    [tag.merchant_id, tag.id],
  );
  const row = recent.rows[0];
  if (row === undefined) return true;
  return row.credits >= NFC_CREDITS_PER_TAG_PER_MINUTE || (newCard && row.cards >= NFC_NEW_CARDS_PER_TAG_10MIN);
}

function denialFromCredit(result: Extract<CreditVisitResult, { credited: false }>): { reason: TapDenial; retryAfter?: string } {
  switch (result.reason.kind) {
    case 'cooldown_active': return { reason: 'cooldown', retryAfter: result.reason.retryAfter };
    case 'reward_pending': return { reason: 'reward_pending' };
    case 'program_inactive':
    case 'merchant_not_active': return { reason: 'program_unavailable' };
    default: return { reason: 'not_credited' };
  }
}

async function creditFromTag(pool: Pool, uidHex: string, readCtr: number, input: TapInput): Promise<TapResult> {
  return withTx(pool, async (client) => {
    const tag = await lookupTag(client, uidHex);
    if (tag === undefined) return { status: 'denied', reason: 'unknown_tag' } as const;
    await client.query('select set_config($1, $2, true)', ['app.merchant_id', tag.merchant_id]);

    // ── 3. Anti-rejeu : consommation atomique du compteur ─────────────
    const advanced = await client.query(
      `update taply.nfc_tags set last_read_ctr = $3, last_read_at = now(), updated_at = now()
        where id = $1 and merchant_id = $2 and last_read_ctr < $3`,
      [tag.id, tag.merchant_id, readCtr],
    );
    if (advanced.rowCount !== 1) {
      // Rechargement de la page par le même navigateur : même résultat, rien de nouveau.
      const identity = await resolveIdentity(client, input.identityToken);
      if (identity !== undefined) {
        const prior = await client.query<{ membership_id: string | null }>(
          `select membership_id from taply.nfc_tap_events
            where tag_id = $1 and merchant_id = $2 and read_ctr = $3 and identity_id = $4
              and outcome <> 'denied_replay' limit 1`,
          [tag.id, tag.merchant_id, readCtr, identity.identityId],
        );
        const priorRow = prior.rows[0];
        if (priorRow !== undefined) {
          const card = priorRow.membership_id ? await cardView(client, tag.merchant_id, priorRow.membership_id) : undefined;
          return { status: 'already_processed', ...(card ? { card } : {}) } as const;
        }
      }
      await recordEvent(client, tag, readCtr, 'denied_replay', {
        ...(identity ? { identityId: identity.identityId } : {}), ipHash: input.ipHash });
      return { status: 'denied', reason: 'replay' } as const;
    }

    // ── 4. Préconditions commerce ─────────────────────────────────────
    const program = await publicProgramView(client, tag.merchant_id, tag.program_id);
    if (tag.status !== 'active') {
      await recordEvent(client, tag, readCtr, 'denied_tag_inactive', { ipHash: input.ipHash });
      return { status: 'denied', reason: 'tag_inactive', ...(program ? { merchantName: program.merchantName } : {}) } as const;
    }
    if (program === undefined) {
      await recordEvent(client, tag, readCtr, 'denied_program_unavailable', { ipHash: input.ipHash });
      return { status: 'denied', reason: 'program_unavailable' } as const;
    }
    if (!program.nfcAutoEnabled) {
      await recordEvent(client, tag, readCtr, 'denied_nfc_disabled', { ipHash: input.ipHash });
      return { status: 'denied', reason: 'nfc_disabled', merchantName: program.merchantName } as const;
    }
    const access = await merchantAccess(client, tag.merchant_id);
    if (!canOperate(access.level)) {
      await recordEvent(client, tag, readCtr, 'denied_billing', { ipHash: input.ipHash });
      return { status: 'denied', reason: 'billing', merchantName: program.merchantName } as const;
    }

    // ── 5. Identité + carte (première visite : création puis crédit) ──
    const ensured = await ensureIdentity(client, input.identityToken, input.identityNonce, input.ipHash);
    if (ensured.status === 'rate_limited') {
      await recordEvent(client, tag, readCtr, 'denied_risk', { ipHash: input.ipHash });
      return { status: 'denied', reason: 'rate_limited', merchantName: program.merchantName } as const;
    }
    const identity: ResolvedIdentity = ensured.identity;
    const identityToken = ensured.status === 'existing' ? undefined : ensured.rawToken;
    const tokenField = identityToken === undefined ? {} : { identityToken };
    let membershipId = await findIdentityCard(client, identity.identityId, tag.program_id);
    const firstVisit = membershipId === undefined;

    // ── 6. Risque : puce relayée / inscriptions en rafale ─────────────
    if (await riskTooHigh(client, tag, firstVisit)) {
      await recordEvent(client, tag, readCtr, 'denied_risk', { identityId: identity.identityId, ipHash: input.ipHash });
      return { status: 'denied', reason: 'risk', merchantName: program.merchantName, ...tokenField } as const;
    }
    if (membershipId === undefined) {
      const enrolled = await enrollCard(client, {
        identityId: identity.identityId, merchantId: tag.merchant_id, programId: tag.program_id, ipHash: input.ipHash,
      });
      if (!('membershipId' in enrolled)) {
        const limited = enrolled.status === 'rate_limited';
        await recordEvent(client, tag, readCtr, limited ? 'denied_risk' : 'denied_program_unavailable',
          { identityId: identity.identityId, ipHash: input.ipHash });
        return { status: 'denied', reason: limited ? 'rate_limited' : 'program_unavailable',
          merchantName: program.merchantName, ...tokenField } as const;
      }
      membershipId = enrolled.membershipId;
    }

    // ── 7. Moteur commun : délai 2 h par carte, récompense, idempotence ─
    const credit = await creditVisitAsActor(client, tag.merchant_id, { kind: 'nfc', tagId: tag.id },
      { membershipId, idempotencyKey: proofIdempotencyKey(tag.id, readCtr) });
    const card = await cardView(client, tag.merchant_id, membershipId);
    if (!credit.credited) {
      const denial = denialFromCredit(credit);
      await recordEvent(client, tag, readCtr,
        denial.reason === 'cooldown' ? 'denied_cooldown'
          : denial.reason === 'reward_pending' ? 'denied_reward_pending' : 'denied_program_unavailable',
        { identityId: identity.identityId, membershipId, ipHash: input.ipHash });
      return { status: 'denied', reason: denial.reason,
        ...(denial.retryAfter ? { retryAfter: denial.retryAfter } : {}),
        ...(card ? { card } : {}), merchantName: program.merchantName, ...tokenField } as const;
    }
    await recordEvent(client, tag, readCtr, firstVisit ? 'enrolled_credited' : 'credited',
      { identityId: identity.identityId, membershipId, ipHash: input.ipHash });
    if (card === undefined) throw new Error('card view unavailable after credit');
    return { status: 'credited', firstVisit, card, rewardUnlocked: credit.rewardUnlocked, ...tokenField } as const;
  });
}
