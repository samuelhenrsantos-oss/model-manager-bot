import { PermissionFlagsBits } from 'discord.js';
import { UserError } from '../utils/errors.js';

const roleField = Object.freeze({
  register: 'register_role_id', edit: 'edit_role_id', delete: 'delete_role_id',
  view: 'view_role_id', credentials: 'credentials_role_id', feature: 'feature_role_id'
});
export const PERMISSION_ACTIONS = Object.freeze(Object.keys(roleField));

const DENIED = 'Você não possui o cargo/permissão necessário para esta operação.';

// Cache curto de configurações: evita consulta ao banco a cada clique e ajuda a
// responder dentro dos 3 segundos que o Discord exige para modais/botões.
const CACHE_TTL_MS = 15_000;
const cache = new Map();

export function invalidateSettings(guildId) { cache.delete(guildId); }
export function clearSettingsCache() { cache.clear(); }

export async function getSettings(db, guildId, { fresh = false } = {}) {
  const hit = cache.get(guildId);
  if (!fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const { data, error } = await db.from('guild_settings').select('*').eq('guild_id', guildId).maybeSingle();
  if (error) throw error;
  cache.set(guildId, { at: Date.now(), value: data });
  return data;
}

export async function ensureSettings(db, guildId) {
  // ignoreDuplicates: não sobrescreve configurações existentes; a leitura abaixo traz a linha final.
  const { error } = await db.from('guild_settings').upsert({ guild_id: guildId }, { onConflict: 'guild_id', ignoreDuplicates: true });
  if (error) throw error;
  return getSettings(db, guildId, { fresh: true });
}

export async function saveSettings(db, guildId, patch) {
  const { error } = await db.from('guild_settings').upsert({ guild_id: guildId, ...patch }, { onConflict: 'guild_id' });
  if (error) throw error;
  invalidateSettings(guildId);
}

/** Administrador = permissão Administrator do Discord OU usuário/cargo listado no .env. */
export function isAdmin(interaction, config = {}) {
  if (!interaction.guild || !interaction.member) return false;
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  if (config.adminUserIds?.includes(interaction.user?.id)) return true;
  const roles = interaction.member.roles?.cache;
  return Boolean(config.adminRoleIds?.some((id) => roles?.has(id)));
}

export async function allowed(interaction, db, action, config = {}) {
  if (!interaction.guild || !interaction.member) return false;
  if (!Object.hasOwn(roleField, action)) return false; // ação desconhecida: nega por padrão
  if (isAdmin(interaction, config)) return true;
  const settings = await getSettings(db, interaction.guildId);
  const roleId = settings?.[roleField[action]];
  if (!roleId) return false;
  return Boolean(interaction.member.roles?.cache?.has(roleId));
}

/** Para uso quando já houve (ou não) resposta à interação: lança UserError se negado. */
export async function assertPermission(interaction, db, action, config) {
  if (!(await allowed(interaction, db, action, config))) throw new UserError(DENIED);
}

export async function assertAdmin(interaction, config) {
  if (!isAdmin(interaction, config)) throw new UserError('Somente administradores podem executar esta operação.');
}
