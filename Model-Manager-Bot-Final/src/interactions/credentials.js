import { ActionRowBuilder, EmbedBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, escapeMarkdown } from 'discord.js';
import { assertPermission } from '../security/permissions.js';
import { changePasswords, revealCredentials } from '../services/actions.js';
import { requireModel, PLATFORMS } from '../services/models.js';
import { UserError } from '../utils/errors.js';
import { FIELD_LIMITS, cleanPassword, isUuid } from '../utils/validators.js';
import { display } from '../utils/text.js';
import { logger } from '../utils/logger.js';

const EPHEMERAL = MessageFlags.Ephemeral;
const LABELS = { gmail: 'Gmail', facebook: 'Facebook', tiktok: 'TikTok', instagram: 'Instagram' };
const AUTO_DELETE_MS = 120_000;

const spoiler = (value) => `||${escapeMarkdown(String(value))}||`;

/** Monta o embed de credenciais. Só deve ser enviado como resposta EFÊMERA. */
export function credentialsEmbed(model, secrets) {
  const logins = { gmail: model.gmail, facebook: model.facebook_email, tiktok: model.tiktok_email, instagram: model.instagram_email };
  return new EmbedBuilder().setColor(0xE67E22).setTitle(`🔐 Credenciais — Modelo #${model.public_id}`)
    .setDescription('Resposta privada. Não compartilhe estas informações. A mensagem será removida automaticamente.')
    .addFields(PLATFORMS.map((p) => ({
      name: LABELS[p],
      value: `Login: ${escapeMarkdown(display(logins[p], 300))}\nSenha: ${spoiler(secrets[`${p}_password`])}`.slice(0, 1024)
    })));
}

/** /credenciais id — a interação já foi adiada como efêmera pelo roteador. */
export async function showCredentials(interaction, ctx, identifier) {
  await assertPermission(interaction, ctx.db, 'credentials', ctx.config);
  const { model, secrets } = await revealCredentials(ctx, interaction, identifier);
  await interaction.editReply({ embeds: [credentialsEmbed(model, secrets)], allowedMentions: { parse: [] } });
  // Remoção automática: reduz o tempo em que as senhas ficam visíveis no histórico do cliente.
  setTimeout(() => { interaction.deleteReply().catch(() => {}); }, AUTO_DELETE_MS).unref();
}

/** /modelo senhas id — abre modal com 4 campos opcionais (vazio = manter senha atual). */
export async function openPasswordModal(interaction, ctx, identifier) {
  await assertPermission(interaction, ctx.db, 'credentials', ctx.config);
  const model = await requireModel(ctx.db, interaction.guildId, identifier);
  const modal = new ModalBuilder().setCustomId(`pwd:${model.id}`).setTitle(`Senhas — Modelo #${model.public_id}`.slice(0, 45));
  for (const p of PLATFORMS) {
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId(`${p}_password`).setLabel(`Nova senha ${LABELS[p]} (vazio = manter)`.slice(0, 45))
      .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(FIELD_LIMITS.password)));
  }
  return interaction.showModal(modal);
}

export async function handlePasswordModal(interaction, ctx) {
  const modelId = interaction.customId.slice(4);
  if (!isUuid(modelId)) throw new UserError('Formulário inválido.');
  await assertPermission(interaction, ctx.db, 'credentials', ctx.config);
  const passwords = {};
  for (const p of PLATFORMS) {
    const raw = interaction.fields.getTextInputValue(`${p}_password`);
    if (raw && raw.length) passwords[`${p}_password`] = cleanPassword(raw, `Senha do ${LABELS[p]}`);
  }
  if (!Object.keys(passwords).length) throw new UserError('Nenhuma senha informada. Nada foi alterado.');
  const { model, changed } = await changePasswords(ctx, interaction, modelId, passwords);
  logger.info(`Senhas atualizadas para a modelo #${model.public_id}.`); // sem valores
  return interaction.reply({ content: `Senhas atualizadas (${changed.map((c) => LABELS[c]).join(', ')}) — Modelo #${model.public_id}.`, flags: EPHEMERAL, allowedMentions: { parse: [] } });
}
