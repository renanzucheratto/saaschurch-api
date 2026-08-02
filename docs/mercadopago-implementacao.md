# Integração Mercado Pago — Documentação Técnica

> Documenta **como a integração foi implementada** no código atual da branch `feat/integracao-mp`.
> Para o histórico de decisões e o passo a passo de configuração no painel do Mercado Pago, ver
> [`mercadopago-planos-split.md`](./mercadopago-planos-split.md). Para a tela do front, ver
> [`mercadopago-tela-integracao.md`](./mercadopago-tela-integracao.md).

## Visão geral

A instituição (igreja) recebe pagamentos de inscrição de evento **na própria conta Mercado Pago**,
via **Checkout Pro**. A plataforma (Brinkstech) retém uma comissão automática no ato do pagamento,
usando o mecanismo de **split** do MP (`marketplace_fee`). O percentual de comissão vem de um
**plano** (`Plano`), com possibilidade de **override por instituição**.

Toda a estrutura de dados da integração é isolada, com tabelas próprias prefixadas `mp_` (mais
`mercado_pago_accounts`, `oauth_nonces`, `planos`). Nenhuma tabela do fluxo financeiro existente
(`Parcela`, `ParticipanteProdutos`, `Participantes`, `ProdutosEvento`) é lida para escrita nem
alterada por este código.

### Componentes

```
src/lib/mercadopago/
  client.ts      — wrapper do SDK oficial `mercadopago`, erro normalizado, nunca loga token
  crypto.ts      — AES-256-GCM para os tokens OAuth das instituições em repouso
  oauth.ts       — Authorization Code + PKCE (buildAuthorizationUrl / exchangeCode / refreshAccessToken)
  signature.ts   — validação HMAC do header x-signature dos webhooks
  token.ts       — getAccessTokenInstituicao(): decifra e renova token de forma transparente
  log.ts         — log estruturado do fluxo MP, com "impressão digital" de token (nunca o valor)

src/helpers/
  split.helper.ts  — resolveRegraSplit() / calcularSplit() / validarOverridesSplit()
  plano.helper.ts  — getPlanoDaInstituicao() / temFeature() (gating por plano)

src/routes/
  planos.ts        — CRUD de planos + configuração de split (backoffice)
  mercadopago.ts    — OAuth de conexão da conta da instituição + status/verificação/pagamentos
  checkout.ts       — criação da preference de pagamento (rota pública)
  webhooks.ts       — recepção das notificações do Mercado Pago
  jobs.ts           — cron de refresh de token
```

Registro em `src/server.ts:47-53`:

```ts
app.use('/planos', planosRoutes);
app.use('/mercadopago', mercadopagoRoutes);
app.use('/checkout', checkoutRoutes);
app.use('/webhooks', webhooksRoutes);
app.use('/jobs', jobsRoutes);
```

`validarChaveCifragem()` (de `crypto.ts`) é chamada no boot do servidor — se
`MP_TOKEN_ENCRYPTION_KEY` estiver ausente ou com tamanho errado, o erro aparece ao subir a API, não
no meio do primeiro OAuth de um usuário real.

---

## Modelo de dados

`prisma/schema.prisma:405-627`. `relationMode = "prisma"` está ativo no projeto — sem FK real no
banco, então toda relação leva `@@index` explícito.

| Model | Mapeia para | Papel |
|---|---|---|
| `Plano` | `planos` | Define percentual/piso/teto padrão de split e o valor da mensalidade do SaaS |
| `MercadoPagoAccount` | `mercado_pago_accounts` | Uma linha por instituição conectada; guarda tokens cifrados |
| `OAuthNonce` | `oauth_nonces` | `state` do fluxo OAuth + `code_verifier` do PKCE, TTL de 10 min, uso único |
| `MpPagamento` | `mp_pagamentos` | Uma linha por tentativa de cobrança (preference → pagamento) |
| `MpWebhookLog` | `mp_webhook_logs` | Log de toda notificação recebida, com dedup |

