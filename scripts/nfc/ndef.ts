/**
 * Contenu du fichier NDEF (FileNo 02h / E104h) d'un tag Taply NTAG 424 DNA
 * et offsets SDM correspondants.
 *
 * Format du fichier (NFC Forum Type 4 Tag ; AN12196 §5.7, Tables 15–16) :
 *   NLEN (2 octets, gros-boutiste) || enregistrement NDEF « short record » :
 *   D1 (MB=1 ME=1 SR=1 TNF=01) || 01 (type length) || payload length ||
 *   55 ('U') || 04 (préfixe URI « https:// ») || URL sans « https:// ».
 *
 * URL gabarit : https://<host>/t?e=<32 × '0'>&c=<16 × '0'>
 *   - e : PICCENCData (32 caractères ASCII hex) — PICCDataOffset ;
 *   - c : SDMMAC (16 caractères ASCII hex) — SDMMACOffset ;
 *   - SDMMACInputOffset = SDMMACOffset ⇒ MAC sur une entrée VIDE, comme
 *     l'exige backend/nfc/sdm.ts.
 * Les offsets sont comptés depuis le DÉBUT DU FICHIER (NLEN inclus).
 */

import {
  NDEF_FILE_SIZE,
  PICC_DATA_ASCII_LENGTH,
  SDM_MAC_ASCII_LENGTH,
} from './ev2.js';

// ── Constants ───────────────────────────────────────────────────────

const NLEN_SIZE = 2;
const URI_RECORD_HEADER = Buffer.from([0xd1, 0x01]); // MB|ME|SR, TNF=well-known ; type length = 1
const URI_TYPE = 0x55; // 'U'
const URI_PREFIX_HTTPS = 0x04; // « https:// » (NFC Forum URI RTD)
const MAX_SHORT_PAYLOAD = 255;

/** Chemin de la page de tap Taply (vercel.json : ^/t$ → /t.html). */
export const TAP_PATH = '/t';

const LABEL = '(?!-)[a-z0-9-]{1,63}(?<!-)';
const HOSTNAME = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*\\.(?!-)[a-z][a-z0-9-]{0,62}(?<!-)$`);
const PATH = /^\/[A-Za-z0-9._~\-/]*$/;
const E_PLACEHOLDER = '0'.repeat(PICC_DATA_ASCII_LENGTH);
const C_PLACEHOLDER = '0'.repeat(SDM_MAC_ASCII_LENGTH);
const HEX_UPPER_OR_LOWER = /^[0-9A-Fa-f]+$/;

// ── Types ───────────────────────────────────────────────────────────

export interface SunNdefFile {
  /** Octets à écrire à partir de l'offset 0 du fichier 02 (NLEN inclus). */
  readonly bytes: Buffer;
  /** URL gabarit, placeholders à zéro. */
  readonly templateUrl: string;
  /** Offset du 1er caractère du placeholder `e` (PICCDataOffset). */
  readonly piccDataOffset: number;
  /** Offset du 1er caractère du placeholder `c` (SDMMACOffset). */
  readonly sdmMacOffset: number;
  /** = sdmMacOffset : MAC calculée sur une entrée vide. */
  readonly sdmMacInputOffset: number;
}

// ── Validation ──────────────────────────────────────────────────────

/**
 * Hôte = nom de domaine en minuscules, sans schéma, port, chemin ni point
 * final, au moins deux labels, TLD alphabétique (refuse IP et « localhost »).
 * Il est GRAVÉ dans la puce : ce doit être le domaine de production final.
 */
export function validateHost(host: unknown): string {
  if (typeof host !== 'string' || !HOSTNAME.test(host)) {
    throw new TypeError(
      `invalid host ${JSON.stringify(host)}: expected a lowercase domain name such as "taply.fr" (no scheme, port, path or trailing dot)`,
    );
  }
  return host;
}

function validatePath(path: unknown): string {
  if (typeof path !== 'string' || !PATH.test(path) || path.includes('//')) {
    throw new TypeError(`invalid path ${JSON.stringify(path)}`);
  }
  return path;
}

// ── Builder ─────────────────────────────────────────────────────────

/**
 * Construit le fichier NDEF SUN et ses offsets.
 * `options.path` n'existe que pour reproduire l'exemple AN12196 (« /ntag424 ») ;
 * Taply utilise toujours `/t`.
 * @throws TypeError / RangeError si l'hôte est invalide ou si le fichier
 *         dépasse 256 octets (ou le payload d'un short record, 255).
 */
export function buildSunNdefFile(host: string, options: { readonly path?: string } = {}): SunNdefFile {
  const validHost = validateHost(host);
  const path = validatePath(options.path ?? TAP_PATH);

  const head = `${validHost}${path}?e=`;
  const middle = '&c=';
  const uriRest = `${head}${E_PLACEHOLDER}${middle}${C_PLACEHOLDER}`;
  const payloadLength = 1 + uriRest.length; // préfixe 04 + reste de l'URI
  if (payloadLength > MAX_SHORT_PAYLOAD) throw new RangeError('URL too long for a short NDEF record');

  const record = Buffer.concat([
    URI_RECORD_HEADER,
    Buffer.from([payloadLength, URI_TYPE, URI_PREFIX_HTTPS]),
    Buffer.from(uriRest, 'ascii'),
  ]);
  const nlen = Buffer.alloc(NLEN_SIZE);
  nlen.writeUInt16BE(record.length, 0);
  const bytes = Buffer.concat([nlen, record]);
  if (bytes.length > NDEF_FILE_SIZE) throw new RangeError(`NDEF file too large (${bytes.length} > ${NDEF_FILE_SIZE} bytes)`);

  // Position de l'URI (après NLEN et l'en-tête de 5 octets D1 01 len 55 04).
  const uriStart = NLEN_SIZE + record.length - uriRest.length;
  const piccDataOffset = uriStart + head.length;
  const sdmMacOffset = piccDataOffset + E_PLACEHOLDER.length + middle.length;

  return {
    bytes,
    templateUrl: `https://${uriRest}`,
    piccDataOffset,
    sdmMacOffset,
    sdmMacInputOffset: sdmMacOffset,
  };
}

