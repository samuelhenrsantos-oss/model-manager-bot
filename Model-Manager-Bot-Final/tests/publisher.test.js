import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModelEmbed, publishModel, publishFeatured, removeFeatured, removePublications, syncPublications, modelPayload } from '../src/services/publisher.js';
import { UserError } from '../src/utils/errors.js';
import { createFakeDb } from './helpers/fakeDb.js';
import { fakeClient, OTHER_GUILD } from './helpers/fakeDiscord.js';
import { seedGuild, seedModel, testConfig } from './helpers/fixtures.js';

const CH = '500000000000000001', CH2 = '500000000000000002', FEAT = '500000000000000003';
const setup = async (channels, settings = {}, modelOver = {}) => {
  const db = createFakeDb(); seedGuild(db, { models_channel_id: CH, featured_channel_id: FEAT, ...settings });
  const model = await seedModel(db, modelOver);
  const client = fakeClient(channels);
  return { db, model, client, ctx: { db, client, config: testConfig() }, settings: db.tables.guild_settings[0] };
};
const fetchModel = (db, id) => db.tables.models.find((m) => m.id === id);

test('embed respeita TODOS os limites do Discord mesmo com dados enormes e nunca contém senhas', () => {
  const huge = 'x'.repeat(5000);
  const model = { public_id: 1, created_at: new Date().toISOString(), created_by_tag: huge, name: huge, stage_name: huge, gmail: huge, facebook_name: huge, facebook_nick: huge, facebook_link: huge, tiktok_name: huge, tiktok_nick: huge, tiktok_link: huge, instagram_name: huge, instagram_nick: huge, instagram_link: huge, observations: huge, gmail_password: 'SEGREDO', facebook_password: 'SEGREDO' };
  const json = buildModelEmbed(model, 'foto.jpg').toJSON();
  assert.ok(json.title.length <= 256 && json.description.length <= 4096 && json.footer.text.length <= 2048);
  for (const f of json.fields) assert.ok(f.name.length <= 256 && f.value.length <= 1024);
  const total = json.title.length + json.description.length + json.footer.text.length + json.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  assert.ok(total <= 6000, `total ${total}`);
  assert.ok(!JSON.stringify(json).includes('SEGREDO'));
  assert.equal(json.image.url, 'attachment://foto.jpg');
});
test('embed: campos vazios viram "Não informado" e markdown/menções são neutralizados', () => {
  const json = buildModelEmbed({ public_id: 3, created_at: new Date().toISOString(), created_by_tag: 'a#1', name: '@everyone **x**', stage_name: 's', gmail: 'a@gmail.com', facebook_name: '', facebook_nick: '', facebook_link: '', tiktok_name: 't', tiktok_nick: 't', tiktok_link: 'https://tiktok.com/x', instagram_name: 'i', instagram_nick: 'i', instagram_link: 'https://instagram.com/i', observations: null }).toJSON();
  assert.match(json.description, /\\\*\\\*x\\\*\\\*/);
  assert.match(json.fields[1].value, /Não informado/);
  assert.match(json.fields[2].value, /<https:\/\/tiktok\.com\/x>/); // sem pré-visualização
  assert.match(json.fields[4].value, /Sem observações/);
});
test('payload usa anexo (bucket privado), botão de destaque e bloqueia menções', async () => {
  const { db, model } = await setup({ [CH]: {} });
  const p = await modelPayload(db, 'model-photos', model);
  assert.equal(p.files.length, 1); assert.deepEqual(p.allowedMentions, { parse: [] }); assert.equal(p.components.length, 1);
  assert.equal((await modelPayload(db, 'model-photos', model, { withButtons: false })).components, undefined);
});
test('publica nova ficha e sincroniza IDs de mensagem/canal com o banco', async () => {
  const { db, model, client, ctx, settings } = await setup({ [CH]: {}, [FEAT]: {} });
  const msg = await publishModel(ctx, settings, model);
  const row = fetchModel(db, model.id);
  assert.equal(row.public_message_id, msg.id); assert.equal(row.public_channel_id, CH);
  assert.equal(client._channels.get(CH).sent.length, 1);
});
test('atualiza ficha existente (edita em vez de duplicar)', async () => {
  const { db, model, client, ctx, settings } = await setup({ [CH]: {} });
  const first = await publishModel(ctx, settings, model);
  await publishModel(ctx, settings, fetchModel(db, model.id));
  assert.equal(client._channels.get(CH).sent.length, 1);
  assert.deepEqual(first.payload.attachments, []); // anexos antigos substituídos
});
test('mensagem apagada manualmente: republica e atualiza o ID', async () => {
  const { db, model, client, ctx, settings } = await setup({ [CH]: {} });
  const first = await publishModel(ctx, settings, model);
  client._channels.get(CH).messages.delete(first.id);
  const second = await publishModel(ctx, settings, fetchModel(db, model.id));
  assert.notEqual(second.id, first.id);
  assert.equal(fetchModel(db, model.id).public_message_id, second.id);
});
test('canal de publicação alterado: remove a ficha antiga e publica no novo', async () => {
  const { db, model, client, ctx } = await setup({ [CH]: {}, [CH2]: {} });
  await publishModel(ctx, { models_channel_id: CH }, model);
  const m2 = await publishModel(ctx, { models_channel_id: CH2 }, fetchModel(db, model.id));
  assert.equal(client._channels.get(CH).messages.size, 0);
  assert.equal(fetchModel(db, model.id).public_channel_id, CH2); assert.ok(m2);
});
test('falhas: canal não configurado, inexistente, de outro servidor e sem permissão', async () => {
  const noCh = await setup({ [CH]: {} });
  await assert.rejects(publishModel(noCh.ctx, {}, noCh.model), /não configurado/);
  await assert.rejects(publishModel(noCh.ctx, { models_channel_id: '999' }, noCh.model), /inacessível/);
  const other = await setup({ [CH]: { guildId: OTHER_GUILD } });
  await assert.rejects(publishModel(other.ctx, other.settings, other.model), /inacessível/); // isolamento entre servidores
  const perm = await setup({ [CH]: { sendError: Object.assign(new Error('Missing Access'), { code: 50001 }) } });
  await assert.rejects(publishModel(perm.ctx, perm.settings, perm.model), (e) => e instanceof UserError && /permissão/.test(e.message));
  const perm2 = await setup({ [CH]: { sendError: Object.assign(new Error('Missing Permissions'), { code: 50013 }) } });
  await assert.rejects(publishModel(perm2.ctx, perm2.settings, perm2.model), UserError);
  const text = await setup({ [CH]: { text: false } });
  await assert.rejects(publishModel(text.ctx, text.settings, text.model), UserError);
});
test('falha na publicação NÃO apaga nem altera dados salvos; erro ao gravar ID remove a mensagem órfã', async () => {
  const { db, model, client, ctx, settings } = await setup({ [CH]: { sendError: new Error('rede') } });
  await assert.rejects(publishModel(ctx, settings, model));
  assert.equal(db.tables.models.length, 1); assert.equal(fetchModel(db, model.id).public_message_id, null);
  const ok = await setup({ [CH]: {} });
  ok.db.failNext('models', 'update');
  await assert.rejects(publishModel(ok.ctx, ok.settings, ok.model));
  assert.equal(ok.client._channels.get(CH).messages.size, 0);
  void client;
});
test('foto ausente no Storage gera UserError (não publica)', async () => {
  const { db, model, ctx, settings, client } = await setup({ [CH]: {} });
  db.files.clear();
  await assert.rejects(publishModel(ctx, settings, model), UserError);
  assert.equal(client._channels.get(CH).sent.length, 0);
});
test('destaque: publica, atualiza, remove e limpa referências', async () => {
  const { db, model, client, ctx, settings } = await setup({ [CH]: {}, [FEAT]: {} });
  const f = await publishFeatured(ctx, settings, model);
  assert.equal(fetchModel(db, model.id).featured_message_id, f.id);
  await publishFeatured(ctx, settings, fetchModel(db, model.id));
  assert.equal(client._channels.get(FEAT).sent.length, 1);
  await removeFeatured(ctx, settings, fetchModel(db, model.id));
  assert.equal(client._channels.get(FEAT).messages.size, 0);
  assert.equal(fetchModel(db, model.id).featured_message_id, null);
  await assert.rejects(publishFeatured(ctx, {}, model), /destaques não configurado/);
});
test('removePublications e syncPublications nunca lançam e reportam avisos', async () => {
  const { db, model, client, ctx, settings } = await setup({ [CH]: {}, [FEAT]: {} });
  await publishModel(ctx, settings, model); await publishFeatured(ctx, settings, fetchModel(db, model.id));
  await removePublications(ctx, settings, fetchModel(db, model.id));
  assert.equal(client._channels.get(CH).messages.size, 0); assert.equal(client._channels.get(FEAT).messages.size, 0);
  const bad = await setup({ [CH]: { sendError: new Error('x') } });
  const warnings = await syncPublications(bad.ctx, bad.settings, { ...bad.model, is_featured: false });
  assert.equal(warnings.length, 1);
  await removePublications({ client: { channels: { fetch: async () => { throw new Error('x'); } } }, db }, settings, model);
});
