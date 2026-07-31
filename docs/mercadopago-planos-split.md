# Integração Mercado Pago — Planos + Split de Pagamento

> Branch: `feat/integracao-mp` · App Mercado Pago: `saas church` (AppID `5795727007100907`)

## Context

O SaaS hoje registra pagamentos de inscrição **manualmente**: um operador cria linhas em `Parcela` (`src/routes/eventos.ts:1455`) e `calcularStatusPagamento` (`src/helpers/calcular-status-pagamento.ts`) deriva PENDENTE/PARCIAL/QUITADO somando essas parcelas. Não existe cobrança online, e o produto não tem modelo de receita.

Objetivo: cobrar o participante online via Mercado Pago, com o dinheiro caindo **na conta da própria instituição** (ela é a vendedora), e a plataforma retendo automaticamente uma comissão via **split de pagamento**. O plano inicial é **gratuito com acesso total** — a monetização vem exclusivamente do split, cujo percentual precisa ser **configurável por instituição** (negociação caso a caso, parceiros-piloto com taxa zero, etc.).

Estado atual da branch `feat/integracao-mp`: schema limpo, sem nenhum model de MP/plano/pagamento. As variáveis `MERCADO_PAGO_*` já existem no `.env`/`.env.prd` (naming a ser reaproveitado). App MP já criada: **`saas church`, AppID `5795727007100907`**.

### Decisões travadas com o usuário

| Decisão | Escolha |
|---|---|
| Checkout | **Checkout Pro** — redirect, split via `marketplace_fee` em `/checkout/preferences` |
| Assinatura SaaS | **Só estrutura** (`Plano` + seed free). Sem `preapproval` nesta entrega |
| Regra de split | **% + piso/teto**, com override por instituição sobre o padrão do plano |
| Persistência | **Estrutura MP 100% isolada** (`mp_pagamentos`). `Parcela` e o cálculo de status existente NÃO são tocados |

> **Restrição explícita do usuário**: não mexer na estrutura de `Parcela` nem na lógica de pagamento atual — isso pertence a outro aspecto do sistema. A integração MP cria tabelas próprias, com prefixo `mp_`, e nenhum arquivo existente de financeiro é alterado. `src/helpers/calcular-status-pagamento.ts` e `src/routes/eventos.ts` ficam intactos. A reconciliação entre as duas visões é **fora de escopo** desta entrega.

---

## Fatos da API MP que guiam o desenho

Confirmados via MCP (`search_documentation`, MLB/pt):

- **Split Checkout Pro**: `marketplace_fee` no `POST /checkout/preferences`, chamado com o **access_token OAuth da instituição**. Valor em **reais (BRL), não percentual**.
- **Ordem de dedução**: "primeiro a comissão do Mercado Pago é descontada e, em seguida, a comissão do Marketplace é descontada sobre o valor restante". Importante para exibir o líquido correto à instituição.
- **OAuth**: `authorization_code` dura **10 min, uso único**; `refresh_token` dura **6 meses e é reutilizável**. PKCE disponível.
- **Webhook `x-signature`**: header `ts=<unix>,v1=<hmac>`. Manifest = `id:[data.id];request-id:[x-request-id];ts:[ts];` → HMAC-SHA256 com o secret, comparar com `v1`. **Se `data.id` vier alfanumérico maiúsculo, converter para minúsculo.**
  - ⚠️ **O manifest NÃO usa o corpo da requisição.** Logo **não é preciso `express.raw()`** — o `express.json()` global em `src/server.ts:24` continua servindo. Evita o erro clássico de criar um body-parser paralelo.
- MP Assinaturas (`preapproval`) **não suporta split** — são fluxos independentes, o que valida a decisão de deixar preapproval fora desta entrega.

---

## Variáveis de ambiente

Reaproveitar os nomes já presentes no `.env`. Adicionar as marcadas com ➕ ao `.env`, `.env.prd` e **`.env.example`** (que hoje não tem nenhuma delas).

| Variável | Obrigatória | Descrição |
|---|---|---|
| `MERCADO_PAGO_APP_ID` | ➕ sim | `5795727007100907`. Usado para montar a URL de autorização OAuth. |
| `MERCADO_PAGO_CLIENT_ID` | sim | Client ID da app. Igual ao App ID, mas mantido separado por clareza. |
| `MERCADO_PAGO_CLIENT_SECRET` | sim | **Secret**. Troca `code`→token e refresh. Nunca logar. |
| `MERCADO_PAGO_ACCESS_TOKEN` | sim | Token da conta da **plataforma** (marketplace owner). Usado só para chamadas em nome próprio. Não é usado para criar preferences. |
| `MERCADO_PAGO_PUBLIC_KEY` | sim | Public key da plataforma. |
| `MERCADO_PAGO_REDIRECT_URI` | sim | Callback OAuth. Deve bater **exatamente** com o cadastrado no painel MP. Dev: `https://naturals-pure-clothes-proceeds.trycloudflare.com/mercadopago/oauth/callback` |
| `MERCADO_PAGO_WEBHOOK_SECRET` | sim | Secret de assinatura dos webhooks (painel MP → Webhooks). Valida `x-signature`. |
| `MP_TOKEN_ENCRYPTION_KEY` | sim | Chave AES-256-GCM, **32 bytes em base64**, para cifrar access/refresh tokens das instituições em repouso. Gerar: `openssl rand -base64 32`. |
| `MERCADO_PAGO_ENV` | ➕ não | `sandbox` \| `production` (default `production`). Só afeta logs e guard-rails; a base URL da API é a mesma. |
| `PLANO_PADRAO_CODIGO` | sim | Código do plano atribuído a instituição nova. Valor: `free`. |
| `SPLIT_PERCENTUAL_PADRAO` | ➕ não | Fallback do % do plano free se o seed não rodou. Sugestão `5`. |
| `CRON_SECRET` | sim | Bearer do cron de refresh de tokens. |
| `API_URL` | sim | Base pública da API. Monta `notification_url` e `redirect_uri`. Dev: `https://naturals-pure-clothes-proceeds.trycloudflare.com` |
| `FRONTEND_URL` | sim | Monta `back_urls` (success/failure/pending) do Checkout Pro. |

