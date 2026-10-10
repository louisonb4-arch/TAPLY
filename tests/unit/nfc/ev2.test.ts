/**
 * Protocole EV2 (NTAG 424 DNA) — vecteurs publiés par NXP.
 *
 * Source : NXP AN12196 « NTAG 424 DNA and NTAG 424 DNA TagTamper features
 * and hints », Rev. 2.0 (4 mars 2025) — texte extrait du PDF officiel et lu
 * table par table. Structures et règles : NXP NT4H2421Gx datasheet Rev. 3.0.
 *
 * Chaque test reproduit OCTET POUR OCTET les valeurs intermédiaires et les
 * APDU publiés. Une seule incohérence du document est documentée (Table 17,
 * champ Length de l'en-tête WriteData) : la valeur retenue est celle que
 * confirme le MAC publié.
 */

import { describe, expect, it } from 'vitest';
import { aesCmac } from '../../../backend/nfc/aes-cmac.js';
import {
  Ntag424Error,
  aesCbcEncrypt,
  authenticateEv2FirstStep2,
  buildAuthenticateEv2FirstPart1,
  buildAuthenticateEv2NonFirstPart1,
  buildChangeFileSettings,
  buildChangeKey,
  buildFullCommand,
  buildGetCardUid,
  buildGetFileSettingsMac,
  buildGetFileSettingsPlain,
  buildIsoSelectNdefApplication,
  buildReadDataPlain,
  buildWriteDataFull,
  buildWriteDataPlain,
  changeKeyData,
  commandIv,
  crc32Nk,
  decryptFullResponse,
  deriveSessionKeys,
  encodeFileSettings,
  expectStatus,
  padIso9797M2,
  parseAuthenticatePart1Response,
  parseFileSettings,
  parseGetCardUidResponse,
  responseIv,
  sessionVectors,
  truncateMac,
  unpadIso9797M2,
  verifyAuthenticateEv2FirstResponse,
  verifyAuthenticateEv2NonFirstResponse,
  verifyMacResponse,
  type Ev2Session,
} from '../../../scripts/nfc/ev2.js';

// ── Helpers ─────────────────────────────────────────────────────────

const h = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const H = (b: Buffer): string => b.toString('hex').toUpperCase();
const ZERO_KEY = Buffer.alloc(16);

/** Session « figée » d'une table AN12196 (TI + clés de session publiées). */
function session(ti: string, enc: string, mac: string): Ev2Session {
  return { ti: h(ti), sesAuthEncKey: h(enc), sesAuthMacKey: h(mac) };
}

// ── AN12196 Table 14 : AuthenticateEV2First, clé 0 ──────────────────

