/**
 * Plan de personnalisation d'UN tag NTAG 424 DNA pour Taply, et exécution
 * de ce plan à travers une interface de transport abstraite.
 *
 * Plan de clés (identique à la dérivation serveur backend/nfc/keys.ts) :
 *   - Clé 0 = appMasterKey     (diversifiée par UID)          — administration
 *   - Clé 1 = sdmMetaReadKey   (commune à une version de clés) — chiffre PICCData
 *   - Clé 2 = sdmFileReadKey   (diversifiée par UID)          — SDMMAC
 *   - Clés 3 et 4 = changeKey  (diversifiée par UID)          — inutilisées, mais
 *     ne doivent pas rester à la valeur usine (16 × 00).
 *   Version de chaque clé (octet KeyVer) = keyVersion (1..255) ; usine = 00h.
 *
 * Fichier 02 (NDEF, 256 o) après personnalisation :
 *   FileOption 40h (SDM activé, CommMode.Plain) ; AccessRights Read=E,
 *   Write=0, ReadWrite=0, Change=0 ; SDMOptions C1h (UID + SDMReadCtr,
 *   ASCII) ; SDMAccessRights MetaRead=1, FileRead=2, CtrRet=F (GetFileCounters
 *   interdit : le compteur n'est lisible que via l'URL) ; PICCDataOffset,
 *   SDMMACInputOffset = SDMMACOffset calculés depuis les octets NDEF réels.
 *
 * Écriture du NDEF : WriteData en CLAIR, AVANT ChangeFileSettings, pendant que
 * Write = Eh (valeur usine, datasheet Table 8). Sous authentification, seule
 * la condition « libre » est satisfaite ⇒ CommMode.Plain (§8.2.3.3) ; le
 * CmdCtr est tout de même incrémenté (§9.1.8). Le contenu NDEF est public.
 *
 * SÉCURITÉ : le plan ne contient AUCUNE clé. Les clés sont fournies à part
 * (ProvisioningKeys), uniquement pour le transport. La session est ouverte
 * avec la clé usine publique : un enregistrement des APDU (ou une écoute RF)
 * permet de retrouver les nouvelles clés ⇒ ne jamais journaliser les APDU,
 * personnaliser dans un lieu maîtrisé.
 */

import { randomBytes } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { deriveTagKeys, parseNfcMasterKey } from '../../backend/nfc/keys.js';
import { verifySunMessage } from '../../backend/nfc/sdm.js';
import {
  NDEF_FILE_NO,
  NDEF_FILE_SIZE,
  Ntag424Error,
  SW,
  authenticateEv2FirstStep2,
  buildAuthenticateEv2FirstPart1,
  buildChangeFileSettings,
  buildChangeKey,
  buildGetCardUid,
  buildGetFileSettingsMac,
  buildGetFileSettingsPlain,
  buildGetKeyVersionMac,
  buildIsoSelectNdefApplication,
  buildReadDataPlain,
  buildWriteDataPlain,
  decryptFullResponse,
  encodeFileSettings,
  expectStatus,
  parseAuthenticatePart1Response,
  parseGetCardUidResponse,
  splitResponse,
  u24le,
  verifyAuthenticateEv2FirstResponse,
  verifyMacResponse,
  type Ev2Session,
  type FileSettingsSpec,
} from './ev2.js';
import { buildSunNdefFile, extractSunParams, isUnmirrored, parseNdefUriFile, type SunNdefFile } from './ndef.js';

// ── Constants ───────────────────────────────────────────────────────

const UID_HEX = /^04[0-9A-F]{12}$/;
const KEY_COUNT = 5;
/** WriteData : données ≤ 248 octets, secure messaging compris (Table 81). */
const MAX_SINGLE_WRITE = 248;
/** GetFileSettings du fichier 02 à la livraison : pas de SDM, Plain, R/W/RW = E, Change = 0, 256 o. */
const FACTORY_NDEF_FILE_SETTINGS = Buffer.from('0000E0EE000100', 'hex');
const FACTORY_KEY_VERSION = 0x00;

// ── Key slots ───────────────────────────────────────────────────────

export type KeyRole = 'appMasterKey' | 'sdmMetaReadKey' | 'sdmFileReadKey' | 'changeKey';

