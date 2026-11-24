import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { REST, Routes } from 'discord.js';
import { validateDiscordEnv } from './config/env.js';
import { commandDefinitions } from './commands/definitions.js';

/** Registra os comandos slash (por servidor se DISCORD_GUILD_ID existir; senão, global). */
export async function registerCommands(config) {
  const rest = new REST({ version: '10', timeout: config.externalTimeoutMs ?? 20_000 }).setToken(config.discordToken);
  const route = config.discordGuildId
    ? Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId)
    : Routes.applicationCommands(config.discordClientId);
  const result = await rest.put(route, { body: commandDefinitions });
  console.log(`${result.length} comando(s) slash publicado(s) ${config.discordGuildId ? `no servidor ${config.discordGuildId}` : 'globalmente'}.`);
  return result;
}

// Executado diretamente: npm run commands:deploy
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await registerCommands(validateDiscordEnv()); } catch (e) {
    console.error('Falha ao publicar comandos:', e.message);
    process.exit(1);
  }
}
