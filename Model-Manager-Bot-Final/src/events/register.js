import { Events } from 'discord.js';
import { handleInteraction, respond } from '../interactions/handler.js';
import { cleanupSessions } from '../interactions/registration.js';
import { userMessage, isDeadInteractionError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const CLEANUP_INTERVAL_MS = 5 * 60_000;

/** Registra eventos e tarefas periódicas. Retorna função que as interrompe (encerramento gracioso). */
export function registerEvents(client, ctx) {
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      await handleInteraction(interaction, { ...ctx, client });
    } catch (error) {
      if (isDeadInteractionError(error)) {
        logger.warn('Interação expirada ou já respondida; ignorada.');
        return;
      }
      if (error?.name !== 'UserError') logger.error('Falha ao processar interação.', error);
      await respond(interaction, userMessage(error));
    }
  });
  client.on(Events.Warn, (m) => logger.warn(m));

  const timer = setInterval(() => {
    cleanupSessions(ctx.db, ctx.config.bucket).catch((e) => logger.warn('Falha na limpeza de sessões.', e));
  }, CLEANUP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
