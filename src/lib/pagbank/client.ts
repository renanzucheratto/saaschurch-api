/**
 * Acesso à API REST do PagBank (Orders/Charges/Connect).
 *
 * O PagBank não publica SDK Node oficial mantido — este módulo é um cliente
 * HTTP fino sobre `fetch`, no mesmo espírito do `mercadopago/client.ts` que
 * substitui: erro normalizado, timeout curto (função roda na Vercel), e o
 * access_token nunca aparece em log, mensagem de erro ou stack (é credencial
 * de terceiro — a instituição — não nossa).
 */

import { logPb, logPbErro } from './log.js';

/** A função tem 10s de teto na Vercel, então o default é curto. */
const TIMEOUT_PADRAO_MS = 8000;

function ambienteProducao(): boolean {
  return process.env.PAGBANK_ENV === 'production';
}

/** Orders, Charges, Connect (accounts) — api.pagseguro.com. */
export function baseUrlOrders(): string {
  return ambienteProducao() ? 'https://api.pagseguro.com' : 'https://sandbox.api.pagseguro.com';
}

/** Autorização/token do Connect vive no mesmo host de Orders. */
export function baseUrlOAuthToken(): string {
  return baseUrlOrders();
}

/** Tela de autorização do Connect (browser do usuário é redirecionado aqui). */
export function baseUrlConnectAuthorize(): string {
  return ambienteProducao()
    ? 'https://connect.pagbank.com.br'
    : 'https://connect.sandbox.pagbank.com.br';
}

/** Assinaturas (mensalidade da plataforma) é produto separado, host próprio. */
export function baseUrlAssinaturas(): string {
  return ambienteProducao()
    ? 'https://api.assinaturas.pagseguro.com'
    : 'https://sandbox.api.assinaturas.pagseguro.com';
}

export class PagBankError extends Error {
  /** null quando a falha foi de rede/timeout, antes de haver resposta. */
  readonly status: number | null;
  readonly corpo: unknown;

  constructor(status: number | null, corpo: unknown, contexto: string, detalhe: string) {
    super(`PagBank ${status ?? 'sem resposta'} em ${contexto}: ${detalhe}`);
    this.name = 'PagBankError';
    this.status = status;
    this.corpo = corpo;
  }

  /**
   * O PagBank devolve erros como `{ error_messages: [{ code, description,
   * parameter_name }] }` (Orders/Connect) ou `{ code, message }` (Assinaturas).
   * Normaliza os dois formatos numa mensagem legível.
   */
  static de(status: number, corpo: unknown, contexto: string): PagBankError {
    if (corpo && typeof corpo === 'object') {
      const c = corpo as Record<string, unknown>;

      const mensagens = Array.isArray(c.error_messages)
        ? (c.error_messages as Array<Record<string, unknown>>)
            .map((m) => String(m.description ?? m.code ?? ''))
            .filter(Boolean)
            .join(' - ')
        : '';

      const detalhe =
        mensagens ||
        (typeof c.message === 'string' ? c.message : '') ||
        (typeof c.error === 'string' ? c.error : '') ||
        'erro desconhecido';

      return new PagBankError(status, corpo, contexto, detalhe);
    }

    return new PagBankError(status, corpo, contexto, String(corpo ?? 'erro desconhecido'));
  }

  static deRede(erro: unknown, contexto: string): PagBankError {
    if (erro instanceof PagBankError) return erro;

    if (erro instanceof Error && (erro.name === 'AbortError' || erro.name === 'TimeoutError')) {
      return new PagBankError(null, null, contexto, 'timeout na chamada');
    }

    return new PagBankError(null, null, contexto, String((erro as Error)?.message ?? erro));
  }
}

export interface OpcoesRequestPb {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  baseUrl: string;
  path: string;
  /** Bearer token — da instituição (Orders) ou da plataforma (Assinaturas). */
  accessToken: string;
  body?: unknown;
  /** Obrigatório em todo POST que cria recurso cobrável (Orders e Assinaturas). */
  idempotencyKey?: string;
  timeoutMs?: number;
  /** Cabeçalhos extras — usado por /accounts, que exige x-client-token além do Bearer. */
  headers?: Record<string, string>;
}

/**
 * Faz a chamada HTTP crua e devolve o corpo já parseado. Lança PagBankError
 * em qualquer resposta não-2xx ou falha de rede/timeout — nunca deixa o
 * `fetch` cru vazar para quem chama.
 */
async function requestPb<T>(contexto: string, opcoes: OpcoesRequestPb): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opcoes.timeoutMs ?? TIMEOUT_PADRAO_MS);

  const inicio = Date.now();

  try {
    const resposta = await fetch(`${opcoes.baseUrl}${opcoes.path}`, {
      method: opcoes.method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${opcoes.accessToken}`,
        'Content-Type': 'application/json',
        ...(opcoes.idempotencyKey ? { 'x-idempotency-key': opcoes.idempotencyKey } : {}),
        ...(opcoes.headers ?? {}),
      },
      body: opcoes.body !== undefined ? JSON.stringify(opcoes.body) : undefined,
    });

    const texto = await resposta.text();
    const corpo = texto ? JSON.parse(texto) : {};

    if (!resposta.ok) {
      const erro = PagBankError.de(resposta.status, corpo, contexto);

      logPbErro('pb.erro', {
        contexto,
        ms: Date.now() - inicio,
        status: erro.status,
        mensagem: erro.message,
        corpo: erro.corpo,
      });

      throw erro;
    }

    logPb('pb.chamada', { contexto, ms: Date.now() - inicio, ok: true });

    return corpo as T;
  } catch (erro) {
    if (erro instanceof PagBankError) throw erro;

    const normalizado = PagBankError.deRede(erro, contexto);

    logPbErro('pb.erro', {
      contexto,
      ms: Date.now() - inicio,
      status: normalizado.status,
      mensagem: normalizado.message,
    });

    throw normalizado;
  } finally {
    clearTimeout(timeout);
  }
}

export { requestPb };
