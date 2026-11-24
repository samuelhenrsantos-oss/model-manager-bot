import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Chave AES deve ter 32 bytes.');
}

/** Formato: base64(iv).base64(tag).base64(ciphertext) — compatível com os dados já gravados. */
export function encryptSecret(plainText, key) {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString('base64')).join('.');
}

export function decryptSecret(payload, key) {
  assertKey(key);
  const parts = String(payload).split('.');
  if (parts.length !== 3) throw new Error('Formato de segredo inválido.');
  const [iv64, tag64, data64] = parts;
  const iv = Buffer.from(iv64, 'base64');
  const tag = Buffer.from(tag64, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Formato de segredo inválido.');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(data64, 'base64')), decipher.final()]).toString('utf8');
}

export const encryptJson = (value, key) => encryptSecret(JSON.stringify(value), key);
export const decryptJson = (payload, key) => JSON.parse(decryptSecret(payload, key));