Campos-chave de `MercadoPagoAccount` (`schema.prisma:537-557`): `mpUserId` (collector_id do
vendedor), `accessTokenEnc`/`refreshTokenEnc` (cifrados), `expiresAt`/`refreshExpiresAt`, `status`
(`PENDING | ACTIVE | EXPIRED | REVOKED`), `ultimoRefreshEm`, `ultimoErro`.

Campos-chave de `MpPagamento` (`schema.prisma:577-607`): `externalReference` (UUID gerado por nós,
único, usado como idempotência e como chave de correlação do webhook), `mpPreferenceId`,
`mpPaymentId` (só existe depois do webhook), `valor` (sempre do produto, nunca do body da
requisição), `splitValor` e `splitPercentualAplicado` (snapshot da regra no momento da criação —
mudar a taxa depois não reescreve o histórico), `initPoint`, `expiraEm`.

`participanteId`/`participanteProdutoId`/`eventoId` em `MpPagamento` são **referências fracas**,
sem `@relation` — decisão deliberada para não adicionar colunas de volta aos models de inscrição.

`MpWebhookLog` usa `action String @default("")` em vez de `String?` (`schema.prisma:616`): no
Postgres, `NULL` é distinto de `NULL` em índice único, o que quebraria a dedup de reentrega sempre
que `action` viesse ausente. String vazia dedupa corretamente.

Em `Instituicao`: `planoId`, `planoAtribuidoEm`, `planoAtribuidoPor`, e os overrides
`splitPercentual`/`splitMinimo`/`splitMaximo`/`splitObservacao` (todos nullable — `null` = herda do
plano).

Duas tabelas **modeladas mas não usadas** por esta integração: `Assinatura` e `Pagamento`/
`WebhookLog` (sem prefixo `mp_`) — resíduo de uma tentativa anterior, mantidas só para o
`migrate diff` permanecer aditivo (`schema.prisma:466-469`).

---

## `src/lib/mercadopago/client.ts` — acesso à API do MP

Usa o **SDK oficial `mercadopago`** (`^3.2.1`), não `fetch` cru. Ideia central: o SDK cria um
`MercadoPagoConfig` por chamada — nunca um cliente global compartilhado — porque o `access_token`
muda por instituição e a `idempotencyKey` do config vale para todas as chamadas feitas com ele.

```ts
clientePreference(accessToken, opcoes)   // Preference
clientePagamento(accessToken, opcoes)    // Payment
clienteUsuario(accessToken, opcoes)      // User — GET /users/me
clienteOAuthPlataforma(opcoes)           // OAuth, sempre com MERCADO_PAGO_ACCESS_TOKEN da plataforma
chamarMp(contexto, fn)                   // wrapper: normaliza erro, mede tempo, loga
```

`MercadoPagoError` normaliza o que o SDK lança — que em erro HTTP é o **corpo JSON cru** do MP, não
um `Error` — extraindo `status`, `message`/`error`, e `cause[0].description` (onde o MP costuma
detalhar o motivo real de uma rejeição).

Timeout padrão de 8s (`TIMEOUT_PADRAO_MS`), coerente com o teto de 10s da função na Vercel
(`vercel.json` → `maxDuration: 10`).

**Regra do arquivo inteiro**: o `access_token` nunca aparece em log, mensagem de erro ou stack.

---

## `src/lib/mercadopago/crypto.ts` — cifragem dos tokens

AES-256-GCM. Formato serializado: `base64(iv):base64(authTag):base64(ciphertext)`.

- Chave: `MP_TOKEN_ENCRYPTION_KEY`, 32 bytes em base64 (`openssl rand -base64 32`), cacheada em
  memória após a primeira leitura.
- IV aleatório de 12 bytes a cada chamada de `encryptToken` — dois tokens iguais nunca produzem o
  mesmo ciphertext.
- GCM autentica: um ciphertext adulterado falha na verificação da `authTag` em `decryptToken`, em
  vez de decifrar em lixo silencioso.
