/**
 * Tests SUN / SDM (NTAG 424 DNA).
 *
 * Vecteurs de référence :
 *   - NXP AN12196 Rev. 2.0 (4 mars 2025) — Tables 1, 2, 4, 5.
 *   - github.com/nfc-developer/sdm-backend, tests/test_libsdm.py
 *     (test_sun1, test_sun2, test_sun3_custom, test_plain_sdm[_wrong]).
 * Note : l'exemple « plain » de AN12196 §3.4.1 (c=54A45B2C3A558765) n'est
 * PAS utilisé — le document précise que son MAC porte sur d'autres données
 * (macInput non vide, non publié), donc hors de notre configuration.
 *
 * L'anti-rejeu n'est pas testé ici : il n'appartient pas à ce module.
 */

import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { aesCmac } from '../../../backend/nfc/aes-cmac.js';
import { deriveSdmMetaReadKey, deriveTagKeys } from '../../../backend/nfc/keys.js';
import {
  decryptPiccData,
  parseSunParams,
  sdmMacTruncated,
  sdmSessionMacKey,
  verifySunMessage,
  type SunVerification,
} from '../../../backend/nfc/sdm.js';
import { simulateSunUrlParams } from '../../helpers/ntag424-sim.js';

// ── Helpers ─────────────────────────────────────────────────────────

const hex = (s: string): Buffer => Buffer.from(s, 'hex');
const ZERO_KEY = Buffer.alloc(16);
const EMPTY = Buffer.alloc(0);

const MASTER = hex('8f1e2d3c4b5a69788796a5b4c3d2e1f000112233445566778899aabbccddeeff');
const KEY_VERSION = 1;

/** Chiffre un bloc PICCData arbitraire (pour fabriquer des tags byte invalides). */
function encryptPiccBlock(key: Buffer, plain: Buffer): string {
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('hex').toUpperCase();
}

function flipBit(hexStr: string, bit: number): string {
  const buf = Buffer.from(hexStr, 'hex');
  const byteIndex = Math.floor(bit / 8);
  buf[byteIndex] = (buf[byteIndex] ?? 0) ^ (0x80 >>> (bit % 8));
  return buf.toString('hex').toUpperCase();
}

/** Contexte « serveur » : clés dérivées du maître, comme en production. */
function serverVerify(e: unknown, c: unknown): SunVerification {
  return verifySunMessage({
    e,
    c,
    sdmMetaReadKey: deriveSdmMetaReadKey(MASTER, KEY_VERSION),
    fileReadKeyForUid: (uidHex) => deriveTagKeys(MASTER, hex(uidHex), KEY_VERSION).sdmFileReadKey,
  });
}

/** Ce qu'émettrait un tag personnalisé avec les clés dérivées du maître. */
function tagEmit(uid: Buffer, readCtr: number, padding?: Buffer): { e: string; c: string } {
  const keys = deriveTagKeys(MASTER, uid, KEY_VERSION);
  return simulateSunUrlParams({
    sdmMetaReadKey: keys.sdmMetaReadKey,
    sdmFileReadKey: keys.sdmFileReadKey,
    uid,
    readCtr,
    ...(padding === undefined ? {} : { padding }),
  });
}

// Vecteur NXP / sdm-backend test_sun1 (clés nulles).
const NXP_E = 'EF963FF7828658A599F3041510671E88';
const NXP_C = '94EED9EE65337086';
const NXP_UID = '04DE5F1EACC040';
const NXP_CTR = 61;

const zeroKeyVerify = (e: unknown, c: unknown): SunVerification =>
  verifySunMessage({ e, c, sdmMetaReadKey: ZERO_KEY, fileReadKeyForUid: () => ZERO_KEY });

// ── Reference vectors ───────────────────────────────────────────────

