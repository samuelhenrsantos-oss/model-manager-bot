import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder,
  TextInputStyle, EmbedBuilder, MessageFlags
} from 'discord.js';
import { downloadAttachment, validateImage, uploadPhoto, removePhoto } from '../services/images.js';
import { createModel } from '../services/models.js';
import { publishModel } from '../services/publisher.js';
import { ensureSettings, allowed, getSettings } from '../security/permissions.js';
import { record } from '../services/logchannel.js';
import { cleanupExpiredSessions, deleteSession, discardOrphanPhoto, getSession, saveSession, touchSession } from '../services/sessions.js';
import { UserError } from '../utils/errors.js';
import { LIMITS, display, escapeText, truncate } from '../utils/text.js';
import { FIELD_LIMITS, cleanEmail, cleanGmail, cleanPassword, cleanText, cleanUrl } from '../utils/validators.js';
import { logger } from '../utils/logger.js';

const EPHEMERAL = MessageFlags.Ephemeral;
const NO_MENTIONS = { parse: [] };

export const REQUIRED_KEYS = Object.freeze(['name', 'stage_name', 'gmail', 'gmail_password', 'facebook_name', 'facebook_nick', 'facebook_link', 'facebook_email', 'facebook_password', 'tiktok_name', 'tiktok_nick', 'tiktok_link', 'tiktok_email', 'tiktok_password', 'instagram_name', 'instagram_nick', 'instagram_link', 'instagram_email', 'instagram_password']);

const SOCIAL = Object.freeze({
  facebook: { label: 'Facebook', next: 'tiktok' },
  tiktok: { label: 'TikTok', next: 'instagram' },
  instagram: { label: 'Instagram', next: 'observations' }
});

/** Etapas na ordem do fluxo. */
export const STEPS = Object.freeze(['identity', 'gmail', 'facebook', 'tiktok', 'instagram', 'observations']);
const STEP_LABEL = { identity: 'Identidade', gmail: 'Gmail', facebook: 'Facebook', tiktok: 'TikTok', instagram: 'Instagram', observations: 'Observações e revisão' };

/** Próxima etapa pendente com base nos dados já preenchidos (permite retomar de onde parou). */
export function nextStep(data) {
  if (!data.name || !data.stage_name) return 'identity';
  if (!data.gmail || !data.gmail_password) return 'gmail';
  for (const key of ['facebook', 'tiktok', 'instagram']) {
    if (!['name', 'nick', 'link', 'email', 'password'].every((f) => data[`${key}_${f}`])) return key;
  }
  if (!data.observations_done) return 'observations';
  return 'confirm';
}