- `validarChaveCifragem()` é chamada no boot do servidor para o erro de chave ausente/inválida
  aparecer no start, não no meio de um OAuth real.

---

## `src/lib/mercadopago/oauth.ts` — Authorization Code + PKCE

Fluxo OAuth do MP para vincular a conta da instituição. Roda sempre com a credencial da
**plataforma** (`MERCADO_PAGO_ACCESS_TOKEN`/`MERCADO_PAGO_APP_ID`/`MERCADO_PAGO_CLIENT_SECRET`) —
é a plataforma que troca `code` por token e faz refresh, nunca a instituição.

```ts
gerarParPkce()                          // code_verifier (random) + code_challenge (SHA-256, S256)
buildAuthorizationUrl(state, challenge) // monta a URL de autorização
exchangeCode(code, codeVerifier)        // troca o authorization_code por tokens
refreshAccessToken(refreshToken)        // renova o access_token
```

PKCE não está tipado no SDK (`AuthorizationRequest`/`OAuthRequest` só declaram os campos básicos),
mas o SDK repassa o objeto inteiro para a query string/corpo — por isso os parâmetros extras
(`code_challenge`, `code_challenge_method`, `code_verifier`) trafegam como
`Record<string, string>` sem reimplementar o endpoint manualmente.

`normalizarResposta()` valida que `access_token`, `refresh_token` e `expires_in` vieram presentes
antes de devolver — o SDK tipa a resposta como totalmente opcional, e persistir uma conta pela
metade só quebraria no primeiro checkout.

Prazos: `expiresAt` vem do `expires_in` real da resposta; `refreshExpiresAt` é fixo em ~180 dias
(`VALIDADE_REFRESH_MS`), porque o Mercado Pago documenta 6 meses de validade para o `refresh_token`
mas não devolve esse valor na resposta.

---

## `src/lib/mercadopago/signature.ts` — assinatura do webhook

Header `x-signature: ts=<unix>,v1=<hmac>`. O HMAC em si é conferido pelo
`WebhookSignatureValidator` do próprio SDK oficial (comparação em tempo constante, trata header
ausente/malformado). Duas correções aplicadas por cima do SDK:

1. **Normalização do `data.id`**: o MP documenta que, se vier alfanumérico maiúsculo, deve ser
   comparado em minúsculo — o validador do SDK não faz essa normalização sozinho.
2. **Janela anti-replay implementada fora do SDK**: o `toleranceSeconds` do
   `WebhookSignatureValidator` lê o `ts` como **milissegundos**
   (`Math.abs(Date.now() - ts)`), mas o Mercado Pago envia o `ts` em **segundos** — usar a opção
   nativa rejeitaria toda notificação legítima. `tsEmSegundos()` aceita as duas unidades (detecta
   por magnitude, limiar em `1e12`) e a comparação de janela (300s) é feita manualmente em
   `validateWebhookSignature`.

Importante: o manifest do `x-signature` **não inclui o corpo da requisição** — por isso o
`express.json()` global de `src/server.ts` é suficiente, sem precisar de um `express.raw()`
paralelo para esta rota.

---

## `src/lib/mercadopago/token.ts` — resolução do access_token

`getAccessTokenInstituicao(instituicaoId)` é o ponto único usado por `checkout.ts` e
`webhooks.ts` para obter um token válido. Centralizado porque os dois precisavam do mesmo
comportamento (decifrar + renovar) e essa lógica não pode ficar duplicada.

Regras:
- Sem conta ou sem `accessTokenEnc` → `ContaMercadoPagoIndisponivel('nao_conectada')`.
- `status === 'REVOKED'` → `ContaMercadoPagoIndisponivel('revogada')`.
- `expiresAt` a menos de 10 min (`MARGEM_RENOVACAO_MS`) → renova via `refreshAccessToken` antes de
  devolver, e persiste os novos tokens cifrados com `status: 'ACTIVE'`.
