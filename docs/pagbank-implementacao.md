# Integração PagBank

Substitui por completo a antiga integração Mercado Pago (removida em
2026-08-28, migration `20260828000000_pagbank`). Cobre dois produtos
PagBank **separados**:

1. **Connect + Orders (split de pagamento)** — inscrições de evento pagas
   online, com taxa da plataforma descontada por transação.
2. **Assinaturas** — mensalidade da instituição com a PLATAFORMA (conta
   única, sem OAuth por instituição).

## Por que a tela de pagamento é nossa, não um redirect

O checkout hospedado do PagBank (`POST /checkouts`) **não aceita** o campo
`splits`. Split só existe em `POST /orders` + `/orders/{id}/pay`. Como o
split é requisito do produto, a inscrição paga não pode usar o checkout
hospedado — por isso `routes/checkout.ts` cria o pedido diretamente
(Pix/boleto/cartão) e o frontend (`/inscricao/pagamento`) exibe QR Code,
link de boleto ou o resultado do cartão, sem sair do site.

## Arquitetura

```
src/lib/pagbank/
  client.ts       cliente HTTP fino (fetch), sem SDK oficial — PagBank não publica um
  crypto.ts        AES-256-GCM dos tokens OAuth em repouso
  log.ts           log estruturado, nunca loga token/PAN em claro
  oauth.ts         Connect: authorize URL, exchangeCode, refresh
  signature.ts     valida x-authenticity-token dos webhooks de Orders
  token.ts         resolve/renova o access_token da instituição
  orders.ts        POST /orders (Pix/boleto/cartão) com splits
  assinaturas.ts   API de Assinaturas (mensalidade da plataforma)

src/routes/
  pagbank.ts       OAuth connect/callback/status/verificar, desvincular, listar pagamentos
  checkout.ts      cria o pedido (rota pública) + chave pública p/ cartão
  webhooks.ts      /pagbank (Orders) e /pagbank-assinaturas
  jobs.ts          renovação de tokens (cron)
  assinaturas.ts   backoffice: assinar/cancelar mensalidade, chave pública
```

## Variáveis de ambiente

Ver `.env.example`. Nenhuma credencial de sandbox/produção foi configurada
na implementação inicial (aplicação PagBank Connect ainda não criada) — os
campos ficam vazios até a aprovação.

- `PAGBANK_ENV` — `sandbox` | `production`
- `PAGBANK_APP_ID`, `PAGBANK_CLIENT_SECRET`, `PAGBANK_REDIRECT_URI` — app Connect
- `PAGBANK_ACCESS_TOKEN` — token da conta DA PLATAFORMA (Connect + Assinaturas)
- `PAGBANK_PLATAFORMA_ACCOUNT_ID` — `ACCO_xxxx` da plataforma, receiver do split
- `PAGBANK_TOKEN_ENCRYPTION_KEY` — AES-256-GCM dos tokens das instituições

## Verificado contra a sandbox (2026-08-29)

Testado com `PAGBANK_ACCESS_TOKEN` real contra `sandbox.api.pagseguro.com`:

| Item | Resultado |
|---|---|
| `POST /orders` com payload de `orders.ts` (Pix) | **201** — shape correto |
| Leitura do QR Code (`charges[0].qr_code.text` + link `QRCODE.BASE64`) | **confere** — ambos existem na resposta |
| Split em `charges[].splits.receivers[].account.id` | **shape validado** — API rejeitou só o ACCO_ falso, apontando `parameter_name: charges[0].receivers.account.id` |
| Status inicial do charge (`WAITING`) | **confere** com o enum `PagBankPagamentoStatus` |
| `/public-keys` no host de Orders | **POST** (PUT → 403) — corrigido, era PUT |
| `/public-keys` no host de Assinaturas | **PUT** (POST → 405) — já estava certo |

O caminho `/public-keys` usa **verbos opostos nos dois hosts**. Não é
inconsistência do código; está comentado nos dois arquivos para ninguém
"padronizar" e quebrar.

## Aplicação Connect (sandbox) — criada em 2026-08-29

Não há tela no painel para isso; cria-se via API, uma vez:

```
POST https://sandbox.api.pagseguro.com/oauth2/application
Authorization: Bearer $PAGBANK_ACCESS_TOKEN
{ "name": "...", "site": "...", "redirect_uri": ".../pagbank/oauth/callback" }
```

A resposta preencheu `PAGBANK_APP_ID` (client_id), `PAGBANK_CLIENT_SECRET`
(client_secret) e `PAGBANK_PLATAFORMA_ACCOUNT_ID` (account_id — o `ACCO_` que
recebe a taxa no split).

Verificado logo após criar: a URL de autorização montada por
`buildAuthorizationUrl` devolve **302** para `acesso.pagbank.com.br` com
`connectClientId` igual ao nosso — ou seja, client_id, redirect_uri e formato
dos escopos estão aceitos pelo PagBank.

> **`redirect_uri` é imutável.** Existe `POST /oauth2/application` (criar) e
> `GET /oauth2/application/{client_id}` (consultar), mas **nenhum endpoint de
> edição**. Hoje ele aponta para um quick tunnel do Cloudflare, cuja URL é
> aleatória e morre ao reiniciar — quando isso acontecer, será preciso criar
> uma aplicação NOVA e trocar as três variáveis. Para estabilizar: túnel
> nomeado do Cloudflare com domínio próprio, ou o domínio da API em produção.

## Conexão OAuth ponta a ponta — funcionando (2026-08-29)

Uma instituição sandbox autorizou de verdade e a conta gravou em
`pagbank_accounts` com `status: ACTIVE`, os quatro escopos concedidos e os dois
tokens cifrados. Isso resolveu duas incógnitas de uma vez:

1. **Headers do token exchange — RESOLVIDO.** `X_CLIENT_ID`/`X_CLIENT_SECRET`
   estão corretos: a troca de um `code` real por token passou. (O teste com
   `code` inválido tinha sido inconclusivo, porque a API valida o `code` antes
   das credenciais e devolvia o mesmo erro com e sem os headers.)
2. **`expires_in` — RESOLVIDO.** O PagBank devolve **1 ano** de validade, não
   a ordem de grandeza de 1h que o piso do `oauth.ts` assumia. O piso continua
   no código como defesa para resposta malformada, mas nunca é usado na
   prática. O cron de refresh (janela de 48h) praticamente nunca vai disparar.

### Papel de cada URL (erra fácil)

| Variável | Valor em dev | Por quê |
|---|---|---|
| `API_URL` | túnel público | monta `notification_urls`; o webhook é server-to-server e **precisa** ser alcançável de fora |
| `PAGBANK_REDIRECT_URI` | túnel público + `/pagbank/oauth/callback` | o PagBank manda o browser para cá; tem de bater com o registrado na aplicação |
| `FRONTEND_URL` | `http://localhost:3001` | só o browser do usuário vai para cá depois do callback — **não** precisa ser público |

Apontar `FRONTEND_URL` para o túnel faz o callback redirecionar para a porta da
API (3000) em vez da do Next (3001), e o usuário cai num
`Cannot GET /configuracoes/pagamentos` do Express — com `?status=ok` na URL,
porque o OAuth em si funcionou.

## Ponto ainda NÃO verificado

**Assinatura do webhook de Orders** (`signature.ts`): a doc do
`x-authenticity-token` fala em "token obtido via iBanking" (modelo de conta
única). Para o modelo Connect (várias instituições), assumido como o
`access_token` OAuth da instituição dona do pedido. Se vier sempre inválida,
tentar `PAGBANK_ACCESS_TOKEN` (token da plataforma) no lugar. Fecha no primeiro
pagamento de teste que gerar notificação real.

## Taxas: o que sabemos e o que não

Duas taxas incidem numa inscrição paga, e só uma é nossa:

| | Origem | Conhecemos? |
|---|---|---|
| Split da plataforma | regra do plano/instituição | sim, calculamos |
| Taxa do PagBank | contrato comercial da conta | **não**, ver abaixo |

`GET /charges/fees/calculate` simula a taxa do PagBank ANTES da transação
(usado pela calculadora de preço em `routes/pagbank.ts`). Duas limitações
verificadas contra a sandbox em 2026-08-29:

1. **Em sandbox os valores são fictícios.** `fees.seller.total` volta 0 nos 23
   emissores, com qualquer token e qualquer valor; passar `account_id` devolve
   504. A documentação confirma que sandbox devolve planos e taxas genéricos.
   Por isso a resposta da API traz `taxaPagBankDisponivel`, para a tela
   distinguir "taxa zero" de "taxa desconhecida" em vez de prometer um líquido
   otimista.
2. **A taxa NÃO varia por bandeira.** A resposta é organizada por emissor, mas
   os valores são idênticos em todos — o que muda por bandeira é até quantas
   parcelas cada uma aceita (discover e jcb só à vista, valecard até 3x).

**Transação concluída não traz a taxa.** O charge pago não tem campo `fees`
(verificado), e a notificação de cartão também não. Para auditar o que foi
efetivamente descontado, o caminho oficial do PagBank é a **API EDI** de
extratos eletrônicos — ainda não integrada. Enquanto isso, as telas dizem
"após nossa taxa", não "líquido", para não superestimar o que cai na conta.

**Juros de parcelamento:** decisão de produto é que a instituição absorve
(o participante paga o mesmo em 1x ou 12x). Por isso a calculadora mostra o
líquido POR número de parcelas, não um número único — em produção eles
divergem. Se um dia o repasse for para o comprador, existe o modo
"criar pedido com repasse de taxa" na API.

## Requisitos de conta

- **Plataforma: PJ obrigatório.** A API de Pagamentos Recorrentes (mensalidade)
  é explícita: *"A integração via API é exclusiva para cadastros Pessoa
  Jurídica (PJ) aprovados no onboarding"*. Sem CNPJ não há cobrança de
  mensalidade por API.
- **Instituição: PJ não documentado como obrigatório** para ser recebedora de
  split — o requisito encontrado é ter conta PagBank do tipo vendedor/
  empresarial. A doc do Connect e a do split não tratam de CPF vs CNPJ;
  confirmar com o comercial do PagBank junto da habilitação do split.
- `Instituicao.cnpj` é opcional no schema, mas `routes/assinaturas.ts` exige
  14 dígitos antes de criar assinatura — sem isso mandaríamos `tax_id` vazio e
  o PagBank recusaria com erro genérico.

## Split

`helpers/split.helper.ts` é o mesmo usado pela integração anterior — a regra
(percentual/mínimo/máximo, plano vs. override da instituição) não mudou,
só o formato de saída (`splits.receivers[]` em centavos, dois receivers:
instituição e plataforma) é específico do PagBank.

## Banco

Tabelas antigas (`mercado_pago_accounts`, `mp_pagamentos`, `mp_webhook_logs`)
foram **descartadas** (não migradas) — decisão do produto, histórico de 28
pagamentos de teste perdido deliberadamente. `oauth_nonces` foi reaproveitada
(já era genérica). `assinaturas`/`planos` foram adaptadas in-place (campos
`mpPreapproval*` → `pagbank*`).
