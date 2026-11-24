/** Limites oficiais do Discord para embeds. */
export const LIMITS = Object.freeze({
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  content: 2000,
  embedTotal: 6000
});

export function truncate(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return `${text.slice(0, max - 1)}…`;
}

/** Texto de exibição: nunca vazio e sempre dentro do limite informado. */
export function display(value, max = LIMITS.fieldValue, fallback = 'Não informado') {
  const text = String(value ?? '').trim();
  return truncate(text || fallback, max);
}

/** Escapa markdown de campos de texto livre (nomes, nicks, observações). */
export function escapeText(value) {
  return String(value ?? '').replace(/([\\*_~`|>[\]()#-])/g, '\\$1');
}

/** Exibe uma URL já validada sem gerar pré-visualização no Discord. */
export function link(value) {
  const text = String(value ?? '').trim();
  return text ? `<${text}>` : 'Não informado';
}

/** Remove caracteres de controle (exceto quebra de linha e tabulação). */
export function stripControl(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}
