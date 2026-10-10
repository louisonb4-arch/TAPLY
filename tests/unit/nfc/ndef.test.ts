/**
 * Fichier NDEF SUN + offsets SDM.
 *
 * Vecteurs : NXP AN12196 Rev. 2.0 §5 (« Personalization example »),
 * Tables 15–16 (NDEF https://choose.url.com/ntag424?e=…&c=…, offsets 0x20 /
 * 0x43) et Table 18 (ChangeFileSettings qui utilise ces offsets).
 *
 * Intégration : le NDEF produit ici, une fois « miroité » comme le ferait la
 * puce (simulateSunUrlParams), donne une URL acceptée par verifySunMessage
 * avec les clés de deriveTagKeys — preuve que le plan correspond au serveur.
 */

import { describe, expect, it } from 'vitest';
import { deriveSdmMetaReadKey, deriveTagKeys } from '../../../backend/nfc/keys.js';
import { verifySunMessage, type SunVerification } from '../../../backend/nfc/sdm.js';
import { encodeFileSettings } from '../../../scripts/nfc/ev2.js';
import {
  buildSunNdefFile,
  extractSunParams,
  isUnmirrored,
  mirrorSunParams,
  parseNdefUriFile,
  validateHost,
} from '../../../scripts/nfc/ndef.js';
import { simulateSunUrlParams } from '../../helpers/ntag424-sim.js';

const h = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const H = (b: Buffer): string => b.toString('hex').toUpperCase();
const ascii = (s: string): string => H(Buffer.from(s, 'ascii'));

const MASTER = h('8f1e2d3c4b5a69788796a5b4c3d2e1f000112233445566778899aabbccddeeff');

// ── AN12196 §5.7 ────────────────────────────────────────────────────

describe('AN12196 §5.7 Tables 15–16 — NDEF message of the personalization example', () => {
  const file = buildSunNdefFile('choose.url.com', { path: '/ntag424' });

  it('Table 16 step 6: file bytes = 0051 D1014D5504 + "choose.url.com/ntag424?e=0…0&c=0…0" (83 bytes)', () => {
    expect(H(file.bytes)).toBe(
      '0051D1014D550463686F6F73652E75726C2E636F6D2F6E7461673432343F653D' +
        '3030303030303030303030303030303030303030303030303030303030303030' +
        '26633D30303030303030303030303030303030',
    );
    expect(H(file.bytes.subarray(0, 7))).toBe('0051D1014D5504'); // Table 15 step 3
    expect(file.bytes.length).toBe(0x53); // Lc 53 de la Table 16 = 0x53 octets de données
  });

  it('Table 15 steps 8–11 / §5 config: PICCData offset 0x20 (32), SDMMACInputOffset = SDMMACOffset = 0x43 (67)', () => {
    expect(file.piccDataOffset).toBe(0x20);
    expect(file.sdmMacOffset).toBe(0x43);
    expect(file.sdmMacInputOffset).toBe(0x43);
  });

  it('Table 18 step 7: those offsets encode to 4000E0C1F121 200000 430000 430000', () => {
    const settings = encodeFileSettings({
      commMode: 'plain',
      access: { read: 0xe, write: 0, readWrite: 0, change: 0 },
      sdm: {
        uidMirror: true, readCtrMirror: true, metaRead: 2, fileRead: 1, ctrRet: 1,
        piccDataOffset: file.piccDataOffset, macInputOffset: file.sdmMacInputOffset, macOffset: file.sdmMacOffset,
      },
    });
    expect(H(settings)).toBe('4000E0C1F121200000430000430000');
  });

  it('AN12196 Tables 2/4 vector mirrored into this file verifies (zero keys, CMACInputOffset == CMACOffset)', () => {
    const mirrored = mirrorSunParams(file, 'EF963FF7828658A599F3041510671E88', '94EED9EE65337086');
    const { e, c } = extractSunParams(parseNdefUriFile(mirrored));
    const result = verifySunMessage({ e, c, sdmMetaReadKey: Buffer.alloc(16), fileReadKeyForUid: () => Buffer.alloc(16) });
    expect(result).toEqual({ ok: true, uidHex: '04DE5F1EACC040', readCtr: 61 });
  });
});

// ── Fichier Taply ───────────────────────────────────────────────────

