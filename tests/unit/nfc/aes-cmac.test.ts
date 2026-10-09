/**
 * Tests AES-128-CMAC — vecteurs officiels RFC 4493 §4 + exemple NXP AN12196
 * (Rev. 2.0, §3.4.4.2.1, sous-clés et bloc final détaillés).
 */

import { describe, expect, it } from 'vitest';
import { aesCmac } from '../../../backend/nfc/aes-cmac.js';

const hex = (s: string): Buffer => Buffer.from(s, 'hex');

const RFC_KEY = hex('2b7e151628aed2a6abf7158809cf4f3c');
const RFC_MSG_64 =
  '6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710';

describe('aesCmac — RFC 4493 test vectors', () => {
  it('Example 1: empty message (len 0)', () => {
    expect(aesCmac(RFC_KEY, Buffer.alloc(0)).toString('hex')).toBe('bb1d6929e95937287fa37d129b756746');
  });

  it('Example 2: one complete block (len 16)', () => {
    expect(aesCmac(RFC_KEY, hex(RFC_MSG_64.slice(0, 32))).toString('hex')).toBe(
      '070a16b46b4d4144f79bdd9dd04a287c',
    );
  });

  it('Example 3: partial last block (len 40)', () => {
    expect(aesCmac(RFC_KEY, hex(RFC_MSG_64.slice(0, 80))).toString('hex')).toBe(
      'dfa66747de9ae63030ca32611497c827',
    );
  });

  it('Example 4: four complete blocks (len 64)', () => {
    expect(aesCmac(RFC_KEY, hex(RFC_MSG_64)).toString('hex')).toBe('51f0bebf7e3b9d92fc49741779363cfe');
  });
});

describe('aesCmac — NXP AN12196 Table 4 (zero-length input)', () => {
  it('full 16-byte CMAC of empty input under KSesSDMFileReadMAC', () => {
    // AN12196 Rev. 2.0 p.16 : KsesSDMFileReadMAC = 3FB5…776F → Step6 = e194c7ee…4386.
    const key = hex('3FB5F6E3A807A03D5E3570ACE393776F');
    expect(aesCmac(key, Buffer.alloc(0)).toString('hex')).toBe('e194c7ee12d9f7ee8a65c8331b704386');
  });
});

describe('aesCmac — robustness', () => {
  it('always returns 16 bytes', () => {
    for (const len of [0, 1, 15, 16, 17, 31, 32, 33, 100]) {
      expect(aesCmac(RFC_KEY, Buffer.alloc(len, 0xab))).toHaveLength(16);
    }
  });

  it('rejects keys that are not exactly 16 bytes (TypeError)', () => {
    for (const len of [0, 1, 15, 17, 24, 32]) {
      expect(() => aesCmac(Buffer.alloc(len), Buffer.alloc(0)), `len ${len}`).toThrow(TypeError);
    }
  });

  it('rejects non-Buffer key / message (TypeError)', () => {
    expect(() => aesCmac('2b7e151628aed2a6abf7158809cf4f3c' as unknown as Buffer, Buffer.alloc(0))).toThrow(
      TypeError,
    );
    expect(() => aesCmac(RFC_KEY, 'abc' as unknown as Buffer)).toThrow(TypeError);
  });

  it('does not mutate the caller message', () => {
    const msg = hex(RFC_MSG_64.slice(0, 80));
    const copy = Buffer.from(msg);
    aesCmac(RFC_KEY, msg);
    expect(msg.equals(copy)).toBe(true);
  });

  it('handles a message that is a view into a larger buffer (byteOffset ≠ 0)', () => {
    const backing = Buffer.concat([Buffer.alloc(7, 0xee), hex(RFC_MSG_64.slice(0, 80)), Buffer.alloc(9, 0xdd)]);
    const view = backing.subarray(7, 7 + 40);
    expect(aesCmac(RFC_KEY, view).toString('hex')).toBe('dfa66747de9ae63030ca32611497c827');
  });

  it('distinguishes a message from its 0x80-padded form (K1 vs K2 path)', () => {
    const partial = hex('6bc1bee22e409f96e93d7e1173');
    const manuallyPadded = Buffer.concat([partial, hex('800000')]);
    expect(aesCmac(RFC_KEY, partial).equals(aesCmac(RFC_KEY, manuallyPadded))).toBe(false);
  });
});