**Não existe variável de percentual por instituição.** O split por instituição é **dado no banco**, não config — é editável em runtime pelo backoffice.

---

## Passo a passo no Mercado Pago (o que VOCÊ faz no painel)

Trabalho manual, fora do código. As etapas 1–4 são **pré-requisito** para o passo 6 do plano de execução (OAuth) — as etapas 1–5 do código não dependem de nada aqui.

Painel: <https://www.mercadopago.com.br/developers/panel>

### Etapa 0 — Conta da plataforma

1. Confirmar que a conta MP dona da aplicação `saas church` é a **conta da plataforma** (CNPJ da Brinkstech), **não** a de nenhuma instituição. É essa conta que recebe o `marketplace_fee`.
2. Conta com CNPJ, e-mail e telefone verificados, e **dados bancários cadastrados** — sem isso a comissão fica retida sem poder ser sacada.
3. ⚠️ **Validar com o suporte/executivo de contas MP se o modelo marketplace com retenção de `marketplace_fee` precisa de liberação específica para a conta.** Em algumas contas o campo é aceito na preference mas ignorado na liquidação. Testar em sandbox (Etapa 4) resolve a dúvida antes de ir para produção — conferir `fee_details` no `GET /v1/payments/{id}` e ver se aparece a linha de comissão do marketplace.

### Etapa 1 — Configurar a aplicação `saas church`

Painel → **Suas integrações** → `saas church` (AppID `5795727007100907`) → **Configurações**.

1. **Modelo de negócio / solução de pagamento**: marcar **Marketplace** (não "loja própria"). Isso habilita o OAuth de vendedores.
2. **Produto**: **Checkout Pro**.
3. **Plataforma de e-commerce**: "Não uso" / integração própria.
4. Salvar. Se o painel não oferecer a opção Marketplace, é sinal de que a Etapa 0.3 precisa ser resolvida antes.

### Etapa 1.5 — Túnel HTTPS local (Cloudflare Tunnel)

> ⚠️ **Não use ngrok no plano grátis para o OAuth.** O interstitial de abuso do ngrok intercepta requisições com User-Agent de browser e devolve uma página "You are about to visit..." em vez de encaminhar para a API. Como o callback do OAuth é uma navegação de browser disparada **pelo Mercado Pago**, não há como injetar o header `ngrok-skip-browser-warning` — o `code` e o `state` simplesmente nunca chegam ao servidor, o nonce fica sem consumir e a conexão falha em silêncio.
>
> Sintoma exato: o browser para na URL do callback com `?code=...&state=...`, nada acontece, a tela continua "não conectado", e `oauth_nonces` mostra o nonce com `consumidoEm = null`.

**Cloudflare Tunnel resolve** — HTTPS público, sem interstitial, gratuito e sem conta.

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:3000
```

A URL (`https://<algo>.trycloudflare.com`) aparece no output. Continua mudando a cada restart, como no ngrok.

Teste que comprova a diferença — este é o que importa, porque é o que o Mercado Pago faz:

```bash
curl -s -H "User-Agent: Mozilla/5.0 ... Chrome/131.0.0.0 Safari/537.36" \
  -o /dev/null -w "%{http_code} %{redirect_url}\n" \
  "https://<tunel>/mercadopago/oauth/callback?code=x&state=inexistente"
```

- ✅ Correto: `302 http://localhost:3001/configuracoes/pagamentos?status=erro&motivo=state_invalido`
- ❌ Interstitial: `200` com HTML do ngrok

URL da sessão atual, validada com UA de browser:

```
https://naturals-pure-clothes-proceeds.trycloudflare.com
```

Subir tudo (três terminais):

```bash
cd saaschurch-api && pnpm dev            # API na 3000
cd saaschurch     && pnpm dev -p 3001    # front na 3001
cloudflared tunnel --url http://localhost:3000
```

⚠️ **Duas coisas a lembrar:**

1. **O subdomínio muda a cada restart do túnel.** Toda vez, reatualizar `API_URL` e `MERCADO_PAGO_REDIRECT_URI` no `.env`, **reiniciar a API** (o dotenv só lê no boot — `tsx watch` não recarrega env) e atualizar redirect URI + webhook no painel do MP. Para eliminar esse ciclo, um túnel nomeado do Cloudflare com domínio próprio dá URL fixa.
2. **O túnel expõe sua API local à internet pública** enquanto estiver de pé. Derrubar quando não estiver testando.

### Etapa 2 — Redirect URI do OAuth

Mesma tela de configurações da aplicação, seção **OAuth / URLs de redirecionamento**.

1. Cadastrar a URL de produção: `https://<seu-dominio-api>/mercadopago/oauth/callback`
2. Cadastrar a URL de teste (túnel da Etapa 1.5):
   ```
   https://naturals-pure-clothes-proceeds.trycloudflare.com/mercadopago/oauth/callback
   ```
3. **HTTPS obrigatório.** `localhost` não é aceito.
4. O valor precisa bater **caractere por caractere** com `MERCADO_PAGO_REDIRECT_URI` — barra final a mais/menos derruba o fluxo com `invalid_redirect_uri`.

### Etapa 3 — Credenciais

Painel → aplicação → **Credenciais de produção** e **Credenciais de teste**.

