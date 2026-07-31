import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../lib/prisma/client.js';
import {
  authenticateUser,
  requireBackoffice,
  AuthRequest,
} from '../middleware/auth.middleware.js';
import {
  buildAuthorizationUrl,
  exchangeCode,
  gerarParPkce,
} from '../lib/mercadopago/oauth.js';
import { encryptToken } from '../lib/mercadopago/crypto.js';
import {
  chamarMp,
  clienteUsuario,
  MercadoPagoError,
} from '../lib/mercadopago/client.js';
import {
  getAccessTokenInstituicao,
  ContaMercadoPagoIndisponivel,
} from '../lib/mercadopago/token.js';

const router = Router();

const NONCE_TTL_MS = 10 * 60 * 1000; // casa com a validade do authorization_code

function paramString(valor: unknown): string {
  return Array.isArray(valor) ? String(valor[0]) : String(valor);
}

function urlRetornoFrontend(status: 'ok' | 'erro', motivo?: string): string {
  const base = process.env.FRONTEND_URL || '';
  const params = new URLSearchParams({ status });
  if (motivo) params.set('motivo', motivo);
  return `${base}/configuracoes/pagamentos?${params.toString()}`;
}

// GET /mercadopago/oauth/connect - inicia a vinculação da conta da instituição
router.get(
  '/oauth/connect',
  authenticateUser,
  requireBackoffice,
  async (req: AuthRequest, res: Response) => {
    try {
      const instituicaoId = req.user!.instituicaoId;

      const { codeVerifier, codeChallenge } = gerarParPkce();
      const nonce = crypto.randomBytes(24).toString('base64url');

      await prisma.oAuthNonce.create({
        data: {
          nonce,
          instituicaoId,
          codeVerifier,
          expiraEm: new Date(Date.now() + NONCE_TTL_MS),
        },
      });

      // Limpeza oportunista dos nonces vencidos, para a tabela não crescer sem fim.
      await prisma.oAuthNonce.deleteMany({
        where: { expiraEm: { lt: new Date() } },
      });

      return res.status(200).json({
        authorizationUrl: buildAuthorizationUrl(nonce, codeChallenge),
        expiraEm: new Date(Date.now() + NONCE_TTL_MS),
      });
    } catch (error) {
      console.error('Erro ao iniciar OAuth Mercado Pago:', error);
      return res.status(500).json({ error: 'Erro ao iniciar conexão com Mercado Pago' });
    }
  },
);

// GET /mercadopago/oauth/callback - rota PÚBLICA: o MP redireciona o browser aqui
router.get('/oauth/callback', async (req: Request, res: Response) => {
  const { code, state, error: erroMp } = req.query;

  try {
    if (erroMp) {
      console.error('OAuth Mercado Pago recusado pelo usuário:', erroMp);
      return res.redirect(urlRetornoFrontend('erro', 'autorizacao_recusada'));
    }

    if (!code || !state) {
      return res.redirect(urlRetornoFrontend('erro', 'parametros_ausentes'));
    }

    const nonce = await prisma.oAuthNonce.findUnique({
      where: { nonce: String(state) },
    });

    if (!nonce || nonce.consumidoEm || nonce.expiraEm < new Date() || !nonce.codeVerifier) {
      return res.redirect(urlRetornoFrontend('erro', 'state_invalido'));
    }

    // Consome antes da troca: se o MP falhar, o nonce não pode ser reusado.
    await prisma.oAuthNonce.update({
      where: { nonce: nonce.nonce },
      data: { consumidoEm: new Date() },
    });

    const tokens = await exchangeCode(String(code), nonce.codeVerifier);

    await prisma.mercadoPagoAccount.upsert({
      where: { instituicaoId: nonce.instituicaoId },
      update: {
        mpUserId: tokens.mpUserId,
        accessTokenEnc: encryptToken(tokens.accessToken),
        refreshTokenEnc: encryptToken(tokens.refreshToken),
        publicKey: tokens.publicKey,
        scope: tokens.scope,
        expiresAt: tokens.expiresAt,
        refreshExpiresAt: tokens.refreshExpiresAt,
        status: 'ACTIVE',
        ultimoRefreshEm: new Date(),
        ultimoErro: null,
      },
      create: {
        instituicaoId: nonce.instituicaoId,
        mpUserId: tokens.mpUserId,
        accessTokenEnc: encryptToken(tokens.accessToken),
        refreshTokenEnc: encryptToken(tokens.refreshToken),
        publicKey: tokens.publicKey,
        scope: tokens.scope,
        expiresAt: tokens.expiresAt,
        refreshExpiresAt: tokens.refreshExpiresAt,
        status: 'ACTIVE',
        ultimoRefreshEm: new Date(),
      },
    });

    return res.redirect(urlRetornoFrontend('ok'));
  } catch (error) {
    // Mensagem do erro pode conter detalhe do MP, mas nunca o token.
    console.error('Erro no callback OAuth Mercado Pago:', error);
    return res.redirect(urlRetornoFrontend('erro', 'falha_troca_token'));
  }
});

