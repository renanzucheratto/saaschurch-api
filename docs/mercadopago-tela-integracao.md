# Tela de integração Mercado Pago — plano + runbook de teste local

> Complementa [`mercadopago-planos-split.md`](./mercadopago-planos-split.md). Aquele cobre a API; este cobre a **tela** onde a instituição conecta a própria conta, e como testar tudo na máquina local.
>
> O código descrito aqui vive no repositório **`saaschurch`** (front), não neste. Ambos já estão na branch `feat/integracao-mp`.

## Context

A API já expõe todo o fluxo OAuth, mas hoje não há como acioná-lo pela interface — só por `curl`. Sem tela, a instituição não consegue conectar a conta, e sem conta conectada o checkout responde `409` e nada de split acontece.

O objetivo é uma tela em **Configurações → Pagamentos** que mostre o estado da conexão, dispare a autorização, trate o retorno e permita desvincular. É a peça que falta para o teste ponta a ponta.

### Stack do front (já existente)

| Item | Como é |
|---|---|
| Framework | Next.js 16, App Router |
| UI | MUI 7 + `@iconify/react` |
| Estado/API | RTK Query — `baseApi` em `config/redux/api/baseApi.ts` |
| Auth | Bearer do `authSlice` (Redux), injetado no `prepareHeaders`; refresh automático no 401 |
| Base URL | `process.env.NEXT_PUBLIC_BASE_URL` |
| Organização | páginas em `app/(authenticated)/<rota>/page.tsx`, componentes em `modules/<nome>/components/` |
| Menu | `menuSections` em `app/(authenticated)/components/Sidebar.tsx`, com `allowedRoles` por item |

---

## Contrato: o que a API já entrega

Tudo abaixo já está implementado e respondendo.

| Método | Rota | Auth | Retorno |
|---|---|---|---|
| `GET` | `/mercadopago/status` | Bearer | `{ conectado, mpUserId, status, expiraEm, refreshExpiraEm, ultimoRefreshEm, ultimoErro, conectadoEm }` — ou `{ conectado: false }`. **Estado local**: não chama o MP |
| `GET` | `/mercadopago/verificar` | Bearer | `{ conectado, contaDivergente, mpUserId, apelido, email, siteId, podeReceber, restricoesRecebimento[], emailConfirmado, termosAceitos, acaoNecessaria }`. **Chama o MP de verdade** (`GET /users/me`); `503` se o MP estiver fora |
| `GET` | `/mercadopago/oauth/connect` | Bearer + **backoffice** | `{ authorizationUrl, expiraEm }` |
| `GET` | `/mercadopago/oauth/callback` | **pública** | `302` → `${FRONTEND_URL}/configuracoes/pagamentos?status=ok\|erro&motivo=...` |
| `DELETE` | `/mercadopago/conta` | Bearer + **backoffice** | `{ message }` |
| `GET` | `/planos/meu` | Bearer | `{ plano, planoAtribuidoEm, split: { percentual, minimo, maximo, origem } }` |
| `GET` | `/planos/disponiveis` | Bearer | `{ planoAtualId, planos[] }` com `atual`, `selecionavel`, `motivoIndisponivel` |
| `PUT` | `/planos/meu` | Bearer + **backoffice** | `{ planoId }` → troca o plano da própria instituição |
| `GET` | `/mercadopago/pagamentos` | Bearer | `{ total, pagina, porPagina, pagamentos[] }` |

`status` da conta assume `PENDING` · `ACTIVE` · `EXPIRED` · `REVOKED`.

Motivos possíveis no retorno do callback: `autorizacao_recusada`, `parametros_ausentes`, `state_invalido`, `falha_troca_token`.

### O ponto que define o desenho da tela

O callback do OAuth é um **redirect de browser direto para a API**. O browser não carrega o Bearer do Redux nessa navegação — por isso a rota é pública e identifica a instituição pelo `state` (nonce em `oauth_nonces`, TTL de 10 min, uso único), não pela sessão.

