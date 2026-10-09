/**
 * Tests de la dérivation des clés NTAG 424 DNA (HKDF-SHA256 depuis le maître).
 * Le format des `info` est figé : le changer rendrait illisibles les tags
 * déjà personnalisés — d'où les tests de non-régression ci-dessous.
 */

import { hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveSdmMetaReadKey, deriveTagKeys, parseNfcMasterKey } from '../../../backend/nfc/keys.js';

const hex = (s: string): Buffer => Buffer.from(s, 'hex');

const MASTER_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const MASTER = hex(MASTER_HEX);
const OTHER_MASTER = hex('f0'.repeat(32));
const UID_A = hex('04DE5F1EACC040');
const UID_B = hex('04958CAA5C5E80');

const ROLES = ['appMasterKey', 'sdmMetaReadKey', 'sdmFileReadKey', 'changeKey'] as const;

// ── parseNfcMasterKey ───────────────────────────────────────────────

describe('parseNfcMasterKey', () => {
  it('accepts exactly 64 hex chars (any case) and returns 32 bytes', () => {
    const lower = parseNfcMasterKey(MASTER_HEX);
    const upper = parseNfcMasterKey(MASTER_HEX.toUpperCase());
    expect(lower).toBeInstanceOf(Buffer);
    expect(lower).toHaveLength(32);
    expect(lower?.equals(MASTER)).toBe(true);
    expect(upper?.equals(MASTER)).toBe(true);
  });

  it('rejects missing / empty / wrong length', () => {
    for (const raw of [undefined, '', 'ab', MASTER_HEX.slice(0, 63), `${MASTER_HEX}0`, MASTER_HEX.slice(0, 32)]) {
      expect(parseNfcMasterKey(raw), String(raw)).toBeUndefined();
    }
  });

  it('rejects non-hex, prefixes, whitespace and base64', () => {
    const bad = [
      `${MASTER_HEX.slice(0, 63)}g`,
      `0x${MASTER_HEX.slice(0, 62)}`,
      ` ${MASTER_HEX}`,
      `${MASTER_HEX}\n`,
      `${MASTER_HEX.slice(0, 32)} ${MASTER_HEX.slice(33)}`,
      MASTER.toString('base64'),
    ];
    for (const raw of bad) {
      expect(parseNfcMasterKey(raw), JSON.stringify(raw)).toBeUndefined();
    }
  });

  it('rejects the all-zero key', () => {
    expect(parseNfcMasterKey('0'.repeat(64))).toBeUndefined();
  });

  it('rejects non-string values at runtime', () => {
    for (const raw of [null, 42, {}, [MASTER_HEX], MASTER]) {
      expect(parseNfcMasterKey(raw as unknown as string)).toBeUndefined();
    }
  });
});

// ── deriveSdmMetaReadKey ────────────────────────────────────────────

describe('deriveSdmMetaReadKey', () => {
  it('is deterministic and 16 bytes', () => {
    const a = deriveSdmMetaReadKey(MASTER, 1);
    expect(a).toHaveLength(16);
    expect(a.equals(deriveSdmMetaReadKey(MASTER, 1))).toBe(true);
  });

  it('differs per key version and per master', () => {
    const v1 = deriveSdmMetaReadKey(MASTER, 1);
    expect(v1.equals(deriveSdmMetaReadKey(MASTER, 2))).toBe(false);
    expect(v1.equals(deriveSdmMetaReadKey(OTHER_MASTER, 1))).toBe(false);
  });

  it('is exactly HKDF-SHA256(master, fixed salt, "taply:ntag424:v1:sdm-meta-read:<v>") (format pinned)', () => {
    const expected = Buffer.from(
      hkdfSync('sha256', MASTER, 'taply:ntag424:hkdf-salt:v1', 'taply:ntag424:v1:sdm-meta-read:7', 16),
    );
    expect(deriveSdmMetaReadKey(MASTER, 7).equals(expected)).toBe(true);
  });

  it('rejects invalid master / version (TypeError)', () => {
    expect(() => deriveSdmMetaReadKey(Buffer.alloc(31, 1), 1)).toThrow(TypeError);
    expect(() => deriveSdmMetaReadKey(Buffer.alloc(33, 1), 1)).toThrow(TypeError);
    for (const v of [0, 256, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => deriveSdmMetaReadKey(MASTER, v), String(v)).toThrow(TypeError);
    }
  });

  it('accepts the version bounds 1 and 255', () => {
    expect(deriveSdmMetaReadKey(MASTER, 1)).toHaveLength(16);
    expect(deriveSdmMetaReadKey(MASTER, 255)).toHaveLength(16);
  });
});