- Falha no refresh → marca `status: 'EXPIRED'` + `ultimoErro`, lança
  `ContaMercadoPagoIndisponivel('expirada')`.

`ContaMercadoPagoIndisponivel` é capturada nas rotas para responder `409` com o motivo, em vez de
estourar como erro genérico 500.

---

## `src/helpers/split.helper.ts` — regra de comissão

```ts
resolveRegraSplit(instituicao, plano): RegraSplit
calcularSplit(valor, regra): number
validarOverridesSplit(dados): string[]
```

`resolveRegraSplit` resolve percentual/mínimo/máximo campo a campo: override da instituição vence
se **não for `null`**; senão herda do plano. A distinção entre "instituição definiu explicitamente
`0`" (taxa zero negociada) e "instituição não definiu nada" (`null`, herda) é a parte mais fácil de
errar aqui — cada campo carrega `Number()` explícito sobre o `Decimal` do Prisma, e `0` é tratado
como valor válido, não como ausência. A função também devolve `origem` (`'plano' | 'instituicao'`)
por campo, consumido pela tela para mostrar o que é herdado.

`calcularSplit`:

```
fee = valor * (percentual / 100)
fee = max(fee, minimo)
fee = min(fee, maximo ?? Infinity)
fee = min(fee, valor)     // nunca pode exceder o valor da cobrança
return round(fee, 2)
```

Os campos do `Plano` mantêm o nome `feeEvento*` (não `split*`) porque as colunas já existiam no
banco com dados de uma tentativa anterior — renomear seria DDL sem ganho funcional.

`validarOverridesSplit` valida `0 ≤ percentual ≤ 100`, `minimo ≥ 0`, `maximo ≥ minimo`. Usado tanto
no CRUD de planos (`planos.ts`) quanto na gravação de overrides por instituição.

## `src/helpers/plano.helper.ts` — plano e gating de features

`getPlanoDaInstituicao` faz fallback para o plano padrão (`PLANO_PADRAO_CODIGO`, hoje
`PILOTO_FREE`) quando a instituição não tem `planoId` atribuído — evita que o checkout quebre por
falta de regra de split. `temFeature` responde `true` para tudo quando `features.acessoTotal ===
true` no plano (é o caso do plano gratuito atual); a estrutura existe para que, quando houver plano
pago de fato, o bloqueio seja mudança de **dado**, não de código.

---

## Endpoints

### `/mercadopago` (`src/routes/mercadopago.ts`)

| Rota | Auth | Descrição |
|---|---|---|
| `GET /mercadopago/oauth/connect` | Bearer + `requireBackoffice` | Gera PKCE + `nonce`, grava `OAuthNonce` (TTL 10 min), devolve `{ authorizationUrl, expiraEm }`. Faz limpeza oportunista de nonces vencidos a cada chamada. |
| `GET /mercadopago/oauth/callback` | **pública** | O MP redireciona o browser aqui. Valida `state` (não consumido, não expirado) → marca consumido **antes** de trocar o código (se o MP falhar, o nonce não pode ser reusado) → `exchangeCode` → cifra e faz `upsert` em `MercadoPagoAccount` com `status: ACTIVE` → `302` para `${FRONTEND_URL}/configuracoes/pagamentos?status=ok\|erro&motivo=...`. Nunca retorna token no body nem na URL. |
| `GET /mercadopago/status` | Bearer | Estado **local** (não chama o MP). Barato, mas pode estar desatualizado se a instituição revogou o acesso pelo painel do MP sem o webhook `mp-connect` ter sido processado. |
| `GET /mercadopago/verificar` | Bearer | Prova de vida: chama `GET /users/me` de verdade com o token da instituição (renovando se necessário). Sempre `200`, com `conectado: true\|false` e, quando aplicável, `contaDivergente`. Um `401`/`403` do MP marca a conta local como `REVOKED` na hora — senão o banco continuaria dizendo `ACTIVE` indefinidamente. |
| `DELETE /mercadopago/conta` | Bearer + `requireBackoffice` | Marca `REVOKED`, zera `accessTokenEnc`/`refreshTokenEnc`. |
| `GET /mercadopago/pagamentos` | Bearer | Lista paginada de `MpPagamento`, filtrável por `eventoId`/`status`/`participanteId`, escopada por `instituicaoId` do usuário. |
| `GET /mercadopago/pagamentos/:id` | Bearer | Detalhe de um `MpPagamento`, `404` se pertence a outra instituição. |