Copiar para o `.env` (teste) e `.env.prd` (produção):

| Painel | Variável |
|---|---|
| Client ID | `MERCADO_PAGO_CLIENT_ID` |
| Client Secret | `MERCADO_PAGO_CLIENT_SECRET` |
| Access Token | `MERCADO_PAGO_ACCESS_TOKEN` |
| Public Key | `MERCADO_PAGO_PUBLIC_KEY` |
| (AppID da aplicação) | `MERCADO_PAGO_APP_ID` = `5795727007100907` |

Atalho: `mcp__mercadopago__get_credentials` com `application_id: 5795727007100907` devolve tudo de uma vez.

🔒 **Client Secret e Access Token não entram em commit, print, chat ou log.** Só `.env` local e as env vars da Vercel. O `.env.example` recebe apenas os nomes, com valor vazio.

Gerar também a chave de cifragem dos tokens das instituições:

```bash
openssl rand -base64 32   # -> MP_TOKEN_ENCRYPTION_KEY
```

Guardar backup dessa chave fora do repositório. Perdê-la obriga **todas** as instituições a reconectar a conta.

### Etapa 4 — Webhooks

Painel → aplicação → **Webhooks**.

1. **URL de produção**: `https://<seu-dominio-api>/webhooks/mercadopago`
2. **URL de teste**:
   ```
   https://naturals-pure-clothes-proceeds.trycloudflare.com/webhooks/mercadopago
   ```
3. **Eventos** a marcar:
   - `payment` — Pagamentos (obrigatório)
   - `mp-connect` — Vinculação de aplicações (avisa quando uma instituição desvincula a conta)
4. Salvar e **copiar a assinatura secreta** que o painel exibe → `MERCADO_PAGO_WEBHOOK_SECRET`. Ela aparece uma vez; se perder, gerar outra e atualizar o `.env`.

Atalho via MCP:

```
mcp__mercadopago__save_webhook
  application_id: 5795727007100907
  callback:         https://<dominio-prod>/webhooks/mercadopago
  callback_sandbox: https://naturals-pure-clothes-proceeds.trycloudflare.com/webhooks/mercadopago
  topics: ["payment", "mp-connect"]
```

Diagnóstico depois: `mcp__mercadopago__notifications_history` mostra entregas, falhas e retentativas.

### Etapa 5 — Usuários de teste (sandbox)

Precisa de **dois**, ambos `site_id: MLB`:

| Perfil | Papel no teste |
|---|---|
| `seller` | Faz o papel da instituição. É com ele que você autoriza o OAuth. |
| `buyer` | Faz o papel do participante que paga. |

Via MCP: `mcp__mercadopago__create_test_user` (`profile: "seller"` e `profile: "buyer"`), e `mcp__mercadopago__add_money_test_user` se o comprador ficar sem saldo (MLB aceita 100–50000 BRL).

⚠️ Usuário de teste tem **e-mail e senha próprios** — logar numa janela anônima, senão o navegador usa sua sessão real e o OAuth vincula a **sua** conta em vez da do vendedor de teste.

Cartões de teste (MLB): aprovado `5031 4332 1540 6351`, CVV `123`, validade `11/30`, nome do titular `APRO` para aprovar / `OTHE` para recusar.

### Etapa 6 — Fluxo de teste ponta a ponta

1. Subir a API local + túnel HTTPS (Etapa 1.5). Conferir: `curl -s -o /dev/null -w "%{http_code}" https://naturals-pure-clothes-proceeds.trycloudflare.com/eventos` → `200`.
2. `GET /mercadopago/oauth/connect` → abrir a URL retornada **em janela anônima** → passar pelo interstitial do ngrok → logar com o **seller de teste** → autorizar.
3. Conferir no banco: `mercado_pago_accounts` com `status = ACTIVE` e os campos `accessTokenEnc`/`refreshTokenEnc` ilegíveis.
4. `POST /checkout/preferences` para um participante com produto pago → abrir o `init_point`.
5. Pagar com o **buyer de teste**.
6. Conferir: webhook chegou, `mp_pagamentos` virou `APPROVED`, e `GET /v1/payments/{id}` traz `fee_details` com a comissão do marketplace no valor esperado.
7. Confirmar o isolamento: `SELECT count(*) FROM parcelas` igual antes e depois.

### Etapa 7 — Qualidade e homologação

Antes de abrir para instituição real, rodar `mcp__mercadopago__quality_checklist` e `mcp__mercadopago__quality_evaluation`. Campos que o MP pontua e que devem estar na preference (implementar já no passo 7 do plano, é barato):

- `external_reference` — id do `MpPagamento`
- `back_urls` + `auto_return`
- `notification_url`
- `statement_descriptor` — o que aparece na fatura do cartão do participante. Usar algo reconhecível, tipo o nome da instituição; reduz contestação.
- `items[]` com `id`, `title`, `description`, `category_id`, `quantity`, `unit_price`
- `payer` com `name`, `surname`, `email`, `phone`, `identification` (CPF) — o cadastro do participante já tem esses dados
- `expires` / `date_of_expiration` — preference com validade curta
- `binary_mode` — decidir: `true` força aprovado/recusado sem estado pendente. Para inscrição de evento com vaga limitada, geralmente é o que se quer.

Se for necessária homologação formal, `mcp__mercadopago__form_homologation`.

### Etapa 8 — Produção

1. Trocar `.env.prd` para as **credenciais de produção** e configurar as mesmas variáveis no painel da **Vercel** (não só no arquivo local).
2. Webhook de produção apontando para o domínio real.
3. `MERCADO_PAGO_ENV=production`.
4. Conectar a **primeira instituição real** e rodar uma transação de valor baixo (R$ 1,00) ponta a ponta antes de liberar para o resto.
5. Conferir na conta da plataforma se a comissão daquela transação apareceu.

