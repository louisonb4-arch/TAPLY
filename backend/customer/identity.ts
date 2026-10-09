/**
 * Identité client anonyme : aucun nom, e-mail, téléphone ni mot de passe.
 *
 * - Jeton de session : 256 bits aléatoires, cookie HttpOnly ; seul
 *   SHA-256(domaine || jeton) est stocké (identity_sessions).
 * - Nonce de première visite : 256 bits, cookie éphémère posé à la lecture
 *   du programme. Deux requêtes concurrentes portant le même nonce
 *   aboutissent à la MÊME identité (verrou consultatif + index unique).
 * - Code de récupération facultatif : 100 bits (20 caractères base32 sans
 *   ambiguïté), hash seul en base, usage unique (renouvelé à chaque
 *   récupération), révocable. Tentatives limitées par IP et globalement.
 *
 * Toutes les fonctions s'exécutent dans une transaction ouverte par
 * l'appelant ; elles posent elles-mêmes les GUC d'identité nécessaires à RLS.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { consumeRateLimit } from '../security/rate-limit.js';

export const IDENTITY_COOKIE = 'taply_cid';
export const IDENTITY_NONCE_COOKIE = 'taply_cid_nonce';
export const IDENTITY_SESSION_DAYS = 400;
export const NONCE_TTL_SECONDS = 20 * 60;

const SESSION_DOMAIN = 'taply:identity-session:v1:';
const NONCE_DOMAIN = 'taply:identity-nonce:v1:';
const RECOVERY_DOMAIN = 'taply:identity-recovery:v1:';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RECOVERY_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{20}$/;

/** Limites de récupération : par IP et globales, par heure. */
export const RECOVERY_LIMIT_PER_IP_HOUR = 10;
export const RECOVERY_LIMIT_GLOBAL_HOUR = 1000;
/** Création d'identités par IP (anti création massive de cartes). */
export const IDENTITY_CREATION_PER_IP_HOUR = 30;

export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isOpaqueToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

export function hashIdentityToken(raw: string): string {
  return createHash('sha256').update(SESSION_DOMAIN + raw).digest('hex');
}

export function hashIdentityNonce(raw: string): string {
  return createHash('sha256').update(NONCE_DOMAIN + raw).digest('hex');
}

/** 20 caractères base32 = 100 bits (rejet des octets ≥ 256 - 256 % 32 inutile : 256 % 32 = 0). */
export function newRecoveryCode(): string {
  return Array.from(randomBytes(20), (b) => RECOVERY_ALPHABET[b & 31]).join('');
}

export function normalizeRecoveryCode(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 64) return undefined;
  const code = raw.replace(/[\s-]/g, '').toUpperCase();
  return RECOVERY_PATTERN.test(code) ? code : undefined;
}

export function hashRecoveryCode(normalized: string): string {
  return createHash('sha256').update(RECOVERY_DOMAIN + normalized).digest('hex');
}

export function formatRecoveryCode(code: string): string {
  return (code.match(/.{1,5}/g) ?? []).join('-');
}

export interface ResolvedIdentity {
  readonly identityId: string;
  readonly sessionId: string;
  readonly hasRecoveryCode: boolean;
}

async function setGuc(client: PoolClient, name: string, value: string): Promise<void> {
  await client.query('select set_config($1, $2, true)', [name, value]);
}

/** Résout le cookie d'identité ; pose app.identity_id si valide. */
export async function resolveIdentity(client: PoolClient, rawToken: string | undefined): Promise<ResolvedIdentity | undefined> {
  if (!isOpaqueToken(rawToken)) return undefined;
  const tokenHash = hashIdentityToken(rawToken);
  await setGuc(client, 'app.identity_session_hash', tokenHash);
  const session = await client.query<{ id: string; identity_id: string; stale: boolean }>(
    `select id, identity_id, last_seen_at < now() - interval '1 hour' as stale
       from taply.identity_sessions
      where token_hash = $1 and revoked_at is null and expires_at > now()`,
    [tokenHash],
  );
  const row = session.rows[0];
  if (row === undefined) return undefined;
  await setGuc(client, 'app.identity_id', row.identity_id);
  const identity = await client.query<{ status: string; recovery: boolean }>(
    `select status, recovery_hash is not null as recovery
       from taply.customer_identities where id = $1`,
    [row.identity_id],
  );
  const id = identity.rows[0];
  if (id === undefined || id.status !== 'active') return undefined;
  if (row.stale) {
    // Session glissante, écrite au plus une fois par heure.
    await client.query(
      `update taply.identity_sessions
          set last_seen_at = now(), expires_at = now() + make_interval(days => $2)
        where id = $1 and identity_id = $3`,
      [row.id, IDENTITY_SESSION_DAYS, row.identity_id],
    );
  }
  return { identityId: row.identity_id, sessionId: row.id, hasRecoveryCode: id.recovery };
}

async function issueSession(client: PoolClient, identityId: string, nonceHash: string | null): Promise<string> {
  const raw = newOpaqueToken();
  const inserted = await client.query(
    `insert into taply.identity_sessions (identity_id, token_hash, creation_nonce_hash, expires_at)
     values ($1, $2, $3, now() + make_interval(days => $4))`,
    [identityId, hashIdentityToken(raw), nonceHash, IDENTITY_SESSION_DAYS],
  );
  if (inserted.rowCount !== 1) throw new Error('identity session insert failed');
  return raw;
}

export type EnsureIdentityResult =
  | { readonly status: 'existing'; readonly identity: ResolvedIdentity }
  | { readonly status: 'created' | 'joined'; readonly identity: ResolvedIdentity; readonly rawToken: string }
  | { readonly status: 'rate_limited' };

