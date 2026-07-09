import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma/client.js';
import { sincronizarPagamentoPorMpId } from './pagamento.service.js';
import { sincronizarPreapproval } from './billing.service.js';

export const TIPO_PAYMENT = 'payment';
export const TIPO_PREAPPROVAL = 'subscription_preapproval';

export type ResultadoWebhook = 'PROCESSADO' | 'JA_PROCESSADO' | 'NAO_ROTEADO';

export interface EntradaWebhook {
  mpEventId: string;
  tipo: string;
  action: string | null;
  payload: unknown;
}

/**
 * Idempotência pela tripla `(mpEventId, tipo, action)`.
 *
 * O MP manda o mesmo `data.id` em `payment.created` e `payment.updated`; deduplicar
 * só por `mpEventId` descartaria o `updated`, que é justamente o evento que confirma
 * a aprovação. Em Postgres, `NULL` não colide em índice único, então um `action`
 * ausente vira string vazia — senão a linha nunca deduplicaria.
 */
export async function processarWebhook(entrada: EntradaWebhook): Promise<ResultadoWebhook> {
  const action = entrada.action ?? '';

  const log = await prisma.webhookLog.upsert({
    where: {
      mpEventId_tipo_action: { mpEventId: entrada.mpEventId, tipo: entrada.tipo, action },
    },
    create: {
      mpEventId: entrada.mpEventId,
      tipo: entrada.tipo,
      action,
      payload: (entrada.payload ?? {}) as Prisma.InputJsonValue,
    },
    update: {},
  });

  if (log.processado) {
    return 'JA_PROCESSADO';
  }

  try {
    const roteado = await rotear(entrada.tipo, entrada.mpEventId);

    await prisma.webhookLog.update({
      where: { id: log.id },
      data: { processado: true, processadoEm: new Date(), erro: null },
    });

    return roteado ? 'PROCESSADO' : 'NAO_ROTEADO';
  } catch (error) {
    // `processado` permanece false e o erro sobe: a rota responde 500 e o MP
    // re-tenta com backoff por até 8h. Responder 200 aqui perderia o evento.
    await prisma.webhookLog.update({
      where: { id: log.id },
      data: {
        erro: error instanceof Error ? error.message : 'Erro desconhecido',
        tentativas: { increment: 1 },
      },
    });

    throw error;
  }
}

/** Nunca decide pelo payload: o handler reconsulta o recurso na API do MP. */
async function rotear(tipo: string, mpEventId: string): Promise<boolean> {
  switch (tipo) {
    case TIPO_PAYMENT:
      await sincronizarPagamentoPorMpId(mpEventId);
      return true;

    case TIPO_PREAPPROVAL:
      await sincronizarPreapproval(mpEventId);
      return true;

    default:
      console.warn(JSON.stringify({ evento: 'webhook_nao_roteado', tipo, mpEventId }));
      return false;
  }
}
