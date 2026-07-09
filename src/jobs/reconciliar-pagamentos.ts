import { PagamentoStatus } from '@prisma/client';
import { prisma } from '../lib/prisma/client.js';
import { AppError } from '../lib/errors.js';
import { logJson, mensagemDeErro } from '../lib/log.js';
import { sincronizarPagamento } from '../services/pagamento.service.js';

const IDADE_MINIMA_MS = 30 * 60 * 1000;
const TAMANHO_LOTE = 200;

export interface ResultadoReconciliacao {
  processados: number;
  atualizados: number;
  erros: number;
}

/**
 * RF-02. Webhook falha: rede cai, o MP sai do ar, o deploy está em cold start. Sem
 * isto, um pagamento aprovado fica `PENDING` para sempre e o participante não recebe
 * a inscrição. Pagamentos recentes não são tocados — o webhook ainda tem chance.
 */
export async function reconciliarPagamentos(): Promise<ResultadoReconciliacao> {
  const corte = new Date(Date.now() - IDADE_MINIMA_MS);

  const pagamentos = await prisma.pagamento.findMany({
    where: {
      status: { in: [PagamentoStatus.PENDING, PagamentoStatus.IN_PROCESS] },
      createdAt: { lt: corte },
    },
    orderBy: { createdAt: 'asc' },
    take: TAMANHO_LOTE,
  });

  const resultado: ResultadoReconciliacao = {
    processados: pagamentos.length,
    atualizados: 0,
    erros: 0,
  };

  for (const pagamento of pagamentos) {
    const inicio = Date.now();

    try {
      const statusNovo = await sincronizarPagamento(pagamento);

      if (statusNovo !== pagamento.status) {
        resultado.atualizados += 1;
      }

      logJson('info', {
        job: 'reconciliar-pagamentos',
        instituicaoId: pagamento.instituicaoId,
        pagamentoId: pagamento.id,
        mpPaymentId: pagamento.mpPaymentId,
        statusAnterior: pagamento.status,
        statusNovo,
        duracaoMs: Date.now() - inicio,
      });
    } catch (error) {
      // Igreja com a conta EXPIRED/REVOKED: o item é pulado, não é falha do job.
      const contaInativa = error instanceof AppError && error.code === 'MP_ACCOUNT_INACTIVE';

      if (!contaInativa) {
        resultado.erros += 1;
      }

      logJson(contaInativa ? 'warn' : 'error', {
        job: 'reconciliar-pagamentos',
        instituicaoId: pagamento.instituicaoId,
        pagamentoId: pagamento.id,
        mpPaymentId: pagamento.mpPaymentId,
        statusAnterior: pagamento.status,
        erro: mensagemDeErro(error),
        duracaoMs: Date.now() - inicio,
      });
    }
  }

  return resultado;
}
