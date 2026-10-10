/**
 * Plan de personnalisation + exécution sur une puce SIMULÉE.
 *
 * Le simulateur ci-dessous implémente le côté PICC d'après la datasheet
 * NT4H2421Gx (§8.2.3, §9.1, §9.3, §10) SANS réutiliser scripts/nfc/ev2.ts :
 * AES via node:crypto, CRC32 via node:zlib, CMAC via backend/nfc/aes-cmac.ts
 * (RFC 4493). Il vérifie MAC, compteurs, padding, CRC des ChangeKey, droits
 * d'accès, et produit les miroirs SDM à partir des offsets configurés.
 *
 * LIMITE : un simulateur écrit d'après la même lecture de la datasheet ne
 * prouve pas la compatibilité avec une vraie puce. Les vecteurs NXP
 * (ev2.test.ts) valident la cryptographie ; seul un test sur matériel
 * validera le comportement réel (états d'authentification, timings, lecteur).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { crc32 } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { aesCmac } from '../../../backend/nfc/aes-cmac.js';
import { deriveSdmMetaReadKey, deriveTagKeys } from '../../../backend/nfc/keys.js';
import { verifySunMessage } from '../../../backend/nfc/sdm.js';
import { authenticateEv2FirstStep2, buildAuthenticateEv2FirstPart1 } from '../../../scripts/nfc/ev2.js';
import { extractSunParams, parseNdefUriFile } from '../../../scripts/nfc/ndef.js';
import {
  ProvisioningError,
  buildProvisioningPlan,
  deriveProvisioningKeys,
  loadMasterKeyFile,
  runProvisioning,
  verifyProvisionedTag,
  type ProvisioningPlan,
  type StepEvent,
  type Transport,
} from '../../../scripts/nfc/plan.js';

// ── Helpers ─────────────────────────────────────────────────────────

const h = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const H = (b: Buffer): string => b.toString('hex').toUpperCase();
const ZERO16 = Buffer.alloc(16);

const MASTER_HEX = '8f1e2d3c4b5a69788796a5b4c3d2e1f000112233445566778899aabbccddeeff';
const MASTER = h(MASTER_HEX);
const UID = '04958CAA5C5E80';
const KEY_VERSION = 1;
const HOST = 'taply.fr';

function plan(uidHex = UID): ProvisioningPlan {
  return buildProvisioningPlan({ masterKeyHex: MASTER_HEX, uidHex, keyVersion: KEY_VERSION, host: HOST });
}

function keys(uidHex = UID) {
  return deriveProvisioningKeys(MASTER_HEX, uidHex, KEY_VERSION);
}

function expectedSlots(uidHex = UID): Buffer[] {
  const k = deriveTagKeys(MASTER, h(uidHex), KEY_VERSION);
  return [k.appMasterKey, k.sdmMetaReadKey, k.sdmFileReadKey, k.changeKey, k.changeKey];
}

async function expectProvisioningError(promise: Promise<unknown>, code: string): Promise<ProvisioningError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as ProvisioningError).code).toBe(code);
    return error as ProvisioningError;
  }
  throw new Error(`expected ProvisioningError ${code}`);
}

// ── Simulated PICC (datasheet-based, independent of ev2.ts) ─────────

function cbc(direction: 'enc' | 'dec', key: Buffer, iv: Buffer, data: Buffer): Buffer {
  const c = direction === 'enc' ? createCipheriv('aes-128-cbc', key, iv) : createDecipheriv('aes-128-cbc', key, iv);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(data), c.final()]);
}
const ecb = (key: Buffer, block: Buffer): Buffer => cbc('enc', key, ZERO16, block);
const macT = (key: Buffer, msg: Buffer): Buffer => {
  const full = aesCmac(key, msg);
  return Buffer.from([1, 3, 5, 7, 9, 11, 13, 15].map((i) => full[i] ?? 0));
};
const rotl = (b: Buffer): Buffer => Buffer.concat([b.subarray(1), b.subarray(0, 1)]);
const xor = (a: Buffer, b: Buffer): Buffer => Buffer.from(a.map((v, i) => v ^ (b[i] ?? 0)));
const u16 = (n: number): Buffer => Buffer.from([n & 0xff, n >> 8]);
const u24 = (n: number): Buffer => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]);
const sw = (v: number): Buffer => Buffer.from([v >> 8, v & 0xff]);
const pad = (d: Buffer): Buffer => {
  const out = Buffer.alloc((Math.floor(d.length / 16) + 1) * 16);
  d.copy(out);
  out[d.length] = 0x80;
  return out;
};
const unpad = (d: Buffer): Buffer | null => {
  let i = d.length - 1;
  while (i >= 0 && d[i] === 0) i--;
  return i < 0 || d[i] !== 0x80 || d.length - i > 16 ? null : Buffer.from(d.subarray(0, i));
};
const jamCrc = (d: Buffer): Buffer => {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(~crc32(d) >>> 0, 0);
  return out;
};

interface SimSdm {
  readonly uid: boolean;
  readonly ctr: boolean;
  readonly metaRead: number;
  readonly fileRead: number;
  readonly piccDataOffset: number;
  readonly macInputOffset: number;
  readonly macOffset: number;
}

/** Décode ChangeFileSettings (Table 69) ; null si invalide ou hors du sous-ensemble simulé. */
function parseCmdSettings(d: Buffer): { fileOption: number; ar: Buffer; sdm: SimSdm | null } | null {
  if (d.length < 3) return null;
  const fileOption = d[0] ?? 0;
  const ar = Buffer.from(d.subarray(1, 3));
  if (!(fileOption & 0x40)) return d.length === 3 ? { fileOption, ar, sdm: null } : null;
  if (d.length < 6) return null;
  const options = d[3] ?? 0;
  const metaRead = (d[5] ?? 0) >> 4;
  const fileRead = (d[5] ?? 0) & 0x0f;
  if (!(options & 0x01) || options & 0x30 || metaRead > 4 || fileRead > 4) return null; // sous-ensemble simulé
  if (d.length !== 6 + 9) return null;
  const piccDataOffset = d.readUIntLE(6, 3);
  const macInputOffset = d.readUIntLE(9, 3);
  const macOffset = d.readUIntLE(12, 3);
  if (macInputOffset > macOffset || macOffset > 256 - 16 || piccDataOffset > 256 - 32) return null;
  if (!(macOffset >= piccDataOffset + 32 || piccDataOffset >= macOffset + 16)) return null;
  return { fileOption, ar, sdm: { uid: !!(options & 0x80), ctr: !!(options & 0x40), metaRead, fileRead, piccDataOffset, macInputOffset, macOffset } };
}

