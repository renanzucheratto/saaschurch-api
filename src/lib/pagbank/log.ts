/**
 * Log estruturado do fluxo PagBank.
 *
 * Regra que vale para o arquivo inteiro: access_token, refresh_token e
 * client_secret NUNCA saem por aqui em texto claro. O que sai é a "impressão
 * digital" — suficiente para responder "é o mesmo token?" sem virar
 * credencial vazada em log de servidor.
 *
 * Ligado por padrão fora de produção. Em produção, exige PB_DEBUG=1.
 */

import crypto from 'crypto';

const HABILITADO =
  process.env.PB_DEBUG === '1' ||
  (process.env.PB_DEBUG !== '0' && process.env.NODE_ENV !== 'production');

export type EventoPb =
  | 'oauth.connect'
  | 'oauth.callback'
  | 'oauth.exchange'
  | 'oauth.refresh'
  | 'token.resolve'
  | 'token.renovado'
  | 'token.falha'
  | 'pedido.inicio'
  | 'pedido.split'
  | 'pedido.payload'
  | 'pedido.ok'
  | 'pedido.erro'
  | 'pedido.alerta'
  | 'pb.chamada'
  | 'pb.erro'
  | 'webhook.recebido'
  | 'webhook.vinculo'
  | 'webhook.charge'
  | 'webhook.aplicado'
  | 'assinatura.plano'
  | 'assinatura.criar'
  | 'assinatura.erro'
  | 'assinatura.webhook';

/**
 * Identifica um token sem revelá-lo: hash curto + comprimento. Dois logs com
 * a mesma impressão são o mesmo token; impressões diferentes no mesmo fluxo
 * significam que trocou de credencial no meio.
 */
export function impressaoToken(token: string | null | undefined): string {
  if (!token) return 'ausente';

  const hash = crypto.createHash('sha256').update(token).digest('hex').slice(0, 10);

  return `${hash}:len${token.length}`;
}

/** Mesma ideia para e-mail/CPF: confere sem expor o dado do participante. */
export function mascarar(valor: string | null | undefined): string | null {
  if (!valor) return null;
  if (valor.length <= 4) return '***';
  return `${valor.slice(0, 2)}***${valor.slice(-2)}`;
}

export function logPb(evento: EventoPb, dados: Record<string, unknown> = {}): void {
  if (!HABILITADO) return;

  console.log(
    `[PB] ${evento} ${JSON.stringify({ ts: new Date().toISOString(), ...dados })}`,
  );
}

/** Erro sempre sai, mesmo com PB_DEBUG desligado. */
export function logPbErro(evento: EventoPb, dados: Record<string, unknown> = {}): void {
  console.error(
    `[PB:ERRO] ${evento} ${JSON.stringify({ ts: new Date().toISOString(), ...dados })}`,
  );
}