Consequência prática: **a tela não recebe dado nenhum do callback além de `status` e `motivo` na query string.** Depois de voltar, ela precisa refazer `GET /mercadopago/status` para saber o que aconteceu de fato. Não dá para confiar só no `?status=ok`.

---

## Arquivos a criar no repo `saaschurch`

| Arquivo | Conteúdo |
|---|---|
| `types/mercadopago.types.ts` | `MercadoPagoStatus`, `ContaMercadoPago`, `RegraSplit`, `PlanoAtual` |
| `config/redux/api/mercadopagoApi.ts` | `baseApi.injectEndpoints` — `useStatusMercadoPagoQuery`, `useConectarMercadoPagoMutation`, `useDesvincularMercadoPagoMutation`, `usePlanoAtualQuery` |
| `app/(authenticated)/configuracoes/pagamentos/page.tsx` | Rota da tela |
| `modules/pagamentos/components/ConexaoMercadoPago.tsx` | Card principal: estado + ações |
| `modules/pagamentos/components/StatusConexaoChip.tsx` | Chip de status com cor por estado |
| `modules/pagamentos/components/ResumoSplit.tsx` | Mostra a taxa efetiva e de onde ela vem |
| `modules/pagamentos/components/DesvincularDialog.tsx` | Confirmação da desvinculação |

Alterações em arquivos existentes:

- `config/redux/api/baseApi.ts` — acrescentar `'MercadoPago'` e `'Plano'` em `tagTypes`.
- `app/(authenticated)/components/Sidebar.tsx` — item de menu novo:
  ```tsx
  {
    title: "CONFIGURAÇÕES",
    items: [
      { id: "pagamentos", label: "Pagamentos",
        icon: <IconifyIcon icon="material-symbols:credit-card-outline" width={20} />,
        href: "/configuracoes/pagamentos",
        allowedRoles: ["backoffice"] },
    ],
  }
  ```

### API slice

```ts
export const mercadopagoApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    statusMercadoPago: builder.query<ContaMercadoPago, void>({
      query: () => '/mercadopago/status',
      providesTags: ['MercadoPago'],
    }),
    // Mutation, não query: dispara efeito (grava nonce) e não deve ser cacheado
    // nem refeito automaticamente — cada clique precisa de um nonce novo.
    conectarMercadoPago: builder.mutation<{ authorizationUrl: string }, void>({
      query: () => ({ url: '/mercadopago/oauth/connect', method: 'GET' }),
    }),
    desvincularMercadoPago: builder.mutation<{ message: string }, void>({
      query: () => ({ url: '/mercadopago/conta', method: 'DELETE' }),
      invalidatesTags: ['MercadoPago'],
    }),
    planoAtual: builder.query<PlanoAtual, void>({
      query: () => '/planos/meu',
      providesTags: ['Plano'],
    }),
  }),
});
```

`conectarMercadoPago` é **mutation apesar de ser GET**: cada chamada grava um `OAuthNonce` novo no banco. Como query, o RTK Query cacharia o resultado e reusaria uma `authorizationUrl` cujo nonce pode já ter sido consumido ou expirado.

### Fluxo da tela

```
1. monta  -> useStatusMercadoPagoQuery() + usePlanoAtualQuery()
2. clica "Conectar"
   -> conectarMercadoPago().unwrap()
   -> window.location.href = authorizationUrl     (navegação, não popup)
3. usuário autoriza no Mercado Pago
4. MP -> API /mercadopago/oauth/callback -> 302 -> /configuracoes/pagamentos?status=ok
5. tela lê searchParams, refetch() do status, mostra o resultado,
   e limpa a query string com router.replace()
```

Passo 5 em detalhe:

```tsx
const searchParams = useSearchParams();
const router = useRouter();
const { data: conta, refetch } = useStatusMercadoPagoQuery();

useEffect(() => {
  const status = searchParams.get('status');
  if (!status) return;

  // O ?status=ok diz apenas que o callback não estourou. A verdade está no
  // banco — refetch antes de declarar sucesso na interface.
  refetch();

  setAviso(
    status === 'ok'
      ? { tipo: 'success', texto: 'Conta Mercado Pago conectada.' }
      : { tipo: 'error', texto: MENSAGENS_ERRO[searchParams.get('motivo') ?? ''] ?? 'Não foi possível conectar.' },
  );

  // Sem isso, um F5 reexibe o aviso indefinidamente.
  router.replace('/configuracoes/pagamentos');
}, [searchParams]);
```

Mensagens por motivo:

| `motivo` | Texto na tela |
|---|---|
| `autorizacao_recusada` | "Você cancelou a autorização no Mercado Pago." |
| `state_invalido` | "A solicitação expirou. Clique em Conectar novamente." |
| `parametros_ausentes` | "Retorno inválido do Mercado Pago. Tente novamente." |
| `falha_troca_token` | "Não foi possível concluir a conexão. Tente novamente ou contate o suporte." |

### Estados do card

| `status` | Visual | Ação disponível |
|---|---|---|
| sem conta (`conectado: false`) | Cinza, "Não conectado" | **Conectar Mercado Pago** |
| `ACTIVE` | Verde, mostra `mpUserId` e data de conexão | **Desvincular** |
| `EXPIRED` | Laranja, exibe `ultimoErro` | **Reconectar** |
| `REVOKED` | Cinza, "Desvinculada" | **Conectar novamente** |
| `PENDING` | Azul, "Conexão incompleta" | **Concluir conexão** |

`EXPIRED` merece destaque: significa que o refresh falhou e **o checkout está fora do ar para aquela instituição**. Não pode ser um chip discreto — vale um `Alert severity="warning"` com a ação de reconectar.

### Resumo do split

`GET /planos/meu` devolve `split.origem` por campo (`'plano' | 'instituicao'`). A tela mostra a taxa efetiva e marca o que é herdado:

```
Taxa da plataforma
  3,5% por inscrição paga          [herdado do plano Gratuito]
  Mínimo: R$ 0,00                  [herdado do plano Gratuito]
```

Read-only para a instituição — quem edita é o backoffice, por `PUT /planos/instituicoes/:id/split`. Mostrar a taxa é importante para transparência; deixar editável seria deixar o cliente escolher a própria comissão.

---

## Runbook de teste local

### Conflito de portas

A API tem `app.listen(3000)` fixo em `src/server.ts:34`, e o `next dev` também usa 3000 por padrão. **Subir o front em outra porta.**

| Processo | Porta |
|---|---|
| API (`saaschurch-api`) | 3000 |
| Front (`saaschurch`) | 3001 — `next dev -p 3001` |
| cloudflared | aponta para **3000** (a API), nunca para o front |

O túnel expõe só a API porque só ela precisa ser alcançável de fora: o Mercado Pago acessa o `redirect_uri` e o webhook. O redirect final para o front é feito **pelo browser**, que é local — por isso `FRONTEND_URL` pode ser `localhost`.

### Passo a passo

**1. Túnel**

```bash
cloudflared tunnel --url http://localhost:3000
```

Anotar a URL (`https://<algo>.trycloudflare.com`). Ela muda a cada restart do túnel.

**2. `.env` da API** (`saaschurch-api`)

```bash
API_URL="https://<tunel>.trycloudflare.com"
FRONTEND_URL="http://localhost:3001"
MERCADO_PAGO_REDIRECT_URI="https://<tunel>.trycloudflare.com/mercadopago/oauth/callback"
MP_TOKEN_ENCRYPTION_KEY="<openssl rand -base64 32>"
```