interface SimAuth {
  readonly keyNo: number;
  readonly ti: Buffer;
  readonly enc: Buffer;
  readonly mac: Buffer;
  ctr: number;
}

class SimulatedNtag424 implements Transport {
  readonly uid: Buffer;
  readonly keys: Buffer[];
  readonly keyVersions: number[] = [0, 0, 0, 0, 0];
  settingsData: Buffer = h('00E0EE'); // FileOption 00, AR : RW=E Change=0 | Read=E Write=E (Table 8)
  readonly file = Buffer.alloc(256);
  sdmReadCtr = 0;
  readonly trace: string[] = [];
  failedAuthentications = 0;
  stateChanges = 0;
  /** Nombre d'APDU traités avant que la puce « quitte le champ ». */
  removeAfter: number | null = null;
  keepAuthOnSelect = false;
  keepAuthAfterKey0Change = false;

  private auth: SimAuth | null = null;
  private pending: { keyNo: number; rndB: Buffer } | null = null;
  private lastWasRead = false;
  private transmitted = 0;
  private padding = randomBytes(5);

  constructor(uidHex: string, keys: Buffer[] = [ZERO16, ZERO16, ZERO16, ZERO16, ZERO16]) {
    this.uid = h(uidHex);
    this.keys = keys.map((k) => Buffer.from(k));
  }

  removeFromField(): void {
    this.auth = null;
    this.pending = null;
    this.lastWasRead = false;
  }

  putBack(): void {
    this.removeFromField();
    this.removeAfter = null;
    this.transmitted = 0;
  }

  async transmit(apdu: Buffer): Promise<Buffer> {
    if (this.removeAfter !== null && this.transmitted >= this.removeAfter) {
      this.removeFromField();
      throw new Error('tag left the RF field');
    }
    this.transmitted++;
    this.trace.push(H(apdu.subarray(0, 2)));
    const isRead = apdu[0] === 0x90 && apdu[1] === 0xad;
    const response = this.process(apdu);
    if (!isRead) this.lastWasRead = false;
    return response;
  }

