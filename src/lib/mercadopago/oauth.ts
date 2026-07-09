import 'dotenv/config';
import jwt from 'jsonwebtoken';
import { MP_API_BASE, MercadoPagoError } from './client.js';

const URL_AUTORIZACAO = 'https://auth.mercadopago.com.br/authorization';

export const TTL_STATE_SEGUNDOS = 10 * 60;

export interface StatePayload {
  instituicaoId: string;
  userId: string;
  nonce: string;
}

export interface TokensMercadoPago {
  accessToken: string;
  refreshToken: string;
  publicKey: string;
  mpUserId: string;
  scope: string | null;
  expiresAt: Date;
}

interface RespostaTokenMP {
  access_token: string;
  refresh_token: string;
  public_key: string;
  user_id: number | string;
  scope?: string;
  expires_in: number;
}

function envObrigatoria(nome: string): string {
  const valor = process.env[nome];

  if (!valor) {
    throw new Error(`${nome} não configurada`);
  }

  return valor;
}

export function assinarState(payload: StatePayload): string {
  return jwt.sign(payload, envObrigatoria('JWT_SECRET'), { expiresIn: TTL_STATE_SEGUNDOS });
}

/** Retorna `null` para state ausente, com assinatura inválida ou expirado. */
export function verificarState(state: string | undefined): StatePayload | null {
  if (!state) return null;

  try {
    const decodificado = jwt.verify(state, envObrigatoria('JWT_SECRET'));

    if (typeof decodificado === 'string') return null;

    const { instituicaoId, userId, nonce } = decodificado as Partial<StatePayload>;

    if (!instituicaoId || !userId || !nonce) return null;

    return { instituicaoId, userId, nonce };
  } catch {
    return null;
  }
}

export function montarUrlAutorizacao(state: string): string {
  const parametros = new URLSearchParams({
    client_id: envObrigatoria('MERCADO_PAGO_CLIENT_ID'),
    response_type: 'code',
    platform_id: 'mp',
    state,
    redirect_uri: envObrigatoria('MERCADO_PAGO_REDIRECT_URI'),
  });

  return `${URL_AUTORIZACAO}?${parametros.toString()}`;
}

export async function trocarCodePorTokens(code: string): Promise<TokensMercadoPago> {
  return postOAuthToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: envObrigatoria('MERCADO_PAGO_REDIRECT_URI'),
  });
}

export async function renovarTokens(refreshToken: string): Promise<TokensMercadoPago> {
  return postOAuthToken({ grant_type: 'refresh_token', refresh_token: refreshToken });
}

/**
 * `POST /oauth/token` autentica pelas credenciais do app de marketplace no corpo,
 * não por Bearer — por isso não passa pelo `mpFetch`.
 */
async function postOAuthToken(extras: Record<string, string>): Promise<TokensMercadoPago> {
  const response = await fetch(`${MP_API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: envObrigatoria('MERCADO_PAGO_CLIENT_ID'),
      client_secret: envObrigatoria('MERCADO_PAGO_CLIENT_SECRET'),
      ...extras,
    }),
  });

  const corpo = (await response.json().catch(() => null)) as RespostaTokenMP | null;

  if (!response.ok || !corpo?.access_token) {
    throw new MercadoPagoError(
      response.status,
      corpo,
      `Falha ao obter tokens OAuth do Mercado Pago (${response.status})`,
    );
  }

  return {
    accessToken: corpo.access_token,
    refreshToken: corpo.refresh_token,
    publicKey: corpo.public_key,
    mpUserId: String(corpo.user_id),
    scope: corpo.scope ?? null,
    expiresAt: new Date(Date.now() + corpo.expires_in * 1000),
  };
}