### `/planos` (`src/routes/planos.ts`)

| Rota | Auth | Descrição |
|---|---|---|
| `GET /planos` | backoffice | Lista todos os planos + contagem de instituições vinculadas. |
| `GET /planos/meu` | Bearer | Plano da instituição do usuário + `split` efetivo. |
| `GET /planos/disponiveis` | Bearer | Catálogo de planos ativos, com `atual`/`selecionavel`/`motivoIndisponivel` por plano. |
| `PUT /planos/meu` | backoffice | A instituição troca o próprio plano — **só se `selecionavel`** (plano ativo e `valorMensal === 0`). Plano pago responde `403`: depende de `preapproval`, que não existe nesta entrega. |
| `POST /planos`, `PUT /planos/:id` | backoffice | CRUD de plano, com `validarOverridesSplit` nos campos `feeEvento*`. |
| `PUT /planos/instituicoes/:id/plano` | backoffice | Atribui plano a uma instituição específica (uso administrativo). |
| `GET /planos/instituicoes/:id/split` | backoffice ou a própria instituição | Overrides + regra efetiva, com `origem` por campo. |
| `PUT /planos/instituicoes/:id/split` | backoffice | Grava overrides (`null` volta a herdar). Valida a **combinação final** (override novo + o que permanece do banco), não só o que veio no corpo — evitar que `maximo < minimo` passe por só mandar um dos dois campos. |

### `/checkout` (`src/routes/checkout.ts`)

`POST /checkout/preferences` — **pública**. Body: `{ participanteId, produtoId, recaptchaToken }`.

1. Valida reCAPTCHA (`verifyRecaptcha`) — rota pública, superfície de abuso externo.
2. Carrega `ParticipanteProdutos` + `produto` + `participante.evento`. Rejeita se
   `!produto.exigePagamento`.
3. Resolve `instituicaoId` a partir de `participanteProduto`/`participante`/`evento` (nessa ordem
   de fallback).
4. Idempotência: `MpPagamento APPROVED` existente → `409`; `PENDING`/`IN_PROCESS` com `initPoint` e
   ainda dentro de `expiraEm` → devolve o **mesmo** `init_point` em vez de criar preference nova.
5. `getAccessTokenInstituicao` — sem conta `ACTIVE`, responde `409` com o motivo
   (`ContaMercadoPagoIndisponivel`).
6. **O valor vem sempre de `produto.valor`**, nunca do body.
7. `resolveRegraSplit` + `calcularSplit` → se `splitValor >= valor`, loga um alerta (`preference.alerta`)
   porque o MP tende a falhar o processamento quando `marketplace_fee` consome o valor inteiro — a
   preference ainda é criada, o erro só aparece no pagamento.
8. Cria `MpPagamento` (`status: PENDING`) com `externalReference` (UUID) e `expiraEm` (validade de
   1h, `VALIDADE_PREFERENCE_MS`).
9. Monta o `PreferenceRequestMp` (tipado pelo SDK — campo inválido quebra em compilação, não em
   `400` do MP): `items`, `payer` (nome/sobrenome/email/telefone/CPF do participante),
   `external_reference`, `notification_url = ${API_URL}/webhooks/mercadopago?ref=<externalReference>`,
   `back_urls`, `auto_return: 'approved'` (só se `FRONTEND_URL` for `https://` — em `localhost` o
   MP rejeita a preference inteira), `statement_descriptor` (nome da instituição, até 22
   caracteres), `binary_mode: true`, `expires`/`expiration_date_to`. `marketplace_fee` só entra no
   payload se `splitValor > 0` — zero explícito é omitido, não enviado como `0`.