describe('reference vectors — NXP AN12196 / sdm-backend', () => {
  it('AN12196 Table 2 / test_sun1: PICCENCData decrypts to tag C7, UID 04DE5F1EACC040, ctr 61', () => {
    const picc = decryptPiccData(ZERO_KEY, hex(NXP_E));
    expect(picc).not.toBeNull();
    expect(picc?.uid.toString('hex').toUpperCase()).toBe(NXP_UID);
    expect(picc?.readCtr).toBe(NXP_CTR); // SDMReadCtr = 3D0000 (LSB first)
  });

  it('AN12196 Table 4: SV2 session key and SDMMAC over zero-length input', () => {
    const sessionKey = sdmSessionMacKey(ZERO_KEY, hex(NXP_UID), NXP_CTR);
    expect(sessionKey.toString('hex').toUpperCase()).toBe('3FB5F6E3A807A03D5E3570ACE393776F');
    expect(sdmMacTruncated(sessionKey, EMPTY).toString('hex').toUpperCase()).toBe(NXP_C);
  });

  it('test_sun1: full verifySunMessage succeeds with zero keys', () => {
    expect(zeroKeyVerify(NXP_E, NXP_C)).toEqual({ ok: true, uidHex: NXP_UID, readCtr: NXP_CTR });
  });

  it('test_sun1: lowercase params are accepted too', () => {
    expect(zeroKeyVerify(NXP_E.toLowerCase(), NXP_C.toLowerCase())).toEqual({
      ok: true,
      uidHex: NXP_UID,
      readCtr: NXP_CTR,
    });
  });

  it('AN12196 Table 1: session MAC key with a non-zero SDMFileReadKey', () => {
    const key = hex('5ACE7E50AB65D5D51FD5BF5A16B8205B');
    const sessionKey = sdmSessionMacKey(key, hex('04C767F2066180'), 1);
    expect(sessionKey.toString('hex').toUpperCase()).toBe('3A3E8110E05311F7A3FCF0D969BF2B48');
  });

  it('test_plain_sdm: uid=041E3C8A2D6B80 ctr=000006 → cmac 4B00064004B0B3D3 (empty macInput)', () => {
    const sessionKey = sdmSessionMacKey(ZERO_KEY, hex('041E3C8A2D6B80'), 6);
    const mac = sdmMacTruncated(sessionKey, EMPTY).toString('hex').toUpperCase();
    expect(mac).toBe('4B00064004B0B3D3');
    expect(mac).not.toBe('AB00064004B0B3AB'); // test_plain_sdm_wrong
  });

  it('AN12196 Table 5 / test_sun2: decryption + MACt over a non-empty macInput', () => {
    const picc = decryptPiccData(ZERO_KEY, hex('FD91EC264309878BE6345CBE53BADF40'));
    expect(picc?.uid.toString('hex').toUpperCase()).toBe('04958CAA5C5E80');
    expect(picc?.readCtr).toBe(8);
    if (picc === null) return;
    const sessionKey = sdmSessionMacKey(ZERO_KEY, picc.uid, picc.readCtr);
    expect(sessionKey.toString('hex').toUpperCase()).toBe('3ED0920E5E6A0320D823D5987FEAFBB1');
    const macInput = Buffer.from('CEE9A53E3E463EF1F459635736738962&cmac=', 'ascii');
    expect(aesCmac(sessionKey, macInput).toString('hex').toUpperCase()).toBe('81EC45C175E72FF6FAC61BC7AB3BAEF6');
    expect(sdmMacTruncated(sessionKey, macInput).toString('hex').toUpperCase()).toBe('ECC1E7F6C6C73BF6');
  });

  it('test_sun3_custom: non-zero meta + file read keys', () => {
    const metaKey = hex('42aff114f2cb3b6141be6dc95dfc5416');
    const fileKey = hex('b62a9baf092439bd43c62aee96b970c5');
    const picc = decryptPiccData(metaKey, hex('8ACADDEF0A9B62CDAE39A16B83FC14DE'));
    expect(picc?.uid.toString('hex').toUpperCase()).toBe('041D3C8A2D6B80');
    expect(picc?.readCtr).toBe(291);
    if (picc === null) return;
    const macInput = Buffer.from('B8436E11F627BB7F543FCC0C1E0D1A89', 'ascii');
    const mac = sdmMacTruncated(sdmSessionMacKey(fileKey, picc.uid, picc.readCtr), macInput);
    expect(mac.toString('hex').toUpperCase()).toBe('238B2543A8DEBAD8');
  });

  it('test_sun2 through verifySunMessage → "mac" (its MAC covers file data, we require empty macInput)', () => {
    expect(zeroKeyVerify('FD91EC264309878BE6345CBE53BADF40', 'ECC1E7F6C6C73BF6')).toEqual({
      ok: false,
      reason: 'mac',
    });
  });

  it('simulator reproduces the NXP URL byte-for-byte given Table 2 padding (DA5CF60941)', () => {
    const sim = simulateSunUrlParams({
      sdmMetaReadKey: ZERO_KEY,
      sdmFileReadKey: ZERO_KEY,
      uid: hex(NXP_UID),
      readCtr: NXP_CTR,
      padding: hex('DA5CF60941'),
    });
    expect(sim).toEqual({ e: NXP_E, c: NXP_C });
  });
});

