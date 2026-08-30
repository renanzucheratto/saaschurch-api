import crypto from 'crypto';
import { baseUrlConnectAuthorize, baseUrlOAuthToken, requestPb } from './client.js';
import { impressaoToken, logPb } from './log.js';

/**
 * Fluxo OAuth Authorization Code (PagBank Connect) para vincular a conta de
 * cada instituição.
 *
 * Prazo documentado pelo PagBank: o `code` de autorização vale 10 minutos e
 * é de uso único (developer.pagbank.com.br/docs/connect-authorization). O
 * PagBank não documenta PKCE no Connect — diferente do Mercado Pago, que este
 * módulo substitui — então o par code_verifier/code_challenge não é usado
 * aqui; o `state` sozinho cobre o anti-CSRF, guardado na mesma tabela
 * `OAuthNonce` (campo `codeVerifier` fica vazio, reaproveitando a tabela).
 *
 * ATENÇÃO: os cabeçalhos `X_CLIENT_ID`/`X_CLIENT_SECRET` na troca de código e
 * no refresh estão documentados assim (com underscore, maiúsculo) em
 * developer.pagbank.com.br/reference/obter-access-token — mas a maioria dos
 * headers reais do PagBank segue `x-algo-coisa` (ex.: `x-client-token` em
 * /accounts). Sem credencial de sandbox para testar contra a API de verdade,
 * a implementação segue literalmente o que a doc escreve. Se a troca de
 * código falhar com 401/invalid_client assim que houver credencial real, o
 * primeiro lugar a olhar é aqui.
 */

const SCOPES_PADRAO = [
  'payments.read',
  'payments.create',
  'payments.refund',
  'accounts.read',
];

function envObrigatoria(nome: string): string {
  const valor = process.env[nome];
  if (!valor) {
    throw new Error(`${nome} não configurada`);
  }
  return valor;
}

export function buildAuthorizationUrl(state: string): string {
  // scope vai com "+" literal entre nomes na URL do PagBank; URLSearchParams
  // já codifica espaço como "+" no serialize, então junta os escopos com espaço.
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: envObrigatoria('PAGBANK_APP_ID'),
    redirect_uri: envObrigatoria('PAGBANK_REDIRECT_URI'),
    scope: SCOPES_PADRAO.join(' '),
    state,
  });

  return `${baseUrlConnectAuthorize()}/oauth2/authorize?${query.toString()}`;
}

export interface TokensPagBank {
  accessToken: string;
  refreshToken: string;
  /** account_id do PagBank (ACCO_xxxx) — o vendedor/collector conectado. */
  accountId: string;
  scope: string | null;
  expiresAt: Date;
}

/**
 * O PagBank não documenta o `expires_in` de forma explícita além do formato
 * (segundos). Sem valor numérico confiável assumimos 1h como piso seguro —
 * `token.ts` renova com 10 min de margem, então um valor conservador aqui só
 * gera renovações um pouco mais frequentes, nunca token expirado em uso.
 */
const EXPIRES_IN_PADRAO_SEGUNDOS = 3600;

function normalizarResposta(resposta: Record<string, any>): TokensPagBank {
  const accessToken = resposta?.access_token;
  const refreshToken = resposta?.refresh_token;
  const accountId = resposta?.account_id;
  const expiresIn = Number(resposta?.expires_in);

  if (!accessToken || !refreshToken) {
    throw new Error('OAuth PagBank: resposta sem access_token/refresh_token');
  }

  if (!accountId) {
    throw new Error('OAuth PagBank: resposta sem account_id');
  }

  const segundos = Number.isFinite(expiresIn) && expiresIn > 0
    ? expiresIn
    : EXPIRES_IN_PADRAO_SEGUNDOS;

  return {
    accessToken: String(accessToken),
    refreshToken: String(refreshToken),
    accountId: String(accountId),
    scope: resposta?.scope ? String(resposta.scope) : null,
    expiresAt: new Date(Date.now() + segundos * 1000),
  };
}

export async function exchangeCode(code: string): Promise<TokensPagBank> {
  const resposta = await requestPb<Record<string, any>>('POST /oauth2/token (authorization_code)', {
    method: 'POST',
    baseUrl: baseUrlOAuthToken(),
    path: '/oauth2/token',
    // Token de plataforma: usado só para autenticar a chamada, não para
    // operar em nome de ninguém ainda (é o troca-de-código quem gera a
    // credencial da instituição).
    accessToken: envObrigatoria('PAGBANK_ACCESS_TOKEN'),
    headers: {
      X_CLIENT_ID: envObrigatoria('PAGBANK_APP_ID'),
      X_CLIENT_SECRET: envObrigatoria('PAGBANK_CLIENT_SECRET'),
    },
    body: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: envObrigatoria('PAGBANK_REDIRECT_URI'),
    },
  });

  const tokens = normalizarResposta(resposta);

  logPb('oauth.exchange', {
    appId: process.env.PAGBANK_APP_ID,
    redirectUri: process.env.PAGBANK_REDIRECT_URI,
    accountId: tokens.accountId,
    scope: tokens.scope,
    token: impressaoToken(tokens.accessToken),
    expiraEm: tokens.expiresAt.toISOString(),
  });

  return tokens;
}

export async function refreshAccessToken(refreshToken: string): Promise<TokensPagBank> {
  const resposta = await requestPb<Record<string, any>>('POST /oauth2/refresh', {
    method: 'POST',
    baseUrl: baseUrlOAuthToken(),
    path: '/oauth2/refresh',
    accessToken: envObrigatoria('PAGBANK_ACCESS_TOKEN'),
    headers: {
      X_CLIENT_ID: envObrigatoria('PAGBANK_APP_ID'),
      X_CLIENT_SECRET: envObrigatoria('PAGBANK_CLIENT_SECRET'),
    },
    body: {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    },
  });

  const tokens = normalizarResposta(resposta);

  logPb('oauth.refresh', {
    accountId: tokens.accountId,
    scope: tokens.scope,
    token: impressaoToken(tokens.accessToken),
    expiraEm: tokens.expiresAt.toISOString(),
  });

  return tokens;
}

/** Gera o `state` anti-CSRF do fluxo. Reaproveita crypto do Node, sem PKCE. */
export function gerarState(): string {
  return crypto.randomBytes(24).toString('base64url');
}
