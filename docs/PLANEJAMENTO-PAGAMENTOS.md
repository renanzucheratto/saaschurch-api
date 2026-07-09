# Planejamento — Camada de Pagamentos (Mercado Pago)
### SaaS de Gestão de Igrejas — `saaschurch-api` + `saaschurch`

> **Versão 2.** Revisa o planejamento original com base na leitura do código real dos dois repositórios, adiciona o **plano gratuito full para parceiros piloto**, o **planejamento de frontend**, e converte a implementação para **spec-driven design**.

---

## 0. Correções ao planejamento original

O planejamento v1 assumia uma arquitetura que não corresponde ao código atual. Antes de qualquer implementação, estas divergências precisam estar entendidas:

| # | Planejamento v1 dizia | Realidade do código | Impacto |
|---|---|---|---|
| 1 | "Módulos" (`billing/`, `payments/`) — padrão NestJS | Express 4 + rotas planas em `src/routes/*.ts`, montadas manualmente em `src/server.ts` | Não existe DI, decorators nem `@Module`. Cada "módulo" vira um arquivo de rota + um arquivo de service. |
| 2 | — | `schema.prisma` usa `relationMode = "prisma"` | Não há foreign keys no banco. Integridade referencial é responsabilidade da aplicação. `onDelete: Cascade` é emulado pelo Prisma Client, não pelo Postgres. |
| 3 | `Pagamento.parcelaId → Parcela` | `Parcela` pertence a `ParticipanteProdutos`, não a `Participantes` | A cadeia real é `Participantes → ParticipanteProdutos → Parcela`. O vínculo do pagamento precisa respeitar isso. |
| 4 | "comissão parametrizável por plano da plataforma" | Não existe model `Plano` no schema | O plano precisa ser criado do zero. É pré-requisito do fee e do plano piloto. |
| 5 | Não mencionava jobs de infra | `src/jobs/` existe mas está **vazio**; deploy é Vercel (`vercel.json`) | Não há worker de longa duração. Jobs precisam ser Vercel Cron ou serviço externo. |
| 6 | — | Envs `MERCADO_PAGO_PUBLIC_KEY`, `MERCADO_PAGO_ACCESS_TOKEN`, `MERCADO_PAGO_WEBHOOK_SECRET` já existem em `.env` / `.env.example` / `.env.prd` | Cobrem a conta **da plataforma**. Faltam as de OAuth (ver §9). |
| 7 | `Decimal` sem qualificação | Prisma `Decimal` vira `Decimal.js` no client, não `number` | Toda aritmética de valor precisa de `.toNumber()` ou `Decimal` — ver `src/helpers/calcular-status-pagamento.ts`, que já lida com isso. |

---

## 1. Visão Geral

O projeto é multi-tenant: cada `Instituicao` (igreja) opera isolada, vinculada por `instituicaoId` em praticamente todas as entidades. A camada de pagamentos atende **três** preocupações de negócio distintas (o v1 listava duas):

1. **Planos e elegibilidade** — cada `Instituicao` pertence a um `Plano`, que define se há cobrança de assinatura, qual o percentual de fee sobre eventos, e quais features estão liberadas. **Parceiros piloto usam um plano gratuito full: sem cobrança de assinatura, com todas as features liberadas.**
2. **Cobrança de assinatura SaaS** — a plataforma cobra a `Instituicao` pelo uso do sistema (Preapproval, conta MP **da plataforma**). Instituições em plano gratuito **não entram neste fluxo**.
3. **Pagamento de eventos/produtos** — `Participantes` pagam inscrições/produtos de `Eventos`; o dinheiro cai direto na conta MP **da própria igreja** (Split Payments), com `application_fee` retida pela plataforma.

Os fluxos 2 e 3 usam APIs diferentes do Mercado Pago, com credenciais diferentes. Confundi-los é o erro mais provável desta implementação.

---

## 2. Objetivos

- Modelar `Plano` com o plano **gratuito full para parceiros piloto** como cidadão de primeira classe, não como caso especial hardcoded.
- Cada `Instituicao` conecta sua própria conta MP via OAuth, independentemente.
- Pagamentos de eventos caem na conta da igreja, com dedução automática da comissão da plataforma.
- Assinatura recorrente cobrada apenas de instituições em plano pago.
- Fluxo auditável, idempotente e resiliente a falha de webhook.
- Tokens de acesso de cada igreja criptografados em repouso e renovados automaticamente.

## 3. Fora de Escopo (nesta fase)

- Emissão de nota fiscal.
- Split entre múltiplas igrejas na mesma transação.
- Métodos de pagamento presenciais (maquininha / Point).
- Downgrade automático de plano com proration.
- Troca de plano self-service com cobrança pró-rata (nesta fase, troca de plano é ação de backoffice).

---

## 4. Arquitetura

Adaptada à stack real (Express + Prisma + Vercel).

```
┌──────────────────────────────────────────────────────────────────┐
│                    saaschurch-api (Express)                      │
│                                                                  │
│  src/routes/                    src/services/                    │
│  ├─ planos.ts        ────────►  ├─ plano.service.ts              │
│  ├─ billing.ts       ────────►  ├─ billing.service.ts            │
│  ├─ payment-connect.ts ──────►  ├─ payment-connect.service.ts    │
│  ├─ pagamentos.ts    ────────►  ├─ pagamento.service.ts          │
│  └─ webhooks.ts      ────────►  └─ webhook.service.ts            │
│                                                                  │
│  src/lib/mercadopago/           src/middleware/                  │
│  ├─ client.ts (factory)         ├─ auth.middleware.ts (existe)   │
│  ├─ oauth.ts                    ├─ permissions.middleware.ts     │
│  ├─ signature.ts                └─ require-plano.middleware.ts   │
│  └─ crypto.ts (AES-256-GCM)        (novo — feature gating)       │
│                                                                  │
│  src/jobs/ (Vercel Cron → rotas protegidas)                      │
│  ├─ refresh-tokens.ts                                            │
│  ├─ reconciliar-pagamentos.ts                                    │
│  └─ verificar-assinaturas.ts                                     │
└──────────────────────────────────────────────────────────────────┘
        │                     │                        │
   Preapproval API      OAuth + Payments API      Notificações
   (conta plataforma)   (conta de cada igreja)    assíncronas
        │                     │                        │
        └──────────► Mercado Pago API ◄────────────────┘
```