### O que cada instituição faz (não é você)

Vale documentar para o suporte:

1. Ter conta Mercado Pago própria com CNPJ da igreja/instituição.
2. No sistema: Configurações → Pagamentos → **Conectar Mercado Pago**.
3. Logar na conta MP **da instituição** e autorizar.
4. Pronto — pagamentos de inscrição caem direto na conta dela, com a comissão já descontada.

---

## Modelo de dados

`prisma/schema.prisma` usa `relationMode = "prisma"` — sem FK no banco, então toda relation precisa de `@@index` explícito.

### Novos models

```prisma
enum MercadoPagoAccountStatus { PENDING ACTIVE EXPIRED REVOKED }
enum MpPagamentoStatus { PENDING IN_PROCESS APPROVED REJECTED REFUNDED CANCELLED CHARGED_BACK }

model Plano {
  id            String  @id @default(uuid())
  codigo        String  @unique          // "free"
  nome          String
  descricao     String?
  valorMensal   Decimal @default(0)      // 0 no free
  // padrões de split herdados pelas instituições
  feePercentual Decimal @default(0)
  feeMinimo     Decimal @default(0)
  feeMaximo     Decimal?
  features      Json    @default("{}")   // free = acesso total
  ativo         Boolean @default(true)
  ordem         Int     @default(0)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  instituicoes  Instituicao[]
  @@map("planos")
}

model MercadoPagoAccount {
  id              String   @id @default(uuid())
  instituicaoId   String   @unique
  mpUserId        String                     // collector_id do vendedor
  accessTokenEnc  String                     // AES-256-GCM
  refreshTokenEnc String
  publicKey       String
  scope           String?
  expiresAt       DateTime                   // expiry do access_token
  refreshExpiresAt DateTime?                 // ~6 meses
  status          MercadoPagoAccountStatus @default(PENDING)
  ultimoRefreshEm DateTime?
  ultimoErro      String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  instituicao     Instituicao @relation(fields: [instituicaoId], references: [id], onDelete: Cascade)
  @@index([instituicaoId]) @@index([status])
  @@map("mercado_pago_accounts")
}

model OAuthNonce {              // state anti-CSRF do fluxo OAuth + PKCE
  nonce         String   @id
  instituicaoId String
  codeVerifier  String                       // PKCE
  consumidoEm   DateTime?
  expiraEm      DateTime                     // now + 10min
  createdAt     DateTime @default(now())
  @@index([expiraEm])
  @@map("oauth_nonces")
}

// Tabela própria da integração MP. Não substitui nem alimenta `Parcela`.
// `participanteId` / `participanteProdutoId` são referências FRACAS (sem @relation)
// justamente para não adicionar campos de volta nos models de inscrição.
model MpPagamento {
  id                    String @id @default(uuid())
  instituicaoId         String
  participanteId        String
  participanteProdutoId String?
  mpPreferenceId        String?  @unique
  mpPaymentId           String?  @unique     // só existe após o webhook
  externalReference     String   @unique     // idempotência na criação
  status                MpPagamentoStatus @default(PENDING)
  statusDetail          String?
  valor                 Decimal
  splitValor            Decimal            // marketplace_fee enviado, em BRL
  splitPercentualAplicado Decimal          // snapshot da regra no momento
  metodoPagamento       String?
  parcelasCartao        Int      @default(1)
  aprovadoEm            DateTime?
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt
  instituicao           Instituicao @relation(fields: [instituicaoId], references: [id], onDelete: Cascade)
  @@index([instituicaoId]) @@index([participanteId])
  @@index([participanteProdutoId]) @@index([status])
  @@index([status, createdAt])
  @@map("mp_pagamentos")
}

model MpWebhookLog {
  id           String   @id @default(uuid())
  mpEventId    String
  tipo         String
  action       String?
  payload      Json
  processado   Boolean  @default(false)
  erro         String?
  tentativas   Int      @default(0)
  processadoEm DateTime?
  createdAt    DateTime @default(now())
  @@unique([mpEventId, tipo, action])   // dedup de reentrega
  @@index([processado])
  @@map("mp_webhook_logs")
}
```

### Alterações em `Instituicao`

```prisma
  planoId           String?
  plano             Plano?    @relation(fields: [planoId], references: [id])
  planoAtribuidoEm  DateTime?
  // overrides de split — null = herda do plano
  splitPercentual   Decimal?
  splitMinimo       Decimal?
  splitMaximo       Decimal?
  splitObservacao   String?     // por que essa taxa foi negociada
  mercadoPagoAccount MercadoPagoAccount?
  mpPagamentos       MpPagamento[]
  @@index([planoId])
```

Estas são as **únicas** alterações em models existentes — todas aditivas (colunas nullable + relations novas). `Parcela`, `ParticipanteProdutos`, `Participantes` e `ProdutosEvento` ficam inalterados.

### Migração

⚠️ `prisma/migrations/` está **gitignored** e o banco tem drift conhecido. **Não usar `migrate dev` nem `reset`.**

No Prisma 7 as flags mudaram: `--from-url` e `--to-schema-datamodel` foram **removidas**, e `db execute` não aceita mais `--url` — a datasource sai de `prisma.config.ts`, que já lê `DIRECT_URL`.

```bash
# 1. gerar
./node_modules/.bin/prisma migrate diff \
  --from-config-datasource --to-schema prisma/schema.prisma \
  --script > /tmp/mp.sql

# 2. AUDITAR antes de aplicar — este passo não é opcional
grep -inE "DROP TABLE|DROP COLUMN|DROP TYPE|TRUNCATE|DELETE FROM" /tmp/mp.sql

# 3. aplicar
./node_modules/.bin/prisma db execute --file /tmp/mp.sql
./node_modules/.bin/prisma migrate resolve --applied <nome_da_migration>
./node_modules/.bin/prisma generate
```

