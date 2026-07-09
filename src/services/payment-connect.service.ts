import crypto from 'node:crypto';
import { MercadoPagoAccountStatus } from '@prisma/client';
import type { MercadoPagoAccount } from '@prisma/client';
import { prisma } from '../lib/prisma/client.js';
import { AppError } from '../lib/errors.js';
import { cifrar, decifrar } from '../lib/mercadopago/crypto.js';
import {
  assinarState,
  montarUrlAutorizacao,
  renovarTokens,
  trocarCodePorTokens,
  verificarState,
  TTL_STATE_SEGUNDOS,
} from '../lib/mercadopago/oauth.js';

export interface StatusConexao {
  status: MercadoPagoAccountStatus | 'NAO_CONECTADO';
  mpUserId?: string;
  conectadoEm?: Date;
  expiresAt?: Date;
  ultimoErro?: string | null;
}

/**
 * RF-01: gera a URL de autorização com `state` assinado e `nonce` de uso único.
 */
export async function iniciarConexao(instituicaoId: string, userId: string): Promise<string> {
  const existente = await prisma.mercadoPagoAccount.findUnique({ where: { instituicaoId } });

  if (existente?.status === MercadoPagoAccountStatus.ACTIVE) {
    throw new AppError(409, 'JA_CONECTADO');
  }

  const nonce = crypto.randomUUID();

  await prisma.oAuthNonce.create({
    data: {
      nonce,
      instituicaoId,
      expiraEm: new Date(Date.now() + TTL_STATE_SEGUNDOS * 1000),
    },
  });

  return montarUrlAutorizacao(assinarState({ instituicaoId, userId, nonce }));
}

/**
 * RF-02: valida o `state`, consome o nonce, troca o `code` por tokens e persiste
 * cifrado. Devolve o `instituicaoId` para o redirect do callback.
 */
export async function processarCallback(
  code: string | undefined,
  state: string | undefined,
): Promise<string> {
  const payload = verificarState(state);

  if (!code || !payload) {
    throw new AppError(400, 'INVALID_STATE');
  }

  // `updateMany` com o filtro de não-consumido é a checagem e a marcação em uma
  // instrução só: um segundo callback com o mesmo nonce atualiza 0 linhas.
  const consumo = await prisma.oAuthNonce.updateMany({
    where: {
      nonce: payload.nonce,
      instituicaoId: payload.instituicaoId,
      consumidoEm: null,
      expiraEm: { gt: new Date() },
    },
    data: { consumidoEm: new Date() },
  });

  if (consumo.count !== 1) {
    throw new AppError(400, 'INVALID_STATE');
  }

  const tokens = await trocarCodePorTokens(code);

  const dados = {
    mpUserId: tokens.mpUserId,
    accessToken: cifrar(tokens.accessToken),
    refreshToken: cifrar(tokens.refreshToken),
    publicKey: tokens.publicKey,
    scope: tokens.scope,
    expiresAt: tokens.expiresAt,
    status: MercadoPagoAccountStatus.ACTIVE,
    ultimoRefreshEm: new Date(),
    ultimoErro: null,
  };

  await prisma.mercadoPagoAccount.upsert({
    where: { instituicaoId: payload.instituicaoId },
    create: { instituicaoId: payload.instituicaoId, ...dados },
    update: dados,
  });

  return payload.instituicaoId;
}

/** RF-03. Nunca expõe `accessToken` nem `refreshToken`. */
export async function obterStatus(instituicaoId: string): Promise<StatusConexao> {
  const conta = await prisma.mercadoPagoAccount.findUnique({ where: { instituicaoId } });

  if (!conta) {
    return { status: 'NAO_CONECTADO' };
  }

  return {
    status: conta.status,
    mpUserId: conta.mpUserId,
    conectadoEm: conta.createdAt,
    expiresAt: conta.expiresAt,
    ultimoErro: conta.ultimoErro,
  };
}

/**
 * RF-04. A desconexão é sempre permitida, mesmo com evento ativo — o que ela
 * derruba é a criação de novos pagamentos. Os já criados seguem o ciclo no MP.
 */
export async function desconectar(instituicaoId: string): Promise<void> {
  const conta = await prisma.mercadoPagoAccount.findUnique({ where: { instituicaoId } });

  if (!conta) {
    return;
  }

  await prisma.mercadoPagoAccount.update({
    where: { instituicaoId },
    data: {
      status: MercadoPagoAccountStatus.REVOKED,
      accessToken: '',
      refreshToken: '',
      ultimoErro: null,
    },
  });
}

/** Quantos eventos ainda aceitariam pagamento — alimenta o aviso do diálogo de desconexão. */
export async function contarEventosAtivosComProdutoPagavel(instituicaoId: string): Promise<number> {
  return prisma.eventos.count({
    where: {
      instituicaoId,
      data_fim: { gte: new Date() },
      produtos: { some: { exigePagamento: true, oculto: false } },
      OR: [{ status: null }, { status: { nome: { notIn: ['cancelado', 'finalizado'] } } }],
    },
  });
}

/**
 * Access token **da igreja**, decifrado. É este — nunca o da plataforma — que
 * assina `POST /v1/payments` e o `GET /v1/payments/{id}` de reconciliação.
 */
export async function obterAccessTokenDaIgreja(instituicaoId: string): Promise<string> {
  const conta = await prisma.mercadoPagoAccount.findUnique({ where: { instituicaoId } });

  if (!conta || conta.status !== MercadoPagoAccountStatus.ACTIVE) {
    throw new AppError(409, 'MP_ACCOUNT_INACTIVE');
  }

  return decifrar(conta.accessToken);
}

export async function obterContaAtiva(instituicaoId: string): Promise<MercadoPagoAccount> {
  const conta = await prisma.mercadoPagoAccount.findUnique({ where: { instituicaoId } });

  if (!conta || conta.status !== MercadoPagoAccountStatus.ACTIVE) {
    throw new AppError(409, 'MP_ACCOUNT_INACTIVE');
  }

  return conta;
}

/**
 * RF-05. Falha de renovação marca a conta como `EXPIRED` em vez de propagar —
 * o job varre um lote e um item ruim não pode abortar os demais.
 */
export async function renovarConta(conta: MercadoPagoAccount): Promise<'RENOVADO' | 'EXPIRADO'> {
  try {
    const tokens = await renovarTokens(decifrar(conta.refreshToken));

    await prisma.mercadoPagoAccount.update({
      where: { id: conta.id },
      data: {
        accessToken: cifrar(tokens.accessToken),
        refreshToken: cifrar(tokens.refreshToken),
        publicKey: tokens.publicKey,
        expiresAt: tokens.expiresAt,
        status: MercadoPagoAccountStatus.ACTIVE,
        ultimoRefreshEm: new Date(),
        ultimoErro: null,
      },
    });

    return 'RENOVADO';
  } catch (error) {
    await prisma.mercadoPagoAccount.update({
      where: { id: conta.id },
      data: {
        status: MercadoPagoAccountStatus.EXPIRED,
        ultimoErro: error instanceof Error ? error.message : 'Erro desconhecido ao renovar token',
      },
    });

    return 'EXPIRADO';
  }
}
