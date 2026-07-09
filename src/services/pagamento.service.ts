import 'dotenv/config';
import crypto from 'node:crypto';
import { PagamentoStatus, Prisma } from '@prisma/client';
import type { Pagamento } from '@prisma/client';
import { prisma } from '../lib/prisma/client.js';
import { AppError } from '../lib/errors.js';
import { mpFetch } from '../lib/mercadopago/client.js';
import { obterAccessTokenDaIgreja, obterContaAtiva } from './payment-connect.service.js';
import { calcularFee, resolverPlano, temFeature } from './plano.service.js';

const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;

interface PagamentoMP {
  id: number | string;
  status: string;
  status_detail?: string;
  payment_method_id?: string;
  installments?: number;
  date_approved?: string | null;
  point_of_interaction?: {
    transaction_data?: {
      qr_code?: string;
      qr_code_base64?: string;
    };
  };
  date_of_expiration?: string | null;
}

const MAPA_STATUS: Record<string, PagamentoStatus> = {
  pending: PagamentoStatus.PENDING,
  in_process: PagamentoStatus.IN_PROCESS,
  in_mediation: PagamentoStatus.IN_PROCESS,
  authorized: PagamentoStatus.APPROVED,
  approved: PagamentoStatus.APPROVED,
  rejected: PagamentoStatus.REJECTED,
  cancelled: PagamentoStatus.CANCELLED,
  refunded: PagamentoStatus.REFUNDED,
  charged_back: PagamentoStatus.REFUNDED,
};

export function mapearStatusPagamento(status: string): PagamentoStatus {
  return MAPA_STATUS[status?.toLowerCase()] ?? PagamentoStatus.PENDING;
}

export interface DadosCriacaoPagamento {
  eventoId: string;
  participanteId: string;
  produtoIds: string[];
  token?: string;
  paymentMethodId: string;
  installments?: number;
  payer: {
    email: string;
    identification?: { type: string; number: string };
  };
}

/**
 * `sha256(participanteId + produtoIds ordenados + valor)`. Determinística: o mesmo
 * carrinho reenviado bate na `@unique` de `idempotencyKey` e devolve o pagamento existente.
 */
export function gerarIdempotencyKey(
  participanteId: string,
  produtoIds: string[],
  valor: Decimal,
): string {
  const material = [participanteId, [...produtoIds].sort().join(','), valor.toFixed(2)].join('|');
  return crypto.createHash('sha256').update(material).digest('hex');
}

async function carregarEventoComInstituicao(eventoId: string) {
  const evento = await prisma.eventos.findUnique({ where: { id: eventoId } });

  if (!evento?.instituicaoId) {
    throw new AppError(404, 'EVENTO_NAO_ENCONTRADO');
  }

  return { evento, instituicaoId: evento.instituicaoId };
}

async function exigirFeaturePagamentos(instituicaoId: string) {
  const plano = await resolverPlano(instituicaoId);

  // Rota pública: o gate de rota (`requireFeature`) depende de `req.user`, que aqui
  // não existe. A mesma pergunta é feita ao plano, com o mesmo código de erro.
  if (!temFeature(plano, 'pagamentosOnline')) {
    throw new AppError(403, 'FEATURE_INDISPONIVEL', { feature: 'pagamentosOnline' });
  }

  return plano;
}

/** RF-01. A `publicKey` é a da igreja e vem em runtime — nunca de env do frontend. */
export async function obterCheckoutConfig(eventoId: string) {
  const { instituicaoId } = await carregarEventoComInstituicao(eventoId);

  await exigirFeaturePagamentos(instituicaoId);

  const conta = await obterContaAtiva(instituicaoId);

  const produtos = await prisma.produtosEvento.findMany({
    where: { eventoId, exigePagamento: true, oculto: false },
    orderBy: { nome: 'asc' },
  });

  return {
    publicKey: conta.publicKey,
    produtos: produtos.map((produto) => ({
      id: produto.id,
      nome: produto.nome,
      descricao: produto.descricao,
      valor: produto.valor.toFixed(2),
    })),
  };
}

/**
 * RF-02/RF-03/RF-04. O valor **sempre** vem de `ProdutosEvento.valor` no banco;
 * o cliente não manda preço. O `application_fee` sai do plano e é congelado no registro.
 */