> O hook do RTK quebra `pnpm prisma ...` neste ambiente (`rtk: No such file or directory`). Chamar o binário direto em `./node_modules/.bin/prisma` contorna.

#### Drift resolvido em 2026-07-26

O banco estava **à frente de todas as branches**: `_prisma_migrations` registrava `add_planos_e_pagamentos` e `conciliacao_bancaria`, mas nenhum `schema.prisma` commitado descrevia essas tabelas. O primeiro `migrate diff` gerou um script que dropava **8 tabelas, duas com dados** (`transacoes_bancarias` 11 linhas, `contas_bancarias` 1 linha) além de colunas de `planos` (3 linhas).

Resolvido alinhando o schema ao banco antes de evoluir: os models de conciliação (de `feat/conciliacao`) e os órfãos (`Plano`, `MercadoPagoAccount`, `OAuthNonce`, `Assinatura`, `Pagamento`, `WebhookLog`) foram trazidos para o `schema.prisma` desta branch. Depois disso o diff virou aditivo e foi aplicado com zero perda de dados.

`Assinatura`, `Pagamento` e `WebhookLog` estão modelados mas **não são usados** pela integração — são peso morto da tentativa anterior, mantidos só para o diff fechar. Podem ser dropados numa limpeza separada depois de confirmado que ninguém depende deles.

### Seed do plano gratuito

`prisma/seed-planos.ts` (rodar com `pnpm prisma:seed:planos`). Independente do `seed.ts` de RBAC, para não reprocessar roles/permissions só por causa de plano.

O plano gratuito **reaproveita a linha `PILOTO_FREE`** que já existia no banco, em vez de criar um segundo plano de valor zero concorrendo com ela. O seed renomeia para "Gratuito", zera a mensalidade, marca `features.acessoTotal = true` e faz o backfill de `planoId` nas instituições sem plano.

O `feeEventoPercentual` **só é definido na criação**. Num plano que já existe ele não é sobrescrito: é valor comercial possivelmente negociado, e um seed idempotente não pode mudar quanto se cobra ao ser rodado de novo. Estado atual: `PILOTO_FREE` a **3,5%**, 1 instituição vinculada.

Os planos `ESSENCIAL` (R$99) e `PRO` (R$249) continuam na tabela, intocados, sem nenhuma instituição vinculada.

---

## Arquivos a criar

Seguir o padrão existente: router Express + `try/catch` por handler + `prisma` de `src/lib/prisma/client.js` + `console.error` + `res.status(n).json({ error })`. **Imports com extensão `.js`** (ESM). Validação manual, sem zod (o projeto não usa).

| Arquivo | Responsabilidade |
|---|---|
| `src/lib/mercadopago/client.ts` | `mpFetch(path, { token, method, body, idempotencyKey })` sobre `fetch` nativo. Base `https://api.mercadopago.com`. Erro MP → `MercadoPagoError` com status + `cause`. **Nunca logar o token.** |
| `src/lib/mercadopago/crypto.ts` | `encryptToken`/`decryptToken` — AES-256-GCM, `MP_TOKEN_ENCRYPTION_KEY`, IV aleatório por token, formato `iv:authTag:ciphertext` em base64. |
| `src/lib/mercadopago/oauth.ts` | `buildAuthorizationUrl(state, codeChallenge)`, `exchangeCode(code, codeVerifier)`, `refreshAccessToken(refreshToken)`. Endpoint `POST /oauth/token`. |
| `src/lib/mercadopago/signature.ts` | `validateWebhookSignature({ xSignature, xRequestId, dataId })` — monta o manifest, HMAC-SHA256, compara com `crypto.timingSafeEqual`. Rejeita `ts` com mais de ~5 min de idade (replay). |
| `src/helpers/split.helper.ts` | **Núcleo da regra.** `resolveRegraSplit(instituicao, plano)` e `calcularSplit(valor, regra)` conforme fórmula abaixo. |
| `src/helpers/plano.helper.ts` | `getPlanoDaInstituicao(instituicaoId)`, `temFeature(instituicaoId, chave)`. No free tudo retorna `true` — o gating existe estruturalmente mas não bloqueia nada hoje. |
| `src/routes/planos.ts` | CRUD de planos (backoffice) + endpoints de override de split por instituição. |
| `src/routes/mercadopago.ts` | Fluxo OAuth de conexão da conta da instituição. |
| `src/routes/checkout.ts` | Criação da preference (rota **pública**). |
| `src/routes/webhooks.ts` | Recepção e processamento de notificações. Escreve só em `mp_*`. |
| `src/routes/jobs.ts` | `POST /jobs/refresh-mp-tokens`, protegido por `CRON_SECRET`. |
| `src/lib/mercadopago/token.ts` | **Não previsto no plano original.** `getAccessTokenInstituicao()` — decifra o token e renova de forma transparente se falta menos de 10 min para vencer. Checkout e webhook precisavam do mesmo comportamento; decifrar token espalhado em dois lugares seria pior. |

### Regra de split — `src/helpers/split.helper.ts`

Os campos do plano mantêm os nomes `feeEvento*` — as colunas já existiam no banco com dados, e renomear seria DDL sem ganho funcional.

```ts
resolveRegraSplit(inst, plano) => {
  percentual: inst.splitPercentual ?? plano.feeEventoPercentual,
  minimo:     inst.splitMinimo     ?? plano.feeEventoMinimo,
  maximo:     inst.splitMaximo     ?? plano.feeEventoMaximo ?? null,
  origem: { percentual: 'plano' | 'instituicao', ... },  // para a UI
}

calcularSplit(valor, regra) => {
  fee = valor * (percentual / 100)
  fee = max(fee, minimo)
  fee = min(fee, maximo ?? Infinity)
  fee = min(fee, valor)            // nunca engole o valor inteiro
  return round(fee, 2)
}
```

