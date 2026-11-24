import { PermissionFlagsBits } from 'discord.js';

export const GUILD = '111111111111111111';
export const OTHER_GUILD = '222222222222222222';
export const USER = '333333333333333333';
export const ROLE = '444444444444444444';

/** Interação falsa: registra tudo que o bot responde. */
export function fakeInteraction(opts = {}) {
  const roles = new Map((opts.roles || []).map((r) => [r, true]));
  const log = [];
  const i = {
    guildId: opts.guildId ?? GUILD,
    guild: opts.noGuild ? null : { id: opts.guildId ?? GUILD, channels: { fetch: async () => null }, members: { me: {} } },
    member: opts.noGuild ? null : { roles: { cache: roles } },
    user: { id: opts.userId ?? USER, tag: 'tester#0001', username: 'tester' },
    memberPermissions: { has: (p) => Boolean(opts.admin) && p === PermissionFlagsBits.Administrator },
    client: { ws: { ping: 42 } },
    customId: opts.customId,
    commandName: opts.commandName,
    deferred: false, replied: false, log,
    values: opts.values,
    inGuild: () => !opts.noGuild,
    isChatInputCommand: () => opts.type === 'command',
    isButton: () => opts.type === 'button',
    isModalSubmit: () => opts.type === 'modal',
    isMessageComponent: () => ['button', 'select'].includes(opts.type),
    isChannelSelectMenu: () => opts.type === 'select' && opts.selectKind === 'channel',
    isRoleSelectMenu: () => opts.type === 'select' && opts.selectKind === 'role',
    options: {
      getSubcommand: (required = true) => { if (opts.sub) return opts.sub; if (required === false) return null; throw new Error('no sub'); },
      getString: (n) => opts.options?.[n] ?? null,
      getInteger: (n) => opts.options?.[n] ?? null,
      getBoolean: (n) => opts.options?.[n] ?? null,
      getAttachment: (n) => opts.options?.[n] ?? null
    },
    fields: { getTextInputValue: (k) => { if (!(k in (opts.fields || {}))) throw new Error(`campo ${k} ausente`); return opts.fields[k]; } },
    async deferReply(o) { i.deferred = true; log.push(['deferReply', o]); },
    async deferUpdate() { i.deferred = true; log.push(['deferUpdate']); },
    async reply(o) { i.replied = true; log.push(['reply', o]); },
    async editReply(o) { log.push(['editReply', o]); },
    async followUp(o) { i.replied = true; log.push(['followUp', o]); },
    async update(o) { i.replied = true; log.push(['update', o]); },
    async showModal(m) { i.replied = true; log.push(['showModal', m]); },
    async deleteReply() { log.push(['deleteReply']); },
    last(kind) { return [...log].reverse().find((l) => l[0] === kind)?.[1]; }
  };
  return i;
}

/** Cliente Discord falso com canais/mensagens em memória. */
export function fakeClient(channelDefs = {}) {
  const channels = new Map();
  let counter = 1000;
  for (const [id, def] of Object.entries(channelDefs)) {
    const messages = new Map();
    messages.fetch = async (mid) => {
      if (def.fetchError) throw def.fetchError;
      const m = messages.get(mid);
      if (!m) { const e = new Error('Unknown Message'); e.code = 10008; throw e; }
      return m;
    };
    const channel = {
      id, guildId: def.guildId ?? GUILD, messages, sent: [], isTextBased: () => def.text !== false,
      async send(payload) {
        if (def.sendError) throw def.sendError;
        const m = { id: String(++counter), payload, async edit(p) { if (def.editError) throw def.editError; m.payload = p; return m; }, async delete() { messages.delete(m.id); } };
        messages.set(m.id, m); channel.sent.push(m); return m;
      }
    };
    channels.set(id, channel);
  }
  return { channels: { fetch: async (id) => { const c = channels.get(id); if (!c) { const e = new Error('Unknown Channel'); e.code = 10003; throw e; } return c; } }, _channels: channels };
}