export interface KeySlot {
  readonly slot: number;
  readonly role: KeyRole;
  readonly diversification: 'par UID' | 'par version de clés (commune à tous les tags)';
  readonly usage: string;
}

export const KEY_SLOTS: readonly KeySlot[] = [
  { slot: 0, role: 'appMasterKey', diversification: 'par UID', usage: 'administration : ChangeKey, ChangeFileSettings (Change=0), écriture NDEF (Write=0, ReadWrite=0)' },
  { slot: 1, role: 'sdmMetaReadKey', diversification: 'par version de clés (commune à tous les tags)', usage: 'chiffrement des PICCData (SDMMetaRead=1) → paramètre e' },
  { slot: 2, role: 'sdmFileReadKey', diversification: 'par UID', usage: 'SDMMAC sur entrée vide (SDMFileRead=2) → paramètre c' },
  { slot: 3, role: 'changeKey', diversification: 'par UID', usage: 'inutilisée pour les accès ; retirée de la valeur usine' },
  { slot: 4, role: 'changeKey', diversification: 'par UID', usage: 'inutilisée pour les accès ; retirée de la valeur usine' },
];

// ── Errors ──────────────────────────────────────────────────────────

export type ProvisioningErrorCode =
  | 'invalid_input'
  | 'precheck_unexpected_settings'
  | 'factory_key_rejected'
  | 'uid_mismatch'
  | 'unexpected_key_version'
  | 'card_error'
  | 'verification_failed';

export class ProvisioningError extends Error {
  readonly code: ProvisioningErrorCode;
  readonly step: string;
  readonly sw: number | null;

  constructor(code: ProvisioningErrorCode, step: string, message: string, sw: number | null = null) {
    super(`[${step}] ${message}`);
    this.name = 'ProvisioningError';
    this.code = code;
    this.step = step;
    this.sw = sw;
  }
}

// ── Inputs ──────────────────────────────────────────────────────────

/** UID NXP de 7 octets (14 hex, premier octet 04h = fabricant NXP), en majuscules. */
export function normalizeUid(uid: unknown): string {
  const upper = typeof uid === 'string' ? uid.toUpperCase() : '';
  if (!UID_HEX.test(upper)) {
    throw new ProvisioningError('invalid_input', 'input', 'UID must be 14 hex chars starting with 04 (7-byte NXP UID)');
  }
  return upper;
}

function assertKeyVersion(keyVersion: unknown): asserts keyVersion is number {
  if (!Number.isInteger(keyVersion) || (keyVersion as number) < 1 || (keyVersion as number) > 255) {
    throw new ProvisioningError('invalid_input', 'input', 'keyVersion must be an integer in 1..255');
  }
}

function parseMaster(masterKeyHex: string): Buffer {
  const master = parseNfcMasterKey(masterKeyHex);
  if (master === undefined) {
    throw new ProvisioningError('invalid_input', 'input', 'master key must be exactly 64 hex chars and not all-zero');
  }
  return master;
}

/**
 * Lit le fichier du secret maître (64 hex, un saut de ligne final toléré).
 * Refuse : fichier absent, non régulier, lisible/écrivable par le groupe ou
 * les autres (mode & 0o077 ≠ 0), contenu invalide ou clé nulle.
 * Le contrôle des droits se fait sur le descripteur ouvert (pas de TOCTOU).
 */
export function loadMasterKeyFile(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    throw new ProvisioningError('invalid_input', 'master-file', `cannot open master key file ${JSON.stringify(path)}`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new ProvisioningError('invalid_input', 'master-file', 'master key path is not a regular file');
    if ((stat.mode & 0o077) !== 0) {
      throw new ProvisioningError(
        'invalid_input',
        'master-file',
        `master key file is accessible by group/others (mode ${(stat.mode & 0o777).toString(8)}); run: chmod 600 <file>`,
      );
    }
    const raw = readFileSync(fd, 'utf8').replace(/\r?\n$/, '');
    if (/^0{64}$/.test(raw)) throw new ProvisioningError('invalid_input', 'master-file', 'master key is all-zero: refused');
    parseMaster(raw);
    return raw;
  } finally {
    closeSync(fd);
  }
}

// ── Keys (transport only) ───────────────────────────────────────────

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/**
 * Clés d'UN tag, réservées à la couche transport. Non sérialisables :
 * JSON.stringify et console.log affichent une version masquée.
 */
