-- =====================================================================
-- Migration 002 — Hardening, sessões persistentes e Storage privado
-- Idempotente e NÃO destrutiva: preserva todos os dados existentes.
-- Execute no SQL Editor do Supabase DEPOIS da migration 001.
-- =====================================================================

-- 1) Função genérica para manter updated_at consistente --------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
revoke all on function public.set_updated_at() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['guild_settings','models','model_secrets'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_set_updated_at', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.set_updated_at()', t || '_set_updated_at', t);
  end loop;
end $$;

-- 2) Colunas para manter publicações sincronizadas com o banco --------
alter table public.models add column if not exists public_channel_id text;
alter table public.models add column if not exists featured_channel_id text;
alter table public.guild_settings add column if not exists registration_message_channel_id text;

-- 3) Sessões de cadastro persistentes ---------------------------------
-- O conteúdo (dados do formulário, incluindo senhas) fica CIFRADO em payload_enc
-- (AES-256-GCM com a MASTER_KEY, feito pela aplicação). Nunca em texto puro.
create table if not exists public.registration_sessions (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null references public.guild_settings(guild_id) on delete cascade,
  user_id text not null,
  photo_path text,
  payload_enc text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (guild_id, user_id)
);
create index if not exists registration_sessions_expires_idx on public.registration_sessions(expires_at);

drop trigger if exists registration_sessions_set_updated_at on public.registration_sessions;
create trigger registration_sessions_set_updated_at
  before update on public.registration_sessions
  for each row execute function public.set_updated_at();

-- 4) RLS em todas as tabelas + remoção de privilégios de anon/authenticated
alter table public.guild_settings enable row level security;
alter table public.models enable row level security;
alter table public.model_secrets enable row level security;
alter table public.audit_logs enable row level security;
alter table public.registration_sessions enable row level security;

-- Sem policies = negação total para anon/authenticated. Somente o backend (service_role,
-- que ignora RLS) acessa os dados. Os REVOKEs abaixo são uma segunda camada de defesa.
revoke all on table public.guild_settings from anon, authenticated;
revoke all on table public.models from anon, authenticated;
revoke all on table public.model_secrets from anon, authenticated;
revoke all on table public.audit_logs from anon, authenticated;
revoke all on table public.registration_sessions from anon, authenticated;
revoke all on sequence public.models_public_id_seq from anon, authenticated;
revoke all on sequence public.audit_logs_id_seq from anon, authenticated;

-- Evita que novas tabelas criadas no futuro herdem acesso para anon/authenticated
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- 5) Constraints de integridade (NOT VALID: não quebra linhas antigas, valida as novas)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'models_photo_path_not_empty') then
    alter table public.models add constraint models_photo_path_not_empty check (char_length(photo_path) > 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'models_name_length') then
    alter table public.models add constraint models_name_length
      check (char_length(name) between 1 and 100 and char_length(stage_name) between 1 and 100) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'models_observations_length') then
    alter table public.models add constraint models_observations_length
      check (observations is null or char_length(observations) <= 1000) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'audit_logs_action_not_empty') then
    alter table public.audit_logs add constraint audit_logs_action_not_empty check (char_length(action) > 0) not valid;
  end if;
end $$;

-- 6) Storage: bucket PRIVADO ------------------------------------------
-- As fotos passam a ser publicadas no Discord como anexos (o bot baixa o arquivo com a
-- service_role). Nenhuma URL pública é necessária e fotos de pessoas não ficam expostas.
update storage.buckets
   set public = false,
       file_size_limit = 8388608,
       allowed_mime_types = array['image/jpeg','image/png','image/webp']
 where id = 'model-photos';

-- Remove eventuais policies antigas que liberavam leitura/escrita do bucket para anon/public
do $$
declare p record;
begin
  for p in
    select policyname from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and (coalesce(qual,'') ilike '%model-photos%' or coalesce(with_check,'') ilike '%model-photos%')
  loop
    execute format('drop policy %I on storage.objects', p.policyname);
  end loop;
end $$;