// ── sdmMacTruncated / sdmSessionMacKey ──────────────────────────────

describe('sdmMacTruncated', () => {
  it('keeps exactly the odd-index bytes of the 16-byte CMAC', () => {
    const key = randomBytes(16);
    const input = randomBytes(23);
    const full = aesCmac(key, input);
    const expected = Buffer.from([1, 3, 5, 7, 9, 11, 13, 15].map((i) => full[i] ?? -1));
    const mac = sdmMacTruncated(key, input);
    expect(mac).toHaveLength(8);
    expect(mac.equals(expected)).toBe(true);
    expect(mac.equals(full.subarray(0, 8))).toBe(false);
  });

  it('rejects a session key that is not 16 bytes', () => {
    expect(() => sdmMacTruncated(Buffer.alloc(8), EMPTY)).toThrow(TypeError);
  });
});

describe('sdmSessionMacKey — input validation', () => {
  const uid = hex(NXP_UID);

  it('rejects UIDs that are not 7 bytes', () => {
    for (const len of [0, 4, 6, 8, 10]) {
      expect(() => sdmSessionMacKey(ZERO_KEY, Buffer.alloc(len), 1), `len ${len}`).toThrow(TypeError);
    }
  });

  it('rejects counters outside 0..0xFFFFFF or non-integers', () => {
    for (const ctr of [-1, 0x1000000, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => sdmSessionMacKey(ZERO_KEY, uid, ctr), String(ctr)).toThrow(TypeError);
    }
  });

  it('accepts counter bounds 0 and 0xFFFFFF', () => {
    expect(sdmSessionMacKey(ZERO_KEY, uid, 0)).toHaveLength(16);
    expect(sdmSessionMacKey(ZERO_KEY, uid, 0xffffff)).toHaveLength(16);
  });

  it('rejects a file read key that is not 16 bytes', () => {
    expect(() => sdmSessionMacKey(Buffer.alloc(15), uid, 1)).toThrow(TypeError);
  });
});

// ── decryptPiccData ─────────────────────────────────────────────────

describe('decryptPiccData', () => {
  it('returns null for wrong ciphertext lengths', () => {
    for (const len of [0, 8, 15, 17, 32]) {
      expect(decryptPiccData(ZERO_KEY, Buffer.alloc(len)), `len ${len}`).toBeNull();
    }
  });

  it('returns null unless the PICCDataTag is exactly 0xC7', () => {
    const body = Buffer.concat([hex(NXP_UID), hex('3D0000'), hex('DA5CF60941')]);
    // 0x87 = UID seul, 0x47 = compteur seul, 0xC4 = UID 4 octets, 0xCA = UID 10 octets, …
    for (const tag of [0x00, 0x07, 0x47, 0x87, 0xc0, 0xc4, 0xc6, 0xc8, 0xca, 0xcf, 0xd7, 0xe7, 0xff]) {
      const e = encryptPiccBlock(ZERO_KEY, Buffer.concat([Buffer.from([tag]), body]));
      expect(decryptPiccData(ZERO_KEY, hex(e)), `tag 0x${tag.toString(16)}`).toBeNull();
    }
    const ok = encryptPiccBlock(ZERO_KEY, Buffer.concat([Buffer.from([0xc7]), body]));
    expect(decryptPiccData(ZERO_KEY, hex(ok))?.readCtr).toBe(61);
  });

  it('parses the 3-byte counter LSB first', () => {
    const plain = Buffer.concat([Buffer.from([0xc7]), hex(NXP_UID), hex('563412'), Buffer.alloc(5)]);
    expect(decryptPiccData(ZERO_KEY, hex(encryptPiccBlock(ZERO_KEY, plain)))?.readCtr).toBe(0x123456);
  });

  it('throws TypeError on a misconfigured meta key', () => {
    expect(() => decryptPiccData(Buffer.alloc(32), hex(NXP_E))).toThrow(TypeError);
  });
});

// ── parseSunParams ──────────────────────────────────────────────────

