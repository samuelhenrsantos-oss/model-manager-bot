/**
 * Erro cuja mensagem é segura para ser mostrada ao usuário no Discord.
 * Qualquer outro erro é tratado como interno e recebe mensagem genérica.
 */
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}

export const GENERIC_ERROR_MESSAGE =
  'Ocorreu um erro ao processar esta ação. Tente novamente; se persistir, contate um administrador.';

/** Códigos da API do Discord que indicam interação expirada/já respondida. */
const DEAD_INTERACTION_CODES = new Set([10062, 10015, 40060]);

export function isDeadInteractionError(error) {
  return Boolean(error) && DEAD_INTERACTION_CODES.has(error.code);
}

export function userMessage(error) {
  return error instanceof UserError ? error.message : GENERIC_ERROR_MESSAGE;
}
