import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } from 'discord.js';
import { downloadPhoto, photoFileName } from './images.js';
import { setPublicationRefs } from './models.js';
import { UserError } from '../utils/errors.js';
import { LIMITS, display, escapeText, link, truncate } from '../utils/text.js';
import { logger } from '../utils/logger.js';

const NO_MENTIONS = Object.freeze({ parse: [] });
const UNKNOWN_MESSAGE = 10008;
const NO_ACCESS = new Set([50001, 50013, 50007]);

export const noMentions = () => ({ parse: [], repliedUser: false });

function social(name, nick, url) {
  return `${display(escapeText(name), 200)}\n${display(escapeText(nick), 200)}\n${link(url)}`;
}

/** Embed da ficha. Nunca contém senhas. Todos os campos respeitam os limites do Discord. */
export function buildModelEmbed(model, imageName) {
  const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('📸 IDENTIDADE DA MODELO')
    .setDescription(truncate(`**Nome:** ${display(escapeText(model.name), 200)}\n**Nome artístico:** ${display(escapeText(model.stage_name), 200)}`, LIMITS.description))
    .addFields(
      { name: '📧 GMAIL', value: truncate(display(escapeText(model.gmail)), LIMITS.fieldValue) },
      { name: '📘 FACEBOOK', value: truncate(social(model.facebook_name, model.facebook_nick, model.facebook_link), LIMITS.fieldValue) },
      { name: '🎵 TIKTOK', value: truncate(social(model.tiktok_name, model.tiktok_nick, model.tiktok_link), LIMITS.fieldValue) },
      { name: '📸 INSTAGRAM', value: truncate(social(model.instagram_name, model.instagram_nick, model.instagram_link), LIMITS.fieldValue) },
      { name: '📝 OBSERVAÇÕES', value: truncate(display(escapeText(model.observations), LIMITS.fieldValue, 'Sem observações'), LIMITS.fieldValue) }
    )
    .setFooter({ text: truncate(`ID #${model.public_id} • Cadastro ${new Date(model.created_at).toLocaleDateString('pt-BR')} • ${model.created_by_tag}`, LIMITS.footer) });
  if (imageName) embed.setImage(`attachment://${imageName}`);
  return fitEmbed(embed);
}

/** O Discord limita a soma de todos os textos do embed a 6000 caracteres: reduz campos longos até caber. */
export function fitEmbed(embed, budget = 5800) {
  const size = () => {
    const d = embed.data;
    return (d.title?.length || 0) + (d.description?.length || 0) + (d.footer?.text?.length || 0)
      + (d.fields || []).reduce((n, f) => n + f.name.length + f.value.length, 0);
  };
  let guard = 0;
  while (size() > budget && guard++ < 50) {
    const d = embed.data;
    const target = (d.fields || []).reduce((a, f) => (f.value.length > a.value.length ? f : a), { value: '' });
    if (target.value.length > 200) target.value = truncate(target.value, Math.floor(target.value.length * 0.7));
    else if (d.description?.length > 400) d.description = truncate(d.description, 400);
    else break;
  }
  return embed;
}

export function featureRow(model) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`model:feature:${model.id}`)
      .setLabel(model.is_featured ? 'Remover destaque' : 'Destacar modelo').setEmoji('⭐')
      .setStyle(model.is_featured ? ButtonStyle.Secondary : ButtonStyle.Primary)
  );
}

export async function modelPayload(db, bucket, model, { withButtons = true } = {}) {
  const buffer = await downloadPhoto(db, bucket, model.photo_path);
  const name = photoFileName(model.photo_path);
  const payload = {
    embeds: [buildModelEmbed(model, name)],
    files: [new AttachmentBuilder(buffer, { name })],
    allowedMentions: NO_MENTIONS
  };
  if (withButtons) payload.components = [featureRow(model)];
  return payload;
}

function featuredEmbed(model, imageName) {
  return new EmbedBuilder().setColor(0xF1C40F).setTitle('⭐ MODELO EM DESTAQUE')
    .setDescription(truncate(`**${display(escapeText(model.stage_name), 200)}**\nIdentificação: #${model.public_id}`, LIMITS.description))
    .setImage(`attachment://${imageName}`);
}

/** Traduz erros de permissão do Discord em mensagens úteis (sem detalhes internos). */
function mapDiscordError(error, channelId) {
  if (error instanceof UserError) return error;
  if (NO_ACCESS.has(error?.code)) {
    return new UserError(`O bot não tem permissão para ver/enviar mensagens e anexar arquivos em <#${channelId}>.`);
  }
  return error;
}

async function fetchChannel(client, guildId, channelId, missingMessage) {
  if (!channelId) throw new UserError(missingMessage);
  let channel;
  try { channel = await client.channels.fetch(channelId); } catch (error) {
    if (NO_ACCESS.has(error?.code)) throw mapDiscordError(error, channelId);
    channel = null;
  }
  // Isolamento entre servidores: o canal configurado precisa pertencer à guild da modelo.
  if (!channel?.isTextBased() || channel.guildId !== guildId) throw new UserError(`${missingMessage.replace(/ não configurado.*/, '')} inacessível. Reconfigure em /painel.`);
  return channel;
}

