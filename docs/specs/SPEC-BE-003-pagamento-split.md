# SPEC-BE-003 — Pagamento de evento (split payment)

| | |
|---|---|
| **Repo** | `saaschurch-api` |
| **Fase** | F4 |
| **Depende de** | [SPEC-BE-001](./SPEC-BE-001-planos.md) (fee), [SPEC-BE-002](./SPEC-BE-002-oauth.md) (token da igreja), [SPEC-BE-005](./SPEC-BE-005-webhook.md) (confirmação) |
| **Habilita** | `SPEC-FE-003`, `SPEC-FE-004` |

---

## Contexto

Participante paga produto de evento. O dinheiro cai na conta MP **da igreja**, com `application_fee` retida pela plataforma.

A chamada a `POST /v1/payments` usa o `accessToken` **da igreja** (de `MercadoPagoAccount`, descriptografado), **nunca** `MERCADO_PAGO_ACCESS_TOKEN`.

### Cadeia de entidades existente

O planejamento v1 errava isto. A cadeia real no `schema.prisma` é:

```
Participantes → ParticipanteProdutos → Parcela
```

`Parcela` pertence a `ParticipanteProdutos`, não direto a `Participantes`. `ProdutosEvento.exigePagamento` define se o produto é cobrável.

## Requisitos funcionais

| ID | Requisito |
|---|---|
| RF-01 | Expor `publicKey` da igreja + produtos pagáveis do evento (rota pública). |
| RF-02 | Criar pagamento com `application_fee` calculado a partir do plano. |
| RF-03 | Idempotência via `X-Idempotency-Key` (MP) + `Pagamento.idempotencyKey` (local). |
| RF-04 | Vincular a `ParticipanteProdutos` e `Parcela`. |
| RF-05 | Consultar status por `id`. |
| RF-06 | Listar pagamentos de um evento (painel autenticado). |

## Modelagem

```prisma
model Pagamento {
  id                     String   @id @default(uuid())
  instituicaoId          String
  instituicao            Instituicao @relation(fields: [instituicaoId], references: [id], onDelete: Cascade)

  participanteId         String
  participante           Participantes @relation(fields: [participanteId], references: [id], onDelete: Cascade)

  participanteProdutoId  String?
  participanteProduto    ParticipanteProdutos? @relation(fields: [participanteProdutoId], references: [id])

  parcelaId              String?  @unique
  parcela                Parcela? @relation(fields: [parcelaId], references: [id])

  mpPaymentId            String   @unique
  idempotencyKey         String   @unique   // header X-Idempotency-Key enviado ao MP
  status                 PagamentoStatus @default(PENDING)
  statusDetail           String?

  valor                  Decimal
  applicationFee         Decimal  // snapshot da comissão no momento da criação
  feePercentualAplicado  Decimal  // snapshot do Plano.feeEventoPercentual usado
  metodoPagamento        String?  // credit_card | pix | bolbradesco
  parcelasCartao         Int      @default(1)

  aprovadoEm             DateTime?
  createdAt              DateTime @default(now())
  updatedAt              DateTime @updatedAt

  @@index([instituicaoId])
  @@index([participanteId])
  @@index([status])
  @@index([status, createdAt])   // suporta o job de reconciliação (SPEC-BE-006)
  @@map("pagamentos")
}

enum PagamentoStatus {
  PENDING
  IN_PROCESS
  APPROVED
  REJECTED
  REFUNDED
  CANCELLED
}
```

Relações reversas necessárias:

```prisma
model Participantes        { /* ... */ pagamentos Pagamento[] }
model ParticipanteProdutos { /* ... */ pagamentos Pagamento[] }
model Parcela              { /* ... */ pagamento  Pagamento?  }
```

> `applicationFee` e `feePercentualAplicado` são **snapshots**. Se o plano da igreja mudar depois, os pagamentos históricos preservam o fee cobrado à época. Nunca recalcule fee a partir do plano atual em telas de histórico.

## Fluxo