10. `chamarMp('POST /checkout/preferences', ...)` com `idempotencyKey: externalReference` — reenvio
    da mesma tentativa não cria uma segunda preference no MP.
11. Em falha na criação: marca o `MpPagamento` como `CANCELLED` (senão o registro ficaria
    bloqueando o caminho de reuso do passo 4 sem nunca ter um `init_point` válido).
12. Confere `collector_id` da preference contra o `mpUserId` gravado — divergência gera um log de
    alerta (`preference.alerta` / `collector_divergente`): sinal de que a preference nasceu numa
    conta MP diferente da conectada.
13. Persiste `mpPreferenceId`/`initPoint`, responde `{ init_point, mpPagamentoId, valor, splitValor }`.

Este endpoint só **lê** `ParticipanteProdutos`/`ProdutosEvento` para obter o valor — não escreve
nada neles.

### `/webhooks` (`src/routes/webhooks.ts`)

`POST /webhooks/mercadopago` — pública, autenticada por assinatura HMAC (não por sessão de
usuário).

1. Extrai `data.id` do corpo ou da query (formato varia por tipo de notificação).
2. `validateWebhookSignature` — inválida → `401`, **não processa nada**.
3. `upsert` em `MpWebhookLog` pela chave única `(mpEventId, tipo, action)`. Já `processado` →
   responde `200` de imediato (dedup de reentrega).
4. Só `type === 'payment'` é processado; outros tópicos são marcados processados e ignorados.
5. Descobre o `MpPagamento`: se a query trouxer `?ref=<externalReference>` (que nós mesmos
   embutimos na `notification_url` ao criar a preference), busca por ele; senão, cai para
   `mpPaymentId`. **A notificação do MP carrega só `data.id`, não `external_reference`** — sem o
   `ref` embutido não haveria como descobrir a instituição (e, portanto, o token) a partir da
   notificação sozinha.
6. `GET /v1/payments/{id}` com o **token da instituição** — nunca confia no status vindo do
   payload da notificação, que pode ser forjado ou desatualizado.
7. Confere que o `external_reference` devolvido pelo MP bate com o do registro local antes de
   aplicar qualquer mudança — o `ref` da query trafegou por uma URL pública; um valor trocado não
   pode atualizar o pagamento errado.
8. Mapeia status do MP → `MpPagamentoStatus` (`MAPA_STATUS`). Sem `status` no payment, não
   atualiza nada (evitaria assumir `PENDING` e rebaixar um pagamento já aprovado).
9. **Transição só avança**: uma reentrega fora de ordem não pode rebaixar um status terminal
   (`APPROVED`, `REFUNDED`, `CHARGED_BACK`) de volta para `PENDING`/`IN_PROCESS`.
10. Atualiza `MpPagamento` (`mpPaymentId`, `statusDetail`, `metodoPagamento`, `parcelasCartao`,
    `aprovadoEm`) e marca o log como `processado`.
11. Erro em qualquer etapa após o registro do log → grava `erro` no `MpWebhookLog`, incrementa
    `tentativas`, responde `500` — o Mercado Pago reenvia a notificação nesse caso.

Escreve exclusivamente em `mp_pagamentos` e `mp_webhook_logs`. Não cria `Parcela`, não altera
`ParticipanteProdutos`, não toca `data_pagamento`.

### `/jobs` (`src/routes/jobs.ts`)

`POST /jobs/refresh-mp-tokens` — protegido por `Authorization: Bearer ${CRON_SECRET}`. Busca
contas `ACTIVE` com `expiresAt` a menos de 48h (`JANELA_RENOVACAO_MS`), renova cada uma via
`refreshAccessToken`; falha marca `status: EXPIRED` + `ultimoErro`. Aproveita a execução para
limpar `OAuthNonce` vencidos. Responde `{ avaliadas, renovadas, falhas, noncesRemovidos }`.