### 4.1 Convenções obrigatórias

- Toda rota nova é registrada em `src/server.ts` com `app.use('/prefixo', router)`.
- Rota de webhook **não** passa por `authenticateUser` — usa validação de assinatura HMAC.
- Rota de cron **não** passa por `authenticateUser` — usa header `Authorization: Bearer ${CRON_SECRET}`.
- Toda query filtra por `instituicaoId` derivado de `req.user.instituicaoId` (nunca do body/params sem `requireSameInstitution`).
- SDK: usar `mercadopago` (SDK oficial Node) **ou** `fetch` direto. Recomendação: `fetch` direto para OAuth e webhooks (o SDK não expõe bem o fluxo de marketplace), SDK para `payments`/`preapproval`.

---

## 5. Modelagem de Dados

Adições ao `prisma/schema.prisma`. Todos os models seguem as convenções já usadas no arquivo: `@@map` snake_case, `@@index` explícito (obrigatório com `relationMode = "prisma"`), `createdAt`/`updatedAt`.

### 5.1 Plano (novo — base de tudo)

```prisma
model Plano {
  id                  String   @id @default(uuid())
  codigo              String   @unique   // PILOTO_FREE | ESSENCIAL | PRO
  nome                String
  descricao           String?

  // Cobrança de assinatura SaaS
  cobrancaSaaS        Boolean  @default(true)   // false => plano gratuito, nunca gera Assinatura
  valorMensal         Decimal  @default(0)
  valorAnual          Decimal?
  mpPreapprovalPlanId String?                   // id do plano no MP (só se cobrancaSaaS)

  // Fee sobre pagamentos de evento (split)
  feeEventoPercentual Decimal  @default(0)      // ex.: 3.50 == 3,5%
  feeEventoMinimo     Decimal  @default(0)      // piso em R$ por transação
  feeEventoMaximo     Decimal?                  // teto em R$ por transação (null = sem teto)

  // Limites / features
  limiteEventosAtivos Int?                      // null = ilimitado
  limiteUsuarios      Int?                      // null = ilimitado
  features            Json     @default("{}")   // { "pagamentosOnline": true, "relatorios": true, ... }

  ativo               Boolean  @default(true)
  ordem               Int      @default(0)      // ordenação na vitrine de planos

  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt
  instituicoes        Instituicao[]
  assinaturas         Assinatura[]

  @@index([codigo])
  @@map("planos")
}
```

> **`features` como `Json`** e não colunas booleanas: features novas não exigem migration. O custo é a perda de type-safety — mitigado por um `PlanoFeatures` em `src/types/` e um helper `temFeature(plano, 'pagamentosOnline')`.

### 5.2 Alteração em `Instituicao`

```prisma
model Instituicao {
  // ... campos existentes ...

  planoId              String?
  plano                Plano?              @relation(fields: [planoId], references: [id])
  parceiroPiloto       Boolean             @default(false)  // flag informativa/auditoria
  planoAtribuidoEm     DateTime?
  planoAtribuidoPor    String?             // email do backoffice que atribuiu

  mercadoPagoAccount   MercadoPagoAccount?
  assinaturas          Assinatura[]
  pagamentos           Pagamento[]

  @@index([planoId])
  // ... @@map("instituicoes")
}
```

`planoId` é opcional para não quebrar as instituições existentes na migration. O `plano.service` trata `planoId == null` como **plano padrão do sistema** (`PILOTO_FREE` durante o período de piloto), o que também torna a migration de dados trivial.

### 5.3 Conexão OAuth por instituição

```prisma
model MercadoPagoAccount {
  id             String      @id @default(uuid())
  instituicaoId  String      @unique
  instituicao    Instituicao @relation(fields: [instituicaoId], references: [id], onDelete: Cascade)

  mpUserId       String                    // user_id do MP da igreja
  accessToken    String                    // AES-256-GCM em repouso
  refreshToken   String                    // AES-256-GCM em repouso
  publicKey      String                    // usado pelo Payment Brick no frontend
  scope          String?
  expiresAt      DateTime
  status         MercadoPagoAccountStatus  @default(PENDING)

  ultimoRefreshEm DateTime?
  ultimoErro      String?

  createdAt      DateTime    @default(now())
  updatedAt      DateTime    @updatedAt

  @@index([instituicaoId])
  @@index([status])
  @@map("mercado_pago_accounts")
}

enum MercadoPagoAccountStatus {
  PENDING     // OAuth iniciado, aguardando autorização
  ACTIVE      // conectado e funcional
  EXPIRED     // token expirado, precisa reautorizar
  REVOKED     // igreja desconectou
}
```

### 5.4 Assinatura da plataforma (SaaS)

