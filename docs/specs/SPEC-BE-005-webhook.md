# SPEC-BE-005 — Webhook único do Mercado Pago

| | |
|---|---|
| **Repo** | `saaschurch-api` |
| **Fase** | F2 |
| **Depende de** | — |
| **Habilita** | [SPEC-BE-003](./SPEC-BE-003-pagamento-split.md), [SPEC-BE-004](./SPEC-BE-004-assinatura-saas.md), [SPEC-BE-006](./SPEC-BE-006-reconciliacao.md) |

---

## Contexto

Endpoint único de notificações do MP, sem autenticação de usuário, protegido por HMAC. **É a superfície mais exposta do sistema.**

Roteia por `type`: `payment` → `pagamento.service`; `subscription_preapproval` → `billing.service`.

## Requisitos funcionais

| ID | Requisito |
|---|---|
| RF-01 | Validar `x-signature` (HMAC-SHA256) antes de qualquer efeito colateral. |
| RF-02 | Rejeitar `ts` fora de uma janela de 5 min (anti-replay). |
| RF-03 | Idempotência por `(mpEventId, tipo, action)`. |
| RF-04 | Buscar o recurso real na API do MP — nunca decidir pelo payload. |
| RF-05 | Rotear para o handler correto. |
| RF-06 | Responder `500` em falha de processamento, para forçar retry do MP. |

## Modelagem

```prisma
model WebhookLog {
  id            String   @id @default(uuid())
  mpEventId     String            // data.id do MP
  tipo          String            // payment | subscription_preapproval
  action        String?           // payment.created | payment.updated
  payload       Json
  processado    Boolean  @default(false)
  erro          String?
  tentativas    Int      @default(0)
  processadoEm  DateTime?
  createdAt     DateTime @default(now())

  @@unique([mpEventId, tipo, action])
  @@index([processado])
  @@map("webhook_logs")
}
```

> O planejamento v1 usava `mpEventId @unique`. Isso é **insuficiente**: o MP envia o mesmo `data.id` para `payment.created` e `payment.updated`. Com `@unique` no `mpEventId`, o `updated` — o evento que realmente confirma a aprovação — seria descartado como duplicata. A chave de idempotência correta é a tripla `(mpEventId, tipo, action)`.

## Validação de assinatura

O MP envia:

```
x-signature: ts=1704908010,v1=618c85345248dd820d5fd456117c2ab2ef8eda45a0282ff693eac24131a5e839
x-request-id: <uuid>
```

Manifesto a assinar (ordem e pontuação exatas; campos ausentes são omitidos junto do separador):

```
id:<data.id>;request-id:<x-request-id>;ts:<ts>;
```

Compare `HMAC_SHA256(manifest, MERCADO_PAGO_WEBHOOK_SECRET)` com `v1` usando **`crypto.timingSafeEqual`**, nunca `===`. Rejeite `ts` com desvio maior que 5 minutos.

> `data.id` deve ser lido do **query param** `data.id` da URL, não do body, e em minúsculas quando alfanumérico. Essa é a pegadinha mais comum da validação de assinatura do MP.

## Fluxo

1. Validar `x-signature` + `x-request-id`. Inválido → `401`, sem processar, sem gravar `WebhookLog`.
2. `upsert` em `WebhookLog` pela tripla `(mpEventId, tipo, action)`. Já existe com `processado = true` → `200 OK` e retorna.
3. Buscar o recurso real: `GET /v1/payments/{id}` ou `GET /preapproval/{id}`. O payload do webhook só carrega o `id` — **nunca** use seu conteúdo para decisão de negócio.
4. Rotear para o handler.
5. `processado = true`, `processadoEm = now()`.
6. Erro no processamento → gravar `erro`, incrementar `tentativas`, responder **`500`**. O MP re-tenta com backoff por até 8h. Responder `200` em falha faz o evento ser perdido para sempre.

> Para `type: payment` de uma igreja, o `GET /v1/payments/{id}` precisa usar o `accessToken` **da igreja**, não o da plataforma. Descubra a igreja pelo `external_reference` que [SPEC-BE-003](./SPEC-BE-003-pagamento-split.md) enviou na criação do pagamento.

## Registro no `server.ts`

A rota de webhook **não** passa por `authenticateUser`. Registrá-la antes de qualquer middleware global de auth.

Requer `express.raw()` ou acesso ao body cru se a validação de assinatura precisar do payload literal — no caso do MP, o manifesto usa apenas headers e query param, então `express.json()` basta.

## Contrato

```http
POST /webhooks/mercadopago?data.id=123&type=payment
Headers:
  x-signature: ts=1704908010,v1=618c85...
  x-request-id: <uuid>

200 OK        # processado, ou já processado (idempotente)
401           # assinatura inválida / ts fora da janela
500           # erro de processamento → MP re-tenta
```

## Critérios de aceite

```gherkin
Cenário: Assinatura inválida é rejeitada sem efeito colateral
  Dado um webhook com v1 incorreto
  Então retorna 401
  E nenhum WebhookLog é criado
  E nenhum Pagamento é alterado

Cenário: Comparação de assinatura é timing-safe
  Então a comparação usa crypto.timingSafeEqual, nunca ===

Cenário: Timestamp antigo é rejeitado (anti-replay)
  Dado um webhook com ts de 10 minutos atrás
  Então retorna 401

Cenário: data.id vem do query param
  Dado um webhook cujo body traz data.id diferente do query param
  Então o manifesto é montado com o valor do query param

Cenário: Idempotência distingue created de updated
  Dado um webhook (data.id=1, type=payment, action=payment.created) já processado
  Quando chega (data.id=1, type=payment, action=payment.updated)
  Então ele É processado (não é duplicata)
  Quando chega novamente (data.id=1, type=payment, action=payment.updated)
  Então retorna 200 sem reprocessar

Cenário: Status vem da API, nunca do payload
  Quando um webhook payment é processado
  Então o serviço chama GET /v1/payments/{id} com o token da igreja
  E o status gravado vem dessa resposta, não do corpo do webhook

Cenário: Payload forjado com status approved não aprova nada
  Dado um webhook com assinatura válida mas payload dizendo status approved
  E o MP reportando status rejected no GET
  Então Pagamento.status = REJECTED

Cenário: Falha de processamento devolve 500
  Dado que o banco está indisponível durante o processamento
  Então retorna 500
  E WebhookLog.tentativas é incrementado
  E processado permanece false

Cenário: Tipo desconhecido não quebra
  Dado um webhook com type "merchant_order"
  Então retorna 200
  E o evento é logado como não roteado
```

## Definição de pronto

- [ ] Migration `WebhookLog` com `@@unique([mpEventId, tipo, action])`
- [ ] `src/lib/mercadopago/signature.ts` com `timingSafeEqual` + janela de `ts`
- [ ] `src/services/webhook.service.ts` com roteamento por `type`
- [ ] `src/routes/webhooks.ts` registrada em `src/server.ts` **antes** de qualquer middleware de auth
- [ ] Rate limit na rota
- [ ] Testado com o webhook simulator do painel do MP
- [ ] Resposta `500` (não `200`) em falha — verificado por teste
- [ ] Assinatura inválida não cria `WebhookLog` — verificado por teste
