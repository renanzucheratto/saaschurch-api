import { AssinaturaStatus } from '@prisma/client';
import { prisma } from '../lib/prisma/client.js';
import { logJson, mensagemDeErro } from '../lib/log.js';
import { sincronizarPreapproval } from '../services/billing.service.js';
import { PLANO_PADRAO_CODIGO } from '../types/plano.types.js';

export interface ResultadoVerificacaoAssinaturas {
  processados: number;
  bloqueados: number;
  erros: number;
  ignoradosPlanoGratuito: number;
}

/** Quantas instituições estão em plano sem cobrança — inclui as de `planoId = null` (RN-04). */
async function contarInstituicoesEmPlanoGratuito(): Promise<number> {
  const planosGratuitos = await prisma.plano.findMany({
    where: { cobrancaSaaS: false },
    select: { id: true, codigo: true },
  });

  const idsGratuitos = planosGratuitos.map((plano) => plano.id);
  const padraoEhGratuito = planosGratuitos.some((plano) => plano.codigo === PLANO_PADRAO_CODIGO);

  return prisma.instituicao.count({
    where: {
      OR: [{ planoId: { in: idsGratuitos } }, ...(padraoEhGratuito ? [{ planoId: null }] : [])],
    },
  });
}

/**
 * RF-03. Reconsulta no MP as assinaturas cuja cobrança já venceu mas seguem
 * `AUTHORIZED` localmente. Instituições em plano gratuito nunca são consultadas.
 */
export async function verificarAssinaturas(): Promise<ResultadoVerificacaoAssinaturas> {
  const ignoradosPlanoGratuito = await contarInstituicoesEmPlanoGratuito();

  const assinaturas = await prisma.assinatura.findMany({
    where: {
      status: AssinaturaStatus.AUTHORIZED,
      proximaCobranca: { lt: new Date() },
      plano: { cobrancaSaaS: true },
    },
  });

  const resultado: ResultadoVerificacaoAssinaturas = {
    processados: assinaturas.length,
    bloqueados: 0,
    erros: 0,
    ignoradosPlanoGratuito,
  };

  for (const assinatura of assinaturas) {
    const inicio = Date.now();

    try {
      await sincronizarPreapproval(assinatura.mpPreapprovalId);

      const atualizada = await prisma.assinatura.findUnique({ where: { id: assinatura.id } });

      if (atualizada && atualizada.status !== AssinaturaStatus.AUTHORIZED) {
        resultado.bloqueados += 1;
      }

      logJson('info', {
        job: 'verificar-assinaturas',
        instituicaoId: assinatura.instituicaoId,
        assinaturaId: assinatura.id,
        statusAnterior: assinatura.status,
        statusNovo: atualizada?.status ?? assinatura.status,
        duracaoMs: Date.now() - inicio,
      });
    } catch (error) {
      resultado.erros += 1;

      logJson('error', {
        job: 'verificar-assinaturas',
        instituicaoId: assinatura.instituicaoId,
        assinaturaId: assinatura.id,
        erro: mensagemDeErro(error),
        duracaoMs: Date.now() - inicio,
      });
    }
  }

  return resultado;
}
