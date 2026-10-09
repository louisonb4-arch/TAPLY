/**
 * Appareil employé approuvé + PIN : double possession requise pour toute
 * action de fidélité. N'authentifie PAS l'achat ou la présence du client.
 *
 * Deux sessions indépendantes : owner authentifié (+ mot de passe revérifié)
 * émet une invitation courte ; le staff authentifié la consomme pour créer
 * un appareil. Le secret appareil est cookie HttpOnly, non renvoyé au JS.
 * Le PIN n'est jamais stocké ni journalisé ; scrypt + pepper serveur.
 *
 * IMPORTANT : retourner false pour un PIN erroné (NE PAS throw) afin de
 * COMMIT les compteurs de tentatives sous withAuthenticatedTx.
 */
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AuthenticatedPrincipal } from '../auth/session.js';

const PIN_PATTERN = /^\d{6,10}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const KEY_PATTERN = /^[0-9a-f]{64}$/;
const LIMIT = 5;
/** Après un PIN correct, l'appareil reste déverrouillé ce délai (service au comptoir). */
export const DEVICE_UNLOCK_MINUTES = 15;
const PEPPER_MIN_LENGTH = 32;

function pepper(): string {
  const value = process.env['TAPLY_STAFF_PIN_PEPPER'];
  if (typeof value !== 'string' || value.length < PEPPER_MIN_LENGTH) {
    throw new Error('Configuration PIN indisponible');
  }
  return value;
}

function hashToken(kind: 'pairing' | 'device', raw: string): string {
  return createHash('sha256').update('taply:staff:' + kind + ':v1:' + raw).digest('hex');
}

function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function pinFormatValid(pin: unknown): pin is string {
  return typeof pin === 'string' && PIN_PATTERN.test(pin);
}

export async function derivePin(pin: string, salt: string): Promise<string> {
  if (!pinFormatValid(pin) || !/^[0-9a-f]{32}$/.test(salt)) {
    throw new Error('Invalid PIN encoding');
  }
  const secret = pepper();
  const key = await new Promise<Buffer>((resolve, reject) => {
    scryptCallback('taply:pin:v1:' + secret + ':' + pin, Buffer.from(salt, 'hex'), 64,
      { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, result) => error ? reject(error) : resolve(result));
  });
  return key.toString('hex');
}

export async function createStaffDevicePairing(
  client: PoolClient,
  principal: AuthenticatedPrincipal,
  targetMerchantUserId: string,
): Promise<string | undefined> {
  if (principal.role !== 'owner') return undefined;
  const token = newOpaqueToken();
  const result = await client.query(
    `insert into taply.staff_device_pairings
       (merchant_id, merchant_user_id, created_by, approval_hash, expires_at)
     values ($1, $2, $3, $4, now() + interval '5 minutes')`,
    [principal.merchantId, targetMerchantUserId, principal.merchantUserId, hashToken('pairing', token)],
  );
  return result.rowCount === 1 ? token : undefined;
}

export interface ActivatedDevice {
  deviceId: string;
  rawDeviceToken: string;
}

export async function activateStaffDevice(
  client: PoolClient,
  principal: AuthenticatedPrincipal,
  pairingToken: string,
  pin: string,
): Promise<ActivatedDevice | undefined> {
  if (!TOKEN_PATTERN.test(pairingToken) || !pinFormatValid(pin)) return undefined;
  const pair = await client.query<{ id: string; merchant_user_id: string }>(
    `select id, merchant_user_id from taply.staff_device_pairings
     where approval_hash = $1 and merchant_id = $2
       and consumed_at is null and expires_at > now()
     for update`,
    [hashToken('pairing', pairingToken), principal.merchantId],
  );
  const row = pair.rows[0];
  if (!row || row.merchant_user_id !== principal.merchantUserId) return undefined;

  const token = newOpaqueToken();
  const salt = randomBytes(16).toString('hex');
  const verifier = await derivePin(pin, salt);
  const inserted = await client.query<{ id: string }>(
    `insert into taply.staff_devices
       (merchant_id, merchant_user_id, token_hash, pin_salt, pin_verifier)
     values ($1, $2, $3, $4, $5) returning id`,
    [principal.merchantId, principal.merchantUserId, hashToken('device', token), salt, verifier],
  );
  if (!inserted.rows[0]) throw new Error('Device provisioning failed');
  const consumed = await client.query(
    `update taply.staff_device_pairings set consumed_at = now()
     where id = $1 and merchant_id = $2 and consumed_at is null`,
    [row.id, principal.merchantId],
  );
  if (consumed.rowCount !== 1) throw new Error('Device pairing race');
  return { deviceId: inserted.rows[0].id, rawDeviceToken: token };
}

interface DeviceRow {
  id: string;
  pin_salt: string;
  pin_verifier: string;
  failed_attempts: number;
  locked: boolean;
  unlocked?: boolean;
}

/**
 * La transaction ouverte DOIT être commit même après un mauvais PIN :
 * cela enregistre failed_attempts / locked_until. false = réponse générique.
 */
export async function authorizeStaffAction(
  client: PoolClient,
  principal: AuthenticatedPrincipal,
  rawDeviceToken: string | undefined,
  pin: unknown,
): Promise<boolean> {
  // PIN absent : accepté seulement si l'appareil a été déverrouillé récemment
  // par un PIN correct (fenêtre DEVICE_UNLOCK_MINUTES, horloge serveur).
  const withoutPin = pin === undefined;
  if (!rawDeviceToken || !TOKEN_PATTERN.test(rawDeviceToken) || (!withoutPin && !pinFormatValid(pin))) {
    return false;
  }
  const tokenHash = hashToken('device', rawDeviceToken);
  if (!KEY_PATTERN.test(tokenHash)) return false;
  const result = await client.query<DeviceRow>(
    `select id, pin_salt, pin_verifier, failed_attempts,
       coalesce(locked_until > now(), false) as locked,
       coalesce(unlocked_until > now(), false) as unlocked
     from taply.staff_devices
     where merchant_id = $1 and merchant_user_id = $2
       and token_hash = $3 and revoked_at is null
     for update`,
    [principal.merchantId, principal.merchantUserId, tokenHash],
  );
  const row = result.rows[0];
  if (!row || row.locked) return false;
  if (withoutPin) {
    if (row.unlocked !== true) return false;
    const touched = await client.query(
      `update taply.staff_devices set last_used_at=now() where id=$1 and merchant_id=$2`,
      [row.id, principal.merchantId],
    );
    return touched.rowCount === 1;
  }
  if (!pinFormatValid(pin)) return false;

  const candidate = await derivePin(pin, row.pin_salt);
  const valid = timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(row.pin_verifier, 'hex'));
  if (!valid) {
    const attempts = Math.min(row.failed_attempts + 1, LIMIT);
    await client.query(
      `update taply.staff_devices
       set failed_attempts=$1, unlocked_until=null,
         locked_until=case when $1 >= 5 then now() + interval '15 minutes' else null end
       where id=$2 and merchant_id=$3`,
      [attempts, row.id, principal.merchantId],
    );
    return false;
  }
  const update = await client.query(
    `update taply.staff_devices
     set failed_attempts=0, locked_until=null, last_used_at=now(),
       unlocked_until=now() + make_interval(mins => $3)
     where id=$1 and merchant_id=$2`,
    [row.id, principal.merchantId, DEVICE_UNLOCK_MINUTES],
  );
  return update.rowCount === 1;
}
