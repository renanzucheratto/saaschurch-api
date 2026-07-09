# Specs — Camada de Pagamentos (backend)

Specs de implementação do `saaschurch-api`. Contexto, arquitetura, modelagem completa e roadmap estão no [planejamento](../PLANEJAMENTO-PAGAMENTOS.md).

As specs de frontend vivem no outro repositório: `saaschurch/docs/specs/`.

## Índice

| Spec | Fase | Depende de | Entrega |
|---|---|---|---|
| [SPEC-BE-001 — Planos e elegibilidade](./SPEC-BE-001-planos.md) | F1 | — | Model `Plano`, seed `PILOTO_FREE`, `calcularFee`, rotas `/planos` |
| [SPEC-BE-007 — Feature gating](./SPEC-BE-007-feature-gating.md) | F1 | BE-001 | `requireFeature` / `requireLimite` / `requireAssinaturaAtiva` |
| [SPEC-BE-005 — Webhook único](./SPEC-BE-005-webhook.md) | F2 | — | `POST /webhooks/mercadopago`, HMAC, idempotência |
| [SPEC-BE-002 — Conexão OAuth](./SPEC-BE-002-oauth.md) | F3 | — | `MercadoPagoAccount`, OAuth, tokens cifrados |
| [SPEC-BE-003 — Pagamento split](./SPEC-BE-003-pagamento-split.md) | F4 | BE-001, BE-002, BE-005 | `POST /pagamentos` com `application_fee` |
| [SPEC-BE-004 — Assinatura SaaS](./SPEC-BE-004-assinatura-saas.md) | F5 | BE-001, BE-005 | Preapproval, `Assinatura` |
| [SPEC-BE-006 — Reconciliação](./SPEC-BE-006-reconciliacao.md) | F6 | BE-002..005 | Jobs de cron, resiliência |

## Grafo de dependências

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
```

## Ordem de implementação

**F1 antes de tudo.** BE-001 + BE-007 entregam o plano gratuito full para parceiros piloto de ponta a ponta, sem tocar em uma linha de Mercado Pago. Se o piloto rodar com fee 0%, a fase de pagamentos pode esperar.

Depois: BE-005 (webhook) → BE-002 (OAuth) → BE-003 (split) → BE-004 (assinatura) → BE-006 (resiliência).

O webhook vem antes do OAuth e do pagamento porque as duas specs seguintes dependem dele para confirmar estado, e porque ele é a superfície mais exposta — vale endurecer cedo.

## Decisões pendentes

Estas bloqueiam o início das specs indicadas:

1. **Fee de evento para `PILOTO_FREE`: 0% ou o percentual padrão?** → bloqueia o seed de BE-001.
2. **Quais planos pagos existem (nomes, valores, limites)?** → bloqueia o seed de BE-001. O `PILOTO_FREE` não depende disso.
3. **`/payment-connect/authorize`: `302` com token em query, ou `POST` retornando `{ authorizeUrl }`?** Recomendação: `POST`. → bloqueia BE-002 RF-01 e `SPEC-FE-001` RF-02.
4. **Igreja desconecta o MP com evento ativo: bloquear a desconexão, ou só os novos pagamentos?** Recomendação: só os novos, com aviso no diálogo. → bloqueia BE-002 RF-04.
5. **Plano da Vercel permite cron a cada 30 min?** No Hobby o limite é 1×/dia. → bloqueia BE-006.

## Invariantes que atravessam todas as specs

- **Isolamento multi-tenant.** `schema.prisma` usa `relationMode = "prisma"` — não há foreign keys no banco. O filtro por `instituicaoId` em toda query é a **única** barreira contra vazamento entre igrejas.
- **Dinheiro é `Decimal`.** Nunca `number`, nunca `parseFloat` no caminho de dinheiro. A API serializa `Decimal` como **string**.
- **Dois tokens, dois fluxos.** `MERCADO_PAGO_ACCESS_TOKEN` é da plataforma e serve à assinatura SaaS. O `accessToken` de `MercadoPagoAccount` é da igreja e serve ao split payment. Trocá-los manda o dinheiro para a conta errada.
- **O gate pergunta pela feature, não pelo plano.** Zero `if (plano.codigo === 'PILOTO_FREE')` no código.
- **Webhook nunca decide pelo payload.** Sempre reconsulta a API do MP.
