import { prisma } from '../lib/prisma/client.js';
import { getAccessTokenInstituicao } from '../lib/pagbank/token.js';
import { consultarCharge } from '../lib/pagbank/orders.js';
import { logPb, logPbErro } from '../lib/pagbank/log.js';
import { registrarBaixaPagamento } from './baixa-pagamento.helper.js';
import type { PagBankPagamento, PagBankPagamentoStatus } from '@prisma/client';

/** Status terminais: uma leitura fora de ordem não pode rebaixá-los. */
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
 * Sincroniza um pagamento com a fonte (o charge no PagBank).
 *
 * O webhook é a via rápida, mas não pode ser a ÚNICA: notificação perdida,
 * túnel de desenvolvimento fora do ar ou assinatura recusada deixariam uma
 * inscrição paga aparecendo como pendente para sempre. Como a tela de
 * pagamento já consulta este pagamento em intervalos regulares enquanto
 * espera o Pix, essa consulta também confere a fonte — o webhook vira
 * otimização, não dependência.
 *
 * Devolve o pagamento (atualizado, se algo mudou).
 */
export async function sincronizarPagamento(
  pagamento: PagBankPagamento,
): Promise<PagBankPagamento> {
  // Terminal não muda mais; e sem charge ainda não há o que consultar.
  if (STATUS_TERMINAIS.includes(pagamento.status) || !pagamento.pagbankChargeId) {
    return pagamento;
  }

  try {
    const token = await getAccessTokenInstituicao(pagamento.instituicaoId);
    const charge = await consultarCharge(token, pagamento.pagbankChargeId);

    const novoStatus = MAPA_STATUS[charge.status] ?? pagamento.status;

    if (novoStatus === pagamento.status) {
      return pagamento;
    }

    const atualizado = await prisma.pagBankPagamento.update({
      where: { id: pagamento.id },
      data: {
        status: novoStatus,
        statusDetail: charge.payment_response?.message ?? pagamento.statusDetail,
        aprovadoEm: novoStatus === 'PAID' ? (pagamento.aprovadoEm ?? new Date()) : pagamento.aprovadoEm,
      },
    });

    logPb('webhook.aplicado', {
      pagamentoId: pagamento.id,
      origem: 'consulta_direta',
      de: pagamento.status,
      para: novoStatus,
    });

    if (novoStatus === 'PAID') {
      await registrarBaixaPagamento(atualizado.id);
    }

    return atualizado;
  } catch (error) {
    // Consulta é oportunista: falhar aqui não pode quebrar a tela, que segue
    // mostrando o último status conhecido e tenta de novo no próximo ciclo.
    logPbErro('pb.erro', {
      pagamentoId: pagamento.id,
      etapa: 'sincronizacao_direta',
      mensagem: String((error as Error)?.message ?? error).slice(0, 300),
    });

    return pagamento;
  }
}