⚠️ Conferidos no `.env` atual e **ainda pendentes**:
- `MP_TOKEN_ENCRYPTION_KEY` tem 48 bytes; o AES-256 exige 32. Do jeito que está, o OAuth quebra na hora de cifrar o token. Regerar é seguro — `mercado_pago_accounts` está vazia.
- `MERCADO_PAGO_REDIRECT_URI` aponta para `app.igrejaformosadecristo.com`, que é o **front**. O callback é rota da **API**.
- `API_URL` está em `localhost:3000`, inalcançável pelo Mercado Pago.

**3. `.env` do front** (`saaschurch`)

```bash
NEXT_PUBLIC_BASE_URL="http://localhost:3000"   # a API
NEXTAUTH_URL="http://localhost:3001"           # o próprio front
NEXT_PUBLIC_APP_URL="http://localhost:3001"
```

`NEXT_PUBLIC_BASE_URL` pode apontar direto para a API local: quem faz essas chamadas é o browser, que enxerga `localhost`. Usar a URL do túnel aqui também funciona, mas adiciona latência desnecessária em cada request XHR.

⚠️ **`NEXTAUTH_URL` e `NEXT_PUBLIC_APP_URL` precisam acompanhar a troca de porta.** Ambas já existem no `.env` do front apontando para a porta padrão. Rodar em 3001 sem atualizá-las quebra o callback do NextAuth — e o sintoma (login falhando) não parece ter relação com Mercado Pago, o que custa tempo de depuração.

**4. Painel do Mercado Pago**

- Redirect URI: `https://<tunel>.trycloudflare.com/mercadopago/oauth/callback`
- Webhook: `https://<tunel>.trycloudflare.com/webhooks/mercadopago`, tópicos `payment` e `mp-connect`

**5. Subir**

```bash
# terminal 1
cd saaschurch-api && pnpm dev

# terminal 2
cd saaschurch && pnpm dev -p 3001

# terminal 3
cloudflared tunnel --url http://localhost:3000
```

**6. Testar**

1. Login no front com usuário **backoffice** (o item de menu e o endpoint exigem esse papel).
2. Configurações → Pagamentos → **Conectar Mercado Pago**.
3. Passar pelo interstitial (não há com Cloudflare Tunnel).
4. **Janela anônima** para logar com o *seller* de teste — com a sessão pessoal aberta, o OAuth vincula a sua conta real em vez da de teste.
5. Autorizar → volta em `/configuracoes/pagamentos?status=ok`.
6. Card deve exibir **Conectado** com o `mpUserId` do seller de teste.

**7. Conferir no banco**

```sql
SELECT "instituicaoId", "mpUserId", status, "expiresAt",
       length("accessTokenEnc") AS tam_cifrado
FROM mercado_pago_accounts;
```

`tam_cifrado` preenchido e o valor ilegível confirmam a cifragem. **Nunca** dar `SELECT` no conteúdo do token para "conferir".

### Casos de erro a exercitar

| Cenário | Como provocar | Esperado |
|---|---|---|
| Usuário recusa | Clicar "Cancelar" no MP | `?status=erro&motivo=autorizacao_recusada` |
| Nonce expirado | Esperar 10 min na tela do MP | `motivo=state_invalido` |
| Nonce reusado | Repetir a URL de callback | `motivo=state_invalido` |
| Não-backoffice | Logar como `lider` | Menu oculto; endpoint responde 403 |
| Desvincular | Botão Desvincular | Status vira `REVOKED`, campos cifrados zerados |
| Reconectar depois de revogar | Conectar de novo | `upsert` reativa para `ACTIVE` |

---

## Ordem de execução

1. `types/mercadopago.types.ts` + `tagTypes` no `baseApi`
2. `config/redux/api/mercadopagoApi.ts`
3. `StatusConexaoChip` e `ResumoSplit` (componentes puros, testáveis isolados)
4. `ConexaoMercadoPago` + `DesvincularDialog`
5. `app/(authenticated)/configuracoes/pagamentos/page.tsx`
6. Item no `Sidebar`
7. Runbook acima, ponta a ponta

