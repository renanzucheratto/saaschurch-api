# SPEC-BE-002 — Conexão OAuth com Mercado Pago

| | |
|---|---|
| **Repo** | `saaschurch-api` |
| **Fase** | F3 |
| **Depende de** | — |
| **Habilita** | [SPEC-BE-003](./SPEC-BE-003-pagamento-split.md), `SPEC-FE-001` |
| **Bloqueada por** | Decisão pendente: formato de `/payment-connect/authorize` (ver abaixo) |

---

## Contexto

Cada igreja conecta a própria conta Mercado Pago. Sem isso não há split payment — o dinheiro do evento não teria onde cair.

Este fluxo usa as credenciais **do app de marketplace da plataforma** (`MERCADO_PAGO_CLIENT_ID` / `_CLIENT_SECRET`) para obter tokens **da igreja**. Não confundir com `MERCADO_PAGO_ACCESS_TOKEN`, que é o token da conta da plataforma e serve à assinatura SaaS ([SPEC-BE-004](./SPEC-BE-004-assinatura-saas.md)).

## Requisitos funcionais

| ID | Requisito |
|---|---|
| RF-01 | Gerar URL de autorização com `state` assinado (JWT, TTL 10 min, `nonce` de uso único). |
| RF-02 | Callback troca `code` por tokens, criptografa e persiste. |
| RF-03 | Consultar status da conexão da instituição. |
| RF-04 | Desconectar (`status = REVOKED`, tokens apagados). |
| RF-05 | Cron renova tokens perto do vencimento. |

## Modelagem

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

Relação reversa em `Instituicao`:
```prisma
mercadoPagoAccount MercadoPagoAccount?
```

## Fluxo

1. Admin da igreja clica em "Conectar Mercado Pago".
2. Backend gera `state` = JWT curto (TTL 10 min) com `{ instituicaoId, userId, nonce }`, assinado com `JWT_SECRET`.
3. Browser navega para `https://auth.mercadopago.com.br/authorization?client_id=...&response_type=code&platform_id=mp&state=<jwt>&redirect_uri=...`.
4. MP redireciona para `GET /payment-connect/callback?code=...&state=...`.
5. Backend valida `state` (assinatura + TTL + nonce não reutilizado), troca `code` por tokens em `POST /oauth/token`, criptografa `access_token`/`refresh_token` (AES-256-GCM), grava `MercadoPagoAccount` com `status = ACTIVE`.
6. Redireciona o browser para `${FRONTEND_URL}/instituicao/pagamentos?connected=1`.
7. Cron diário renova tokens com `expiresAt` a menos de 7 dias, usando `refresh_token`.

> O `redirect_uri` registrado no painel do MP precisa ser **exatamente** a URL do callback, incluindo protocolo e ausência de barra final. Divergência aqui é a causa nº 1 de `invalid_client` no OAuth do MP.

## Segurança

### Tokens em repouso

- Cifrados com **AES-256-GCM**, chave de 32 bytes em `MP_TOKEN_ENCRYPTION_KEY` (hex, 64 chars).
- Formato armazenado: `iv:authTag:ciphertext` (base64 por segmento).
- **Nunca** logar token, nem truncado. **Nunca** retornar em resposta de API — nem para backoffice.
- Rotação de chave: prever coluna `encryptionKeyVersion` se a chave for rotacionada.

### `state`

JWT assinado com `JWT_SECRET`, TTL 10 min, `nonce` de uso único persistido (tabela ou cache) e consumido no callback. Protege contra CSRF e replay do `code`.

## Variáveis de ambiente novas

```bash
MERCADO_PAGO_CLIENT_ID=""
MERCADO_PAGO_CLIENT_SECRET=""
MERCADO_PAGO_REDIRECT_URI="https://api.exemplo.com/payment-connect/callback"

# gerar: openssl rand -hex 32
MP_TOKEN_ENCRYPTION_KEY=""

# proteção das rotas de cron
CRON_SECRET=""
```

