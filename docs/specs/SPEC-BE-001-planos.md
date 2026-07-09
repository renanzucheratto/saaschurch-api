# SPEC-BE-001 — Planos e elegibilidade

| | |
|---|---|
| **Repo** | `saaschurch-api` |
| **Fase** | F1 |
| **Depende de** | — (raiz do grafo) |
| **Habilita** | [SPEC-BE-003](./SPEC-BE-003-pagamento-split.md), [SPEC-BE-004](./SPEC-BE-004-assinatura-saas.md), [SPEC-BE-007](./SPEC-BE-007-feature-gating.md), `SPEC-FE-002`, `SPEC-FE-005` |
| **Bloqueada por** | Decisão pendente §6.4 do [planejamento](../PLANEJAMENTO-PAGAMENTOS.md) |

---

## Contexto

Não existe model `Plano` no `schema.prisma`. Todo o resto da camada de pagamentos — fee de evento, feature gating, assinatura SaaS e o plano gratuito de parceiro piloto — depende dele. É a primeira spec a implementar.

Esta spec entrega o **plano gratuito full para parceiros piloto de ponta a ponta, sem tocar em uma linha de Mercado Pago**.

## Requisitos funcionais

| ID | Requisito |
|---|---|
| RF-01 | Sistema mantém catálogo de planos com fee, limites e features. |
| RF-02 | Instituição tem exatamente um plano; `planoId = null` resolve para `PLANO_PADRAO_CODIGO`. |
| RF-03 | Seed cria `PILOTO_FREE` (gratuito full) + ao menos um plano pago. |
| RF-04 | Backoffice atribui/troca plano de qualquer instituição. |
| RF-05 | Instituição consulta o próprio plano com features e limites resolvidos. |

## Regras de negócio

| ID | Regra |
|---|---|
| RN-01 | Se `plano.cobrancaSaaS == false`, o sistema **nunca** cria `Assinatura`, **nunca** chama a Preapproval API e **nunca** bloqueia features por status de assinatura. |
| RN-02 | Toda checagem de feature consulta `plano.features`, **nunca** `instituicao.parceiroPiloto` nem `plano.codigo`. A flag `parceiroPiloto` é só auditoria/exibição. |
| RN-03 | O fee de evento vem **sempre** de `plano.feeEventoPercentual`, independentemente de o plano ser gratuito. Plano gratuito não implica fee zero — são eixos ortogonais. |
| RN-04 | `instituicao.planoId == null` resolve para o plano padrão do sistema, configurável por `PLANO_PADRAO_CODIGO`. |
| RN-05 | Atribuir/trocar plano é ação restrita a `userType == 'backoffice'`. Não há self-service de upgrade nesta fase. |
| RN-06 | Toda troca de plano registra `planoAtribuidoEm` + `planoAtribuidoPor`. |
| RN-07 | Migrar de plano gratuito → pago exige criar `Assinatura` e só entra em vigor com `status == AUTHORIZED`. Até lá a instituição permanece no plano anterior. |
| RN-08 | Migrar de plano pago → gratuito cancela a `Assinatura` ativa no MP e grava `motivoCancelamento`. |

> **RN-01 e RN-02 juntas são o coração da feature.** Se o gating perguntar "é piloto?" em vez de "tem a feature?", cada plano novo vai exigir tocar em `if`s espalhados. O gate pergunta pelo plano; o plano responde pela feature.

## Modelagem

