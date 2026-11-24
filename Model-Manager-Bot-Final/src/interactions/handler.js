import { MessageFlags } from 'discord.js';
import { allowed } from '../security/permissions.js';
import { removeModel, toggleFeature } from '../services/actions.js';
import { listModels } from '../services/models.js';
import { buildListPayload, commandHandlers, MODAL_COMMANDS, SENSITIVE_COMMANDS } from './commands.js';
import { handlePanelComponent } from './panels.js';
import { handlePasswordModal } from './credentials.js';
import { handleRegistration, startFromButton } from './registration.js';
import { RateLimiter } from '../utils/ratelimit.js';
import { UserError, isDeadInteractionError } from '../utils/errors.js';
import { isUuid, isSnowflake } from '../utils/validators.js';
import { logger } from '../utils/logger.js';

const EPHEMERAL = MessageFlags.Ephemeral;
const DENIED = 'Você não possui o cargo/permissão necessário para esta operação.';
const DELETE_CONFIRM_TTL_MS = 120_000;

const generalLimiter = new RateLimiter({ limit: 12, windowMs: 10_000 });
const sensitiveLimiter = new RateLimiter({ limit: 5, windowMs: 60_000 });
setInterval(() => { generalLimiter.sweep(); sensitiveLimiter.sweep(); }, 60_000).unref();

const noMentions = { parse: [] };

/** Adia a atualização de um componente e marca a interação (para o tratamento de erros). */
async function deferUpdate(interaction) {
  await interaction.deferUpdate();
  interaction.updateDeferred = true;
}

/** Responde com segurança, qualquer que seja o estado da interação. Nunca vaza detalhes internos. */
export async function respond(interaction, content) {
  const payload = { content, embeds: [], components: [], files: [], allowedMentions: noMentions };
  try {
    if (interaction.replied || (interaction.deferred && interaction.updateDeferred)) await interaction.followUp({ ...payload, flags: EPHEMERAL });
    else if (interaction.deferred) await interaction.editReply(payload);
    else await interaction.reply({ ...payload, flags: EPHEMERAL });
  } catch (error) {
    if (!isDeadInteractionError(error)) logger.warn('Não foi possível responder à interação.', error);
  }
}

export function commandKey(interaction) {
  const sub = interaction.options?.getSubcommand?.(false);
  return sub ? `${interaction.commandName}:${sub}` : interaction.commandName;
}

function checkRate(interaction, sensitive) {
  const key = `${interaction.guildId}:${interaction.user.id}`;
  const general = generalLimiter.check(key);
  if (!general.ok) return general;
  return sensitive ? sensitiveLimiter.check(`s:${key}`) : general;
}

async function handleCommand(interaction, ctx) {
  const key = commandKey(interaction);
  const handler = commandHandlers[interaction.commandName];
  if (!handler) throw new UserError('Comando desconhecido.');
  if (!MODAL_COMMANDS.has(key)) await interaction.deferReply({ flags: EPHEMERAL });
  return handler(interaction, ctx);
}

async function handleListButton(interaction, ctx) {
  const [, rawPage, flag] = interaction.customId.split(':');
  const featured = flag === '1';
  if (!(await allowed(interaction, ctx.db, 'view', ctx.config))) throw new UserError(DENIED);
  await deferUpdate(interaction);
  const result = await listModels(ctx.db, interaction.guildId, Number(rawPage), featured);
  return interaction.editReply(buildListPayload(result, featured));
}

async function handleFeatureButton(interaction, ctx) {
  const modelId = interaction.customId.split(':')[2];
  if (!isUuid(modelId)) throw new UserError('Botão inválido.');
  if (!(await allowed(interaction, ctx.db, 'feature', ctx.config))) throw new UserError(DENIED);
  await interaction.deferReply({ flags: EPHEMERAL });
  const { featured, warnings } = await toggleFeature(ctx, interaction, modelId);
  const extra = warnings.length ? `\n⚠️ ${warnings.join('\n⚠️ ')}` : '';
  return interaction.editReply({ content: `${featured ? 'Modelo destacada.' : 'Destaque removido.'}${extra}`, allowedMentions: noMentions });
}

async function handleDeleteButton(interaction, ctx) {
  if (interaction.customId === 'delete:no') return interaction.update({ content: 'Exclusão cancelada.', components: [] });
  const [, , modelId, userId, issuedAt] = interaction.customId.split(':');
  if (!isUuid(modelId) || !isSnowflake(userId)) throw new UserError('Botão inválido.');
  if (userId !== interaction.user.id) throw new UserError('Somente quem solicitou a exclusão pode confirmá-la.');
  if (!Number.isFinite(Number(issuedAt)) || Date.now() - Number(issuedAt) > DELETE_CONFIRM_TTL_MS) {
    return interaction.update({ content: 'Confirmação expirada. Execute /modelo excluir novamente.', components: [] });
  }
  if (!(await allowed(interaction, ctx.db, 'delete', ctx.config))) throw new UserError(DENIED);
  await deferUpdate(interaction);
  try {
    const { model, storageRemoved } = await removeModel(ctx, interaction, modelId);
    const note = storageRemoved ? '' : ' (a limpeza da fotografia no armazenamento falhou e foi registrada em log)';
    return interaction.editReply({ content: `Modelo #${model.public_id} excluída.${note}`, components: [], allowedMentions: noMentions });
  } catch (error) {
    if (error instanceof UserError) return interaction.editReply({ content: error.message, components: [] });
    throw error;
  }
}

export async function handleInteraction(interaction, ctx) {
  const { config } = ctx;
  const isOurs = interaction.isChatInputCommand() || interaction.isMessageComponent() || interaction.isModalSubmit();
  if (!isOurs) return;
  if (!interaction.inGuild()) return respond(interaction, 'Este bot só funciona dentro de servidores.');
  if (config.allowedGuildIds?.length && !config.allowedGuildIds.includes(interaction.guildId)) {
    return respond(interaction, 'Este bot não está autorizado neste servidor.');
  }

  const sensitive = interaction.isChatInputCommand() ? SENSITIVE_COMMANDS.has(commandKey(interaction)) : interaction.customId?.startsWith('pwd:');
  const rate = checkRate(interaction, sensitive);
  if (!rate.ok) return respond(interaction, `Muitas ações em pouco tempo. Aguarde ${Math.ceil(rate.retryAfterMs / 1000)}s e tente novamente.`);

  const id = interaction.customId;
  if (interaction.isChatInputCommand()) return handleCommand(interaction, ctx);
  if (interaction.isModalSubmit()) {
    if (id.startsWith('reg:')) return handleRegistration(interaction, ctx);
    if (id.startsWith('pwd:')) return handlePasswordModal(interaction, ctx);
    return;
  }
  if (interaction.isButton()) {
    if (id === 'registration:start') return startFromButton(interaction, ctx);
    if (id.startsWith('reg:')) return handleRegistration(interaction, ctx);
    if (id.startsWith('panel:')) return handlePanelComponent(interaction, ctx);
    if (id.startsWith('list:')) return handleListButton(interaction, ctx);
    if (id.startsWith('model:feature:')) return handleFeatureButton(interaction, ctx);
    if (id.startsWith('delete:')) return handleDeleteButton(interaction, ctx);
    return;
  }
  if ((interaction.isChannelSelectMenu() || interaction.isRoleSelectMenu()) && id.startsWith('cfg:')) return handlePanelComponent(interaction, ctx);
}
