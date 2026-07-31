import { prisma } from '../prisma/client.js';
import { decryptToken, encryptToken } from './crypto.js';
import { refreshAccessToken } from './oauth.js';
import { impressaoToken, logMp, logMpErro } from './log.js';

/**
 * Resolve o access_token válido de uma instituição, renovando de forma
 * transparente quando está perto de vencer.
 *
 * Centralizado aqui porque checkout e webhook precisam do mesmo comportamento —
 * e porque decifrar token é o tipo de coisa que não pode estar espalhada.
 */

const MARGEM_RENOVACAO_MS = 10 * 60 * 1000; // renova se faltam menos de 10 min

export class ContaMercadoPagoIndisponivel extends Error {
  readonly motivo: 'nao_conectada' | 'revogada' | 'expirada';

  constructor(motivo: 'nao_conectada' | 'revogada' | 'expirada', mensagem: string) {
    super(mensagem);
    this.name = 'ContaMercadoPagoIndisponivel';
    this.motivo = motivo;
  }
}

export async function getAccessTokenInstituicao(instituicaoId: string): Promise<string> {
  const conta = await prisma.mercadoPagoAccount.findUnique({
    where: { instituicaoId },
  });

  if (!conta || !conta.accessTokenEnc) {
    logMpErro('token.falha', { instituicaoId, motivo: 'nao_conectada' });
    throw new ContaMercadoPagoIndisponivel(
      'nao_conectada',
      'Instituição não conectada ao Mercado Pago',
    );
  }

  if (conta.status === 'REVOKED') {
    logMpErro('token.falha', { instituicaoId, motivo: 'revogada' });
    throw new ContaMercadoPagoIndisponivel(
      'revogada',
      'Conexão com o Mercado Pago foi revogada',
    );
  }

  const precisaRenovar =
    conta.expiresAt.getTime() - Date.now() < MARGEM_RENOVACAO_MS;

  if (!precisaRenovar) {
    const accessToken = decryptToken(conta.accessTokenEnc);

    logMp('token.resolve', {
      instituicaoId,
      mpUserId: conta.mpUserId,
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

    await prisma.mercadoPagoAccount.update({
      where: { instituicaoId },
      data: {
        accessTokenEnc: encryptToken(tokens.accessToken),
        refreshTokenEnc: encryptToken(tokens.refreshToken),
        expiresAt: tokens.expiresAt,
        refreshExpiresAt: tokens.refreshExpiresAt,
        status: 'ACTIVE',
        ultimoRefreshEm: new Date(),
        ultimoErro: null,
      },
    });

    logMp('token.renovado', {
      instituicaoId,
      mpUserIdGravado: conta.mpUserId,
      mpUserIdNovo: tokens.mpUserId,
      // Divergência aqui = a conta MP do refresh não é a que conectamos.
      contaDivergente: Boolean(
        conta.mpUserId && tokens.mpUserId && conta.mpUserId !== tokens.mpUserId,
      ),
      scope: tokens.scope,
      renovou: true,
      expiraEm: tokens.expiresAt.toISOString(),
      token: impressaoToken(tokens.accessToken),
    });

    return tokens.accessToken;
  } catch (error: any) {
    logMpErro('token.falha', {
      instituicaoId,
      mpUserId: conta.mpUserId,
      motivo: 'refresh_falhou',
      detalhe: String(error?.message ?? error).slice(0, 500),
    });

    await prisma.mercadoPagoAccount.update({
      where: { instituicaoId },
      data: {
        status: 'EXPIRED',
        ultimoErro: String(error?.message ?? error).slice(0, 500),
      },
    });

    throw new ContaMercadoPagoIndisponivel(
      'expirada',
      'Não foi possível renovar o acesso ao Mercado Pago. A instituição precisa reconectar a conta.',
    );
  }
}