export class ProvisioningKeys {
  readonly uidHex: string;
  readonly keyVersion: number;
  readonly #slots: readonly Buffer[];

  constructor(uidHex: string, keyVersion: number, slots: readonly Buffer[]) {
    if (slots.length !== KEY_COUNT || slots.some((k) => k.length !== 16)) throw new TypeError('expected 5 AES-128 keys');
    if (slots.some((k) => k.every((b) => b === 0))) throw new TypeError('a derived key is all-zero: refused');
    this.uidHex = uidHex;
    this.keyVersion = keyVersion;
    this.#slots = slots.map((k) => Buffer.from(k));
  }

  /** Copie de la clé du slot 0..4 (l'appelant peut l'effacer après usage). */
  slot(slot: number): Buffer {
    const key = this.#slots[slot];
    if (key === undefined) throw new RangeError('key slot must be 0..4');
    return Buffer.from(key);
  }

  toJSON(): { uidHex: string; keyVersion: number; keys: string } {
    return { uidHex: this.uidHex, keyVersion: this.keyVersion, keys: '[redacted]' };
  }

  [INSPECT](): string {
    return `ProvisioningKeys { uid: ${this.uidHex}, keyVersion: ${this.keyVersion}, keys: [redacted] }`;
  }
}

/**
 * Dérive les 5 clés du tag avec EXACTEMENT les fonctions du serveur
 * (deriveTagKeys) : slot 0 appMasterKey, 1 sdmMetaReadKey, 2 sdmFileReadKey,
 * 3 et 4 changeKey.
 */
export function deriveProvisioningKeys(masterKeyHex: string, uidHex: string, keyVersion: number): ProvisioningKeys {
  const uid = normalizeUid(uidHex);
  assertKeyVersion(keyVersion);
  const tagKeys = deriveTagKeys(parseMaster(masterKeyHex), Buffer.from(uid, 'hex'), keyVersion);
  return new ProvisioningKeys(uid, keyVersion, [
    tagKeys.appMasterKey,
    tagKeys.sdmMetaReadKey,
    tagKeys.sdmFileReadKey,
    tagKeys.changeKey,
    tagKeys.changeKey,
  ]);
}

// ── Plan ────────────────────────────────────────────────────────────

export type StepId =
  | 'select-application'
  | 'precheck-file-settings'
  | 'authenticate-key0'
  | 'get-card-uid'
  | 'write-ndef'
  | 'change-file-settings'
  | 'verify-file-settings'
  | 'change-key-1'
  | 'change-key-2'
  | 'change-key-3'
  | 'change-key-4'
  | 'change-key-0'
  | 'verify-sun-read';

export interface PlanStep {
  readonly id: StepId;
  readonly title: string;
  /** Description de l'APDU : octets publics en clair, cryptogrammes symbolisés. */
  readonly apduDescription: string;
  /** Clé dont une authentification active est requise (null = aucune). */
  readonly needsAuthWithKey: number | null;
  /** NOMS des secrets utilisés (jamais leur valeur). */
  readonly secretsUsed: readonly string[];
}

export interface ProvisioningPlan {
  readonly uidHex: string;
  readonly keyVersion: number;
  readonly host: string;
  readonly ndef: SunNdefFile;
  readonly fileSettingsSpec: FileSettingsSpec;
  /** Données de ChangeFileSettings (sans FileNo). */
  readonly fileSettings: Buffer;
  /** Réponse GetFileSettings(02) attendue après personnalisation. */
  readonly expectedFileSettings: Buffer;
  /** Réponse GetFileSettings(02) d'une puce sortie d'usine. */
  readonly factoryFileSettings: Buffer;
  readonly keySlots: readonly KeySlot[];
  readonly steps: readonly PlanStep[];
}

function hexSpaced(buf: Buffer): string {
  return buf.toString('hex').toUpperCase().replace(/(..)(?=.)/g, '$1 ');
}

