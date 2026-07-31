import { InvalidWebhookSignatureError, WebhookSignatureValidator } from 'mercadopago';

/**
 * Validação da assinatura dos webhooks do Mercado Pago.
 *
 * Header recebido:  x-signature: ts=1704908010,v1=<hmac hex>
 * Manifest:         id:<data.id>;request-id:<x-request-id>;ts:<ts>;
 * v1 = HMAC-SHA256(manifest, MERCADO_PAGO_WEBHOOK_SECRET)
 *
 * O manifest NÃO usa o corpo da requisição — por isso o express.json() global
 * serve e não é preciso um raw body parser paralelo.
 *
 * O HMAC é conferido pelo `WebhookSignatureValidator` do SDK oficial, que já
 * compara em tempo constante e trata header ausente/malformado.
 *
 * A janela anti-replay fica aqui, e NÃO no `toleranceSeconds` do SDK: o
 * validador do SDK lê o `ts` como milissegundos (`Math.abs(Date.now() - ts)`),
 * enquanto o Mercado Pago envia segundos. Passar `toleranceSeconds` faria toda
 * notificação legítima ser recusada por TimestampOutOfTolerance. A checagem
 * abaixo aceita as duas unidades, para continuar valendo se o MP mudar.
 */

/** Janela de tolerância do ts, contra replay. */
const TOLERANCIA_SEGUNDOS = 300;

/** Acima disso o valor só pode estar em milissegundos (2001-09-09 em segundos). */
const LIMIAR_MILISSEGUNDOS = 1e12;

export interface ResultadoValidacao {
  valido: boolean;
  motivo?: string;
}

function tsEmSegundos(xSignature: string): number | null {
  for (const parte of xSignature.split(',')) {
    const idx = parte.indexOf('=');
    if (idx === -1) continue;

    if (parte.substring(0, idx).trim().toLowerCase() !== 'ts') continue;

    const bruto = Number(parte.substring(idx + 1).trim());
    if (!Number.isFinite(bruto) || bruto <= 0) return null;

    return bruto >= LIMIAR_MILISSEGUNDOS ? bruto / 1000 : bruto;
  }

  return null;
}

export function validateWebhookSignature(params: {
  xSignature?: string;
  xRequestId?: string;
  dataId?: string;
}): ResultadoValidacao {
  const secret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;

  if (!secret) {
    return { valido: false, motivo: 'MERCADO_PAGO_WEBHOOK_SECRET não configurada' };
  }

  try {
    WebhookSignatureValidator.validate({
      xSignature: params.xSignature,
      xRequestId: params.xRequestId,
      // O MP documenta: se data.id vier alfanumérico maiúsculo, usar minúsculo.
      // O validador do SDK não normaliza isso, então normalizamos antes.
      dataId: params.dataId ? params.dataId.toLowerCase() : params.dataId,
      secret,
    });
  } catch (erro) {
    if (erro instanceof InvalidWebhookSignatureError) {
      return { valido: false, motivo: erro.reason };
    }

    return { valido: false, motivo: 'falha ao validar assinatura' };
  }

  // Só chega aqui com o HMAC conferido, então o ts já está presente e numérico.
  const ts = tsEmSegundos(params.xSignature as string);

  if (ts === null) {
    return { valido: false, motivo: 'timestamp ausente no x-signature' };
  }

  if (Math.abs(Date.now() / 1000 - ts) > TOLERANCIA_SEGUNDOS) {
    return { valido: false, motivo: 'timestamp fora da janela de tolerância' };
  }

  return { valido: true };
}
