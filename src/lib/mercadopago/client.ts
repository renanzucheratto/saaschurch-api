import 'dotenv/config';

export const MP_API_BASE = 'https://api.mercadopago.com';

export class MercadoPagoError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'MercadoPagoError';
  }
}

export interface MpFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  accessToken: string;
  body?: unknown;
  idempotencyKey?: string;
}

/**
 * Chamada crua à API do Mercado Pago.
 *
 * O `accessToken` é sempre explícito: quem chama decide se o fluxo é da
 * plataforma (assinatura SaaS) ou da igreja (split payment). Trocá-los manda o
 * dinheiro para a conta errada, então não existe token padrão aqui.
 */
export async function mpFetch<T>(path: string, options: MpFetchOptions): Promise<T> {
  const { method = 'GET', accessToken, body, idempotencyKey } = options;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  if (idempotencyKey) {
    headers['X-Idempotency-Key'] = idempotencyKey;
  }

  const response = await fetch(`${MP_API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const texto = await response.text();
  const payload = texto ? safeJsonParse(texto) : null;

  if (!response.ok) {
    throw new MercadoPagoError(
      response.status,
      payload,
      `Mercado Pago respondeu ${response.status} em ${method} ${path}`,
    );
  }

  return payload as T;
}

function safeJsonParse(texto: string): unknown {
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

export function accessTokenDaPlataforma(): string {
  const token = process.env.MERCADO_PAGO_ACCESS_TOKEN;

  if (!token) {
    throw new Error('MERCADO_PAGO_ACCESS_TOKEN não configurado');
  }

  return token;
}
