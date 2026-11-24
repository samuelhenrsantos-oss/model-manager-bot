import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { saveSession, getSession, touchSession, deleteSession, cleanupExpiredSessions, discardOrphanPhoto } from '../src/services/sessions.js';
import { createFakeDb } from './helpers/fakeDb.js';
import { KEY, seedGuild, seedModel } from './helpers/fixtures.js';
import { GUILD, OTHER_GUILD } from './helpers/fakeDiscord.js';

const TTL = 30 * 60 * 1000;

test('sessão persiste CIFRADA e é recuperada apenas pelo dono', async () => {
  const db = createFakeDb(); seedGuild(db);
  await saveSession(db, KEY, { guildId: GUILD, userId: 'u1', photoPath: 'g/p.jpg', data: { name: 'Ana', gmail_password: 'SEGREDO-123' } }, TTL);
  const raw = JSON.stringify(db.tables.registration_sessions);
  assert.ok(!raw.includes('SEGREDO-123') && !raw.includes('Ana'));
  const s = await getSession(db, KEY, GUILD, 'u1');
  assert.equal(s.data.gmail_password, 'SEGREDO-123'); assert.equal(s.photoPath, 'g/p.jpg');
  assert.equal(await getSession(db, KEY, GUILD, 'outro-usuario'), null);
  assert.equal(await getSession(db, KEY, OTHER_GUILD, 'u1'), null);
});
test('retomada: dados salvos sobrevivem a "reinício" (nova leitura do banco) e touch renova a validade', async () => {
  const db = createFakeDb(); seedGuild(db);
  await saveSession(db, KEY, { guildId: GUILD, userId: 'u1', photoPath: 'p', data: { name: 'A' } }, 60_000);
  const first = await getSession(db, KEY, GUILD, 'u1');
  first.data.stage_name = 'B';
  await touchSession(db, KEY, first, TTL);
  const again = await getSession(db, KEY, GUILD, 'u1');
  assert.deepEqual(again.data, { name: 'A', stage_name: 'B' });
  assert.ok(new Date(again.expiresAt).getTime() - Date.now() > 10 * 60_000);
});
test('sessão expirada é tratada como inexistente', async () => {
  const db = createFakeDb(); seedGuild(db);
  await saveSession(db, KEY, { guildId: GUILD, userId: 'u1', photoPath: 'p', data: {} }, TTL);
  db.tables.registration_sessions[0].expires_at = new Date(Date.now() - 1000).toISOString();
  assert.equal(await getSession(db, KEY, GUILD, 'u1'), null);
});
test('sessão ilegível (chave diferente) não quebra: retorna null', async () => {
  const db = createFakeDb(); seedGuild(db);
  await saveSession(db, randomBytes(32), { guildId: GUILD, userId: 'u1', photoPath: 'p', data: { a: 1 } }, TTL);
  assert.equal(await getSession(db, KEY, GUILD, 'u1'), null);
});
test('nova sessão substitui a anterior e devolve a foto antiga para limpeza (uma sessão por usuário)', async () => {
  const db = createFakeDb(); seedGuild(db);
  assert.equal(await saveSession(db, KEY, { guildId: GUILD, userId: 'u1', photoPath: 'velha', data: {} }, TTL), null);
  assert.equal(await saveSession(db, KEY, { guildId: GUILD, userId: 'u1', photoPath: 'nova', data: {} }, TTL), 'velha');
  assert.equal(db.tables.registration_sessions.length, 1);
});
test('limpeza: remove expiradas e suas fotos, preserva ativas e fotos já usadas por modelos', async () => {
  const db = createFakeDb(); seedGuild(db);
  const used = await seedModel(db);
  db.files.set('model-photos/g/orfa.jpg', Buffer.from('o')); db.files.set('model-photos/g/ativa.jpg', Buffer.from('a'));
  await saveSession(db, KEY, { guildId: GUILD, userId: 'u1', photoPath: 'g/orfa.jpg', data: {} }, TTL);
  await saveSession(db, KEY, { guildId: GUILD, userId: 'u2', photoPath: used.photo_path, data: {} }, TTL);
  await saveSession(db, KEY, { guildId: GUILD, userId: 'u3', photoPath: 'g/ativa.jpg', data: {} }, TTL);
  for (const r of db.tables.registration_sessions.filter((x) => x.user_id !== 'u3')) r.expires_at = new Date(Date.now() - 1000).toISOString();
  assert.equal(await cleanupExpiredSessions(db, 'model-photos'), 2);
  assert.ok(!db.files.has('model-photos/g/orfa.jpg'));
  assert.ok(db.files.has(`model-photos/${used.photo_path}`)); // foto de modelo existente intacta
  assert.ok(db.files.has('model-photos/g/ativa.jpg'));
  assert.equal(db.tables.registration_sessions.length, 1);
});
test('deleteSession / discardOrphanPhoto / erros do banco', async () => {
  const db = createFakeDb(); seedGuild(db);
  await saveSession(db, KEY, { guildId: GUILD, userId: 'u1', photoPath: 'p', data: {} }, TTL);
  const s = await getSession(db, KEY, GUILD, 'u1');
  await deleteSession(db, s.id); assert.equal(db.tables.registration_sessions.length, 0);
  assert.equal(await discardOrphanPhoto(db, 'model-photos', null), false);
  db.failNext('registration_sessions', 'delete');
  await assert.rejects(cleanupExpiredSessions(db, 'model-photos'));
});