describe('AN12196 §5.6 Table 14 — AuthenticateEV2First with key 0x00 (K0 = 00×16)', () => {
  const rndA = h('13C5DB8A5930439FC3DEF9A4C675360F');
  const encRndB = h('A04C124213C186F22399D33AC2A30215');

  it('step 5: C-APDU part 1 = 9071000002000000', () => {
    expect(H(buildAuthenticateEv2FirstPart1(0))).toBe('9071000002000000');
  });

  it('steps 6–7: R-APDU part 1 parsed to E(K0, RndB)', () => {
    expect(H(parseAuthenticatePart1Response(h('A04C124213C186F22399D33AC2A3021591AF')))).toBe(H(encRndB));
  });

  it('steps 9–14: RndB, RndA || RndB\', E(K0, RndA || RndB\') and the part 2 C-APDU', () => {
    const step2 = authenticateEv2FirstStep2(ZERO_KEY, encRndB, rndA);
    expect(H(step2.rndB)).toBe('B9E2FC789B64BF237CCCAA20EC7E6E48');
    expect(H(step2.pcdCryptogram)).toBe('35C3E05A752E0144BAC0DE51C1F22C56B34408A23D8AEA266CAB947EA8E0118D');
    expect(H(step2.apdu)).toBe('90AF00002035C3E05A752E0144BAC0DE51C1F22C56B34408A23D8AEA266CAB947EA8E0118D00');
  });

  it('steps 15–24: PICC response → TI 9D00C4DF, RndA\' verified, PDcap2/PCDcap2 = 0', () => {
    const rndB = h('B9E2FC789B64BF237CCCAA20EC7E6E48');
    const result = verifyAuthenticateEv2FirstResponse(
      ZERO_KEY,
      h('3FA64DB5446D1F34CD6EA311167F5E4985B89690C04A05F17FA7AB2F081206639100'),
      rndA,
      rndB,
    );
    expect(H(result.session.ti)).toBe('9D00C4DF');
    expect(H(result.pdCap2)).toBe('000000000000');
    expect(H(result.pcdCap2)).toBe('000000000000');
    // Steps 27–28.
    expect(H(result.session.sesAuthEncKey)).toBe('1309C877509E5A215007FF0ED19CA564');
    expect(H(result.session.sesAuthMacKey)).toBe('4C6626F5E72EA694202139295C7A7FC7');
  });

  it('steps 25–26: SV1 / SV2 exactly as published (datasheet §9.1.7 construction)', () => {
    const { sv1, sv2 } = sessionVectors(rndA, h('B9E2FC789B64BF237CCCAA20EC7E6E48'));
    expect(H(sv1)).toBe('A55A0001008013C56268A548D8FBBF237CCCAA20EC7E6E48C3DEF9A4C675360F');
    expect(H(sv2)).toBe('5AA50001008013C56268A548D8FBBF237CCCAA20EC7E6E48C3DEF9A4C675360F');
    expect(sv1.length).toBe(32);
  });

  it('a wrong RndA\' (PICC that does not know the key) is rejected', () => {
    expect(() =>
      verifyAuthenticateEv2FirstResponse(
        ZERO_KEY,
        h('3FA64DB5446D1F34CD6EA311167F5E4985B89690C04A05F17FA7AB2F081206639100'),
        h('00C5DB8A5930439FC3DEF9A4C675360F'),
        h('B9E2FC789B64BF237CCCAA20EC7E6E48'),
      ),
    ).toThrow(Ntag424Error);
  });

  it('91AE on part 2 (wrong key) surfaces as Ntag424Error with sw = 0x91AE', () => {
    try {
      verifyAuthenticateEv2FirstResponse(ZERO_KEY, h('91AE'), rndA, rndA);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Ntag424Error);
      expect((error as Ntag424Error).sw).toBe(0x91ae);
    }
  });

  it('an 18-byte LRP part 1 answer is refused (LRP not supported)', () => {
    expect(() => parseAuthenticatePart1Response(Buffer.concat([Buffer.alloc(17), h('91AF')]))).toThrow(/LRP/);
  });
});

// ── AN12196 Table 19 : AuthenticateEV2First, clé 3 ──────────────────

describe('AN12196 §5.10 Table 19 — AuthenticateEV2First with key 0x03', () => {
  it('reproduces part 2 C-APDU, TI 7614281A and both session keys', () => {
    const rndA = h('B98F4C50CF1C2E084FD150E33992B048');
    expect(H(buildAuthenticateEv2FirstPart1(3))).toBe('9071000002030000');
    const step2 = authenticateEv2FirstStep2(ZERO_KEY, h('B875CEB0E66A6C5CD00898DC371F92D1'), rndA);
    expect(H(step2.rndB)).toBe('91517975190DCEA6104948EFA3085C1B');
    expect(H(step2.apdu)).toBe('90AF000020FF0306E47DFBC50087C4D8A78E88E62DE1E8BE457AA477C707E2F0874916A8B100');
    const { session: s } = verifyAuthenticateEv2FirstResponse(
      ZERO_KEY,
      h('0CC9A8094A8EEA683ECAAC5C7BF20584206D0608D477110FC6B3D5D3F65C3A6A9100'),
      rndA,
      step2.rndB,
    );
    expect(H(s.ti)).toBe('7614281A');
    expect(H(sessionVectors(rndA, step2.rndB).sv1)).toBe('A55A00010080B98FDD01B6693705CEA6104948EFA3085C1B4FD150E33992B048');
    expect(H(s.sesAuthEncKey)).toBe('7A93D6571E4B180FCA6AC90C9A7488D4');
    expect(H(s.sesAuthMacKey)).toBe('FC4AF159B62E549B5812394CAB1918CC');
  });
});

// ── AN12196 Table 23 : AuthenticateEV2NonFirst ──────────────────────

