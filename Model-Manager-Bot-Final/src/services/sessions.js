import { encryptJson, decryptJson } from '../security/crypto.js';
import { removePhoto } from './images.js';
import { logger } from '../utils/logger.js';

/**
 * Sessões de cadastro persistentes (tabela registration_sessions).
 * Todo o conteúdo do formulário (inclusive senhas) é guardado CIFRADO em payload_enc.
 */
const iso = (ms) => new Date(ms).toISOString();

export async function getSession(db, key, guildId, userId) {
  const { data, error } = await db.from('registration_sessions').select('*').eq('guild_id', guildId).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (new Date(data.expires_at).getTime() <= Date.now()) return null; // expirada: tratada como inexistente
  let payload;
  try { payload = decryptJson(data.payload_enc, key); } catch (e) {
    logger.error('Sessão de cadastro ilegível (chave alterada ou dado corrompido).', e);
    return null;
  }
  return { id: data.id, guildId, userId, photoPath: data.photo_path, data: payload.data || {}, expiresAt: data.expires_at };
}

/** Cria (ou substitui) a sessão do usuário. Retorna o caminho da foto antiga, se houver, para limpeza. */
export async function saveSession(db, key, { guildId, userId, photoPath, data }, ttlMs) {
  const { data: previous } = await db.from('registration_sessions').select('photo_path').eq('guild_id', guildId).eq('user_id', userId).maybeSingle();
  const row = {
    guild_id: guildId, user_id: userId, photo_path: photoPath ?? null,
    payload_enc: encryptJson({ data }, key), expires_at: iso(Date.now() + ttlMs)
  };
  const { error } = await db.from('registration_sessions').upsert(row, { onConflict: 'guild_id,user_id' });
  if (error) throw error;
  return previous?.photo_path && previous.photo_path !== photoPath ? previous.photo_path : null;
}

/** Atualiza os dados e renova a expiração a cada passo concluído. */
export async function touchSession(db, key, session, ttlMs) {
  const { error } = await db.from('registration_sessions').update({
    payload_enc: encryptJson({ data: session.data }, key), expires_at: iso(Date.now() + ttlMs)
  }).eq('id', session.id);
  if (error) throw error;
}

export async function deleteSession(db, sessionId) {
  const { error } = await db.from('registration_sessions').delete().eq('id', sessionId);
  if (error) throw error;
}

async function photoInUse(db, path) {
  const { data, error } = await db.from('models').select('id').eq('photo_path', path).limit(1);
  if (error) throw error;
  return Boolean(data?.length);
}

/** Remove a foto só se nenhuma modelo a referencia (evita apagar foto já cadastrada). */
export async function discardOrphanPhoto(db, bucket, path) {
  if (!path) return false;
  if (await photoInUse(db, path)) return false;
  return removePhoto(db, bucket, path);
}

/** Apaga sessões expiradas e as fotos temporárias associadas. Retorna a quantidade removida. */
export async function cleanupExpiredSessions(db, bucket) {
  const { data, error } = await db.from('registration_sessions').delete().lte('expires_at', new Date().toISOString()).select('id,photo_path');
  if (error) throw error;
  for (const row of data || []) await discardOrphanPhoto(db, bucket, row.photo_path);
  return (data || []).length;
}
