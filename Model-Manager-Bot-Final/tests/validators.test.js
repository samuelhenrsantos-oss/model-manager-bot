import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelId, cleanUrl, cleanGmail, cleanEmail, cleanText, validateEdit, cleanPassword, isUuid } from '../src/utils/validators.js';
import { UserError } from '../src/utils/errors.js';
import { truncate, display, escapeText, LIMITS } from '../src/utils/text.js';

const UUID = '3f2b8c1e-5a4d-4e6f-9a1b-0c2d3e4f5a6b';

test('parseModelId: público, UUID e inválidos', () => {
  assert.deepEqual(parseModelId('12'), { kind: 'public', value: 12 });
  assert.deepEqual(parseModelId('#7'), { kind: 'public', value: 7 });
  assert.deepEqual(parseModelId(UUID.toUpperCase()), { kind: 'uuid', value: UUID });
  for (const bad of ['', 'abc', '0', '-1', '1.5', '99999999999999999999', "1'; drop table models;--", UUID + 'x', 'null']) {
    assert.equal(parseModelId(bad), null, bad);
  }
  assert.ok(isUuid(UUID) && !isUuid('xyz'));
});
test('cleanUrl: http(s), sem credenciais, domínio da plataforma', () => {
  assert.equal(cleanUrl('https://www.instagram.com/user', { platform: 'instagram' }), 'https://www.instagram.com/user');
  assert.equal(cleanUrl('https://vm.tiktok.com/abc', { platform: 'tiktok' }), 'https://vm.tiktok.com/abc');
  for (const bad of ['javascript:alert(1)', 'ftp://x.com', 'https://user:pass@instagram.com/x', 'não-url', 'https://evil.com/instagram.com', 'https://notinstagram.com/x']) {
    assert.throws(() => cleanUrl(bad, { platform: 'instagram' }), UserError, bad);
  }
  assert.throws(() => cleanUrl('https://instagram.com/' + 'a'.repeat(400), { platform: 'instagram' }), /excede/);
  assert.equal(cleanUrl('https://qualquer.com/x'), 'https://qualquer.com/x');
});
test('cleanGmail / cleanEmail', () => {
  assert.equal(cleanGmail('  Pessoa@Gmail.com '), 'pessoa@gmail.com');
  assert.throws(() => cleanGmail('pessoa@outlook.com'), /Gmail/);
  assert.throws(() => cleanGmail('sem-arroba'), UserError);
  assert.throws(() => cleanEmail('a b@c.com'), UserError);
  assert.equal(cleanEmail('x@empresa.com.br'), 'x@empresa.com.br');
});
test('cleanText: obrigatório, limite e caracteres de controle', () => {
  assert.throws(() => cleanText('   ', { max: 10, label: 'Nome' }), /obrigatório/);
  assert.throws(() => cleanText('a'.repeat(11), { max: 10, label: 'Nome' }), /excede/);
  assert.equal(cleanText('a\u0000b', { max: 10, label: 'Nome' }), 'ab');
  assert.equal(cleanText('', { max: 10, label: 'Obs', required: false }), '');
});
test('validateEdit: apenas campos permitidos (sem photo_path/is_featured/id)', () => {
  assert.equal(validateEdit('name', ' Ana '), 'Ana');
  assert.equal(validateEdit('observations', ''), null);
  for (const f of ['photo_path', 'is_featured', 'id', 'guild_id', 'gmail_password', '__proto__', 'constructor', 'toString']) {
    assert.throws(() => validateEdit(f, 'x'), /não editável/, f);
  }
  assert.throws(() => validateEdit('tiktok_link', 'https://instagram.com/x'), UserError);
});
test('cleanPassword não altera o valor (sem trim) e recusa vazio/longo', () => {
  assert.equal(cleanPassword(' abc '), ' abc ');
  assert.throws(() => cleanPassword('   '), UserError);
  assert.throws(() => cleanPassword('x'.repeat(257)), UserError);
});
test('utilitários de texto respeitam limites do Discord', () => {
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abc', 4), 'abc');
  assert.equal(display('', 20), 'Não informado');
  assert.ok(display('x'.repeat(5000), LIMITS.fieldValue).length <= LIMITS.fieldValue);
  assert.equal(escapeText('**@everyone** _x_'), '\\*\\*@everyone\\*\\* \\_x\\_');
});