`resolveRegraSplit` devolve também a `origem` de cada campo, para a UI mostrar o que é herdado do plano e o que foi sobrescrito.

Invariantes cobertas por teste (30 asserções, todas passando):
- `percentual = 0` (parceiro-piloto) → fee `0`, e nesse caso o `marketplace_fee` é **omitido** da preference em vez de enviado como `0`.
- ticket baixo com piso alto → fee limitado pelo próprio valor, nunca maior.
- `splitPercentual = 0` é override legítimo e **não** é confundido com `null` (que herda) — a distinção entre "taxa zero negociada" e "sem override" é a regra mais fácil de errar aqui.
- `Decimal` do Prisma passa por `Number()` explícito, mesmo padrão de `calcular-status-pagamento.ts`.

Script de teste em `scratchpad/test-split.ts`, rodável com `tsx`. O projeto não tem runner de testes configurado.

---

## Endpoints

### Planos e configuração de split — `src/routes/planos.ts` → `/planos`

Backoffice (`authenticateUser, requireBackoffice` de `src/middleware/auth.middleware.ts`):

- `GET /planos` — lista.
- `POST /planos` · `PUT /planos/:id` — CRUD.
- `PUT /instituicoes/:id/plano` — atribui plano, grava `planoAtribuidoEm`.
- `GET /instituicoes/:id/split` — retorna regra **efetiva** (com `origem: 'plano' | 'instituicao'` por campo, para a UI mostrar o que é herdado).
- `PUT /instituicoes/:id/split` — grava overrides. Aceita `null` para voltar a herdar. Validar `0 ≤ percentual ≤ 100`, `minimo ≥ 0`, `maximo ≥ minimo`.

Instituição (`authenticateUser`, escopo `req.user.instituicaoId`):
- `GET /planos/meu` — plano atual + regra de split efetiva (read-only; a instituição vê a taxa mas não edita).

### OAuth — `src/routes/mercadopago.ts` → `/mercadopago`

- `GET /mercadopago/oauth/connect` — auth + `requireBackoffice` ou `requireUserType('lider')`. Gera `nonce` + PKCE `code_verifier`, grava `OAuthNonce` (TTL 10 min, casando com a validade do `authorization_code`), devolve `{ authorizationUrl }`.
- `GET /mercadopago/oauth/callback` — **rota pública** (o MP redireciona o browser). Valida `state` contra `OAuthNonce` não consumido e não expirado → marca consumido → troca `code` por tokens → cifra e faz upsert em `MercadoPagoAccount` com `status: ACTIVE` → redireciona para `${FRONTEND_URL}/configuracoes/pagamentos?status=ok|erro`. **Nunca retornar token no body nem na URL.**
- `GET /mercadopago/status` — auth. `{ conectado, mpUserId, status, expiraEm }`. Sem tokens.
- `DELETE /mercadopago/conta` — auth + backoffice. Marca `REVOKED`, zera os campos cifrados.

### Checkout — `src/routes/checkout.ts` → `/checkout`

- `POST /checkout/preferences` — **público** (participante não é usuário do sistema, igual à inscrição em `src/routes/eventos.ts:484`). Body: `{ participanteId, produtoId, recaptchaToken }`.
  1. Validar reCAPTCHA reusando `verifyRecaptcha` de `src/middleware/recaptcha.ts` — a rota é pública e cria carga externa.
  2. Carregar `ParticipanteProdutos` + `produto` + `evento` + `instituicao.plano`. Rejeitar se `produto.exigePagamento === false`.
  3. **O valor vem do banco** (`produto.valor`), nunca do body — senão o cliente escolhe quanto pagar.
  4. Se já existir `MpPagamento` `APPROVED` para esse `participanteProdutoId` → `409`.
  5. Se existir `MpPagamento` `PENDING` recente com preference válida → devolver o mesmo `init_point` (idempotência).
  6. `MercadoPagoAccount` da instituição precisa estar `ACTIVE`; senão `409 { error: 'Instituição não conectada ao Mercado Pago' }`.
  7. `calcularSplit` → `marketplace_fee`.
  8. `POST /checkout/preferences` **com o access_token da instituição**, com `external_reference` = id do `MpPagamento` recém-criado, `notification_url` = `${API_URL}/webhooks/mercadopago`, `back_urls` a partir de `FRONTEND_URL`, `auto_return: 'approved'`, `expires` curto.
  9. Persistir `MpPagamento` com `mpPreferenceId`, `splitValor`, `splitPercentualAplicado` (snapshot — mudar a taxa depois não reescreve o histórico).
  10. Responder `{ init_point, mpPagamentoId }`.

  Este endpoint **só lê** `ParticipanteProdutos`/`ProdutosEvento` para obter o valor. Não escreve nada neles.

### Webhook — `src/routes/webhooks.ts` → `/webhooks`

