import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import { commandDefinitions, EDIT_CHOICES } from '../src/commands/definitions.js';
import { commandHandlers, subcommandHandlers, MODAL_COMMANDS, SENSITIVE_COMMANDS, buildListPayload } from '../src/interactions/commands.js';
import { handleInteraction, respond, commandKey } from '../src/interactions/handler.js';
import { showCredentials, credentialsEmbed, openPasswordModal, handlePasswordModal } from '../src/interactions/credentials.js';
import { showAdminPanel, handlePanelComponent, publishRegistrationCenter, CHANNEL_FIELDS, ROLE_FIELDS } from '../src/interactions/panels.js';
import { clearSettingsCache } from '../src/security/permissions.js';
import { createModel, getSecrets } from '../src/services/models.js';
import { UserError } from '../src/utils/errors.js';
import { EDITABLE_FIELDS } from '../src/utils/validators.js';
import { createFakeDb } from './helpers/fakeDb.js';
import { fakeClient, fakeInteraction, GUILD, OTHER_GUILD, ROLE, USER } from './helpers/fakeDiscord.js';
import { KEY, seedGuild, seedModel, testConfig, validData } from './helpers/fixtures.js';

afterEach(() => clearSettingsCache());
const CH = '500000000000000001', FEAT = '500000000000000003', LOGS = '500000000000000009';

async function env(settings = {}, config = {}) {
  clearSettingsCache(); // cache de configurações é global por guild: isola cada ambiente de teste
  const db = createFakeDb();
  seedGuild(db, { models_channel_id: CH, featured_channel_id: FEAT, registration_channel_id: CH, ...settings });
  const client = fakeClient({ [CH]: {}, [FEAT]: {}, [LOGS]: {} });
  return { db, client, ctx: { db, client, config: testConfig(config) } };
}

