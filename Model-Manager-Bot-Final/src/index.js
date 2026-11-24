import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { validateEnv } from './config/env.js';
import { createSupabaseClient, checkSupabaseConnection } from './database/supabase.js';
import { registerEvents } from './events/register.js';
import { cleanupSessions } from './interactions/registration.js';
import { registerCommands } from './deploy-commands.js';
import { logger } from './utils/logger.js';

let config;
try { config = validateEnv(); } catch (error) {
  console.error(`Configuração inválida: ${error.message}`);
  process.exit(1);
}
process.env.LOG_LEVEL = config.logLevel;

const db = createSupabaseClient(config);
// Somente a intent Guilds é necessária: cadastro e fotos usam comandos slash com anexo,
// portanto NÃO há dependência da Message Content Intent (privilegiada).
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  allowedMentions: { parse: [], repliedUser: false }
});

let stopEvents = () => {};
let closing = false;

async function shutdown(signal, code = 0) {
  if (closing) return;
  closing = true;
  logger.info(`Encerrando (${signal}).`);
  const force = setTimeout(() => process.exit(code || 1), 10_000);
  force.unref();
  try { stopEvents(); await client.destroy(); } catch (error) { logger.error('Erro ao encerrar o cliente Discord.', error); }
  process.exit(code);
}

client.on(Events.Error, (e) => logger.error('Erro Discord Gateway.', e));
// Falhas inesperadas NÃO são escondidas: são registradas e o processo encerra para ser reiniciado pelo orquestrador.
process.on('unhandledRejection', (e) => { logger.error('Promise rejeitada sem tratamento; encerrando.', e); shutdown('unhandledRejection', 1); });
process.on('uncaughtException', (e) => { logger.error('Exceção não tratada; encerrando.', e); shutdown('uncaughtException', 1); });
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

async function startupChecks() {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { warnings } = await checkSupabaseConnection(db, config.bucket);
      warnings.forEach((w) => logger.warn(w));
      logger.info('Supabase conectado.');
      return;
    } catch (error) {
      lastError = error;
      logger.warn(`Verificação do Supabase falhou (tentativa ${attempt}/3).`, error);
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  throw lastError;
}

client.once(Events.ClientReady, async (c) => {
  logger.info(`Discord conectado como ${c.user.tag} em ${c.guilds.cache.size} servidor(es).`);
  try { await cleanupSessions(db, config.bucket); } catch (e) { logger.warn('Falha na limpeza inicial de sessões.', e); }
});

try {
  await startupChecks();
  if (config.autoRegisterCommands) await registerCommands(config);
  stopEvents = registerEvents(client, { db, config });
  await client.login(config.discordToken);
} catch (error) {
  logger.error('Falha na inicialização.', error);
  process.exit(1);
}
