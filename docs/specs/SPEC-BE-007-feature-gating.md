# SPEC-BE-007 — Feature gating por plano

| | |
|---|---|
| **Repo** | `saaschurch-api` |
| **Fase** | F1 |
| **Depende de** | [SPEC-BE-001](./SPEC-BE-001-planos.md) |
| **Habilita** | `SPEC-FE-006` |

---

## Contexto

O gate decide se uma instituição pode usar uma rota, com base no seu plano. Três eixos independentes:

1. **Feature** — `plano.features.pagamentosOnline` está ligada?
2. **Limite** — a instituição já tem 5 de 5 eventos ativos?
3. **Assinatura** — a assinatura está ativa? (**no-op em plano gratuito**)

> **RN-02 é a regra que sustenta o plano gratuito.** O gate pergunta `plano.features.x`, **nunca** `plano.codigo === 'PILOTO_FREE'` nem `instituicao.parceiroPiloto`. Se o gate perguntar "é piloto?", cada plano novo vai exigir tocar em `if`s espalhados pelo código. O gate pergunta pelo plano; o plano responde pela feature.

## Requisitos funcionais

| ID | Requisito |
|---|---|
| RF-01 | `requireFeature(f)` bloqueia rota quando `plano.features[f] != true`. |
| RF-02 | `requireLimite(l)` bloqueia quando o uso atual atinge o limite do plano. |
| RF-03 | `requireAssinaturaAtiva()` bloqueia quando a assinatura está `PAUSED`/`CANCELLED`. |
| RF-04 | `requireAssinaturaAtiva()` é **no-op** quando `plano.cobrancaSaaS == false`. |
| RF-05 | Limite `null` significa ilimitado. |
| RF-06 | Erros são **tipados** — o frontend depende do código, não da mensagem. |

## Interface

`src/middleware/require-plano.middleware.ts`:

```ts
// router.post('/pagamentos', authenticateUser, requireFeature('pagamentosOnline'), handler)
export function requireFeature(feature: keyof PlanoFeatures): RequestHandler;

// router.post('/eventos', authenticateUser, requireLimite('eventosAtivos'), handler)
export function requireLimite(limite: 'eventosAtivos' | 'usuarios'): RequestHandler;

// No-op quando plano.cobrancaSaaS == false (RN-01)
export function requireAssinaturaAtiva(): RequestHandler;
```

`src/types/plano.types.ts`:

```ts
export interface PlanoFeatures {
  pagamentosOnline: boolean;
  relatorios: boolean;
  projetos: boolean;
  areas: boolean;
  camposCustomizados: boolean;
  exportacao: boolean;
}
```

O middleware resolve o plano por `req.user.instituicaoId` via `plano.service.resolverPlano()`.

## Erros tipados

O contrato de erro é consumido diretamente pelo frontend (`SPEC-FE-006`). Mudar estes códigos quebra a UI.

```http
403 { "error": "FEATURE_INDISPONIVEL", "feature": "pagamentosOnline" }
403 { "error": "LIMITE_ATINGIDO", "limite": "eventosAtivos", "max": 5, "atual": 5 }
402 { "error": "ASSINATURA_INATIVA", "status": "PAUSED" }
```

`402 Payment Required` para assinatura inativa, `403 Forbidden` para feature e limite — a distinção importa porque o frontend trata os dois casos com telas diferentes.

## Aplicação nas rotas

| Rota | Gate |
|---|---|
| `POST /pagamentos` | `requireFeature('pagamentosOnline')` |
| `GET /pagamentos/checkout-config/:eventoId` | `requireFeature('pagamentosOnline')` |
| `POST /eventos` | `requireLimite('eventosAtivos')` |
| `POST /users` | `requireLimite('usuarios')` |
| `POST /projetos` | `requireFeature('projetos')` |

`requireAssinaturaAtiva()` entra nas rotas de escrita quando [SPEC-BE-004](./SPEC-BE-004-assinatura-saas.md) estiver pronta.

## Critérios de aceite

```gherkin
Cenário: Feature liberada passa
  Dado plano com features.pagamentosOnline = true
  Quando rota com requireFeature('pagamentosOnline')
  Então prossegue

Cenário: Feature bloqueada retorna 403 tipado
  Dado plano com features.pagamentosOnline = false
  Então retorna 403 { "error": "FEATURE_INDISPONIVEL", "feature": "pagamentosOnline" }

Cenário: Feature ausente do JSON é tratada como false
  Dado plano.features sem a chave "exportacao"
  Quando rota com requireFeature('exportacao')
  Então retorna 403 FEATURE_INDISPONIVEL

Cenário: Limite atingido retorna 403 tipado
  Dado plano com limiteEventosAtivos = 5 e a instituição já tem 5 eventos ativos
  Quando POST /eventos
  Então retorna 403 { "error": "LIMITE_ATINGIDO", "limite": "eventosAtivos", "max": 5, "atual": 5 }

Cenário: Limite null é ilimitado
  Dado plano com limiteEventosAtivos = null e 500 eventos ativos
  Então POST /eventos prossegue

Cenário: Gate de assinatura é no-op em plano gratuito
  Dado plano com cobrancaSaaS = false e nenhuma Assinatura
  Quando rota com requireAssinaturaAtiva()
  Então prossegue

Cenário: Assinatura inativa retorna 402
  Dado plano pago com Assinatura PAUSED
  Então retorna 402 { "error": "ASSINATURA_INATIVA", "status": "PAUSED" }

Cenário: Instituição sem plano usa o padrão
  Dado instituicao.planoId = null e PLANO_PADRAO_CODIGO = "PILOTO_FREE"
  Então o gate avalia as features de PILOTO_FREE

Cenário: Contagem de limite é isolada por tenant
  Dado a instituição A com 5 eventos e a B com 0
  Então o gate da B não conta os eventos da A
```

## Definição de pronto

- [ ] `src/middleware/require-plano.middleware.ts` com os três middlewares
- [ ] `src/types/plano.types.ts` com `PlanoFeatures`
- [ ] Erros tipados exatamente como no contrato acima
- [ ] Gates aplicados nas rotas da tabela
- [ ] Contagem de limite filtra por `instituicaoId` (não há FK — `relationMode = "prisma"`)
- [ ] `grep -rn "PILOTO_FREE\|parceiroPiloto" src/middleware/ src/routes/` não retorna nada (RN-02)
- [ ] Feature ausente do JSON tratada como `false`, não como erro