function changeKeyStep(slot: 1 | 2 | 3 | 4, role: KeyRole, keyVersion: number): PlanStep {
  const v = keyVersion.toString(16).toUpperCase().padStart(2, '0');
  return {
    id: `change-key-${slot}`,
    title: `ChangeKey ${slot} ← ${role} (version ${v}h)`,
    apduDescription:
      `90 64 00 00 09 0${slot} <MACt> 00 (GetKeyVersion : 00h ⇒ ancienne clé = usine ; ${v}h ⇒ reprise, ancienne clé = ${role} ; autre ⇒ arrêt), ` +
      `puis 90 C4 00 00 29 0${slot} <E(SesAuthENC, (${role} ⊕ ancienne clé) ‖ ${v} ‖ CRC32NK(${role}) ‖ 80 00…)> <MACt> 00`,
    needsAuthWithKey: 0,
    secretsUsed: [role, 'clé usine 00×16 (publique) ou clé Taply actuelle', 'clés de session'],
  };
}

/**
 * Plan ordonné pour un tag. `masterKeyHex` n'est utilisé que pour être
 * validé (format, non nul) : le plan ne contient aucune clé ni dérivée.
 */
export function buildProvisioningPlan(input: {
  readonly masterKeyHex: string;
  readonly uidHex: string;
  readonly keyVersion: number;
  readonly host: string;
}): ProvisioningPlan {
  parseMaster(input.masterKeyHex);
  const uidHex = normalizeUid(input.uidHex);
  assertKeyVersion(input.keyVersion);
  const keyVersion = input.keyVersion;
  let ndef: SunNdefFile;
  try {
    ndef = buildSunNdefFile(input.host);
  } catch (error) {
    throw new ProvisioningError('invalid_input', 'input', error instanceof Error ? error.message : String(error));
  }
  if (ndef.bytes.length > MAX_SINGLE_WRITE) {
    throw new ProvisioningError('invalid_input', 'input', `NDEF file (${ndef.bytes.length} bytes) exceeds a single WriteData frame`);
  }

  const fileSettingsSpec: FileSettingsSpec = {
    commMode: 'plain',
    access: { read: 0xe, write: 0x0, readWrite: 0x0, change: 0x0 },
    sdm: {
      uidMirror: true,
      readCtrMirror: true,
      metaRead: 1,
      fileRead: 2,
      ctrRet: 0xf,
      piccDataOffset: ndef.piccDataOffset,
      macInputOffset: ndef.sdmMacInputOffset,
      macOffset: ndef.sdmMacOffset,
    },
  };
  const fileSettings = encodeFileSettings(fileSettingsSpec);
  // GetFileSettings = FileType(00) || FileOption || AccessRights || FileSize(3) || reste SDM.
  const expectedFileSettings = Buffer.concat([
    Buffer.from([0x00]),
    fileSettings.subarray(0, 3),
    u24le(NDEF_FILE_SIZE),
    fileSettings.subarray(3),
  ]);

  const ndefLen = ndef.bytes.length;
  const lenHex = hexSpaced(u24le(ndefLen));
  const selectHex = hexSpaced(buildIsoSelectNdefApplication());
  const steps: PlanStep[] = [
    {
      id: 'select-application',
      title: 'Sélection de l’application NDEF (ISOSelectFile par DF name)',
      apduDescription: `${selectHex} → attendu 90 00`,
      needsAuthWithKey: null,
      secretsUsed: [],
    },
    {
      id: 'precheck-file-settings',
      title: 'Contrôle préalable : réglages du fichier 02 (GetFileSettings, non authentifié)',
      apduDescription:
        `${hexSpaced(buildGetFileSettingsPlain(NDEF_FILE_NO))} → attendu ${hexSpaced(FACTORY_NDEF_FILE_SETTINGS)} 91 00 (usine) ` +
        `ou ${hexSpaced(expectedFileSettings)} 91 00 (déjà configuré par Taply) ; sinon ARRÊT (puce préconfigurée par un tiers)`,
      needsAuthWithKey: null,
      secretsUsed: [],
    },
    {
      id: 'authenticate-key0',
      title: 'AuthenticateEV2First clé 0 avec la clé usine (16 × 00)',
      apduDescription:
        '90 71 00 00 02 00 00 00 → E(K0, RndB) 91 AF ; 90 AF 00 00 20 <E(K0, RndA ‖ RndB′)> 00 → E(K0, TI ‖ RndA′ ‖ PDcap2 ‖ PCDcap2) 91 00. ' +
        'Échec 91 AE ⇒ clé 0 non usine : AUCUN forçage (une seule tentative avec la clé Taply si le fichier est déjà configuré par Taply, sinon arrêt)',
      needsAuthWithKey: null,
      secretsUsed: ['clé usine 0 (00×16, publique)', 'appMasterKey (seulement si reprise d’une puce déjà Taply)'],
    },
    {
      id: 'get-card-uid',
      title: 'GetCardUID (CommMode.Full) et comparaison avec --uid',
      apduDescription: '90 51 00 00 08 <MACt> 00 → E(SesAuthENC, UID ‖ 80 00…) ‖ MACt 91 00 ; UID ≠ --uid ⇒ ARRÊT avant toute écriture',
      needsAuthWithKey: 0,
      secretsUsed: ['clés de session'],
    },
    {
      id: 'write-ndef',
      title: `WriteData fichier 02 en clair (${ndefLen} octets, Write=E usine)`,
      apduDescription:
        `90 8D 00 00 ${hexSpaced(Buffer.from([7 + ndefLen]))} | FileNo 02 | Offset 00 00 00 | Length ${lenHex} | NDEF | 00 → 91 00 ; ` +
        `APDU complet : ${hexSpaced(buildWriteDataPlain(NDEF_FILE_NO, 0, ndef.bytes))}`,
      needsAuthWithKey: null,
      secretsUsed: [],
    },
    {
      id: 'change-file-settings',
      title: 'ChangeFileSettings fichier 02 : SDM + droits définitifs (CommMode.Full)',
      apduDescription: `90 5F 00 00 19 02 <E(SesAuthENC, ${hexSpaced(fileSettings)} ‖ 80)> <MACt> 00 → MACt 91 00`,
      needsAuthWithKey: 0,
      secretsUsed: ['clés de session'],
    },
    {
      id: 'verify-file-settings',
      title: 'GetFileSettings fichier 02 (CommMode.MAC) : relecture des réglages',
      apduDescription: `90 F5 00 00 09 02 <MACt> 00 → attendu ${hexSpaced(expectedFileSettings)} ‖ MACt 91 00`,
      needsAuthWithKey: 0,
      secretsUsed: ['clés de session'],
    },
    changeKeyStep(1, 'sdmMetaReadKey', keyVersion),
    changeKeyStep(2, 'sdmFileReadKey', keyVersion),
    changeKeyStep(3, 'changeKey', keyVersion),
    changeKeyStep(4, 'changeKey', keyVersion),
    {
      id: 'change-key-0',
      title: `ChangeKey 0 ← appMasterKey (EN DERNIER : met fin à la session)`,
      apduDescription:
        `90 C4 00 00 29 00 <E(SesAuthENC, appMasterKey ‖ ${keyVersion.toString(16).toUpperCase().padStart(2, '0')} ‖ 80 00…)> <MACt> 00 → 91 00 (sans MAC)`,
      needsAuthWithKey: 0,
      secretsUsed: ['appMasterKey', 'clés de session'],
    },
    {
      id: 'verify-sun-read',
      title: 'Relecture non authentifiée du NDEF et vérification SUN locale (même code que le serveur)',
      apduDescription:
        `${selectHex} puis ${hexSpaced(buildReadDataPlain(NDEF_FILE_NO, 0, ndefLen))} → URL miroir ; verifySunMessage doit accepter e/c, UID = --uid. ` +
        'Si les placeholders sont encore à zéro (puce restée authentifiée), retirer la puce du champ et relancer la vérification',
      needsAuthWithKey: null,
      secretsUsed: ['sdmMetaReadKey', 'sdmFileReadKey (vérification locale uniquement)'],
    },
  ];

  return {
    uidHex,
    keyVersion,
    host: input.host,
    ndef,
    fileSettingsSpec,
    fileSettings,
    expectedFileSettings,
    factoryFileSettings: Buffer.from(FACTORY_NDEF_FILE_SETTINGS),
    keySlots: KEY_SLOTS,
    steps,
  };
}