Passos 1–6 são independentes da configuração do painel MP — dá para construir e ver a tela em estado "não conectado" antes de mexer em túnel ou credencial.

---

## Tela de planos — IMPLEMENTADA

Entregue junto com este documento. `/configuracoes/planos`, item **CONFIGURAÇÕES → Planos** no menu, visível para `backoffice`.

**API** (`saaschurch-api/src/routes/planos.ts`):
- `GET /planos/disponiveis` — catálogo dos planos ativos, marcando `atual` e `selecionavel`.
- `PUT /planos/meu` — a instituição troca o próprio plano.

**Front** (`saaschurch`):
- `types/plano.types.ts`
- `config/redux/api/planosApi.ts` — `useListarPlanosDisponiveisQuery`, `usePlanoAtualQuery`, `useAtualizarPlanoMutation`
- `modules/planos/components/{PlanosSelecao,PlanoCard,ResumoSplit}.tsx`
- `app/(authenticated)/configuracoes/planos/page.tsx`
- `Sidebar.tsx` + `tagTypes` do `baseApi` (`'Plano'`, `'MercadoPago'`)

### Só o gratuito é aplicável

A regra é `plano.ativo && valorMensal === 0`, aplicada **no servidor** (`PUT /planos/meu` responde `403` para plano pago) e refletida na tela pelo campo `selecionavel`.

Optei por **não desativar** `ESSENCIAL` e `PRO` no banco. Eles continuam aparecendo como cards bloqueados, com tooltip explicando o porquê — mostra o roteiro de preços sem permitir contratação. Esconder exigiria mexer no `ativo` das linhas; do jeito atual, quando a cobrança recorrente existir, basta remover a trava.

O bloqueio é necessário porque plano pago depende de `preapproval`, que **não existe nesta entrega**. Sem a trava, qualquer backoffice se auto-atribuiria o PRO e teria acesso pago sem nenhuma cobrança.

Estado verificado contra o banco real:

| Código | Mensal | Taxa | Atual | Selecionável |
|---|---|---|---|---|
| `PILOTO_FREE` | R$ 0,00 | 3,50% | ✅ | ✅ |
| `ESSENCIAL` | R$ 99,00 | 3,50% | — | ❌ pago |
| `PRO` | R$ 249,00 | 2,50% | — | ❌ pago |

### Detalhe de UX que vale manter

O `ResumoSplit` mostra a taxa **efetiva** e sinaliza quando ela vem de uma condição negociada da instituição, não do plano. Sem isso, um backoffice trocaria de plano esperando a taxa mudar e ela continuaria a mesma — o override da instituição vence o padrão do plano. O diálogo de confirmação avisa disso antes de aplicar.

---

## Tela de conexão + checkout — IMPLEMENTADOS

### Conexão da conta (`/configuracoes/pagamentos`)

`types/mercadopago.types.ts` · `config/redux/api/mercadopagoApi.ts` · `modules/pagamentos/components/{ConexaoMercadoPago,StatusConexaoChip,DesvincularDialog}.tsx` · `app/(authenticated)/configuracoes/pagamentos/page.tsx` · item no Sidebar.

Comportamento conforme planejado: mutation (não query) para o `connect`, refetch do status ao voltar do callback, `router.replace` para limpar a query string, `Alert` destacado no estado `EXPIRED`.

A page envolve o componente em `<Suspense>` — `useSearchParams` no App Router exige, senão a rota inteira cai para renderização dinâmica.

### Checkout do participante

Integrado ao formulário público de inscrição, não como tela separada. Depois que a inscrição é gravada, se o produto escolhido tem `exigePagamento`, o hook chama `POST /checkout/preferences` e redireciona para o `init_point`.

