import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEnv, validateDiscordEnv } from '../src/config/env.js';

const base = () => ({
  DISCORD_TOKEN: 'tok', DISCORD_CLIENT_ID: '123456789012345678',
  SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc', MASTER_KEY: 'a'.repeat(64)
});

test('configuração mínima válida e valores padrão', () => {
  const c = validateEnv(base());
  assert.equal(c.bucket, 'model-photos');
  assert.equal(c.maxImageBytes, 8 * 1024 * 1024);
  assert.equal(c.sessionTtlMs, 30 * 60 * 1000);
  assert.equal(c.masterKey.length, 32);
  assert.deepEqual(c.adminRoleIds, []);
  assert.ok(Object.isFrozen(c));
});
test('variáveis obrigatórias ausentes', () => {
  assert.throws(() => validateEnv({}), /ausentes: DISCORD_TOKEN/);
  const e = base(); delete e.MASTER_KEY;
  assert.throws(() => validateEnv(e), /MASTER_KEY/);
});
test('MASTER_KEY precisa de 64 hex', () => {
  assert.throws(() => validateEnv({ ...base(), MASTER_KEY: 'abc' }), /64 caracteres/);
  assert.throws(() => validateEnv({ ...base(), MASTER_KEY: 'z'.repeat(64) }), /64 caracteres/);
});
test('SUPABASE_URL exige https (http só em localhost)', () => {
  assert.throws(() => validateEnv({ ...base(), SUPABASE_URL: 'http://evil.example.com' }), /HTTPS/);
  assert.doesNotThrow(() => validateEnv({ ...base(), SUPABASE_URL: 'http://localhost:54321' }));
  assert.throws(() => validateEnv({ ...base(), SUPABASE_URL: 'não é url' }), /inválida/);
});
test('valores numéricos inválidos são recusados (sem NaN)', () => {
  assert.throws(() => validateEnv({ ...base(), MAX_IMAGE_MB: 'abc' }), /MAX_IMAGE_MB/);
  assert.throws(() => validateEnv({ ...base(), SESSION_TTL_MINUTES: '1' }), /SESSION_TTL_MINUTES/);
  assert.equal(validateEnv({ ...base(), SESSION_TTL_MINUTES: '60' }).sessionTtlMs, 3_600_000);
});
test('listas de IDs administrativos validadas', () => {
  const c = validateEnv({ ...base(), ADMIN_ROLE_IDS: '123456789012345678, 223456789012345678', ADMIN_USER_IDS: '323456789012345678' });
  assert.equal(c.adminRoleIds.length, 2);
  assert.throws(() => validateEnv({ ...base(), ADMIN_ROLE_IDS: 'abc' }), /ADMIN_ROLE_IDS/);
  assert.throws(() => validateEnv({ ...base(), DISCORD_CLIENT_ID: 'x' }), /CLIENT_ID/);
  assert.throws(() => validateEnv({ ...base(), LOG_LEVEL: 'verbose' }), /LOG_LEVEL/);
});
test('validateDiscordEnv exige só o necessário para registrar comandos', () => {
  assert.throws(() => validateDiscordEnv({}), /DISCORD_TOKEN, DISCORD_CLIENT_ID/);
  assert.throws(() => validateDiscordEnv({ DISCORD_TOKEN: 't', DISCORD_CLIENT_ID: 'x' }), /CLIENT_ID/);
  const c = validateDiscordEnv({ DISCORD_TOKEN: 't', DISCORD_CLIENT_ID: '123456789012345678', DISCORD_GUILD_ID: '223456789012345678' });
  assert.equal(c.discordGuildId, '223456789012345678'); assert.equal(c.externalTimeoutMs, 20000);
});