// ── Mirroring & read-back ───────────────────────────────────────────

/**
 * Ce que fait la puce à la lecture : remplace les placeholders par e/c
 * (hex ASCII). Sert aux tests et à la vérification de relecture.
 */
export function mirrorSunParams(file: SunNdefFile, e: string, c: string): Buffer {
  if (e.length !== PICC_DATA_ASCII_LENGTH || !HEX_UPPER_OR_LOWER.test(e)) throw new TypeError('e must be 32 hex chars');
  if (c.length !== SDM_MAC_ASCII_LENGTH || !HEX_UPPER_OR_LOWER.test(c)) throw new TypeError('c must be 16 hex chars');
  const out = Buffer.from(file.bytes);
  out.write(e, file.piccDataOffset, 'ascii');
  out.write(c, file.sdmMacOffset, 'ascii');
  return out;
}

/**
 * Relit un fichier NDEF contenant UN short record URI « https:// » et
 * renvoie l'URL complète. Les octets au-delà de NLEN sont ignorés.
 * @throws TypeError si le format n'est pas celui produit par buildSunNdefFile.
 */
export function parseNdefUriFile(file: Buffer): string {
  if (file.length < NLEN_SIZE + 5) throw new TypeError('NDEF file too short');
  const nlen = file.readUInt16BE(0);
  const record = file.subarray(NLEN_SIZE, NLEN_SIZE + nlen);
  if (record.length !== nlen) throw new TypeError('NDEF file truncated (NLEN beyond data)');
  if (record[0] !== 0xd1 || record[1] !== 0x01 || record[3] !== URI_TYPE) throw new TypeError('not a single short URI record');
  const payloadLength = record[2] ?? 0;
  if (4 + payloadLength !== nlen) throw new TypeError('NDEF payload length mismatch');
  if (record[4] !== URI_PREFIX_HTTPS) throw new TypeError('URI prefix is not https://');
  return `https://${record.subarray(5).toString('ascii')}`;
}

/** Extrait `e` et `c` (chaînes brutes, non validées) d'une URL de tap. */
export function extractSunParams(url: string): { e: string | null; c: string | null } {
  const parsed = new URL(url);
  return { e: parsed.searchParams.get('e'), c: parsed.searchParams.get('c') };
}

/** Vrai si les placeholders sont encore à zéro (aucun miroir SDM appliqué). */
export function isUnmirrored(params: { e: string | null; c: string | null }): boolean {
  return params.e === E_PLACEHOLDER && params.c === C_PLACEHOLDER;
}