describe('AN12196 §5.14 Table 23 — AuthenticateEV2NonFirst with key 0x00', () => {
  it('reproduces the C-APDUs, SV1/SV2 and session keys (TI kept from Table 19)', () => {
    const rndA = h('60BE759EDA560250AC57CDDC11743CF6');
    expect(H(buildAuthenticateEv2NonFirstPart1(0))).toBe('90770000010000');
    const step2 = authenticateEv2FirstStep2(ZERO_KEY, h('A6A2B3C572D06C097BB8DB70463E22DC'), rndA);
    expect(H(step2.rndB)).toBe('6924E8D09722659A2E7DEC68E66312B8');
    expect(H(step2.apdu)).toBe('90AF000020BE7D45753F2CAB85F34BC60CE58B940763FE969658A532DF6D95EA2773F6E99100');
    const { sv1, sv2 } = sessionVectors(rndA, step2.rndB);
    expect(H(sv1)).toBe('A55A0001008060BE1CBA32869572659A2E7DEC68E66312B8AC57CDDC11743CF6');
    expect(H(sv2)).toBe('5AA50001008060BE1CBA32869572659A2E7DEC68E66312B8AC57CDDC11743CF6');
    const s = verifyAuthenticateEv2NonFirstResponse(ZERO_KEY, h('B888349C24B315EAB5B589E279C8263E9100'), rndA, step2.rndB, h('7614281A'));
    expect(H(s.sesAuthEncKey)).toBe('4CF3CB41A22583A61E89B158D252FC53');
    expect(H(s.sesAuthMacKey)).toBe('5529860B2FC5FB6154B7F28361D30BF9');
    expect(deriveSessionKeys(ZERO_KEY, rndA, step2.rndB)).toEqual({ sesAuthEncKey: s.sesAuthEncKey, sesAuthMacKey: s.sesAuthMacKey });
  });
});

// ── AN12196 Table 9 / 10 : commandes en clair ──────────────────────

describe('AN12196 plain commands', () => {
  it('Table 9: ISOSelectFile of the NDEF application = 00A4040C07D276000085010100', () => {
    expect(H(buildIsoSelectNdefApplication())).toBe('00A4040C07D276000085010100');
  });

  it('Table 10: GetFileSettings(02) plain = 90F50000010200', () => {
    expect(H(buildGetFileSettingsPlain(2))).toBe('90F50000010200');
  });

  it('Table 24: WriteData plain to the CC file (offset 0x0E, 18 bytes)', () => {
    expect(H(buildWriteDataPlain(1, 0x0e, h('FF0506E10500808283000000000000000000')))).toBe(
      '908D000019010E0000120000FF0506E1050080828300000000000000000000',
    );
  });

  it('ReadData plain framing: 90 AD 00 00 07 FileNo Offset(3) Length(3) 00 (datasheet Table 78)', () => {
    expect(H(buildReadDataPlain(2, 0, 0x47))).toBe('90AD0000070200000047000000');
  });
});

// ── AN12196 Table 7 : CommMode.MAC (GetFileSettings) ────────────────

describe('AN12196 §4.3 Table 7 — CommMode.MAC on GetFileSettings', () => {
  const s = session('7A21085E', '00000000000000000000000000000000', '8248134A386E86EB7FAF54A52E536CB6');

  it('steps 7–10: CMAC, MACt (odd bytes) and C-APDU', () => {
    expect(H(aesCmac(s.sesAuthMacKey, h('F500007A21085E02')))).toBe('B565AC978FA46D5784C845CD1444102C');
    expect(H(truncateMac(h('B565AC978FA46D5784C845CD1444102C')))).toBe('6597A457C8CD442C');
    expect(H(buildGetFileSettingsMac(s, 0, 2))).toBe('90F5000009026597A457C8CD442C00');
  });

  it('steps 11–15: response MAC verified over RC || CmdCtr+1 || TI || RespData', () => {
    const data = verifyMacResponse(s, 0, h('0040EEEE000100D1FE001F00004400004400002000006A00002A474282E7A479869100'));
    expect(H(data)).toBe('0040EEEE000100D1FE001F00004400004400002000006A0000');
  });

  it('a single flipped bit in the response is rejected', () => {
    expect(() => verifyMacResponse(s, 0, h('0040EEEE000100D1FE001F00004400004400002000006B00002A474282E7A479869100'))).toThrow(/MAC mismatch/);
    // Mauvais compteur : même données, CmdCtr décalé.
    expect(() => verifyMacResponse(s, 1, h('0040EEEE000100D1FE001F00004400004400002000006A00002A474282E7A479869100'))).toThrow(/MAC mismatch/);
  });

  it('the published response decodes per datasheet Table 73 (offsets agree with AN12196 Table 5)', () => {
    const parsed = parseFileSettings(h('0040EEEE000100D1FE001F00004400004400002000006A0000'));
    expect(parsed).toEqual({
      fileType: 0,
      commMode: 'plain',
      access: { read: 0xe, write: 0xe, readWrite: 0xe, change: 0xe },
      fileSize: 256,
      sdm: {
        uidMirror: true, readCtrMirror: true, readCtrLimitEnabled: false, encFileData: true, asciiEncoding: true,
        metaRead: 0, fileRead: 0, ctrRet: 0xe,
        uidOffset: null, readCtrOffset: null,
        piccDataOffset: 0x1f, macInputOffset: 0x44, encOffset: 0x44, encLength: 0x20, macOffset: 0x6a,
        readCtrLimit: null,
      },
    });
  });
});