function modal(id, title, fields) {
  const m = new ModalBuilder().setCustomId(id).setTitle(title);
  for (const f of fields) {
    const input = new TextInputBuilder().setCustomId(f.key).setLabel(f.label).setStyle(f.style || TextInputStyle.Short)
      .setRequired(f.required !== false).setMaxLength(f.max);
    if (f.value) input.setValue(f.value);
    m.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return m;
}

export function stepModal(step, data = {}) {
  const L = FIELD_LIMITS;
  if (step === 'identity') return modal('reg:identity:submit', 'Identidade da modelo', [
    { key: 'name', label: 'Nome da modelo', max: L.name, value: data.name }, { key: 'stage_name', label: 'Nome artístico', max: L.stage_name, value: data.stage_name }]);
  if (step === 'gmail') return modal('reg:gmail:submit', 'Dados do Gmail', [
    { key: 'gmail', label: 'Endereço Gmail', max: L.gmail, value: data.gmail }, { key: 'gmail_password', label: 'Senha do Gmail', max: L.password }]);
  if (step === 'observations') return modal('reg:observations:submit', 'Observações', [
    { key: 'observations', label: 'Observações (opcional)', style: TextInputStyle.Paragraph, max: L.observations, required: false, value: data.observations }]);
  const s = SOCIAL[step];
  return modal(`reg:${step}:submit`, `Dados ${s.label}`, [
    { key: `${step}_name`, label: 'Nome do perfil', max: L.profile_name, value: data[`${step}_name`] },
    { key: `${step}_nick`, label: 'Nick (@)', max: L.nick, value: data[`${step}_nick`] },
    { key: `${step}_link`, label: 'Link do perfil', max: L.link, value: data[`${step}_link`] },
    { key: `${step}_email`, label: 'Gmail vinculado', max: L.email, value: data[`${step}_email`] },
    { key: `${step}_password`, label: 'Senha da conta', max: L.password }]);
}

/** Valida e normaliza os campos de uma etapa; lança UserError com mensagem amigável. */
export function validateStep(step, get) {
  if (step === 'identity') return {
    name: cleanText(get('name'), { max: FIELD_LIMITS.name, label: 'Nome' }),
    stage_name: cleanText(get('stage_name'), { max: FIELD_LIMITS.stage_name, label: 'Nome artístico' })
  };
  if (step === 'gmail') return { gmail: cleanGmail(get('gmail')), gmail_password: cleanPassword(get('gmail_password'), 'Senha do Gmail') };
  if (step === 'observations') return {
    observations: cleanText(get('observations'), { max: FIELD_LIMITS.observations, label: 'Observações', required: false }),
    observations_done: true
  };
  const s = SOCIAL[step];
  if (!s) throw new UserError('Etapa inválida.');
  return {
    [`${step}_name`]: cleanText(get(`${step}_name`), { max: FIELD_LIMITS.profile_name, label: `${s.label} — nome` }),
    [`${step}_nick`]: cleanText(get(`${step}_nick`), { max: FIELD_LIMITS.nick, label: `${s.label} — nick` }),
    [`${step}_link`]: cleanUrl(get(`${step}_link`), { platform: step, label: `${s.label} — link` }),
    [`${step}_email`]: cleanEmail(get(`${step}_email`), `${s.label} — e-mail`),
    [`${step}_password`]: cleanPassword(get(`${step}_password`), `Senha do ${s.label}`)
  };
}

const button = (id, label, style = ButtonStyle.Primary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const row = (...buttons) => new ActionRowBuilder().addComponents(...buttons);

function reviewEmbed(d) {
  return new EmbedBuilder().setColor(0x5865F2).setTitle('Confirmação do cadastro')
    .setDescription(truncate([
      `**Nome:** ${display(escapeText(d.name), 150)}`, `**Artístico:** ${display(escapeText(d.stage_name), 150)}`,
      `**Gmail:** ${display(escapeText(d.gmail), 150)}`,
      `**Facebook:** ${display(escapeText(d.facebook_name), 100)} (${display(escapeText(d.facebook_nick), 100)})`,
      `**TikTok:** ${display(escapeText(d.tiktok_name), 100)} (${display(escapeText(d.tiktok_nick), 100)})`,
      `**Instagram:** ${display(escapeText(d.instagram_name), 100)} (${display(escapeText(d.instagram_nick), 100)})`,
      `**Observações:** ${display(escapeText(d.observations), 1000, '—')}`,
      '', 'Senhas: armazenadas criptografadas e nunca exibidas.'
    ].join('\n'), LIMITS.description));
}

/** Monta a mensagem (efêmera) do passo atual da sessão. */
export function stepMessage(session, intro = '') {
  const step = nextStep(session.data);
  const prefix = intro ? `${intro}\n` : '';
  if (step === 'confirm') {
    return { content: `${prefix}Revise os dados e confirme o cadastro.`, embeds: [reviewEmbed(session.data)],
      components: [row(button('reg:confirm', 'Confirmar cadastro', ButtonStyle.Success), button('reg:cancel', 'Cancelar', ButtonStyle.Danger))], allowedMentions: NO_MENTIONS };
  }
  const n = STEPS.indexOf(step) + 1;
  return { content: `${prefix}Etapa ${n}/${STEPS.length} — ${STEP_LABEL[step]}`, embeds: [],
    components: [row(button(`reg:open:${step}`, `Preencher ${STEP_LABEL[step].toLowerCase()}`), button('reg:cancel', 'Cancelar', ButtonStyle.Danger))], allowedMentions: NO_MENTIONS };
}

/** Mensagens novas (reply) precisam do flag efêmero; edições/updates não. */
const asReply = (message) => ({ ...message, flags: EPHEMERAL });

const confirming = new Set(); // evita duplo clique em "Confirmar"

/** /cadastrar foto:<anexo> — inicia (ou reinicia) o cadastro. A foto chega pela própria interação. */
export async function startRegistration(interaction, ctx, attachment, { restart = false } = {}) {
  await ensureSettings(ctx.db, interaction.guildId);
  const existing = await getSession(ctx.db, ctx.config.masterKey, interaction.guildId, interaction.user.id);
  if (existing && !restart) {
    return interaction.editReply({ ...stepMessage(existing, 'Você tem um cadastro em andamento. Continue de onde parou ou reinicie.'),
      components: [row(button('reg:resume', 'Continuar cadastro'), button('reg:restart', 'Descartar e reiniciar', ButtonStyle.Danger))] });
  }
  if (!attachment) {
    throw new UserError('Use /cadastrar e anexe a fotografia vertical 9:16 (JPG, PNG ou WEBP) no campo "foto".');
  }
  const buffer = await downloadAttachment(attachment, { maxBytes: ctx.config.maxImageBytes, timeoutMs: ctx.config.externalTimeoutMs });
  const info = await validateImage(buffer, ctx.config.maxImageBytes);
  const photoPath = await uploadPhoto(ctx.db, ctx.config.bucket, interaction.guildId, buffer, info);
  const session = { guildId: interaction.guildId, userId: interaction.user.id, photoPath, data: {} };
  let oldPhoto;
  try { oldPhoto = await saveSession(ctx.db, ctx.config.masterKey, session, ctx.config.sessionTtlMs); } catch (error) {
    await removePhoto(ctx.db, ctx.config.bucket, photoPath);
    throw error;
  }
  if (oldPhoto) await discardOrphanPhoto(ctx.db, ctx.config.bucket, oldPhoto);
  const saved = await getSession(ctx.db, ctx.config.masterKey, interaction.guildId, interaction.user.id);
  return interaction.editReply({ ...stepMessage(saved, 'Fotografia validada.') });
}

/** Botão do painel público: orienta ou retoma o cadastro em andamento. */
export async function startFromButton(interaction, ctx) {
  const existing = await getSession(ctx.db, ctx.config.masterKey, interaction.guildId, interaction.user.id);
  if (existing) return interaction.reply({ ...asReply(stepMessage(existing, 'Cadastro em andamento encontrado.')), components: [row(button('reg:resume', 'Continuar cadastro'), button('reg:restart', 'Descartar e reiniciar', ButtonStyle.Danger))] });
  return interaction.reply({ content: 'Para cadastrar uma modelo, use o comando **/cadastrar** e anexe a fotografia vertical 9:16 (JPG, PNG ou WEBP, até '
    + `${(ctx.config.maxImageBytes / 1024 / 1024).toFixed(0)} MB). Depois você preenche os dados por etapas.`, flags: EPHEMERAL, allowedMentions: NO_MENTIONS });
}

async function requireSession(interaction, ctx) {
  const session = await getSession(ctx.db, ctx.config.masterKey, interaction.guildId, interaction.user.id);
  if (!session) throw new UserError('Sessão de cadastro inexistente ou expirada. Inicie novamente com /cadastrar.');
  return session; // a sessão é buscada pelo usuário da interação: só quem iniciou consegue retomar
}

async function assertCanRegister(interaction, ctx) {
  if (!(await allowed(interaction, ctx.db, 'register', ctx.config))) throw new UserError('Você não possui o cargo/permissão necessário para esta operação.');
}

async function confirmRegistration(interaction, ctx) {
  const key = `${interaction.guildId}:${interaction.user.id}`;
  if (confirming.has(key)) throw new UserError('Cadastro já está sendo processado.');
  confirming.add(key);
  try {
    await assertCanRegister(interaction, ctx);
    const session = await requireSession(interaction, ctx);
    const missing = REQUIRED_KEYS.filter((k) => !session.data[k]);
    if (missing.length || !session.photoPath) throw new UserError('Cadastro incompleto. Continue o preenchimento.');
    const actor = { id: interaction.user.id, tag: interaction.user.tag || interaction.user.username };
    const model = await createModel(ctx.db, ctx.config.masterKey, interaction.guildId, actor, session.data, session.photoPath);
    await deleteSession(ctx.db, session.id).catch((e) => logger.warn('Falha ao remover sessão concluída.', e));
    let note = '';
    try {
      const settings = await getSettings(ctx.db, interaction.guildId);
      await publishModel(ctx, settings, model);
      await record(ctx, interaction, 'model_created_published', model.id);
    } catch (error) {
      logger.warn('Cadastro salvo, mas a publicação falhou.', error);
      note = ` ⚠️ Os dados foram salvos, mas a publicação falhou${error instanceof UserError ? `: ${error.message}` : '.'} Use /modelo publicar id:${model.public_id} depois de corrigir.`;
    }
    return interaction.editReply({ content: `Cadastro concluído! Modelo #${model.public_id} salva.${note}`, embeds: [], components: [], allowedMentions: NO_MENTIONS });
  } finally { confirming.delete(key); }
}

export async function handleRegistration(interaction, ctx) {
  const id = interaction.customId;
  if (interaction.isButton()) {
    if (id === 'reg:resume' || id === 'reg:restart') {
      await assertCanRegister(interaction, ctx);
      if (id === 'reg:restart') {
        const s = await getSession(ctx.db, ctx.config.masterKey, interaction.guildId, interaction.user.id);
        if (s) { await deleteSession(ctx.db, s.id); await discardOrphanPhoto(ctx.db, ctx.config.bucket, s.photoPath); }
        return interaction.update({ content: 'Cadastro anterior descartado. Use /cadastrar e anexe a nova fotografia.', embeds: [], components: [] });
      }
      return interaction.update(stepMessage(await requireSession(interaction, ctx), 'Retomando cadastro.'));
    }
    if (id.startsWith('reg:open:')) {
      await assertCanRegister(interaction, ctx);
      const step = id.slice('reg:open:'.length);
      if (!STEPS.includes(step)) throw new UserError('Etapa inválida.');
      const session = await requireSession(interaction, ctx);
      return interaction.showModal(stepModal(step, session.data));
    }
    if (id === 'reg:cancel') {
      const s = await getSession(ctx.db, ctx.config.masterKey, interaction.guildId, interaction.user.id);
      if (s) { await deleteSession(ctx.db, s.id); await discardOrphanPhoto(ctx.db, ctx.config.bucket, s.photoPath); }
      return interaction.update({ content: 'Cadastro cancelado.', embeds: [], components: [] });
    }
    if (id === 'reg:confirm') {
      await interaction.deferUpdate();
      return confirmRegistration(interaction, ctx);
    }
  }
  if (interaction.isModalSubmit() && id.startsWith('reg:') && id.endsWith(':submit')) {
    await assertCanRegister(interaction, ctx);
    const step = id.split(':')[1];
    if (!STEPS.includes(step)) throw new UserError('Etapa inválida.');
    const session = await requireSession(interaction, ctx);
    Object.assign(session.data, validateStep(step, (k) => interaction.fields.getTextInputValue(k)));
    await touchSession(ctx.db, ctx.config.masterKey, session, ctx.config.sessionTtlMs);
    return interaction.reply(asReply(stepMessage(session, `${STEP_LABEL[step]} salvo.`)));
  }
}

/** Remove sessões expiradas (e fotos temporárias associadas). Chamado no boot e periodicamente. */
export async function cleanupSessions(db, bucket) {
  const removed = await cleanupExpiredSessions(db, bucket);
  if (removed) logger.info(`${removed} sessão(ões) de cadastro expirada(s) removida(s).`);
  return removed;
}