  private fail(code: number): Buffer {
    this.auth = null;
    return sw(code);
  }

  private checkMac(ins: number, header: Buffer, body: Buffer): Buffer | null {
    const a = this.auth;
    if (a === null || body.length < 8) return null;
    const payload = body.subarray(0, body.length - 8);
    const expected = macT(a.mac, Buffer.concat([Buffer.from([ins]), u16(a.ctr), a.ti, header, payload]));
    return expected.equals(body.subarray(body.length - 8)) ? Buffer.from(payload) : null;
  }

  private decryptCommand(payload: Buffer): Buffer | null {
    const a = this.auth;
    if (a === null || payload.length === 0 || payload.length % 16 !== 0) return null;
    const iv = ecb(a.enc, Buffer.concat([h('A55A'), a.ti, u16(a.ctr), Buffer.alloc(8)]));
    return unpad(cbc('dec', a.enc, iv, payload));
  }

  /** Réponse MAC/Full : CmdCtr DÉJÀ incrémenté. */
  private respond(respData: Buffer): Buffer {
    const a = this.auth;
    if (a === null) throw new Error('sim: respond without auth');
    return Buffer.concat([respData, macT(a.mac, Buffer.concat([h('00'), u16(a.ctr), a.ti, respData])), sw(0x9100)]);
  }

  private encryptResponse(plain: Buffer): Buffer {
    const a = this.auth;
    if (a === null) throw new Error('sim: encrypt without auth');
    const iv = ecb(a.enc, Buffer.concat([h('5AA5'), a.ti, u16(a.ctr), Buffer.alloc(8)]));
    return cbc('enc', a.enc, iv, pad(plain));
  }

  private get access(): { read: number; write: number; rw: number; change: number } {
    const b0 = this.settingsData[1] ?? 0;
    const b1 = this.settingsData[2] ?? 0;
    return { read: b1 >> 4, write: b1 & 0xf, rw: b0 >> 4, change: b0 & 0xf };
  }

  getFileSettingsData(): Buffer {
    return Buffer.concat([h('00'), this.settingsData.subarray(0, 3), u24(256), this.settingsData.subarray(3)]);
  }

  private mirrored(): Buffer {
    const out = Buffer.from(this.file);
    const parsed = parseCmdSettings(this.settingsData);
    const sdm = parsed?.sdm;
    if (sdm === undefined || sdm === null) return out;
    const ctr = u24(this.sdmReadCtr);
    const tag = (sdm.uid ? 0x80 | 0x07 : 0) | (sdm.ctr ? 0x40 : 0);
    const body = Buffer.concat([Buffer.from([tag]), sdm.uid ? this.uid : Buffer.alloc(0), sdm.ctr ? ctr : Buffer.alloc(0)]);
    const piccPlain = Buffer.concat([body, this.padding]).subarray(0, 16);
    out.write(H(cbc('enc', this.keys[sdm.metaRead] ?? ZERO16, ZERO16, piccPlain)), sdm.piccDataOffset, 'ascii');
    const sv2 = Buffer.concat([h('3CC300010080'), sdm.uid ? this.uid : Buffer.alloc(0), sdm.ctr ? ctr : Buffer.alloc(0)]);
    const sv2Padded = Buffer.concat([sv2, Buffer.alloc((16 - (sv2.length % 16)) % 16)]);
    const sessionKey = aesCmac(this.keys[sdm.fileRead] ?? ZERO16, sv2Padded);
    const mac = macT(sessionKey, out.subarray(sdm.macInputOffset, sdm.macOffset));
    out.write(H(mac), sdm.macOffset, 'ascii');
    return out;
  }

