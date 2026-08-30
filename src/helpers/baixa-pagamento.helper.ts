import { prisma } from '../lib/prisma/client.js';
import { logPb, logPbErro } from '../lib/pagbank/log.js';

/**
 * Registra a baixa financeira de um pagamento online aprovado.
 *
 * A integração PagBank grava em `pagbank_pagamentos`, uma tabela isolada. Mas
 * a tela do evento calcula "pago / pendente" somando `Parcela` — então, sem
 * esta ponte, uma inscrição paga com cartão continua aparecendo como pendente
 * para a organização do evento.
 *
 * É idempotente por construção: o PagBank reentrega notificações, e o
 * pagamento também é confirmado de forma síncrona no cartão. Criar a parcela
 * duas vezes dobraria o valor recebido no relatório.
 */
export async function registrarBaixaPagamento(pagamentoId: string): Promise<void> {
  const pagamento = await prisma.pagBankPagamento.findUnique({
    where: { id: pagamentoId },
  });

  if (!pagamento || pagamento.status !== 'PAID' || !pagamento.participanteProdutoId) {
    return;
  }

  const descricao = `Pagamento online PagBank (${pagamento.externalReference})`;

  // A tela de pagamentos usa um vocabulário próprio no seletor de método
  // ("Pix", "Crédito", "Débito", "Dinheiro") e o histórico manual está todo
  // nesses valores. Gravar "CREDIT_CARD" cru faz o campo aparecer vazio na
  // edição, porque não casa com nenhuma opção do select.
  const METODO_NA_TELA: Record<string, string> = {
    CREDIT_CARD: 'Crédito',
    DEBIT_CARD: 'Débito',
    PIX: 'Pix',
    BOLETO: 'Boleto',
  };

  const metodo = METODO_NA_TELA[pagamento.metodoPagamento ?? ''] ?? 'Pix';

  // A descrição carrega o externalReference, que é único por cobrança — é o
  // que permite reconhecer uma parcela já lançada sem adicionar coluna nova.
  const jaLancada = await prisma.parcela.findFirst({
    where: { participanteProdutoId: pagamento.participanteProdutoId, descricao },
  });

  if (jaLancada) {
    logPb('webhook.aplicado', {
      pagamentoId,
      baixa: 'ja_lancada',
      parcelaId: jaLancada.id,
    });
    return;
  }

  try {
    await prisma.$transaction([
      prisma.parcela.create({
        data: {
          participanteProdutoId: pagamento.participanteProdutoId,
          valor_pago: pagamento.valor,
          metodo_pagamento: metodo,
          // A tela só exibe "(Nx)" para crédito; em Pix e boleto o campo
          // ficaria como um "1x" sem sentido.
          numero_vezes: metodo === 'Crédito' ? pagamento.parcelasCartao : null,
          descricao,
          data_pagamento: pagamento.aprovadoEm ?? new Date(),
          instituicaoId: pagamento.instituicaoId,
        },
      }),
      prisma.participanteProdutos.update({
        where: { id: pagamento.participanteProdutoId },
        data: { data_pagamento: pagamento.aprovadoEm ?? new Date() },
      }),
    ]);

    logPb('webhook.aplicado', {
      pagamentoId,
      baixa: 'lancada',
      participanteProdutoId: pagamento.participanteProdutoId,
      valor: Number(pagamento.valor),
    });
  } catch (error) {
    // A baixa não pode derrubar o webhook: o pagamento no PagBank aconteceu de
    // qualquer forma, e devolver 500 faria o PagBank reenviar indefinidamente.
    logPbErro('webhook.aplicado', {
      pagamentoId,
      baixa: 'falhou',
      mensagem: String((error as Error)?.message ?? error).slice(0, 300),
    });
  }
}