// ── AN12196 Table 17 : WriteData CommMode.Full (session Table 14) ───

describe('AN12196 §5.8.2 Table 17 — WriteData NDEF in CommMode.Full', () => {
  const s = session('9D00C4DF', '1309C877509E5A215007FF0ED19CA564', '4C6626F5E72EA694202139295C7A7FC7');
  const ndef = h(
    '0051D1014D550463686F6F73652E75726C2E636F6D2F6E7461673432343F653D3030303030303030303030303030303030303030303030303030303030303030' +
      '26633D30303030303030303030303030303030',
  );
  const cmdData = Buffer.concat([ndef, Buffer.alloc(128 - ndef.length)]); // step 7 : 128 octets
  const encrypted =
    '421C73A27D827658AF481FDFF20A5025B559D0E3AA21E58D347F343CFFC768BFE596C706BC00F2176781D4B0242642A0FF5A42C461AAF894D9A1284B8C76BCFA' +
    '658ACD40555D362E08DB15CF421B51283F9064BCBE20E96CAE545B407C9D651A3315B27373772E5DA2367D2064AE054AF996C6F1F669170FA88CE8C4E3A4A7BB' +
    'BEF0FD971FF532C3A802AF745660F2B4';

  it('steps 8–11: IVc and ciphertext (128-byte data ⇒ one extra 80 00… padding block)', () => {
    expect(H(commandIv(s, 0))).toBe('D2CB7277A17841A06654A48188C1F8F5');
    expect(H(aesCbcEncrypt(s.sesAuthEncKey, commandIv(s, 0), padIso9797M2(cmdData)))).toBe(encrypted);
  });

  it('steps 13–15: MAC and C-APDU (header Length = 800000, as in the step 15 APDU)', () => {
    // Le document écrit « 02 000000 530000 » aux étapes 4 et 12 mais l'APDU
    // (étape 15) porte 800000 ; seul 800000 redonne le CMAC publié.
    expect(H(aesCmac(s.sesAuthMacKey, Buffer.concat([h('8D00009D00C4DF02000000800000'), h(encrypted)])))).toBe(
      'A8D185D964A8E04998965461E7EB3EF3',
    );
    expect(H(aesCmac(s.sesAuthMacKey, Buffer.concat([h('8D00009D00C4DF02000000530000'), h(encrypted)])))).not.toBe(
      'A8D185D964A8E04998965461E7EB3EF3',
    );
    expect(H(buildWriteDataFull(s, 0, 2, 0, cmdData))).toBe(`908D00009F02000000800000${encrypted}D1D9A8499661EBF300`);
  });

  it('steps 16–21: response MACt FC222E5F7A542452 verified (no response data)', () => {
    expect(verifyMacResponse(s, 0, h('FC222E5F7A5424529100')).length).toBe(0);
  });
});

// ── AN12196 Table 18 : ChangeFileSettings avec SDM ──────────────────

