import { logger } from '../utils/logger.js';

const SENSITIVE_KEY = /pass|senha|secret|token|key|credential/i;

/** Remove qualquer chave que possa carregar segredo e limita o tamanho dos valores. */
export function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const out = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (SENSITIVE_KEY.test(k)) continue;
    if (v === null || ['number', 'boolean'].includes(typeof v)) out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 200);
    else if (Array.isArray(v)) out[k] = v.slice(0, 20).map((x) => String(x).slice(0, 100));
  }
  return out;
}

/** Contexto de auditoria independente do tipo de interação (comando, botão, modal). */
export function auditContext(interaction) {
  return {
    guildId: interaction.guildId,
    actor: {
      id: interaction.user?.id || null,
      tag: interaction.user?.tag || interaction.user?.username || null
    }
  };
}

/**
 * Registra auditoria. Por padrão é "best effort" (falha de auditoria não desfaz a operação
 * já concluída). Com { required: true } a falha é propagada — usado antes de revelar credenciais.
 */
export async function audit(db, context, action, modelId = null, metadata = {}, { required = false } = {}) {
  const row = {
    guild_id: context.guildId,
    actor_id: context.actor?.id || null,
    actor_tag: context.actor?.tag || null,
    action,
    model_id: modelId,
    metadata: sanitizeMetadata(metadata)
  };
  const { error } = await db.from('audit_logs').insert(row);
  if (error) {
    if (required) throw error;
    logger.warn(`Falha ao gravar auditoria (${action}).`, error);
  }
}
