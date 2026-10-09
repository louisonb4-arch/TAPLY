/**
 * Vérification des messages SUN / SDM (Secure Dynamic Messaging) des tags
 * NXP NTAG 424 DNA — réf. NXP AN12196 et datasheet NT4H2421Gx.
 *
 * URL émise par le tag à chaque tap : `?e=<32 hex>&c=<16 hex>`
 *   - e = PICCENCData : AES-128-CBC(SDMMetaReadKey, IV = 0^16) de
 *         PICCDataTag(1) || UID(7) || SDMReadCtr(3, LSB d'abord) || aléa(5).
 *         On EXIGE PICCDataTag = 0xC7 (UID + compteur mirrorés, UID 7 octets).
 *   - c = SDMMAC : MACt(AES-CMAC(K_SesSDMFileReadMAC, macInput)), macInput
 *         VIDE dans notre configuration (SDMMACInputOffset = SDMMACOffset).
 *     K_SesSDMFileReadMAC = AES-CMAC(SDMFileReadKey,
 *         3C C3 00 01 00 80 || UID(7) || SDMReadCtr(3, LSB d'abord)).
 *     MACt = octets d'indices impairs 1,3,…,15 du CMAC de 16 octets.
 *
 * HORS PÉRIMÈTRE — ANTI-REJEU : ce module ne garde AUCUN état. Un message
 * valide reste valide indéfiniment. L'appelant DOIT persister le dernier
 * SDMReadCtr accepté par UID et refuser tout compteur <= à celui-ci
 * (atomiquement), sinon une URL copiée est rejouable à l'infini.
 *
 * Les `reason` retournées sont destinées aux logs/métriques serveur ; la
 * réponse HTTP ne devrait pas les distinguer.
 */

import { createDecipheriv, timingSafeEqual } from 'node:crypto';
import { aesCmac } from './aes-cmac.js';

// ── Constants ───────────────────────────────────────────────────────

const KEY_SIZE = 16;
const PICC_ENC_SIZE = 16;
const SDM_MAC_SIZE = 8;
const UID_SIZE = 7;
const MAX_READ_CTR = 0xffffff;

/** bit7 UID mirroré, bit6 compteur mirroré, bits 3..0 = longueur UID (7). */
const REQUIRED_PICC_DATA_TAG = 0xc7;

/** Préfixe SV2 (vecteur de session MAC) — AN12196. */
const SV2_PREFIX = Buffer.from([0x3c, 0xc3, 0x00, 0x01, 0x00, 0x80]);

const PICC_ENC_HEX = /^[0-9A-Fa-f]{32}$/;
const SDM_MAC_HEX = /^[0-9A-Fa-f]{16}$/;

const ZERO_IV = Buffer.alloc(16);
const EMPTY = Buffer.alloc(0);

// ── Helpers ─────────────────────────────────────────────────────────

function assertKey(key: unknown, name: string): asserts key is Buffer {
  if (!(key instanceof Uint8Array) || key.length !== KEY_SIZE) {
    throw new TypeError(`${name} must be a ${KEY_SIZE}-byte Buffer`);
  }
}

function isValidReadCtr(readCtr: unknown): readCtr is number {
  return Number.isInteger(readCtr) && (readCtr as number) >= 0 && (readCtr as number) <= MAX_READ_CTR;
}

// ── PICCData ────────────────────────────────────────────────────────

/**
 * Déchiffre PICCENCData. Retourne null si la longueur n'est pas 16 octets
 * ou si PICCDataTag ≠ 0xC7.
 * @throws TypeError si la clé n'est pas une clé AES-128 (erreur de config).
 */
export function decryptPiccData(
  sdmMetaReadKey: Buffer,
  piccEnc: Buffer,
): { uid: Buffer; readCtr: number } | null {
  assertKey(sdmMetaReadKey, 'sdmMetaReadKey');
  if (!(piccEnc instanceof Uint8Array) || piccEnc.length !== PICC_ENC_SIZE) {
    return null;
  }

  const decipher = createDecipheriv('aes-128-cbc', sdmMetaReadKey, ZERO_IV);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(piccEnc), decipher.final()]);

  if (plain[0] !== REQUIRED_PICC_DATA_TAG) {
    return null;
  }

  const uid = Buffer.from(plain.subarray(1, 1 + UID_SIZE));
  // SDMReadCtr : 3 octets, LSB d'abord.
  const readCtr = plain.readUIntLE(1 + UID_SIZE, 3);
  return { uid, readCtr };
}

