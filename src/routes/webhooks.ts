import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../lib/prisma/client.js';
import { validateWebhookSignature } from '../lib/pagbank/signature.js';
import { getAccessTokenInstituicao } from '../lib/pagbank/token.js';
import { consultarCharge } from '../lib/pagbank/orders.js';
import { consultarAssinatura } from '../lib/pagbank/assinaturas.js';
import { logPb, logPbErro } from '../lib/pagbank/log.js';
import { registrarBaixaPagamento } from '../helpers/baixa-pagamento.helper.js';
import type { PagBankPagamentoStatus, AssinaturaStatus } from '@prisma/client';

const router = Router();

/** Status terminais: uma reentrega fora de ordem não pode rebaixá-los. */
const STATUS_TERMINAIS: PagBankPagamentoStatus[] = ['PAID', 'REFUNDED'];

const MAPA_STATUS: Record<string, PagBankPagamentoStatus> = {
  WAITING: 'WAITING',
  IN_ANALYSIS: 'IN_ANALYSIS',
  AUTHORIZED: 'AUTHORIZED',
  PAID: 'PAID',
  DECLINED: 'DECLINED',
  CANCELED: 'CANCELED',
  REFUNDED: 'REFUNDED',
};

/**
 * POST /webhooks/pagbank - rota PÚBLICA, autenticada por x-authenticity-token.
 *
 * O manifest da assinatura USA o corpo da requisição — diferente do Mercado
 * Pago — então a validação depende do buffer bruto capturado pelo `verify`
 * do `express.json()` em server.ts (`req.rawBody`). Sem esse buffer, a
 * assinatura nunca fecha.
 *
 * Ao confirmar um pagamento, lança uma Parcela e marca data_pagamento na
 * inscrição — sem isso a organização do evento vê como pendente algo que já
 * foi pago. Ver `registrarBaixaPagamento`, que é idempotente.
 */
router.post('/pagbank', async (req: Request, res: Response) => {
  const corpo = req.body ?? {};
  const rawBody = (req as Request & { rawBody?: string }).rawBody ?? '';
  const ref = req.query.ref ? String(req.query.ref) : undefined;

  const pedidoId: string | undefined = corpo?.id;
  const chargeId: string | undefined = corpo?.charges?.[0]?.id;

  logPb('webhook.recebido', {
    ref: ref ?? null,
    origem: req.headers['x-product-origin'] ?? null,
    pagbankOrderId: pedidoId ?? null,
    pagbankChargeId: chargeId ?? null,
  });

  if (!ref) {
    // Sem ref não há como saber a instituição (e portanto o token) que valida
    // a assinatura nem que grava o pagamento. Aceita e ignora — não é um erro
    // nosso, mas também não há o que processar.
    return res.status(200).json({ recebido: true, vinculado: false });
  }

  const pagamento = await prisma.pagBankPagamento.findUnique({
    where: { externalReference: ref },
  });

  if (!pagamento) {
    return res.status(200).json({ recebido: true, vinculado: false });
  }

  let accessToken: string;

  try {
    accessToken = await getAccessTokenInstituicao(pagamento.instituicaoId);
  } catch (error) {
    logPbErro('webhook.recebido', {
      ref,
      etapa: 'obter_token',
      mensagem: String((error as Error)?.message ?? error),
    });
    // 200: reenviar não vai ajudar se a conta está desconectada; fica como
    // não processado no log para investigação manual.
    return res.status(200).json({ recebido: true, vinculado: false, motivo: 'sem_token' });
  }

  const validacao = validateWebhookSignature({
    xAuthenticityToken: req.headers['x-authenticity-token'] as string | undefined,
    accountToken: accessToken,
    rawBody,
  });

  if (!validacao.valido) {
    logPbErro('webhook.recebido', {
      ref,
      etapa: 'assinatura',
      motivo: validacao.motivo,
      candidatosTestados: validacao.candidatosTestados,
      headerPresente: Boolean(req.headers['x-authenticity-token']),
      tamanhoCorpoBruto: rawBody.length,
    });
    return res.status(401).json({ error: 'Assinatura inválida' });
  }

  logPb('webhook.recebido', { ref, etapa: 'assinatura_ok', tokenUsado: validacao.tokenUsado });

  const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');

  let logId: string;

  try {
    const existente = await prisma.pagBankWebhookLog.findUnique({ where: { payloadHash } });

    if (existente?.processado) {
      return res.status(200).json({ recebido: true, duplicado: true });
    }

    const log = existente
      ? await prisma.pagBankWebhookLog.update({
          where: { id: existente.id },
          data: { tentativas: { increment: 1 }, payload: corpo },
        })
      : await prisma.pagBankWebhookLog.create({
          data: {
            payloadHash,
            origem: String(req.headers['x-product-origin'] ?? 'desconhecido'),
            pagbankOrderId: pedidoId ?? null,
            pagbankChargeId: chargeId ?? null,
            payload: corpo,
            tentativas: 1,
          },
        });

    logId = log.id;
  } catch (error) {
    console.error('Erro ao registrar webhook PagBank:', error);
    return res.status(500).json({ error: 'Erro ao registrar notificação' });
  }

  try {
    if (!chargeId) {
      await prisma.pagBankWebhookLog.update({
        where: { id: logId },
        data: { processado: true, processadoEm: new Date(), erro: 'sem charge id' },
      });
      return res.status(200).json({ recebido: true });
    }

    logPb('webhook.vinculo', {
      chargeId,
      ref,
      pagamentoId: pagamento.id,
      instituicaoId: pagamento.instituicaoId,
      statusLocal: pagamento.status,
    });

    // Nunca confiar no status do payload: consultar a fonte.
    const charge = await consultarCharge(accessToken, chargeId);

    logPb('webhook.charge', {
      chargeId: charge.id,
      status: charge.status,
      metodo: charge.payment_method?.type ?? null,
      valor: charge.amount?.value ?? null,
      mensagem: charge.payment_response?.message ?? null,
    });

    if (charge.reference_id && charge.reference_id !== pagamento.externalReference) {
      await prisma.pagBankWebhookLog.update({
        where: { id: logId },
        data: {
          processado: true,
          processadoEm: new Date(),
          erro: 'reference_id divergente',
        },
      });
      return res.status(200).json({ recebido: true, vinculado: false });
    }

    const novoStatus = MAPA_STATUS[charge.status] ?? 'IN_ANALYSIS';

    // Transição só avança: reentrega antiga não rebaixa um estado terminal.
    if (STATUS_TERMINAIS.includes(pagamento.status) && novoStatus !== pagamento.status) {
      await prisma.pagBankWebhookLog.update({
        where: { id: logId },
        data: {
          processado: true,
          processadoEm: new Date(),
          erro: `ignorado: ${pagamento.status} -> ${novoStatus}`,
        },
      });
      return res.status(200).json({ recebido: true, ignorado: 'status_terminal' });
    }

    await prisma.pagBankPagamento.update({
      where: { id: pagamento.id },
      data: {
        pagbankChargeId: charge.id,
        status: novoStatus,
        statusDetail: charge.payment_response?.message ?? null,
        metodoPagamento: charge.payment_method?.type ?? pagamento.metodoPagamento,
        aprovadoEm: novoStatus === 'PAID' ? new Date() : pagamento.aprovadoEm,
      },
    });

    await prisma.pagBankWebhookLog.update({
      where: { id: logId },
      data: { processado: true, processadoEm: new Date(), erro: null },
    });

    logPb('webhook.aplicado', {
      pagamentoId: pagamento.id,
      instituicaoId: pagamento.instituicaoId,
      de: pagamento.status,
      para: novoStatus,
    });

    // Aprovado: lança a parcela para a inscrição aparecer como paga na tela
    // do evento. Idempotente — o cartão já pode ter lançado no fluxo síncrono.
    if (novoStatus === 'PAID') {
      await registrarBaixaPagamento(pagamento.id);
    }

    return res.status(200).json({ recebido: true, status: novoStatus });
  } catch (error: any) {
    const mensagem = String(error?.message ?? error).slice(0, 500);
    logPbErro('webhook.recebido', { chargeId, etapa: 'processamento', mensagem });
    console.error('Erro ao processar webhook PagBank:', mensagem);

    await prisma.pagBankWebhookLog
      .update({ where: { id: logId }, data: { erro: mensagem } })
      .catch(() => undefined);

    // 500 faz o PagBank reenviar a notificação.
    return res.status(500).json({ error: 'Erro ao processar notificação' });
  }
});

