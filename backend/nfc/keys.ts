/**
 * Gestion des clés NTAG 424 DNA côté serveur.
 *
 * Aucune clé de tag n'est stockée : toutes sont dérivées (HKDF-SHA256) d'un
 * unique secret maître de 32 octets fourni par variable d'environnement.
 *   - SDMMetaReadKey : commune à tous les tags d'une même version de clé
 *     (l'UID n'est connu qu'APRÈS déchiffrement de PICCData).
 *   - AppMasterKey, SDMFileReadKey, ChangeKey : diversifiées par UID.
 * Chaque dérivation a un `info` distinct et versionné (rôle, UID, version) :
 * compromettre une clé de tag ne révèle ni le maître ni les autres tags.
 *
 * SÉCURITÉ : ces clés (et le maître) ne doivent JAMAIS être loguées,
 * sérialisées dans une réponse HTTP ni envoyées au frontend. Seul l'outil
 * de personnalisation des tags (hors ligne / back-office) en a besoin.
 */

import { hkdfSync } from 'node:crypto';

// ── Constants ───────────────────────────────────────────────────────

const MASTER_KEY_SIZE = 32;
const TAG_KEY_SIZE = 16;
const UID_SIZE = 7;
const MIN_KEY_VERSION = 1;
const MAX_KEY_VERSION = 255;

const MASTER_KEY_HEX = /^[0-9A-Fa-f]{64}$/;

/** Sel HKDF fixe (séparation de domaine). Ne jamais changer sans migration. */
const HKDF_SALT = Buffer.from('taply:ntag424:hkdf-salt:v1', 'utf8');
const INFO_PREFIX = 'taply:ntag424:v1';

type PerTagRole = 'app-master' | 'sdm-file-read' | 'change';

// ── Helpers ─────────────────────────────────────────────────────────

function assertMaster(master: unknown): asserts master is Buffer {
  if (!(master instanceof Uint8Array) || master.length !== MASTER_KEY_SIZE) {
    throw new TypeError(`NFC master key must be a ${MASTER_KEY_SIZE}-byte Buffer`);
  }
}

function assertKeyVersion(keyVersion: unknown): asserts keyVersion is number {
  if (
    !Number.isInteger(keyVersion) ||
    (keyVersion as number) < MIN_KEY_VERSION ||
    (keyVersion as number) > MAX_KEY_VERSION
  ) {
    throw new TypeError(`keyVersion must be an integer in ${MIN_KEY_VERSION}..${MAX_KEY_VERSION}`);
  }
}

function hkdf16(master: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, HKDF_SALT, Buffer.from(info, 'utf8'), TAG_KEY_SIZE));
}

// ── Master key ──────────────────────────────────────────────────────

/**
 * Parse le secret maître (exactement 64 hex). Tout autre format, ou la
 * clé nulle (0x00 × 32), → undefined. Aucun trim implicite.
 */
export function parseNfcMasterKey(raw: string | undefined): Buffer | undefined {
  if (typeof raw !== 'string' || !MASTER_KEY_HEX.test(raw)) {
    return undefined;
  }
  const key = Buffer.from(raw, 'hex');
  if (key.every((byte) => byte === 0)) {
    return undefined;
  }
  return key;
}

// ── Derivation ──────────────────────────────────────────────────────

/** SDMMetaReadKey (16 octets), commune à tous les tags d'une version. */
export function deriveSdmMetaReadKey(master: Buffer, keyVersion: number): Buffer {
  assertMaster(master);
  assertKeyVersion(keyVersion);
  return hkdf16(master, `${INFO_PREFIX}:sdm-meta-read:${keyVersion}`);
}

function derivePerTagKey(master: Buffer, role: PerTagRole, uidHex: string, keyVersion: number): Buffer {
  return hkdf16(master, `${INFO_PREFIX}:${role}:${uidHex}:${keyVersion}`);
}

/**
 * Jeu de clés d'un tag (16 octets chacune). Toutes diversifiées par UID,
 * sauf `sdmMetaReadKey` (identique à `deriveSdmMetaReadKey`).
 * @throws TypeError si maître ≠ 32 octets, UID ≠ 7 octets, version ∉ 1..255.
 */
export function deriveTagKeys(
  master: Buffer,
  uid: Buffer,
  keyVersion: number,
): { appMasterKey: Buffer; sdmMetaReadKey: Buffer; sdmFileReadKey: Buffer; changeKey: Buffer } {
  assertMaster(master);
  assertKeyVersion(keyVersion);
  if (!(uid instanceof Uint8Array) || uid.length !== UID_SIZE) {
    throw new TypeError(`uid must be a ${UID_SIZE}-byte Buffer`);
  }
  const uidHex = Buffer.from(uid).toString('hex').toUpperCase();

  return {
    appMasterKey: derivePerTagKey(master, 'app-master', uidHex, keyVersion),
    sdmMetaReadKey: deriveSdmMetaReadKey(master, keyVersion),
    sdmFileReadKey: derivePerTagKey(master, 'sdm-file-read', uidHex, keyVersion),
    changeKey: derivePerTagKey(master, 'change', uidHex, keyVersion),
  };
}
