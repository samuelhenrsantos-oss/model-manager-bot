import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { GUILD } from './fakeDiscord.js';

export const KEY = randomBytes(32);

export const validData = (over = {}) => ({
  name: 'Ana Souza', stage_name: 'Ana S', gmail: 'ana@gmail.com', gmail_password: 'gm-pass-1',
  facebook_name: 'Ana FB', facebook_nick: '@anafb', facebook_link: 'https://facebook.com/anafb', facebook_email: 'ana.fb@gmail.com', facebook_password: 'fb-pass-2',
  tiktok_name: 'Ana TT', tiktok_nick: '@anatt', tiktok_link: 'https://tiktok.com/@anatt', tiktok_email: 'ana.tt@gmail.com', tiktok_password: 'tt-pass-3',
  instagram_name: 'Ana IG', instagram_nick: '@anaig', instagram_link: 'https://instagram.com/anaig', instagram_email: 'ana.ig@gmail.com', instagram_password: 'ig-pass-4',
  observations: 'Observação de teste', ...over
});

export const testConfig = (over = {}) => ({
  bucket: 'model-photos', masterKey: KEY, maxImageBytes: 8 * 1024 * 1024, sessionTtlMs: 30 * 60 * 1000,
  externalTimeoutMs: 5000, adminRoleIds: [], adminUserIds: [], allowedGuildIds: [], ...over
});

export const jpeg916 = (w = 540, h = 960) => sharp({ create: { width: w, height: h, channels: 3, background: '#aa3366' } }).jpeg().toBuffer();

export function seedGuild(db, settings = {}) {
  db.tables.guild_settings.push({ guild_id: GUILD, ...settings });
}

/** Insere uma modelo diretamente (com foto no Storage falso). */
export async function seedModel(db, over = {}) {
  const path = over.photo_path || `${GUILD}/${crypto.randomUUID()}.jpg`;
  db.files.set(`model-photos/${path}`, await jpeg916());
  const row = {
    id: crypto.randomUUID(), public_id: db.tables.models.length + 1, guild_id: GUILD, ...validData(), photo_path: path,
    is_featured: false, public_message_id: null, public_channel_id: null, featured_message_id: null, featured_channel_id: null,
    created_by: 'u1', created_by_tag: 'criador#1', created_at: new Date(Date.now() - db.tables.models.length * 1000).toISOString(), ...over
  };
  delete row.gmail_password; delete row.facebook_password; delete row.tiktok_password; delete row.instagram_password;
  db.tables.models.push(row);
  return row;
}
