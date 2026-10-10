/**
 * NTAG 424 DNA (NT4H2421Gx) — protocole EV2 côté lecteur (PCD), mode AES.
 *
 * Fonctions PURES (aucune E/S) : authentification AuthenticateEV2First /
 * NonFirst, clés de session, secure messaging CommMode.MAC / CommMode.Full,
 * et construction des APDU ISO 7816-4 (CLA 90) utilisés par la
 * personnalisation Taply. Le transport (PC/SC) est hors de ce module.
 *
 * Sources (lues, puis reproduites octet pour octet par
 * tests/unit/nfc/ev2.test.ts) :
 *   - NXP NT4H2421Gx « NTAG 424 DNA » datasheet Rev. 3.0 (31 janv. 2019) :
 *     §8.2.3 droits d'accès, §9.1.2–9.1.10 secure messaging, §10 commandes.
 *   - NXP AN12196 Rev. 2.0 (4 mars 2025) : §4.3, §5.3–5.16, §6.2–6.3.
 *
 * Conventions (datasheet §8.3–8.4) :
 *   - paramètres « plain » multi-octets (offsets, longueurs, CmdCtr) : LSB d'abord ;
 *   - clés, aléas, TI et MAC : ordre MSB d'abord, tels quels sur l'interface ;
 *   - MACt = octets d'indices impairs (1, 3, …, 15) du CMAC de 16 octets
 *     (« even-numbered bytes » en numérotation 1..16).
 *
 * SÉCURITÉ : ce module manipule des clés en clair. Aucune fonction ici ne
 * journalise quoi que ce soit. Attention : une session ouverte avec la clé
 * usine (16 × 00, publique) est déchiffrable par quiconque enregistre les
 * APDU — ne JAMAIS journaliser les APDU d'une personnalisation.
 */

import { createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { aesCmac } from '../../backend/nfc/aes-cmac.js';

// ── Constants ───────────────────────────────────────────────────────

const BLOCK = 16;
const KEY_SIZE = 16;
const MAC_SIZE = 8;
const ZERO_IV = Buffer.alloc(BLOCK);
const EMPTY = Buffer.alloc(0);
const MAX_CMD_CTR = 0xfffe; // à FFFFh le PICC refuse la commande (§9.1.2)
const MAX_LC = 255; // APDU courts uniquement (§8.4)

/** DF name ISO de l'application NDEF (§8.2.2, AN12196 Table 9). */
export const NDEF_APPLICATION_DF_NAME: Buffer = Buffer.from('D2760000850101', 'hex');
/** Fichier NDEF : FileNo 02h, ISO FID E104h, 256 octets (§8.2.3, Table 5). */
export const NDEF_FILE_NO = 0x02;
export const NDEF_FILE_SIZE = 256;
/** Nombre de clés applicatives (§8.2.4.2). */
export const APP_KEY_COUNT = 5;

/** Codes commande natifs (§10.2, Table 22). */
export const INS = {
  AUTHENTICATE_EV2_FIRST: 0x71,
  AUTHENTICATE_EV2_NON_FIRST: 0x77,
  ADDITIONAL_FRAME: 0xaf,
  GET_CARD_UID: 0x51,
  GET_KEY_VERSION: 0x64,
  CHANGE_KEY: 0xc4,
  CHANGE_FILE_SETTINGS: 0x5f,
  GET_FILE_SETTINGS: 0xf5,
  READ_DATA: 0xad,
  WRITE_DATA: 0x8d,
} as const;

/** Mots d'état utilisés par la logique (Tables 23–24). */
export const SW = {
  OPERATION_OK: 0x9100,
  ADDITIONAL_FRAME: 0x91af,
  AUTHENTICATION_ERROR: 0x91ae,
  INTEGRITY_ERROR: 0x911e,
  PERMISSION_DENIED: 0x919d,
  ISO_OK: 0x9000,
} as const;

const STATUS_NAMES: Readonly<Record<number, string>> = {
  0x9100: 'OPERATION_OK',
  0x911c: 'ILLEGAL_COMMAND_CODE',
  0x911e: 'INTEGRITY_ERROR',
  0x9140: 'NO_SUCH_KEY',
  0x917e: 'LENGTH_ERROR',
  0x919d: 'PERMISSION_DENIED',
  0x919e: 'PARAMETER_ERROR',
  0x91ad: 'AUTHENTICATION_DELAY',
  0x91ae: 'AUTHENTICATION_ERROR',
  0x91af: 'ADDITIONAL_FRAME',
  0x91be: 'BOUNDARY_ERROR',
  0x91ca: 'COMMAND_ABORTED',
  0x91ee: 'MEMORY_ERROR',
  0x91f0: 'FILE_NOT_FOUND',
  0x9000: 'ISO_OK',
  0x6700: 'ISO_WRONG_LENGTH',
  0x6982: 'ISO_SECURITY_STATUS_NOT_SATISFIED',
  0x6985: 'ISO_CONDITIONS_OF_USE_NOT_SATISFIED',
  0x6a80: 'ISO_INCORRECT_DATA',
  0x6a82: 'ISO_FILE_OR_APPLICATION_NOT_FOUND',
  0x6a86: 'ISO_INCORRECT_P1_P2',
  0x6a87: 'ISO_LC_INCONSISTENT',
  0x6d00: 'ISO_INS_NOT_SUPPORTED',
  0x6e00: 'ISO_CLA_NOT_SUPPORTED',
};

// ── Errors ──────────────────────────────────────────────────────────

/** Erreur protocole (statut inattendu, MAC invalide, réponse mal formée). */
export class Ntag424Error extends Error {
  readonly sw: number | null;

  constructor(message: string, sw: number | null = null) {
    super(sw === null ? message : `${message} (SW ${hex16(sw)} ${statusName(sw)})`);
    this.name = 'Ntag424Error';
    this.sw = sw;
  }
}

function hex16(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, '0');
}

