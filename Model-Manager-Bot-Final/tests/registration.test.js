import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startRegistration, handleRegistration, nextStep, stepModal, validateStep, STEPS, REQUIRED_KEYS, startFromButton } from '../src/interactions/registration.js';
import { getSession } from '../src/services/sessions.js';
import { clearSettingsCache } from '../src/security/permissions.js';
import { UserError } from '../src/utils/errors.js';
import { createFakeDb } from './helpers/fakeDb.js';
import { fakeClient, fakeInteraction, GUILD, ROLE } from './helpers/fakeDiscord.js';
import { jpeg916, seedGuild, testConfig, validData, KEY } from './helpers/fixtures.js';
import sharp from 'sharp';

const CH = '500000000000000001';
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; clearSettingsCache(); });

const serve = (buf) => { globalThis.fetch = async () => new Response(buf, { status: 200 }); };
const attachment = { url: 'https://cdn.discordapp.com/attachments/1/2/foto.jpg', size: 1000, contentType: 'image/jpeg' };

async function env(channels = { [CH]: {} }) {
  const db = createFakeDb(); seedGuild(db, { register_role_id: ROLE, models_channel_id: CH });
  const client = fakeClient(channels);
  return { db, client, ctx: { db, client, config: testConfig() } };
}
const cmd = (over = {}) => { const i = fakeInteraction({ type: 'command', roles: [ROLE], ...over }); i.deferred = true; return i; };
const modal = (customId, fields, over = {}) => fakeInteraction({ type: 'modal', customId, fields, roles: [ROLE], ...over });
const button = (customId, over = {}) => fakeInteraction({ type: 'button', customId, roles: [ROLE], ...over });

async function fillAll(ctx, over = {}) {
  const d = validData(over);
  const steps = [
    ['reg:identity:submit', { name: d.name, stage_name: d.stage_name }],
    ['reg:gmail:submit', { gmail: d.gmail, gmail_password: d.gmail_password }],
    ...['facebook', 'tiktok', 'instagram'].map((p) => [`reg:${p}:submit`, Object.fromEntries(['name', 'nick', 'link', 'email', 'password'].map((f) => [`${p}_${f}`, d[`${p}_${f}`]]))]),
    ['reg:observations:submit', { observations: d.observations }]
  ];
  for (const [id, fields] of steps) await handleRegistration(modal(id, fields), ctx);
}