1. Participante escolhe produto(s) e forma de pagamento no checkout público.
2. Frontend chama `GET /pagamentos/checkout-config/:eventoId` → recebe a **`publicKey` da igreja** e inicializa o Payment Brick com ela.
3. Brick tokeniza o cartão no browser (a API nunca vê o PAN) e devolve `token` + `payment_method_id` + `installments`.
4. Frontend chama `POST /pagamentos`.
5. Backend:
   - resolve `MercadoPagoAccount` da instituição do evento; `status != ACTIVE` → `409 MP_ACCOUNT_INACTIVE`;
   - resolve `Plano` da instituição e calcula `applicationFee`;
   - **recalcula o valor** a partir de `ProdutosEvento.valor` no banco — nunca confia no valor do cliente;
   - gera `idempotencyKey` determinística: `sha256(participanteId + produtoIds ordenados + valor)`;
   - chama `POST /v1/payments` com o `accessToken` **da igreja**, header `X-Idempotency-Key`, campo `application_fee` e `external_reference` (para achar a igreja no webhook);
   - grava `Pagamento` com `status = PENDING` + snapshots de fee.
6. Vincula à `ParticipanteProdutos`/`Parcela` existentes.
7. Webhook `payment.updated` ([SPEC-BE-005](./SPEC-BE-005-webhook.md)) confirma aprovação → atualiza `Pagamento.status` e preenche `Parcela.valor_pago` / `data_pagamento` / `metodo_pagamento`.

### Cálculo do `applicationFee`

```
bruto = Σ produto.valor
fee   = bruto × (plano.feeEventoPercentual / 100)
fee   = max(fee, plano.feeEventoMinimo)
fee   = min(fee, plano.feeEventoMaximo ?? fee)
fee   = arredondar(fee, 2)   // ROUND_HALF_UP, via Decimal.js
```

Restrições: `fee >= 0` e `fee < bruto`. Se `plano.feeEventoPercentual == 0`, envie `application_fee: 0` ou omita o campo — **nunca** `null`.

> Todo esse cálculo em `Decimal` (Prisma/`Decimal.js`), **nunca** em `number`. `0.1 + 0.2 !== 0.3` custa centavos por transação e torna a reconciliação de fim de mês impossível. Ver `src/helpers/calcular-status-pagamento.ts`, que já lida com a conversão.

## Segurança

`POST /pagamentos` é rota **pública** — o participante não é um usuário autenticado do sistema.

- reCAPTCHA v3 obrigatório (`src/middleware/recaptcha.ts` já existe).
- Rate limit por IP.
- Valor **sempre** recalculado no servidor a partir do banco.
- `GET /pagamentos/:id` é público mas só devolve status, sem dados sensíveis do participante.

## Contrato

```http
GET /pagamentos/checkout-config/:eventoId          # pública
200 {
  "publicKey": "APP_USR-...",
  "produtos": [ { "id": "...", "nome": "...", "valor": "150.00" } ]
}
409 { "error": "MP_ACCOUNT_INACTIVE" }
403 { "error": "FEATURE_INDISPONIVEL", "feature": "pagamentosOnline" }
```

```http
POST /pagamentos                                   # pública + reCAPTCHA
{
  "eventoId": "...",
  "participanteId": "...",
  "produtoIds": ["..."],
  "token": "<card token do Brick>",
  "paymentMethodId": "master",
  "installments": 3,
  "payer": { "email": "...", "identification": { "type": "CPF", "number": "..." } },
  "recaptchaToken": "..."
}

201 { "pagamentoId": "...", "mpPaymentId": "123", "status": "PENDING", "statusDetail": "pending_contingency" }

# PIX
201 { "pagamentoId": "...", "mpPaymentId": "123", "status": "PENDING",
      "pix": { "qrCode": "00020126...", "qrCodeBase64": "iVBOR...", "expiraEm": "2026-07-09T18:30:00Z" } }

409 { "error": "MP_ACCOUNT_INACTIVE" }
422 { "error": "VALOR_DIVERGENTE" }
422 { "error": "PRODUTO_NAO_PAGAVEL" }
```