export function statusName(sw: number): string {
  return STATUS_NAMES[sw] ?? 'UNKNOWN_STATUS';
}

// ── Byte helpers ────────────────────────────────────────────────────

function assertBytes(value: unknown, name: string): asserts value is Buffer {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${name} must be a Buffer`);
}

function assertLength(value: unknown, length: number, name: string): asserts value is Buffer {
  assertBytes(value, name);
  if (value.length !== length) throw new TypeError(`${name} must be ${length} bytes, got ${value.length}`);
}

function assertKey(value: unknown, name: string): asserts value is Buffer {
  assertLength(value, KEY_SIZE, name);
}

function assertByte(value: unknown, name: string, max = 0xff): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new TypeError(`${name} must be an integer in 0..${max}`);
  }
}

function assertKeyNo(keyNo: unknown): asserts keyNo is number {
  assertByte(keyNo, 'keyNo', APP_KEY_COUNT - 1);
}

function assertCmdCtr(cmdCtr: unknown): asserts cmdCtr is number {
  assertByte(cmdCtr, 'cmdCtr', MAX_CMD_CTR);
}

function bytes(...values: number[]): Buffer {
  return Buffer.from(values);
}

/** Entier non signé 16 bits, LSB d'abord. */
export function u16le(value: number): Buffer {
  assertByte(value, 'u16', 0xffff);
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value, 0);
  return out;
}

/** Entier non signé 24 bits, LSB d'abord (offsets, longueurs, compteurs SDM). */
export function u24le(value: number): Buffer {
  assertByte(value, 'u24', 0xffffff);
  const out = Buffer.alloc(3);
  out.writeUIntLE(value, 0, 3);
  return out;
}

export function xorBytes(a: Buffer, b: Buffer): Buffer {
  if (a.length !== b.length) throw new TypeError('xor operands must have the same length');
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] ?? 0) ^ (b[i] ?? 0);
  return out;
}

/** Rotation d'un octet vers la gauche : RndB' = RndB[1..15] || RndB[0]. */
export function rotateLeft1(data: Buffer): Buffer {
  return Buffer.concat([data.subarray(1), data.subarray(0, 1)]);
}

export function rotateRight1(data: Buffer): Buffer {
  return Buffer.concat([data.subarray(data.length - 1), data.subarray(0, data.length - 1)]);
}

function equalBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── AES primitives (node:crypto) ────────────────────────────────────

export function aesEncryptBlock(key: Buffer, block: Buffer): Buffer {
  assertKey(key, 'key');
  assertLength(block, BLOCK, 'block');
  const cipher = createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]);
}

/** AES-128-CBC sans padding automatique (longueur multiple de 16). */
export function aesCbcEncrypt(key: Buffer, iv: Buffer, data: Buffer): Buffer {
  assertKey(key, 'key');
  assertLength(iv, BLOCK, 'iv');
  if (data.length % BLOCK !== 0) throw new TypeError('CBC input must be a multiple of 16 bytes');
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

export function aesCbcDecrypt(key: Buffer, iv: Buffer, data: Buffer): Buffer {
  assertKey(key, 'key');
  assertLength(iv, BLOCK, 'iv');
  if (data.length % BLOCK !== 0) throw new TypeError('CBC input must be a multiple of 16 bytes');
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/**
 * Padding ISO/IEC 9797-1 méthode 2 (§9.1.4) : TOUJOURS 80h puis des zéros
 * jusqu'au multiple de 16 (un bloc entier est ajouté si déjà aligné).
 */
export function padIso9797M2(data: Buffer): Buffer {
  const total = (Math.floor(data.length / BLOCK) + 1) * BLOCK;
  const out = Buffer.alloc(total);
  data.copy(out);
  out[data.length] = 0x80;
  return out;
}

export function unpadIso9797M2(data: Buffer): Buffer {
  if (data.length === 0 || data.length % BLOCK !== 0) throw new Ntag424Error('invalid padded length');
  let i = data.length - 1;
  while (i >= 0 && data[i] === 0x00) i--;
  if (i < 0 || data[i] !== 0x80 || data.length - i > BLOCK) throw new Ntag424Error('invalid ISO 9797-1 M2 padding');
  return Buffer.from(data.subarray(0, i));
}

/** MACt : octets d'indices impairs du CMAC (§9.1.3, AN12196 Table 7). */
export function truncateMac(cmac: Buffer): Buffer {
  assertLength(cmac, BLOCK, 'cmac');
  const out = Buffer.alloc(MAC_SIZE);
  for (let i = 0; i < MAC_SIZE; i++) out[i] = cmac[2 * i + 1] ?? 0;
  return out;
}

export function macT(key: Buffer, message: Buffer): Buffer {
  return truncateMac(aesCmac(key, message));
}

let crcTable: Uint32Array | undefined;

/**
 * CRC32NK de ChangeKey (Table 63 : « IEEE 802.3 FCS »). Le vecteur AN12196
 * Table 25 (CRC32(NewKey) = 789DFADC) n'est reproduit qu'avec : polynôme
 * réfléchi EDB88320h, init FFFFFFFFh, SANS complément final, sortie LSB
 * d'abord (variante dite « JAMCRC »).
 */
export function crc32Nk(data: Buffer): Buffer {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = ((crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)) >>> 0;
  const out = Buffer.alloc(4);
  out.writeUInt32LE(crc >>> 0, 0);
  return out;
}

// ── APDU framing & responses ────────────────────────────────────────

/** Commande native encapsulée ISO 7816-4 : 90 INS 00 00 [Lc Data] 00 (§8.4). */
export function wrapNative(ins: number, data: Buffer = EMPTY): Buffer {
  assertByte(ins, 'ins');
  if (data.length > MAX_LC) throw new TypeError(`APDU data too long (${data.length} > ${MAX_LC})`);
  if (data.length === 0) return bytes(0x90, ins, 0x00, 0x00, 0x00);
  return Buffer.concat([bytes(0x90, ins, 0x00, 0x00, data.length), data, bytes(0x00)]);
}

export interface ResponseApdu {
  readonly data: Buffer;
  readonly sw: number;
}

export function splitResponse(rapdu: Buffer): ResponseApdu {
  assertBytes(rapdu, 'rapdu');
  if (rapdu.length < 2) throw new Ntag424Error(`R-APDU too short (${rapdu.length} bytes)`);
  return {
    data: Buffer.from(rapdu.subarray(0, rapdu.length - 2)),
    sw: rapdu.readUInt16BE(rapdu.length - 2),
  };
}

/** Vérifie le mot d'état et renvoie les données (sans SW). */
export function expectStatus(rapdu: Buffer, expected: number, context: string): Buffer {
  const { data, sw } = splitResponse(rapdu);
  if (sw !== expected) throw new Ntag424Error(`${context}: unexpected status`, sw);
  return data;
}

// ── ISO commands ────────────────────────────────────────────────────

/** ISOSelectFile par DF name (P1=04, P2=0C : pas de FCI) — AN12196 Table 9. */
export function buildIsoSelectByDfName(dfName: Buffer): Buffer {
  assertBytes(dfName, 'dfName');
  if (dfName.length < 1 || dfName.length > 16) throw new TypeError('DF name must be 1..16 bytes');
  return Buffer.concat([bytes(0x00, 0xa4, 0x04, 0x0c, dfName.length), dfName, bytes(0x00)]);
}

export function buildIsoSelectNdefApplication(): Buffer {
  return buildIsoSelectByDfName(NDEF_APPLICATION_DF_NAME);
}

// ── Authentication (§9.1.5–9.1.7, §10.4) ────────────────────────────

export interface Ev2Session {
  /** Transaction Identifier (4 octets), constant pendant la transaction. */
  readonly ti: Buffer;
  readonly sesAuthEncKey: Buffer;
  readonly sesAuthMacKey: Buffer;
}

/** Part 1 : 90 71 00 00 02 KeyNo LenCap=00 00 (aucun PCDcap2 ⇒ AES, pas LRP). */
export function buildAuthenticateEv2FirstPart1(keyNo: number): Buffer {
  assertKeyNo(keyNo);
  return wrapNative(INS.AUTHENTICATE_EV2_FIRST, bytes(keyNo, 0x00));
}

/** Part 1 NonFirst : 90 77 00 00 01 KeyNo 00 (TI et CmdCtr conservés). */
export function buildAuthenticateEv2NonFirstPart1(keyNo: number): Buffer {
  assertKeyNo(keyNo);
  return wrapNative(INS.AUTHENTICATE_EV2_NON_FIRST, bytes(keyNo));
}

/**
 * Réponse Part 1 : E(Kx, RndB) (16 octets) + 91AF. Une réponse de 17 octets
 * signale un PICC configuré en LRP (§9, Table 19) : non supporté ici.
 */
export function parseAuthenticatePart1Response(rapdu: Buffer): Buffer {
  const { data, sw } = splitResponse(rapdu);
  if (sw !== SW.ADDITIONAL_FRAME) throw new Ntag424Error('Authenticate part 1 rejected', sw);
  if (data.length === 17) throw new Ntag424Error('PICC answered with an LRP AuthMode: LRP mode is not supported');
  if (data.length !== BLOCK) throw new Ntag424Error(`Authenticate part 1: expected 16 bytes, got ${data.length}`);
  return data;
}

export interface AuthenticateStep2 {
  /** RndB déchiffré (secret de session : ne pas journaliser). */
  readonly rndB: Buffer;
  /** E(Kx, RndA || RndB') — 32 octets, IV nul, sans padding. */
  readonly pcdCryptogram: Buffer;
  /** APDU Part 2 : 90 AF 00 00 20 <cryptogramme> 00. */
  readonly apdu: Buffer;
}

/**
 * Calcule la réponse du PCD (identique pour First et NonFirst) :
 * RndB = D(Kx, E(Kx,RndB)) ; RndB' = rotl1(RndB) ; E(Kx, RndA || RndB').
 */
export function authenticateEv2FirstStep2(key: Buffer, encRndB: Buffer, rndA: Buffer): AuthenticateStep2 {
  assertKey(key, 'key');
  assertLength(encRndB, BLOCK, 'encRndB');
  assertLength(rndA, BLOCK, 'rndA');
  const rndB = aesCbcDecrypt(key, ZERO_IV, encRndB);
  const pcdCryptogram = aesCbcEncrypt(key, ZERO_IV, Buffer.concat([rndA, rotateLeft1(rndB)]));
  return { rndB, pcdCryptogram, apdu: wrapNative(INS.ADDITIONAL_FRAME, pcdCryptogram) };
}

/**
 * Vecteurs de session (§9.1.7) — notation MSB d'abord, RndX[15] = 1er octet :
 *   SV1 = A5 5A 00 01 00 80 || RndA[15..14] || (RndA[13..8] ⊕ RndB[15..10])
 *         || RndB[9..0] || RndA[7..0]
 *   SV2 = idem avec le libellé 5A A5.
 */
export function sessionVectors(rndA: Buffer, rndB: Buffer): { sv1: Buffer; sv2: Buffer } {
  assertLength(rndA, BLOCK, 'rndA');
  assertLength(rndB, BLOCK, 'rndB');
  const context = Buffer.concat([
    rndA.subarray(0, 2), // RndA[15..14]
    xorBytes(rndA.subarray(2, 8), rndB.subarray(0, 6)), // RndA[13..8] ⊕ RndB[15..10]
    rndB.subarray(6, 16), // RndB[9..0]
    rndA.subarray(8, 16), // RndA[7..0]
  ]);
  const fixed = bytes(0x00, 0x01, 0x00, 0x80); // compteur 0001h, longueur 0080h
  return {
    sv1: Buffer.concat([bytes(0xa5, 0x5a), fixed, context]),
    sv2: Buffer.concat([bytes(0x5a, 0xa5), fixed, context]),
  };
}

/** SesAuthENCKey = CMAC(Kx, SV1) ; SesAuthMACKey = CMAC(Kx, SV2). */
export function deriveSessionKeys(key: Buffer, rndA: Buffer, rndB: Buffer): { sesAuthEncKey: Buffer; sesAuthMacKey: Buffer } {
  assertKey(key, 'key');
  const { sv1, sv2 } = sessionVectors(rndA, rndB);
  return { sesAuthEncKey: aesCmac(key, sv1), sesAuthMacKey: aesCmac(key, sv2) };
}

/**
 * Vérifie la réponse Part 2 de AuthenticateEV2First :
 * D(Kx, ·) = TI(4) || RndA'(16) || PDcap2(6) || PCDcap2(6), RndA' = rotl1(RndA).
 * @throws Ntag424Error si statut ≠ 9100 (91AE = mauvaise clé) ou RndA' faux.
 */
export function verifyAuthenticateEv2FirstResponse(
  key: Buffer,
  rapdu: Buffer,
  rndA: Buffer,
  rndB: Buffer,
): { session: Ev2Session; pdCap2: Buffer; pcdCap2: Buffer } {
  assertKey(key, 'key');
  const data = expectStatus(rapdu, SW.OPERATION_OK, 'AuthenticateEV2First part 2');
  if (data.length !== 2 * BLOCK) throw new Ntag424Error(`AuthenticateEV2First part 2: expected 32 bytes, got ${data.length}`);
  const plain = aesCbcDecrypt(key, ZERO_IV, data);
  const ti = Buffer.from(plain.subarray(0, 4));
  if (!equalBytes(plain.subarray(4, 20), rotateLeft1(rndA))) {
    throw new Ntag424Error('AuthenticateEV2First: RndA\' mismatch, PICC not authenticated');
  }
  const pdCap2 = Buffer.from(plain.subarray(20, 26));
  const pcdCap2 = Buffer.from(plain.subarray(26, 32));
  return { session: { ti, ...deriveSessionKeys(key, rndA, rndB) }, pdCap2, pcdCap2 };
}

/** Réponse Part 2 de NonFirst : E(Kx, RndA') seul ; TI conservé (§9.1.6). */
export function verifyAuthenticateEv2NonFirstResponse(
  key: Buffer,
  rapdu: Buffer,
  rndA: Buffer,
  rndB: Buffer,
  ti: Buffer,
): Ev2Session {
  assertKey(key, 'key');
  assertLength(ti, 4, 'ti');
  const data = expectStatus(rapdu, SW.OPERATION_OK, 'AuthenticateEV2NonFirst part 2');
  if (data.length !== BLOCK) throw new Ntag424Error(`AuthenticateEV2NonFirst part 2: expected 16 bytes, got ${data.length}`);
  const plain = aesCbcDecrypt(key, ZERO_IV, data);
  if (!equalBytes(plain, rotateLeft1(rndA))) {
    throw new Ntag424Error('AuthenticateEV2NonFirst: RndA\' mismatch, PICC not authenticated');
  }
  return { ti: Buffer.from(ti), ...deriveSessionKeys(key, rndA, rndB) };
}

// ── Secure messaging (§9.1.2–9.1.10) ────────────────────────────────
//
// `cmdCtr` est TOUJOURS la valeur courante utilisée pour la COMMANDE.
// La réponse est calculée avec cmdCtr + 1 (le PICC incrémente entre les
// deux). L'appelant incrémente son compteur après chaque échange
// authentifié, y compris en CommMode.Plain (§9.1.8).

function ivFor(session: Ev2Session, label: Buffer, ctr: number): Buffer {
  return aesEncryptBlock(session.sesAuthEncKey, Buffer.concat([label, session.ti, u16le(ctr), Buffer.alloc(8)]));
}

/** IVc = E(SesAuthENCKey, A5 5A || TI || CmdCtr || 00×8). */
export function commandIv(session: Ev2Session, cmdCtr: number): Buffer {
  assertCmdCtr(cmdCtr);
  return ivFor(session, bytes(0xa5, 0x5a), cmdCtr);
}

/** IVr = E(SesAuthENCKey, 5A A5 || TI || (CmdCtr+1) || 00×8). */
export function responseIv(session: Ev2Session, cmdCtr: number): Buffer {
  assertCmdCtr(cmdCtr);
  return ivFor(session, bytes(0x5a, 0xa5), cmdCtr + 1);
}

/** MACt(SesAuthMACKey, Cmd || CmdCtr || TI || CmdHeader || Data). */
export function commandMac(session: Ev2Session, cmdCtr: number, ins: number, header: Buffer, data: Buffer): Buffer {
  assertCmdCtr(cmdCtr);
  return macT(session.sesAuthMacKey, Buffer.concat([bytes(ins), u16le(cmdCtr), session.ti, header, data]));
}

/** CommMode.MAC : 90 INS 00 00 Lc CmdHeader CmdData MACt 00. */
export function buildMacCommand(session: Ev2Session, cmdCtr: number, ins: number, header: Buffer, data: Buffer = EMPTY): Buffer {
  const mac = commandMac(session, cmdCtr, ins, header, data);
  return wrapNative(ins, Buffer.concat([header, data, mac]));
}

/**
 * CommMode.Full : CmdData chiffré (AES-CBC, IVc, padding M2) puis MAC sur le
 * cryptogramme. Sans CmdData (ex. GetCardUID), seule la MAC est envoyée.
 */
export function buildFullCommand(session: Ev2Session, cmdCtr: number, ins: number, header: Buffer, plainData: Buffer): Buffer {
  const encrypted = plainData.length === 0
    ? EMPTY
    : aesCbcEncrypt(session.sesAuthEncKey, commandIv(session, cmdCtr), padIso9797M2(plainData));
  const mac = commandMac(session, cmdCtr, ins, header, encrypted);
  return wrapNative(ins, Buffer.concat([header, encrypted, mac]));
}

/**
 * Vérifie une réponse CommMode.MAC/Full : RespData || MACt + 91 00, avec
 * MACt(SesAuthMACKey, RC || CmdCtr+1 || TI || RespData). Renvoie RespData
 * (encore chiffré en CommMode.Full). Une erreur PICC n'a jamais de MAC.
 */
export function verifyMacResponse(session: Ev2Session, cmdCtr: number, rapdu: Buffer): Buffer {
  assertCmdCtr(cmdCtr);
  const { data, sw } = splitResponse(rapdu);
  if (sw !== SW.OPERATION_OK) throw new Ntag424Error('secure messaging response', sw);
  if (data.length < MAC_SIZE) throw new Ntag424Error('secure messaging response: missing MAC');
  const respData = Buffer.from(data.subarray(0, data.length - MAC_SIZE));
  const received = data.subarray(data.length - MAC_SIZE);
  const expected = macT(
    session.sesAuthMacKey,
    Buffer.concat([bytes(sw & 0xff), u16le(cmdCtr + 1), session.ti, respData]),
  );
  if (!equalBytes(expected, received)) throw new Ntag424Error('response MAC mismatch (integrity / authenticity failure)');
  return respData;
}

/** CommMode.Full : vérifie la MAC puis déchiffre (IVr) et retire le padding. */
export function decryptFullResponse(session: Ev2Session, cmdCtr: number, rapdu: Buffer): Buffer {
  const encrypted = verifyMacResponse(session, cmdCtr, rapdu);
  if (encrypted.length === 0) return EMPTY;
  return unpadIso9797M2(aesCbcDecrypt(session.sesAuthEncKey, responseIv(session, cmdCtr), encrypted));
}

// ── File settings (§10.7.1–10.7.2, Tables 69 et 73) ─────────────────

export type CommMode = 'plain' | 'mac' | 'full';

/** Conditions d'accès (Table 6) : 0..4 = clé, 0xE = libre, 0xF = jamais. */
export interface AccessRights {
  readonly read: number;
  readonly write: number;
  readonly readWrite: number;
  readonly change: number;
}

/**
 * Sous-ensemble SDM supporté par l'encodeur : PICCData CHIFFRÉES
 * (SDMMetaRead = clé 0..4), pas de SDMENCFileData, pas de SDMReadCtrLimit,
 * encodage ASCII (seul encodage du NT4H2421Gx).
 */
export interface SdmSettings {
  readonly uidMirror: boolean;
  readonly readCtrMirror: boolean;
  /** Clé de chiffrement des PICCData (0..4). */
  readonly metaRead: number;
  /** Clé SDMFileRead pour SDMMAC (0..4) ou 0xF (pas de SDM en lecture). */
  readonly fileRead: number;
  /** Accès à GetFileCounters (0..4, 0xE, 0xF). */
  readonly ctrRet: number;
  readonly piccDataOffset: number;
  readonly macInputOffset: number;
  readonly macOffset: number;
}

export interface FileSettingsSpec {
  readonly commMode: CommMode;
  readonly access: AccessRights;
  readonly sdm: SdmSettings | null;
}

/** Longueurs ASCII des miroirs (§9.3.4.1, §9.3.7) en mode AES. */
export const PICC_DATA_ASCII_LENGTH = 32;
export const SDM_MAC_ASCII_LENGTH = 16;

const COMM_MODE_BITS: Readonly<Record<CommMode, number>> = { plain: 0b00, mac: 0b01, full: 0b11 };

function assertCondition(value: unknown, name: string): asserts value is number {
  if (!Number.isInteger(value) || !(((value as number) >= 0 && (value as number) <= 4) || value === 0xe || value === 0xf)) {
    throw new TypeError(`${name} must be a key number 0..4, 0xE (free) or 0xF (never)`);
  }
}

/**
 * AccessRights sur 2 octets (Table 7 : bits 15..12 Read, 11..8 Write,
 * 7..4 ReadWrite, 3..0 Change), transmis LSB d'abord :
 * octet 0 = RW<<4 | Change, octet 1 = Read<<4 | Write.
 */
export function encodeAccessRights(access: AccessRights): Buffer {
  assertCondition(access.read, 'read');
  assertCondition(access.write, 'write');
  assertCondition(access.readWrite, 'readWrite');
  assertCondition(access.change, 'change');
  return bytes((access.readWrite << 4) | access.change, (access.read << 4) | access.write);
}

export function decodeAccessRights(wire: Buffer): AccessRights {
  const b0 = wire[0] ?? 0;
  const b1 = wire[1] ?? 0;
  return { read: b1 >> 4, write: b1 & 0x0f, readWrite: b0 >> 4, change: b0 & 0x0f };
}

/**
 * SDMAccessRights sur 2 octets (Table 69 : bits 15..12 SDMMetaRead,
 * 11..8 SDMFileRead, 7..4 RFU = F, 3..0 SDMCtrRet), LSB d'abord :
 * octet 0 = F<<4 | CtrRet, octet 1 = MetaRead<<4 | FileRead
 * (AN12196 Table 18 : « F121 » = RFU F, CtrRet 1, MetaRead 2, FileRead 1).
 */
export function encodeSdmAccessRights(sdm: Pick<SdmSettings, 'metaRead' | 'fileRead' | 'ctrRet'>): Buffer {
  return bytes(0xf0 | sdm.ctrRet, (sdm.metaRead << 4) | sdm.fileRead);
}

/**
 * Données de commande de ChangeFileSettings (sans FileNo) :
 * FileOption || AccessRights || [SDMOptions || SDMAccessRights ||
 * PICCDataOffset || SDMMACInputOffset || SDMMACOffset].
 */
export function encodeFileSettings(spec: FileSettingsSpec, fileSize = NDEF_FILE_SIZE): Buffer {
  const fileOption = (spec.sdm === null ? 0x00 : 0x40) | COMM_MODE_BITS[spec.commMode];
  const parts: Buffer[] = [bytes(fileOption), encodeAccessRights(spec.access)];
  const sdm = spec.sdm;
  if (sdm !== null) {
    if (!Number.isInteger(sdm.metaRead) || sdm.metaRead < 0 || sdm.metaRead > 4) {
      throw new TypeError('only encrypted PICCData mirroring (SDMMetaRead = key 0..4) is supported');
    }
    if (!sdm.uidMirror && !sdm.readCtrMirror) throw new TypeError('encrypted PICCData requires UID and/or SDMReadCtr mirroring');
    assertCondition(sdm.fileRead, 'fileRead');
    if (sdm.fileRead === 0xe) throw new TypeError('SDMFileRead = 0xE is RFU');
    assertCondition(sdm.ctrRet, 'ctrRet');
    if (sdm.ctrRet !== 0xf && !sdm.readCtrMirror) throw new TypeError('SDMCtrRet requires SDMReadCtr to be enabled');

    const sdmOptions = (sdm.uidMirror ? 0x80 : 0) | (sdm.readCtrMirror ? 0x40 : 0) | 0x01; // bit0 = ASCII
    parts.push(bytes(sdmOptions), encodeSdmAccessRights(sdm));

    if (!Number.isInteger(sdm.piccDataOffset) || sdm.piccDataOffset < 0 || sdm.piccDataOffset > fileSize - PICC_DATA_ASCII_LENGTH) {
      throw new RangeError('PICCDataOffset out of file bounds');
    }
    parts.push(u24le(sdm.piccDataOffset));

    if (sdm.fileRead !== 0xf) {
      const { macInputOffset, macOffset, piccDataOffset } = sdm;
      if (!Number.isInteger(macOffset) || macOffset < 0 || macOffset > fileSize - SDM_MAC_ASCII_LENGTH) {
        throw new RangeError('SDMMACOffset out of file bounds');
      }
      if (!Number.isInteger(macInputOffset) || macInputOffset < 0 || macInputOffset > macOffset) {
        throw new RangeError('SDMMACInputOffset must be in 0..SDMMACOffset');
      }
      const overlap = !(macOffset >= piccDataOffset + PICC_DATA_ASCII_LENGTH || piccDataOffset >= macOffset + SDM_MAC_ASCII_LENGTH);
      if (overlap) throw new RangeError('SDMMAC and PICCData mirrors overlap');
      parts.push(u24le(macInputOffset), u24le(macOffset));
    }
  }
  return Buffer.concat(parts);
}

export interface ParsedSdmSettings {
  readonly uidMirror: boolean;
  readonly readCtrMirror: boolean;
  readonly readCtrLimitEnabled: boolean;
  readonly encFileData: boolean;
  readonly asciiEncoding: boolean;
  readonly metaRead: number;
  readonly fileRead: number;
  readonly ctrRet: number;
  readonly uidOffset: number | null;
  readonly readCtrOffset: number | null;
  readonly piccDataOffset: number | null;
  readonly macInputOffset: number | null;
  readonly encOffset: number | null;
  readonly encLength: number | null;
  readonly macOffset: number | null;
  readonly readCtrLimit: number | null;
}

export interface ParsedFileSettings {
  readonly fileType: number;
  readonly commMode: CommMode;
  readonly access: AccessRights;
  readonly fileSize: number;
  readonly sdm: ParsedSdmSettings | null;
}

/** Décode la réponse (en clair) de GetFileSettings (Table 73). */
export function parseFileSettings(data: Buffer): ParsedFileSettings {
  let pos = 0;
  const take = (n: number): Buffer => {
    if (pos + n > data.length) throw new Ntag424Error('GetFileSettings response truncated');
    const out = data.subarray(pos, pos + n);
    pos += n;
    return out;
  };
  const u8 = (): number => take(1)[0] ?? 0;
  const u24 = (): number => take(3).readUIntLE(0, 3);

  const fileType = u8();
  const fileOption = u8();
  const access = decodeAccessRights(take(2));
  const fileSize = u24();
  const modeBits = fileOption & 0b11;
  const commMode: CommMode = modeBits === 0b01 ? 'mac' : modeBits === 0b11 ? 'full' : 'plain';

  let sdm: ParsedSdmSettings | null = null;
  if (fileOption & 0x40) {
    const options = u8();
    const ar = take(2);
    const ctrRet = (ar[0] ?? 0) & 0x0f;
    const metaRead = (ar[1] ?? 0) >> 4;
    const fileRead = (ar[1] ?? 0) & 0x0f;
    const uidMirror = (options & 0x80) !== 0;
    const readCtrMirror = (options & 0x40) !== 0;
    const readCtrLimitEnabled = (options & 0x20) !== 0;
    const encFileData = (options & 0x10) !== 0;
    const uidOffset = uidMirror && metaRead === 0xe ? u24() : null;
    const readCtrOffset = readCtrMirror && metaRead === 0xe ? u24() : null;
    const piccDataOffset = metaRead <= 4 ? u24() : null;
    const macInputOffset = fileRead !== 0xf ? u24() : null;
    const encOffset = fileRead !== 0xf && encFileData ? u24() : null;
    const encLength = fileRead !== 0xf && encFileData ? u24() : null;
    const macOffset = fileRead !== 0xf ? u24() : null;
    const readCtrLimit = readCtrLimitEnabled ? u24() : null;
    sdm = {
      uidMirror, readCtrMirror, readCtrLimitEnabled, encFileData, asciiEncoding: (options & 0x01) !== 0,
      metaRead, fileRead, ctrRet, uidOffset, readCtrOffset, piccDataOffset, macInputOffset,
      encOffset, encLength, macOffset, readCtrLimit,
    };
  }
  if (pos !== data.length) throw new Ntag424Error(`GetFileSettings response has ${data.length - pos} unexpected trailing bytes`);
  return { fileType, commMode, access, fileSize, sdm };
}

// ── Command builders ────────────────────────────────────────────────

function fileNoByte(fileNo: number): Buffer {
  assertByte(fileNo, 'fileNo', 0x1f);
  return bytes(fileNo);
}

/** GetFileSettings sans authentification (CommMode.Plain) : 90 F5 00 00 01 FileNo 00. */
export function buildGetFileSettingsPlain(fileNo: number): Buffer {
  return wrapNative(INS.GET_FILE_SETTINGS, fileNoByte(fileNo));
}

/** GetFileSettings authentifié (CommMode.MAC) — AN12196 Table 7. */
export function buildGetFileSettingsMac(session: Ev2Session, cmdCtr: number, fileNo: number): Buffer {
  return buildMacCommand(session, cmdCtr, INS.GET_FILE_SETTINGS, fileNoByte(fileNo));
}

/** GetKeyVersion authentifié (CommMode.MAC) : réponse KeyVer(1) || MACt. */
export function buildGetKeyVersionMac(session: Ev2Session, cmdCtr: number, keyNo: number): Buffer {
  assertKeyNo(keyNo);
  return buildMacCommand(session, cmdCtr, INS.GET_KEY_VERSION, bytes(keyNo));
}

/** GetCardUID (CommMode.Full, aucune donnée de commande) — AN12196 Table 28. */
export function buildGetCardUid(session: Ev2Session, cmdCtr: number): Buffer {
  return buildFullCommand(session, cmdCtr, INS.GET_CARD_UID, EMPTY, EMPTY);
}

/** Déchiffre la réponse GetCardUID : UID de 7 octets. */
export function parseGetCardUidResponse(session: Ev2Session, cmdCtr: number, rapdu: Buffer): Buffer {
  const plain = decryptFullResponse(session, cmdCtr, rapdu);
  if (plain.length !== 7) throw new Ntag424Error(`GetCardUID: expected a 7-byte UID, got ${plain.length} bytes`);
  return plain;
}

export interface ChangeKeyParams {
  /** Clé à changer (0..4). */
  readonly keyNo: number;
  /** Clé de l'authentification en cours : doit être 0 (AppMasterKey, §10.6.1). */
  readonly authKeyNo: number;
  readonly newKey: Buffer;
  /** Version de la nouvelle clé (00h..FFh). */
  readonly newKeyVersion: number;
  /** Valeur ACTUELLE de la clé (requise si keyNo ≠ authKeyNo). */
  readonly oldKey: Buffer | null;
}

/**
 * KeyData en clair de ChangeKey (Table 63) :
 *   - keyNo = clé authentifiée (0)  : NewKey || KeyVer                (17 o)
 *   - sinon                         : (NewKey ⊕ OldKey) || KeyVer || CRC32NK(NewKey)  (21 o)
 */
export function changeKeyData(params: ChangeKeyParams): Buffer {
  assertKeyNo(params.keyNo);
  if (params.authKeyNo !== 0) throw new TypeError('ChangeKey requires an active authentication with key 0 (AppMasterKey)');
  assertKey(params.newKey, 'newKey');
  assertByte(params.newKeyVersion, 'newKeyVersion');
  if (params.keyNo === params.authKeyNo) {
    return Buffer.concat([params.newKey, bytes(params.newKeyVersion)]);
  }
  if (params.oldKey === null) throw new TypeError(`ChangeKey of key ${params.keyNo} requires the current (old) key`);
  assertKey(params.oldKey, 'oldKey');
  return Buffer.concat([xorBytes(params.newKey, params.oldKey), bytes(params.newKeyVersion), crc32Nk(params.newKey)]);
}

/** ChangeKey (CommMode.Full) : 90 C4 00 00 Lc KeyNo E(KeyData) MACt 00. */
export function buildChangeKey(session: Ev2Session, cmdCtr: number, params: ChangeKeyParams): Buffer {
  return buildFullCommand(session, cmdCtr, INS.CHANGE_KEY, bytes(params.keyNo), changeKeyData(params));
}

/** ChangeFileSettings (CommMode.Full) : 90 5F 00 00 Lc FileNo E(settings) MACt 00. */
export function buildChangeFileSettings(session: Ev2Session, cmdCtr: number, fileNo: number, settings: Buffer): Buffer {
  return buildFullCommand(session, cmdCtr, INS.CHANGE_FILE_SETTINGS, fileNoByte(fileNo), settings);
}

function writeHeader(fileNo: number, offset: number, length: number): Buffer {
  if (length < 1) throw new RangeError('WriteData length must be >= 1');
  return Buffer.concat([fileNoByte(fileNo), u24le(offset), u24le(length)]);
}

/** WriteData en clair (fichier en CommMode.Plain) : 90 8D 00 00 Lc FileNo Off(3) Len(3) Data 00. */
export function buildWriteDataPlain(fileNo: number, offset: number, data: Buffer): Buffer {
  return wrapNative(INS.WRITE_DATA, Buffer.concat([writeHeader(fileNo, offset, data.length), data]));
}

/** WriteData en CommMode.Full (fichier configuré Full) — AN12196 Tables 17 et 21. */
export function buildWriteDataFull(session: Ev2Session, cmdCtr: number, fileNo: number, offset: number, data: Buffer): Buffer {
  return buildFullCommand(session, cmdCtr, INS.WRITE_DATA, writeHeader(fileNo, offset, data.length), data);
}

/** ReadData en clair (non authentifié ⇒ SDM appliqué) : 90 AD 00 00 07 FileNo Off(3) Len(3) 00. */
export function buildReadDataPlain(fileNo: number, offset: number, length: number): Buffer {
  return wrapNative(INS.READ_DATA, Buffer.concat([fileNoByte(fileNo), u24le(offset), u24le(length)]));
}