describe('parseSunParams', () => {
  it('accepts exactly 32 + 16 hex chars, case-insensitive', () => {
    const parsed = parseSunParams(NXP_E, NXP_C);
    expect(parsed?.piccEnc.toString('hex').toUpperCase()).toBe(NXP_E);
    expect(parsed?.mac.toString('hex').toUpperCase()).toBe(NXP_C);
    expect(parseSunParams(NXP_E.toLowerCase(), 'aBcDeF0123456789')).not.toBeNull();
  });

  it('rejects wrong lengths', () => {
    expect(parseSunParams(NXP_E.slice(0, 31), NXP_C)).toBeNull();
    expect(parseSunParams(`${NXP_E}0`, NXP_C)).toBeNull();
    expect(parseSunParams(`${NXP_E}00`, NXP_C)).toBeNull();
    expect(parseSunParams(NXP_E, NXP_C.slice(0, 15))).toBeNull();
    expect(parseSunParams(NXP_E, `${NXP_C}0`)).toBeNull();
    expect(parseSunParams('', '')).toBeNull();
  });

  it('rejects non-hex characters, prefixes and whitespace', () => {
    const bad: Array<[string, string]> = [
      [`${NXP_E.slice(0, 31)}G`, NXP_C],
      [NXP_E, `${NXP_C.slice(0, 15)}z`],
      [`0x${NXP_E.slice(0, 30)}`, NXP_C],
      [` ${NXP_E.slice(1)}`, NXP_C],
      [`${NXP_E}\n`, NXP_C],
      [NXP_E, `${NXP_C}\n`],
      [`${NXP_E.slice(0, 31)}٠`, NXP_C], // chiffre arabe-indien
      [`${NXP_E.slice(0, 31)}Ａ`, NXP_C], // « Ａ » pleine chasse
      [NXP_E, NXP_C.replace(/./g, '-')],
    ];
    for (const [e, c] of bad) {
      expect(parseSunParams(e, c), JSON.stringify([e, c])).toBeNull();
    }
  });

  it('rejects non-string values (arrays, objects, undefined, numbers, boxed strings)', () => {
    const weird: unknown[] = [
      undefined,
      null,
      0,
      123n,
      true,
      [NXP_E],
      { toString: () => NXP_E },
      new String(NXP_E),
      hex(NXP_E),
      Symbol('e'),
    ];
    for (const value of weird) {
      expect(parseSunParams(value, NXP_C)).toBeNull();
      expect(parseSunParams(NXP_E, value)).toBeNull();
    }
  });
});

// ── verifySunMessage — negative paths ───────────────────────────────

