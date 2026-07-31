/**
 * Log estruturado do fluxo Mercado Pago.
 *
 * Regra que vale para o arquivo inteiro: access_token, refresh_token e
 * client_secret NUNCA saem por aqui em texto claro. O que sai é a "impressão
 * digital" — suficiente para responder "é o mesmo token?" e "é token de
 * produção ou de teste?" sem virar credencial vazada em log de servidor.
 *
 * Ligado por padrão fora de produção. Em produção, exige MP_DEBUG=1.
 */

import crypto from 'crypto';

const HABILITADO =
  process.env.MP_DEBUG === '1' ||
  (process.env.MP_DEBUG !== '0' && process.env.NODE_ENV !== 'production');

export type EventoMp =
  | 'oauth.connect'
  | 'oauth.callback'
  | 'oauth.exchange'
  | 'oauth.refresh'
  | 'token.resolve'
  | 'token.renovado'
  | 'token.falha'
  | 'preference.inicio'
  | 'preference.split'
  | 'preference.payload'
  | 'preference.ok'
  | 'preference.erro'
  | 'preference.alerta'
  | 'mp.chamada'
  | 'mp.erro'
  | 'webhook.recebido'
  | 'webhook.vinculo'
  | 'webhook.payment'
  | 'webhook.aplicado';

/**
 * Identifica um token sem revelá-lo: ambiente declarado no prefixo + hash
 * curto. Dois logs com a mesma impressão são o mesmo token; impressões
 * diferentes no mesmo checkout significam que trocou de credencial no meio.
 */
export function impressaoToken(token: string | null | undefined): string {
  if (!token) return 'ausente';

  const hash = crypto.createHash('sha256').update(token).digest('hex').slice(0, 10);

  // O MP codifica o ambiente no prefixo: TEST-* é credencial de teste,
  // APP_USR-* é credencial produtiva (inclusive a de test user via OAuth).
  const prefixo = token.startsWith('TEST-')
    ? 'TEST'
    : token.startsWith('APP_USR-')
      ? 'APP_USR'
      : 'DESCONHECIDO';

  return `${prefixo}:${hash}:len${token.length}`;
}

/** Mesma ideia para e-mail/CPF: confere sem expor o dado do participante. */
export function mascarar(valor: string | null | undefined): string | null {
  if (!valor) return null;
  if (valor.length <= 4) return '***';
  return `${valor.slice(0, 2)}***${valor.slice(-2)}`;
}

export function logMp(evento: EventoMp, dados: Record<string, unknown> = {}): void {
  if (!HABILITADO) return;

  // Uma linha por evento, JSON: legível no terminal e filtrável no Vercel/CloudWatch.
  console.log(
    `[MP] ${evento} ${JSON.stringify({ ts: new Date().toISOString(), ...dados })}`,
  );
}

/** Erro sempre sai, mesmo com MP_DEBUG desligado. */
export function logMpErro(evento: EventoMp, dados: Record<string, unknown> = {}): void {
  console.error(
    `[MP:ERRO] ${evento} ${JSON.stringify({ ts: new Date().toISOString(), ...dados })}`,
  );
}
