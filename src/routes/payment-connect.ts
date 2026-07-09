import 'dotenv/config';
import { Router, type Request, type Response } from 'express';
import { responderErro } from '../lib/errors.js';
import {
  authenticateUser,
  requireUserType,
  type AuthRequest,
} from '../middleware/auth.middleware.js';
import {
  contarEventosAtivosComProdutoPagavel,
  desconectar,
  iniciarConexao,
  obterStatus,
  processarCallback,
} from '../services/payment-connect.service.js';

const router = Router();

const requireAdminDaIgreja = requireUserType('backoffice', 'pastor');

function urlDoPainel(query: string): string {
  return `${process.env.FRONTEND_URL}/instituicao/pagamentos?${query}`;
}

// ==================== POST /authorize ====================
// JSON em vez de 302: navegação de browser não carrega `Authorization`, e mandar o
// token em query string o deixaria no histórico e nos logs de acesso.
router.post(
  '/authorize',
  authenticateUser,
  requireAdminDaIgreja,
  async (req: AuthRequest, res: Response) => {
    try {
      const authorizeUrl = await iniciarConexao(req.user!.instituicaoId, req.user!.id);
      return res.status(200).json({ authorizeUrl });
    } catch (error) {
      return responderErro(res, error, 'Erro ao iniciar conexão com o Mercado Pago');
    }
  },
);

// ==================== GET /callback ====================
// Rota pública: quem chega aqui é o browser redirecionado pelo MP. A confiança vem
// do `state` assinado, não de sessão.
router.get('/callback', async (req: Request, res: Response) => {
  try {
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;

    await processarCallback(code, state);

    return res.redirect(302, urlDoPainel('connected=1'));
  } catch (error) {
    console.error('Erro no callback OAuth do Mercado Pago:', error);
    return res.redirect(302, urlDoPainel('error=INVALID_STATE'));
  }
});

// ==================== GET /status ====================
// `instituicaoId` vem de `req.user`, nunca de path param — elimina IDOR por construção.
router.get('/status', authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const status = await obterStatus(req.user!.instituicaoId);
    return res.status(200).json(status);
  } catch (error) {
    return responderErro(res, error, 'Erro ao consultar a conexão com o Mercado Pago');
  }
});

// ==================== GET /impacto-desconexao ====================
// Alimenta o aviso do diálogo: quantos eventos deixam de aceitar pagamento online.
router.get(
  '/impacto-desconexao',
  authenticateUser,
  requireAdminDaIgreja,
  async (req: AuthRequest, res: Response) => {
    try {
      const eventosAtivos = await contarEventosAtivosComProdutoPagavel(req.user!.instituicaoId);
      return res.status(200).json({ eventosAtivos });
    } catch (error) {
      return responderErro(res, error, 'Erro ao avaliar o impacto da desconexão');
    }
  },
);

// ==================== DELETE / ====================
// A desconexão é sempre permitida, mesmo com evento ativo. O que ela impede é a
// criação de novos pagamentos; os já criados seguem seu ciclo no MP.
router.delete('/', authenticateUser, requireAdminDaIgreja, async (req: AuthRequest, res: Response) => {
  try {
    await desconectar(req.user!.instituicaoId);
    return res.status(204).send();
  } catch (error) {
    return responderErro(res, error, 'Erro ao desconectar o Mercado Pago');
  }
});

export default router;
