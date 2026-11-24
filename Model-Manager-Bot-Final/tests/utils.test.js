import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/utils/ratelimit.js';
import { redact, describeError } from '../src/utils/logger.js';
import { sanitizeMetadata, auditContext, audit } from '../src/services/audit.js';
import { UserError, isDeadInteractionError, userMessage, GENERIC_ERROR_MESSAGE } from '../src/utils/errors.js';
import { createFakeDb } from './helpers/fakeDb.js';

test('RateLimiter: bloqueia após o limite e libera depois da janela', () => {
  let now = 0;
  const rl = new RateLimiter({ limit: 2, windowMs: 1000, now: () => now });
  assert.ok(rl.check('u').ok); assert.ok(rl.check('u').ok);
  const blocked = rl.check('u');
  assert.equal(blocked.ok, false); assert.ok(blocked.retryAfterMs > 0);
  assert.ok(rl.check('outro').ok);
  now = 1500;
  assert.ok(rl.check('u').ok);
  rl.sweep(); now = 5000; rl.sweep(); assert.equal(rl.hits.size, 0);
});
test('logger: redige tokens, JWT, chave hex e senhas', () => {
  const discord = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.GabcDE.' + 'x'.repeat(30);
  assert.ok(!redact(`falha ${discord}`).includes(discord));
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.abcdefghijk';
  assert.ok(!redact(jwt).includes('eyJhbGci'));
  assert.ok(!redact('chave ' + 'ab'.repeat(32)).includes('abab'));
  assert.ok(!redact('password: hunter2').includes('hunter2'));
  assert.ok(!redact('{"senha":"abc123"}').includes('abc123'));
});
test('logger: describeError lida com Error, objeto e string', () => {
  assert.match(describeError(new Error('boom')), /Error: boom/);
  assert.match(describeError({ code: '23505', message: 'dup' }), /23505 \| dup/);
  assert.equal(describeError(null), '');
  assert.ok(!describeError({ message: 'senha=abc' }).includes('abc'));
});
test('audit: sanitizeMetadata remove chaves sensíveis e limita tamanho', () => {
  const m = sanitizeMetadata({ field: 'name', gmail_password: 'x', token: 'y', secret_value: 'z', n: 1, ok: true, big: 'a'.repeat(500), arr: ['a', 'b'], obj: { a: 1 } });
  assert.deepEqual(Object.keys(m).sort(), ['arr', 'big', 'field', 'n', 'ok']);
  assert.equal(m.big.length, 200);
  assert.deepEqual(sanitizeMetadata(null), {}); assert.deepEqual(sanitizeMetadata([1]), {});
});
test('audit: contexto independente do tipo de interação e falha opcional/obrigatória', async () => {
  const db = createFakeDb();
  const ctx = auditContext({ guildId: 'g', user: { id: 'u', tag: 't' } });
  assert.deepEqual(ctx, { guildId: 'g', actor: { id: 'u', tag: 't' } });
  await audit(db, ctx, 'x', null, { field: 'a', password: 'nao' });
  assert.equal(db.tables.audit_logs.length, 1);
  assert.deepEqual(db.tables.audit_logs[0].metadata, { field: 'a' });
  db.failNext('audit_logs', 'insert');
  await audit(db, ctx, 'x'); // best effort: não lança
  db.failNext('audit_logs', 'insert');
  await assert.rejects(audit(db, ctx, 'x', null, {}, { required: true }));
});
test('errors: UserError é exibido, demais viram mensagem genérica', () => {
  assert.equal(userMessage(new UserError('ok')), 'ok');
  assert.equal(userMessage(new Error('segredo interno')), GENERIC_ERROR_MESSAGE);
  assert.equal(userMessage({ code: 'PGRST', message: 'detalhe' }), GENERIC_ERROR_MESSAGE);
  assert.ok(isDeadInteractionError({ code: 10062 }) && isDeadInteractionError({ code: 40060 }) && !isDeadInteractionError({ code: 1 }));
});