// ── deriveTagKeys ───────────────────────────────────────────────────

describe('deriveTagKeys', () => {
  it('returns four 16-byte keys, deterministically', () => {
    const a = deriveTagKeys(MASTER, UID_A, 1);
    const b = deriveTagKeys(MASTER, UID_A, 1);
    for (const role of ROLES) {
      expect(a[role], role).toHaveLength(16);
      expect(a[role].equals(b[role]), role).toBe(true);
    }
  });

  it('all four roles are pairwise distinct', () => {
    const keys = deriveTagKeys(MASTER, UID_A, 1);
    const hexes = new Set(ROLES.map((role) => keys[role].toString('hex')));
    expect(hexes.size).toBe(4);
  });

  it('per-UID keys differ between UIDs; sdmMetaReadKey is shared', () => {
    const a = deriveTagKeys(MASTER, UID_A, 1);
    const b = deriveTagKeys(MASTER, UID_B, 1);
    expect(a.appMasterKey.equals(b.appMasterKey)).toBe(false);
    expect(a.sdmFileReadKey.equals(b.sdmFileReadKey)).toBe(false);
    expect(a.changeKey.equals(b.changeKey)).toBe(false);
    expect(a.sdmMetaReadKey.equals(b.sdmMetaReadKey)).toBe(true);
    expect(a.sdmMetaReadKey.equals(deriveSdmMetaReadKey(MASTER, 1))).toBe(true);
  });

  it('UIDs differing by a single bit give unrelated per-UID keys', () => {
    const flipped = Buffer.from(UID_A);
    flipped[6] = (flipped[6] ?? 0) ^ 0x01;
    const a = deriveTagKeys(MASTER, UID_A, 1);
    const b = deriveTagKeys(MASTER, flipped, 1);
    expect(a.sdmFileReadKey.equals(b.sdmFileReadKey)).toBe(false);
  });

  it('every key changes with the key version', () => {
    const v1 = deriveTagKeys(MASTER, UID_A, 1);
    const v2 = deriveTagKeys(MASTER, UID_A, 2);
    for (const role of ROLES) {
      expect(v1[role].equals(v2[role]), role).toBe(false);
    }
  });

  it('every key changes with the master', () => {
    const a = deriveTagKeys(MASTER, UID_A, 1);
    const b = deriveTagKeys(OTHER_MASTER, UID_A, 1);
    for (const role of ROLES) {
      expect(a[role].equals(b[role]), role).toBe(false);
    }
  });

  it('no derived key equals a slice of the master', () => {
    const keys = deriveTagKeys(MASTER, UID_A, 1);
    for (const role of ROLES) {
      expect(keys[role].equals(MASTER.subarray(0, 16)), role).toBe(false);
      expect(keys[role].equals(MASTER.subarray(16, 32)), role).toBe(false);
    }
  });

  it('per-UID info strings are pinned (uppercase UID hex, versioned role)', () => {
    const expect16 = (info: string): Buffer =>
      Buffer.from(hkdfSync('sha256', MASTER, 'taply:ntag424:hkdf-salt:v1', info, 16));
    const keys = deriveTagKeys(MASTER, UID_A, 3);
    expect(keys.appMasterKey.equals(expect16('taply:ntag424:v1:app-master:04DE5F1EACC040:3'))).toBe(true);
    expect(keys.sdmFileReadKey.equals(expect16('taply:ntag424:v1:sdm-file-read:04DE5F1EACC040:3'))).toBe(true);
    expect(keys.changeKey.equals(expect16('taply:ntag424:v1:change:04DE5F1EACC040:3'))).toBe(true);
  });

  it('rejects invalid master / uid / version (TypeError)', () => {
    expect(() => deriveTagKeys(Buffer.alloc(16, 1), UID_A, 1)).toThrow(TypeError);
    expect(() => deriveTagKeys(MASTER, Buffer.alloc(6), 1)).toThrow(TypeError);
    expect(() => deriveTagKeys(MASTER, Buffer.alloc(8), 1)).toThrow(TypeError);
    expect(() => deriveTagKeys(MASTER, '04DE5F1EACC040' as unknown as Buffer, 1)).toThrow(TypeError);
    for (const v of [0, 256, 1.5, Number.NaN]) {
      expect(() => deriveTagKeys(MASTER, UID_A, v), String(v)).toThrow(TypeError);
    }
  });
});
