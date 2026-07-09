import crypto from 'node:crypto';

export const JANELA_TS_MS = 5 * 60 * 1000;

export interface PartesAssinatura {
  ts: string;
  v1: string;
}

export interface EntradaValidacao {
  /** Valor do query param `data.id` da URL — nunca do body. */
  dataId: string | undefined;
  xSignature: string | undefined;
  xRequestId: string | undefined;
  segredo: string;
  agora?: number;
}

export type ResultadoValidacao = { valido: true } | { valido: false; motivo: string };

/** `x-signature: ts=1704908010,v1=618c85...` */
export function parseXSignature(header: string | undefined): PartesAssinatura | null {
  if (!header) return null;

  const partes: Record<string, string> = {};

  for (const segmento of header.split(',')) {
    const separador = segmento.indexOf('=');
    if (separador === -1) continue;

    const chave = segmento.slice(0, separador).trim();
    const valor = segmento.slice(separador + 1).trim();
    if (chave) partes[chave] = valor;
  }

  if (!partes.ts || !partes.v1) return null;

  return { ts: partes.ts, v1: partes.v1 };
}

/**
 * Manifesto do MP: `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`
 * Campo ausente é omitido junto do seu separador.
 * `data.id` alfanumérico entra em minúsculas.
 */
export function montarManifesto(
  dataId: string | undefined,
  xRequestId: string | undefined,
  ts: string,
): string {
  let manifesto = '';

  if (dataId) {
    manifesto += `id:${/^\d+$/.test(dataId) ? dataId : dataId.toLowerCase()};`;
  }

  if (xRequestId) {
    manifesto += `request-id:${xRequestId};`;
  }

  manifesto += `ts:${ts};`;

  return manifesto;
}

export function validarAssinatura(entrada: EntradaValidacao): ResultadoValidacao {
  const { dataId, xSignature, xRequestId, segredo, agora = Date.now() } = entrada;

  if (!segredo) {
    return { valido: false, motivo: 'MERCADO_PAGO_WEBHOOK_SECRET não configurado' };
  }

  const partes = parseXSignature(xSignature);

  if (!partes) {
    return { valido: false, motivo: 'x-signature ausente ou malformado' };
  }

  const tsNumero = Number(partes.ts);

  if (!Number.isFinite(tsNumero)) {
    return { valido: false, motivo: 'ts inválido' };
  }

  // O MP envia `ts` em segundos; toleramos milissegundos por robustez.
  const tsMs = partes.ts.length > 12 ? tsNumero : tsNumero * 1000;

  if (Math.abs(agora - tsMs) > JANELA_TS_MS) {
    return { valido: false, motivo: 'ts fora da janela de 5 minutos' };
  }

  const esperado = crypto
    .createHmac('sha256', segredo)
    .update(montarManifesto(dataId, xRequestId, partes.ts))
    .digest('hex');

  if (!comparacaoSegura(esperado, partes.v1)) {
    return { valido: false, motivo: 'assinatura não confere' };
  }

  return { valido: true };
}

/** `crypto.timingSafeEqual` exige buffers do mesmo tamanho — daí o guard de length. */
function comparacaoSegura(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');

  if (bufferA.length !== bufferB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufferA, bufferB);
}