  private process(apdu: Buffer): Buffer {
    if (apdu[0] === 0x00 && apdu[1] === 0xa4) {
      if (H(apdu) !== '00A4040C07D276000085010100') return sw(0x6a82);
      if (!this.keepAuthOnSelect) this.auth = null;
      return sw(0x9000);
    }
    if (apdu[0] !== 0x90) return sw(0x6e00);
    const ins = apdu[1] ?? 0;
    let data: Buffer;
    if (apdu[2] !== 0 || apdu[3] !== 0) return this.fail(0x917e);
    if (apdu.length === 5) {
      if (apdu[4] !== 0) return this.fail(0x917e);
      data = Buffer.alloc(0);
    } else {
      const lc = apdu[4] ?? 0;
      if (apdu.length !== 6 + lc || apdu[apdu.length - 1] !== 0x00) return this.fail(0x917e);
      data = Buffer.from(apdu.subarray(5, 5 + lc));
    }
    if (this.pending !== null && ins !== 0xaf) this.pending = null;
    const a = this.auth;

    switch (ins) {
      case 0x71: {
        this.auth = null;
        const keyNo = data[0] ?? 0xff;
        if (data.length !== 2 || data[1] !== 0x00) return this.fail(0x917e);
        if (keyNo > 4) return this.fail(0x9140);
        const rndB = randomBytes(16);
        this.pending = { keyNo, rndB };
        return Buffer.concat([cbc('enc', this.keys[keyNo] ?? ZERO16, ZERO16, rndB), sw(0x91af)]);
      }
      case 0xaf: {
        const p = this.pending;
        this.pending = null;
        if (p === null || data.length !== 32) return this.fail(0x91ca);
        const key = this.keys[p.keyNo] ?? ZERO16;
        const dec = cbc('dec', key, ZERO16, data);
        const rndA = dec.subarray(0, 16);
        if (!dec.subarray(16).equals(rotl(p.rndB))) {
          this.failedAuthentications++;
          return this.fail(0x91ae);
        }
        const ti = randomBytes(4);
        const ctx = Buffer.concat([rndA.subarray(0, 2), xor(rndA.subarray(2, 8), p.rndB.subarray(0, 6)), p.rndB.subarray(6), rndA.subarray(8)]);
        this.auth = {
          keyNo: p.keyNo,
          ti,
          enc: aesCmac(key, Buffer.concat([h('A55A00010080'), ctx])),
          mac: aesCmac(key, Buffer.concat([h('5AA500010080'), ctx])),
          ctr: 0,
        };
        return Buffer.concat([cbc('enc', key, ZERO16, Buffer.concat([ti, rotl(rndA), Buffer.alloc(12)])), sw(0x9100)]);
      }
      case 0xf5: {
        if (data[0] !== 0x02) return this.fail(0x91f0);
        if (a === null) return data.length === 1 ? Buffer.concat([this.getFileSettingsData(), sw(0x9100)]) : this.fail(0x917e);
        const payload = this.checkMac(ins, data.subarray(0, 1), data.subarray(1));
        if (payload === null || payload.length !== 0) return this.fail(0x911e);
        a.ctr++;
        return this.respond(this.getFileSettingsData());
      }
      case 0x64: {
        const keyNo = data[0] ?? 0xff;
        if (keyNo > 4) return this.fail(0x9140);
        if (a === null) return Buffer.concat([Buffer.from([this.keyVersions[keyNo] ?? 0]), sw(0x9100)]);
        const payload = this.checkMac(ins, data.subarray(0, 1), data.subarray(1));
        if (payload === null || payload.length !== 0) return this.fail(0x911e);
        a.ctr++;
        return this.respond(Buffer.from([this.keyVersions[keyNo] ?? 0]));
      }
      case 0x51: {
        if (a === null) return this.fail(0x91ae);
        const payload = this.checkMac(ins, Buffer.alloc(0), data);
        if (payload === null || payload.length !== 0) return this.fail(0x911e);
        a.ctr++;
        return this.respond(this.encryptResponse(this.uid));
      }
      case 0x8d: {
        if (data.length < 8 || data[0] !== 0x02) return this.fail(0x917e);
        const offset = data.readUIntLE(1, 3);
        const length = data.readUIntLE(4, 3);
        const body = data.subarray(7);
        const { write, rw } = this.access;
        const granted = write === 0xe || rw === 0xe || (a !== null && (write === a.keyNo || rw === a.keyNo));
        if (!granted) return this.fail(0x91ae);
        if (((this.settingsData[0] ?? 0) & 0x03) !== 0) return this.fail(0x919e); // sim : fichier Plain uniquement
        if (body.length !== length || offset + length > 256) return this.fail(0x91be);
        if (a !== null) a.ctr++; // CommMode.Plain sous authentification : compteur incrémenté
        body.copy(this.file, offset);
        this.stateChanges++;
        return sw(0x9100);
      }
      case 0x5f: {
        if (a === null || this.access.change !== a.keyNo) return this.fail(0x91ae);
        const payload = this.checkMac(ins, data.subarray(0, 1), data.subarray(1));
        if (payload === null || data[0] !== 0x02) return this.fail(0x911e);
        const plain = this.decryptCommand(payload);
        if (plain === null) return this.fail(0x911e);
        a.ctr++;
        const parsed = parseCmdSettings(plain);
        if (parsed === null) return this.fail(0x919e);
        this.settingsData = plain;
        if (parsed.sdm !== null) this.sdmReadCtr = 0; // §9.3.1
        this.stateChanges++;
        return this.respond(Buffer.alloc(0));
      }
      case 0xc4: {
        if (a === null || a.keyNo !== 0) return this.fail(0x91ae);
        const keyNo = data[0] ?? 0xff;
        if (keyNo > 4) return this.fail(0x9140);
        const payload = this.checkMac(ins, data.subarray(0, 1), data.subarray(1));
        if (payload === null) return this.fail(0x911e);
        const plain = this.decryptCommand(payload);
        if (plain === null) return this.fail(0x911e);
        a.ctr++;
        if (keyNo === a.keyNo) {
          if (plain.length !== 17) return this.fail(0x911e);
          this.keys[keyNo] = Buffer.from(plain.subarray(0, 16));
          this.keyVersions[keyNo] = plain[16] ?? 0;
          this.stateChanges++;
          if (!this.keepAuthAfterKey0Change) this.auth = null;
          return sw(0x9100); // pas de MAC : la clé de session n'est plus valide
        }
        if (plain.length !== 21) return this.fail(0x911e);
        const newKey = xor(plain.subarray(0, 16), this.keys[keyNo] ?? ZERO16);
        if (!jamCrc(newKey).equals(plain.subarray(17, 21))) return this.fail(0x911e);
        this.keys[keyNo] = newKey;
        this.keyVersions[keyNo] = plain[16] ?? 0;
        this.stateChanges++;
        return this.respond(Buffer.alloc(0));
      }
      case 0xad: {
        if (data.length !== 7 || data[0] !== 0x02) return this.fail(0x917e);
        const offset = data.readUIntLE(1, 3);
        const length = data.readUIntLE(4, 3) || 256 - offset;
        const { read, rw } = this.access;
        const sdm = parseCmdSettings(this.settingsData)?.sdm ?? null;
        if (a !== null) {
          if (!(read === 0xe || rw === 0xe || read === a.keyNo || rw === a.keyNo)) return this.fail(0x91ae);
          a.ctr++;
          return Buffer.concat([this.file.subarray(offset, offset + length), sw(0x9100)]); // pas de miroir authentifié
        }
        if (sdm === null) {
          if (read !== 0xe && rw !== 0xe) return this.fail(0x91ae);
          return Buffer.concat([this.file.subarray(offset, offset + length), sw(0x9100)]);
        }
        if (!this.lastWasRead) {
          this.sdmReadCtr++;
          this.padding = randomBytes(5);
        }
        this.lastWasRead = true;
        return Buffer.concat([this.mirrored().subarray(offset, offset + length), sw(0x9100)]);
      }
      default:
        return this.fail(0x911c);
    }
  }
}