```prisma
model Assinatura {
  id                String   @id @default(uuid())
  instituicaoId     String
  instituicao       Instituicao @relation(fields: [instituicaoId], references: [id], onDelete: Cascade)

  planoId           String
  plano             Plano    @relation(fields: [planoId], references: [id])

  mpPreapprovalId   String   @unique
  valor             Decimal
  periodicidade     String   @default("mensal")  // mensal | anual
  status            AssinaturaStatus @default(PENDING)
  proximaCobranca   DateTime?
  canceladaEm       DateTime?
  motivoCancelamento String?

  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

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

> Instituição em plano com `cobrancaSaaS = false` **nunca** tem registro em `Assinatura`. A ausência de linha é o estado válido, não um erro.

### 5.5 Pagamentos de eventos (split payments)

Corrige o vínculo errado do v1: a cadeia real é `Participantes → ParticipanteProdutos → Parcela`.

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
  idempotencyKey         String   @unique   // enviado no header X-Idempotency-Key ao MP
  status                 PagamentoStatus @default(PENDING)
  statusDetail           String?

  valor                  Decimal
  applicationFee         Decimal  // comissão retida pela plataforma, snapshot no momento da criação
  feePercentualAplicado  Decimal  // snapshot do Plano.feeEventoPercentual usado
  metodoPagamento        String?  // credit_card | pix | bolbradesco
  parcelasCartao         Int      @default(1)

  aprovadoEm             DateTime?
  createdAt              DateTime @default(now())
  updatedAt              DateTime @updatedAt

  @@index([instituicaoId])
  @@index([participanteId])
  @@index([status])
  @@index([status, createdAt])   // suporta o job de reconciliação
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

> `applicationFee` e `feePercentualAplicado` são **snapshots**. Se o plano da igreja mudar depois, os pagamentos históricos preservam o fee cobrado à época. Nunca recalcule fee a partir do plano atual em telas de histórico.

### 5.6 Relações reversas necessárias

```prisma
model Participantes {
  // ... existente ...
  pagamentos Pagamento[]
}

model ParticipanteProdutos {
  // ... existente ...
  pagamentos Pagamento[]
}

