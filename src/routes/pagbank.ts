import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma/client.js';
import {
  authenticateUser,
  requireBackoffice,
  AuthRequest,
} from '../middleware/auth.middleware.js';
import { buildAuthorizationUrl, exchangeCode, gerarState } from '../lib/pagbank/oauth.js';
import { encryptToken } from '../lib/pagbank/crypto.js';
import { consultarConta, simularTaxas } from '../lib/pagbank/orders.js';
import { PagBankError } from '../lib/pagbank/client.js';
import { resolveRegraSplit, calcularSplit } from '../helpers/split.helper.js';
import { logPbErro } from '../lib/pagbank/log.js';
import {
  getAccessTokenInstituicao,
  ContaPagBankIndisponivel,
} from '../lib/pagbank/token.js';

const router = Router();

const STATE_TTL_MS = 10 * 60 * 1000; // casa com a validade do authorization_code do PagBank

function urlRetornoFrontend(status: 'ok' | 'erro', motivo?: string): string {
  const base = process.env.FRONTEND_URL || '';
  const params = new URLSearchParams({ status });
  if (motivo) params.set('motivo', motivo);
  return `${base}/configuracoes/pagamentos?${params.toString()}`;
}

// GET /pagbank/oauth/connect - inicia a vinculação da conta da instituição
router.get(
  '/oauth/connect',
  authenticateUser,
  requireBackoffice,
  async (req: AuthRequest, res: Response) => {
    try {
      const instituicaoId = req.user!.instituicaoId;
      const state = gerarState();

      // Reaproveita a tabela OAuthNonce (genérica, não específica de provedor).
      // codeVerifier fica vazio: o Connect do PagBank não documenta PKCE.
      await prisma.oAuthNonce.create({
        data: {
          nonce: state,
          instituicaoId,
          expiraEm: new Date(Date.now() + STATE_TTL_MS),
        },
      });

      await prisma.oAuthNonce.deleteMany({
        where: { expiraEm: { lt: new Date() } },
      });

      return res.status(200).json({
        authorizationUrl: buildAuthorizationUrl(state),
        expiraEm: new Date(Date.now() + STATE_TTL_MS),
      });
    } catch (error) {
      console.error('Erro ao iniciar OAuth PagBank:', error);
      return res.status(500).json({ error: 'Erro ao iniciar conexão com o PagBank' });
    }
  },
);

// GET /pagbank/oauth/callback - rota PÚBLICA: o PagBank redireciona o browser aqui
router.get('/oauth/callback', async (req: Request, res: Response) => {
  const { code, state, error: erroPb } = req.query;

  try {
    if (erroPb) {
      console.error('OAuth PagBank recusado pelo usuário:', erroPb);
      return res.redirect(urlRetornoFrontend('erro', 'autorizacao_recusada'));
    }

    if (!code || !state) {
      return res.redirect(urlRetornoFrontend('erro', 'parametros_ausentes'));
    }

    const nonce = await prisma.oAuthNonce.findUnique({
      where: { nonce: String(state) },
    });

    if (!nonce || nonce.consumidoEm || nonce.expiraEm < new Date()) {
      return res.redirect(urlRetornoFrontend('erro', 'state_invalido'));
    }

    // Consome antes da troca: se o PagBank falhar, o state não pode ser reusado.
    await prisma.oAuthNonce.update({
      where: { nonce: nonce.nonce },
      data: { consumidoEm: new Date() },
    });

    const tokens = await exchangeCode(String(code));

    await prisma.pagBankAccount.upsert({
      where: { instituicaoId: nonce.instituicaoId },
      update: {
        pagbankAccountId: tokens.accountId,
        accessTokenEnc: encryptToken(tokens.accessToken),
        refreshTokenEnc: encryptToken(tokens.refreshToken),
        scope: tokens.scope,
        expiresAt: tokens.expiresAt,
        status: 'ACTIVE',
        ultimoRefreshEm: new Date(),
        ultimoErro: null,
      },
      create: {
        instituicaoId: nonce.instituicaoId,
        pagbankAccountId: tokens.accountId,
        accessTokenEnc: encryptToken(tokens.accessToken),
        refreshTokenEnc: encryptToken(tokens.refreshToken),
        scope: tokens.scope,
        expiresAt: tokens.expiresAt,
        status: 'ACTIVE',
        ultimoRefreshEm: new Date(),
      },
    });

    return res.redirect(urlRetornoFrontend('ok'));
  } catch (error) {
    // Mensagem do erro pode conter detalhe do PagBank, mas nunca o token.
    console.error('Erro no callback OAuth PagBank:', error);
    return res.redirect(urlRetornoFrontend('erro', 'falha_troca_token'));
  }
});

