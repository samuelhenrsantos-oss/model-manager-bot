import { encryptSecret, decryptSecret } from '../security/crypto.js';
import { audit } from './audit.js';
import { removePhoto } from './images.js';
import { UserError } from '../utils/errors.js';
import { FIELD_LIMITS, parseModelId } from '../utils/validators.js';
import { logger } from '../utils/logger.js';

export const PUBLIC_FIELDS = 'id,public_id,guild_id,name,stage_name,gmail,facebook_name,facebook_nick,facebook_link,facebook_email,tiktok_name,tiktok_nick,tiktok_link,tiktok_email,instagram_name,instagram_nick,instagram_link,instagram_email,observations,photo_path,is_featured,public_message_id,public_channel_id,featured_message_id,featured_channel_id,created_by,created_by_tag,created_at,updated_at';

export const PLATFORMS = Object.freeze(['gmail', 'facebook', 'tiktok', 'instagram']);
export const PAGE_SIZE = 8;
const EDITABLE_COLUMNS = new Set(['name', 'stage_name', 'gmail', 'facebook_name', 'facebook_nick', 'facebook_link', 'facebook_email', 'tiktok_name', 'tiktok_nick', 'tiktok_link', 'tiktok_email', 'instagram_name', 'instagram_nick', 'instagram_link', 'instagram_email', 'observations', 'photo_path']);
const SYNC_COLUMNS = new Set(['public_message_id', 'public_channel_id', 'featured_message_id', 'featured_channel_id']);

export function buildModelRow(guildId, actor, data, photoPath) {
  const t = (v) => String(v).trim();
  return {
    guild_id: guildId, name: t(data.name), stage_name: t(data.stage_name), gmail: t(data.gmail),
    facebook_name: t(data.facebook_name), facebook_nick: t(data.facebook_nick), facebook_link: t(data.facebook_link), facebook_email: t(data.facebook_email),
    tiktok_name: t(data.tiktok_name), tiktok_nick: t(data.tiktok_nick), tiktok_link: t(data.tiktok_link), tiktok_email: t(data.tiktok_email),
    instagram_name: t(data.instagram_name), instagram_nick: t(data.instagram_nick), instagram_link: t(data.instagram_link), instagram_email: t(data.instagram_email),
    observations: data.observations?.trim() || null, photo_path: photoPath, created_by: actor.id, created_by_tag: actor.tag || actor.id
  };
}

/** Cria a modelo e seus segredos. Se os segredos falharem, a modelo recém-criada é desfeita. */
export async function createModel(db, key, guildId, actor, data, photoPath) {
  // Criptografa ANTES de gravar qualquer coisa: erro de criptografia não deixa registro parcial.
  const secrets = {
    gmail_password: encryptSecret(data.gmail_password, key),
    facebook_password: encryptSecret(data.facebook_password, key),
    tiktok_password: encryptSecret(data.tiktok_password, key),
    instagram_password: encryptSecret(data.instagram_password, key)
  };
  const { data: model, error } = await db.from('models').insert(buildModelRow(guildId, actor, data, photoPath)).select(PUBLIC_FIELDS).single();
  if (error) throw error;
  const { error: secretError } = await db.from('model_secrets').insert({ model_id: model.id, guild_id: guildId, ...secrets });
  if (secretError) {
    const { error: rollbackError } = await db.from('models').delete().eq('id', model.id).eq('guild_id', guildId);
    if (rollbackError) logger.error('Falha ao desfazer modelo após erro nos segredos.', rollbackError);
    throw secretError;
  }
  await audit(db, { guildId, actor }, 'model_created', model.id);
  return model;
}

/** Retorna a modelo, null se não existir. Lança UserError para identificador inválido. */
export async function getModel(db, guildId, identifier) {
  const parsed = parseModelId(identifier);
  if (!parsed) throw new UserError('ID inválido. Informe o número da modelo (ex.: 12) ou o UUID completo.');
  let query = db.from('models').select(PUBLIC_FIELDS).eq('guild_id', guildId);
  query = parsed.kind === 'public' ? query.eq('public_id', parsed.value) : query.eq('id', parsed.value);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data;
}

export async function requireModel(db, guildId, identifier) {
  const model = await getModel(db, guildId, identifier);
  if (!model) throw new UserError('Modelo não encontrada.');
  return model;
}

export const escapeLike = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Pesquisa por nome, nome artístico e nicks. Usa consultas parametrizadas separadas (sem
 * montar expressão `.or()` com texto do usuário), eliminando injeção em filtros PostgREST.
 */
