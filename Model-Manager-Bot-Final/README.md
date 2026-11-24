# Model Manager Bot

Bot Discord multi-servidor para **cadastro e gerenciamento de modelos**, com Supabase (PostgreSQL + Storage privado), senhas criptografadas (AES-256-GCM), auditoria e execução contínua (Render Background Worker ou qualquer host Node.js).

> **Versão 2.0** — auditoria completa, correções de segurança e novos fluxos. Veja [Atualizando da versão 1](#atualizando-da-versão-1).

## Recursos

- **Cadastro por etapas** (identidade → Gmail → Facebook → TikTok → Instagram → observações → revisão/confirmação), com a foto enviada pelo comando `/cadastrar`.
- **Validação de foto**: JPG/PNG/WEBP reais (conteúdo verificado, não só o tipo declarado), proporção **9:16**, resolução mínima 360×640, limite de tamanho, orientação EXIF considerada.
- **Sessões persistentes**: cadastros interrompidos ficam no Supabase (cifrados) e podem ser **retomados** por quem os iniciou, mesmo após reiniciar o bot. Expiram sozinhos e as fotos temporárias são limpas.
- **Gerenciamento**: listar (paginado), pesquisar, ver, editar campos, **substituir foto**, **editar senhas**, excluir (com confirmação), destacar/remover destaque, republicar.
- **Senhas e credenciais**: criptografadas no banco; descriptografadas somente para quem tem o cargo de credenciais; exibidas em mensagem **efêmera**, em spoiler, auto-apagada em 2 min; consulta **auditada antes** de revelar; nunca em canais públicos, logs ou mensagens de erro.
- **Publicações**: fichas em embed + foto anexada, atualizadas no lugar (IDs de mensagem/canal sincronizados no banco), destaque em canal próprio, tratamento de mensagem apagada, canal alterado e falta de permissão. Falha de publicação **nunca** apaga dados salvos.
- **Painel administrativo** com menus de canais e cargos; central de cadastro com botão.
- **Segurança**: permissões verificadas em todo handler, rate limit, validação de entradas/URLs/anexos, busca sem injeção, bucket privado, RLS, logs com redação de segredos.

## Requisitos

- Node.js **22+** (exigência do `@supabase/supabase-js` atual; testado em 22)
- Aplicação/bot no [Discord Developer Portal](https://discord.com/developers/applications)
- Projeto [Supabase](https://supabase.com)
- (Produção) Render Background Worker ou outro host que mantenha o processo ativo — **não** use serverless (o bot mantém uma conexão Gateway)

## Estrutura

```
src/
  index.js               inicialização, checagens, encerramento gracioso
  deploy-commands.js     registro dos comandos slash
  config/env.js          validação das variáveis de ambiente
  commands/definitions.js definição dos comandos slash
  interactions/          roteador, comandos, cadastro, credenciais, painel
  services/              modelos, sessões, imagens, publicação, auditoria, ações
  security/              criptografia e permissões
  database/supabase.js   cliente Supabase (timeout) e verificação de saúde
database/migrations/     SQL (aplicar em ordem)
tests/                   testes automatizados (node:test)
scripts/check.js         validação de sintaxe, imports e exports
```

## 1. Supabase

1. Crie um projeto em supabase.com.
2. No **SQL Editor**, execute **em ordem** e por inteiro:
   1. `database/migrations/001_initial_schema.sql`
   2. `database/migrations/002_hardening_sessions_private_storage.sql`
3. As migrations criam tabelas, índices, constraints, triggers de `updated_at`, **RLS ativado sem policies** (acesso apenas pela `service_role`), `REVOKE` para `anon`/`authenticated`, a tabela de sessões e o bucket **privado** `model-photos`. São idempotentes e **não apagam dados**.
4. Em *Project Settings → API* copie a **URL** e a chave **`service_role`**. Ela contorna RLS: use **apenas** no servidor do bot (variável de ambiente), nunca em frontend, repositório ou mensagens.
5. Storage: o bucket é privado (conferido na inicialização do bot; ele avisa se estiver público). O bot baixa a foto com a `service_role` e a anexa à mensagem do Discord. O limite do bucket é 8 MB — se aumentar `MAX_IMAGE_MB`, ajuste também o bucket.

## 2. Discord Developer Portal

1. *New Application* → aba **Bot** → *Reset Token* e copie o token. Copie o *Application ID* em *General Information*.
2. **Privileged Gateway Intents: deixe TODAS desligadas.** O bot usa somente a intent `Guilds` (não privilegiada). A **Message Content Intent não é necessária**: a foto chega como anexo do comando slash (`/cadastrar`), que o Discord entrega na própria interação.
3. Convite (*OAuth2 → URL Generator*): escopos `bot` e `applications.commands`. Permissões mínimas (valor `117760`):
   - View Channels, Send Messages, Embed Links, Attach Files, Read Message History
   - *Não* são necessárias Administrator, Manage Messages nem Mention Everyone.

   URL pronta (troque `SEU_CLIENT_ID`):
   `https://discord.com/oauth2/authorize?client_id=SEU_CLIENT_ID&scope=bot%20applications.commands&permissions=117760`
4. Dê ao bot acesso (ver/enviar/anexar) aos canais de cadastro, publicação, destaques e logs.

## 3. Configuração

```bash
cp .env.example .env
npm ci          # instalação limpa (use `npm install` se não tiver package-lock)
```

Preencha o `.env` (todas as variáveis estão comentadas em `.env.example`):

| Variável | Obrigatória | Descrição |
|---|---|---|
| `DISCORD_TOKEN` | sim | Token do bot |
| `DISCORD_CLIENT_ID` | sim | ID da aplicação |
| `DISCORD_GUILD_ID` | não | Registra comandos só nesse servidor (instantâneo, bom para testes) |
| `ALLOWED_GUILD_IDS` | não | Restringe o bot a esses servidores |
| `ADMIN_ROLE_IDS` / `ADMIN_USER_IDS` | não | Cargos/usuários com acesso administrativo total (além de quem tem *Administrador*) |
| `SUPABASE_URL` | sim | URL HTTPS do projeto |
| `SUPABASE_SERVICE_ROLE_KEY` | sim | Chave `service_role` (segredo) |
| `SUPABASE_STORAGE_BUCKET` | não | Padrão `model-photos` |
| `MASTER_KEY` | sim | 64 caracteres hex (AES-256) |
| `MAX_IMAGE_MB` | não | Padrão 8 |
| `SESSION_TTL_MINUTES` | não | Padrão 30 (5–1440); cada etapa renova o prazo |
| `EXTERNAL_TIMEOUT_SECONDS` | não | Padrão 20 |
| `AUTO_REGISTER_COMMANDS` | não | `true` registra os comandos ao iniciar |
| `LOG_LEVEL` | não | `error`, `warn`, `info` (padrão) ou `debug` |

Gerar a `MASTER_KEY`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> **Guarde a `MASTER_KEY` em gerenciador de segredos e faça backup.** Se for perdida ou trocada, as senhas já gravadas **não podem ser recuperadas**.

IDs de **canais** e **cargos** de cada servidor (cadastro, publicação, destaques, logs; cadastrar, editar, excluir, consultar, credenciais, destaque) são configurados no Discord pelo `/painel` e ficam no banco — não no `.env`.

## 4. Registrar comandos e iniciar

```bash
npm run validate          # sintaxe + lint + testes + auditoria de dependências
npm run commands:deploy   # registra os comandos slash
npm start
```

Com `DISCORD_GUILD_ID` os comandos aparecem na hora naquele servidor; sem ele são globais (propagação mais lenta). Alternativa: `AUTO_REGISTER_COMMANDS=true`.

Na inicialização o bot valida o `.env`, verifica tabelas e bucket (3 tentativas), registra comandos (se configurado), conecta ao Discord e limpa sessões expiradas.

## 5. Primeiro uso

1. Como administrador, execute `/painel` e escolha os canais e cargos.
2. Execute `/painel-cadastro` (ou o botão do painel) para publicar a central de cadastro.
3. Quem tem o cargo de cadastro usa `/cadastrar` anexando a foto 9:16 e preenche as etapas pelos botões/formulários. O botão **Criar modelo** da central explica o fluxo e retoma cadastro em andamento.

## Comandos e permissões

| Comando | Quem pode |
|---|---|
| `/painel`, `/painel-cadastro` | Administradores |
| `/cadastrar [foto]` | Cargo **cadastrar** |
| `/modelos [pagina] [destaques]`, `/modelo buscar`, `/modelo ver` | Cargo **consultar** |
| `/modelo editar id campo valor`, `/modelo foto id imagem`, `/modelo publicar id` | Cargo **editar** |
| `/modelo senhas id` (formulário privado; campo vazio = manter) | Cargo **credenciais** |
| `/credenciais id` | Cargo **credenciais** (auditado, efêmero) |
| `/modelo excluir id` (confirmação de 2 min, só quem pediu confirma) | Cargo **excluir** |
| `/modelo destaque id` e botão ⭐ da ficha | Cargo **destaque** |
| `/ping` | Qualquer pessoa (em servidor) |

`id` aceita o número da modelo (ex.: `12`) ou o UUID. Administradores têm todas as permissões.

## Segurança

- **Criptografia**: AES-256-GCM com IV aleatório por valor e verificação de integridade; sessões de cadastro também são cifradas. A `MASTER_KEY` só existe na memória do processo.
- **Credenciais**: nunca em embeds públicos, logs, auditoria ou erros. Auditoria da consulta é gravada **antes** de descriptografar (se falhar, a consulta é negada). Limite de 5 consultas/min por usuário.
- **Logs**: redigem tokens, JWTs, chaves hex e valores de senha; erros mostrados ao usuário são genéricos (apenas mensagens de validação conhecidas aparecem).
- **Entradas**: tamanhos limitados, caracteres de controle removidos, e-mails/Gmail e URLs validados (http/https, sem credenciais, domínio da rede social), IDs validados (inteiro seguro ou UUID), busca com consultas parametrizadas e curingas escapados.
- **Anexos**: só `https://cdn.discordapp.com`/`media.discordapp.net`, sem redirecionamentos, timeout, teto de bytes em streaming, formato verificado por decodificação (`sharp`), limite de pixels, imagens animadas recusadas. Nenhum arquivo temporário é gravado em disco (tudo em memória); arquivos órfãos no Storage são removidos.
- **Menções**: `allowedMentions` vazio em todo o bot; textos livres têm markdown escapado.
- **Banco**: RLS ligado sem policies + `REVOKE` para `anon`/`authenticated`; bucket privado; tudo filtrado por `guild_id` (isolamento entre servidores).
- **Operações destrutivas**: exclusão exige confirmação do próprio solicitante, com expiração; exclusão é concluída mesmo que a limpeza do Storage falhe (registrada em log).
- **Processo**: encerramento gracioso (SIGINT/SIGTERM); exceções não tratadas são registradas e encerram o processo para reinício limpo (nada é escondido).
- **Permissões do bot**: mínimas (ver acima) e sem intents privilegiadas.

Limitações a conhecer: o `service_role` ignora RLS (proteção depende de manter o worker e os segredos privados); senhas digitadas em formulários do Discord trafegam pela infraestrutura do Discord; o rate limit é em memória (reinicia com o processo); a ficha pública exibe o Gmail da modelo (os canais devem ter acesso restrito).

## Testes

```bash
npm test             # ~110 testes automatizados (node:test)
npm run check        # sintaxe, imports relativos e exports de todos os módulos
npm run lint         # ESLint (no-undef, no-unused-vars...)
npm run audit:deps   # npm audit das dependências de produção
npm run validate     # tudo acima
```

Cobertura: criptografia, configuração, validadores, imagens (formatos, proporção, EXIF, download seguro), modelos (criação/rollback, busca, paginação, edição, exclusão), sessões (persistência cifrada, expiração, retomada, limpeza), permissões, publicação (limites de embed, mensagem apagada, canal alterado, falhas), fluxo completo de cadastro, comandos (cada comando definido tem handler), credenciais, painel, exclusão/destaque/foto e **migrations SQL executadas em PostgreSQL real (PGlite)**, inclusive idempotência e preservação de dados.

**O que os testes NÃO cobrem** (exigem credenciais/serviços reais): conexão real com o Gateway do Discord e com um projeto Supabase real (Discord e Supabase são simulados por mocks), comportamento real de RLS/Storage do Supabase e limites de taxa reais do Discord. Faça um teste de fumaça em servidor/projeto de teste antes de produção (checklist abaixo).

### Teste de fumaça (servidor de teste)

1. `/painel` → configurar canais/cargos; `/painel-cadastro`.
2. `/cadastrar` com foto 9:16 → preencher etapas → confirmar → ficha publicada.
3. Interromper no meio, reiniciar o bot, voltar ao `/cadastrar` → "Continuar".
4. `/modelo editar`, `/modelo foto`, `/modelo senhas`, `/credenciais` (efêmero), `/modelo destaque`, `/modelo excluir`.

## Deploy (Render)

1. Repositório privado no GitHub (o `.gitignore` já exclui `.env`).
2. Render → *New → Background Worker* (ou *Blueprint* com `render.yaml`).
3. Build: `npm ci --omit=dev` · Start: `npm start`.
4. Configure no painel (Environment) todas as variáveis do `.env.example`; segredos como `sync: false`.
5. Acompanhe os logs: devem aparecer "Supabase conectado." e "Discord conectado como ...".

## Atualizando da versão 1

1. **Faça backup** do banco e guarde a mesma `MASTER_KEY` (as senhas gravadas continuam compatíveis).
2. Execute `002_hardening_sessions_private_storage.sql` (a 001 já foi aplicada antes).
3. Publique os comandos novamente (`npm run commands:deploy`): surgem `/cadastrar`, `/modelo foto`, `/modelo senhas`, `/modelo publicar`.
4. O bucket passa a ser **privado**. Fichas já publicadas pela v1 usavam URL pública da foto e **deixam de exibir a imagem** até serem republicadas: execute `/modelo publicar id` para cada modelo já publicada.
5. O cadastro deixa de usar coleta de mensagens do canal (que exigia Message Content Intent): agora é `/cadastrar` com anexo.

## Solução de problemas

| Sintoma | Causa provável / solução |
|---|---|
| `Configuração inválida: ...` ao iniciar | Variável ausente ou malformada; confira `.env.example`. `MASTER_KEY` precisa de 64 hex. |
| `Tabela "..." inacessível` | Migrations não aplicadas, ou `SUPABASE_URL`/`service_role` incorretos. |
| Aviso "bucket está PÚBLICO" | Aplique a migration 002. |
| Comandos não aparecem | Rode `npm run commands:deploy`; use `DISCORD_GUILD_ID` para teste imediato; reconvide o bot com o escopo `applications.commands`. |
| "O bot não tem permissão ... no canal" | Dê ao bot Ver canal, Enviar mensagens, Inserir links, Anexar arquivos e Ler histórico no canal. |
| "Canal ... não configurado" | Configure em `/painel`. |
| Foto recusada | Precisa ser JPG/PNG/WEBP estática, 9:16 (ex.: 1080×1920), ≥360×640 e dentro de `MAX_IMAGE_MB`. |
| "Sessão de cadastro inexistente ou expirada" | O prazo (`SESSION_TTL_MINUTES`) venceu: reinicie com `/cadastrar`. |
| "Interação expirada" nos logs | O Discord exige resposta em 3 s; ocorre com atraso de rede/banco e é ignorado com segurança. |
| Senhas não descriptografam | `MASTER_KEY` diferente da usada no cadastro. |
| "Muitas ações em pouco tempo" | Rate limit anti-spam; aguarde o tempo indicado. |
