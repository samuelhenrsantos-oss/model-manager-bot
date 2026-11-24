import { SlashCommandBuilder, PermissionFlagsBits, InteractionContextType, ApplicationIntegrationType } from 'discord.js';

const idOption = (o) => o.setName('id').setDescription('ID público (ex.: 12) ou UUID').setRequired(true).setMaxLength(36);
const guildOnly = (b) => b.setContexts(InteractionContextType.Guild).setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

export const EDIT_CHOICES = Object.freeze([
  { name: 'Nome', value: 'name' }, { name: 'Nome artístico', value: 'stage_name' }, { name: 'Gmail', value: 'gmail' },
  { name: 'Observações', value: 'observations' },
  { name: 'Facebook — nome', value: 'facebook_name' }, { name: 'Facebook — nick', value: 'facebook_nick' }, { name: 'Facebook — link', value: 'facebook_link' },
  { name: 'TikTok — nome', value: 'tiktok_name' }, { name: 'TikTok — nick', value: 'tiktok_nick' }, { name: 'TikTok — link', value: 'tiktok_link' },
  { name: 'Instagram — nome', value: 'instagram_name' }, { name: 'Instagram — nick', value: 'instagram_nick' }, { name: 'Instagram — link', value: 'instagram_link' }
]);

export const commandDefinitions = [
  guildOnly(new SlashCommandBuilder().setName('ping').setDescription('Verifica se o bot está respondendo.')),
  guildOnly(new SlashCommandBuilder().setName('painel').setDescription('Abre o painel de configuração (administradores).')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)),
  guildOnly(new SlashCommandBuilder().setName('painel-cadastro').setDescription('Publica a central de cadastro no canal configurado.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)),
  guildOnly(new SlashCommandBuilder().setName('cadastrar').setDescription('Inicia o cadastro de uma modelo (envie a foto vertical 9:16).')
    .addAttachmentOption((o) => o.setName('foto').setDescription('Fotografia vertical 9:16 (JPG, PNG ou WEBP)').setRequired(false))),
  guildOnly(new SlashCommandBuilder().setName('modelos').setDescription('Lista modelos cadastradas.')
    .addIntegerOption((o) => o.setName('pagina').setDescription('Página').setMinValue(1).setMaxValue(100000))
    .addBooleanOption((o) => o.setName('destaques').setDescription('Mostrar somente destaques'))),
  guildOnly(new SlashCommandBuilder().setName('modelo').setDescription('Gerencia uma modelo.')
    .addSubcommand((s) => s.setName('buscar').setDescription('Pesquisa modelos.')
      .addStringOption((o) => o.setName('termo').setDescription('Nome, artístico, nick ou ID').setRequired(true).setMaxLength(64)))
    .addSubcommand((s) => s.setName('ver').setDescription('Consulta modelo pelo ID.').addStringOption(idOption))
    .addSubcommand((s) => s.setName('editar').setDescription('Edita um campo textual.').addStringOption(idOption)
      .addStringOption((o) => o.setName('campo').setDescription('Campo').setRequired(true).addChoices(...EDIT_CHOICES))
      .addStringOption((o) => o.setName('valor').setDescription('Novo valor').setRequired(true).setMaxLength(1000)))
    .addSubcommand((s) => s.setName('foto').setDescription('Substitui a fotografia (9:16).').addStringOption(idOption)
      .addAttachmentOption((o) => o.setName('imagem').setDescription('Nova fotografia vertical 9:16').setRequired(true)))
    .addSubcommand((s) => s.setName('senhas').setDescription('Cadastra/edita as senhas (formulário privado).').addStringOption(idOption))
    .addSubcommand((s) => s.setName('excluir').setDescription('Exclui modelo após confirmação.').addStringOption(idOption))
    .addSubcommand((s) => s.setName('destaque').setDescription('Marca ou desmarca destaque.').addStringOption(idOption))
    .addSubcommand((s) => s.setName('publicar').setDescription('Publica/atualiza a ficha nos canais configurados.').addStringOption(idOption))),
  guildOnly(new SlashCommandBuilder().setName('credenciais').setDescription('Consulta credenciais em resposta privada e auditada.').addStringOption(idOption))
].map((c) => c.toJSON());
