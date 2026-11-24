import { UserError } from './errors.js';
import { stripControl } from './text.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNOWFLAKE_RE = /^\d{17,20}$/;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
export const isSnowflake = (v) => typeof v === 'string' && SNOWFLAKE_RE.test(v);

/**
 * Interpreta o identificador informado pelo usuário.
 * Retorna { kind: 'public'|'uuid', value } ou null quando inválido.
 */
export function parseModelId(raw) {
  const text = String(raw ?? '').trim().replace(/^#/, '');
  if (/^\d{1,15}$/.test(text)) {
    const n = Number(text);
    return n >= 1 && Number.isSafeInteger(n) ? { kind: 'public', value: n } : null;
  }
  if (isUuid(text)) return { kind: 'uuid', value: text.toLowerCase() };
  return null;
}

export const FIELD_LIMITS = Object.freeze({
  name: 100, stage_name: 100, gmail: 254, nick: 100, profile_name: 100,
  link: 300, email: 254, password: 256, observations: 1000, search: 64
});

export function cleanText(value, { max, required = true, label }) {
  const text = stripControl(value).trim();
  if (!text) {
    if (required) throw new UserError(`O campo "${label}" é obrigatório.`);
    return '';
  }
  if (text.length > max) throw new UserError(`O campo "${label}" excede ${max} caracteres.`);
  return text;
}

export function cleanEmail(value, label = 'E-mail') {
  const text = cleanText(value, { max: FIELD_LIMITS.email, label });
  if (!EMAIL_RE.test(text)) throw new UserError(`O campo "${label}" não contém um e-mail válido.`);
  return text.toLowerCase();
}

export function cleanGmail(value, label = 'Gmail') {
  const text = cleanEmail(value, label);
  if (!/@(gmail|googlemail)\.com$/.test(text)) throw new UserError(`O campo "${label}" precisa ser um endereço Gmail.`);
  return text;
}

export const PLATFORM_HOSTS = Object.freeze({
  facebook: ['facebook.com', 'fb.com', 'fb.me', 'fb.watch'],
  tiktok: ['tiktok.com'],
  instagram: ['instagram.com', 'instagr.am']
});

/** Valida URL http(s) sem credenciais embutidas; opcionalmente restringe ao domínio da rede social. */
export function cleanUrl(value, { platform = null, label = 'Link' } = {}) {
  const text = cleanText(value, { max: FIELD_LIMITS.link, label });
  let url;
  try { url = new URL(text); } catch { throw new UserError(`O campo "${label}" não contém uma URL válida.`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new UserError(`O campo "${label}" deve usar http ou https.`);
  if (url.username || url.password) throw new UserError(`O campo "${label}" não pode conter credenciais na URL.`);
  if (platform) {
    const host = url.hostname.toLowerCase();
    const ok = PLATFORM_HOSTS[platform].some((d) => host === d || host.endsWith(`.${d}`));
    if (!ok) throw new UserError(`O campo "${label}" deve apontar para ${PLATFORM_HOSTS[platform][0]}.`);
  }
  return url.href;
}

/** Campos editáveis via /modelo editar e a regra de validação de cada um. */
export const EDITABLE_FIELDS = Object.freeze({
  name: (v) => cleanText(v, { max: FIELD_LIMITS.name, label: 'Nome' }),
  stage_name: (v) => cleanText(v, { max: FIELD_LIMITS.stage_name, label: 'Nome artístico' }),
  gmail: (v) => cleanGmail(v),
  observations: (v) => cleanText(v, { max: FIELD_LIMITS.observations, label: 'Observações', required: false }) || null,
  facebook_name: (v) => cleanText(v, { max: FIELD_LIMITS.profile_name, label: 'Facebook — nome' }),
  facebook_nick: (v) => cleanText(v, { max: FIELD_LIMITS.nick, label: 'Facebook — nick' }),
  facebook_link: (v) => cleanUrl(v, { platform: 'facebook', label: 'Facebook — link' }),
  tiktok_name: (v) => cleanText(v, { max: FIELD_LIMITS.profile_name, label: 'TikTok — nome' }),
  tiktok_nick: (v) => cleanText(v, { max: FIELD_LIMITS.nick, label: 'TikTok — nick' }),
  tiktok_link: (v) => cleanUrl(v, { platform: 'tiktok', label: 'TikTok — link' }),
  instagram_name: (v) => cleanText(v, { max: FIELD_LIMITS.profile_name, label: 'Instagram — nome' }),
  instagram_nick: (v) => cleanText(v, { max: FIELD_LIMITS.nick, label: 'Instagram — nick' }),
  instagram_link: (v) => cleanUrl(v, { platform: 'instagram', label: 'Instagram — link' })
});

export function validateEdit(field, value) {
  const fn = Object.hasOwn(EDITABLE_FIELDS, field) ? EDITABLE_FIELDS[field] : null;
  if (!fn) throw new UserError('Campo não editável.');
  return fn(value);
}

export function cleanPassword(value, label = 'Senha') {
  const text = String(value ?? '');
  if (!text.trim()) throw new UserError(`A ${label.toLowerCase()} não pode ficar vazia.`);
  if (text.length > FIELD_LIMITS.password) throw new UserError(`A ${label.toLowerCase()} excede ${FIELD_LIMITS.password} caracteres.`);
  return text;
}