- `POST /webhooks/mercadopago` — público, sem auth de usuário. `express.json()` global basta (o manifest não usa o body).
  1. Validar `x-signature` → inválida = `401` e **não processa**.
  2. `upsert` em `MpWebhookLog` pela unique `(mpEventId, tipo, action)`. Já processado → `200` imediato (dedup de reentrega).
  3. Filtrar `type === 'payment'`.
  4. `GET /v1/payments/{id}` **com o token da instituição**. Nunca confiar no status vindo do payload.

     ⚠️ **Achado durante a implementação**: a notificação do MP carrega **apenas `data.id`** (o id do payment) — não traz `external_reference`. Isso cria um impasse: para consultar o payment é preciso o token da instituição, mas para saber a instituição seria preciso o payment. Resolvido embutindo o `external_reference` na `notification_url` que nós mesmos montamos na criação da preference:

     ```
     notification_url: ${API_URL}/webhooks/mercadopago?ref=<externalReference>
     ```

     Como o `ref` chega por uma URL que trafega externamente, o handler ainda confere que o `external_reference` do payment retornado bate com o do registro local — um `ref` trocado não atualiza o pagamento errado.
  5. Mapear status MP → `MpPagamentoStatus`, atualizar `MpPagamento` (`mpPaymentId`, `statusDetail`, `metodoPagamento`, `parcelasCartao`, `aprovadoEm`).
  6. **Transição só avança** — ignorar webhook que tente rebaixar `APPROVED` para `PENDING` (reentregas fora de ordem).
  7. `200` sempre que o evento foi recebido e registrado; erro interno → gravar em `MpWebhookLog.erro`, incrementar `tentativas` e **retornar 500** para o MP reenviar.
  8. ⏱ `vercel.json` limita a função a **10 s** — o handler precisa ser enxuto: validar, logar, buscar 1 payment, atualizar. Sem e-mail síncrono aqui.
  9. O webhook **escreve exclusivamente em `mp_pagamentos` e `mp_webhook_logs`**. Não cria `Parcela`, não altera `ParticipanteProdutos`, não toca `data_pagamento`.

### Consulta dos pagamentos MP — `/mercadopago/pagamentos`

Como a estrutura é isolada, a leitura também é. Endpoints próprios, `authenticateUser` + escopo por `req.user.instituicaoId`:

- `GET /mercadopago/pagamentos?eventoId=&status=&participanteId=` — lista paginada de `MpPagamento`.
- `GET /mercadopago/pagamentos/:id` — detalhe, incluindo `splitValor` e `splitPercentualAplicado`.

Assim o front consegue exibir os pagamentos online **sem** que nenhuma tela ou endpoint financeiro atual precise mudar.

### O que NÃO é alterado

Lista explícita, para conferência no code review:

- `src/helpers/calcular-status-pagamento.ts` — intocado. Assinatura e comportamento idênticos.
- `src/routes/eventos.ts` — intocado. Nenhuma rota de parcela/produto/participante é modificada.
- Models `Parcela`, `ParticipanteProdutos`, `Participantes`, `ProdutosEvento` — nenhum campo novo, nenhuma relation nova.
- Tabela `parcelas` — nenhuma escrita em nenhum caminho da integração.

Verificado após a implementação: `git diff --stat` não toca nenhum desses arquivos.

---

## Status da implementação (2026-07-26)

Passos 1–10 do plano de execução **concluídos**. `tsc --noEmit` limpo, servidor sobe, rotas respondem.

| Rota | Sem credencial | Verificado |
|---|---|---|
| `GET /planos`, `/planos/meu` | 401 | ✅ |
| `GET /mercadopago/status`, `/pagamentos` | 401 | ✅ |
| `POST /checkout/preferences` | 400 (valida reCAPTCHA antes de tudo) | ✅ |
| `POST /webhooks/mercadopago` | 401 (assinatura inválida) | ✅ |
| `POST /jobs/refresh-mp-tokens` | 401 | ✅ |
| `GET /mercadopago/oauth/callback` | 302 → `?status=erro&motivo=parametros_ausentes` | ✅ |

**Não verificado ainda** — depende das Etapas 1–5 do painel MP: fluxo OAuth real, criação de preference, recebimento de webhook e conferência do `fee_details`. Nenhuma chamada real ao Mercado Pago foi feita até aqui.

### Pendências de configuração antes do teste ponta a ponta

Auditoria do `.env` atual (valores não impressos):

| Variável | Situação |
|---|---|
| `MERCADO_PAGO_APP_ID`, `CLIENT_ID`, `CLIENT_SECRET`, `ACCESS_TOKEN`, `PUBLIC_KEY` | ✅ preenchidas |
| `MERCADO_PAGO_WEBHOOK_SECRET`, `CRON_SECRET` | ✅ preenchidas |
| `MP_TOKEN_ENCRYPTION_KEY` | ❌ **inválida — 48 bytes, o AES-256 exige 32** |
| `MERCADO_PAGO_REDIRECT_URI` | ⚠️ aponta para o domínio do **front** (`app.igrejaformosadecristo.com`), não da API |
| `API_URL` | ⚠️ `http://localhost:3000` — o MP não alcança; precisa ser o túnel/domínio público |
| `SPLIT_PERCENTUAL_PADRAO`, `MERCADO_PAGO_ENV` | vazias (opcionais, têm default) |

1. **Regerar a chave de cifragem** — a atual tem 48 bytes e faz `encryptToken` lançar no primeiro OAuth. Regerar é seguro agora: `mercado_pago_accounts` está vazia, então não há nada cifrado para perder.
   ```bash
   openssl rand -base64 32   # -> MP_TOKEN_ENCRYPTION_KEY
   ```
2. **Corrigir `MERCADO_PAGO_REDIRECT_URI`** — o callback é rota da API (`/mercadopago/oauth/callback`), não do front. Em dev, apontar para o túnel.
3. **`API_URL`** com a URL pública do túnel — é o que monta a `notification_url` da preference.
4. Subir o túnel e cadastrar redirect URI + webhook no painel (Etapas 2 e 4).
5. Criar os usuários de teste (Etapa 5).

Consequência aceita: o status financeiro exibido hoje continua refletindo **só** os lançamentos manuais de `Parcela`. Unificar as duas visões é decisão de produto para uma etapa posterior, não desta entrega.