async function fetchMessage(channel, messageId) {
  if (!messageId) return null;
  try { return await channel.messages.fetch(messageId); } catch (error) {
    if (error?.code === UNKNOWN_MESSAGE) return null; // mensagem apagada manualmente
    if (NO_ACCESS.has(error?.code)) throw mapDiscordError(error, channel.id);
    throw error;
  }
}

async function deleteQuietly(message) {
  try { await message?.delete(); return true; } catch (error) {
    logger.warn('Não foi possível apagar mensagem antiga.', error);
    return false;
  }
}

/**
 * Publica ou atualiza a ficha. Em qualquer falha os dados do banco permanecem intactos;
 * o chamador pode repetir a operação (comando /modelo publicar).
 */
export async function publishModel(ctx, settings, model) {
  const { client, db, config } = ctx;
  const channelId = settings?.models_channel_id;
  const channel = await fetchChannel(client, model.guild_id, channelId, 'Canal de publicação não configurado');
  const payload = await modelPayload(db, config.bucket, model);
  const storedChannel = model.public_channel_id || channelId;
  let message = null;
  try {
    if (model.public_message_id) {
      if (storedChannel === channelId) {
        message = await fetchMessage(channel, model.public_message_id);
        if (message) message = await message.edit({ ...payload, attachments: [] });
      } else { // canal de publicação mudou: remove a ficha antiga e republica no canal novo
        const old = await client.channels.fetch(storedChannel).catch(() => null);
        await deleteQuietly(await fetchMessage(old, model.public_message_id).catch(() => null));
      }
    }
    if (!message) message = await channel.send(payload);
  } catch (error) { throw mapDiscordError(error, channelId); }
  try {
    await setPublicationRefs(db, model.guild_id, model.id, { public_message_id: message.id, public_channel_id: channel.id });
  } catch (error) {
    if (message.id !== model.public_message_id) await deleteQuietly(message); // evita mensagem órfã sem registro
    throw error;
  }
  return message;
}

export async function publishFeatured(ctx, settings, model) {
  const { client, db, config } = ctx;
  const channelId = settings?.featured_channel_id;
  const channel = await fetchChannel(client, model.guild_id, channelId, 'Canal de destaques não configurado');
  const buffer = await downloadPhoto(db, config.bucket, model.photo_path);
  const name = photoFileName(model.photo_path);
  const payload = { embeds: [featuredEmbed(model, name)], files: [new AttachmentBuilder(buffer, { name })], allowedMentions: NO_MENTIONS };
  const storedChannel = model.featured_channel_id || channelId;
  let message = null;
  try {
    if (model.featured_message_id) {
      if (storedChannel === channelId) {
        message = await fetchMessage(channel, model.featured_message_id);
        if (message) message = await message.edit({ ...payload, attachments: [] });
      } else {
        const old = await client.channels.fetch(storedChannel).catch(() => null);
        await deleteQuietly(await fetchMessage(old, model.featured_message_id).catch(() => null));
      }
    }
    if (!message) message = await channel.send(payload);
  } catch (error) { throw mapDiscordError(error, channelId); }
  try {
    await setPublicationRefs(db, model.guild_id, model.id, { featured_message_id: message.id, featured_channel_id: channel.id });
  } catch (error) {
    if (message.id !== model.featured_message_id) await deleteQuietly(message);
    throw error;
  }
  return message;
}

async function deleteStored(client, guildId, channelId, messageId) {
  if (!channelId || !messageId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || channel.guildId !== guildId) return;
  await deleteQuietly(await fetchMessage(channel, messageId).catch(() => null));
}

export async function removeFeatured(ctx, settings, model) {
  const channelId = model.featured_channel_id || settings?.featured_channel_id;
  await deleteStored(ctx.client, model.guild_id, channelId, model.featured_message_id);
  await setPublicationRefs(ctx.db, model.guild_id, model.id, { featured_message_id: null, featured_channel_id: null });
}

/** Apaga as publicações (ficha e destaque) de uma modelo que será excluída. Nunca lança. */
export async function removePublications(ctx, settings, model) {
  try {
    await deleteStored(ctx.client, model.guild_id, model.public_channel_id || settings?.models_channel_id, model.public_message_id);
    await deleteStored(ctx.client, model.guild_id, model.featured_channel_id || settings?.featured_channel_id, model.featured_message_id);
  } catch (error) { logger.warn('Falha ao remover publicações da modelo.', error); }
}

/** Atualiza ficha (e destaque, se houver) após edição; retorna lista de avisos em vez de lançar. */
export async function syncPublications(ctx, settings, model) {
  const warnings = [];
  try { await publishModel(ctx, settings, model); } catch (error) {
    logger.warn('Falha ao sincronizar ficha pública.', error);
    warnings.push(error instanceof UserError ? error.message : 'Não foi possível atualizar a ficha pública.');
  }
  if (model.is_featured && model.featured_message_id) {
    try { await publishFeatured(ctx, settings, model); } catch (error) {
      logger.warn('Falha ao sincronizar destaque.', error);
      warnings.push(error instanceof UserError ? error.message : 'Não foi possível atualizar o destaque.');
    }
  }
  return warnings;
}
