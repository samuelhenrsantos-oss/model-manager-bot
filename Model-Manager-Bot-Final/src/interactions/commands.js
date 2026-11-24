import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { assertPermission } from '../security/permissions.js';
import { editField, replacePhoto, republish, toggleFeature } from '../services/actions.js';
import { PAGE_SIZE, listModels, requireModel, searchModels } from '../services/models.js';
import { modelPayload } from '../services/publisher.js';
import { openPasswordModal, showCredentials } from './credentials.js';
import { publishRegistrationCenter, showAdminPanel } from './panels.js';
import { startRegistration } from './registration.js';
import { UserError } from '../utils/errors.js';
import { LIMITS, display, escapeText, truncate } from '../utils/text.js';

const NO_MENTIONS = { parse: [] };

const modelLine = (m) => `**#${m.public_id}** — ${display(escapeText(m.stage_name), 80)} (${display(escapeText(m.name), 80)}) ${m.is_featured ? '⭐' : ''}`.trim();

/** Mensagem da listagem paginada (usada pelo comando e pelos botões). */
export function buildListPayload(result, featured) {
  const { page, pages } = result;
  const flag = featured ? 1 : 0;
  const description = truncate(result.data.map(modelLine).join('\n') || 'Nenhuma modelo encontrada.', LIMITS.description);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`list:${Math.max(1, page - 1)}:${flag}`).setLabel('Anterior').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`list:${Math.min(pages, page + 1)}:${flag}`).setLabel('Próxima').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages)
  );
  return {
    embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle(`Modelos${featured ? ' em destaque' : ''} — página ${page}/${pages}`)
      .setDescription(description).setFooter({ text: `${result.count} registro(s) • ${PAGE_SIZE} por página` })],
    components: [row], allowedMentions: NO_MENTIONS
  };
}

const warningText = (warnings) => (warnings.length ? `\n⚠️ ${warnings.join('\n⚠️ ')}` : '');
const reply = (interaction, content) => interaction.editReply({ content, allowedMentions: NO_MENTIONS });

export const subcommandHandlers = {
  async buscar(interaction, ctx) {
    await assertPermission(interaction, ctx.db, 'view', ctx.config);
    const results = await searchModels(ctx.db, interaction.guildId, interaction.options.getString('termo', true));
    const description = truncate(results.map(modelLine).join('\n') || 'Nenhum resultado.', LIMITS.description);
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle(`Resultados (${results.length})`).setDescription(description)], allowedMentions: NO_MENTIONS });
  },
  async ver(interaction, ctx) {
    await assertPermission(interaction, ctx.db, 'view', ctx.config);
    const model = await requireModel(ctx.db, interaction.guildId, interaction.options.getString('id', true));
    return interaction.editReply(await modelPayload(ctx.db, ctx.config.bucket, model, { withButtons: false }));
  },
  async editar(interaction, ctx) {
    await assertPermission(interaction, ctx.db, 'edit', ctx.config);
    const { model, warnings } = await editField(ctx, interaction, interaction.options.getString('id', true), interaction.options.getString('campo', true), interaction.options.getString('valor', true));
    return reply(interaction, `Modelo #${model.public_id} atualizada.${warningText(warnings)}`);
  },
  async foto(interaction, ctx) {
    await assertPermission(interaction, ctx.db, 'edit', ctx.config);
    const { model, warnings } = await replacePhoto(ctx, interaction, interaction.options.getString('id', true), interaction.options.getAttachment('imagem', true));
    return reply(interaction, `Fotografia da modelo #${model.public_id} substituída.${warningText(warnings)}`);
  },
  async senhas(interaction, ctx) {
    return openPasswordModal(interaction, ctx, interaction.options.getString('id', true));
  },
  async excluir(interaction, ctx) {
    await assertPermission(interaction, ctx.db, 'delete', ctx.config);
    const model = await requireModel(ctx.db, interaction.guildId, interaction.options.getString('id', true));
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`delete:yes:${model.id}:${interaction.user.id}:${Date.now()}`).setLabel('Confirmar exclusão').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('delete:no').setLabel('Cancelar').setStyle(ButtonStyle.Secondary));
    return interaction.editReply({ content: `Confirma excluir a modelo #${model.public_id} (${escapeText(model.stage_name)})? Esta ação não pode ser desfeita.`, components: [row], allowedMentions: NO_MENTIONS });
  },
  async destaque(interaction, ctx) {
    await assertPermission(interaction, ctx.db, 'feature', ctx.config);
    const { featured, warnings } = await toggleFeature(ctx, interaction, interaction.options.getString('id', true));
    return reply(interaction, `${featured ? 'Modelo destacada.' : 'Destaque removido.'}${warningText(warnings)}`);
  },
  async publicar(interaction, ctx) {
    await assertPermission(interaction, ctx.db, 'edit', ctx.config);
    const model = await republish(ctx, interaction, interaction.options.getString('id', true));
    return reply(interaction, `Ficha da modelo #${model.public_id} publicada/atualizada.`);
  }
};

export const commandHandlers = {
  ping: (interaction) => reply(interaction, `Pong! ${Math.round(interaction.client.ws.ping)} ms`),
  painel: (interaction, ctx) => showAdminPanel(interaction, ctx),
  async 'painel-cadastro'(interaction, ctx) {
    await publishRegistrationCenter(interaction, ctx);
    return reply(interaction, 'Central de cadastro publicada/atualizada.');
  },
  async cadastrar(interaction, ctx) {
    await assertPermission(interaction, ctx.db, 'register', ctx.config);
    return startRegistration(interaction, ctx, interaction.options.getAttachment('foto'));
  },
  async modelos(interaction, ctx) {
    await assertPermission(interaction, ctx.db, 'view', ctx.config);
    const featured = interaction.options.getBoolean('destaques') || false;
    const result = await listModels(ctx.db, interaction.guildId, interaction.options.getInteger('pagina') || 1, featured);
    return interaction.editReply(buildListPayload(result, featured));
  },
  credenciais: (interaction, ctx) => showCredentials(interaction, ctx, interaction.options.getString('id', true)),
  async modelo(interaction, ctx) {
    const handler = subcommandHandlers[interaction.options.getSubcommand()];
    if (!handler) throw new UserError('Subcomando desconhecido.');
    return handler(interaction, ctx);
  }
};

/** Comandos que respondem com modal: não podem ser adiados (defer) antes. */
export const MODAL_COMMANDS = new Set(['modelo:senhas']);
export const SENSITIVE_COMMANDS = new Set(['credenciais', 'modelo:senhas']);