### `Plano` (novo)

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
  features            Json     @default("{}")

  ativo               Boolean  @default(true)
  ordem               Int      @default(0)

  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt
  instituicoes        Instituicao[]
  assinaturas         Assinatura[]

  @@index([codigo])
  @@map("planos")
}
```

`features` é `Json` e não colunas booleanas: features novas não exigem migration. O custo é perda de type-safety — mitigado por `PlanoFeatures` em `src/types/plano.types.ts` e o helper `temFeature(plano, 'pagamentosOnline')`.

### Alteração em `Instituicao`

```prisma
model Instituicao {
  // ... campos existentes ...
  planoId              String?
  plano                Plano?    @relation(fields: [planoId], references: [id])
  parceiroPiloto       Boolean   @default(false)  // flag informativa/auditoria
  planoAtribuidoEm     DateTime?
  planoAtribuidoPor    String?                    // email do backoffice

  @@index([planoId])
}
```

`planoId` é opcional para não quebrar as instituições existentes na migration. `plano.service` trata `null` como plano padrão (RN-04), o que torna a migration de dados trivial.

### Seed — `PILOTO_FREE`

```ts
{
  codigo: 'PILOTO_FREE',
  nome: 'Parceiro Piloto',
  descricao: 'Acesso completo, sem cobrança de assinatura. Concedido a parceiros do programa piloto.',
  cobrancaSaaS: false,
  valorMensal: 0,
  valorAnual: 0,
  mpPreapprovalPlanId: null,
  feeEventoPercentual: 0,      // ⚠ DECISÃO PENDENTE — ver abaixo
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

O seed deve ser **idempotente** (`upsert` por `codigo`) — roda em toda migration deploy.

## Decisão pendente (bloqueia o seed)

**O parceiro piloto paga fee sobre eventos?** O schema suporta as duas respostas sem alteração, porque `feeEventoPercentual` é campo do plano. O seed acima assume `0`.

- **`0%`** — piloto 100% gratuito, plataforma não retém nada. Simples de comunicar; receita zero na fase piloto.
- **`X%`** (mesmo dos planos pagos) — assinatura gratuita, mas transação gera receita. Recomendado se o piloto tiver eventos de volume relevante.

Também pendente: **quantos planos pagos existem, com quais nomes, valores e limites.** O `PILOTO_FREE` não depende disso — a spec pode ser implementada e o plano pago seedado depois.

## Contrato

```http
GET /planos/meu                          # autenticado
200 OK
{
  "plano": {
    "codigo": "PILOTO_FREE",
    "nome": "Parceiro Piloto",
    "cobrancaSaaS": false,
    "feeEventoPercentual": "0.00",
    "features": { "pagamentosOnline": true, "relatorios": true },
    "limites": { "eventosAtivos": null, "usuarios": null }
  },
  "uso": { "eventosAtivos": 12, "usuarios": 40 },
  "assinatura": null,
  "parceiroPiloto": true
}
```

```http
GET /planos                              # autenticado — lista planos ativos
200 OK { "planos": [ { "codigo": "...", "nome": "...", "valorMensal": "99.00", ... } ] }
```

```http
PATCH /planos/instituicao/:instituicaoId  # backoffice
{ "planoCodigo": "PRO", "motivo": "Fim do período piloto" }

200 OK  { "plano": { ... }, "assinaturaNecessaria": true, "initPoint": "https://..." }
403     { "error": "Acesso negado..." }      # não-backoffice
409     { "error": "PLANO_INATIVO" }
```

Valores `Decimal` são serializados como **string**, nunca `number` — precisão decimal em dinheiro.

## Critérios de aceite

```gherkin
Cenário: Instituição sem plano resolve para o padrão
  Dado uma Instituicao com planoId = null
  E PLANO_PADRAO_CODIGO = "PILOTO_FREE"
  Quando GET /planos/meu
  Então o plano retornado tem codigo "PILOTO_FREE"
  E cobrancaSaaS é false

Cenário: Plano gratuito nunca gera assinatura
  Dado uma Instituicao no plano PILOTO_FREE
  Quando POST /billing/assinaturas para essa instituição
  Então retorna 409 com erro "PLANO_SEM_COBRANCA"
  E nenhuma chamada é feita à Preapproval API do MP
  E nenhum registro é criado em Assinatura

Cenário: Gating pergunta pela feature, não pelo código do plano
  Dado um Plano "X" com features.pagamentosOnline = false
  E uma Instituicao nesse plano
  Quando POST /pagamentos
  Então retorna 403 com erro "FEATURE_INDISPONIVEL"

Cenário: Troca para plano pago só vigora após autorização
  Dado uma Instituicao no plano PILOTO_FREE
  Quando backoffice faz PATCH para o plano "PRO"
  Então uma Assinatura é criada com status PENDING
  E instituicao.planoId ainda aponta para PILOTO_FREE
  Quando o webhook confirma preapproval authorized
  Então instituicao.planoId passa a apontar para PRO

Cenário: Troca de plano é auditada
  Quando backoffice troca o plano de uma instituição
  Então planoAtribuidoEm recebe o timestamp
  E planoAtribuidoPor recebe o email do backoffice

Cenário: Não-backoffice não troca plano
  Dado um usuário com userType "lider"
  Quando PATCH /planos/instituicao/:id
  Então retorna 403

Cenário: Seed é idempotente
  Quando o seed roda duas vezes
  Então existe exatamente um Plano com codigo "PILOTO_FREE"
```

### Bordas de `calcularFee`

```gherkin
Cenário: Fee percentual simples
  Dado feeEventoPercentual = 3.50 e bruto = 200.00
  Então fee = 7.00

Cenário: Piso é aplicado
  Dado feeEventoPercentual = 1, feeEventoMinimo = 2.00, bruto = 50.00
  Então fee = 2.00

Cenário: Teto é aplicado
  Dado feeEventoPercentual = 1, feeEventoMaximo = 10.00, bruto = 5000.00
  Então fee = 10.00

Cenário: Teto null é sem teto
  Dado feeEventoMaximo = null, feeEventoPercentual = 10, bruto = 10000.00
  Então fee = 1000.00

Cenário: Arredondamento é ROUND_HALF_UP em 2 casas
  Dado um fee calculado de 7.005
  Então fee = 7.01

Cenário: Fee nunca excede o bruto
  Dado qualquer configuração de plano
  Então 0 <= fee < bruto
```

## Definição de pronto

- [ ] Migration `Plano` + `Instituicao.planoId/parceiroPiloto/planoAtribuidoEm/planoAtribuidoPor`
- [ ] Seed idempotente de `PILOTO_FREE` + planos pagos
- [ ] `src/services/plano.service.ts` com `resolverPlano(instituicaoId)`, `temFeature(plano, f)`, `calcularFee(plano, bruto)`
- [ ] `src/types/plano.types.ts` com `PlanoFeatures`
- [ ] `src/routes/planos.ts` registrada em `src/server.ts`
- [ ] `calcularFee` coberto pelas bordas acima, em `Decimal` — zero `parseFloat`
- [ ] `Decimal` serializado como string na resposta HTTP
- [ ] Toda query filtra por `instituicaoId` (não há FK protegendo — `relationMode = "prisma"`)
- [ ] **Decisão de fee confirmada** antes de rodar o seed