/** Ce que fait un téléphone : sélection + lecture non authentifiée. */
async function phoneTap(sim: SimulatedNtag424): Promise<{ e: string | null; c: string | null; url: string }> {
  sim.removeFromField();
  await sim.transmit(h('00A4040C07D276000085010100'));
  const rapdu = await sim.transmit(h('90AD0000070200000000000000'));
  const url = parseNdefUriFile(rapdu.subarray(0, rapdu.length - 2));
  return { ...extractSunParams(url), url };
}

/** Vérification exactement comme le serveur (backend/nfc/tap.ts → verifyTap). */
function serverVerify(e: unknown, c: unknown) {
  return verifySunMessage({
    e,
    c,
    sdmMetaReadKey: deriveSdmMetaReadKey(MASTER, KEY_VERSION),
    fileReadKeyForUid: (uidHex) => deriveTagKeys(MASTER, Buffer.from(uidHex, 'hex'), KEY_VERSION).sdmFileReadKey,
  });
}

const FULL_SEQUENCE = [
  '00A4', // ISOSelectFile
  '90F5', // GetFileSettings (plain, contrôle préalable)
  '9071', '90AF', // AuthenticateEV2First clé 0
  '9051', // GetCardUID
  '908D', // WriteData NDEF
  '905F', // ChangeFileSettings
  '90F5', // GetFileSettings (MAC)
  '9064', '90C4', '9064', '90C4', '9064', '90C4', '9064', '90C4', // clés 1..4
  '90C4', // clé 0
  '00A4', '90AD', // vérification SUN
];