// ── SDMMAC ──────────────────────────────────────────────────────────

/**
 * K_SesSDMFileReadMAC = AES-CMAC(SDMFileReadKey, SV2).
 * @throws TypeError sur clé, UID (7 octets) ou compteur (0..0xFFFFFF) invalide.
 */
export function sdmSessionMacKey(sdmFileReadKey: Buffer, uid: Buffer, readCtr: number): Buffer {
  assertKey(sdmFileReadKey, 'sdmFileReadKey');
  if (!(uid instanceof Uint8Array) || uid.length !== UID_SIZE) {
    throw new TypeError(`uid must be a ${UID_SIZE}-byte Buffer`);
  }
  if (!isValidReadCtr(readCtr)) {
    throw new TypeError('readCtr must be an integer in 0..0xFFFFFF');
  }

  const ctr = Buffer.alloc(3);
  ctr.writeUIntLE(readCtr, 0, 3);
  const sv2 = Buffer.concat([SV2_PREFIX, uid, ctr]); // 6 + 7 + 3 = 16 octets
  return aesCmac(sdmFileReadKey, sv2);
}

/** MACt : octets d'indices impairs du CMAC complet → 8 octets. */
export function sdmMacTruncated(sessionMacKey: Buffer, macInput: Buffer): Buffer {
  const full = aesCmac(sessionMacKey, macInput);
  const truncated = Buffer.alloc(SDM_MAC_SIZE);
  for (let i = 0; i < SDM_MAC_SIZE; i++) {
    truncated[i] = full[2 * i + 1] ?? 0;
  }
  return truncated;
}

// ── URL params ──────────────────────────────────────────────────────

/**
 * Validation stricte des paramètres d'URL : `e` = 32 hex, `c` = 16 hex
 * (casse indifférente). Tout autre type ou forme → null.
 */
export function parseSunParams(e: unknown, c: unknown): { piccEnc: Buffer; mac: Buffer } | null {
  if (typeof e !== 'string' || typeof c !== 'string') {
    return null;
  }
  if (!PICC_ENC_HEX.test(e) || !SDM_MAC_HEX.test(c)) {
    return null;
  }
  return { piccEnc: Buffer.from(e, 'hex'), mac: Buffer.from(c, 'hex') };
}

// ── Vérification complète ───────────────────────────────────────────

export type SunVerification =
  | { ok: true; uidHex: string; readCtr: number }
  | { ok: false; reason: 'format' | 'picc_tag' | 'unknown_key' | 'mac' };

/**
 * Vérifie un message SUN (`e`, `c` bruts, non fiables).
 *
 * Ne lève jamais sur `e`/`c` (entrées attaquant). Lève TypeError uniquement
 * sur erreur de configuration serveur (clé meta invalide, ou clé de lecture
 * renvoyée par `fileReadKeyForUid` qui n'est pas une clé AES-128). Les
 * exceptions de `fileReadKeyForUid` se propagent telles quelles.
 *
 * Succès ≠ tap frais : l'anti-rejeu (compteur) reste à la charge de l'appelant.
 */
export function verifySunMessage(input: {
  e: unknown;
  c: unknown;
  sdmMetaReadKey: Buffer;
  fileReadKeyForUid: (uidHex: string) => Buffer | undefined;
}): SunVerification {
  assertKey(input.sdmMetaReadKey, 'sdmMetaReadKey');

  const params = parseSunParams(input.e, input.c);
  if (params === null) {
    return { ok: false, reason: 'format' };
  }

  const picc = decryptPiccData(input.sdmMetaReadKey, params.piccEnc);
  if (picc === null) {
    return { ok: false, reason: 'picc_tag' };
  }

  const uidHex = picc.uid.toString('hex').toUpperCase();
  const fileReadKey = input.fileReadKeyForUid(uidHex);
  if (fileReadKey === undefined) {
    return { ok: false, reason: 'unknown_key' };
  }
  assertKey(fileReadKey, 'fileReadKeyForUid() result');

  const sessionKey = sdmSessionMacKey(fileReadKey, picc.uid, picc.readCtr);
  const expected = sdmMacTruncated(sessionKey, EMPTY);
  // Longueurs égales garanties (8 octets) : comparaison à temps constant.
  if (!timingSafeEqual(expected, params.mac)) {
    return { ok: false, reason: 'mac' };
  }

  return { ok: true, uidHex, readCtr: picc.readCtr };
}