/**
 * GET /pagbank/status - situação da conexão SEGUNDO O NOSSO BANCO.
 *
 * Barato e sem chamada externa, mas é a última coisa que soubemos: se a
 * instituição revogou o acesso no painel do PagBank, ele não nos avisa e
 * este endpoint continua dizendo ACTIVE. Para saber de fato, /verificar.
 *
 * Nunca devolve token.
 */
router.get('/status', authenticateUser, requireBackoffice, async (req: AuthRequest, res: Response) => {
  try {
    const conta = await prisma.pagBankAccount.findUnique({
      where: { instituicaoId: req.user!.instituicaoId },
      select: {
        pagbankAccountId: true,
        status: true,
        expiresAt: true,
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
      pagbankAccountId: conta.pagbankAccountId,
      status: conta.status,
      expiraEm: conta.expiresAt,
      ultimoRefreshEm: conta.ultimoRefreshEm,
      ultimoErro: conta.ultimoErro,
      conectadoEm: conta.createdAt,
    });
  } catch (error) {
    console.error('Erro ao consultar status PagBank:', error);
    return res.status(500).json({ error: 'Erro ao consultar status' });
  }
});

/**
 * GET /pagbank/verificar - prova de vida da conexão (GET /accounts/{id}).
 *
 * Três desfechos possíveis, todos com HTTP 200:
 *  - conectado: true  -> o token vale agora
 *  - conectado: false -> nunca conectou, refresh falhou ou o PagBank recusou
 *  - contaDivergente  -> conectou, mas com uma conta diferente da gravada
 */
router.get('/verificar', authenticateUser, requireBackoffice, async (req: AuthRequest, res: Response) => {
  const instituicaoId = req.user!.instituicaoId;

  try {
    const conta = await prisma.pagBankAccount.findUnique({
      where: { instituicaoId },
      select: { pagbankAccountId: true, status: true, expiresAt: true, createdAt: true },
    });

    if (!conta) {
      return res.status(200).json({ conectado: false, motivo: 'nao_conectada' });
    }

    let accessToken: string;

    try {
      accessToken = await getAccessTokenInstituicao(instituicaoId);
    } catch (error) {
      if (error instanceof ContaPagBankIndisponivel) {
        return res.status(200).json({
          conectado: false,
          motivo: error.motivo,
          detalhe: error.message,
        });
      }
      throw error;
    }

    let conta_pb;

    try {
      conta_pb = await consultarConta(accessToken, conta.pagbankAccountId);
    } catch (error) {
      const status = error instanceof PagBankError ? error.status : null;

      // Só 401 é prova de credencial inválida. O 403 do PagBank também aparece
      // em erro de permissão/configuração da chamada — foi o que acontecia
      // quando `consultarConta` mandava o token errado no Bearer, e rebaixar
      // para REVOKED aqui corrompia uma conexão perfeitamente saudável.
      if (status === 401) {
        await prisma.pagBankAccount.update({
          where: { instituicaoId },
          data: {
            status: 'REVOKED',
            ultimoErro: 'PagBank recusou o token na verificação',
          },
        });

        return res.status(200).json({ conectado: false, motivo: 'revogada' });
      }

      if (status === 403) {
        // Não mexe no status local: não sabemos se é revogação ou permissão.
        console.error('PagBank recusou a consulta de conta com 403:', error);

        return res.status(200).json({
          conectado: true,
          verificacaoIndisponivel: true,
          detalhe: 'O PagBank recusou a consulta cadastral (403). O status exibido é o do nosso banco.',
        });
      }

      console.error(
        'Falha ao verificar conta PagBank:',
        error instanceof Error ? error.message : error,
      );

      return res.status(503).json({
        error: 'Não foi possível falar com o PagBank agora',
      });
    }

    const accountIdAtual = conta_pb.id ?? null;
    const contaDivergente = Boolean(
      accountIdAtual && conta.pagbankAccountId && accountIdAtual !== conta.pagbankAccountId,
    );

    if (!contaDivergente && conta.status !== 'ACTIVE') {
      await prisma.pagBankAccount.update({
        where: { instituicaoId },
        data: { status: 'ACTIVE', ultimoErro: null },
      });
    }

    return res.status(200).json({
      conectado: !contaDivergente,
      contaDivergente,
      pagbankAccountId: accountIdAtual,
      pagbankAccountIdGravado: conta.pagbankAccountId,
      email: conta_pb.email ?? null,
      status: conta_pb.status ?? null,
      tokenExpiraEm: conta.expiresAt,
      conectadoEm: conta.createdAt,
    });
  } catch (error) {
    console.error('Erro ao verificar conta PagBank:', error);
    return res.status(500).json({ error: 'Erro ao verificar conta' });
  }
});

// DELETE /pagbank/conta - desvincula e apaga os tokens
router.delete(
  '/conta',
  authenticateUser,
  requireBackoffice,
  async (req: AuthRequest, res: Response) => {
    try {
      const conta = await prisma.pagBankAccount.findUnique({
        where: { instituicaoId: req.user!.instituicaoId },
      });

      if (!conta) {
        return res.status(404).json({ error: 'Nenhuma conta PagBank conectada' });
      }

      await prisma.pagBankAccount.update({
        where: { instituicaoId: req.user!.instituicaoId },
        data: {
          status: 'REVOKED',
          accessTokenEnc: '',
          refreshTokenEnc: '',
          ultimoErro: `Desvinculada por ${req.user!.email}`,
        },
      });

      return res.status(200).json({ message: 'Conta PagBank desvinculada' });
    } catch (error) {
      console.error('Erro ao desvincular conta PagBank:', error);
      return res.status(500).json({ error: 'Erro ao desvincular conta' });
    }
  },
);

// GET /pagbank/pagamentos - leitura isolada dos pagamentos online
router.get('/pagamentos', authenticateUser, requireBackoffice, async (req: AuthRequest, res: Response) => {
  try {
    const { eventoId, status, participanteId, pagina, porPagina } = req.query;

    const take = Math.min(Number(porPagina) || 50, 200);
    const skip = ((Number(pagina) || 1) - 1) * take;

    const where: any = { instituicaoId: req.user!.instituicaoId };

    if (eventoId) where.eventoId = String(eventoId);
    if (participanteId) where.participanteId = String(participanteId);
    if (status) where.status = String(status);

    const [total, pagamentos] = await Promise.all([
      prisma.pagBankPagamento.count({ where }),
      prisma.pagBankPagamento.findMany({
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
    console.error('Erro ao listar pagamentos PagBank:', error);
    return res.status(500).json({ error: 'Erro ao listar pagamentos' });
  }
});

// GET /pagbank/pagamentos/:id
router.get('/pagamentos/:id', authenticateUser, requireBackoffice, async (req: AuthRequest, res: Response) => {
  try {
    const id = String(req.params.id);

    const pagamento = await prisma.pagBankPagamento.findUnique({ where: { id } });

    if (!pagamento || pagamento.instituicaoId !== req.user!.instituicaoId) {
      return res.status(404).json({ error: 'Pagamento não encontrado' });
    }

    return res.status(200).json(pagamento);
  } catch (error) {
    console.error('Erro ao buscar pagamento PagBank:', error);
    return res.status(500).json({ error: 'Erro ao buscar pagamento' });
  }
});

/**
 * GET /pagbank/simular-taxas?valor=100 - backoffice.
 *
 * Quanto sobra para a instituição num produto de determinado preço, separando
 * as DUAS taxas que incidem:
 *
 *  - split da plataforma: regra do plano/instituição, conhecida por nós
 *  - taxa do PagBank: vem do contrato da conta, consultada na API
 *
 * Também resolve o problema inverso ("quero receber R$ X limpos, quanto
 * cobro?") por busca numérica — a regra de split tem piso e teto, então não há
 * fórmula fechada que se inverta de forma confiável.
 */
router.get('/simular-taxas', authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const valor = Number(req.query.valor);
    const liquidoDesejado = Number(req.query.liquidoDesejado);

    const temValor = Number.isFinite(valor) && valor > 0;
    const temAlvo = Number.isFinite(liquidoDesejado) && liquidoDesejado > 0;

    if (!temValor && !temAlvo) {
      return res.status(400).json({ error: 'Informe valor ou liquidoDesejado' });
    }

    const instituicao = await prisma.instituicao.findUnique({
      where: { id: req.user!.instituicaoId },
      include: { plano: true },
    });

    if (!instituicao) {
      return res.status(404).json({ error: 'Instituição não encontrada' });
    }

    const regra = resolveRegraSplit(instituicao, instituicao.plano);

    // Taxa do PagBank por número de parcelas. A instituição absorve o custo do
    // parcelamento (decisão de produto), então o líquido CAI conforme o
    // participante parcela — mostrar um número só esconderia isso.
    let taxaPagBank = 0;
    let taxaPagBankDisponivel = false;
    let taxaPorParcela: Array<{ parcelas: number; taxa: number }> = [];

    try {
      const accessToken = await getAccessTokenInstituicao(req.user!.instituicaoId);
      const base = temValor ? valor : liquidoDesejado;
      const maxParcelas = Math.max(1, Math.min(12, Math.floor(base / 5)));

      const metodos = await simularTaxas(accessToken, {
        valorCentavos: Math.round(base * 100),
        maxParcelas,
      });

      // A resposta é organizada por bandeira, mas a taxa é do PagBank e não
      // varia entre elas — verificado contra a sandbox em 2026-08-29: os 23
      // emissores devolvem exatamente os mesmos valores. O que muda por
      // bandeira é ATÉ QUANTAS parcelas cada uma aceita (discover e jcb só à
      // vista, valecard até 3x, as demais até 12x).
      //
      // Por isso o agrupamento é por número de parcelas, e o `max` serve
      // apenas de defesa caso o PagBank passe a diferenciar por emissor —
      // hoje ele opera sobre valores idênticos.
      const bandeiras = Object.values(metodos.credit_card ?? {});

      const porParcela = new Map<number, number>();
      for (const bandeira of bandeiras) {
        for (const plano of bandeira?.installment_plans ?? []) {
          const centavos = plano.amount?.fees?.seller?.total;
          if (typeof centavos !== 'number') continue;
          const atual = porParcela.get(plano.installments) ?? 0;
          porParcela.set(plano.installments, Math.max(atual, centavos));
        }
      }

      taxaPorParcela = [...porParcela.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([parcelas, centavos]) => ({ parcelas, taxa: centavos / 100 }));

      taxaPagBank = taxaPorParcela.find((t) => t.parcelas === 1)?.taxa ?? 0;
      taxaPagBankDisponivel = taxaPorParcela.some((t) => t.taxa > 0);
    } catch (error) {
      // Simulação é informativa: não pode impedir alguém de criar um produto.
      logPbErro('pb.erro', {
        etapa: 'simular_taxas',
        mensagem: String((error as Error)?.message ?? error).slice(0, 200),
      });
    }

    const montar = (bruto: number) => {
      const split = calcularSplit(bruto, regra);
      const liquido = Math.round((bruto - split - taxaPagBank) * 100) / 100;
      return { bruto, split, taxaPagBank, liquido };
    };

    if (temValor) {
      const split = calcularSplit(valor, regra);

      // Não devolve o percentual do split: quem cria o evento precisa saber
      // quanto sobra, não como a taxa se divide internamente. Líder tem acesso
      // a esta rota (cria eventos), backoffice não é exigido aqui.
      return res.status(200).json({
        ...montar(valor),
        taxaPagBankDisponivel,
        // Líquido por opção de parcelamento — o split não muda, só a taxa.
        porParcela: taxaPorParcela.map(({ parcelas, taxa }) => ({
          parcelas,
          taxas: Math.round((split + taxa) * 100) / 100,
          liquido: Math.round((valor - split - taxa) * 100) / 100,
        })),
      });
    }

    // Inverso: procura o menor bruto cujo líquido alcança o alvo. Busca binária
    // em centavos — a regra tem piso e teto, então não é linear.
    let baixo = liquidoDesejado;
    let alto = liquidoDesejado * 3 + 100;

    for (let i = 0; i < 40; i++) {
      const meio = (baixo + alto) / 2;
      if (montar(meio).liquido < liquidoDesejado) baixo = meio;
      else alto = meio;
    }

    const sugerido = Math.ceil(alto * 100) / 100;

    return res.status(200).json({
      ...montar(sugerido),
      liquidoDesejado,
      taxaPagBankDisponivel,
    });
  } catch (error) {
    console.error('Erro ao simular taxas:', error);
    return res.status(500).json({ error: 'Erro ao simular taxas' });
  }
});

export default router;