// ── Plan ────────────────────────────────────────────────────────────

describe('buildProvisioningPlan', () => {
  const p = plan();

  it('orders the steps: checks first, NDEF before ChangeFileSettings, key 0 last, verification at the end', () => {
    expect(p.steps.map((s) => s.id)).toEqual([
      'select-application', 'precheck-file-settings', 'authenticate-key0', 'get-card-uid', 'write-ndef',
      'change-file-settings', 'verify-file-settings', 'change-key-1', 'change-key-2', 'change-key-3', 'change-key-4',
      'change-key-0', 'verify-sun-read',
    ]);
    expect(p.steps.find((s) => s.id === 'change-file-settings')?.needsAuthWithKey).toBe(0);
    expect(p.steps.find((s) => s.id === 'write-ndef')?.needsAuthWithKey).toBeNull();
  });

  it('file settings: FileOption 40, AR 00E0, SDMOptions C1, SDMAR FF12, offsets from the NDEF bytes', () => {
    expect(H(p.fileSettings)).toBe('4000E0C1FF12140000370000370000');
    expect(p.ndef.piccDataOffset).toBe(0x14);
    expect(p.ndef.sdmMacOffset).toBe(0x37);
    expect(H(p.expectedFileSettings)).toBe('004000E0000100C1FF12140000370000370000');
    expect(H(p.factoryFileSettings)).toBe('0000E0EE000100');
  });

  it('contains no key material anywhere (master, derived keys, any case)', () => {
    const text = JSON.stringify(p).toUpperCase();
    expect(text).not.toContain(MASTER_HEX.toUpperCase());
    for (const key of expectedSlots()) expect(text).not.toContain(H(key));
  });

  it('rejects invalid inputs with code invalid_input', () => {
    const base = { masterKeyHex: MASTER_HEX, uidHex: UID, keyVersion: 1, host: HOST };
    for (const bad of [
      { ...base, uidHex: '05958CAA5C5E80' },
      { ...base, uidHex: '958CAA5C5E80' },
      { ...base, keyVersion: 0 },
      { ...base, keyVersion: 256 },
      { ...base, masterKeyHex: '0'.repeat(64) },
      { ...base, masterKeyHex: 'zz' },
      { ...base, host: 'https://taply.fr' },
    ]) {
      expect(() => buildProvisioningPlan(bad)).toThrow(ProvisioningError);
    }
    expect(plan(UID.toLowerCase()).uidHex).toBe(UID);
  });
});

describe('deriveProvisioningKeys', () => {
  it('uses exactly deriveTagKeys: slot 0..4 = appMaster, sdmMetaRead, sdmFileRead, change, change', () => {
    const k = keys();
    expectedSlots().forEach((expected, slot) => expect(H(k.slot(slot))).toBe(H(expected)));
    expect(H(k.slot(1))).toBe(H(deriveSdmMetaReadKey(MASTER, KEY_VERSION)));
  });

  it('is redacted in JSON and util.inspect', () => {
    const k = keys();
    for (const text of [JSON.stringify(k), inspect(k), String(inspect({ nested: k }))]) {
      for (const key of expectedSlots()) expect(text.toUpperCase()).not.toContain(H(key));
      expect(text).toContain('redacted');
    }
  });

  it('slot() returns a copy (wiping it does not affect the keys)', () => {
    const k = keys();
    k.slot(2).fill(0);
    expect(H(k.slot(2))).toBe(H(expectedSlots()[2] ?? ZERO16));
  });
});

// ── Master key file ─────────────────────────────────────────────────