### Cron de refresh de token

`refresh_token` vale 6 meses; o `access_token` bem menos. Job diário renovando contas `ACTIVE` com `expiresAt` em menos de 48 h; falha → `status: EXPIRED` + `ultimoErro`. Expor como `POST /jobs/refresh-mp-tokens` protegido por `Authorization: Bearer ${CRON_SECRET}` e agendar em `vercel.json` (`crons`).

### Registro em `src/server.ts`

Adicionar após as rotas existentes (`src/server.ts:26-32`):

```ts
app.use('/planos', planosRoutes);
app.use('/mercadopago', mercadopagoRoutes);
app.use('/checkout', checkoutRoutes);
app.use('/webhooks', webhooksRoutes);
app.use('/jobs', jobsRoutes);
```

O `cors` atual tem allowlist fixa (`src/server.ts:15-21`) — webhook e callback OAuth são server-to-server/redirect de browser, não passam por CORS, então não precisam entrar na lista.

---

## Ordem de execução

1. Schema + migração (diff/execute/resolve) + `generate`.
2. Seed do plano `free` + backfill de `planoId` nas instituições.
3. `crypto.ts`, `client.ts`, `oauth.ts`, `signature.ts`.
4. `split.helper.ts` + `plano.helper.ts`.
5. `/planos` (CRUD + override de split) — já dá para configurar a taxa por instituição.
6. `/mercadopago` OAuth.
7. `/checkout/preferences`.
8. `/webhooks/mercadopago` + `/mercadopago/pagamentos` (leitura).
9. Cron de refresh.
10. `.env.example` atualizado + este doc.

Passos 1–5 entregam **planos e split configurável** de ponta a ponta sem depender de nenhuma chamada ao MP — dá para validar isoladamente.

---

## Verificação

**Unitário (sem MP)** — não há runner de testes no projeto hoje; usar `tsx` num script em `scratchpad`:
- `calcularSplit`: 5% de R$250 → 12,50 · piso R$0,50 em ticket de R$5 a 1% → 0,50 · teto · percentual 0 → 0 · fee nunca > valor.
- `resolveRegraSplit`: override parcial (só `splitPercentual` setado) herda `minimo`/`maximo` do plano.
- `encryptToken`/`decryptToken` round-trip; ciphertext diferente a cada chamada (IV aleatório).
- `validateWebhookSignature` com um manifest conhecido e secret fixo.

**Integração com MP (sandbox)**, via MCP:
1. `mcp__mercadopago__create_test_user` — um `seller` (a "instituição") e um `buyer`, `site_id: MLB`.
2. `mcp__mercadopago__get_credentials` (app `5795727007100907`) para `CLIENT_ID`/`CLIENT_SECRET`. **Credenciais não vão para o repositório nem para o chat — direto no `.env` local.**
3. Expor a API local (`pnpm dev` + túnel HTTPS) e `mcp__mercadopago__save_webhook` com `callback_sandbox` = `<tunel>/webhooks/mercadopago` e `topics: ['payment', 'mp-connect']`.
4. Cadastrar o mesmo túnel como `redirect_uri` no painel MP e em `MERCADO_PAGO_REDIRECT_URI`.
5. `GET /mercadopago/oauth/connect` → autorizar com o **seller de teste** → conferir `MercadoPagoAccount` `ACTIVE` e que os campos `*Enc` no banco estão ilegíveis.
6. `POST /checkout/preferences` para um participante real → abrir `init_point` → pagar com o **buyer de teste** (usar `mcp__mercadopago__add_money_test_user` se faltar saldo).
7. Conferir: `MpPagamento` vira `APPROVED`; `GET /v1/payments/{id}` mostra `fee_details` com a comissão do marketplace; `GET /mercadopago/pagamentos` lista a transação com o split correto.
8. **Confirmar isolamento**: nenhuma linha nova em `parcelas` e nenhum `data_pagamento` alterado após o fluxo completo — `SELECT count(*) FROM parcelas` antes/depois.
9. Reenviar o mesmo webhook manualmente → deve retornar `200` sem duplicar nada (dedup pela unique de `mp_webhook_logs`).
10. Enviar webhook com `x-signature` adulterada → `401`.
11. `mcp__mercadopago__notifications_history` para conferir entregas e retentativas.
12. Antes de produção: `mcp__mercadopago__quality_checklist` / `quality_evaluation` na app.

**Cenários negativos a exercitar**: instituição sem MP conectado (`409`); produto com `exigePagamento: false` (`400`); segunda preference para produto já `APPROVED` (`409`); instituição com `splitPercentual = 0` → preference **sem** `marketplace_fee`.

---

## Riscos

- **Tokens de terceiros em repouso** — mitigado por AES-256-GCM com `MP_TOKEN_ENCRYPTION_KEY`. Perder essa chave = todas as instituições precisam reconectar. Guardar fora do repo, com backup.
- **`marketplace_fee` é valor absoluto, não %** — erro aqui cobra a mais/menos do cliente real. Daí o snapshot de `splitPercentualAplicado` em cada `MpPagamento` para auditoria.
- **Timeout de 10 s da Vercel** no webhook — manter o handler mínimo.
- **`relationMode = "prisma"`** — sem FK no banco; deletar uma instituição não limpa `mp_pagamentos`/`mercado_pago_accounts` no nível do banco. O Prisma emula no client, mas SQL direto não.
- **Duas visões financeiras coexistindo** — consequência direta e aceita do isolamento pedido: `Parcela` (lançamento manual) e `MpPagamento` (online) não se falam. Um participante pode aparecer como `PENDENTE` na tela atual mesmo tendo pago online. **Alinhar isso com o produto antes de expor o checkout a usuários reais**; a unificação é escopo de outra entrega.