/**
 * GET /mercadopago/status - situação da conexão SEGUNDO O NOSSO BANCO.
 *
 * Barato e sem chamada externa, mas é a última coisa que soubemos: se a
 * instituição revogou o acesso no painel do Mercado Pago, o MP não nos avisa e
 * este endpoint continua dizendo ACTIVE. Para saber de fato, /verificar.
 *
 * Nunca devolve token.
 */
router.get('/status', authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const conta = await prisma.mercadoPagoAccount.findUnique({
      where: { instituicaoId: req.user!.instituicaoId },
      select: {
        mpUserId: true,
        status: true,
        expiresAt: true,
        refreshExpiresAt: true,
        ultimoRefreshEm: true,
        ultimoErro: true,
        createdAt: true,
      },
    });

    if (!conta) {
      return res.status(200).json({ conectado: false });
    }

    return res.status(200).json({
      conectado: conta.status === 'ACTIVE',
      mpUserId: conta.mpUserId,
      status: conta.status,
      expiraEm: conta.expiresAt,
      refreshExpiraEm: conta.refreshExpiresAt,
      ultimoRefreshEm: conta.ultimoRefreshEm,
      ultimoErro: conta.ultimoErro,
      conectadoEm: conta.createdAt,
    });
  } catch (error) {
    console.error('Erro ao consultar status Mercado Pago:', error);
    return res.status(500).json({ error: 'Erro ao consultar status' });
  }
});

/**
 * GET /mercadopago/verificar - prova de vida da conexão.
 *
 * Faz o que /status não faz: usa o token de verdade contra o Mercado Pago
 * (GET /users/me). Exercita o caminho inteiro — decifra o token, renova se
 * estiver perto de vencer, e vê o que o MP responde.
 *
 * Três desfechos possíveis, todos com HTTP 200 (a pergunta foi respondida; a
 * resposta é que pode ser "não"):
 *  - conectado: true  -> o token vale agora
 *  - conectado: false -> nunca conectou, refresh falhou ou o MP recusou
 *  - contaDivergente  -> conectou, mas com uma conta MP diferente da gravada
 *
 * Um 401/403 do MP significa acesso revogado ou credencial inválida: o registro
 * local é marcado REVOKED, senão o banco continuaria mentindo ACTIVE.
 */
