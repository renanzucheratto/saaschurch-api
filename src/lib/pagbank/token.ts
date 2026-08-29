import { prisma } from '../prisma/client.js';
import { decryptToken, encryptToken } from './crypto.js';
import { refreshAccessToken } from './oauth.js';
import { impressaoToken, logPb, logPbErro } from './log.js';

/**
 * Resolve o access_token válido de uma instituição, renovando de forma
 * transparente quando está perto de vencer.
 *
 * Centralizado aqui porque checkout e webhook precisam do mesmo comportamento
 * — e porque decifrar token é o tipo de coisa que não pode estar espalhada.
 */

const MARGEM_RENOVACAO_MS = 10 * 60 * 1000; // renova se faltam menos de 10 min

export class ContaPagBankIndisponivel extends Error {
  readonly motivo: 'nao_conectada' | 'revogada' | 'expirada';

  constructor(motivo: 'nao_conectada' | 'revogada' | 'expirada', mensagem: string) {
    super(mensagem);
    this.name = 'ContaPagBankIndisponivel';
    this.motivo = motivo;
  }
}

export async function getAccessTokenInstituicao(instituicaoId: string): Promise<string> {
  const conta = await prisma.pagBankAccount.findUnique({
    where: { instituicaoId },
  });

  if (!conta || !conta.accessTokenEnc) {
    logPbErro('token.falha', { instituicaoId, motivo: 'nao_conectada' });
    throw new ContaPagBankIndisponivel(
      'nao_conectada',
      'Instituição não conectada ao PagBank',
    );
  }

  if (conta.status === 'REVOKED') {
    logPbErro('token.falha', { instituicaoId, motivo: 'revogada' });
    throw new ContaPagBankIndisponivel(
      'revogada',
      'Conexão com o PagBank foi revogada',
    );
  }

  const precisaRenovar =
    conta.expiresAt.getTime() - Date.now() < MARGEM_RENOVACAO_MS;

  if (!precisaRenovar) {
    const accessToken = decryptToken(conta.accessTokenEnc);

    logPb('token.resolve', {
      instituicaoId,
      pagbankAccountId: conta.pagbankAccountId,
      status: conta.status,
      scope: conta.scope,
      renovou: false,
      expiraEm: conta.expiresAt.toISOString(),
      expiraEmMin: Math.round((conta.expiresAt.getTime() - Date.now()) / 60000),
      token: impressaoToken(accessToken),
    });

    return accessToken;
  }

  try {
    const tokens = await refreshAccessToken(decryptToken(conta.refreshTokenEnc));

    await prisma.pagBankAccount.update({
      where: { instituicaoId },
      data: {
        accessTokenEnc: encryptToken(tokens.accessToken),
        refreshTokenEnc: encryptToken(tokens.refreshToken),
        expiresAt: tokens.expiresAt,
        status: 'ACTIVE',
        ultimoRefreshEm: new Date(),
        ultimoErro: null,
      },
    });

    logPb('token.renovado', {
      instituicaoId,
      accountIdGravado: conta.pagbankAccountId,
      accountIdNovo: tokens.accountId,
      // Divergência aqui = a conta PagBank do refresh não é a que conectamos.
      contaDivergente: Boolean(
        conta.pagbankAccountId && tokens.accountId && conta.pagbankAccountId !== tokens.accountId,
      ),
      scope: tokens.scope,
      renovou: true,
      expiraEm: tokens.expiresAt.toISOString(),
      token: impressaoToken(tokens.accessToken),
    });

    return tokens.accessToken;
  } catch (error: any) {
    logPbErro('token.falha', {
      instituicaoId,
      pagbankAccountId: conta.pagbankAccountId,
      motivo: 'refresh_falhou',
      detalhe: String(error?.message ?? error).slice(0, 500),
    });

    await prisma.pagBankAccount.update({
      where: { instituicaoId },
      data: {
        status: 'EXPIRED',
        ultimoErro: String(error?.message ?? error).slice(0, 500),
      },
    });

    throw new ContaPagBankIndisponivel(
      'expirada',
      'Não foi possível renovar o acesso ao PagBank. A instituição precisa reconectar a conta.',
    );
  }
}
