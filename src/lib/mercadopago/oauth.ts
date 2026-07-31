import crypto from 'crypto';
import { chamarMp, clienteOAuthPlataforma } from './client.js';

/**
 * Fluxo OAuth Authorization Code + PKCE para vincular a conta Mercado Pago de
 * cada instituição, sobre o cliente `OAuth` do SDK oficial.
 *
 * Prazos definidos pelo Mercado Pago:
 *  - authorization_code: 10 minutos, uso único
 *  - refresh_token: 6 meses, reutilizável
 *
 * PKCE não aparece nos tipos do SDK (`AuthorizationRequest` e `OAuthRequest` só
 * declaram os campos básicos), mas o SDK repassa o objeto inteiro para a query
 * string e para o corpo. Por isso os parâmetros são montados como
 * Record<string, string>: carrega code_challenge/code_verifier adiante sem cast
 * e sem reimplementar o endpoint na mão.
 */

/** ~6 meses, validade do refresh_token do Mercado Pago. */
const VALIDADE_REFRESH_MS = 180 * 24 * 60 * 60 * 1000;

export interface TokensMercadoPago {
  accessToken: string;
  refreshToken: string;
  publicKey: string | null;
  /** user_id do MP como string: é identificador, não número para cálculo. */
  mpUserId: string;
  scope: string | null;
  expiresAt: Date;
  refreshExpiresAt: Date;
}

function envObrigatoria(nome: string): string {
  const valor = process.env[nome];
  if (!valor) {
    throw new Error(`${nome} não configurada`);
  }
  return valor;
}

/** PKCE: gera o verifier e o challenge S256 correspondente. */
export function gerarParPkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  return { codeVerifier, codeChallenge };
}

export function buildAuthorizationUrl(state: string, codeChallenge: string): string {
  // response_type=code e platform_id=mp são acrescentados pelo próprio SDK.
  const parametros: Record<string, string> = {
    client_id: envObrigatoria('MERCADO_PAGO_APP_ID'),
    redirect_uri: envObrigatoria('MERCADO_PAGO_REDIRECT_URI'),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  };

  return clienteOAuthPlataforma().getAuthorizationURL({ options: parametros });
}

/**
 * O SDK devolve todo campo como opcional (`OAuthResponse`). Sem access_token ou
 * refresh_token não há o que gravar — falhar aqui é melhor do que persistir uma
 * conta pela metade e descobrir só no primeiro checkout.
 */
function normalizarResposta(resposta: Record<string, any>): TokensMercadoPago {
  const accessToken = resposta?.access_token;
  const refreshToken = resposta?.refresh_token;
  const expiresIn = Number(resposta?.expires_in);

  if (!accessToken || !refreshToken) {
    throw new Error('OAuth Mercado Pago: resposta sem access_token/refresh_token');
  }

  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('OAuth Mercado Pago: resposta sem expires_in válido');
  }

  const agora = Date.now();

  return {
    accessToken: String(accessToken),
    refreshToken: String(refreshToken),
    publicKey: resposta?.public_key ? String(resposta.public_key) : null,
    mpUserId: resposta?.user_id !== undefined ? String(resposta.user_id) : '',
    scope: resposta?.scope ? String(resposta.scope) : null,
    expiresAt: new Date(agora + expiresIn * 1000),
    refreshExpiresAt: new Date(agora + VALIDADE_REFRESH_MS),
  };
}

export async function exchangeCode(
  code: string,
  codeVerifier: string,
): Promise<TokensMercadoPago> {
  // grant_type=authorization_code é injetado pelo SDK.
  const corpo: Record<string, string> = {
    client_id: envObrigatoria('MERCADO_PAGO_APP_ID'),
    client_secret: envObrigatoria('MERCADO_PAGO_CLIENT_SECRET'),
    code,
    redirect_uri: envObrigatoria('MERCADO_PAGO_REDIRECT_URI'),
    code_verifier: codeVerifier,
  };

  const resposta = await chamarMp('POST /oauth/token (authorization_code)', () =>
    clienteOAuthPlataforma().create({ body: corpo }),
  );

  return normalizarResposta(resposta as Record<string, any>);
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<TokensMercadoPago> {
  // grant_type=refresh_token é injetado pelo SDK.
  const corpo: Record<string, string> = {
    client_id: envObrigatoria('MERCADO_PAGO_APP_ID'),
    client_secret: envObrigatoria('MERCADO_PAGO_CLIENT_SECRET'),
    refresh_token: refreshToken,
  };

  const resposta = await chamarMp('POST /oauth/token (refresh_token)', () =>
    clienteOAuthPlataforma().refresh({ body: corpo }),
  );

  return normalizarResposta(resposta as Record<string, any>);
}
