import { EmbedBuilder } from 'discord.js';
import { audit, auditContext, sanitizeMetadata } from './audit.js';
import { getSettings } from '../security/permissions.js';
import { logger } from '../utils/logger.js';
import { truncate } from '../utils/text.js';

const ACTION_LABEL = {
  model_created: 'Modelo cadastrada', model_created_published: 'Modelo cadastrada e publicada', model_updated: 'Modelo editada',
  model_photo_replaced: 'Foto substituída', model_featured: 'Modelo destacada', model_unfeatured: 'Destaque removido',
  model_republished: 'Ficha republicada', model_deleted: 'Modelo excluída', credentials_viewed: 'Credenciais consultadas',
  credentials_updated: 'Credenciais alteradas', settings_updated: 'Configuração alterada', registration_center_published: 'Central de cadastro publicada'
};

/** Envia um resumo (SEM dados sensíveis) ao canal de logs configurado. Falhas nunca afetam a operação. */
export async function notifyLogChannel(ctx, guildId, actor, action, modelId, metadata) {
  try {
    const settings = await getSettings(ctx.db, guildId);
    if (!settings?.logs_channel_id) return;
    const channel = await ctx.client.channels.fetch(settings.logs_channel_id).catch(() => null);
    if (!channel?.isTextBased() || channel.guildId !== guildId) return;
    const meta = sanitizeMetadata(metadata);
    const embed = new EmbedBuilder().setColor(0x95A5A6).setTitle(truncate(`📋 ${ACTION_LABEL[action] || action}`, 256))
      .addFields({ name: 'Usuário', value: actor?.id ? `<@${actor.id}>` : 'Desconhecido', inline: true });
    if (modelId) embed.addFields({ name: 'Modelo (UUID)', value: `\`${modelId}\``, inline: true });
    const extra = Object.entries(meta).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n');
    if (extra) embed.addFields({ name: 'Detalhes', value: truncate(extra, 1024) });
    embed.setTimestamp();
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (error) {
    logger.warn('Não foi possível enviar registro ao canal de logs.', error);
  }
}

/** Auditoria no banco + resumo no canal de logs. `required` torna a auditoria no banco obrigatória. */
export async function record(ctx, interaction, action, modelId = null, metadata = {}, options = {}) {
  const context = auditContext(interaction);
  await audit(ctx.db, context, action, modelId, metadata, options);
  await notifyLogChannel(ctx, context.guildId, context.actor, action, modelId, metadata);
}
