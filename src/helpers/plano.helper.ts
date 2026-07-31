import { prisma } from '../lib/prisma/client.js';
import { resolveRegraSplit, type RegraSplit } from './split.helper.js';

/**
 * Plano da instituição e gating de features.
 *
 * Hoje o único plano em uso é o gratuito com acesso total, então temFeature()
 * responde true para tudo. A estrutura existe para que, quando houver plano
 * pago, o bloqueio seja uma mudança de dados e não de código.
 */

const CODIGO_PLANO_PADRAO = process.env.PLANO_PADRAO_CODIGO || 'PILOTO_FREE';

export async function getPlanoDaInstituicao(instituicaoId: string) {
  const instituicao = await prisma.instituicao.findUnique({
    where: { id: instituicaoId },
    include: { plano: true },
  });

  if (!instituicao) return null;

  // Instituição sem plano atribuído cai no padrão, em vez de ficar sem regra
  // de split e quebrar o checkout.
  const plano =
    instituicao.plano ??
    (await prisma.plano.findUnique({ where: { codigo: CODIGO_PLANO_PADRAO } }));

  return { instituicao, plano };
}

export async function getRegraSplitDaInstituicao(
  instituicaoId: string,
): Promise<RegraSplit | null> {
  const resultado = await getPlanoDaInstituicao(instituicaoId);
  if (!resultado) return null;
  return resolveRegraSplit(resultado.instituicao, resultado.plano);
}

export async function temFeature(
  instituicaoId: string,
  chave: string,
): Promise<boolean> {
  const resultado = await getPlanoDaInstituicao(instituicaoId);

  if (!resultado?.plano) return false;

  const features = resultado.plano.features as Record<string, unknown> | null;

  if (features?.acessoTotal === true) return true;

  return features?.[chave] === true;
}
