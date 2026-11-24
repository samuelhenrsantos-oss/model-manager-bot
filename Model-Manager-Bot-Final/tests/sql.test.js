import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Executa as migrations em um PostgreSQL real (PGlite/WASM), com stubs mínimos do schema "storage"
// e dos papéis do Supabase. NÃO substitui um teste em projeto Supabase real (limitação documentada no README).
let PGlite;
try { ({ PGlite } = await import('@electric-sql/pglite')); } catch { /* dependência de desenvolvimento ausente */ }

const dir = path.resolve('database/migrations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const sql = (f) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '');

const STUBS = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
  create policy "leitura publica antiga" on storage.objects for select to public using (bucket_id = 'model-photos');
`;

test('migrations existem e estão em ordem', () => {
  assert.deepEqual(files.slice(0, 2), ['001_initial_schema.sql', '002_hardening_sessions_private_storage.sql']);
});

test('migrations aplicam, são idempotentes, preservam dados e endurecem acesso', { skip: !PGlite && 'PGlite indisponível' }, async () => {
  const db = new PGlite();
  await db.exec(STUBS);
  await db.exec(sql(files[0]));
  // dados "legados" criados antes da migration 002
  await db.exec(`
    insert into public.guild_settings(guild_id, view_role_id) values ('g1','r1');
    insert into public.models(guild_id,name,stage_name,gmail,facebook_name,facebook_nick,facebook_link,facebook_email,tiktok_name,tiktok_nick,tiktok_link,tiktok_email,instagram_name,instagram_nick,instagram_link,instagram_email,photo_path,created_by,created_by_tag)
    values ('g1','Ana','A','a@gmail.com','f','f','https://facebook.com/f','f@gmail.com','t','t','https://tiktok.com/t','t@gmail.com','i','i','https://instagram.com/i','i@gmail.com','g1/x.jpg','u','u#1');`);
  assert.equal((await db.query(`select public from storage.buckets where id='model-photos'`)).rows[0].public, true); // 001 criava público

  await db.exec(sql(files[1]));
  await db.exec(sql(files[1])); // idempotente: segunda execução não falha

  const q = async (text) => (await db.query(text)).rows;
  assert.equal((await q(`select count(*)::int n from public.models`))[0].n, 1); // dados preservados
  assert.equal((await q(`select public from storage.buckets where id='model-photos'`))[0].public, false); // bucket privado
  assert.equal((await q(`select count(*)::int n from pg_policies where schemaname='storage' and tablename='objects'`))[0].n, 0); // policy pública removida
  for (const t of ['guild_settings', 'models', 'model_secrets', 'audit_logs', 'registration_sessions']) {
    assert.equal((await q(`select relrowsecurity from pg_class where oid='public.${t}'::regclass`))[0].relrowsecurity, true, `RLS em ${t}`);
    for (const role of ['anon', 'authenticated']) {
      assert.equal((await q(`select has_table_privilege('${role}','public.${t}','select') s`))[0].s, false, `${role} sem acesso a ${t}`);
    }
  }
  const cols = (await q(`select column_name from information_schema.columns where table_name='models'`)).map((r) => r.column_name);
  for (const c of ['public_channel_id', 'featured_channel_id']) assert.ok(cols.includes(c), c);
  // trigger de updated_at
  const before = (await q(`select updated_at from public.models`))[0].updated_at;
  await new Promise((r) => setTimeout(r, 15));
  await db.exec(`update public.models set name='Ana 2'`);
  assert.ok((await q(`select updated_at from public.models`))[0].updated_at > before);
  // constraints NOT VALID barram novas linhas inválidas
  await assert.rejects(db.exec(`update public.models set name=''`));
  // sessões: única por usuário/guild e cascata ao remover a guild
  await db.exec(`insert into public.registration_sessions(guild_id,user_id,payload_enc,expires_at) values ('g1','u1','x', now() + interval '1 hour')`);
  await assert.rejects(db.exec(`insert into public.registration_sessions(guild_id,user_id,payload_enc,expires_at) values ('g1','u1','y', now())`));
  await db.exec(`delete from public.guild_settings where guild_id='g1'`);
  assert.equal((await q(`select count(*)::int n from public.registration_sessions`))[0].n, 0);
  await db.close();
});

test('migration 002 em instalação limpa (001 + 002)', { skip: !PGlite && 'PGlite indisponível' }, async () => {
  const db = new PGlite();
  await db.exec(STUBS); await db.exec(sql(files[0])); await db.exec(sql(files[1]));
  assert.equal((await db.query(`select count(*)::int n from public.registration_sessions`)).rows[0].n, 0);
  await db.close();
});
