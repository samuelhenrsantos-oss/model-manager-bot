import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel, getModel, requireModel, searchModels, listModels, updateModel, getSecrets, updateSecrets, deleteModel, escapeLike, setFeaturedFlag } from '../src/services/models.js';
import { decryptSecret } from '../src/security/crypto.js';
import { UserError } from '../src/utils/errors.js';
import { createFakeDb } from './helpers/fakeDb.js';
import { KEY, validData, seedGuild, seedModel } from './helpers/fixtures.js';
import { GUILD, OTHER_GUILD } from './helpers/fakeDiscord.js';

const actor = { id: 'u1', tag: 'tester#1' };

test('createModel: salva modelo e senhas CRIPTOGRAFADAS (nunca em texto puro)', async () => {
  const db = createFakeDb(); seedGuild(db);
  const m = await createModel(db, KEY, GUILD, actor, validData(), `${GUILD}/x.jpg`);
  assert.equal(m.guild_id, GUILD); assert.ok(m.public_id);
  const s = db.tables.model_secrets[0];
  assert.equal(s.model_id, m.id);
  for (const p of ['gmail', 'facebook', 'tiktok', 'instagram']) {
    assert.notEqual(s[`${p}_password`], validData()[`${p}_password`]);
    assert.equal(decryptSecret(s[`${p}_password`], KEY), validData()[`${p}_password`]);
  }
  assert.ok(!JSON.stringify(m).includes('pass'));
  assert.equal(db.tables.audit_logs[0].action, 'model_created');
  assert.equal(db.tables.audit_logs[0].actor_id, 'u1'); // contexto de auditoria correto
});
test('createModel: falha nos segredos desfaz a modelo (sem registro parcial)', async () => {
  const db = createFakeDb(); seedGuild(db);
  db.failNext('model_secrets', 'insert');
  await assert.rejects(createModel(db, KEY, GUILD, actor, validData(), 'p.jpg'));
  assert.equal(db.tables.models.length, 0);
});
test('createModel: falha ao inserir modelo não grava segredos; chave inválida não grava nada', async () => {
  const db = createFakeDb(); seedGuild(db);
  db.failNext('models', 'insert');
  await assert.rejects(createModel(db, KEY, GUILD, actor, validData(), 'p.jpg'));
  assert.equal(db.tables.model_secrets.length, 0);
  await assert.rejects(createModel(db, Buffer.alloc(5), GUILD, actor, validData(), 'p.jpg'), /32 bytes/);
  assert.equal(db.tables.models.length, 0);
});
test('getModel: ID inválido -> UserError; inexistente -> null; isolado por servidor', async () => {
  const db = createFakeDb(); seedGuild(db);
  const m = await seedModel(db);
  await assert.rejects(getModel(db, GUILD, "1'; drop table models;--"), UserError);
  await assert.rejects(getModel(db, GUILD, ''), UserError);
  assert.equal(await getModel(db, GUILD, '9999'), null);
  assert.equal((await getModel(db, GUILD, String(m.public_id))).id, m.id);
  assert.equal((await getModel(db, GUILD, m.id)).id, m.id);
  assert.equal(await getModel(db, OTHER_GUILD, m.id), null);
  await assert.rejects(requireModel(db, GUILD, '9999'), /não encontrada/);
});
test('searchModels: curingas escapados, termos maliciosos inofensivos, limites', async () => {
  const db = createFakeDb(); seedGuild(db);
  await seedModel(db, { name: 'Maria 100%', stage_name: 'M' });
  await seedModel(db, { name: 'Mario', stage_name: 'Mar', tiktok_nick: '@x_y' });
  await seedModel(db, { name: 'Outra', stage_name: 'O' });
  assert.equal(escapeLike('a%b_c\\'), 'a\\%b\\_c\\\\');
  assert.equal((await searchModels(db, GUILD, 'mari')).length, 2);
  assert.equal((await searchModels(db, GUILD, '100%')).length, 1);
  assert.equal((await searchModels(db, GUILD, '%')).length, 1); // '%' literal, não curinga
  assert.equal((await searchModels(db, GUILD, '_')).length, 1); // só o nick com underscore
  for (const evil of ["x'),name.ilike.%", 'a,b.eq.c', '*', '\\', ')(,.']) {
    const r = await searchModels(db, GUILD, evil); assert.ok(Array.isArray(r));
  }
  assert.equal((await searchModels(db, GUILD, 'outra')).length, 1);
  await assert.rejects(searchModels(db, GUILD, '   '), UserError);
  await assert.rejects(searchModels(db, GUILD, 'a'.repeat(65)), UserError);
  const byId = await searchModels(db, GUILD, '1'); assert.ok(byId.some((m) => m.public_id === 1));
  assert.equal((await searchModels(db, OTHER_GUILD, 'mari')).length, 0);
});
test('listModels: paginação, página inválida/além do fim, filtro de destaques', async () => {
  const db = createFakeDb(); seedGuild(db);
  for (let i = 0; i < 20; i++) await seedModel(db, { is_featured: i % 5 === 0 });
  const p1 = await listModels(db, GUILD, 1);
  assert.equal(p1.data.length, 8); assert.equal(p1.count, 20); assert.equal(p1.pages, 3);
  assert.equal((await listModels(db, GUILD, 3)).data.length, 4);
  const beyond = await listModels(db, GUILD, 99); assert.equal(beyond.page, 3); assert.equal(beyond.data.length, 4);
  for (const bad of [NaN, 'abc', -5, 0, undefined, 1.7]) assert.ok((await listModels(db, GUILD, bad)).page >= 1);
  const f = await listModels(db, GUILD, 1, true); assert.equal(f.count, 4);
  const empty = await listModels(db, OTHER_GUILD, 1); assert.equal(empty.pages, 1); assert.equal(empty.data.length, 0);
});
test('updateModel: só campos permitidos; inexistente -> UserError; erro do banco propaga', async () => {
  const db = createFakeDb(); seedGuild(db);
  const m = await seedModel(db);
  const u = await updateModel(db, GUILD, m.id, { name: 'Novo', id: 'hack', guild_id: 'x', is_featured: true, created_by: 'x' });
  assert.equal(u.name, 'Novo'); assert.equal(u.is_featured, false); assert.equal(u.guild_id, GUILD); assert.equal(u.created_by, 'u1');
  await assert.rejects(updateModel(db, GUILD, m.id, { id: 'x' }), /Nenhum campo/);
  await assert.rejects(updateModel(db, OTHER_GUILD, m.id, { name: 'x' }), /não encontrada/);
  db.failNext('models', 'update');
  await assert.rejects(updateModel(db, GUILD, m.id, { name: 'x' }));
  assert.equal((await setFeaturedFlag(db, GUILD, m.id, true)).is_featured, true);
});
test('getSecrets/updateSecrets: descriptografia, atualização parcial e isolamento', async () => {
  const db = createFakeDb(); seedGuild(db);
  const m = await createModel(db, KEY, GUILD, actor, validData(), 'p.jpg');
  const s = await getSecrets(db, GUILD, m.id, KEY);
  assert.equal(s.gmail_password, 'gm-pass-1'); assert.equal(s.instagram_password, 'ig-pass-4');
  const before = db.tables.model_secrets[0].facebook_password;
  const changed = await updateSecrets(db, GUILD, m.id, KEY, { gmail_password: 'nova-senha', tiktok_password: '' });
  assert.deepEqual(changed, ['gmail']);
  assert.equal((await getSecrets(db, GUILD, m.id, KEY)).gmail_password, 'nova-senha');
  assert.equal(db.tables.model_secrets[0].facebook_password, before);
  await assert.rejects(updateSecrets(db, GUILD, m.id, KEY, {}), /Nenhuma senha/);
  await assert.rejects(updateSecrets(db, OTHER_GUILD, m.id, KEY, { gmail_password: 'x' }), /não encontradas/);
  await assert.rejects(getSecrets(db, OTHER_GUILD, m.id, KEY), UserError);
  await assert.rejects(getSecrets(db, GUILD, m.id, Buffer.alloc(32, 1))); // chave errada
});
test('deleteModel: remove registro e foto; falha do Storage NÃO impede a exclusão', async () => {
  const db = createFakeDb(); seedGuild(db);
  const a = await seedModel(db); const b = await seedModel(db);
  assert.deepEqual(await deleteModel(db, GUILD, a, 'model-photos'), { storageRemoved: true });
  assert.ok(!db.files.has(`model-photos/${a.photo_path}`));
  db.failNext('storage', 'remove');
  assert.deepEqual(await deleteModel(db, GUILD, b, 'model-photos'), { storageRemoved: false });
  assert.equal(db.tables.models.length, 0);
  await assert.rejects(deleteModel(db, GUILD, b, 'model-photos'), /já não existe/);
});
test('deleteModel: erro do banco propaga e não toca no Storage', async () => {
  const db = createFakeDb(); seedGuild(db);
  const a = await seedModel(db);
  db.failNext('models', 'delete');
  await assert.rejects(deleteModel(db, GUILD, a, 'model-photos'));
  assert.ok(db.files.has(`model-photos/${a.photo_path}`)); assert.equal(db.tables.models.length, 1);
});