router.get('/verificar', authenticateUser, async (req: AuthRequest, res: Response) => {
  const instituicaoId = req.user!.instituicaoId;

  try {
    const conta = await prisma.mercadoPagoAccount.findUnique({
      where: { instituicaoId },
      select: { mpUserId: true, status: true, expiresAt: true, createdAt: true },
    });

    if (!conta) {
      return res.status(200).json({ conectado: false, motivo: 'nao_conectada' });
    }

    let accessToken: string;

    try {
      accessToken = await getAccessTokenInstituicao(instituicaoId);
    } catch (error) {
      if (error instanceof ContaMercadoPagoIndisponivel) {
        return res.status(200).json({
          conectado: false,
          motivo: error.motivo,
          detalhe: error.message,
        });
      }
      throw error;
    }

    let usuario;

    try {
      usuario = await chamarMp('GET /users/me', () => clienteUsuario(accessToken).get());
    } catch (error) {
      const status = error instanceof MercadoPagoError ? error.status : null;

      if (status === 401 || status === 403) {
        await prisma.mercadoPagoAccount.update({
          where: { instituicaoId },
          data: {
            status: 'REVOKED',
            ultimoErro: 'Mercado Pago recusou o token na verificação',
          },
        });

        return res.status(200).json({ conectado: false, motivo: 'revogada' });
      }

      // Instabilidade do MP não é desconexão: não rebaixa o status local.
      console.error(
        'Falha ao verificar conta Mercado Pago:',
        error instanceof Error ? error.message : error,
      );

      return res.status(503).json({
        error: 'Não foi possível falar com o Mercado Pago agora',
      });
    }

    const mpUserIdAtual = usuario.id !== undefined ? String(usuario.id) : null;
    const contaDivergente = Boolean(
      mpUserIdAtual && conta.mpUserId && mpUserIdAtual !== conta.mpUserId,
    );

    if (!contaDivergente && conta.status !== 'ACTIVE') {
      // O token respondeu: o status local estava desatualizado.
      await prisma.mercadoPagoAccount.update({
        where: { instituicaoId },
        data: { status: 'ACTIVE', ultimoErro: null },
      });
    }

    return res.status(200).json({
      conectado: !contaDivergente,
      contaDivergente,
      mpUserId: mpUserIdAtual,
      mpUserIdGravado: conta.mpUserId,
      apelido: usuario.nickname ?? null,
      email: usuario.email ?? null,
      siteId: usuario.site_id ?? null,
      // Conta conectada não é o mesmo que conta apta a receber: o MP pode
      // exigir documentação/aceite pendente antes de liberar cobrança.
      podeReceber: usuario.status?.sell?.allow ?? null,
      restricoesRecebimento: usuario.status?.sell?.codes ?? [],
      emailConfirmado: usuario.status?.confirmed_email ?? null,
      termosAceitos: usuario.status?.mercadopago_tc_accepted ?? null,
      acaoNecessaria: usuario.status?.required_action ?? null,
      tokenExpiraEm: conta.expiresAt,
      conectadoEm: conta.createdAt,
    });
  } catch (error) {
    console.error('Erro ao verificar conta Mercado Pago:', error);
    return res.status(500).json({ error: 'Erro ao verificar conta' });
  }
});

// DELETE /mercadopago/conta - desvincula e apaga os tokens
router.delete(
  '/conta',
  authenticateUser,
  requireBackoffice,
  async (req: AuthRequest, res: Response) => {
    try {
      const conta = await prisma.mercadoPagoAccount.findUnique({
        where: { instituicaoId: req.user!.instituicaoId },
      });

      if (!conta) {
        return res.status(404).json({ error: 'Nenhuma conta Mercado Pago conectada' });
      }

      await prisma.mercadoPagoAccount.update({
        where: { instituicaoId: req.user!.instituicaoId },
        data: {
          status: 'REVOKED',
          accessTokenEnc: '',
          refreshTokenEnc: '',
          ultimoErro: `Desvinculada por ${req.user!.email}`,
        },
      });

      return res.status(200).json({ message: 'Conta Mercado Pago desvinculada' });
    } catch (error) {
      console.error('Erro ao desvincular conta Mercado Pago:', error);
      return res.status(500).json({ error: 'Erro ao desvincular conta' });
    }
  },
);

// GET /mercadopago/pagamentos - leitura isolada dos pagamentos online
router.get('/pagamentos', authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const { eventoId, status, participanteId, pagina, porPagina } = req.query;

    const take = Math.min(Number(porPagina) || 50, 200);
    const skip = ((Number(pagina) || 1) - 1) * take;

    const where: any = { instituicaoId: req.user!.instituicaoId };

    if (eventoId) where.eventoId = String(eventoId);
    if (participanteId) where.participanteId = String(participanteId);
    if (status) where.status = String(status);

    const [total, pagamentos] = await Promise.all([
      prisma.mpPagamento.count({ where }),
      prisma.mpPagamento.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
    ]);

    return res.status(200).json({
      total,
      pagina: Number(pagina) || 1,
      porPagina: take,
      pagamentos,
    });
  } catch (error) {
    console.error('Erro ao listar pagamentos Mercado Pago:', error);
    return res.status(500).json({ error: 'Erro ao listar pagamentos' });
  }
});

// GET /mercadopago/pagamentos/:id
router.get('/pagamentos/:id', authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const id = paramString(req.params.id);

    const pagamento = await prisma.mpPagamento.findUnique({ where: { id } });

    if (!pagamento || pagamento.instituicaoId !== req.user!.instituicaoId) {
      return res.status(404).json({ error: 'Pagamento não encontrado' });
    }

    return res.status(200).json(pagamento);
  } catch (error) {
    console.error('Erro ao buscar pagamento Mercado Pago:', error);
    return res.status(500).json({ error: 'Erro ao buscar pagamento' });
  }
});

export default router;
