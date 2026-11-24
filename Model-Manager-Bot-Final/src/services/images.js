import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { UserError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

sharp.cache(false);

export const ASPECT = 9 / 16;
export const ASPECT_TOLERANCE = 0.005;
export const MIN_WIDTH = 360;
export const MIN_HEIGHT = 640;
export const MAX_PIXELS = 40_000_000;

const FORMATS = Object.freeze({ jpeg: { ext: 'jpg', mime: 'image/jpeg' }, png: { ext: 'png', mime: 'image/png' }, webp: { ext: 'webp', mime: 'image/webp' } });
// Hosts oficiais de anexos do Discord. Qualquer outro host é recusado (proteção contra SSRF).
export const DISCORD_CDN_HOSTS = Object.freeze(['cdn.discordapp.com', 'media.discordapp.net']);

/**
 * Valida o conteúdo REAL do arquivo (não confia no content-type informado pelo cliente).
 * Retorna { width, height, format, mime, ext } com dimensões já considerando a orientação EXIF.
 */
export async function validateImage(buffer, maxBytes) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new UserError('Imagem vazia.');
  if (buffer.length > maxBytes) throw new UserError(`Imagem acima do limite de ${(maxBytes / 1024 / 1024).toFixed(1)} MB.`);
  let meta;
  try {
    meta = await sharp(buffer, { failOn: 'error', limitInputPixels: MAX_PIXELS }).metadata();
  } catch {
    throw new UserError('Arquivo inválido ou corrompido. Envie JPG, PNG ou WEBP.');
  }
  const fmt = FORMATS[meta.format];
  if (!fmt) throw new UserError('Formato inválido. Envie JPG, JPEG, PNG ou WEBP.');
  if (!meta.width || !meta.height) throw new UserError('Não foi possível ler as dimensões da imagem.');
  if (meta.pages && meta.pages > 1) throw new UserError('Imagens animadas não são aceitas.');
  // Orientações EXIF 5-8 giram a imagem em 90°: a proporção exibida é a inversa da armazenada.
  const rotated = meta.orientation >= 5 && meta.orientation <= 8;
  const width = rotated ? meta.height : meta.width;
  const height = rotated ? meta.width : meta.height;
  if (width < MIN_WIDTH || height < MIN_HEIGHT) throw new UserError(`Resolução mínima: ${MIN_WIDTH}x${MIN_HEIGHT}. Recebido: ${width}x${height}.`);
  if (Math.abs(width / height - ASPECT) > ASPECT_TOLERANCE) {
    throw new UserError(`A foto precisa ser vertical 9:16 (ex.: 1080x1920). Recebido: ${width}x${height}.`);
  }
  return { width, height, format: meta.format, mime: fmt.mime, ext: fmt.ext };
}

/** Baixa um anexo do Discord com limite de tamanho, timeout e sem seguir redirecionamentos. */
export async function downloadAttachment(attachment, { maxBytes, timeoutMs = 20_000, fetchImpl = globalThis.fetch } = {}) {
  let url;
  try { url = new URL(attachment?.url); } catch { throw new UserError('Anexo inválido.'); }
  if (url.protocol !== 'https:' || !DISCORD_CDN_HOSTS.includes(url.hostname)) throw new UserError('Anexo inválido: origem não permitida.');
  if (Number.isFinite(attachment.size) && attachment.size > maxBytes) {
    throw new UserError(`Imagem acima do limite de ${(maxBytes / 1024 / 1024).toFixed(1)} MB.`);
  }
  let response;
  try {
    response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new UserError('Não foi possível baixar a imagem enviada. Tente novamente.');
  }
  if (!response.ok) throw new UserError('Não foi possível baixar a imagem enviada. Tente novamente.');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new UserError('Imagem acima do limite de tamanho.');
  // Leitura em streaming com teto de bytes (não confia em content-length).
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > maxBytes) throw new UserError('Imagem acima do limite de tamanho.');
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError('Falha ao baixar a imagem enviada. Tente novamente.');
  }
  return Buffer.concat(chunks);
}

export async function uploadPhoto(db, bucket, guildId, buffer, { mime, ext }) {
  const path = `${guildId}/${randomUUID()}.${ext}`;
  const { error } = await db.storage.from(bucket).upload(path, buffer, { contentType: mime, upsert: false });
  if (error) throw error;
  return path;
}

/** Remoção de arquivos nunca derruba o fluxo principal: falhas são registradas. */
export async function removePhoto(db, bucket, path) {
  if (!path) return false;
  try {
    const { error } = await db.storage.from(bucket).remove([path]);
    if (error) throw error;
    return true;
  } catch (error) {
    logger.warn('Falha ao remover arquivo do Storage (arquivo órfão).', error);
    return false;
  }
}

/** Baixa a foto privada do Storage para anexá-la às mensagens do Discord. */
export async function downloadPhoto(db, bucket, path) {
  const { data, error } = await db.storage.from(bucket).download(path);
  if (error || !data) throw new UserError('Não foi possível carregar a fotografia do armazenamento.');
  return Buffer.from(await data.arrayBuffer());
}

export const photoFileName = (path) => `foto.${String(path).split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'}`;