describe('AN12196 §5.9 Table 18 — ChangeFileSettings of the NDEF file with SDM', () => {
  const s = session('9D00C4DF', '1309C877509E5A215007FF0ED19CA564', '4C6626F5E72EA694202139295C7A7FC7');

  it('step 7: CmdData from the encoder (FileOption 40, AR 00E0, SDMOptions C1, SDMAR F121, offsets 20/43/43)', () => {
    const settings = encodeFileSettings({
      commMode: 'plain',
      access: { read: 0xe, write: 0x0, readWrite: 0x0, change: 0x0 },
      sdm: { uidMirror: true, readCtrMirror: true, metaRead: 2, fileRead: 1, ctrRet: 1, piccDataOffset: 0x20, macInputOffset: 0x43, macOffset: 0x43 },
    });
    expect(H(settings)).toBe('4000E0C1F121200000430000430000');
  });

  it('steps 8–16: IVc, ciphertext, MACt and C-APDU (CmdCtr = 1)', () => {
    expect(H(commandIv(s, 1))).toBe('3E27082AB2ACC1EF55C57547934E9962');
    expect(H(buildChangeFileSettings(s, 1, 2, h('4000E0C1F121200000430000430000')))).toBe(
      '905F0000190261B6D97903566E84C3AE5274467E89EAD799B7C1A0EF7A0400',
    );
  });

  it('steps 17–22: response MACt 57BFF87B1241E93D verified with CmdCtr+1 = 2', () => {
    expect(decryptFullResponse(s, 1, h('57BFF87B1241E93D9100')).length).toBe(0);
  });
});

// ── AN12196 Table 21 : WriteData CommMode.Full (session Table 19) ───

describe('AN12196 §5.12 Table 21 — WriteData to the proprietary file in CommMode.Full', () => {
  const s = session('7614281A', '7A93D6571E4B180FCA6AC90C9A7488D4', 'FC4AF159B62E549B5812394CAB1918CC');

  it('IVc, C-APDU and response MAC', () => {
    expect(H(commandIv(s, 0))).toBe('4C651A64261A90307B6C293F611C7F7B');
    expect(H(buildWriteDataFull(s, 0, 3, 0, h('0102030405060708090A')))).toBe(
      '908D00001F030000000A00006B5E6804909962FC4E3FF5522CF0F8436C0C53315B9C73AA00',
    );
    expect(verifyMacResponse(s, 0, h('C26D236E4A7C046D9100')).length).toBe(0);
  });
});

// ── AN12196 Tables 25 / 26 : ChangeKey (session Table 23) ───────────

describe('AN12196 §5.16 — ChangeKey', () => {
  const s = session('7614281A', '4CF3CB41A22583A61E89B158D252FC53', '5529860B2FC5FB6154B7F28361D30BF9');

  it('Table 25 step 7: CRC32NK(NewKey) = 789DFADC (JAMCRC, LSB first)', () => {
    expect(H(crc32Nk(h('F3847D627727ED3BC9C4CC050489B966')))).toBe('789DFADC');
  });

  it('Table 25 (case 1, key 2 ≠ auth key 0): KeyData, IVe, C-APDU', () => {
    const params = { keyNo: 2, authKeyNo: 0, newKey: h('F3847D627727ED3BC9C4CC050489B966'), newKeyVersion: 1, oldKey: ZERO_KEY };
    expect(H(padIso9797M2(changeKeyData(params)))).toBe('F3847D627727ED3BC9C4CC050489B96601789DFADC8000000000000000000000');
    expect(H(commandIv(s, 2))).toBe('307EDE1814707F30CFE603DD6CA62353');
    expect(H(buildChangeKey(s, 2, params))).toBe(
      '90C4000029022CF362B7BF4311FF3BE1DAA295E8C68DE09050560D19B9E16C2393AE9CD1FAC75D0CE20BCD1D06E600',
    );
  });

  it('Table 25 step 20: the published R-APDU 203BB55D1089D587 9100 carries a valid response MAC (CmdCtr+1 = 3)', () => {
    expect(verifyMacResponse(s, 2, h('203BB55D1089D5879100')).length).toBe(0);
  });

  it('Table 26 (case 2, key 0 = auth key): IVc and C-APDU (no XOR, no CRC)', () => {
    const params = { keyNo: 0, authKeyNo: 0, newKey: h('5004BF991F408672B1EF00F08F9E8647'), newKeyVersion: 1, oldKey: null };
    // Étape 11 : NewKey || KeyVer || 80 00… (32 octets).
    expect(H(padIso9797M2(changeKeyData(params)))).toBe(`5004BF991F408672B1EF00F08F9E8647${'01'}${'80'}${'00'.repeat(14)}`);
    expect(H(commandIv(s, 3))).toBe('01602D579423B2797BE8B478B0B4D27B');
    expect(H(buildChangeKey(s, 3, params))).toBe(
      '90C400002900C0EB4DEEFEDDF0B513A03A95A75491818580503190D4D05053FF75668A01D6FDA6610234BDED643200',
    );
  });

  it('ChangeKey of a non-auth key without the old key, or with auth key ≠ 0, is refused', () => {
    expect(() => changeKeyData({ keyNo: 1, authKeyNo: 0, newKey: ZERO_KEY, newKeyVersion: 1, oldKey: null })).toThrow(/old/);
    expect(() => changeKeyData({ keyNo: 1, authKeyNo: 2, newKey: ZERO_KEY, newKeyVersion: 1, oldKey: ZERO_KEY })).toThrow(/key 0/);
  });
});