- `config/redux/api/checkoutApi.ts` — `useCriarPreferenceCheckoutMutation`
- `modules/evento-form/hooks/useEventoForm.ts` — recebe `produtos` e faz o encadeamento
- `modules/evento-form/components/EventoForm.tsx` — passa `evento.produtos`, texto de botão e aviso durante o redirect
- `app/(public)/inscricao/pagamento/page.tsx` — retorno do MP (`sucesso` · `pendente` · `falha`)
- `proxy.ts` — `/inscricao` adicionado a `publicPaths`

**Ordem importa: a inscrição é gravada antes do pagamento.** Se o participante abandonar o checkout, a inscrição fica pendente e pode ser retomada. O inverso (cobrar antes de inscrever) deixaria pagamento sem inscrição correspondente.

Se a preference falhar depois da inscrição criada, a mensagem diz explicitamente que **a inscrição foi registrada** — sem isso a pessoa tentaria se cadastrar de novo e bateria no unique de `(eventoId, cpf)`.

⚠️ **`/inscricao` precisou entrar em `publicPaths` no `proxy.ts`** (o `middleware.ts` foi renomeado para `proxy.ts` no Next 16). Sem isso o participante voltava do Mercado Pago direto para a tela de login — ele não tem sessão, é inscrito em evento, não usuário do sistema.

### Configuração corrigida

`.env` da API ajustado (backup em `.env.bak-<timestamp>`):

| Variável | Antes | Agora |
|---|---|---|
| `MP_TOKEN_ENCRYPTION_KEY` | 48 bytes (inválida) | 32 bytes ✅ |
| `MERCADO_PAGO_REDIRECT_URI` | domínio do front | `<tunel>/mercadopago/oauth/callback` |
| `API_URL` | `localhost:3000` | URL do túnel |
| `FRONTEND_URL` | **duplicada**, `:3000` vencia | `localhost:3001`, duplicata removida |

A duplicata de `FRONTEND_URL` é o achado mais traiçoeiro: havia duas linhas no `.env`, e o dotenv faz a última vencer — o callback redirecionava para a porta errada mesmo com a linha correta presente no arquivo.

`dotenv` só lê no boot: **trocar o `.env` exige reiniciar a API**, `tsx watch` não recarrega variável de ambiente.

## Estado verificado

| Rota | Resposta | |
|---|---|---|
| `GET /planos`, `/planos/disponiveis`, `/planos/meu` | 401 | ✅ |
| `PUT /planos/meu` | 401 | ✅ |
| `GET /mercadopago/status`, `/pagamentos` | 401 | ✅ |
| `POST /checkout/preferences` | 400 (valida antes de tudo) | ✅ |
| `POST /webhooks/mercadopago` | 401 (assinatura) | ✅ |
| `POST /jobs/refresh-mp-tokens` | 401 | ✅ |
| `GET /mercadopago/oauth/callback` | 302 → `localhost:3001/...` | ✅ |
| front `/configuracoes/{planos,pagamentos}` | 307 → login | ✅ |
| front `/inscricao/pagamento` | 200 público | ✅ |
| túnel → API | 200 | ✅ |

`tsc --noEmit` limpo nos dois repositórios.

**Não verificado:** o fluxo OAuth real, a criação de preference e o recebimento de webhook. Todos dependem de credencial de teste e de um vendedor de teste no painel do Mercado Pago (Etapas 1–5). Nenhuma chamada real ao Mercado Pago foi feita.

## Fora de escopo

- Tela de **listagem de pagamentos MP** — a API (`GET /mercadopago/pagamentos`) e o hook (`useListarPagamentosMercadoPagoQuery`) estão prontos; falta só a tela.
- Edição de split pelo backoffice (`PUT /planos/instituicoes/:id/split`) — API pronta, tela administrativa é entrega separada.
- Cobrança recorrente do SaaS (`preapproval`) — é o que trava os planos pagos hoje.
