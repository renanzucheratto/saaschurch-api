# SPEC-BE-004 — Assinatura SaaS (Preapproval)

| | |
|---|---|
| **Repo** | `saaschurch-api` |
| **Fase** | F5 |
| **Depende de** | [SPEC-BE-001](./SPEC-BE-001-planos.md), [SPEC-BE-005](./SPEC-BE-005-webhook.md) |
| **Habilita** | `SPEC-FE-002` (seção de cobrança) |

---

## Contexto

A plataforma cobra assinatura recorrente das instituições em **plano pago**, usando a Preapproval API do Mercado Pago com as credenciais **da própria plataforma** (`MERCADO_PAGO_ACCESS_TOKEN`).

**Este fluxo inteiro é no-op para plano gratuito.** Instituições em plano com `cobrancaSaaS = false` — os parceiros piloto — nunca chegam aqui (RN-01 de [SPEC-BE-001](./SPEC-BE-001-planos.md)).

Não confundir com [SPEC-BE-003](./SPEC-BE-003-pagamento-split.md), que usa o token **da igreja**.

## Requisitos funcionais

| ID | Requisito |
|---|---|
| RF-01 | Backoffice cria assinatura para instituição em plano pago. |
| RF-02 | Retornar `init_point` para a igreja autorizar. |
| RF-03 | Webhook de `subscription_preapproval` atualiza o status. |
| RF-04 | Consultar assinatura da instituição do usuário. |
| RF-05 | Backoffice cancela assinatura. |
| RF-06 | `requireAssinaturaAtiva()` bloqueia rotas quando `PAUSED`/`CANCELLED` — e é **no-op** em plano gratuito. |

## Modelagem

```prisma
model Assinatura {
  id                 String   @id @default(uuid())
  instituicaoId      String
  instituicao        Instituicao @relation(fields: [instituicaoId], references: [id], onDelete: Cascade)

  planoId            String
  plano              Plano    @relation(fields: [planoId], references: [id])

  mpPreapprovalId    String   @unique
  valor              Decimal
  periodicidade      String   @default("mensal")  // mensal | anual
  status             AssinaturaStatus @default(PENDING)
  proximaCobranca    DateTime?
  canceladaEm        DateTime?
  motivoCancelamento String?

  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  @@index([instituicaoId])
  @@index([status])
  @@map("assinaturas")
}

enum AssinaturaStatus {
  PENDING
  AUTHORIZED
  PAUSED
  CANCELLED
}
```

> Instituição em plano com `cobrancaSaaS = false` **nunca** tem registro em `Assinatura`. A ausência de linha é o estado válido, não um erro. O frontend precisa tratar `null` como estado normal, não como falha.

## Fluxo

1. Backoffice atribui plano pago a uma instituição ([SPEC-BE-001](./SPEC-BE-001-planos.md) RF-04).
2. `POST /billing/assinaturas` chama `POST /preapproval` com `MERCADO_PAGO_ACCESS_TOKEN`.
3. Retorna `init_point`; a igreja autoriza no MP.
4. Webhook `type: subscription_preapproval` atualiza `Assinatura.status`.
5. Ao chegar `AUTHORIZED`, `instituicao.planoId` passa a apontar para o plano novo (RN-07).
6. `status ∈ {PAUSED, CANCELLED}` → `requireAssinaturaAtiva()` bloqueia rotas protegidas com `402`.

Migrar de pago → gratuito cancela a assinatura ativa no MP e grava `motivoCancelamento` (RN-08).

## Contrato

```http
POST /billing/assinaturas                # backoffice
{ "instituicaoId": "...", "planoCodigo": "PRO", "periodicidade": "mensal" }

201 { "assinaturaId": "...", "initPoint": "https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=..." }
409 { "error": "PLANO_SEM_COBRANCA" }
409 { "error": "ASSINATURA_JA_ATIVA" }
403 { "error": "Acesso negado..." }
```

```http
GET /billing/assinaturas                 # autenticado; instituicaoId de req.user
200 { "status": "AUTHORIZED", "valor": "99.00", "proximaCobranca": "2026-08-09", "plano": { ... } }
200 { "status": null, "motivo": "PLANO_SEM_COBRANCA" }     # plano gratuito — NÃO é erro
```

```http
PATCH /billing/assinaturas/:id/cancelar  # backoffice
{ "motivo": "Downgrade para plano piloto" }
200 { "status": "CANCELLED" }
```

## Critérios de aceite

```gherkin
Cenário: Assinatura usa credenciais da plataforma
  Quando POST /billing/assinaturas
  Então a chamada a /preapproval usa MERCADO_PAGO_ACCESS_TOKEN
  E nunca usa o accessToken de uma MercadoPagoAccount

Cenário: Plano gratuito rejeita criação de assinatura
  Dado uma Instituicao em plano com cobrancaSaaS = false
  Quando POST /billing/assinaturas
  Então retorna 409 PLANO_SEM_COBRANCA
  E nenhuma chamada é feita à API do MP

Cenário: GET de assinatura em plano gratuito não é erro
  Dado uma Instituicao em plano gratuito
  Quando GET /billing/assinaturas
  Então retorna 200 com status null e motivo PLANO_SEM_COBRANCA

Cenário: Assinatura duplicada é rejeitada
  Dado uma Assinatura com status AUTHORIZED
  Quando POST /billing/assinaturas para a mesma instituição
  Então retorna 409 ASSINATURA_JA_ATIVA

Cenário: Webhook de autorização ativa o plano pago
  Dado uma Assinatura PENDING para o plano PRO
  Quando chega webhook subscription_preapproval com status authorized
  Então Assinatura.status = AUTHORIZED
  E instituicao.planoId = id do plano PRO

Cenário: Assinatura pausada bloqueia features
  Dado uma Assinatura com status PAUSED
  Quando o usuário acessa rota com requireAssinaturaAtiva()
  Então retorna 402 com erro "ASSINATURA_INATIVA"

Cenário: Gate de assinatura é no-op em plano gratuito
  Dado plano com cobrancaSaaS = false e nenhuma Assinatura
  Quando rota com requireAssinaturaAtiva()
  Então prossegue

Cenário: Downgrade cancela a assinatura no MP
  Dado uma Instituicao com Assinatura AUTHORIZED
  Quando backoffice troca para um plano com cobrancaSaaS = false
  Então a assinatura é cancelada na API do MP
  E Assinatura.status = CANCELLED
  E motivoCancelamento é preenchido
```

## Definição de pronto

- [ ] Migration `Assinatura` + enum + relações reversas em `Instituicao` e `Plano`
- [ ] `src/services/billing.service.ts`
- [ ] `src/routes/billing.ts` registrada em `src/server.ts`
- [ ] `requireAssinaturaAtiva()` com no-op comprovado por teste para `cobrancaSaaS = false`
- [ ] Handler de `subscription_preapproval` em `webhook.service.ts`
- [ ] `grep -rn "PILOTO_FREE" src/` não retorna nada (RN-02 — o gate pergunta pela feature, não pelo código)
