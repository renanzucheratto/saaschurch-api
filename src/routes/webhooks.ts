import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma/client.js';
import { validateWebhookSignature } from '../lib/mercadopago/signature.js';
import { chamarMp, clientePagamento } from '../lib/mercadopago/client.js';
import { getAccessTokenInstituicao } from '../lib/mercadopago/token.js';
import type { MpPagamentoStatus } from '@prisma/client';

const router = Router();

/** Status terminais: uma reentrega fora de ordem não pode rebaixá-los. */
const STATUS_TERMINAIS: MpPagamentoStatus[] = [
  'APPROVED',
  'REFUNDED',
  'CHARGED_BACK',
];

const MAPA_STATUS: Record<string, MpPagamentoStatus> = {
  pending: 'PENDING',
  in_process: 'IN_PROCESS',
  in_mediation: 'IN_PROCESS',
  authorized: 'IN_PROCESS',
  approved: 'APPROVED',
  rejected: 'REJECTED',
  refunded: 'REFUNDED',
  cancelled: 'CANCELLED',
  charged_back: 'CHARGED_BACK',
};

/**
 * POST /webhooks/mercadopago - rota PÚBLICA, autenticada por assinatura HMAC.
 *
 * O manifest do x-signature não usa o corpo da requisição, então o
 * express.json() global de server.ts serve — não é preciso raw body parser.
 *
 * Escreve exclusivamente em mp_pagamentos e mp_webhook_logs. Não cria Parcela,
 * não altera ParticipanteProdutos, não toca data_pagamento.
 *
 * A função tem 10s de teto na Vercel: validar, logar, buscar 1 pagamento,
 * atualizar. Nada de e-mail síncrono aqui.
 */