export async function criarPagamento(dados: DadosCriacaoPagamento) {
  const { evento, instituicaoId } = await carregarEventoComInstituicao(dados.eventoId);

  const plano = await exigirFeaturePagamentos(instituicaoId);

  if (!dados.produtoIds?.length) {
    throw new AppError(422, 'PRODUTO_NAO_INFORMADO');
  }

  const participante = await prisma.participantes.findUnique({
    where: { id: dados.participanteId },
  });

  if (!participante || participante.eventoId !== evento.id) {
    throw new AppError(422, 'PARTICIPANTE_INVALIDO');
  }

  const produtos = await prisma.produtosEvento.findMany({
    where: { id: { in: dados.produtoIds }, eventoId: evento.id },
  });

  if (produtos.length !== dados.produtoIds.length) {
    throw new AppError(422, 'PRODUTO_NAO_PERTENCE_AO_EVENTO');
  }

  if (produtos.some((produto) => !produto.exigePagamento)) {
    throw new AppError(422, 'PRODUTO_NAO_PAGAVEL');
  }

  const bruto = produtos.reduce((total, produto) => total.plus(produto.valor), new Decimal(0));

  if (bruto.lte(0)) {
    throw new AppError(422, 'VALOR_DIVERGENTE');
  }

  const idempotencyKey = gerarIdempotencyKey(dados.participanteId, dados.produtoIds, bruto);

  const jaExiste = await prisma.pagamento.findUnique({ where: { idempotencyKey } });

  if (jaExiste) {
    return montarRespostaCriacao(jaExiste, null);
  }

  const fee = calcularFee(plano, bruto);
  const accessToken = await obterAccessTokenDaIgreja(instituicaoId);

  // O id local é gerado antes da chamada para viajar no `external_reference` — é
  // por ele que o webhook descobre a igreja e o token com que reconsultar o MP.
  const pagamentoId = crypto.randomUUID();
  const ehPix = dados.paymentMethodId === 'pix';

  const pagamentoMP = await mpFetch<PagamentoMP>('/v1/payments', {
    method: 'POST',
    accessToken,
    idempotencyKey,
    body: {
      transaction_amount: Number(bruto.toFixed(2)),
      description: `${evento.nome} — ${produtos.map((p) => p.nome).join(', ')}`,
      payment_method_id: dados.paymentMethodId,
      external_reference: pagamentoId,
      notification_url: `${process.env.API_URL}/webhooks/mercadopago`,
      payer: dados.payer,
      ...(ehPix ? {} : { token: dados.token, installments: dados.installments ?? 1 }),
      // `application_fee: null` é rejeitado pelo MP; fee zero simplesmente não vai.
      ...(fee.gt(0) ? { application_fee: Number(fee.toFixed(2)) } : {}),
    },
  });

  const vinculo = await resolverVinculo(dados.participanteId, dados.produtoIds);

  const pagamento = await prisma.pagamento.create({
    data: {
      id: pagamentoId,
      instituicaoId,
      participanteId: dados.participanteId,
      participanteProdutoId: vinculo.participanteProdutoId,
      parcelaId: vinculo.parcelaId,
      mpPaymentId: String(pagamentoMP.id),
      idempotencyKey,
      status: mapearStatusPagamento(pagamentoMP.status),
      statusDetail: pagamentoMP.status_detail ?? null,
      valor: bruto,
      applicationFee: fee,
      feePercentualAplicado: plano.feeEventoPercentual,
      metodoPagamento: pagamentoMP.payment_method_id ?? dados.paymentMethodId,
      parcelasCartao: pagamentoMP.installments ?? dados.installments ?? 1,
      aprovadoEm: pagamentoMP.date_approved ? new Date(pagamentoMP.date_approved) : null,
    },
  });

  if (pagamento.status === PagamentoStatus.APPROVED) {
    await liquidarParcela(pagamento);
  }

  return montarRespostaCriacao(pagamento, pagamentoMP);
}

function montarRespostaCriacao(pagamento: Pagamento, pagamentoMP: PagamentoMP | null) {
  const qr = pagamentoMP?.point_of_interaction?.transaction_data;

  return {
    pagamentoId: pagamento.id,
    mpPaymentId: pagamento.mpPaymentId,
    status: pagamento.status,
    statusDetail: pagamento.statusDetail,
    ...(qr?.qr_code
      ? {
          pix: {
            qrCode: qr.qr_code,
            qrCodeBase64: qr.qr_code_base64 ?? null,
            expiraEm: pagamentoMP?.date_of_expiration ?? null,
          },
        }
      : {}),
  };
}

/**
 * `Parcela` pende de `ParticipanteProdutos`, não de `Participantes`. Só há um vínculo
 * inequívoco quando o carrinho tem um produto — em compra múltipla, ficam nulos.
 */
async function resolverVinculo(participanteId: string, produtoIds: string[]) {
  if (produtoIds.length !== 1) {
    return { participanteProdutoId: null, parcelaId: null };
  }

  const participanteProduto = await prisma.participanteProdutos.findUnique({
    where: { participanteId_produtoId: { participanteId, produtoId: produtoIds[0] } },
    include: { parcelas: { where: { data_pagamento: null }, orderBy: { createdAt: 'asc' } } },
  });

  if (!participanteProduto) {
    return { participanteProdutoId: null, parcelaId: null };
  }

  const parcelaLivre = await primeiraParcelaSemPagamento(participanteProduto.parcelas);

  return {
    participanteProdutoId: participanteProduto.id,
    parcelaId: parcelaLivre?.id ?? null,
  };
}

async function primeiraParcelaSemPagamento(parcelas: { id: string }[]) {
  for (const parcela of parcelas) {
    const ocupada = await prisma.pagamento.findUnique({ where: { parcelaId: parcela.id } });
    if (!ocupada) return parcela;
  }

  return null;
}

