import { MercadoPagoAccountStatus } from '@prisma/client';
import { prisma } from '../lib/prisma/client.js';
import { logJson, mensagemDeErro } from '../lib/log.js';
import { renovarConta } from '../services/payment-connect.service.js';

const JANELA_RENOVACAO_DIAS = 7;

export interface ResultadoRefreshTokens {
  processados: number;
  renovados: number;
  expirados: number;
  erros: number;
}

/** RF-01. Renova só o que está perto de vencer; contas distantes do vencimento são ignoradas. */
export async function refreshTokens(): Promise<ResultadoRefreshTokens> {
  const limite = new Date(Date.now() + JANELA_RENOVACAO_DIAS * 24 * 60 * 60 * 1000);

  const contas = await prisma.mercadoPagoAccount.findMany({
    where: { status: MercadoPagoAccountStatus.ACTIVE, expiresAt: { lt: limite } },
  });

  const resultado: ResultadoRefreshTokens = {
    processados: contas.length,
    renovados: 0,
    expirados: 0,
    erros: 0,
  };

  for (const conta of contas) {
    const inicio = Date.now();

    // try/catch por item: uma conta com refresh_token revogado não pode abortar o lote.
    try {
      const desfecho = await renovarConta(conta);

      if (desfecho === 'RENOVADO') {
        resultado.renovados += 1;
      } else {
        resultado.expirados += 1;
      }

      logJson('info', {
        job: 'refresh-tokens',
        instituicaoId: conta.instituicaoId,
        desfecho,
        duracaoMs: Date.now() - inicio,
      });
    } catch (error) {
      resultado.erros += 1;

      logJson('error', {
        job: 'refresh-tokens',
        instituicaoId: conta.instituicaoId,
        erro: mensagemDeErro(error),
        duracaoMs: Date.now() - inicio,
      });
    }
  }

  return resultado;
}