router.post('/mercadopago', async (req: Request, res: Response) => {
  const corpo = req.body ?? {};

  // data.id pode vir no corpo ou na query, dependendo do tipo de notificação.
  const dataId =
    corpo?.data?.id !== undefined
      ? String(corpo.data.id)
      : req.query['data.id']
        ? String(req.query['data.id'])
        : req.query.id
          ? String(req.query.id)
          : undefined;

  const validacao = validateWebhookSignature({
    xSignature: req.headers['x-signature'] as string | undefined,
    xRequestId: req.headers['x-request-id'] as string | undefined,
    dataId,
  });

  if (!validacao.valido) {
    console.error('Webhook Mercado Pago rejeitado:', validacao.motivo);
    return res.status(401).json({ error: 'Assinatura inválida' });
  }

  const tipo = String(corpo.type || corpo.topic || req.query.type || 'desconhecido');
  const action = String(corpo.action || '');
  const mpEventId = String(corpo.id || dataId || '');

  if (!mpEventId) {
    return res.status(400).json({ error: 'Notificação sem identificador' });
  }

  let logId: string;

  try {
    const existente = await prisma.mpWebhookLog.findUnique({
      where: { mpEventId_tipo_action: { mpEventId, tipo, action } },
    });

    // Reentrega de algo já processado: responde 200 e sai.
    if (existente?.processado) {
      return res.status(200).json({ recebido: true, duplicado: true });
    }

    const log = existente
      ? await prisma.mpWebhookLog.update({
          where: { id: existente.id },
          data: { tentativas: { increment: 1 }, payload: corpo },
        })
      : await prisma.mpWebhookLog.create({
          data: { mpEventId, tipo, action, payload: corpo, tentativas: 1 },
        });

    logId = log.id;
  } catch (error) {
    console.error('Erro ao registrar webhook Mercado Pago:', error);
    return res.status(500).json({ error: 'Erro ao registrar notificação' });
  }

  try {
    // Só pagamento interessa nesta entrega. Outros tópicos ficam logados.
    if (tipo !== 'payment') {
      await prisma.mpWebhookLog.update({
        where: { id: logId },
        data: { processado: true, processadoEm: new Date() },
      });
      return res.status(200).json({ recebido: true, ignorado: tipo });
    }

    if (!dataId) {
      await prisma.mpWebhookLog.update({
        where: { id: logId },
        data: { processado: true, processadoEm: new Date(), erro: 'sem data.id' },
      });
      return res.status(200).json({ recebido: true });
    }

    // A notificação do MP carrega apenas data.id (o payment). O external
    // reference vai no query da notification_url que nós mesmos montamos na
    // criação da preference — é o que amarra o payment à instituição.
    const ref = req.query.ref ? String(req.query.ref) : undefined;

    const pagamento = ref
      ? await prisma.mpPagamento.findUnique({ where: { externalReference: ref } })
      : await prisma.mpPagamento.findFirst({ where: { mpPaymentId: dataId } });

    if (!pagamento) {
      // Pode ser pagamento de outra origem na mesma conta. Não é erro nosso.
      await prisma.mpWebhookLog.update({
        where: { id: logId },
        data: {
          processado: true,
          processadoEm: new Date(),
          erro: 'pagamento não encontrado localmente',
        },
      });
      return res.status(200).json({ recebido: true, vinculado: false });
    }

    const accessToken = await getAccessTokenInstituicao(pagamento.instituicaoId);

    // Nunca confiar no status do payload: consultar a fonte.
    const pagamentoMp = await chamarMp(`GET /v1/payments/${dataId}`, () =>
      clientePagamento(accessToken).get({ id: dataId }),
    );

    // O ref vem de uma URL que nós montamos, mas quem chama o webhook é externo.
    // Conferir que o payment realmente aponta para este registro evita que uma
    // notificação com ref trocado atualize o pagamento errado.
    if (
      pagamentoMp.external_reference &&
      pagamentoMp.external_reference !== pagamento.externalReference
    ) {
      await prisma.mpWebhookLog.update({
        where: { id: logId },
        data: {
          processado: true,
          processadoEm: new Date(),
          erro: 'external_reference divergente',
        },
      });
      return res.status(200).json({ recebido: true, vinculado: false });
    }

    // Todo campo do PaymentResponse é opcional no SDK: sem status não dá para
    // decidir transição, e assumir PENDING poderia rebaixar um pagamento pago.
    if (!pagamentoMp.status) {
      await prisma.mpWebhookLog.update({
        where: { id: logId },
        data: {
          processado: true,
          processadoEm: new Date(),
          erro: 'payment sem status',
        },
      });
      return res.status(200).json({ recebido: true, vinculado: false });
    }

    const novoStatus = MAPA_STATUS[pagamentoMp.status] ?? 'PENDING';

    // Transição só avança: reentrega antiga não rebaixa um estado terminal.
    if (STATUS_TERMINAIS.includes(pagamento.status) && novoStatus !== pagamento.status) {
      await prisma.mpWebhookLog.update({
        where: { id: logId },
        data: {
          processado: true,
          processadoEm: new Date(),
          erro: `ignorado: ${pagamento.status} -> ${novoStatus}`,
        },
      });
      return res.status(200).json({ recebido: true, ignorado: 'status_terminal' });
    }

    await prisma.mpPagamento.update({
      where: { id: pagamento.id },
      data: {
        // id vem opcional no tipo do SDK; o data.id da notificação é o mesmo
        // payment e já foi usado para buscá-lo.
        mpPaymentId: pagamentoMp.id !== undefined ? String(pagamentoMp.id) : dataId,
        status: novoStatus,
        statusDetail: pagamentoMp.status_detail ?? null,
        metodoPagamento: pagamentoMp.payment_method_id ?? null,
        parcelasCartao: pagamentoMp.installments ?? 1,
        aprovadoEm:
          novoStatus === 'APPROVED'
            ? pagamentoMp.date_approved
              ? new Date(pagamentoMp.date_approved)
              : new Date()
            : pagamento.aprovadoEm,
      },
    });

    await prisma.mpWebhookLog.update({
      where: { id: logId },
      data: { processado: true, processadoEm: new Date(), erro: null },
    });

    return res.status(200).json({ recebido: true, status: novoStatus });
  } catch (error: any) {
    const mensagem = String(error?.message ?? error).slice(0, 500);
    console.error('Erro ao processar webhook Mercado Pago:', mensagem);

    await prisma.mpWebhookLog
      .update({ where: { id: logId }, data: { erro: mensagem } })
      .catch(() => undefined);

    // 500 faz o Mercado Pago reenviar a notificação.
    return res.status(500).json({ error: 'Erro ao processar notificação' });
  }
});

export default router;