describe('loadMasterKeyFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'taply-nfc-master-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function file(name: string, content: string, mode: number): string {
    const path = join(dir, name);
    writeFileSync(path, content);
    chmodSync(path, mode);
    return path;
  }

  it('accepts a 0600 file with a trailing newline', () => {
    expect(loadMasterKeyFile(file('ok.hex', `${MASTER_HEX}\n`, 0o600))).toBe(MASTER_HEX);
    expect(loadMasterKeyFile(file('ok400.hex', MASTER_HEX, 0o400))).toBe(MASTER_HEX);
  });

  it.each([0o644, 0o640, 0o604, 0o660])('refuses mode %o (group/other access)', (mode) => {
    expect(() => loadMasterKeyFile(file(`m${mode.toString(8)}.hex`, MASTER_HEX, mode))).toThrow(/chmod 600/);
  });

  it('refuses an all-zero, malformed, missing or non-regular master file', () => {
    expect(() => loadMasterKeyFile(file('zero.hex', '0'.repeat(64), 0o600))).toThrow(/all-zero/);
    expect(() => loadMasterKeyFile(file('short.hex', 'abcd', 0o600))).toThrow(/64 hex/);
    expect(() => loadMasterKeyFile(file('spaces.hex', ` ${MASTER_HEX}`, 0o600))).toThrow(/64 hex/);
    expect(() => loadMasterKeyFile(join(dir, 'absent.hex'))).toThrow(/cannot open/);
    const sub = join(dir, 'subdir');
    mkdirSync(sub, { mode: 0o700 });
    expect(() => loadMasterKeyFile(sub)).toThrow(ProvisioningError);
  });
});

// ── Exécution sur puce simulée ──────────────────────────────────────

describe('runProvisioning on a simulated factory tag', () => {
  it('provisions, verifies, and produces taps the server accepts', async () => {
    const sim = new SimulatedNtag424(UID);
    const events: StepEvent[] = [];
    const report = await runProvisioning(sim, plan(), keys(), { onStep: (e) => events.push(e) });

    expect(report).toEqual({ outcome: 'provisioned', verification: { status: 'verified', readCtr: 1 } });
    expect(sim.trace).toEqual(FULL_SEQUENCE);
    expect(events.map((e) => `${e.step}:${e.status}`)).toEqual([
      'select-application:ok', 'precheck-file-settings:ok', 'authenticate-key0:ok', 'get-card-uid:ok', 'write-ndef:ok',
      'change-file-settings:ok', 'verify-file-settings:ok', 'change-key-1:ok', 'change-key-2:ok', 'change-key-3:ok',
      'change-key-4:ok', 'change-key-0:ok', 'verify-sun-read:ok',
    ]);
    for (const event of events) for (const key of expectedSlots()) expect(event.detail.toUpperCase()).not.toContain(H(key));

    // État final de la puce : clés = dérivation serveur, version 1, réglages et NDEF du plan.
    expectedSlots().forEach((expected, slot) => expect(H(sim.keys[slot] ?? ZERO16)).toBe(H(expected)));
    expect(sim.keyVersions).toEqual([1, 1, 1, 1, 1]);
    expect(H(sim.getFileSettingsData())).toBe(H(plan().expectedFileSettings));
    expect(H(sim.file.subarray(0, plan().ndef.bytes.length))).toBe(H(plan().ndef.bytes));

    // Taps téléphone : URL différente à chaque fois, compteur croissant, acceptée par le serveur.
    const first = await phoneTap(sim);
    const second = await phoneTap(sim);
    expect(first.url.startsWith('https://taply.fr/t?e=')).toBe(true);
    expect(first.e).not.toBe(second.e);
    expect(serverVerify(first.e, first.c)).toEqual({ ok: true, uidHex: UID, readCtr: 2 });
    expect(serverVerify(second.e, second.c)).toEqual({ ok: true, uidHex: UID, readCtr: 3 });
  });

  it('afterwards: unauthenticated WriteData is refused and the factory key 0 no longer authenticates', async () => {
    const sim = new SimulatedNtag424(UID);
    await runProvisioning(sim, plan(), keys());
    sim.removeFromField();
    expect(H(await sim.transmit(h('00A4040C07D276000085010100')))).toBe('9000');
    // WriteData 3 octets à l'offset 0, sans authentification (Write = 0 ⇒ refusé).
    expect(H(await sim.transmit(h('908D00000A02000000030000414141 00')))).toBe('91AE');
    const part1 = await sim.transmit(buildAuthenticateEv2FirstPart1(0));
    const part2 = authenticateEv2FirstStep2(ZERO16, part1.subarray(0, 16), randomBytes(16));
    expect(H(await sim.transmit(part2.apdu))).toBe('91AE');
  });

  it('keys derived for another UID are refused before any APDU', async () => {
    const sim = new SimulatedNtag424(UID);
    await expectProvisioningError(runProvisioning(sim, plan(), keys('04958CAA5C5E81')), 'invalid_input');
    expect(sim.trace).toEqual([]);
  });
});