/**
 * Retourne l'identité du cookie, sinon en crée une. `rawNonce` (cookie de
 * première visite) rend la création idempotente face aux requêtes
 * simultanées et aux rechargements.
 */
export async function ensureIdentity(
  client: PoolClient,
  rawToken: string | undefined,
  rawNonce: string | undefined,
  ipHash: string,
): Promise<EnsureIdentityResult> {
  const existing = await resolveIdentity(client, rawToken);
  if (existing) return { status: 'existing', identity: existing };

  const nonceHash = isOpaqueToken(rawNonce) ? hashIdentityNonce(rawNonce) : null;
  if (nonceHash !== null) {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', ['taply:identity-nonce:' + nonceHash]);
    await setGuc(client, 'app.identity_nonce_hash', nonceHash);
    const prior = await client.query<{ identity_id: string }>(
      `select identity_id from taply.identity_sessions
        where creation_nonce_hash = $1 and created_at > now() - make_interval(secs => $2)`,
      [nonceHash, NONCE_TTL_SECONDS],
    );
    const priorId = prior.rows[0]?.identity_id;
    if (priorId !== undefined) {
      await setGuc(client, 'app.identity_id', priorId);
      const raw = await issueSession(client, priorId, null);
      return { status: 'joined', rawToken: raw,
        identity: { identityId: priorId, sessionId: '', hasRecoveryCode: false } };
    }
  }

  if (!await consumeRateLimit(client, 'identity-create:' + ipHash, IDENTITY_CREATION_PER_IP_HOUR, 3600)) {
    return { status: 'rate_limited' };
  }

  const identityId = randomUUID();
  await setGuc(client, 'app.identity_id', identityId);
  const created = await client.query('insert into taply.customer_identities (id) values ($1)', [identityId]);
  if (created.rowCount !== 1) throw new Error('identity insert failed');
  const raw = await issueSession(client, identityId, nonceHash);
  return { status: 'created', rawToken: raw,
    identity: { identityId, sessionId: '', hasRecoveryCode: false } };
}

/** Crée ou renouvelle le code de récupération (l'ancien devient inutilisable). */
export async function issueRecoveryCode(client: PoolClient, identity: ResolvedIdentity): Promise<string> {
  const code = newRecoveryCode();
  const updated = await client.query(
    `update taply.customer_identities
        set recovery_hash = $2, recovery_created_at = now(), updated_at = now()
      where id = $1 and status = 'active'`,
    [identity.identityId, hashRecoveryCode(code)],
  );
  if (updated.rowCount !== 1) throw new Error('recovery code update failed');
  return code;
}

export async function revokeRecoveryCode(client: PoolClient, identity: ResolvedIdentity): Promise<void> {
  await client.query(
    `update taply.customer_identities
        set recovery_hash = null, recovery_created_at = null, updated_at = now()
      where id = $1`,
    [identity.identityId],
  );
}

export type RecoverResult =
  | { readonly status: 'recovered'; readonly rawToken: string; readonly newRecoveryCode: string; readonly identityId: string }
  | { readonly status: 'invalid' | 'rate_limited' };

/**
 * Rattache l'identité du code à ce navigateur. Les autres sessions de
 * l'identité sont révoquées (téléphone perdu) et le code est remplacé par
 * un nouveau, affiché une seule fois.
 */
export async function recoverIdentity(client: PoolClient, rawCode: unknown, ipHash: string): Promise<RecoverResult> {
  // Les tentatives comptent AVANT la vérification, codes invalides compris.
  if (!await consumeRateLimit(client, 'recovery-ip:' + ipHash, RECOVERY_LIMIT_PER_IP_HOUR, 3600)
      || !await consumeRateLimit(client, 'recovery-global', RECOVERY_LIMIT_GLOBAL_HOUR, 3600)) {
    return { status: 'rate_limited' };
  }
  const normalized = normalizeRecoveryCode(rawCode);
  if (normalized === undefined) return { status: 'invalid' };
  const codeHash = hashRecoveryCode(normalized);
  // Deux récupérations simultanées du même code : la seconde attend puis ne
  // trouve plus rien (le code est remplacé). Pas de FOR UPDATE ici : sous
  // RLS il exigerait la policy UPDATE, qui dépend de app.identity_id.
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', ['taply:recovery:' + codeHash]);
  await setGuc(client, 'app.identity_recovery_hash', codeHash);
  const found = await client.query<{ id: string }>(
    `select id from taply.customer_identities
      where recovery_hash = $1 and status = 'active'`,
    [codeHash],
  );
  const identityId = found.rows[0]?.id;
  if (identityId === undefined) return { status: 'invalid' };
  await setGuc(client, 'app.identity_id', identityId);
  await client.query(
    `update taply.identity_sessions set revoked_at = now()
      where identity_id = $1 and revoked_at is null`,
    [identityId],
  );
  const raw = await issueSession(client, identityId, null);
  const next = await issueRecoveryCode(client, { identityId, sessionId: '', hasRecoveryCode: true });
  return { status: 'recovered', rawToken: raw, newRecoveryCode: next, identityId };
}

/** « Oublier cet appareil » : révoque la session courante uniquement. */
export async function revokeCurrentSession(client: PoolClient, identity: ResolvedIdentity): Promise<void> {
  await client.query(
    `update taply.identity_sessions set revoked_at = now()
      where id = $1 and identity_id = $2 and revoked_at is null`,
    [identity.sessionId, identity.identityId],
  );
}
