/**
 * Acesso à API do Mercado Pago pelo SDK oficial (`mercadopago`).
 *
 * Regra de ouro deste arquivo: o access_token nunca aparece em log, mensagem de
 * erro ou stack. Ele é credencial de terceiro (a instituição), não nossa.
 *
 * Duas particularidades do SDK que este módulo esconde do resto do código:
 *  - em erro HTTP ele lança o CORPO JSON cru (objeto puro), não um Error;
 *  - cada cliente (Preference, Payment, ...) recebe um MercadoPagoConfig, e o
 *    token varia por requisição — então o config é criado por chamada, nunca
 *    compartilhado entre instituições.
 */

import {
  MercadoPagoConfig,
  OAuth,
  Payment,
  PaymentMethod,
  Preference,
  User,
} from 'mercadopago';
import { logMp, logMpErro } from './log.js';

/** A função tem 10s de teto na Vercel, então o default é curto. */
const TIMEOUT_PADRAO_MS = 8000;

export interface OpcoesMp {
  timeoutMs?: number;
  /** Obrigatório em POST que cria recurso cobrável. */
  idempotencyKey?: string;
}

/**
 * O SDK não reexporta os tipos de payload no entrypoint, só as classes.
 * Derivá-los das assinaturas evita importar caminho interno de `dist/`.
 */
export type PreferenceRequestMp = Parameters<Preference['create']>[0]['body'];
export type PagamentoMp = Awaited<ReturnType<Payment['get']>>;

export class MercadoPagoError extends Error {
  /** null quando a falha foi de rede/timeout, antes de haver resposta. */
  readonly status: number | null;
  readonly corpo: unknown;

  constructor(status: number | null, corpo: unknown, contexto: string, detalhe: string) {
    super(`Mercado Pago ${status ?? 'sem resposta'} em ${contexto}: ${detalhe}`);
    this.name = 'MercadoPagoError';
    this.status = status;
    this.corpo = corpo;
  }

  /**
   * Normaliza o que o SDK lança: corpo JSON do MP, DOMException de timeout ou
   * Error de rede.
   */
  static de(erro: unknown, contexto: string): MercadoPagoError {
    if (erro instanceof MercadoPagoError) return erro;

    if (erro instanceof Error && (erro.name === 'AbortError' || erro.name === 'TimeoutError')) {
      return new MercadoPagoError(null, null, contexto, 'timeout na chamada');
    }

    if (erro && typeof erro === 'object') {
      const corpo = erro as Record<string, unknown>;

      const status =
        typeof corpo.status === 'number'
          ? corpo.status
          : typeof corpo.statusCode === 'number'
            ? corpo.statusCode
            : null;

      // O MP devolve `message` ou `error`, e detalha em `cause[].description`.
      const causa = Array.isArray(corpo.cause) ? corpo.cause[0] : null;
      const descricaoCausa =
        causa && typeof causa === 'object'
          ? String((causa as Record<string, unknown>).description ?? '')
          : '';

      const detalhe =
        [corpo.message, corpo.error, descricaoCausa]
          .filter((v): v is string => typeof v === 'string' && v.length > 0)
          .join(' - ') || 'erro desconhecido';

      return new MercadoPagoError(status, corpo, contexto, detalhe);
    }

    return new MercadoPagoError(null, erro, contexto, String(erro));
  }
}

function criarConfigMp(accessToken: string, opcoes: OpcoesMp = {}): MercadoPagoConfig {
  if (!accessToken) {
    throw new Error('Mercado Pago: access token ausente');
  }

  return new MercadoPagoConfig({
    accessToken,
    options: {
      timeout: opcoes.timeoutMs ?? TIMEOUT_PADRAO_MS,
      // A chave de idempotência definida no config vale para TODAS as chamadas
      // feitas com ele — por isso um config por operação, e não um cliente
      // global reaproveitado.
      ...(opcoes.idempotencyKey ? { idempotencyKey: opcoes.idempotencyKey } : {}),
    },
  });
}

export function clientePreference(accessToken: string, opcoes?: OpcoesMp): Preference {
  return new Preference(criarConfigMp(accessToken, opcoes));
}

export function clientePagamento(accessToken: string, opcoes?: OpcoesMp): Payment {
  return new Payment(criarConfigMp(accessToken, opcoes));
}

/**
 * `GET /users/me` com o token da instituição. É a única forma de saber se a
 * conexão realmente vale — o status guardado no banco é só a última coisa que
 * soubemos, e não muda quando a instituição revoga o acesso pelo painel do MP.
 */
export function clienteUsuario(accessToken: string, opcoes?: OpcoesMp): User {
  return new User(criarConfigMp(accessToken, opcoes));
}

export function clienteMetodoPagamento(
  accessToken: string,
  opcoes?: OpcoesMp,
): PaymentMethod {
  return new PaymentMethod(criarConfigMp(accessToken, opcoes));
}

/**
 * OAuth roda com a credencial da PLATAFORMA (nossa aplicação), não com a da
 * instituição — é ela que troca o authorization_code e renova o refresh_token.
 */
export function clienteOAuthPlataforma(opcoes?: OpcoesMp): OAuth {
  const token = process.env.MERCADO_PAGO_ACCESS_TOKEN;

  if (!token) {
    throw new Error('MERCADO_PAGO_ACCESS_TOKEN não configurada');
  }

  return new OAuth(criarConfigMp(token, opcoes));
}

/** Envolve chamadas ao SDK para o erro sair sempre como MercadoPagoError. */
export async function chamarMp<T>(contexto: string, fn: () => Promise<T>): Promise<T> {
  const inicio = Date.now();

  try {
    const resultado = await fn();
    logMp('mp.chamada', { contexto, ms: Date.now() - inicio, ok: true });
    return resultado;
  } catch (erro) {
    const normalizado = MercadoPagoError.de(erro, contexto);

    // O corpo cru do MP é onde mora o motivo real (cause[].code/description).
    // Sem ele, sobra só "Bad Request" e o debug morre aqui.
    logMpErro('mp.erro', {
      contexto,
      ms: Date.now() - inicio,
      status: normalizado.status,
      mensagem: normalizado.message,
      corpo: normalizado.corpo,
    });

    throw normalizado;
  }
}