describe('verifySunMessage — rejection reasons', () => {
  it('format: invalid e/c shapes, never calls the key lookup', () => {
    let lookups = 0;
    const run = (e: unknown, c: unknown): SunVerification =>
      verifySunMessage({
        e,
        c,
        sdmMetaReadKey: ZERO_KEY,
        fileReadKeyForUid: () => {
          lookups++;
          return ZERO_KEY;
        },
      });
    const cases: Array<[unknown, unknown]> = [
      [undefined, undefined],
      [NXP_E, undefined],
      [undefined, NXP_C],
      [[NXP_E], NXP_C],
      [NXP_E, [NXP_C]],
      [{ e: NXP_E }, NXP_C],
      [NXP_E.slice(2), NXP_C],
      [NXP_E, NXP_C.slice(2)],
      [NXP_C, NXP_E], // swapped
      [`${NXP_E}${NXP_C}`, ''],
    ];
    for (const [e, c] of cases) {
      expect(run(e, c), JSON.stringify([e, c])).toEqual({ ok: false, reason: 'format' });
    }
    expect(lookups).toBe(0);
  });

  it('picc_tag: valid shape but plaintext tag byte ≠ 0xC7, never calls the key lookup', () => {
    let lookups = 0;
    const body = Buffer.concat([hex(NXP_UID), hex('3D0000'), hex('DA5CF60941')]);
    for (const tag of [0x87, 0x47, 0xc4, 0x00]) {
      const e = encryptPiccBlock(ZERO_KEY, Buffer.concat([Buffer.from([tag]), body]));
      const result = verifySunMessage({
        e,
        c: NXP_C,
        sdmMetaReadKey: ZERO_KEY,
        fileReadKeyForUid: () => {
          lookups++;
          return ZERO_KEY;
        },
      });
      expect(result).toEqual({ ok: false, reason: 'picc_tag' });
    }
    expect(lookups).toBe(0);
  });

  it('unknown_key: lookup returns undefined; lookup receives uppercase 14-hex UID', () => {
    const seen: string[] = [];
    const result = verifySunMessage({
      e: NXP_E.toLowerCase(),
      c: NXP_C,
      sdmMetaReadKey: ZERO_KEY,
      fileReadKeyForUid: (uidHex) => {
        seen.push(uidHex);
        return undefined;
      },
    });
    expect(result).toEqual({ ok: false, reason: 'unknown_key' });
    expect(seen).toEqual([NXP_UID]);
  });

  it('mac: wrong SDMFileReadKey', () => {
    const result = verifySunMessage({
      e: NXP_E,
      c: NXP_C,
      sdmMetaReadKey: ZERO_KEY,
      fileReadKeyForUid: () => Buffer.alloc(16, 0x01),
    });
    expect(result).toEqual({ ok: false, reason: 'mac' });
  });

  it('wrong SDMMetaReadKey → not ok (picc_tag or mac), never ok', () => {
    for (let i = 0; i < 32; i++) {
      const result = verifySunMessage({
        e: NXP_E,
        c: NXP_C,
        sdmMetaReadKey: randomBytes(16),
        fileReadKeyForUid: () => ZERO_KEY,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(['picc_tag', 'mac']).toContain(result.reason);
    }
  });

  it('every single-bit flip of e is rejected (picc_tag or mac)', () => {
    for (let bit = 0; bit < 128; bit++) {
      const result = zeroKeyVerify(flipBit(NXP_E, bit), NXP_C);
      expect(result.ok, `bit ${bit}`).toBe(false);
      if (!result.ok) expect(['picc_tag', 'mac'], `bit ${bit}`).toContain(result.reason);
    }
  });

  it('every single-bit flip of c is rejected with reason mac', () => {
    for (let bit = 0; bit < 64; bit++) {
      expect(zeroKeyVerify(NXP_E, flipBit(NXP_C, bit)), `bit ${bit}`).toEqual({ ok: false, reason: 'mac' });
    }
  });

  it('all-zero / all-F MAC is rejected', () => {
    expect(zeroKeyVerify(NXP_E, '0'.repeat(16))).toEqual({ ok: false, reason: 'mac' });
    expect(zeroKeyVerify(NXP_E, 'F'.repeat(16))).toEqual({ ok: false, reason: 'mac' });
  });

  it('throws TypeError on server misconfiguration (bad meta key, bad looked-up key)', () => {
    expect(() =>
      verifySunMessage({ e: NXP_E, c: NXP_C, sdmMetaReadKey: Buffer.alloc(15), fileReadKeyForUid: () => ZERO_KEY }),
    ).toThrow(TypeError);
    expect(() =>
      verifySunMessage({ e: NXP_E, c: NXP_C, sdmMetaReadKey: ZERO_KEY, fileReadKeyForUid: () => Buffer.alloc(32) }),
    ).toThrow(TypeError);
  });
});

describe('verifySunMessage — never throws on attacker-controlled e/c', () => {
  const hostile: unknown[] = [
    undefined,
    null,
    '',
    0,
    -1,
    Number.NaN,
    123n,
    true,
    Symbol('x'),
    () => NXP_E,
    [],
    [NXP_E, NXP_E],
    {},
    Object.create(null),
    {
      toString(): string {
        throw new Error('boom');
      },
      valueOf(): string {
        throw new Error('boom');
      },
    },
    new Proxy(
      {},
      {
        get() {
          throw new Error('proxy get');
        },
        getPrototypeOf() {
          throw new Error('proxy proto');
        },
      },
    ),
    'é'.repeat(32),
    '\u0000'.repeat(32),
    'A'.repeat(100_000),
    '%00'.repeat(11),
    hex(NXP_E),
  ];

  it('returns format for every hostile value in e or c', () => {
    for (const value of hostile) {
      expect(() => zeroKeyVerify(value, NXP_C)).not.toThrow();
      expect(() => zeroKeyVerify(NXP_E, value)).not.toThrow();
      expect(zeroKeyVerify(value, NXP_C)).toEqual({ ok: false, reason: 'format' });
      expect(zeroKeyVerify(NXP_E, value)).toEqual({ ok: false, reason: 'format' });
    }
  });

  it('random well-formed e/c (fuzz, 2000 runs) are rejected without throwing', () => {
    for (let i = 0; i < 2000; i++) {
      const e = randomBytes(16).toString('hex');
      const c = randomBytes(8).toString('hex');
      const result = serverVerify(e, c);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(['picc_tag', 'mac']).toContain(result.reason);
    }
  });
});

// ── Round trip with the simulator (keys from keys.ts) ───────────────

describe('round trip — simulated tag ↔ server verification', () => {
  const uids = ['04DE5F1EACC040', '04958CAA5C5E80', '041D3C8A2D6B80', '00000000000000', 'FFFFFFFFFFFFFF'].map(hex);
  const counters = [0, 1, 2, 255, 256, 0x10000, 0xfffffe, 0xffffff];

  it('verifies for several UIDs and counters (incl. 0, 1, 0xFFFFFF)', () => {
    for (const uid of uids) {
      for (const readCtr of counters) {
        const { e, c } = tagEmit(uid, readCtr);
        expect(e).toMatch(/^[0-9A-F]{32}$/);
        expect(c).toMatch(/^[0-9A-F]{16}$/);
        expect(serverVerify(e, c), `${uid.toString('hex')}#${readCtr}`).toEqual({
          ok: true,
          uidHex: uid.toString('hex').toUpperCase(),
          readCtr,
        });
      }
    }
  });

  it('verifies random UIDs / counters (200 runs)', () => {
    for (let i = 0; i < 200; i++) {
      const uid = randomBytes(7);
      const readCtr = randomBytes(3).readUIntLE(0, 3);
      const { e, c } = tagEmit(uid, readCtr);
      expect(serverVerify(e, c)).toEqual({ ok: true, uidHex: uid.toString('hex').toUpperCase(), readCtr });
    }
  });

  it('MAC for counter N does not verify for counter N+1 (counter cannot be bumped/rolled back)', () => {
    const uid = hex('04DE5F1EACC040');
    for (const n of [0, 1, 41, 0xfffe, 0xfffffe]) {
      const tapN = tagEmit(uid, n);
      const tapN1 = tagEmit(uid, n + 1);
      // Même avec un e valide (attaquant ayant la clé meta partagée) : MAC de N refusé pour N+1.
      expect(serverVerify(tapN1.e, tapN.c), `N=${n}`).toEqual({ ok: false, reason: 'mac' });
      expect(serverVerify(tapN.e, tapN1.c), `N=${n}`).toEqual({ ok: false, reason: 'mac' });
    }
  });

  it('a MAC from tag A is rejected for tag B at the same counter', () => {
    const a = tagEmit(hex('04DE5F1EACC040'), 10);
    const b = tagEmit(hex('04958CAA5C5E80'), 10);
    expect(serverVerify(a.e, b.c)).toEqual({ ok: false, reason: 'mac' });
    expect(serverVerify(b.e, a.c)).toEqual({ ok: false, reason: 'mac' });
  });

  it('forging e with the shared meta key but no per-UID file key fails', () => {
    const uid = hex('04DE5F1EACC040');
    const forged = simulateSunUrlParams({
      sdmMetaReadKey: deriveSdmMetaReadKey(MASTER, KEY_VERSION),
      sdmFileReadKey: randomBytes(16),
      uid,
      readCtr: 1000,
    });
    expect(serverVerify(forged.e, forged.c)).toEqual({ ok: false, reason: 'mac' });
  });

  it('tags of another key version are rejected', () => {
    const uid = hex('04DE5F1EACC040');
    const v2 = deriveTagKeys(MASTER, uid, 2);
    const { e, c } = simulateSunUrlParams({
      sdmMetaReadKey: v2.sdmMetaReadKey,
      sdmFileReadKey: v2.sdmFileReadKey,
      uid,
      readCtr: 5,
    });
    expect(serverVerify(e, c).ok).toBe(false);
  });

  it('same UID+counter with different padding: e differs, c identical, both verify (replay is the caller’s job)', () => {
    const uid = hex('04958CAA5C5E80');
    const t1 = tagEmit(uid, 7, hex('0000000000'));
    const t2 = tagEmit(uid, 7, hex('FFFFFFFFFF'));
    expect(t1.e).not.toBe(t2.e);
    expect(t1.c).toBe(t2.c);
    expect(serverVerify(t1.e, t1.c).ok).toBe(true);
    expect(serverVerify(t2.e, t2.c).ok).toBe(true);
  });
});
