import { createClient } from '@supabase/supabase-js';

/** fetch com timeout, para que chamadas ao Supabase nunca fiquem penduradas. */
export function fetchWithTimeout(timeoutMs, baseFetch = globalThis.fetch) {
  return (input, init = {}) => {
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    return baseFetch(input, { ...init, signal });
  };
}

export function createSupabaseClient(config) {
  const timeout = Math.max(config.externalTimeoutMs ?? 20_000, 5_000) * 2; // uploads/downloads podem demorar mais
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { headers: { 'X-Client-Info': 'model-manager-bot/2.0.0' }, fetch: fetchWithTimeout(timeout) }
  });
}

/** Verifica conexão, tabelas obrigatórias e bucket. Lança erro se algo essencial faltar. */
export async function checkSupabaseConnection(client, bucket) {
  for (const table of ['guild_settings', 'models', 'model_secrets', 'audit_logs', 'registration_sessions']) {
    const { error } = await client.from(table).select('*', { head: true, count: 'exact' }).limit(1);
    if (error) throw new Error(`Tabela "${table}" inacessível (${error.code || 'erro'}). As migrations foram aplicadas? ${error.message}`);
  }
  const warnings = [];
  const { data, error } = await client.storage.getBucket(bucket);
  if (error || !data) throw new Error(`Bucket "${bucket}" não encontrado. Aplique as migrations SQL.`);
  if (data.public) warnings.push(`O bucket "${bucket}" está PÚBLICO. Aplique a migration 002 para torná-lo privado.`);
  return { warnings, bucket: data };
}
