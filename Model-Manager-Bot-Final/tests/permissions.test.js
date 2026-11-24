import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { allowed, isAdmin, assertPermission, assertAdmin, getSettings, saveSettings, ensureSettings, clearSettingsCache, PERMISSION_ACTIONS } from '../src/security/permissions.js';
import { UserError } from '../src/utils/errors.js';
import { createFakeDb } from './helpers/fakeDb.js';
import { fakeInteraction, GUILD, ROLE, USER } from './helpers/fakeDiscord.js';
import { seedGuild } from './helpers/fixtures.js';

beforeEach(() => clearSettingsCache());

test('administrador do Discord tem acesso total', async () => {
  const db = createFakeDb(); seedGuild(db);
  const i = fakeInteraction({ admin: true });
  for (const a of PERMISSION_ACTIONS) assert.equal(await allowed(i, db, a, {}), true, a);
  assert.equal(isAdmin(i, {}), true);
});
test('usuário comum sem cargo configurado é negado em tudo', async () => {
  const db = createFakeDb(); seedGuild(db);
  const i = fakeInteraction({ roles: [ROLE] });
  for (const a of PERMISSION_ACTIONS) assert.equal(await allowed(i, db, a, {}), false, a);
  await assert.rejects(assertPermission(i, db, 'view', {}), UserError);
});
test('cargo configurado libera somente a ação correspondente', async () => {
  const db = createFakeDb(); seedGuild(db, { view_role_id: ROLE, credentials_role_id: '999999999999999999' });
  const i = fakeInteraction({ roles: [ROLE] });
  assert.equal(await allowed(i, db, 'view', {}), true);
  assert.equal(await allowed(i, db, 'credentials', {}), false);
  assert.equal(await allowed(i, db, 'delete', {}), false);
});
test('ação desconhecida e interação fora de servidor são negadas', async () => {
  const db = createFakeDb(); seedGuild(db, { view_role_id: ROLE });
  assert.equal(await allowed(fakeInteraction({ admin: true }), db, 'inexistente', {}), false);
  assert.equal(await allowed(fakeInteraction({ admin: true }), db, '__proto__', {}), false);
  assert.equal(await allowed(fakeInteraction({ noGuild: true }), db, 'view', {}), false);
});
test('ADMIN_ROLE_IDS e ADMIN_USER_IDS do .env concedem acesso administrativo', async () => {
  const db = createFakeDb(); seedGuild(db);
  assert.equal(isAdmin(fakeInteraction({ roles: [ROLE] }), { adminRoleIds: [ROLE] }), true);
  assert.equal(isAdmin(fakeInteraction({}), { adminUserIds: [USER] }), true);
  assert.equal(isAdmin(fakeInteraction({}), { adminUserIds: ['1'] }), false);
  await assert.rejects(assertAdmin(fakeInteraction({}), {}), UserError);
  await assertAdmin(fakeInteraction({ admin: true }), {});
});
test('cache de configurações: invalida ao salvar e propaga erros do banco', async () => {
  const db = createFakeDb(); seedGuild(db, { view_role_id: ROLE });
  const i = fakeInteraction({ roles: [ROLE] });
  assert.equal(await allowed(i, db, 'view', {}), true);
  const before = db.calls.length;
  await allowed(i, db, 'view', {}); assert.equal(db.calls.length, before); // veio do cache
  await saveSettings(db, GUILD, { view_role_id: '555555555555555555' });
  assert.equal(await allowed(i, db, 'view', {}), false);
  clearSettingsCache(); db.failNext('guild_settings', 'select');
  await assert.rejects(getSettings(db, GUILD));
  const s = await ensureSettings(createFakeDb(), GUILD).catch((e) => e); assert.ok(s);
});