## Decisão pendente

**`/payment-connect/authorize` responde `302` ou JSON?**

`302` exige mandar o token de auth em query param (navegação de browser não carrega header `Authorization`), o que vaza o token no histórico e nos logs de acesso.

**Recomendação: `POST /payment-connect/authorize` retornando `{ authorizeUrl }` em JSON**, e o frontend navega para ela. Mantém o `Authorization: Bearer` e não vaza nada.

O contrato abaixo assume a recomendação.

## Contrato

```http
POST /payment-connect/authorize          # autenticado, backoffice|pastor
200 { "authorizeUrl": "https://auth.mercadopago.com.br/authorization?..." }
403 { "error": "Acesso negado..." }
409 { "error": "JA_CONECTADO" }

GET /payment-connect/callback?code=...&state=...    # pública, valida state
302 → ${FRONTEND_URL}/instituicao/pagamentos?connected=1
302 → ${FRONTEND_URL}/instituicao/pagamentos?error=INVALID_STATE

GET /payment-connect/status              # autenticado; instituicaoId vem de req.user
200 { "status": "ACTIVE", "mpUserId": "123", "conectadoEm": "...", "expiresAt": "..." }
200 { "status": "NAO_CONECTADO" }

DELETE /payment-connect                  # backoffice|pastor
204
```

`status` e `DELETE` derivam `instituicaoId` de `req.user`, não de path param — elimina uma classe inteira de IDOR.

Nenhuma resposta expõe `accessToken` ou `refreshToken`.

## Critérios de aceite

```gherkin
Cenário: State inválido é rejeitado
  Dado um callback com state não assinado por JWT_SECRET
  Quando GET /payment-connect/callback
  Então redireciona com error=INVALID_STATE
  E nenhum token é trocado com o MP

Cenário: State expirado é rejeitado
  Dado um state emitido há 11 minutos
  Quando GET /payment-connect/callback
  Então redireciona com error=INVALID_STATE

Cenário: Nonce não pode ser reutilizado
  Dado um callback já processado com sucesso para o nonce N
  Quando um segundo callback chega com o mesmo nonce N
  Então redireciona com error=INVALID_STATE

Cenário: Tokens são criptografados em repouso
  Dado um callback válido
  Quando os tokens são persistidos
  Então MercadoPagoAccount.accessToken != o access_token em claro
  E o valor decifrado com MP_TOKEN_ENCRYPTION_KEY é igual ao original

Cenário: Tokens nunca vazam na API
  Quando GET /payment-connect/status
  Então a resposta não contém accessToken nem refreshToken

Cenário: Refresh falho marca a conta como EXPIRED
  Dado uma conta com refresh_token revogado no MP
  Quando o job refresh-tokens roda
  Então status = EXPIRED
  E ultimoErro é preenchido
  E nenhuma exceção não tratada escapa do job

Cenário: Desconectar apaga os tokens
  Quando DELETE /payment-connect
  Então status = REVOKED
  E accessToken e refreshToken são apagados do registro

Cenário: Instituição não vê a conexão de outra
  Dado dois usuários de instituições diferentes
  Então GET /payment-connect/status retorna apenas a conta da própria instituição
```

## Definição de pronto

- [ ] `src/lib/mercadopago/crypto.ts` (AES-256-GCM, formato `iv:authTag:ciphertext`)
- [ ] `src/lib/mercadopago/oauth.ts`
- [ ] `src/services/payment-connect.service.ts`
- [ ] `src/routes/payment-connect.ts` registrada em `src/server.ts`
- [ ] Migration `MercadoPagoAccount` + enum + relação reversa em `Instituicao`
- [ ] Envs novas adicionadas em `.env.example`, `.env`, `.env.prd`
- [ ] `redirect_uri` cadastrada no painel do MP, byte a byte igual à env
- [ ] Nenhum token aparece em log — `grep -rn "accessToken" src/` revisado
- [ ] Decisão de formato do `authorize` confirmada