> ⚠️ `vercel.json` atual **não tem** entrada `crons` apontando para esta rota — o job existe e
> funciona sob chamada manual/externa, mas ainda não está agendado automaticamente no deploy.

---

## Observabilidade (`src/lib/mercadopago/log.ts`)

Log estruturado, uma linha JSON por evento, prefixo `[MP]`/`[MP:ERRO]`. Ligado por padrão fora de
produção; em produção exige `MP_DEBUG=1` (erros sempre saem, independente da flag).

`impressaoToken(token)` nunca loga o valor do token — devolve `PREFIXO:hash10:lenN` (prefixo
`TEST-`/`APP_USR-` identifica o ambiente da credencial, hash SHA-256 truncado permite comparar "é o
mesmo token?" entre dois logs sem revelar o segredo). Usado para detectar, por exemplo, se a
preference foi assinada com um token diferente do esperado, ou se a credencial da plataforma e a
da instituição estão em ambientes diferentes (teste vs. produção).

`mascarar(valor)` faz o mesmo para e-mail/CPF do participante nos logs de payload da preference.

Eventos emitidos cobrem o ciclo inteiro: `oauth.exchange`, `oauth.refresh`, `token.resolve`,
`token.renovado`, `token.falha`, `preference.inicio` → `preference.split` → `preference.payload` →
`preference.ok`/`preference.erro`/`preference.alerta`, `webhook.recebido` → `webhook.vinculo` →
`webhook.payment` → `webhook.aplicado`, `mp.chamada`/`mp.erro` (toda chamada ao SDK).

---

## Segurança — resumo

- **Tokens de terceiro em repouso**: AES-256-GCM, IV aleatório por token, autenticado (GCM). Nunca
  logados, nunca devolvidos em nenhuma resposta de API.
- **Webhook**: HMAC-SHA256 do manifest `id:...;request-id:...;ts:...;` contra
  `MERCADO_PAGO_WEBHOOK_SECRET`, com janela anti-replay de 300s. Corpo confiável só depois de
  buscar o pagamento de volta na API do MP (nunca confia no payload da notificação).
- **OAuth**: PKCE (S256) + `state` de uso único com TTL de 10 min, casando com a validade do
  `authorization_code` do MP. Nonce é consumido **antes** da troca do código, para não ser
  reaproveitável em caso de falha.
- **Checkout público**: reCAPTCHA obrigatório, valor sempre lido do banco (nunca do body),
  idempotência por `external_reference` tanto localmente quanto na chamada ao MP
  (`idempotencyKey`).
- **Multi-tenant**: toda leitura de `MpPagamento`/`MercadoPagoAccount` é escopada por
  `instituicaoId` do usuário autenticado; `/mercadopago/pagamentos/:id` responde `404` (não `403`)
  para registro de outra instituição.

---

## O que não está implementado

- **Cobrança recorrente do SaaS** (`preapproval`) — travada deliberadamente: plano pago responde
  `403` em `PUT /planos/meu` porque não há fluxo de cobrança por trás. `Assinatura` está modelada
  no schema mas não é usada em nenhuma rota.
- **Agendamento automático do cron** de refresh de token — `vercel.json` não tem `crons`
  configurado; a rota existe e funciona, mas depende de disparo externo.
- **Tela de listagem de pagamentos MP** no front — a API (`GET /mercadopago/pagamentos`) e o hook
  do front já existem; falta a tela.
- **Edição de split pelo backoffice** no front — API pronta (`PUT /planos/instituicoes/:id/split`),
  tela é entrega separada.
- **Reconciliação** entre `Parcela` (lançamento manual) e `MpPagamento` (pagamento online) — as
  duas visões coexistem sem se falar; um participante pode aparecer `PENDENTE` na tela financeira
  atual mesmo tendo pago online. Fora de escopo por decisão explícita.