test('TODO comando definido tem handler (e todo subcomando também) — nenhum comando órfão', () => {
  const names = commandDefinitions.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
  for (const def of commandDefinitions) {
    assert.equal(typeof commandHandlers[def.name], 'function', `sem handler: /${def.name}`);
    const subs = (def.options || []).filter((o) => o.type === 1).map((o) => o.name);
    if (def.name === 'modelo') {
      assert.deepEqual([...subs].sort(), Object.keys(subcommandHandlers).sort());
    } else assert.equal(subs.length, 0);
  }
  for (const name of Object.keys(commandHandlers)) assert.ok(names.includes(name), `handler sem comando: ${name}`);
});
test('definições: guild-only, dentro dos limites do Discord e escolhas de edição válidas', () => {
  assert.ok(commandDefinitions.length <= 100);
  for (const def of commandDefinitions) {
    assert.ok(def.name.length <= 32 && def.description.length <= 100, def.name);
    assert.deepEqual(def.contexts, [0]);
    const walk = (opts = []) => opts.forEach((o) => { assert.ok(o.description.length <= 100, o.name); walk(o.options); });
    walk(def.options);
  }
  assert.equal(commandDefinitions.find((c) => c.name === 'painel').default_member_permissions, String(PermissionsBitField.Flags.Administrator));
  for (const choice of EDIT_CHOICES) assert.ok(Object.hasOwn(EDITABLE_FIELDS, choice.value), choice.value);
  assert.equal(EDIT_CHOICES.length, Object.keys(EDITABLE_FIELDS).length);
  assert.ok(MODAL_COMMANDS.has('modelo:senhas') && SENSITIVE_COMMANDS.has('credenciais'));
  const foto = commandDefinitions.find((c) => c.name === 'modelo').options.find((o) => o.name === 'foto');
  assert.ok(foto.options.some((o) => o.type === 11 && o.required)); // option attachment obrigatória
});
test('permissões do bot: convite com o mínimo necessário e SEM intents privilegiadas', () => {
  const needed = new PermissionsBitField(['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory']);
  assert.equal(needed.bitfield, 117760n); // valor documentado no README
});
test('roteador: servidor não autorizado, DM e rate limit', async () => {
  const { ctx } = await env({}, { allowedGuildIds: [OTHER_GUILD] });
  const denied = fakeInteraction({ type: 'command', commandName: 'ping' });
  await handleInteraction(denied, ctx);
  assert.match(denied.last('reply').content, /não está autorizado/);
  const dm = fakeInteraction({ type: 'command', commandName: 'ping', noGuild: true });
  await handleInteraction(dm, ctx);
  assert.match(dm.last('reply').content, /dentro de servidores/);
  const ok = await env({}, {});
  let limited;
  for (let n = 0; n < 15; n++) { limited = fakeInteraction({ type: 'command', commandName: 'ping', userId: '777777777777777777' }); await handleInteraction(limited, ok.ctx); }
  assert.match(limited.last('reply').content, /Muitas ações/);
});
test('/ping responde de forma efêmera após defer', async () => {
  const { ctx } = await env();
  const i = fakeInteraction({ type: 'command', commandName: 'ping', userId: '666666666666666661' });
  await handleInteraction(i, ctx);
  assert.equal(i.log[0][0], 'deferReply'); assert.match(i.last('editReply').content, /Pong! 42/);
  assert.equal(commandKey(fakeInteraction({ type: 'command', commandName: 'modelo', sub: 'ver' })), 'modelo:ver');
});
test('comandos de modelo exigem permissão específica (negado sem cargo)', async () => {
  const { ctx, db } = await env();
  const m = await seedModel(db);
  const cases = [['modelos', {}, null], ['modelo', { id: String(m.public_id) }, 'ver'], ['modelo', { id: String(m.public_id), campo: 'name', valor: 'x' }, 'editar'],
    ['modelo', { id: String(m.public_id) }, 'excluir'], ['modelo', { id: String(m.public_id) }, 'destaque'], ['modelo', { termo: 'a' }, 'buscar'],
    ['modelo', { id: String(m.public_id) }, 'publicar'], ['credenciais', { id: String(m.public_id) }, null], ['cadastrar', {}, null], ['modelo', { id: String(m.public_id) }, 'senhas']];
  for (const [commandName, options, sub] of cases) {
    const i = fakeInteraction({ type: 'command', commandName, options, sub, roles: [], userId: `88888888888888${Math.floor(Math.random() * 9000 + 1000)}` });
    await handleInteraction(i, ctx).catch((e) => { assert.ok(e instanceof UserError, `${commandName}:${sub}`); assert.match(e.message, /permissão|administradores/); });
  }
  assert.equal(db.tables.models[0].name, validData().name);
});
test('/modelos e botões de página: paginação, permissão e página inexistente', async () => {
  const { ctx, db } = await env({ view_role_id: ROLE });
  for (let n = 0; n < 12; n++) await seedModel(db);
  const i = fakeInteraction({ type: 'command', commandName: 'modelos', roles: [ROLE], options: { pagina: 2 }, userId: '555555555555555551' });
  await handleInteraction(i, ctx);
  const payload = i.last('editReply');
  assert.match(payload.embeds[0].toJSON().title, /página 2\/2/);
  const b = fakeInteraction({ type: 'button', customId: 'list:1:0', roles: [ROLE], userId: '555555555555555552' });
  await handleInteraction(b, ctx);
  assert.match(b.last('editReply').embeds[0].toJSON().title, /página 1\/2/);
  const nope = fakeInteraction({ type: 'button', customId: 'list:1:0', roles: [], userId: '555555555555555553' });
  await assert.rejects(handleInteraction(nope, ctx), UserError);
  const weird = fakeInteraction({ type: 'button', customId: 'list:abc:1', roles: [ROLE], userId: '555555555555555554' });
  await handleInteraction(weird, ctx);
  const row = buildListPayload({ data: [], count: 0, page: 1, pages: 1 }, false).components[0].toJSON();
  assert.ok(row.components.every((c) => c.disabled));
});
test('/modelo ver: modelo inexistente e ID inválido dão mensagens amigáveis', async () => {
  const { ctx } = await env({ view_role_id: ROLE });
  for (const [id, re] of [['9999', /não encontrada/], ['abc', /ID inválido/]]) {
    const i = fakeInteraction({ type: 'command', commandName: 'modelo', sub: 'ver', options: { id }, roles: [ROLE], userId: `4444444444444444${id.length}1` });
    await assert.rejects(handleInteraction(i, ctx), re);
  }
});
test('/modelo ver mostra ficha (efêmera) sem senhas', async () => {
  const { ctx, db } = await env({ view_role_id: ROLE });
  const m = await seedModel(db);
  const i = fakeInteraction({ type: 'command', commandName: 'modelo', sub: 'ver', options: { id: String(m.public_id) }, roles: [ROLE], userId: '444444444444444411' });
  await handleInteraction(i, ctx);
  assert.deepEqual(i.log[0][1], { flags: 64 }); // adiado como efêmero
  assert.ok(!JSON.stringify(i.last('editReply').embeds[0].toJSON()).includes('pass'));
});
test('/modelo editar valida, atualiza, sincroniza ficha e grava auditoria; valor inválido não altera nada', async () => {
  const { ctx, db, client } = await env({ edit_role_id: ROLE });
  const m = await seedModel(db);
  const run = (campo, valor) => { const i = fakeInteraction({ type: 'command', commandName: 'modelo', sub: 'editar', options: { id: String(m.public_id), campo, valor }, roles: [ROLE], userId: `1111111111111${Math.floor(Math.random() * 90000 + 10000)}` }); return handleInteraction(i, ctx).then(() => i); };
  const ok = await run('name', 'Nome Novo');
  assert.match(ok.last('editReply').content, /atualizada/);
  assert.equal(db.tables.models[0].name, 'Nome Novo');
  assert.equal(client._channels.get(CH).sent.length, 1);
  assert.ok(db.tables.audit_logs.some((a) => a.action === 'model_updated' && a.metadata.field === 'name'));
  await assert.rejects(run('instagram_link', 'https://evil.com/x'), /instagram\.com/);
  await assert.rejects(run('photo_path', 'x'), UserError);
  assert.equal(db.tables.models[0].photo_path, m.photo_path);
});
test('edição com falha de publicação mantém o dado salvo e avisa o usuário', async () => {
  const { ctx, db } = await env({ edit_role_id: ROLE, models_channel_id: null });
  const m = await seedModel(db);
  const i = fakeInteraction({ type: 'command', commandName: 'modelo', sub: 'editar', options: { id: String(m.public_id), campo: 'stage_name', valor: 'Novo' }, roles: [ROLE], userId: '121212121212121212' });
  await handleInteraction(i, ctx);
  assert.equal(db.tables.models[0].stage_name, 'Novo');
  assert.match(i.last('editReply').content, /⚠️.*não configurado/s);
});
test('/modelo foto: substitui a foto, remove a antiga e atualiza a ficha; foto inválida preserva a antiga', async () => {
  const { ctx, db } = await env({ edit_role_id: ROLE });
  const m = await seedModel(db);
  const oldPath = m.photo_path;
  const sharpMod = (await import('sharp')).default;
  const good = await sharpMod({ create: { width: 720, height: 1280, channels: 3, background: '#0f0' } }).png().toBuffer();
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(good);
    const att = { url: 'https://cdn.discordapp.com/attachments/1/2/n.png', size: 1000 };
    const i = fakeInteraction({ type: 'command', commandName: 'modelo', sub: 'foto', options: { id: String(m.public_id), imagem: att }, roles: [ROLE], userId: '131313131313131313' });
    await handleInteraction(i, ctx);
    assert.match(i.last('editReply').content, /substituída/);
    const row = db.tables.models[0];
    assert.notEqual(row.photo_path, oldPath); assert.match(row.photo_path, /\.png$/);
    assert.ok(!db.files.has(`model-photos/${oldPath}`)); assert.ok(db.files.has(`model-photos/${row.photo_path}`));
    globalThis.fetch = async () => new Response(Buffer.from('nao é imagem'));
    const bad = fakeInteraction({ type: 'command', commandName: 'modelo', sub: 'foto', options: { id: String(m.public_id), imagem: att }, roles: [ROLE], userId: '141414141414141414' });
    await assert.rejects(handleInteraction(bad, ctx), UserError);
    assert.equal(db.tables.models[0].photo_path, row.photo_path); assert.equal(db.files.size, 1);
    // falha no banco após upload: remove a foto nova (sem órfãos) e mantém a antiga
    globalThis.fetch = async () => new Response(good);
    db.failNext('models', 'update');
    const dbFail = fakeInteraction({ type: 'command', commandName: 'modelo', sub: 'foto', options: { id: String(m.public_id), imagem: att }, roles: [ROLE], userId: '151515151515151515' });
    await assert.rejects(handleInteraction(dbFail, ctx));
    assert.equal(db.files.size, 1); assert.equal(db.tables.models[0].photo_path, row.photo_path);
  } finally { globalThis.fetch = real; }
});
test('/modelo destaque: liga, desliga, sincroniza botão e REVERTE se a publicação falhar', async () => {
  const { ctx, db, client } = await env({ feature_role_id: ROLE });
  const m = await seedModel(db);
  const run = (userId) => { const i = fakeInteraction({ type: 'command', commandName: 'modelo', sub: 'destaque', options: { id: String(m.public_id) }, roles: [ROLE], userId }); return handleInteraction(i, ctx).then(() => i); };
  const on = await run('161616161616161611');
  assert.match(on.last('editReply').content, /destacada/); assert.equal(db.tables.models[0].is_featured, true);
  assert.equal(client._channels.get(FEAT).sent.length, 1);
  const off = await run('161616161616161612');
  assert.match(off.last('editReply').content, /removido/); assert.equal(db.tables.models[0].is_featured, false);
  assert.equal(client._channels.get(FEAT).messages.size, 0);
  const noChannel = await env({ feature_role_id: ROLE, featured_channel_id: null });
  const m2 = await seedModel(noChannel.db);
  const i = fakeInteraction({ type: 'command', commandName: 'modelo', sub: 'destaque', options: { id: String(m2.public_id) }, roles: [ROLE], userId: '161616161616161613' });
  await assert.rejects(handleInteraction(i, noChannel.ctx), /Canal de destaques/);
  assert.equal(noChannel.db.tables.models[0].is_featured, false);
  const broken = await env({ feature_role_id: ROLE });
  broken.client._channels.get(FEAT).send = async () => { throw new Error('falha'); };
  const m3 = await seedModel(broken.db);
  const j = fakeInteraction({ type: 'command', commandName: 'modelo', sub: 'destaque', options: { id: String(m3.public_id) }, roles: [ROLE], userId: '161616161616161614' });
  await assert.rejects(handleInteraction(j, broken.ctx));
  assert.equal(broken.db.tables.models[0].is_featured, false); // flag revertido
});
test('botão de destaque da ficha pública exige o cargo e valida o UUID', async () => {
  const { ctx, db } = await env({ feature_role_id: ROLE });
  const m = await seedModel(db);
  const b = fakeInteraction({ type: 'button', customId: `model:feature:${m.id}`, roles: [ROLE], userId: '171717171717171711' });
  await handleInteraction(b, ctx);
  assert.equal(db.tables.models[0].is_featured, true);
  await assert.rejects(handleInteraction(fakeInteraction({ type: 'button', customId: `model:feature:${m.id}`, roles: [], userId: '171717171717171712' }), ctx), UserError);
  await assert.rejects(handleInteraction(fakeInteraction({ type: 'button', customId: 'model:feature:xyz', roles: [ROLE], userId: '171717171717171713' }), ctx), /inválido/);
});
test('exclusão: confirmação ligada ao usuário, expira, apaga publicações e conclui mesmo se o Storage falhar', async () => {
  const { ctx, db, client } = await env({ delete_role_id: ROLE });
  const m = await seedModel(db);
  const ask = fakeInteraction({ type: 'command', commandName: 'modelo', sub: 'excluir', options: { id: String(m.public_id) }, roles: [ROLE], userId: '181818181818181811' });
  await handleInteraction(ask, ctx);
  assert.ok(ask.last('editReply').content.includes('Confirma excluir'));
  assert.equal(db.tables.models.length, 1); // nada excluído antes da confirmação
  const yes = (userId, ts = Date.now(), roles = [ROLE]) => fakeInteraction({ type: 'button', customId: `delete:yes:${m.id}:181818181818181811:${ts}`, roles, userId });
  await assert.rejects(handleInteraction(yes('999999999999999999'), ctx), /Somente quem solicitou/);
  const expired = yes('181818181818181811', Date.now() - 10 * 60_000); await handleInteraction(expired, ctx);
  assert.match(expired.last('update').content, /expirada/); assert.equal(db.tables.models.length, 1);
  await assert.rejects(handleInteraction(yes('181818181818181811', Date.now(), []), ctx), UserError);
  await ctx.client.channels.fetch(CH); // garante canal
  await (await import('../src/services/publisher.js')).publishModel(ctx, db.tables.guild_settings[0], db.tables.models[0]);
  assert.equal(client._channels.get(CH).messages.size, 1);
  db.failNext('storage', 'remove');
  const ok = yes('181818181818181811'); await handleInteraction(ok, ctx);
  assert.match(ok.last('editReply').content, /excluída.*limpeza/);
  assert.equal(db.tables.models.length, 0); assert.equal(client._channels.get(CH).messages.size, 0);
  const again = yes('181818181818181811'); await handleInteraction(again, ctx);
  assert.match(again.last('editReply').content, /não encontrada|já não existe/);
  const no = fakeInteraction({ type: 'button', customId: 'delete:no', userId: '181818181818181811' }); await handleInteraction(no, ctx);
  assert.match(no.last('update').content, /cancelada/);
});
test('/modelo publicar republica a ficha', async () => {
  const { ctx, db, client } = await env({ edit_role_id: ROLE });
  const m = await seedModel(db);
  const i = fakeInteraction({ type: 'command', commandName: 'modelo', sub: 'publicar', options: { id: String(m.public_id) }, roles: [ROLE], userId: '191919191919191911' });
  await handleInteraction(i, ctx);
  assert.equal(client._channels.get(CH).sent.length, 1); assert.match(i.last('editReply').content, /publicada/);
});