describe('Taply NDEF file', () => {
  const file = buildSunNdefFile('taply.fr');

  it('exact bytes for https://taply.fr/t?e=…&c=…', () => {
    const url = `taply.fr/t?e=${'0'.repeat(32)}&c=${'0'.repeat(16)}`;
    expect(H(file.bytes)).toBe(`0045D10141${'5504'}${ascii(url)}`);
    expect(file.bytes.readUInt16BE(0)).toBe(file.bytes.length - 2); // NLEN = longueur du message
    expect(file.templateUrl).toBe(`https://${url}`);
  });

  it('offsets: e at 2 + 5 + len("taply.fr/t?e=") = 20, c at 20 + 32 + len("&c=") = 55', () => {
    expect(file.piccDataOffset).toBe(20);
    expect(file.sdmMacOffset).toBe(55);
    expect(file.sdmMacInputOffset).toBe(55);
    expect(file.bytes.subarray(file.piccDataOffset - 3, file.piccDataOffset).toString('ascii')).toBe('?e=');
    expect(file.bytes.subarray(file.sdmMacOffset - 3, file.sdmMacOffset).toString('ascii')).toBe('&c=');
    expect(file.sdmMacOffset + 16).toBe(file.bytes.length); // c est le dernier champ
  });

  it('round-trips and is recognised as unmirrored', () => {
    const url = parseNdefUriFile(file.bytes);
    expect(url).toBe(file.templateUrl);
    expect(isUnmirrored(extractSunParams(url))).toBe(true);
  });

  it('parser ignores bytes beyond NLEN (rest of the 256-byte file)', () => {
    const full = Buffer.concat([file.bytes, Buffer.alloc(256 - file.bytes.length, 0xaa)]);
    expect(parseNdefUriFile(full)).toBe(file.templateUrl);
  });
});

describe('host validation (the host is burnt into the tag)', () => {
  it.each(['taply.fr', 'staging.taply.fr', 'xn--tply-6na.fr', 'a-b.example.co.uk'])('accepts %s', (host) => {
    expect(validateHost(host)).toBe(host);
  });

  it.each([
    'Taply.fr', 'taply.fr/', 'https://taply.fr', 'taply.fr:443', 'localhost', '127.0.0.1', '', 'taply..fr',
    '-taply.fr', 'taply-.fr', 'taply.fr.', 'taply.fr/t', 'tap ly.fr', 'taply.1',
  ])('refuses %j', (host) => {
    expect(() => buildSunNdefFile(host)).toThrow(TypeError);
  });

  it('refuses a URL that no longer fits a short NDEF record / the 256-byte file', () => {
    const label = 'a'.repeat(60);
    expect(() => buildSunNdefFile(`${label}.${label}.${label}.${label}.fr`)).toThrow(RangeError);
  });
});

// ── Intégration serveur ─────────────────────────────────────────────

describe('integration: plan NDEF + tag mirroring + server verification', () => {
  const KEY_VERSION = 1;
  const file = buildSunNdefFile('taply.fr');

  function serverVerify(e: unknown, c: unknown): SunVerification {
    return verifySunMessage({
      e,
      c,
      sdmMetaReadKey: deriveSdmMetaReadKey(MASTER, KEY_VERSION),
      fileReadKeyForUid: (uidHex) => deriveTagKeys(MASTER, h(uidHex), KEY_VERSION).sdmFileReadKey,
    });
  }

  function tap(uid: Buffer, readCtr: number): { mirrored: Buffer; url: string } {
    const keys = deriveTagKeys(MASTER, uid, KEY_VERSION);
    const { e, c } = simulateSunUrlParams({ sdmMetaReadKey: keys.sdmMetaReadKey, sdmFileReadKey: keys.sdmFileReadKey, uid, readCtr });
    const mirrored = mirrorSunParams(file, e, c);
    return { mirrored, url: parseNdefUriFile(mirrored) };
  }

  it.each<[string, number]>([
    ['04958CAA5C5E80', 1],
    ['04DE5F1EACC040', 61],
    ['04AABBCCDDEEFF', 0xfffffe],
  ])('UID %s, SDMReadCtr %i: URL from the mirrored file is accepted by verifySunMessage', (uidHex, readCtr) => {
    const { mirrored, url } = tap(h(uidHex), readCtr);
    expect(url.startsWith('https://taply.fr/t?e=')).toBe(true);
    // Seuls les placeholders changent.
    expect(H(mirrored.subarray(0, file.piccDataOffset))).toBe(H(file.bytes.subarray(0, file.piccDataOffset)));
    expect(H(mirrored.subarray(file.piccDataOffset + 32, file.sdmMacOffset))).toBe(ascii('&c='));
    const { e, c } = extractSunParams(url);
    expect(serverVerify(e, c)).toEqual({ ok: true, uidHex, readCtr });
  });

  it('a URL produced with another UID\'s file key is rejected (keys are per UID)', () => {
    const uid = h('04958CAA5C5E80');
    const meta = deriveTagKeys(MASTER, uid, KEY_VERSION).sdmMetaReadKey;
    const wrongFileKey = deriveTagKeys(MASTER, h('04958CAA5C5E81'), KEY_VERSION).sdmFileReadKey;
    const { e, c } = simulateSunUrlParams({ sdmMetaReadKey: meta, sdmFileReadKey: wrongFileKey, uid, readCtr: 3 });
    const params = extractSunParams(parseNdefUriFile(mirrorSunParams(file, e, c)));
    expect(serverVerify(params.e, params.c)).toEqual({ ok: false, reason: 'mac' });
  });

  it('the unmirrored template (zeros) is rejected by the server', () => {
    const { e, c } = extractSunParams(file.templateUrl);
    expect(serverVerify(e, c).ok).toBe(false);
  });
});
