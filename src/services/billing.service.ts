import 'dotenv/config';
import { AssinaturaStatus } from '@prisma/client';
import type { Assinatura, Plano } from '@prisma/client';
import { prisma } from '../lib/prisma/client.js';
import { AppError } from '../lib/errors.js';
import { accessTokenDaPlataforma, mpFetch } from '../lib/mercadopago/client.js';
import { resolverPlano, serializarPlano } from './plano.service.js';

export type Periodicidade = 'mensal' | 'anual';

interface PreapprovalMP {
  id: string;
  init_point: string;
  status: string;
  next_payment_date?: string;
}

const MAPA_STATUS: Record<string, AssinaturaStatus> = {
  pending: AssinaturaStatus.PENDING,
  authorized: AssinaturaStatus.AUTHORIZED,
  paused: AssinaturaStatus.PAUSED,
  cancelled: AssinaturaStatus.CANCELLED,
};

export function mapearStatusPreapproval(status: string): AssinaturaStatus {
  return MAPA_STATUS[status?.toLowerCase()] ?? AssinaturaStatus.PENDING;
}

function valorDoPlano(plano: Plano, periodicidade: Periodicidade) {
  if (periodicidade === 'anual') {
    if (plano.valorAnual === null) {
      throw new AppError(422, 'PLANO_SEM_VALOR_ANUAL');
    }
    return plano.valorAnual;
  }

  return plano.valorMensal;
}

/**
 * RF-01/RF-02. Usa `MERCADO_PAGO_ACCESS_TOKEN` — a conta **da plataforma**.
 * O token da igreja (`MercadoPagoAccount`) não tem nada a ver com este fluxo.
 */
export async function criarAssinatura(entrada: {
  instituicaoId: string;
  planoCodigo: string;
  periodicidade?: Periodicidade;
}): Promise<{ assinatura: Assinatura; initPoint: string }> {
  const { instituicaoId, planoCodigo, periodicidade = 'mensal' } = entrada;

  const [instituicao, plano] = await Promise.all([
    prisma.instituicao.findUnique({ where: { id: instituicaoId } }),
    prisma.plano.findUnique({ where: { codigo: planoCodigo } }),
  ]);

  if (!instituicao) {
    throw new AppError(404, 'INSTITUICAO_NAO_ENCONTRADA');
  }

  if (!plano) {
    throw new AppError(404, 'PLANO_NAO_ENCONTRADO');
  }

  // RN-01: plano gratuito nunca chega à Preapproval API.
  if (!plano.cobrancaSaaS) {
    throw new AppError(409, 'PLANO_SEM_COBRANCA');
  }

  if (!plano.ativo) {
    throw new AppError(409, 'PLANO_INATIVO');
  }

  const ativa = await prisma.assinatura.findFirst({
    where: { instituicaoId, status: AssinaturaStatus.AUTHORIZED },
  });

  if (ativa) {
    throw new AppError(409, 'ASSINATURA_JA_ATIVA');
  }

  if (!instituicao.email) {
    throw new AppError(422, 'INSTITUICAO_SEM_EMAIL');
  }

  const valor = valorDoPlano(plano, periodicidade);

  const preapproval = await mpFetch<PreapprovalMP>('/preapproval', {
    method: 'POST',
    accessToken: accessTokenDaPlataforma(),
    body: {
      reason: `Assinatura ${plano.nome} — ${instituicao.nome}`,
      external_reference: instituicaoId,
      payer_email: instituicao.email,
      back_url: `${process.env.FRONTEND_URL}/instituicao/assinatura`,
      status: 'pending',
      ...(plano.mpPreapprovalPlanId ? { preapproval_plan_id: plano.mpPreapprovalPlanId } : {}),
      auto_recurring: {
        frequency: periodicidade === 'anual' ? 12 : 1,
        frequency_type: 'months',
        transaction_amount: Number(valor.toFixed(2)),
        currency_id: 'BRL',
      },
    },
  });

  const assinatura = await prisma.assinatura.create({
    data: {
      instituicaoId,
      planoId: plano.id,
      mpPreapprovalId: preapproval.id,
      valor,
      periodicidade,
      status: mapearStatusPreapproval(preapproval.status),
      proximaCobranca: preapproval.next_payment_date
        ? new Date(preapproval.next_payment_date)
        : null,
    },
  });

  return { assinatura, initPoint: preapproval.init_point };
}