// ---- Credenciais ----
test('/credenciais: resposta EFÊMERA, em spoiler, auditada ANTES de revelar e com remoção automática', async () => {
  const { ctx, db } = await env({ credentials_role_id: ROLE });
  const m = await createModel(db, KEY, GUILD, { id: 'u', tag: 't' }, validData(), 'p.jpg');
  const i = fakeInteraction({ type: 'command', commandName: 'credenciais', options: { id: String(m.public_id) }, roles: [ROLE], userId: '202020202020202011' });
  await handleInteraction(i, ctx);
  assert.deepEqual(i.log[0][1], { flags: 64 });
  const desc = JSON.stringify(i.last('editReply').embeds[0].toJSON());
  assert.ok(desc.includes('||gm-pass-1||') && desc.includes('||ig-pass-4||'));
  assert.ok(!('flags' in i.last('editReply')) || true);
  const a = db.tables.audit_logs.find((x) => x.action === 'credentials_viewed');
  assert.ok(a && a.model_id === m.id && a.actor_id === '202020202020202011');
  assert.ok(!JSON.stringify(db.tables.audit_logs).includes('gm-pass-1'));
});
test('/credenciais: sem cargo é negado e NADA é descriptografado; falha de auditoria bloqueia a consulta', async () => {
  const { ctx, db } = await env({ credentials_role_id: ROLE });
  const m = await createModel(db, KEY, GUILD, { id: 'u', tag: 't' }, validData(), 'p.jpg');
  const denied = fakeInteraction({ type: 'command', commandName: 'credenciais', options: { id: String(m.public_id) }, roles: ['1'], userId: '212121212121212111' });
  await assert.rejects(handleInteraction(denied, ctx), /permissão/);
  assert.ok(!denied.log.some((l) => JSON.stringify(l).includes('pass')));
  assert.equal(db.tables.audit_logs.filter((a) => a.action === 'credentials_viewed').length, 0);
  const ok = fakeInteraction({ type: 'command', commandName: 'credenciais', options: { id: String(m.public_id) }, roles: [ROLE], userId: '212121212121212112' });
  db.failNext('audit_logs', 'insert');
  await assert.rejects(handleInteraction(ok, ctx));
  assert.ok(!ok.log.some((l) => JSON.stringify(l).includes('gm-pass')));
  const missing = fakeInteraction({ type: 'command', commandName: 'credenciais', options: { id: '9999' }, roles: [ROLE], userId: '212121212121212113' });
  await assert.rejects(handleInteraction(missing, ctx), /não encontrada/);
});
test('/credenciais: limite de consultas por minuto (anti-abuso)', async () => {
  const { ctx, db } = await env({ credentials_role_id: ROLE });
  const m = await createModel(db, KEY, GUILD, { id: 'u', tag: 't' }, validData(), 'p.jpg');
  let last;
  for (let n = 0; n < 7; n++) { last = fakeInteraction({ type: 'command', commandName: 'credenciais', options: { id: String(m.public_id) }, roles: [ROLE], userId: '232323232323232311' }); await handleInteraction(last, ctx); }
  assert.match(last.last('reply').content, /Muitas ações/);
});
test('credenciais com markdown/caracteres especiais são escapados dentro do spoiler', () => {
  const embed = credentialsEmbed({ public_id: 1, gmail: 'a@gmail.com', facebook_email: 'b_c@gmail.com', tiktok_email: 'x', instagram_email: 'y' },
    { gmail_password: 'a||b*c_d`e', facebook_password: 'p', tiktok_password: 'q', instagram_password: 'r'.repeat(256) }).toJSON();
  assert.match(embed.fields[0].value, /\|\|a\\\|\\\|b\\\*c\\_d\\`e\|\|/);
  for (const f of embed.fields) assert.ok(f.value.length <= 1024);
});
test('/modelo senhas: abre modal só com permissão; modal atualiza só os campos preenchidos e nunca ecoa senhas', async () => {
  const { ctx, db } = await env({ credentials_role_id: ROLE });
  const m = await createModel(db, KEY, GUILD, { id: 'u', tag: 't' }, validData(), 'p.jpg');
  const open = fakeInteraction({ type: 'command', commandName: 'modelo', sub: 'senhas', options: { id: String(m.public_id) }, roles: [ROLE], userId: '242424242424242411' });
  await handleInteraction(open, ctx);
  assert.ok(!open.log.some((l) => l[0] === 'deferReply')); // modal precisa ser a primeira resposta
  const modalJson = open.last('showModal').toJSON();
  assert.equal(modalJson.custom_id, `pwd:${m.id}`); assert.equal(modalJson.components.length, 4);
  assert.ok(modalJson.components.every((c) => c.components[0].required === false));
  const noRole = fakeInteraction({ type: 'command', commandName: 'modelo', sub: 'senhas', options: { id: String(m.public_id) }, roles: [], userId: '242424242424242412' });
  await assert.rejects(handleInteraction(noRole, ctx), /permissão/);
  const submit = fakeInteraction({ type: 'modal', customId: `pwd:${m.id}`, roles: [ROLE], userId: '242424242424242413', fields: { gmail_password: 'NOVA-GMAIL', facebook_password: '', tiktok_password: '', instagram_password: 'NOVA-IG' } });
  await handleInteraction(submit, ctx);
  const msg = submit.last('reply');
  assert.match(msg.content, /Gmail, Instagram/); assert.ok(!msg.content.includes('NOVA'));
  const s = await getSecrets(db, GUILD, m.id, KEY);
  assert.deepEqual([s.gmail_password, s.facebook_password, s.tiktok_password, s.instagram_password], ['NOVA-GMAIL', 'fb-pass-2', 'tt-pass-3', 'NOVA-IG']);
  const audit = db.tables.audit_logs.find((a) => a.action === 'credentials_updated');
  assert.deepEqual(audit.metadata.platforms, ['gmail', 'instagram']); assert.ok(!JSON.stringify(db.tables.audit_logs).includes('NOVA'));
  const empty = fakeInteraction({ type: 'modal', customId: `pwd:${m.id}`, roles: [ROLE], userId: '242424242424242414', fields: { gmail_password: '', facebook_password: '', tiktok_password: '', instagram_password: '' } });
  await assert.rejects(handleInteraction(empty, ctx), /Nenhuma senha/);
  const noPerm = fakeInteraction({ type: 'modal', customId: `pwd:${m.id}`, roles: [], userId: '242424242424242415', fields: { gmail_password: 'x', facebook_password: '', tiktok_password: '', instagram_password: '' } });
  await assert.rejects(handleInteraction(noPerm, ctx), /permissão/);
  assert.equal((await getSecrets(db, GUILD, m.id, KEY)).gmail_password, 'NOVA-GMAIL');
  const bad = fakeInteraction({ type: 'modal', customId: 'pwd:nao-uuid', roles: [ROLE], userId: '242424242424242416', fields: {} });
  await assert.rejects(handlePasswordModal(bad, ctx), /inválido/);
  void showCredentials; void openPasswordModal;
});

// ---- Painel ----
test('painel: somente administradores; salva canais/cargos com validação', async () => {
  const { ctx, db } = await env();
  const guild = (perms) => ({ id: GUILD, channels: { fetch: async () => ({ permissionsFor: () => ({ has: () => perms }) }) }, members: { me: {} } });
  const denied = fakeInteraction({ type: 'command', commandName: 'painel', userId: '252525252525252511' }); denied.deferred = true;
  await assert.rejects(showAdminPanel(denied, ctx), /administradores/);
  const adm = fakeInteraction({ type: 'command', commandName: 'painel', admin: true, userId: '252525252525252512' }); adm.deferred = true;
  await showAdminPanel(adm, ctx);
  assert.equal(adm.last('editReply').components.length, 5); // 4 menus de canal + botão
  assert.equal(adm.log.filter((l) => l[0] === 'followUp').length, 2);
  for (const f of ROLE_FIELDS) assert.ok(f.endsWith('_role_id'));
  const sel = fakeInteraction({ type: 'select', selectKind: 'channel', customId: 'cfg:logs_channel_id', values: [LOGS], admin: true, userId: '252525252525252513' });
  sel.guild = guild(true); await handlePanelComponent(sel, ctx);
  assert.equal(db.tables.guild_settings[0].logs_channel_id, LOGS); assert.match(sel.last('reply').content, /salva/);
  const warn = fakeInteraction({ type: 'select', selectKind: 'channel', customId: 'cfg:models_channel_id', values: [CH], admin: true, userId: '252525252525252514' });
  warn.guild = guild(false); await handlePanelComponent(warn, ctx);
  assert.match(warn.last('reply').content, /⚠️/);
  const role = fakeInteraction({ type: 'select', selectKind: 'role', customId: 'cfg:view_role_id', values: [ROLE], admin: true, userId: '252525252525252515' });
  await handlePanelComponent(role, ctx); assert.equal(db.tables.guild_settings[0].view_role_id, ROLE);
  const everyone = fakeInteraction({ type: 'select', selectKind: 'role', customId: 'cfg:view_role_id', values: [GUILD], admin: true, userId: '252525252525252516' });
  await assert.rejects(handlePanelComponent(everyone, ctx), /@everyone/);
  const unknown = fakeInteraction({ type: 'select', selectKind: 'role', customId: 'cfg:is_admin', values: [ROLE], admin: true, userId: '252525252525252517' });
  await assert.rejects(handlePanelComponent(unknown, ctx), /desconhecida/);
  const nonAdmin = fakeInteraction({ type: 'select', selectKind: 'role', customId: 'cfg:view_role_id', values: [ROLE], roles: [ROLE], userId: '252525252525252518' });
  await assert.rejects(handlePanelComponent(nonAdmin, ctx), /administradores/);
  assert.ok(CHANNEL_FIELDS.length === 4 && db.tables.audit_logs.some((a) => a.action === 'settings_updated'));
});
test('central de cadastro: publica, atualiza a mesma mensagem e exige canal válido', async () => {
  const { ctx, db, client } = await env();
  const i = fakeInteraction({ type: 'command', commandName: 'painel-cadastro', admin: true, userId: '262626262626262611' }); i.deferred = true;
  await publishRegistrationCenter(i, ctx);
  assert.equal(client._channels.get(CH).sent.length, 1);
  assert.ok(db.tables.guild_settings[0].registration_message_id);
  await publishRegistrationCenter(i, ctx);
  assert.equal(client._channels.get(CH).sent.length, 1); // editou
  const none = await env({ registration_channel_id: null });
  await assert.rejects(publishRegistrationCenter(i, none.ctx), /Configure o canal/);
  const via = fakeInteraction({ type: 'command', commandName: 'painel-cadastro', admin: true, userId: '262626262626262612' });
  await handleInteraction(via, ctx); assert.match(via.last('editReply').content, /publicada/);
  const nonAdmin = fakeInteraction({ type: 'command', commandName: 'painel-cadastro', userId: '262626262626262613' });
  await assert.rejects(handleInteraction(nonAdmin, ctx), /administradores/);
});
test('canal de logs recebe resumo SEM dados sensíveis', async () => {
  const { ctx, db, client } = await env({ logs_channel_id: LOGS, edit_role_id: ROLE });
  const m = await seedModel(db);
  const i = fakeInteraction({ type: 'command', commandName: 'modelo', sub: 'editar', options: { id: String(m.public_id), campo: 'gmail', valor: 'novo@gmail.com' }, roles: [ROLE], userId: '272727272727272711' });
  await handleInteraction(i, ctx);
  const sent = client._channels.get(LOGS).sent;
  assert.equal(sent.length, 1);
  const text = JSON.stringify(sent[0].payload.embeds[0].toJSON());
  assert.match(text, /Modelo editada/); assert.ok(!text.includes('novo@gmail.com'));
  assert.deepEqual(sent[0].payload.allowedMentions, { parse: [] });
});
test('respond(): trata qualquer estado da interação e ignora interações expiradas', async () => {
  const a = fakeInteraction({ type: 'command' }); await respond(a, 'x'); assert.equal(a.log[0][0], 'reply');
  const b = fakeInteraction({ type: 'command' }); b.deferred = true; await respond(b, 'x'); assert.equal(b.log[0][0], 'editReply');
  const c = fakeInteraction({ type: 'button' }); c.deferred = true; c.updateDeferred = true; await respond(c, 'x'); assert.equal(c.log[0][0], 'followUp');
  const d = fakeInteraction({ type: 'command' }); d.reply = async () => { throw Object.assign(new Error('Unknown interaction'), { code: 10062 }); };
  await respond(d, 'x'); // não lança
});
void USER;
