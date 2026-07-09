import type { Plano } from '@prisma/client';
import { prisma } from '../lib/prisma/client.js';
import {
  PLANO_PADRAO_CODIGO,
  type FeatureKey,
  type LimiteKey,
  type PlanoFeatures,
  type PlanoSerializado,
  type UsoPlano,
} from '../types/plano.types.js';

export { calcularFee, type ConfigFee } from '../helpers/calcular-fee.js';

export class PlanoNaoEncontradoError extends Error {
  constructor(codigo: string) {
    super(`Plano "${codigo}" não encontrado. Rode o seed de planos.`);
    this.name = 'PlanoNaoEncontradoError';
  }
}

/**
 * Resolve o plano de uma instituição. `planoId = null` cai no plano padrão (RN-04).
 */
export async function resolverPlano(instituicaoId: string): Promise<Plano> {
  const instituicao = await prisma.instituicao.findUnique({
    where: { id: instituicaoId },
    include: { plano: true },
  });

  if (instituicao?.plano) {
    return instituicao.plano;
  }

  const padrao = await prisma.plano.findUnique({ where: { codigo: PLANO_PADRAO_CODIGO } });

  if (!padrao) {
    throw new PlanoNaoEncontradoError(PLANO_PADRAO_CODIGO);
  }

  return padrao;
}

/**
 * RN-02: a checagem pergunta pela feature, nunca pelo código do plano.
 * Feature ausente do JSON é `false`, não erro.
 */
export function temFeature(plano: Pick<Plano, 'features'>, feature: FeatureKey): boolean {
  const features = (plano.features ?? {}) as Partial<PlanoFeatures>;
  return features[feature] === true;
}

export function limiteDoPlano(
  plano: Pick<Plano, 'limiteEventosAtivos' | 'limiteUsuarios'>,
  limite: LimiteKey,
): number | null {
  return limite === 'eventosAtivos' ? plano.limiteEventosAtivos : plano.limiteUsuarios;
}

/**
 * Uso atual da instituição, para `requireLimite`. Sempre filtrado por
 * `instituicaoId` — `relationMode = "prisma"` não tem FK protegendo.
 */
export async function contarUso(instituicaoId: string): Promise<UsoPlano> {
  const agora = new Date();

  const [eventosAtivos, usuarios] = await Promise.all([
    prisma.eventos.count({
      where: {
        instituicaoId,
        data_fim: { gte: agora },
        OR: [{ status: null }, { status: { nome: { notIn: ['cancelado', 'finalizado'] } } }],
      },
    }),
    prisma.users.count({ where: { instituicaoId, active: true } }),
  ]);

  return { eventosAtivos, usuarios };
}

/** Serializa `Decimal` como string — precisão de dinheiro não sobrevive a `number`. */
export function serializarPlano(plano: Plano): PlanoSerializado {
  const features = (plano.features ?? {}) as Partial<PlanoFeatures>;

  return {
    id: plano.id,
    codigo: plano.codigo,
    nome: plano.nome,
    descricao: plano.descricao,
    cobrancaSaaS: plano.cobrancaSaaS,
    valorMensal: plano.valorMensal.toFixed(2),
    valorAnual: plano.valorAnual === null ? null : plano.valorAnual.toFixed(2),
    feeEventoPercentual: plano.feeEventoPercentual.toFixed(2),
    feeEventoMinimo: plano.feeEventoMinimo.toFixed(2),
    feeEventoMaximo: plano.feeEventoMaximo === null ? null : plano.feeEventoMaximo.toFixed(2),
    features: {
      pagamentosOnline: features.pagamentosOnline === true,
      relatorios: features.relatorios === true,
      projetos: features.projetos === true,
      areas: features.areas === true,
      camposCustomizados: features.camposCustomizados === true,
      exportacao: features.exportacao === true,
    },
    limites: {
      eventosAtivos: plano.limiteEventosAtivos,
      usuarios: plano.limiteUsuarios,
    },
    ativo: plano.ativo,
    ordem: plano.ordem,
  };
}
