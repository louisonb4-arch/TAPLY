/**
 * AES-128-CMAC (RFC 4493 / NIST SP 800-38B).
 *
 * Primitive AES fournie par node:crypto (OpenSSL) — aucun AES maison.
 * Seule la construction CMAC (sous-clés K1/K2, padding 0x80 00..) est ici.
 * Utilisé par la vérification SUN/SDM des tags NTAG 424 DNA (voir sdm.ts).
 */

import { createCipheriv } from 'node:crypto';

const BLOCK_SIZE = 16;
const KEY_SIZE = 16;
const RB = 0x87; // constante Rb pour un bloc de 128 bits
const ZERO_BLOCK = Buffer.alloc(BLOCK_SIZE);

function assertBytes(value: unknown, name: string): asserts value is Buffer {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${name} must be a Buffer`);
  }
}

/** AES-128-CBC, IV nul, sans padding : retourne le dernier bloc chiffré. */
function cbcMacLastBlock(key: Buffer, data: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-cbc', key, ZERO_BLOCK);
  cipher.setAutoPadding(false);
  const out = Buffer.concat([cipher.update(data), cipher.final()]);
  return out.subarray(out.length - BLOCK_SIZE);
}

/** Décalage à gauche de 1 bit sur 128 bits + XOR Rb si le MSB était à 1. */
function doubleBlock(block: Buffer): Buffer {
  const out = Buffer.alloc(BLOCK_SIZE);
  let carry = 0;
  for (let i = BLOCK_SIZE - 1; i >= 0; i--) {
    const byte = block[i] ?? 0;
    out[i] = ((byte << 1) | carry) & 0xff;
    carry = byte >>> 7;
  }
  if ((block[0] ?? 0) & 0x80) {
    out[BLOCK_SIZE - 1] = (out[BLOCK_SIZE - 1] ?? 0) ^ RB;
  }
  return out;
}

function xorInto(target: Buffer, offset: number, mask: Buffer): void {
  for (let i = 0; i < BLOCK_SIZE; i++) {
    target[offset + i] = (target[offset + i] ?? 0) ^ (mask[i] ?? 0);
  }
}

/**
 * AES-128-CMAC(key, message) → tag de 16 octets.
 * @throws TypeError si la clé ne fait pas exactement 16 octets.
 */
export function aesCmac(key: Buffer, message: Buffer): Buffer {
  assertBytes(key, 'key');
  assertBytes(message, 'message');
  if (key.length !== KEY_SIZE) {
    throw new TypeError(`AES-CMAC key must be ${KEY_SIZE} bytes, got ${key.length}`);
  }

  // Sous-clés (RFC 4493 §2.3).
  const l = cbcMacLastBlock(key, ZERO_BLOCK);
  const k1 = doubleBlock(l);
  const k2 = doubleBlock(k1);

  // Nombre de blocs ; un message vide compte pour un bloc incomplet.
  const blockCount = Math.max(1, Math.ceil(message.length / BLOCK_SIZE));
  const lastComplete = message.length > 0 && message.length % BLOCK_SIZE === 0;

  // Copie : le message de l'appelant n'est jamais modifié.
  const prepared = Buffer.alloc(blockCount * BLOCK_SIZE);
  Buffer.from(message.buffer, message.byteOffset, message.length).copy(prepared);
  const lastOffset = (blockCount - 1) * BLOCK_SIZE;

  if (lastComplete) {
    xorInto(prepared, lastOffset, k1);
  } else {
    prepared[message.length] = 0x80; // padding 10*
    xorInto(prepared, lastOffset, k2);
  }

  // CBC-MAC avec IV nul sur M_1..M_{n-1} || M_last.
  return cbcMacLastBlock(key, prepared);
}
