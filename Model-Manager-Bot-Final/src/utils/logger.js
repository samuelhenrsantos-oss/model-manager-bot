const levels = { error: 0, warn: 1, info: 2, debug: 3 };

function threshold() {
  return levels[process.env.LOG_LEVEL || 'info'] ?? 2;
}

const REDACTIONS = [
  [/[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}/g, '[REDACTED_DISCORD_TOKEN]'],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED_JWT]'],
  [/\b[a-fA-F0-9]{64}\b/g, '[REDACTED_KEY]'],
  [/(password|senha|secret|token|apikey|api_key|authorization)(["'\s:=]+)[^\s,;"'}]+/gi, '$1$2[REDACTED]']
];

export function redact(text) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

/** Converte qualquer erro em texto seguro (sem stack completo e sem segredos). */
export function describeError(err) {
  if (!err) return '';
  if (err instanceof Error) {
    const code = err.code ? ` [${err.code}]` : '';
    return redact(`${err.name}${code}: ${err.message}`);
  }
  if (typeof err === 'object') {
    const parts = [err.code, err.message, err.details, err.hint].filter(Boolean).map(String);
    return redact(parts.join(' | ') || 'Erro desconhecido');
  }
  return redact(String(err));
}

function line(level, msg, err) {
  const suffix = err ? ` ${describeError(err)}` : '';
  return `${new Date().toISOString()} [${level}] ${redact(msg)}${suffix}`;
}

export const logger = {
  error: (msg, err) => { if (threshold() >= 0) console.error(line('ERROR', msg, err)); },
  warn: (msg, err) => { if (threshold() >= 1) console.warn(line('WARN', msg, err)); },
  info: (msg) => { if (threshold() >= 2) console.log(line('INFO', msg)); },
  debug: (msg) => { if (threshold() >= 3) console.debug(line('DEBUG', msg)); }
};