const MAPA_STATUS_ASSINATURA: Record<string, AssinaturaStatus> = {
  NEW: 'PENDING',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  OVERDUE: 'ACTIVE', // em atraso, mas ainda ativa — cobrança será retentada
  CANCELED: 'CANCELLED',
  EXPIRED: 'CANCELLED',
};

/**
 * POST /webhooks/pagbank-assinaturas - rota PÚBLICA (mensalidade da
 * plataforma, produto Assinaturas — não confundir com o webhook de Orders
 * acima, que é o pagamento de inscrições de evento).
 *
 * A documentação da API de Assinaturas não especifica um header de
 * autenticidade (ao contrário de Orders, que usa x-authenticity-token) — por
 * isso esta rota NÃO confia em nada do corpo recebido: usa o `resource.id`
 * só para saber QUAL assinatura consultar, e escreve no banco apenas o que
 * `consultarAssinatura` (GET direto na API, com o token da plataforma)
 * devolver. Um payload forjado, na pior hipótese, causa uma consulta
 * redundante — nunca um dado falso persistido.
 */
router.post('/pagbank-assinaturas', async (req: Request, res: Response) => {
  const corpo = req.body ?? {};
  const assinaturaId: string | undefined = corpo?.resource?.id;

  logPb('assinatura.webhook', { evento: corpo?.event ?? null, assinaturaId: assinaturaId ?? null });

  if (!assinaturaId) {
    return res.status(200).json({ recebido: true });
  }

  try {
    const assinatura = await prisma.assinatura.findUnique({
      where: { pagbankAssinaturaId: assinaturaId },
    });

    if (!assinatura) {
      return res.status(200).json({ recebido: true, vinculado: false });
    }

    const fonte = await consultarAssinatura(assinaturaId);
    const novoStatus = MAPA_STATUS_ASSINATURA[fonte.status] ?? assinatura.status;

    await prisma.assinatura.update({
      where: { id: assinatura.id },
      data: {
        status: novoStatus,
        proximaCobranca: fonte.next_invoice_at ? new Date(fonte.next_invoice_at) : assinatura.proximaCobranca,
        canceladaEm: novoStatus === 'CANCELLED' ? (assinatura.canceladaEm ?? new Date()) : assinatura.canceladaEm,
      },
    });

    return res.status(200).json({ recebido: true, status: novoStatus });
  } catch (error) {
    console.error('Erro ao processar webhook de assinatura PagBank:', error);
    return res.status(500).json({ error: 'Erro ao processar notificação' });
  }
});

export default router;