model Parcela {
  // ... existente ...
  pagamento Pagamento?
}
```

### 5.7 Log de webhooks (auditoria/idempotência)

```prisma
model WebhookLog {
  id            String   @id @default(uuid())
  mpEventId     String            // data.id do MP
  tipo          String            // payment | subscription_preapproval | ...
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

> O v1 usava `mpEventId @unique`. Isso é **insuficiente**: o MP envia o mesmo `data.id` para `payment.created` e `payment.updated`. A chave de idempotência correta é a tripla `(mpEventId, tipo, action)`.

---

## 6. Regra de negócio: Plano Gratuito Full (Parceiro Piloto)

### 6.1 Definição

`Plano { codigo: "PILOTO_FREE" }` é um plano real, seedado na base:

```ts
{
  codigo: 'PILOTO_FREE',
  nome: 'Parceiro Piloto',
  descricao: 'Acesso completo, sem cobrança de assinatura. Concedido a parceiros do programa piloto.',
  cobrancaSaaS: false,
  valorMensal: 0,
  valorAnual: 0,
  mpPreapprovalPlanId: null,
  feeEventoPercentual: 0,      // DECISÃO PENDENTE — ver §6.4
  feeEventoMinimo: 0,
  feeEventoMaximo: null,
  limiteEventosAtivos: null,   // ilimitado
  limiteUsuarios: null,        // ilimitado
  features: {                  // full
    pagamentosOnline: true,
    relatorios: true,
    projetos: true,
    areas: true,
    camposCustomizados: true,
    exportacao: true
  },
  ativo: true,
  ordem: 0
}
```

### 6.2 Invariantes

| ID | Regra |
|---|---|
| RN-01 | Se `plano.cobrancaSaaS == false`, o sistema **nunca** cria `Assinatura`, **nunca** chama a Preapproval API e **nunca** bloqueia features por status de assinatura. |
| RN-02 | Toda checagem de feature consulta `plano.features`, **nunca** `instituicao.parceiroPiloto` nem `plano.codigo`. A flag `parceiroPiloto` é só auditoria/exibição. |
| RN-03 | O fee de evento vem **sempre** de `plano.feeEventoPercentual`, independentemente de o plano ser gratuito. Plano gratuito não implica fee zero — são eixos ortogonais. |
| RN-04 | `instituicao.planoId == null` resolve para o plano padrão do sistema (`PILOTO_FREE` durante o piloto), configurável por `PLANO_PADRAO_CODIGO`. |
| RN-05 | Atribuir/trocar plano é ação restrita a `userType == 'backoffice'` (não existe self-service de upgrade nesta fase). |
| RN-06 | Toda troca de plano registra `planoAtribuidoEm` + `planoAtribuidoPor`. |
| RN-07 | Migrar de plano gratuito → pago exige criar `Assinatura` e só entra em vigor com `status == AUTHORIZED`. Até lá, a instituição permanece no plano anterior. |
| RN-08 | Migrar de plano pago → gratuito cancela a `Assinatura` ativa no MP e grava `motivoCancelamento`. |

> **RN-01 e RN-02 juntas são o coração da feature.** Se o gating perguntar "é piloto?" em vez de "tem a feature?", cada plano novo vai exigir tocar em `if`s espalhados. O gate pergunta pelo plano, o plano responde pela feature.

### 6.3 Feature gating

`src/middleware/require-plano.middleware.ts`:

```ts
// Uso: router.post('/pagamentos', authenticateUser, requireFeature('pagamentosOnline'), handler)
export function requireFeature(feature: keyof PlanoFeatures) { /* ... */ }

// Uso: router.post('/eventos', authenticateUser, requireLimite('eventosAtivos'), handler)
export function requireLimite(limite: 'eventosAtivos' | 'usuarios') { /* ... */ }

// Bloqueia se houver Assinatura em PAUSED/CANCELLED.
// No-op quando plano.cobrancaSaaS == false (RN-01).
export function requireAssinaturaAtiva() { /* ... */ }
```

### 6.4 Decisão pendente (bloqueia SPEC-BE-001)

**O parceiro piloto paga fee sobre eventos?** O enunciado diz que "o restante como fee e etc mantém como está", o que se lê como *o mecanismo de fee continua existindo* — mas não define o valor para `PILOTO_FREE`.

O schema acima suporta ambas as respostas sem alteração (`feeEventoPercentual` é um campo do plano). O seed acima assume `0`. Confirmar antes de rodar o seed:

- **`0%`** — piloto é 100% gratuito, plataforma não retém nada. Simples de comunicar, receita zero na fase piloto.
- **`X%`** (mesmo dos planos pagos) — assinatura é gratuita, mas transação gera receita. Recomendado se o piloto tiver eventos de volume relevante.

---

## 7. Fluxos Detalhados

### 7.1 Onboarding OAuth de uma igreja

1. Admin da igreja clica em "Conectar Mercado Pago".
2. `POST /payment-connect/authorize` — backend gera `state` = JWT curto (TTL 10 min) contendo `{ instituicaoId, userId, nonce }`, assinado com `JWT_SECRET`, e devolve `{ authorizeUrl }`.
3. Frontend navega para `https://auth.mercadopago.com.br/authorization?client_id=...&response_type=code&platform_id=mp&state=<jwt>&redirect_uri=...`.
4. MP redireciona para `GET /payment-connect/callback?code=...&state=...`.
5. Backend valida `state` (assinatura + TTL + nonce não reutilizado), troca `code` por tokens em `POST /oauth/token`, criptografa `access_token`/`refresh_token` (AES-256-GCM), grava `MercadoPagoAccount` com `status = ACTIVE`.
6. Redireciona o browser para `${FRONTEND_URL}/instituicao/pagamentos?connected=1`.
7. Cron diário renova tokens com `expiresAt` a menos de 7 dias, usando `refresh_token`.

> O `redirect_uri` registrado no painel do MP precisa ser **exatamente** a URL do callback, incluindo protocolo e ausência de barra final. Divergência aqui é a causa nº 1 de `invalid_client` no OAuth do MP.

### 7.2 Pagamento de evento (split payment)

1. Participante escolhe produto(s) do evento e forma de pagamento no checkout público.
2. Frontend pede `GET /pagamentos/checkout-config/:eventoId` → recebe a **`publicKey` da igreja** (de `MercadoPagoAccount`) e inicializa o Payment Brick com ela.
3. Brick tokeniza o cartão no browser (a API nunca vê o PAN) e devolve `token` + `payment_method_id` + `installments`.
4. Frontend chama `POST /pagamentos` com `{ eventoId, participanteId, produtoIds[], token, paymentMethodId, installments, payer }`.
5. Backend:
   - resolve `MercadoPagoAccount` da instituição do evento; se `status != ACTIVE` → `409 MP_ACCOUNT_INACTIVE`;
   - resolve `Plano` da instituição e calcula `applicationFee` (§7.2.1);
   - gera `idempotencyKey` determinística (`sha256(participanteId + produtoIds + valor)`);
   - chama `POST /v1/payments` com o `accessToken` **da igreja** (descriptografado), header `X-Idempotency-Key`, campo `application_fee`;
   - grava `Pagamento` com `status = PENDING` + snapshots de fee.
6. Vincula à `ParticipanteProdutos`/`Parcela` existentes.
7. Webhook `payment.updated` confirma aprovação → atualiza `Pagamento.status`, preenche `Parcela.valor_pago` / `data_pagamento` / `metodo_pagamento`.

#### 7.2.1 Cálculo do `applicationFee`

```
bruto  = Σ produto.valor
fee    = bruto × (plano.feeEventoPercentual / 100)
fee    = max(fee, plano.feeEventoMinimo)
fee    = min(fee, plano.feeEventoMaximo ?? fee)
fee    = arredondar(fee, 2)   // ROUND_HALF_UP, via Decimal.js
```

Restrições: `fee >= 0` e `fee < bruto`. Se `plano.feeEventoPercentual == 0`, envie `application_fee: 0` ou omita o campo — não envie `null`.

> Todo esse cálculo em `Decimal` (Prisma/`Decimal.js`), **nunca** em `number`. `0.1 + 0.2 !== 0.3` custa centavos por transação e reconciliação impossível no fim do mês.

### 7.3 Assinatura SaaS (Preapproval)

**Só executa se `plano.cobrancaSaaS == true` (RN-01).**

1. Backoffice atribui plano pago a uma instituição.
2. `POST /billing/assinaturas` chama `POST /preapproval` com as **credenciais da plataforma** (`MERCADO_PAGO_ACCESS_TOKEN`).
3. Retorna `init_point`; a igreja autoriza no MP.
4. Webhook `subscription_preapproval` atualiza `Assinatura.status`.
5. `status ∈ {PAUSED, CANCELLED}` → `requireAssinaturaAtiva()` passa a bloquear rotas protegidas.

### 7.4 Webhooks (endpoint único)

```
POST /webhooks/mercadopago
```

1. Validar `x-signature` + `x-request-id` (HMAC-SHA256, ver §8.2). Payload inválido → `401`, sem processar.
2. `upsert` em `WebhookLog` pela tripla `(mpEventId, tipo, action)`. Se já existe com `processado = true` → `200 OK` e retorna (idempotência).
3. Buscar o recurso real na API do MP (`GET /v1/payments/{id}` ou `GET /preapproval/{id}`). **Nunca** usar o payload do webhook para decisão de negócio — ele só carrega o `id`.
4. Rotear: `type: payment` → `pagamento.service`; `type: subscription_preapproval` → `billing.service`.
5. `WebhookLog.processado = true`, `processadoEm = now()`.
6. Erro no processamento → gravar `erro`, incrementar `tentativas`, responder **`500`** (o MP re-tenta com backoff por até 8h). Responder `200` em falha faz o evento ser perdido para sempre.

> Para `type: payment` de uma igreja, o `GET /v1/payments/{id}` precisa usar o `accessToken` **da igreja**, não o da plataforma. Descubra a igreja pelo `external_reference` que você enviou na criação do pagamento.

---

## 8. Segurança

### 8.1 Tokens em repouso

- `accessToken`/`refreshToken` cifrados com **AES-256-GCM**, chave de 32 bytes em `MP_TOKEN_ENCRYPTION_KEY` (hex, 64 chars).
- Formato armazenado: `iv:authTag:ciphertext` (base64 por segmento).
- **Nunca** logar token, nem truncado. Nunca retornar em resposta de API — nem para backoffice.
- Rotação de chave: prever coluna `encryptionKeyVersion` se a chave for rotacionada.

### 8.2 Validação de assinatura do webhook

O MP envia:
```
x-signature: ts=1704908010,v1=618c85345248dd820d5fd456117c2ab2ef8eda45a0282ff693eac24131a5e839
x-request-id: <uuid>
```

Manifesto a assinar (ordem e pontuação são exatas; campos ausentes são omitidos junto do separador):
```
id:<data.id>;request-id:<x-request-id>;ts:<ts>;
```

Compare `HMAC_SHA256(manifest, MERCADO_PAGO_WEBHOOK_SECRET)` com `v1` usando **`crypto.timingSafeEqual`**, nunca `===`. Rejeite `ts` com desvio > 5 min (proteção contra replay).

> `data.id` deve ser lido do **query param** `data.id` da URL, não do body, e em minúsculas quando alfanumérico. Essa é a pegadinha mais comum da validação de assinatura do MP.

### 8.3 Demais controles

- `state` do OAuth = JWT assinado, TTL curto, `nonce` de uso único (evita CSRF e replay do `code`).
- Rate limiting em `POST /webhooks/mercadopago` e `POST /pagamentos`.
- Isolamento por `instituicaoId` em **toda** query. Com `relationMode = "prisma"` não há FK protegendo contra vazamento entre tenants — a aplicação é a única barreira.
- Rotas de cron protegidas por `CRON_SECRET` (Vercel injeta `Authorization: Bearer $CRON_SECRET`).
- Credenciais `TEST-` em dev/staging; `APP_USR-` só em produção. Nunca compartilhar `.env.prd`.
- `POST /pagamentos` é rota **pública** (participante não é usuário autenticado): protegê-la com reCAPTCHA (`src/middleware/recaptcha.ts` já existe) + rate limit por IP.

---

## 9. Variáveis de ambiente

Já existem em `.env`, `.env.example`, `.env.prd` (conta da **plataforma**):

```bash
MERCADO_PAGO_PUBLIC_KEY=""
MERCADO_PAGO_ACCESS_TOKEN=""
MERCADO_PAGO_WEBHOOK_SECRET=""
```

**Faltam** e precisam ser adicionadas — sem elas o fluxo OAuth (§7.1) não existe:

```bash
# OAuth marketplace (app criado no painel de Aplicações do MP)
MERCADO_PAGO_CLIENT_ID=""
MERCADO_PAGO_CLIENT_SECRET=""
MERCADO_PAGO_REDIRECT_URI="https://api.exemplo.com/payment-connect/callback"

# Criptografia de tokens em repouso — 32 bytes hex
# gerar: openssl rand -hex 32
MP_TOKEN_ENCRYPTION_KEY=""

# Proteção das rotas de cron
CRON_SECRET=""

# Plano padrão para instituicao.planoId == null (RN-04)
PLANO_PADRAO_CODIGO="PILOTO_FREE"
```

Frontend (`saaschurch/.env`):

```bash
NEXT_PUBLIC_BASE_URL="http://localhost:3001"   # já existe (usado por baseApi.ts)
```

> A `publicKey` do Payment Brick **não** vai em env do frontend. Ela é a chave da igreja, obtida em runtime via `GET /pagamentos/checkout-config/:eventoId`. Colocar `NEXT_PUBLIC_MP_PUBLIC_KEY` no build enviaria os pagamentos de todas as igrejas para a conta da plataforma.

---

## 10. Endpoints

| Método | Rota | Auth | Descrição |
|---|---|---|---|
| GET | `/planos` | autenticado | Lista planos ativos |
| GET | `/planos/meu` | autenticado | Plano da instituição do usuário + features + limites |
| PATCH | `/planos/instituicao/:instituicaoId` | backoffice | Atribui/troca plano (RN-05..08) |
| POST | `/payment-connect/authorize` | autenticado + backoffice/pastor | Inicia OAuth; retorna `{ authorizeUrl }` |
| GET | `/payment-connect/callback` | pública (valida `state`) | Callback OAuth do MP |
| GET | `/payment-connect/status` | autenticado | Status da conexão da instituição |
| DELETE | `/payment-connect` | backoffice/pastor | Desconecta conta MP |
| GET | `/pagamentos/checkout-config/:eventoId` | pública | `publicKey` da igreja + produtos pagáveis |
| POST | `/pagamentos` | pública + reCAPTCHA | Cria pagamento de evento (split) |
| GET | `/pagamentos/:id` | pública (por token) | Status de um pagamento |
| GET | `/pagamentos/evento/:eventoId` | autenticado | Lista pagamentos do evento (painel) |
| POST | `/billing/assinaturas` | backoffice | Cria assinatura SaaS |
| GET | `/billing/assinaturas` | autenticado | Assinatura da instituição do usuário |
| PATCH | `/billing/assinaturas/:id/cancelar` | backoffice | Cancela assinatura |
| POST | `/webhooks/mercadopago` | HMAC | Endpoint único de notificações |
| POST | `/jobs/refresh-tokens` | `CRON_SECRET` | Renova tokens OAuth |
| POST | `/jobs/reconciliar-pagamentos` | `CRON_SECRET` | Reconcilia `PENDING` antigos |
| POST | `/jobs/verificar-assinaturas` | `CRON_SECRET` | Verifica assinaturas vencidas |

`GET /payment-connect/status` e `DELETE /payment-connect` derivam `instituicaoId` de `req.user`, não de path param — elimina uma classe inteira de IDOR.

---

## 11. Jobs / Rotinas Assíncronas

Deploy é Vercel → jobs são **Vercel Cron** apontando para rotas HTTP protegidas por `CRON_SECRET`.

`vercel.json`:
```json
{
  "crons": [
    { "path": "/jobs/refresh-tokens",        "schedule": "0 3 * * *" },
    { "path": "/jobs/reconciliar-pagamentos","schedule": "*/30 * * * *" },
    { "path": "/jobs/verificar-assinaturas", "schedule": "0 4 * * *" }
  ]
}
```

| Job | Frequência | O que faz |
|---|---|---|
| `refresh-tokens` | diário 03:00 | Renova `MercadoPagoAccount` com `expiresAt < now + 7d`. Falha → `status = EXPIRED` + `ultimoErro`. |
| `reconciliar-pagamentos` | a cada 30 min | Varre `Pagamento` com `status ∈ {PENDING, IN_PROCESS}` e `createdAt < now - 30min`; consulta status real na API do MP. **Obrigatório**, não nice-to-have: webhook do MP falha. |
| `verificar-assinaturas` | diário 04:00 | `Assinatura` com `proximaCobranca < now` e `status == AUTHORIZED` → reconsulta MP e aplica bloqueio se divergente. Ignora instituições com `plano.cobrancaSaaS == false`. |

> Vercel Cron no plano Hobby só dispara 1×/dia e tem timeout curto. Se o reconciliador de 30 min for necessário desde o piloto, isso exige plano Pro ou um agendador externo. Verificar antes da Fase 5.

---

# PARTE II — SPEC-DRIVEN DESIGN

Cada spec é uma unidade implementável e testável de forma independente. Formato: **contexto → requisitos → contrato → critérios de aceite (Gherkin) → definição de pronto**.

Um arquivo por spec, **no repositório onde ela será implementada**:

```
saaschurch-api/docs/                     saaschurch/docs/
├── PLANEJAMENTO-PAGAMENTOS.md           └── specs/
└── specs/                                   ├── README.md
    ├── README.md                            ├── SPEC-FE-001-conectar-mercado-pago.md
    ├── SPEC-BE-001-planos.md                ├── SPEC-FE-002-assinatura.md
    ├── SPEC-BE-002-oauth.md                 ├── SPEC-FE-003-checkout-evento.md
    ├── SPEC-BE-003-pagamento-split.md       ├── SPEC-FE-004-painel-pagamentos.md
    ├── SPEC-BE-004-assinatura-saas.md       ├── SPEC-FE-005-backoffice-planos.md
    ├── SPEC-BE-005-webhook.md               └── SPEC-FE-006-guard-plano.md
    ├── SPEC-BE-006-reconciliacao.md
    └── SPEC-BE-007-feature-gating.md
```

Este arquivo continua sendo a fonte única de arquitetura, modelagem e roadmap. As specs carregam requisitos, contratos e critérios de aceite.

### Grafo de dependências

```
SPEC-BE-001 (Planos)
   ├──► SPEC-BE-003 (Pagamento split)   ──┐
   ├──► SPEC-BE-004 (Assinatura SaaS)   ──┤
   └──► SPEC-BE-007 (Feature gating)      │
                                          │
SPEC-BE-002 (OAuth) ──────────────────────┤
                                          │
SPEC-BE-005 (Webhook) ◄───────────────────┘
   └──► SPEC-BE-006 (Reconciliação)

SPEC-FE-001 (Conectar MP)  ← BE-002
SPEC-FE-002 (Assinatura)   ← BE-001, BE-004
SPEC-FE-003 (Checkout)     ← BE-003
SPEC-FE-004 (Painel pgto)  ← BE-003
SPEC-FE-005 (Backoffice)   ← BE-001
SPEC-FE-006 (Guard)        ← BE-007
```

---

## Índice das specs de backend

Corpo completo em [`docs/specs/`](./specs/README.md) — um arquivo por spec, para abrir isoladamente numa sessão de implementação.

| Spec | Fase | Depende de | Entrega |
|---|---|---|---|
| [SPEC-BE-001 — Planos e elegibilidade](./specs/SPEC-BE-001-planos.md) | F1 | — | Model `Plano`, seed `PILOTO_FREE`, `calcularFee`, rotas `/planos` |
| [SPEC-BE-007 — Feature gating](./specs/SPEC-BE-007-feature-gating.md) | F1 | BE-001 | `requireFeature` / `requireLimite` / `requireAssinaturaAtiva` |
| [SPEC-BE-005 — Webhook único](./specs/SPEC-BE-005-webhook.md) | F2 | — | `POST /webhooks/mercadopago`, HMAC, idempotência |
| [SPEC-BE-002 — Conexão OAuth](./specs/SPEC-BE-002-oauth.md) | F3 | — | `MercadoPagoAccount`, OAuth, tokens cifrados |
| [SPEC-BE-003 — Pagamento split](./specs/SPEC-BE-003-pagamento-split.md) | F4 | BE-001, BE-002, BE-005 | `POST /pagamentos` com `application_fee` |
| [SPEC-BE-004 — Assinatura SaaS](./specs/SPEC-BE-004-assinatura-saas.md) | F5 | BE-001, BE-005 | Preapproval, `Assinatura` |
| [SPEC-BE-006 — Reconciliação](./specs/SPEC-BE-006-reconciliacao.md) | F6 | BE-002..005 | Jobs de cron, resiliência |

# PARTE III — PLANEJAMENTO FRONTEND (`saaschurch`)

## 12. Estado atual do frontend

Repo: `/Users/renanzucheratto/Documents/Projetos/brinkstech/saaschurch`
Stack: Next.js 16 (App Router) · React 19 · MUI 7 · RTK Query · next-auth · zod · react-hook-form

```
saaschurch/
├── app/
│   ├── (authenticated)/          # layout com Navbar + Sidebar
│   │   ├── page.tsx              # dashboard
│   │   ├── eventos/ areas/ projetos/ usuarios/
│   │   └── components/           # Navbar, Sidebar, UserSync
│   ├── (public)/
│   │   ├── login/ forgot-password/ reset-password/ set-password/
│   │   └── externo/eventos/[eventoId]/   ◄── checkout entra aqui
│   └── api/auth/[...nextauth]/
├── modules/                      # feature = módulo (index.tsx + hooks/ + components/ ...)
│   ├── dashboard/ eventos/ areas/ projetos/ usuarios/ login/ ...
├── config/
│   ├── redux/
│   │   ├── api/                  # baseApi.ts + <dominio>Api.ts  ◄── RTK Query mora aqui
│   │   ├── slices/authSlice.ts
│   │   └── store.ts
│   ├── theme/overrides/
│   └── helpers/
└── lib/  hooks/  permissions/  useAuth.ts  usePermissions.ts
```

`config/redux/api/baseApi.ts` já implementa `baseQueryWithReauth` (Bearer + refresh 401 + logout federado via `next-auth`). Serviços novos usam `baseApi.injectEndpoints`.

`tagTypes` atuais: `['Eventos', 'Participantes', 'Users', 'Projetos', 'Areas', 'Me', 'Dashboard']`.

## 13. Skills obrigatórias

**Toda página nova de módulo → `/new-module`. Todo domínio novo de API → `/new-rtk-service`.** Não crie a árvore de arquivos à mão nem escreva `createApi` novo.

```
/new-module instituicao/pagamentos
/new-rtk-service payment-connect
```

### 13.1 As skills foram corrigidas ✅

As três skills em `.claude/skills/` do frontend foram copiadas do projeto **Portal Vixtra** e apontavam para caminhos inexistentes neste repositório (`src/modules/<f>/pages/<p>/`, `src/redux/services/`, `src/app/[locale]/`, `ResponseViewModel<T>`, um MCP `next-devtools` não configurado). Já foram reescritas para os paths reais, e os templates que elas carregam foram verificados com `pnpm check-types`.

Junto disso, no repo do frontend:

- **`.claude/CLAUDE.md`** foi criado, consolidando o `.cursorrules` — as skills o citam como fonte das regras.
- **`pnpm check-types`** (`tsc --noEmit`) foi adicionado ao `package.json`. Antes não existia.

**Não há módulo de referência no frontend.** Nenhum módulo atual segue o padrão: não existe um único `styles.tsx`, os hooks usam camelCase (`hooks/useSignIn.ts`), há `schemas/` e `utils/` em vez de `helpers/`, e há `sx` inline por toda parte. Por isso as skills carregam os templates completos inline e mandam explicitamente não copiar a forma dos módulos existentes. `/refactor-module` traz um módulo antigo ao padrão.

As regras (e valem como regra deste plano):

1. `index.tsx` é presentacional puro: só JSX + uma chamada `use<Modulo>()`. Nada de `useState`/`useEffect`/`useMemo`/query/corpo de handler nele.
2. Toda lógica vive em `hooks/use-<modulo>.tsx`, retornada como objeto plano.
3. Toda estilização em `styles.tsx` (hook `useStyles()`), zero `sx={{...}}` literal nos componentes.
4. `helpers/`: um arquivo por função, kebab-case = nome da função, arrow function exportada inline. `helpers/constants.ts` e `helpers/validation.ts` são os únicos com múltiplos exports.
5. `helpers/validation.ts` exporta schema zod **e** o `z.infer`.
6. Serviço novo usa `baseApi.injectEndpoints` — **não** editar `store.ts`, **não** criar `createApi`.
7. Tag nova → adicionar a string em `tagTypes` de `baseApi.ts`.
8. Pasta em `app/` só define rota e importa o módulo. Zero lógica lá.

## 14. Dependências novas do frontend

```bash
pnpm add @mercadopago/sdk-react
```

Nenhuma env nova. A `publicKey` do Brick vem em runtime de `GET /pagamentos/checkout-config/:eventoId` (§9).

## 15. Serviços RTK a criar (`/new-rtk-service`)

Todos em `config/redux/api/`, injetando em `baseApi`. Tags novas a adicionar em `tagTypes`: `'Plano'`, `'Assinatura'`, `'PaymentConnect'`, `'Pagamentos'`.

| Arquivo | Endpoints | Tags |
|---|---|---|
| `planosApi.ts` | `listarPlanos` (Q), `obterMeuPlano` (Q), `atribuirPlano` (M) | provides `Plano`; invalidates `Plano`, `Assinatura` |
| `paymentConnectApi.ts` | `obterStatusConexao` (Q), `iniciarConexao` (M), `desconectarMercadoPago` (M) | provides/invalidates `PaymentConnect` |
| `assinaturaApi.ts` | `obterAssinatura` (Q), `criarAssinatura` (M), `cancelarAssinatura` (M) | provides/invalidates `Assinatura` |
| `pagamentosApi.ts` | `obterCheckoutConfig` (Q), `criarPagamento` (M), `obterPagamento` (Q), `listarPagamentosEvento` (Q) | provides `Pagamentos`; invalidates `Pagamentos`, `Participantes` |

> **`/payment-connect/authorize` não pode ser um `302`.** Uma navegação de browser não carrega o header `Authorization`, o que forçaria mandar o token de auth em query param — vazando-o no histórico e nos logs de acesso. E `fetch` seguiria o redirect até o domínio do MP, quebrando no CORS.
>
> Recomendação, refletida em §10 e nas specs: **`POST /payment-connect/authorize` retorna `{ authorizeUrl }` em JSON**, e o front navega com `window.location.href`. Mantém o `Bearer` e não vaza nada. É a decisão pendente nº 3 de §18.

---

## Índice das specs de frontend

As specs de frontend vivem **no repositório do frontend**: `saaschurch/docs/specs/`. O contexto de estrutura, skills e serviços RTK está replicado no [`README`](../../saaschurch/docs/specs/README.md) de lá, para que uma sessão de implementação do front não precise abrir este arquivo.

| Spec | Fase | Depende de | Entrega |
|---|---|---|---|
| `SPEC-FE-002` — Módulo assinatura | F1 | BE-001, BE-004 | Tela de plano atual, badge de parceiro piloto |
| `SPEC-FE-005` — Backoffice: gestão de planos | F1 | BE-001 | Atribuir/trocar plano de instituições |
| `SPEC-FE-006` — Guard de plano e assinatura | F1 | BE-007 | `usePlano()`, `<FeatureGate>`, erros tipados |
| `SPEC-FE-001` — Conectar Mercado Pago | F3 | BE-002 | Onboarding OAuth da igreja |
| `SPEC-FE-003` — Checkout público de evento | F4 | BE-003 | Payment Brick, cartão e PIX |
| `SPEC-FE-004` — Painel de pagamentos do evento | F4 | BE-003 | Aba de pagamentos com totalizadores |

Frontend e backend de uma mesma fase podem correr em paralelo assim que o contrato da API estiver acordado. Os contratos estão nas specs de backend correspondentes.

---

# PARTE IV — ROADMAP

## 16. Fases

Ordem imposta pelo grafo de dependências (§ Parte II). Backend e frontend de uma mesma fase podem correr em paralelo assim que o contrato da API estiver acordado.

| Fase | Specs | Entrega |
|---|---|---|
| **F0 — Pré-requisitos** | — | ~~Corrigir as skills do front; criar `.claude/CLAUDE.md`~~ ✅ feito (§13.1). Falta: adicionar envs de §9; **confirmar decisão §6.4** |
| **F1 — Planos** | BE-001, BE-007, FE-002, FE-005, FE-006 | Model `Plano`, seed `PILOTO_FREE`, feature gating, telas de assinatura/backoffice. **Entrega o plano gratuito full de ponta a ponta, sem depender do MP.** |
| **F2 — Fundação de pagamento** | BE-005 | Webhook único com HMAC + idempotência + `WebhookLog` |
| **F3 — Conexão OAuth** | BE-002, FE-001 | Igrejas conectam a conta MP; job de refresh |
| **F4 — Pagamentos de evento** | BE-003, FE-003, FE-004 | Split payment com fee; checkout público; painel |
| **F5 — Assinatura SaaS** | BE-004 (+ FE-002 completa) | Preapproval para planos pagos |
| **F6 — Resiliência** | BE-006 | Reconciliação, logs estruturados, métricas |

> **F1 antes de tudo.** Ela entrega o plano gratuito full — o que os parceiros piloto precisam — sem tocar em uma linha de Mercado Pago. Se o piloto rodar com fee 0% (§6.4), a Fase 4 pode esperar.

## 17. Riscos e pontos de atenção

| Risco | Mitigação |
|---|---|
| Igreja revoga o acesso no MP a qualquer momento | Status `REVOKED`, fluxo de reconexão, checkout bloqueado com mensagem clara (SPEC-FE-003 RF-06) |
| Webhook do MP falha ou atrasa | Job de reconciliação é **obrigatório** (SPEC-BE-006). Responder `500` em falha para forçar retry. |
| `application_fee` hardcoded | Sempre de `plano.feeEventoPercentual`; snapshot em `Pagamento`. |
| Igreja desconecta o MP com evento ativo em andamento | **Decisão de produto pendente.** Opções: (a) bloquear novos pagamentos, manter os existentes; (b) impedir a desconexão enquanto houver `Pagamento` `PENDING`. Recomendação: (a) + aviso no diálogo de desconexão. |
| Plano gratuito tratado como `if` especial | RN-02 + item de "pronto" com grep em BE-007 e FE-006. |
| Precisão decimal em dinheiro | `Decimal` ponta a ponta; `parseFloat` proibido no caminho de dinheiro; API serializa `Decimal` como **string**, front nunca faz `Number()` antes de formatar. |
| `relationMode = "prisma"` sem FK | Vazamento entre tenants não é barrado pelo banco. Filtro por `instituicaoId` em toda query é a única defesa. |
| Vercel Cron (Hobby) não roda a cada 30 min | Verificar plano antes da F6; alternativa é agendador externo. |
| `redirect_uri` divergente no painel do MP | Causa `invalid_client`. Conferir byte a byte, incluindo barra final. |
| Skills do front geram código fora do padrão | Resolvido: skills reescritas para os paths reais e templates validados com `pnpm check-types` (§13.1). |
| Código novo copia a forma dos módulos antigos, que estão fora do padrão | As skills mandam explicitamente não usá-los como referência e carregam os templates inline. |

## 18. Decisões pendentes (bloqueiam implementação)

1. **§6.4 — Fee de evento para `PILOTO_FREE`: 0% ou o percentual padrão?** Bloqueia o seed de BE-001.
2. **§17 — Desconexão do MP com evento ativo:** bloquear a desconexão ou apenas os novos pagamentos? Bloqueia BE-002 RF-04.
3. **§15 — `/payment-connect/authorize`: `302` com token em query, ou `POST` retornando `{ authorizeUrl }`?** Recomendação: `POST`. Bloqueia BE-002 RF-01 e FE-001 RF-02.
4. **Planos pagos:** quantos, quais nomes, valores e limites? Bloqueia o seed de BE-001 (o `PILOTO_FREE` não depende disso).