export async function searchModels(db, guildId, term, limit = 15) {
  const clean = String(term ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  if (!clean) throw new UserError('Informe um termo de pesquisa.');
  if (clean.length > FIELD_LIMITS.search) throw new UserError(`O termo de pesquisa excede ${FIELD_LIMITS.search} caracteres.`);
  const pattern = `%${escapeLike(clean)}%`;
  const columns = ['name', 'stage_name', 'facebook_nick', 'tiktok_nick', 'instagram_nick'];
  const results = await Promise.all(columns.map(async (col) => {
    const { data, error } = await db.from('models').select(PUBLIC_FIELDS).eq('guild_id', guildId).ilike(col, pattern).order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return data || [];
  }));
  const byId = new Map();
  if (parseModelId(clean)) {
    const exact = await getModel(db, guildId, clean);
    if (exact) byId.set(exact.id, exact);
  }
  for (const row of results.flat()) byId.set(row.id, row);
  return [...byId.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit);
}

export async function listModels(db, guildId, page = 1, featuredOnly = false, pageSize = PAGE_SIZE) {
  const wanted = Number.isFinite(Number(page)) ? Math.max(1, Math.floor(Number(page))) : 1;
  const build = () => {
    let q = db.from('models').select(PUBLIC_FIELDS, { count: 'exact' }).eq('guild_id', guildId);
    if (featuredOnly) q = q.eq('is_featured', true);
    return q.order('created_at', { ascending: false });
  };
  let current = wanted;
  let from = (current - 1) * pageSize;
  let { data, count, error } = await build().range(from, from + pageSize - 1);
  if (error) throw error;
  const pages = Math.max(1, Math.ceil((count || 0) / pageSize));
  if (current > pages) { // página além do fim: devolve a última
    current = pages;
    from = (current - 1) * pageSize;
    ({ data, error } = await build().range(from, from + pageSize - 1));
    if (error) throw error;
  }
  return { data: data || [], count: count || 0, page: current, pages };
}

export async function updateModel(db, guildId, id, patch) {
  const safe = Object.fromEntries(Object.entries(patch).filter(([k, v]) => EDITABLE_COLUMNS.has(k) && v !== undefined));
  if (!Object.keys(safe).length) throw new UserError('Nenhum campo válido para atualizar.');
  safe.updated_at = new Date().toISOString();
  const { data, error } = await db.from('models').update(safe).eq('guild_id', guildId).eq('id', id).select(PUBLIC_FIELDS).maybeSingle();
  if (error) throw error;
  if (!data) throw new UserError('Modelo não encontrada.');
  return data;
}

export async function setFeaturedFlag(db, guildId, id, value) {
  const { data, error } = await db.from('models').update({ is_featured: Boolean(value), updated_at: new Date().toISOString() })
    .eq('guild_id', guildId).eq('id', id).select(PUBLIC_FIELDS).maybeSingle();
  if (error) throw error;
  if (!data) throw new UserError('Modelo não encontrada.');
  return data;
}

/** Mantém os IDs de mensagem/canal das publicações sincronizados com o banco. */
export async function setPublicationRefs(db, guildId, id, refs) {
  const safe = Object.fromEntries(Object.entries(refs).filter(([k]) => SYNC_COLUMNS.has(k)));
  if (!Object.keys(safe).length) return;
  const { error } = await db.from('models').update(safe).eq('guild_id', guildId).eq('id', id);
  if (error) throw error;
}

/** Descriptografa as senhas. O chamador DEVE ter validado permissão e auditado antes. */
export async function getSecrets(db, guildId, modelId, key) {
  const { data, error } = await db.from('model_secrets').select('*').eq('guild_id', guildId).eq('model_id', modelId).maybeSingle();
  if (error) throw error;
  if (!data) throw new UserError('Credenciais não encontradas para esta modelo.');
  const out = {};
  for (const p of PLATFORMS) out[`${p}_password`] = decryptSecret(data[`${p}_password`], key);
  return out;
}

/** Atualiza somente as senhas informadas (campos ausentes permanecem intactos). Retorna as plataformas alteradas. */
export async function updateSecrets(db, guildId, modelId, key, passwords) {
  const patch = {};
  for (const p of PLATFORMS) {
    const value = passwords[`${p}_password`];
    if (value !== undefined && value !== null && value !== '') patch[`${p}_password`] = encryptSecret(value, key);
  }
  const changed = Object.keys(patch).map((k) => k.replace('_password', ''));
  if (!changed.length) throw new UserError('Nenhuma senha informada para atualizar.');
  patch.updated_at = new Date().toISOString();
  const { data, error } = await db.from('model_secrets').update(patch).eq('guild_id', guildId).eq('model_id', modelId).select('model_id');
  if (error) throw error;
  if (!data?.length) throw new UserError('Credenciais não encontradas para esta modelo.');
  return changed;
}

/**
 * Exclui a modelo. O registro no banco é a fonte da verdade: a exclusão é concluída mesmo se a
 * limpeza do Storage falhar (o arquivo órfão é apenas registrado em log).
 */
export async function deleteModel(db, guildId, model, bucket) {
  const { data, error } = await db.from('models').delete().eq('guild_id', guildId).eq('id', model.id).select('id');
  if (error) throw error;
  if (!data?.length) throw new UserError('Modelo já não existe.');
  const storageRemoved = await removePhoto(db, bucket, model.photo_path);
  return { storageRemoved };
}