/**
 * Reconsulta o MP e aplica o status real. Único ponto de escrita de status —
 * usado tanto pelo webhook (BE-005) quanto pelo reconciliador (BE-006).
 */
export async function sincronizarPagamentoPorMpId(mpPaymentId: string): Promise<void> {
  const pagamento = await prisma.pagamento.findUnique({ where: { mpPaymentId } });

  if (!pagamento) {
    console.warn(JSON.stringify({ evento: 'pagamento_sem_registro_local', mpPaymentId }));
    return;
  }

  await sincronizarPagamento(pagamento);
}

export async function sincronizarPagamento(pagamento: Pagamento): Promise<PagamentoStatus> {
  const accessToken = await obterAccessTokenDaIgreja(pagamento.instituicaoId);

  const pagamentoMP = await mpFetch<PagamentoMP>(`/v1/payments/${pagamento.mpPaymentId}`, {
    accessToken,
  });

  const status = mapearStatusPagamento(pagamentoMP.status);

  if (status === pagamento.status) {
    return status;
  }

  const atualizado = await prisma.pagamento.update({
    where: { id: pagamento.id },
    data: {
      status,
      statusDetail: pagamentoMP.status_detail ?? pagamento.statusDetail,
      metodoPagamento: pagamentoMP.payment_method_id ?? pagamento.metodoPagamento,
      aprovadoEm:
        status === PagamentoStatus.APPROVED
          ? pagamentoMP.date_approved
            ? new Date(pagamentoMP.date_approved)
            : new Date()
          : pagamento.aprovadoEm,
    },
  });

  if (status === PagamentoStatus.APPROVED) {
    await liquidarParcela(atualizado);
  }

  return status;
}

/**
 * Preenche a `Parcela` na aprovação. Idempotente: só escreve quando a parcela
 * ainda não tem `data_pagamento`, então rodar o job duas vezes não soma o valor duas vezes.
 */
async function liquidarParcela(pagamento: Pagamento): Promise<void> {
  if (pagamento.parcelaId) {
    await prisma.parcela.updateMany({
      where: { id: pagamento.parcelaId, data_pagamento: null },
      data: {
        valor_pago: pagamento.valor,
        data_pagamento: pagamento.aprovadoEm ?? new Date(),
        metodo_pagamento: pagamento.metodoPagamento,
      },
    });
    return;
  }

  if (!pagamento.participanteProdutoId) {
    return;
  }

  const parcela = await prisma.parcela.create({
    data: {
      participanteProdutoId: pagamento.participanteProdutoId,
      instituicaoId: pagamento.instituicaoId,
      valor_pago: pagamento.valor,
      data_pagamento: pagamento.aprovadoEm ?? new Date(),
      metodo_pagamento: pagamento.metodoPagamento,
      descricao: 'Pagamento online',
    },
  });

  await prisma.pagamento.update({
    where: { id: pagamento.id },
    data: { parcelaId: parcela.id },
  });
}

/** RF-05. Rota pública: devolve status, nunca dados do participante. */
export async function obterStatusPagamento(id: string) {
  const pagamento = await prisma.pagamento.findUnique({ where: { id } });

  if (!pagamento) {
    throw new AppError(404, 'PAGAMENTO_NAO_ENCONTRADO');
  }

  return {
    status: pagamento.status,
    statusDetail: pagamento.statusDetail,
    aprovadoEm: pagamento.aprovadoEm,
  };
}

/** RF-06. Totais somam apenas os aprovados — pendente não é receita. */
export async function listarPagamentosDoEvento(eventoId: string, instituicaoId: string) {
  const pagamentos = await prisma.pagamento.findMany({
    where: { instituicaoId, participante: { eventoId } },
    include: { participante: { select: { id: true, nome: true, email: true } } },
    orderBy: { createdAt: 'desc' },
  });

  const aprovados = pagamentos.filter((p) => p.status === PagamentoStatus.APPROVED);

  const bruto = aprovados.reduce((total, p) => total.plus(p.valor), new Decimal(0));
  const fee = aprovados.reduce((total, p) => total.plus(p.applicationFee), new Decimal(0));

  return {
    pagamentos: pagamentos.map((pagamento) => ({
      id: pagamento.id,
      mpPaymentId: pagamento.mpPaymentId,
      status: pagamento.status,
      statusDetail: pagamento.statusDetail,
      valor: pagamento.valor.toFixed(2),
      applicationFee: pagamento.applicationFee.toFixed(2),
      feePercentualAplicado: pagamento.feePercentualAplicado.toFixed(2),
      metodoPagamento: pagamento.metodoPagamento,
      parcelasCartao: pagamento.parcelasCartao,
      aprovadoEm: pagamento.aprovadoEm,
      createdAt: pagamento.createdAt,
      participante: pagamento.participante,
    })),
    totais: {
      bruto: bruto.toFixed(2),
      fee: fee.toFixed(2),
      liquido: bruto.minus(fee).toFixed(2),
    },
  };
}