```http
GET /pagamentos/:id                                # pública
200 { "status": "APPROVED", "statusDetail": "accredited", "aprovadoEm": "..." }

GET /pagamentos/evento/:eventoId                   # autenticado
200 { "pagamentos": [...], "totais": { "bruto": "1500.00", "fee": "52.50", "liquido": "1447.50" } }
```

Valores `Decimal` serializados como **string**.

## Critérios de aceite

```gherkin
Cenário: Fee é calculado a partir do plano e congelado no pagamento
  Dado uma Instituicao em plano com feeEventoPercentual = 3.50
  E produtos somando R$ 200,00
  Quando POST /pagamentos
  Então application_fee enviado ao MP é 7.00
  E Pagamento.applicationFee = 7.00
  E Pagamento.feePercentualAplicado = 3.50

Cenário: Fee zero não envia null
  Dado um plano com feeEventoPercentual = 0
  Quando POST /pagamentos
  Então o corpo enviado ao MP tem application_fee = 0 ou omite o campo
  E nunca envia application_fee: null

Cenário: Fee respeita piso e teto
  Dado um plano com feeEventoPercentual=1, feeEventoMinimo=2.00, feeEventoMaximo=10.00
  E um produto de R$ 50,00
  Então applicationFee = 2.00
  E para um produto de R$ 5.000,00, applicationFee = 10.00

Cenário: Pagamento usa o token da igreja, não o da plataforma
  Dado uma Instituicao com MercadoPagoAccount ACTIVE
  Quando POST /pagamentos
  Então a chamada a /v1/payments usa o accessToken decifrado da igreja
  E nunca usa MERCADO_PAGO_ACCESS_TOKEN

Cenário: Conta MP inativa bloqueia o checkout
  Dado uma Instituicao com MercadoPagoAccount status EXPIRED
  Quando GET /pagamentos/checkout-config/:eventoId
  Então retorna 409 MP_ACCOUNT_INACTIVE
  E o frontend não renderiza o Brick

Cenário: Requisição duplicada não gera pagamento duplicado
  Dado um POST /pagamentos já processado
  Quando o mesmo payload é reenviado
  Então nenhum novo registro Pagamento é criado
  E retorna o mesmo mpPaymentId

Cenário: Valor é recalculado no servidor
  Dado um payload cujo valor do cliente diverge da soma de ProdutosEvento.valor
  Então o servidor ignora o valor do cliente e usa o do banco

Cenário: Produto sem exigePagamento não é cobrável
  Dado um produtoId com exigePagamento = false
  Quando POST /pagamentos o inclui
  Então retorna 422 PRODUTO_NAO_PAGAVEL

Cenário: Produto de outro evento é rejeitado
  Dado um produtoId que não pertence ao eventoId informado
  Então retorna 422

Cenário: Aprovação preenche a Parcela
  Quando o webhook confirma status approved
  Então Parcela.valor_pago, data_pagamento e metodo_pagamento são preenchidos
  E Pagamento.aprovadoEm recebe o timestamp
```

## Definição de pronto

- [ ] Migration `Pagamento` + enum + relações reversas
- [ ] `src/services/pagamento.service.ts` usando `calcularFee` de `plano.service`
- [ ] `src/routes/pagamentos.ts` registrada em `src/server.ts`
- [ ] reCAPTCHA + rate limit nas rotas públicas
- [ ] Aritmética 100% em `Decimal` — zero `parseFloat` no caminho de dinheiro
- [ ] `external_reference` enviado ao MP contendo o `pagamentoId` (o webhook depende disso)
- [ ] Testado em sandbox com cartões de teste do MP: aprovado, recusado, pendente
- [ ] Fluxo PIX retornando QR code e copia-e-cola
- [ ] `grep -rn "MERCADO_PAGO_ACCESS_TOKEN" src/services/pagamento.service.ts` não retorna nada
