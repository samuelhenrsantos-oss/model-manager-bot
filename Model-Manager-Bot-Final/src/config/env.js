import { isSnowflake } from '../utils/validators.js';

const required = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'MASTER_KEY'];

function intInRange(env, key, def, min, max) {
  const raw = env[key];
  if (raw === undefined || String(raw).trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${key} deve ser um número entre ${min} e ${max}.`);
  return n;
}

function idList(env, key) {
  const raw = (env[key] || '').trim();
  if (!raw) return [];
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = ids.filter((id) => !isSnowflake(id));
  if (bad.length) throw new Error(`${key} contém IDs inválidos (use IDs numéricos do Discord separados por vírgula).`);
  return ids;
}

export function validateEnv(env = process.env) {
  const missing = required.filter((key) => !env[key]?.trim());
  if (missing.length) throw new Error(`Variáveis obrigatórias ausentes: ${missing.join(', ')}`);

  let url;
  try { url = new URL(env.SUPABASE_URL); } catch { throw new Error('SUPABASE_URL inválida.'); }
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('SUPABASE_URL deve usar HTTPS (HTTP só é aceito para localhost).');
  }
  if (!/^[a-fA-F0-9]{64}$/.test(env.MASTER_KEY)) {
    throw new Error('MASTER_KEY deve conter exatamente 64 caracteres hexadecimais (32 bytes).');
  }
  if (!isSnowflake(env.DISCORD_CLIENT_ID)) throw new Error('DISCORD_CLIENT_ID inválido (ID numérico da aplicação).');
  if (env.DISCORD_GUILD_ID && !isSnowflake(env.DISCORD_GUILD_ID)) throw new Error('DISCORD_GUILD_ID inválido.');

  const bucket = (env.SUPABASE_STORAGE_BUCKET || 'model-photos').trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/i.test(bucket)) throw new Error('SUPABASE_STORAGE_BUCKET inválido.');

  const logLevel = (env.LOG_LEVEL || 'info').trim();
  if (!['error', 'warn', 'info', 'debug'].includes(logLevel)) throw new Error('LOG_LEVEL deve ser error, warn, info ou debug.');

  return Object.freeze({
    discordToken: env.DISCORD_TOKEN.trim(),
    discordClientId: env.DISCORD_CLIENT_ID.trim(),
    discordGuildId: env.DISCORD_GUILD_ID?.trim() || null,
    allowedGuildIds: Object.freeze(idList(env, 'ALLOWED_GUILD_IDS')),
    adminRoleIds: Object.freeze(idList(env, 'ADMIN_ROLE_IDS')),
    adminUserIds: Object.freeze(idList(env, 'ADMIN_USER_IDS')),
    supabaseUrl: env.SUPABASE_URL.trim(),
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY.trim(),
    bucket,
    masterKey: Buffer.from(env.MASTER_KEY, 'hex'),
    maxImageBytes: Math.round(intInRange(env, 'MAX_IMAGE_MB', 8, 0.1, 50) * 1024 * 1024),
    sessionTtlMs: intInRange(env, 'SESSION_TTL_MINUTES', 30, 5, 1440) * 60 * 1000,
    externalTimeoutMs: intInRange(env, 'EXTERNAL_TIMEOUT_SECONDS', 20, 3, 120) * 1000,
    autoRegisterCommands: String(env.AUTO_REGISTER_COMMANDS || '').toLowerCase() === 'true',
    logLevel
  });
}

/** Validação reduzida para `npm run commands:deploy` (não exige Supabase nem MASTER_KEY). */
export function validateDiscordEnv(env = process.env) {
  const missing = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID'].filter((key) => !env[key]?.trim());
  if (missing.length) throw new Error(`Variáveis obrigatórias ausentes: ${missing.join(', ')}`);
  if (!isSnowflake(env.DISCORD_CLIENT_ID.trim())) throw new Error('DISCORD_CLIENT_ID inválido (ID numérico da aplicação).');
  if (env.DISCORD_GUILD_ID?.trim() && !isSnowflake(env.DISCORD_GUILD_ID.trim())) throw new Error('DISCORD_GUILD_ID inválido.');
  return Object.freeze({
    discordToken: env.DISCORD_TOKEN.trim(),
    discordClientId: env.DISCORD_CLIENT_ID.trim(),
    discordGuildId: env.DISCORD_GUILD_ID?.trim() || null,
    externalTimeoutMs: intInRange(env, 'EXTERNAL_TIMEOUT_SECONDS', 20, 3, 120) * 1000
  });
}
