import {
  EmbedBuilder, ActionRowBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder,
  ChannelType, ButtonBuilder, ButtonStyle, PermissionFlagsBits, MessageFlags
} from 'discord.js';
import { ensureSettings, assertAdmin, saveSettings } from '../security/permissions.js';
import { record } from '../services/logchannel.js';
import { UserError } from '../utils/errors.js';

const EPHEMERAL = MessageFlags.Ephemeral;
export const CHANNEL_FIELDS = Object.freeze(['registration_channel_id', 'models_channel_id', 'featured_channel_id', 'logs_channel_id']);
export const ROLE_FIELDS = Object.freeze(['register_role_id', 'edit_role_id', 'delete_role_id', 'view_role_id', 'credentials_role_id', 'feature_role_id']);
const CHANNEL_LABEL = { registration_channel_id: 'Canal de cadastro', models_channel_id: 'Canal de publicação', featured_channel_id: 'Canal de destaques', logs_channel_id: 'Canal de logs' };
const ROLE_LABEL = { register_role_id: 'Cadastrar', edit_role_id: 'Editar', delete_role_id: 'Excluir', view_role_id: 'Consultar', credentials_role_id: 'Credenciais', feature_role_id: 'Destaques' };
const REQUIRED_BOT_PERMS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory];

const mention = (id, prefix) => (id ? `<${prefix}${id}>` : 'Não definido');

export async function showAdminPanel(interaction, ctx) {
  await assertAdmin(interaction, ctx.config);
  const s = await ensureSettings(ctx.db, interaction.guildId);
  const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('⚙️ Model Manager — Configurações')
    .setDescription('Selecione os canais e cargos responsáveis por cada operação. As alterações são salvas imediatamente. Administradores sempre têm acesso total.')
    .addFields(
      { name: 'Canais', value: CHANNEL_FIELDS.map((f) => `${CHANNEL_LABEL[f]}: ${mention(s[f], '#')}`).join('\n') },
      { name: 'Cargos', value: ROLE_FIELDS.map((f) => `${ROLE_LABEL[f]}: ${mention(s[f], '@&')}`).join('\n') }
    );
  const channelRows = CHANNEL_FIELDS.map((f) => new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId(`cfg:${f}`).setPlaceholder(CHANNEL_LABEL[f]).setChannelTypes(ChannelType.GuildText)));
  channelRows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panel:publish-registration').setLabel('Publicar central de cadastro').setEmoji('📣').setStyle(ButtonStyle.Success)));
  const roleRows = (fields) => fields.map((f) => new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder().setCustomId(`cfg:${f}`).setPlaceholder(`Cargo — ${ROLE_LABEL[f]}`)));
  await interaction.editReply({ embeds: [embed], components: channelRows });
  await interaction.followUp({ content: '**Cargos — cadastrar, editar e excluir**', components: roleRows(ROLE_FIELDS.slice(0, 3)), flags: EPHEMERAL, allowedMentions: { parse: [] } });
  await interaction.followUp({ content: '**Cargos — consultar, credenciais e destaques**', components: roleRows(ROLE_FIELDS.slice(3)), flags: EPHEMERAL, allowedMentions: { parse: [] } });
}

/** Publica (ou atualiza) a mensagem com o botão de cadastro no canal configurado. */
export async function publishRegistrationCenter(interaction, ctx) {
  await assertAdmin(interaction, ctx.config);
  const s = await ensureSettings(ctx.db, interaction.guildId);
  if (!s.registration_channel_id) throw new UserError('Configure o canal de cadastro primeiro com /painel.');
  const channel = await ctx.client.channels.fetch(s.registration_channel_id).catch(() => null);
  if (!channel?.isTextBased() || channel.guildId !== interaction.guildId) throw new UserError('Canal de cadastro indisponível. Reconfigure em /painel.');
  const payload = {
    embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('📸 CENTRAL DE CADASTRO DE MODELOS')
      .setDescription('Para cadastrar uma nova modelo use o comando **/cadastrar** anexando uma fotografia vertical 9:16. Depois, preencha os dados pelos formulários.')],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('registration:start').setLabel('Criar modelo').setEmoji('➕').setStyle(ButtonStyle.Success))],
    allowedMentions: { parse: [] }
  };
  let message = null;
  if (s.registration_message_id && (s.registration_message_channel_id || s.registration_channel_id) === channel.id) {
    message = await channel.messages.fetch(s.registration_message_id).catch(() => null);
    if (message) message = await message.edit(payload).catch(() => null);
  }
  try { if (!message) message = await channel.send(payload); } catch (error) {
    if ([50001, 50013].includes(error?.code)) throw new UserError('O bot não tem permissão para enviar mensagens e embeds no canal de cadastro.');
    throw error;
  }
  await saveSettings(ctx.db, interaction.guildId, { registration_message_id: message.id, registration_message_channel_id: channel.id });
  await record(ctx, interaction, 'registration_center_published');
  return message;
}

export async function handlePanelComponent(interaction, ctx) {
  await assertAdmin(interaction, ctx.config);
  const id = interaction.customId;
  if (interaction.isButton() && id === 'panel:publish-registration') {
    await interaction.deferReply({ flags: EPHEMERAL });
    await publishRegistrationCenter(interaction, ctx);
    return interaction.editReply('Central de cadastro publicada/atualizada.');
  }
  if (!id.startsWith('cfg:')) return;
  const field = id.slice(4);
  const isChannel = CHANNEL_FIELDS.includes(field);
  if (!isChannel && !ROLE_FIELDS.includes(field)) throw new UserError('Configuração desconhecida.');
  const selected = interaction.values?.[0];
  if (!selected) throw new UserError('Nenhuma opção selecionada.');
  let warning = '';
  if (!isChannel && selected === interaction.guildId) throw new UserError('O cargo @everyone não pode ser usado (daria acesso a todos).');
  if (isChannel) {
    const channel = await interaction.guild.channels.fetch(selected).catch(() => null);
    if (!channel) throw new UserError('Canal não encontrado neste servidor.');
    const perms = channel.permissionsFor(interaction.guild.members.me);
    if (field !== 'logs_channel_id' && !perms?.has(REQUIRED_BOT_PERMS)) {
      warning = '\n⚠️ O bot ainda não tem todas as permissões necessárias nesse canal (Ver canal, Enviar mensagens, Inserir links, Anexar arquivos, Ler histórico).';
    } else if (field === 'logs_channel_id' && !perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
      warning = '\n⚠️ O bot não consegue enviar embeds nesse canal de logs.';
    }
  }
  await ensureSettings(ctx.db, interaction.guildId);
  await saveSettings(ctx.db, interaction.guildId, { [field]: selected });
  await record(ctx, interaction, 'settings_updated', null, { field });
  return interaction.reply({ content: `Configuração salva.${warning}`, flags: EPHEMERAL, allowedMentions: { parse: [] } });
}
