/**
 * Simulateur de tag NTAG 424 DNA (tests uniquement) : produit les paramètres
 * `e` / `c` qu'un vrai tag mettrait dans l'URL SUN (hex majuscule).
 *
 * Volontairement indépendant de backend/nfc/sdm.ts (SV2, MACt et chiffrement
 * réécrits ici) : seule la primitive AES-CMAC est partagée, elle-même
 * validée par les vecteurs RFC 4493. Les vecteurs NXP valident la spec.
 */

import { createCipheriv, randomBytes } from 'node:crypto';
import { aesCmac } from '../../backend/nfc/aes-cmac.js';

const PICC_DATA_TAG_UID_CTR_7 = 0xc7;

export function simulateSunUrlParams(opts: {
  sdmMetaReadKey: Buffer;
  sdmFileReadKey: Buffer;
  uid: Buffer;
  readCtr: number;
  padding?: Buffer;
}): { e: string; c: string } {
  const { sdmMetaReadKey, sdmFileReadKey, uid, readCtr } = opts;
  const padding = opts.padding ?? randomBytes(5);
  if (uid.length !== 7) throw new TypeError('sim: uid must be 7 bytes');
  if (padding.length !== 5) throw new TypeError('sim: padding must be 5 bytes');
  if (!Number.isInteger(readCtr) || readCtr < 0 || readCtr > 0xffffff) {
    throw new TypeError('sim: readCtr out of range');
  }

  const ctrLsb = Buffer.from([readCtr & 0xff, (readCtr >>> 8) & 0xff, (readCtr >>> 16) & 0xff]);

  // PICCENCData = AES-128-CBC(SDMMetaReadKey, IV 0) du bloc PICCData.
  const plain = Buffer.concat([Buffer.from([PICC_DATA_TAG_UID_CTR_7]), uid, ctrLsb, padding]);
  const cipher = createCipheriv('aes-128-cbc', sdmMetaReadKey, Buffer.alloc(16));
  cipher.setAutoPadding(false);
  const piccEnc = Buffer.concat([cipher.update(plain), cipher.final()]);

  // SDMMAC : session key via SV2, CMAC d'un macInput vide, puis octets impairs.
  const sv2 = Buffer.concat([Buffer.from('3CC300010080', 'hex'), uid, ctrLsb]);
  const sessionKey = aesCmac(sdmFileReadKey, sv2);
  const fullMac = aesCmac(sessionKey, Buffer.alloc(0));
  const mac = Buffer.from([1, 3, 5, 7, 9, 11, 13, 15].map((i) => fullMac[i] ?? 0));

  return {
    e: piccEnc.toString('hex').toUpperCase(),
    c: mac.toString('hex').toUpperCase(),
  };
}
