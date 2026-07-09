# SPEC-BE-006 — Reconciliação e resiliência

| | |
|---|---|
| **Repo** | `saaschurch-api` |
| **Fase** | F6 |
| **Depende de** | [SPEC-BE-002](./SPEC-BE-002-oauth.md), [SPEC-BE-003](./SPEC-BE-003-pagamento-split.md), [SPEC-BE-004](./SPEC-BE-004-assinatura-saas.md), [SPEC-BE-005](./SPEC-BE-005-webhook.md) |

---

## Contexto

Webhook do Mercado Pago falha. Rede cai, o MP fica fora do ar, o deploy está no meio de um cold start. Sem reconciliação, um pagamento aprovado fica `PENDING` para sempre e o participante não recebe a inscrição.

**O job de reconciliação é obrigatório, não nice-to-have.**

Deploy é Vercel (`vercel.json`) — não há worker de longa duração. `src/jobs/` existe mas está vazio. Jobs são **Vercel Cron** apontando para rotas HTTP protegidas por `CRON_SECRET`.

## Requisitos funcionais

| ID | Requisito |
|---|---|
| RF-01 | Renovar tokens OAuth perto do vencimento. |
| RF-02 | Reconciliar `Pagamento` pendente antigo contra a API do MP. |
| RF-03 | Verificar assinaturas vencidas com status divergente. |
| RF-04 | Rotas de job autenticadas por `CRON_SECRET`, nunca por sessão de usuário. |
| RF-05 | Erro em um item não aborta o lote. |

## Jobs

| Job | Frequência | O que faz |
|---|---|---|
| `refresh-tokens` | diário 03:00 | Renova `MercadoPagoAccount` com `expiresAt < now + 7d`. Falha → `status = EXPIRED` + `ultimoErro`. |
| `reconciliar-pagamentos` | a cada 30 min | Varre `Pagamento` com `status ∈ {PENDING, IN_PROCESS}` e `createdAt < now - 30min`; consulta status real na API do MP com o token **da igreja**. |
| `verificar-assinaturas` | diário 04:00 | `Assinatura` com `proximaCobranca < now` e `status == AUTHORIZED` → reconsulta o MP e aplica bloqueio se divergente. **Ignora instituições com `plano.cobrancaSaaS == false`.** |

O índice `@@index([status, createdAt])` de `Pagamento` existe exatamente para suportar a varredura do reconciliador.

## Configuração

`vercel.json`:

```json
{
  "crons": [
    { "path": "/jobs/refresh-tokens",         "schedule": "0 3 * * *" },
    { "path": "/jobs/reconciliar-pagamentos", "schedule": "*/30 * * * *" },
    { "path": "/jobs/verificar-assinaturas",  "schedule": "0 4 * * *" }
  ]
}
```

A Vercel injeta `Authorization: Bearer $CRON_SECRET` nas chamadas de cron. As rotas validam esse header e **não** passam por `authenticateUser`.

> **Vercel Cron no plano Hobby dispara no máximo 1×/dia** e tem timeout curto. O reconciliador de 30 min exige plano Pro ou um agendador externo (GitHub Actions, cron-job.org batendo na rota com o `CRON_SECRET`). Verificar antes de começar esta spec.

## Contrato

```http
POST /jobs/refresh-tokens
Authorization: Bearer <CRON_SECRET>
200 { "processados": 12, "renovados": 3, "expirados": 1, "erros": 0 }
401

POST /jobs/reconciliar-pagamentos
Authorization: Bearer <CRON_SECRET>
200 { "processados": 8, "atualizados": 5, "erros": 1 }

POST /jobs/verificar-assinaturas
Authorization: Bearer <CRON_SECRET>
200 { "processados": 4, "bloqueados": 1, "ignoradosPlanoGratuito": 27 }
```

## Observabilidade

Logs estruturados (JSON, uma linha por evento) com no mínimo: `job`, `instituicaoId`, `pagamentoId`, `mpPaymentId`, `statusAnterior`, `statusNovo`, `duracaoMs`.

Métricas a expor ou logar: taxa de aprovação, tempo médio entre criação e confirmação, contagem de reconciliações que corrigiram um status (mede a taxa de falha real do webhook).

## Critérios de aceite

```gherkin
Cenário: Pagamento pendente antigo é reconciliado
  Dado um Pagamento PENDING criado há 45 minutos
  E o MP reporta status approved
  Quando o job reconciliar-pagamentos roda
  Então Pagamento.status = APPROVED
  E a Parcela vinculada é atualizada com valor_pago e data_pagamento

Cenário: Pagamento recente não é tocado
  Dado um Pagamento PENDING criado há 5 minutos
  Quando o job roda
  Então ele não é consultado no MP

Cenário: Job é idempotente
  Quando o job roda duas vezes seguidas
  Então nenhuma Parcela é atualizada duas vezes
  E o valor_pago não é somado em dobro

Cenário: Job não derruba tudo por causa de um erro
  Dado 10 pagamentos pendentes e o 3º falha ao consultar o MP
  Então os outros 9 são processados
  E o erro do 3º é logado
  E a resposta reporta erros = 1

Cenário: Reconciliação usa o token da igreja
  Quando um Pagamento é reconciliado
  Então GET /v1/payments/{id} usa o accessToken da igreja daquele pagamento

Cenário: Conta EXPIRED não trava a reconciliação
  Dado um Pagamento pendente de uma igreja com MercadoPagoAccount EXPIRED
  Então o item é pulado com log de aviso
  E os demais são processados

Cenário: Verificação de assinatura ignora plano gratuito
  Dado 27 instituições em plano com cobrancaSaaS = false
  Quando o job verificar-assinaturas roda
  Então nenhuma delas é consultada no MP
  E ignoradosPlanoGratuito = 27

Cenário: Rota de job sem CRON_SECRET é rejeitada
  Dado uma requisição sem o header Authorization correto
  Então retorna 401
  E nenhum processamento ocorre

Cenário: Refresh renova só o que está perto de vencer
  Dado uma conta com expiresAt daqui a 30 dias
  Então ela não é renovada
```

## Definição de pronto

- [ ] `src/jobs/refresh-tokens.ts`, `src/jobs/reconciliar-pagamentos.ts`, `src/jobs/verificar-assinaturas.ts`
- [ ] `src/routes/jobs.ts` com validação de `CRON_SECRET`, registrada em `src/server.ts`
- [ ] `vercel.json` com a seção `crons`
- [ ] Cada job processa itens em lote com `try/catch` por item — um erro nunca aborta o lote
- [ ] Logs estruturados em JSON com `instituicaoId`, `pagamentoId`, `mpPaymentId`
- [ ] Idempotência verificada por teste (rodar duas vezes, comparar estado)
- [ ] Limitação de plano Vercel para o cron de 30 min verificada e decidida