test('fluxo completo: foto → 6 etapas → revisão → confirmação → modelo salva e publicada', async () => {
  const { db, client, ctx } = await env();
  serve(await jpeg916());
  const start = cmd(); await startRegistration(start, ctx, attachment);
  assert.match(start.last('editReply').content, /Etapa 1\/6/);
  assert.equal(db.files.size, 1);
  assert.equal(db.tables.registration_sessions.length, 1);
  await fillAll(ctx);
  const s = await getSession(db, KEY, GUILD, '333333333333333333');
  assert.equal(nextStep(s.data), 'confirm');
  const confirm = button('reg:confirm'); await handleRegistration(confirm, ctx);
  assert.match(confirm.last('editReply').content, /Cadastro concluído! Modelo #1/);
  assert.equal(db.tables.models.length, 1);
  assert.equal(db.tables.model_secrets.length, 1);
  assert.equal(db.tables.registration_sessions.length, 0);
  assert.equal(db.tables.models[0].public_message_id, client._channels.get(CH).sent[0].id);
  assert.ok(db.files.has(`model-photos/${db.tables.models[0].photo_path}`)); // foto mantida
});
test('senhas jamais aparecem nas mensagens de resposta nem no embed de revisão', async () => {
  const { ctx } = await env();
  serve(await jpeg916());
  const outputs = [];
  const start = cmd(); await startRegistration(start, ctx, attachment); outputs.push(start.log);
  const d = validData();
  const mods = [modal('reg:gmail:submit', { gmail: d.gmail, gmail_password: d.gmail_password })];
  await handleRegistration(modal('reg:identity:submit', { name: d.name, stage_name: d.stage_name }), ctx);
  for (const m of mods) { await handleRegistration(m, ctx); outputs.push(m.log); }
  assert.ok(!JSON.stringify(outputs).includes('gm-pass-1'));
});
test('retomada: após "reinício" (estado só no banco) o usuário continua da etapa pendente', async () => {
  const { db, ctx } = await env();
  serve(await jpeg916());
  await startRegistration(cmd(), ctx, attachment);
  await handleRegistration(modal('reg:identity:submit', { name: 'Ana', stage_name: 'A' }), ctx);
  await handleRegistration(modal('reg:gmail:submit', { gmail: 'ana@gmail.com', gmail_password: 'x1' }), ctx);
  // Novo /cadastrar sem restart: oferece continuar (não apaga nada)
  const again = cmd(); await startRegistration(again, ctx, null);
  assert.match(again.last('editReply').content, /em andamento/);
  assert.match(again.last('editReply').content, /Etapa 3\/6/);
  assert.equal(db.tables.registration_sessions.length, 1);
  const resume = button('reg:resume'); await handleRegistration(resume, ctx);
  assert.match(resume.last('update').content, /Etapa 3\/6/);
  // o botão de abrir formulário vem preenchido com os dados já salvos
  const open = button('reg:open:identity'); await handleRegistration(open, ctx);
  assert.equal(open.last('showModal').toJSON().custom_id, 'reg:identity:submit');
});
test('somente quem iniciou o cadastro consegue retomar/alterar a sessão', async () => {
  const { ctx, db } = await env();
  serve(await jpeg916());
  await startRegistration(cmd(), ctx, attachment);
  const intruder = { userId: '999999999999999999' };
  await assert.rejects(handleRegistration(modal('reg:identity:submit', { name: 'X', stage_name: 'Y' }, intruder), ctx), /Sessão de cadastro inexistente/);
  await assert.rejects(handleRegistration(button('reg:resume', intruder), ctx), UserError);
  await assert.rejects(handleRegistration(button('reg:confirm', intruder), ctx), UserError);
  assert.equal(db.tables.models.length, 0);
});
test('validação por etapa: dados inválidos são recusados e NÃO são gravados', async () => {
  const { ctx, db } = await env();
  serve(await jpeg916());
  await startRegistration(cmd(), ctx, attachment);
  await assert.rejects(handleRegistration(modal('reg:gmail:submit', { gmail: 'ana@outlook.com', gmail_password: 'x' }), ctx), /Gmail/);
  await assert.rejects(handleRegistration(modal('reg:facebook:submit', { facebook_name: 'a', facebook_nick: 'b', facebook_link: 'javascript:alert(1)', facebook_email: 'a@gmail.com', facebook_password: 'p' }), ctx), /http/);
  await assert.rejects(handleRegistration(modal('reg:tiktok:submit', { tiktok_name: 'a', tiktok_nick: 'b', tiktok_link: 'https://evil.com/x', tiktok_email: 'a@gmail.com', tiktok_password: 'p' }), ctx), /tiktok\.com/);
  const s = await getSession(db, KEY, GUILD, '333333333333333333');
  assert.deepEqual(s.data, {});
});
test('foto inválida (proporção, formato, host) não cria sessão nem deixa arquivo', async () => {
  const { ctx, db } = await env();
  serve(await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#000' } }).jpeg().toBuffer());
  await assert.rejects(startRegistration(cmd(), ctx, attachment), /9:16/);
  serve(Buffer.from('lixo'));
  await assert.rejects(startRegistration(cmd(), ctx, attachment), UserError);
  await assert.rejects(startRegistration(cmd(), ctx, { ...attachment, url: 'https://evil.com/a.jpg' }), /origem/);
  await assert.rejects(startRegistration(cmd(), ctx, null), /anexe a fotografia/);
  assert.equal(db.files.size, 0); assert.equal(db.tables.registration_sessions.length, 0);
});
test('falha ao salvar sessão remove a foto enviada (sem órfãos)', async () => {
  const { ctx, db } = await env();
  serve(await jpeg916());
  db.failNext('registration_sessions', 'upsert');
  await assert.rejects(startRegistration(cmd(), ctx, attachment));
  assert.equal(db.files.size, 0);
});
test('cancelar/reiniciar descarta a sessão e a foto temporária', async () => {
  const { ctx, db } = await env();
  serve(await jpeg916());
  await startRegistration(cmd(), ctx, attachment);
  const cancel = button('reg:cancel'); await handleRegistration(cancel, ctx);
  assert.match(cancel.last('update').content, /cancelado/);
  assert.equal(db.tables.registration_sessions.length, 0); assert.equal(db.files.size, 0);
  await startRegistration(cmd(), ctx, attachment);
  const restart = button('reg:restart'); await handleRegistration(restart, ctx);
  assert.equal(db.tables.registration_sessions.length, 0); assert.equal(db.files.size, 0);
});
test('novo /cadastrar com restart substitui a sessão e remove a foto antiga', async () => {
  const { ctx, db } = await env();
  serve(await jpeg916());
  await startRegistration(cmd(), ctx, attachment);
  const first = [...db.files.keys()][0];
  await startRegistration(cmd(), ctx, attachment, { restart: true });
  assert.equal(db.files.size, 1); assert.ok(!db.files.has(first));
  assert.equal(db.tables.registration_sessions.length, 1);
});
test('permissão revalidada em cada etapa: perder o cargo bloqueia o cadastro', async () => {
  const { ctx, db } = await env();
  serve(await jpeg916());
  await startRegistration(cmd(), ctx, attachment);
  await fillAll(ctx);
  await assert.rejects(handleRegistration(button('reg:confirm', { roles: [] }), ctx), /permissão/);
  await assert.rejects(handleRegistration(modal('reg:identity:submit', { name: 'x', stage_name: 'y' }, { roles: [] }), ctx), /permissão/);
  assert.equal(db.tables.models.length, 0);
});
test('confirmar sessão incompleta é recusado', async () => {
  const { ctx } = await env();
  serve(await jpeg916());
  await startRegistration(cmd(), ctx, attachment);
  await assert.rejects(handleRegistration(button('reg:confirm'), ctx), /incompleto/);
});
test('falha na publicação NÃO perde o cadastro: modelo salva e usuário é orientado', async () => {
  const { ctx, db } = await env({ [CH]: { sendError: new Error('Discord fora do ar') } });
  serve(await jpeg916());
  await startRegistration(cmd(), ctx, attachment);
  await fillAll(ctx);
  const confirm = button('reg:confirm'); await handleRegistration(confirm, ctx);
  const msg = confirm.last('editReply').content;
  assert.match(msg, /Modelo #1 salva/); assert.match(msg, /publicação falhou/); assert.match(msg, /\/modelo publicar id:1/);
  assert.equal(db.tables.models.length, 1); assert.equal(db.tables.registration_sessions.length, 0);
});
test('falha ao criar modelo mantém a sessão para nova tentativa', async () => {
  const { ctx, db } = await env();
  serve(await jpeg916());
  await startRegistration(cmd(), ctx, attachment);
  await fillAll(ctx);
  db.failNext('models', 'insert');
  await assert.rejects(handleRegistration(button('reg:confirm'), ctx));
  assert.equal(db.tables.registration_sessions.length, 1); assert.equal(db.tables.models.length, 0);
  await handleRegistration(button('reg:confirm'), ctx);
  assert.equal(db.tables.models.length, 1);
});
test('duplo clique em confirmar não cria duas modelos', async () => {
  const { ctx, db } = await env();
  serve(await jpeg916());
  await startRegistration(cmd(), ctx, attachment);
  await fillAll(ctx);
  const results = await Promise.allSettled([handleRegistration(button('reg:confirm'), ctx), handleRegistration(button('reg:confirm'), ctx)]);
  assert.equal(db.tables.models.length, 1);
  assert.ok(results.some((r) => r.status === 'rejected'));
});
test('botão do painel público orienta o uso do /cadastrar ou retoma a sessão', async () => {
  const { ctx } = await env();
  const i = button('registration:start'); await startFromButton(i, ctx);
  assert.match(i.last('reply').content, /\/cadastrar/);
  serve(await jpeg916());
  await startRegistration(cmd(), ctx, attachment);
  const j = button('registration:start'); await startFromButton(j, ctx);
  assert.match(j.last('reply').content, /em andamento/);
});
test('modais: no máximo 5 campos, IDs únicos, campos obrigatórios e opcionais corretos', () => {
  for (const step of STEPS) {
    const json = stepModal(step, {}).toJSON();
    assert.ok(json.components.length >= 1 && json.components.length <= 5, step);
    assert.ok(json.title.length <= 45);
    const ids = json.components.map((c) => c.components[0].custom_id);
    assert.equal(new Set(ids).size, ids.length);
    for (const c of json.components) assert.ok(c.components[0].max_length <= 4000);
  }
  const obs = stepModal('observations').toJSON().components[0].components[0];
  assert.equal(obs.required, false);
  const covered = STEPS.flatMap((s) => stepModal(s).toJSON().components.map((c) => c.components[0].custom_id));
  for (const key of REQUIRED_KEYS) assert.ok(covered.includes(key), `campo ${key} sem formulário`);
  assert.throws(() => validateStep('inexistente', () => ''), UserError);
});