/**
 * RF-04. Plano gratuito devolve `status: null` — é o estado normal de um parceiro
 * piloto, não um erro. O frontend não renderiza tela de falha nesse caso.
 */
export async function obterAssinaturaDaInstituicao(instituicaoId: string) {
  const plano = await resolverPlano(instituicaoId);

  if (!plano.cobrancaSaaS) {
    return { status: null, motivo: 'PLANO_SEM_COBRANCA' as const };
  }

  const assinatura = await prisma.assinatura.findFirst({
    where: { instituicaoId },
    orderBy: { createdAt: 'desc' },
    include: { plano: true },
  });

  if (!assinatura) {
    return { status: null, motivo: 'SEM_ASSINATURA' as const };
  }

  return {
    id: assinatura.id,
    status: assinatura.status,
    valor: assinatura.valor.toFixed(2),
    periodicidade: assinatura.periodicidade,
    proximaCobranca: assinatura.proximaCobranca,
    canceladaEm: assinatura.canceladaEm,
    motivoCancelamento: assinatura.motivoCancelamento,
    plano: serializarPlano(assinatura.plano),
    // Enquanto PENDING, a igreja ainda precisa autorizar no MP. O checkout de
    // preapproval é endereçável pelo id, então não guardamos o `init_point`.
    initPoint:
      assinatura.status === AssinaturaStatus.PENDING
        ? `https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=${assinatura.mpPreapprovalId}`
        : null,
  };
}

/** RF-05 / RN-08. Cancela no MP antes de gravar — se o MP recusar, nada muda aqui. */
export async function cancelarAssinatura(assinaturaId: string, motivo: string): Promise<Assinatura> {
  const assinatura = await prisma.assinatura.findUnique({ where: { id: assinaturaId } });

  if (!assinatura) {
    throw new AppError(404, 'ASSINATURA_NAO_ENCONTRADA');
  }

  if (assinatura.status === AssinaturaStatus.CANCELLED) {
    return assinatura;
  }

  await mpFetch(`/preapproval/${assinatura.mpPreapprovalId}`, {
    method: 'PUT',
    accessToken: accessTokenDaPlataforma(),
    body: { status: 'cancelled' },
  });

  return prisma.assinatura.update({
    where: { id: assinaturaId },
    data: {
      status: AssinaturaStatus.CANCELLED,
      canceladaEm: new Date(),
      motivoCancelamento: motivo,
    },
  });
}

/**
 * RF-03. Chamado pelo webhook. Reconsulta o MP — o payload do webhook nunca
 * decide status. Ao autorizar, o plano pago passa a vigorar (RN-07).
 */
export async function sincronizarPreapproval(mpPreapprovalId: string): Promise<void> {
  const preapproval = await mpFetch<PreapprovalMP>(`/preapproval/${mpPreapprovalId}`, {
    accessToken: accessTokenDaPlataforma(),
  });

  const assinatura = await prisma.assinatura.findUnique({
    where: { mpPreapprovalId },
  });

  if (!assinatura) {
    console.warn(
      JSON.stringify({ evento: 'preapproval_sem_assinatura_local', mpPreapprovalId }),
    );
    return;
  }

  const status = mapearStatusPreapproval(preapproval.status);

  await prisma.assinatura.update({
    where: { id: assinatura.id },
    data: {
      status,
      proximaCobranca: preapproval.next_payment_date
        ? new Date(preapproval.next_payment_date)
        : assinatura.proximaCobranca,
      ...(status === AssinaturaStatus.CANCELLED && !assinatura.canceladaEm
        ? { canceladaEm: new Date() }
        : {}),
    },
  });

  if (status === AssinaturaStatus.AUTHORIZED) {
    await prisma.instituicao.update({
      where: { id: assinatura.instituicaoId },
      data: {
        planoId: assinatura.planoId,
        planoAtribuidoEm: new Date(),
      },
    });
  }
}

/** Cancela no MP toda assinatura viva da instituição. Usado no downgrade (RN-08). */
export async function cancelarAssinaturasAtivas(
  instituicaoId: string,
  motivo: string,
): Promise<number> {
  const vivas = await prisma.assinatura.findMany({
    where: {
      instituicaoId,
      status: { in: [AssinaturaStatus.PENDING, AssinaturaStatus.AUTHORIZED, AssinaturaStatus.PAUSED] },
    },
  });

  for (const assinatura of vivas) {
    await cancelarAssinatura(assinatura.id, motivo);
  }

  return vivas.length;
}