// ── AN12196 Table 27 : SetConfiguration (secure messaging générique) ─

describe('AN12196 §6.2 Table 27 — CommMode.Full generic path (SetConfiguration)', () => {
  it('IVc, C-APDU and response MAC', () => {
    const s = session('D779B1D0', '7951A705F47F3C29B596454DC1490383', 'FE4EDBF46536557E304682F33E63A84F');
    expect(H(commandIv(s, 0))).toBe('FEFB918047F385563FA8356DE86E5182');
    expect(H(buildFullCommand(s, 0, 0x5c, h('00'), h('02')))).toBe('905C000019008EA0138A7AF6FC8E99DF2A3A305602C43A7A3C9228C3134A00');
    expect(verifyMacResponse(s, 0, h('86044208CAD1676A9100')).length).toBe(0);
  });
});

// ── AN12196 Table 28 : GetCardUID ───────────────────────────────────

describe('AN12196 §6.3 Table 28 — GetCardUID in CommMode.Full', () => {
  const s = session('DF055522', '2B4D963C014DC36F24F69A50A394F875', '379D32130CE61705DD5FD8C36B95D764');
  const rapdu = h('70756055688505B52A5E26E59E329CD6595F672298EA41B79100');

  it('C-APDU carries only the MAC (no command data to encrypt)', () => {
    expect(H(aesCmac(s.sesAuthMacKey, h('510000DF055522')))).toBe('CC8E8C2CD015945AFDDD7DA9B19BB9E3');
    expect(H(buildGetCardUid(s, 0))).toBe('90510000088E2C155ADDA99BE300');
  });

  it('IVr with CmdCtr+1 and decrypted UID 04958CAA5C5E80', () => {
    expect(H(responseIv(s, 0))).toBe('7F6BB0B278EA054CBD238C5D9E9E342B');
    expect(H(parseGetCardUidResponse(s, 0, rapdu))).toBe('04958CAA5C5E80');
  });

  it('a tampered ciphertext is rejected before decryption', () => {
    const tampered = Buffer.from(rapdu);
    tampered[0] = (tampered[0] ?? 0) ^ 0x01;
    expect(() => parseGetCardUidResponse(s, 0, tampered)).toThrow(/MAC mismatch/);
  });
});

// ── Utilitaires ─────────────────────────────────────────────────────

describe('helpers', () => {
  it('ISO 9797-1 M2 padding always adds 80h and round-trips', () => {
    expect(H(padIso9797M2(h('01')))).toBe('01800000000000000000000000000000');
    expect(padIso9797M2(Buffer.alloc(16)).length).toBe(32);
    expect(H(unpadIso9797M2(padIso9797M2(h('0102'))))).toBe('0102');
    expect(() => unpadIso9797M2(Buffer.alloc(16))).toThrow(Ntag424Error);
  });

  it('expectStatus reports the status name', () => {
    expect(() => expectStatus(h('91AE'), 0x9100, 'ctx')).toThrow(/AUTHENTICATION_ERROR/);
  });

  it('encodeFileSettings refuses overlapping mirrors and MAC input after the MAC', () => {
    const base = { commMode: 'plain' as const, access: { read: 0xe, write: 0, readWrite: 0, change: 0 } };
    const sdm = { uidMirror: true, readCtrMirror: true, metaRead: 1, fileRead: 2, ctrRet: 0xf, piccDataOffset: 20, macInputOffset: 55, macOffset: 55 };
    expect(() => encodeFileSettings({ ...base, sdm: { ...sdm, macOffset: 40, macInputOffset: 40 } })).toThrow(/overlap/);
    expect(() => encodeFileSettings({ ...base, sdm: { ...sdm, macInputOffset: 56 } })).toThrow(/SDMMACInputOffset/);
    expect(() => encodeFileSettings({ ...base, sdm: { ...sdm, macOffset: 241, macInputOffset: 241 } })).toThrow(/bounds/);
  });
});
