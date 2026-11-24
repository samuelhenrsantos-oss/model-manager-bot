import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encryptSecret, decryptSecret, encryptJson, decryptJson } from '../src/security/crypto.js';

test('AES-256-GCM cifra e decifra', () => {
  const key = randomBytes(32), value = 'senha-de-teste-!@#ção';
  const encrypted = encryptSecret(value, key);
  assert.notEqual(encrypted, value);
  assert.ok(!encrypted.includes(value));
  assert.equal(decryptSecret(encrypted, key), value);
});
test('cada cifragem usa IV diferente', () => {
  const key = randomBytes(32);
  assert.notEqual(encryptSecret('x', key), encryptSecret('x', key));
});
test('AES-256-GCM detecta adulteração do texto cifrado', () => {
  const key = randomBytes(32), encrypted = encryptSecret('segredo', key);
  const [iv, tag, data] = encrypted.split('.');
  const changed = Buffer.from(data, 'base64'); changed[0] ^= 1;
  assert.throws(() => decryptSecret([iv, tag, changed.toString('base64')].join('.'), key));
});
test('chave errada não decifra', () => {
  const encrypted = encryptSecret('segredo', randomBytes(32));
  assert.throws(() => decryptSecret(encrypted, randomBytes(32)));
});
test('rejeita chave com tamanho inválido e formato inválido', () => {
  assert.throws(() => encryptSecret('x', Buffer.alloc(16)), /32 bytes/);
  assert.throws(() => encryptSecret('x', 'string'), /32 bytes/);
  const key = randomBytes(32);
  assert.throws(() => decryptSecret('abc', key), /inválido/);
  assert.throws(() => decryptSecret('a.b.c', key), /inválido/);
});
test('senha vazia e unicode round-trip; JSON round-trip', () => {
  const key = randomBytes(32);
  assert.equal(decryptSecret(encryptSecret('', key), key), '');
  const obj = { data: { gmail_password: 'p@ss"\\\n', n: 1 } };
  assert.deepEqual(decryptJson(encryptJson(obj, key), key), obj);
});