// ── Transport & execution ───────────────────────────────────────────

/**
 * Transport APDU (implémentation PC/SC à venir, matériel non reçu).
 * Contrat : envoie UN C-APDU court et renvoie le R-APDU complet (données +
 * SW1 SW2). L'implémentation NE DOIT PAS journaliser les APDU (cf. en-tête).
 */
export interface Transport {
  transmit(apdu: Buffer): Promise<Buffer>;
}

export interface StepEvent {
  readonly step: StepId;
  readonly status: 'ok' | 'skipped' | 'info';
  /** Texte sans secret (statuts, versions de clés, compteurs). */
  readonly detail: string;
}

export interface RunOptions {
  /** Source d'aléa pour RndA (tests). Défaut : crypto.randomBytes. */
  readonly random?: (size: number) => Buffer;
  readonly onStep?: (event: StepEvent) => void;
}

export type VerificationResult =
  | { readonly status: 'verified'; readonly readCtr: number }
  | { readonly status: 'not_mirrored' };

export interface ProvisioningReport {
  readonly outcome: 'provisioned' | 'already_provisioned';
  readonly verification: VerificationResult;
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.equals(b);
}

async function exchange(transport: Transport, apdu: Buffer, step: StepId): Promise<Buffer> {
  try {
    return await transport.transmit(apdu);
  } catch (error) {
    throw new ProvisioningError('card_error', step, `transport failure: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function cardError(step: StepId, error: unknown): ProvisioningError {
  if (error instanceof ProvisioningError) return error;
  if (error instanceof Ntag424Error) return new ProvisioningError('card_error', step, error.message, error.sw);
  return new ProvisioningError('card_error', step, error instanceof Error ? error.message : String(error));
}

/** AuthenticateEV2First ; renvoie null si le PICC refuse la clé (91 AE en partie 2). */
async function authenticateFirst(transport: Transport, keyNo: number, key: Buffer, random: (n: number) => Buffer): Promise<Ev2Session | null> {
  const step: StepId = 'authenticate-key0';
  const encRndB = parseAuthenticatePart1Response(await exchange(transport, buildAuthenticateEv2FirstPart1(keyNo), step));
  const rndA = random(16);
  const part2 = authenticateEv2FirstStep2(key, encRndB, rndA);
  const rapdu = await exchange(transport, part2.apdu, step);
  if (splitResponse(rapdu).sw === SW.AUTHENTICATION_ERROR) return null;
  return verifyAuthenticateEv2FirstResponse(key, rapdu, rndA, part2.rndB).session;
}

/**
 * Relit le NDEF SANS authentification et vérifie le message SUN avec le
 * code du serveur (verifySunMessage) et les clés dérivées du tag.
 * À relancer seule après avoir retiré/représenté la puce si `not_mirrored`.
 */
export async function verifyProvisionedTag(transport: Transport, plan: ProvisioningPlan, keys: ProvisioningKeys): Promise<VerificationResult> {
  const step: StepId = 'verify-sun-read';
  try {
    expectStatus(await exchange(transport, buildIsoSelectNdefApplication(), step), SW.ISO_OK, 'ISOSelectFile');
    const data = expectStatus(
      await exchange(transport, buildReadDataPlain(NDEF_FILE_NO, 0, plan.ndef.bytes.length), step),
      SW.OPERATION_OK,
      'ReadData',
    );
    const url = parseNdefUriFile(data);
    const expectedPrefix = plan.ndef.templateUrl.slice(0, plan.ndef.templateUrl.indexOf('?'));
    if (!url.startsWith(`${expectedPrefix}?`)) {
      throw new ProvisioningError('verification_failed', step, 'NDEF read back does not match the planned URL');
    }
    const params = extractSunParams(url);
    if (isUnmirrored(params)) return { status: 'not_mirrored' };
    const metaKey = keys.slot(1);
    const fileKey = keys.slot(2);
    try {
      const result = verifySunMessage({
        e: params.e,
        c: params.c,
        sdmMetaReadKey: metaKey,
        fileReadKeyForUid: (uidHex) => (uidHex === plan.uidHex ? fileKey : undefined),
      });
      if (!result.ok) throw new ProvisioningError('verification_failed', step, `SUN message rejected (${result.reason})`);
      if (result.uidHex !== plan.uidHex) throw new ProvisioningError('verification_failed', step, 'SUN message carries another UID');
      return { status: 'verified', readCtr: result.readCtr };
    } finally {
      metaKey.fill(0);
      fileKey.fill(0);
    }
  } catch (error) {
    throw cardError(step, error);
  }
}

/**
 * Exécute le plan de bout en bout sur une puce présente.
 *  - Puce usine : personnalisation complète puis vérification SUN.
 *  - Puce partiellement personnalisée par cet outil (coupure) : reprise
 *    (GetKeyVersion indique quelles clés sont déjà posées).
 *  - Puce déjà entièrement personnalisée par Taply : contrôles + vérification.
 *  - Toute autre puce (clés ou réglages inconnus) : ARRÊT sans rien forcer.
 * @throws ProvisioningError (code + étape + SW éventuel).
 */
export async function runProvisioning(
  transport: Transport,
  plan: ProvisioningPlan,
  keys: ProvisioningKeys,
  options: RunOptions = {},
): Promise<ProvisioningReport> {
  if (keys.uidHex !== plan.uidHex || keys.keyVersion !== plan.keyVersion) {
    throw new ProvisioningError('invalid_input', 'input', 'keys were derived for another UID or key version');
  }
  const random = options.random ?? randomBytes;
  const emit = (step: StepId, status: StepEvent['status'], detail: string): void => options.onStep?.({ step, status, detail });
  let step: StepId = 'select-application';
  let alreadyProvisioned = false;

  try {
    // 1. Sélection de l'application.
    expectStatus(await exchange(transport, buildIsoSelectNdefApplication(), step), SW.ISO_OK, 'ISOSelectFile');
    emit(step, 'ok', '90 00');

    // 2. Contrôle préalable, non authentifié.
    step = 'precheck-file-settings';
    const current = expectStatus(
      await exchange(transport, buildGetFileSettingsPlain(NDEF_FILE_NO), step),
      SW.OPERATION_OK,
      'GetFileSettings',
    );
    const factoryLayout = sameBytes(current, plan.factoryFileSettings);
    const taplyLayout = sameBytes(current, plan.expectedFileSettings);
    if (!factoryLayout && !taplyLayout) {
      throw new ProvisioningError('precheck_unexpected_settings', step, 'NDEF file settings are neither factory nor Taply: tag pre-configured by a third party, nothing changed');
    }
    emit(step, 'ok', factoryLayout ? 'réglages usine' : 'réglages Taply déjà présents (reprise ou puce déjà programmée)');

    // 3. Authentification clé 0 : usine d'abord, jamais de forçage.
    step = 'authenticate-key0';
    const factoryKey = Buffer.alloc(16);
    let session = await authenticateFirst(transport, 0, factoryKey, random);
    if (session === null) {
      if (!taplyLayout) {
        throw new ProvisioningError('factory_key_rejected', step, 'key 0 is not the factory key: tag locked by someone else, nothing changed — contact the supplier', SW.AUTHENTICATION_ERROR);
      }
      const appMasterKey = keys.slot(0);
      try {
        session = await authenticateFirst(transport, 0, appMasterKey, random);
      } finally {
        appMasterKey.fill(0);
      }
      if (session === null) {
        throw new ProvisioningError('factory_key_rejected', step, 'key 0 is neither the factory key nor this tag\'s Taply key: nothing changed', SW.AUTHENTICATION_ERROR);
      }
      alreadyProvisioned = true;
    }
    emit(step, 'ok', alreadyProvisioned ? 'clé 0 Taply acceptée (puce déjà personnalisée)' : 'clé usine acceptée');
    let cmdCtr = 0;

    // 4. UID réel.
    step = 'get-card-uid';
    const uid = parseGetCardUidResponse(session, cmdCtr, await exchange(transport, buildGetCardUid(session, cmdCtr), step));
    cmdCtr++;
    const uidHex = uid.toString('hex').toUpperCase();
    if (uidHex !== plan.uidHex) {
      throw new ProvisioningError('uid_mismatch', step, `tag UID ${uidHex} differs from planned UID ${plan.uidHex}: nothing written`);
    }
    emit(step, 'ok', `UID ${uidHex}`);

    if (alreadyProvisioned) {
      emit('write-ndef', 'skipped', 'puce déjà personnalisée');
      emit('change-file-settings', 'skipped', 'puce déjà personnalisée');
    } else {
      // 5. NDEF en clair (Write=E usine, ou Write=0 + auth clé 0 en reprise).
      step = 'write-ndef';
      expectStatus(await exchange(transport, buildWriteDataPlain(NDEF_FILE_NO, 0, plan.ndef.bytes), step), SW.OPERATION_OK, 'WriteData');
      cmdCtr++; // CommMode.Plain sous authentification : le compteur avance (§9.1.8)
      emit(step, 'ok', `${plan.ndef.bytes.length} octets`);

      // 6. Réglages SDM définitifs.
      step = 'change-file-settings';
      decryptFullResponse(session, cmdCtr, await exchange(transport, buildChangeFileSettings(session, cmdCtr, NDEF_FILE_NO, plan.fileSettings), step));
      cmdCtr++;
      emit(step, 'ok', '91 00, MAC réponse vérifiée');
    }

    // 7. Relecture des réglages (MAC).
    step = 'verify-file-settings';
    const settings = verifyMacResponse(session, cmdCtr, await exchange(transport, buildGetFileSettingsMac(session, cmdCtr, NDEF_FILE_NO), step));
    cmdCtr++;
    if (!sameBytes(settings, plan.expectedFileSettings)) {
      throw new ProvisioningError('verification_failed', step, 'file settings read back differ from the plan');
    }
    emit(step, 'ok', 'réglages conformes');

    // 8. Clés 1 à 4 (GetKeyVersion ⇒ ancienne clé usine ou reprise).
    for (const slot of [1, 2, 3, 4] as const) {
      step = `change-key-${slot}`;
      const versionData = verifyMacResponse(session, cmdCtr, await exchange(transport, buildGetKeyVersionMac(session, cmdCtr, slot), step));
      cmdCtr++;
      const version = versionData.length === 1 ? (versionData[0] ?? -1) : -1;
      if (alreadyProvisioned) {
        if (version !== plan.keyVersion) {
          throw new ProvisioningError('unexpected_key_version', step, `key ${slot} has version ${version}, expected ${plan.keyVersion}`);
        }
        emit(step, 'skipped', `version ${version} déjà posée`);
        continue;
      }
      let oldKey: Buffer;
      if (version === FACTORY_KEY_VERSION) oldKey = Buffer.alloc(16);
      else if (version === plan.keyVersion) oldKey = keys.slot(slot);
      else throw new ProvisioningError('unexpected_key_version', step, `key ${slot} has unexpected version ${version}: nothing forced`);
      const newKey = keys.slot(slot);
      try {
        verifyMacResponse(session, cmdCtr, await exchange(
          transport,
          buildChangeKey(session, cmdCtr, { keyNo: slot, authKeyNo: 0, newKey, newKeyVersion: plan.keyVersion, oldKey }),
          step,
        ));
      } finally {
        newKey.fill(0);
        oldKey.fill(0);
      }
      cmdCtr++;
      emit(step, 'ok', version === FACTORY_KEY_VERSION ? 'remplacée (ancienne = usine)' : 'réappliquée (reprise)');
    }

    // 9. Clé 0 en dernier : la session s'arrête là.
    step = 'change-key-0';
    if (alreadyProvisioned) {
      emit(step, 'skipped', 'clé 0 Taply déjà en place');
    } else {
      const appMasterKey = keys.slot(0);
      let rapdu: Buffer;
      try {
        rapdu = await exchange(
          transport,
          buildChangeKey(session, cmdCtr, { keyNo: 0, authKeyNo: 0, newKey: appMasterKey, newKeyVersion: plan.keyVersion, oldKey: null }),
          step,
        );
      } finally {
        appMasterKey.fill(0);
      }
      const rest = expectStatus(rapdu, SW.OPERATION_OK, 'ChangeKey 0');
      if (rest.length !== 0) throw new ProvisioningError('card_error', step, 'unexpected data after ChangeKey of the authenticated key');
      emit(step, 'ok', '91 00 (session terminée par le PICC)');
    }
  } catch (error) {
    throw cardError(step, error);
  }

  // 10. Vérification SUN (non authentifiée).
  const verification = await verifyProvisionedTag(transport, plan, keys);
  emit('verify-sun-read', verification.status === 'verified' ? 'ok' : 'info',
    verification.status === 'verified' ? `SUN valide, SDMReadCtr = ${verification.readCtr}` : 'URL non miroitée : retirer la puce et relancer la vérification');
  return { outcome: alreadyProvisioned ? 'already_provisioned' : 'provisioned', verification };
}