describe('runProvisioning refuses anything that is not a factory or Taply tag', () => {
  it('foreign key 0 (supplier-locked tag): stops after one failed authentication, nothing written', async () => {
    const foreign = randomBytes(16);
    const sim = new SimulatedNtag424(UID, [foreign, ZERO16, ZERO16, ZERO16, ZERO16]);
    const error = await expectProvisioningError(runProvisioning(sim, plan(), keys()), 'factory_key_rejected');
    expect(error.sw).toBe(0x91ae);
    expect(sim.failedAuthentications).toBe(1);
    expect(sim.stateChanges).toBe(0);
    expect(sim.trace).toEqual(['00A4', '90F5', '9071', '90AF']);
  });

  it('pre-configured NDEF file (third-party settings): stops before any authentication', async () => {
    const sim = new SimulatedNtag424(UID);
    sim.settingsData = h('40EEEEC1FE00200000430000430000'); // SDM tiers, droits libres
    await expectProvisioningError(runProvisioning(sim, plan(), keys()), 'precheck_unexpected_settings');
    expect(sim.trace).toEqual(['00A4', '90F5']);
    expect(sim.stateChanges).toBe(0);
  });

  it('UID different from --uid: stops before writing', async () => {
    const sim = new SimulatedNtag424('04AABBCCDDEEFF');
    const error = await expectProvisioningError(runProvisioning(sim, plan(), keys()), 'uid_mismatch');
    expect(error.message).toContain('04AABBCCDDEEFF');
    expect(sim.stateChanges).toBe(0);
  });

  it('a tampered response MAC (relay / bad reader) aborts before writing', async () => {
    const sim = new SimulatedNtag424(UID);
    const mitm: { transmit(apdu: Buffer): Promise<Buffer> } = {
      async transmit(apdu) {
        const response = await sim.transmit(apdu);
        if (apdu[1] === 0x51) response[0] = (response[0] ?? 0) ^ 0x01;
        return response;
      },
    };
    const error = await expectProvisioningError(runProvisioning(mitm, plan(), keys()), 'card_error');
    expect(error.step).toBe('get-card-uid');
    expect(sim.stateChanges).toBe(0);
  });
});

describe('runProvisioning resume and re-run', () => {
  it('resumes after the tag left the field between ChangeKey 2 and ChangeKey 3', async () => {
    const sim = new SimulatedNtag424(UID);
    sim.removeAfter = 12; // 12 APDU traités : … GetKeyVersion 2, ChangeKey 2
    const error = await expectProvisioningError(runProvisioning(sim, plan(), keys()), 'card_error');
    expect(error.step).toBe('change-key-3');
    expect(sim.keyVersions).toEqual([0, 1, 1, 0, 0]);

    sim.putBack();
    const report = await runProvisioning(sim, plan(), keys());
    expect(report).toEqual({ outcome: 'provisioned', verification: { status: 'verified', readCtr: 1 } });
    expectedSlots().forEach((expected, slot) => expect(H(sim.keys[slot] ?? ZERO16)).toBe(H(expected)));
    const tap = await phoneTap(sim);
    expect(serverVerify(tap.e, tap.c)).toMatchObject({ ok: true, uidHex: UID });
  });

  it('re-running on a fully provisioned tag only checks and verifies', async () => {
    const sim = new SimulatedNtag424(UID);
    await runProvisioning(sim, plan(), keys());
    const changes = sim.stateChanges;
    sim.putBack();
    const report = await runProvisioning(sim, plan(), keys());
    expect(report.outcome).toBe('already_provisioned');
    expect(report.verification.status).toBe('verified');
    expect(sim.stateChanges).toBe(changes);
    expect(sim.failedAuthentications).toBe(1); // une tentative clé usine, puis clé Taply
  });

  it('reports not_mirrored if the PICC stays authenticated, then verifies after a re-tap', async () => {
    const sim = new SimulatedNtag424(UID);
    sim.keepAuthOnSelect = true;
    sim.keepAuthAfterKey0Change = true;
    const report = await runProvisioning(sim, plan(), keys());
    expect(report.verification).toEqual({ status: 'not_mirrored' });
    sim.removeFromField();
    expect(await verifyProvisionedTag(sim, plan(), keys())).toEqual({ status: 'verified', readCtr: 1 });
  });
});
