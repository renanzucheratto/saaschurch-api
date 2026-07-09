import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../lib/prisma/client.js';
import { AppError, responderErro } from '../lib/errors.js';
import { authenticateUser, type AuthRequest } from '../middleware/auth.middleware.js';
import { verifyRecaptcha } from '../middleware/recaptcha.js';
import {
  criarPagamento,
  listarPagamentosDoEvento,
  obterCheckoutConfig,
  obterStatusPagamento,
  type DadosCriacaoPagamento,
} from '../services/pagamento.service.js';

const router = Router();

// `POST /pagamentos` é público: quem paga é o participante, que não é usuário do
// sistema. Sem rate limit, é um endpoint de teste de cartão de graça.
const limitePagamento = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'MUITAS_REQUISICOES' },
});

const limiteConsulta = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'MUITAS_REQUISICOES' },
});

// ==================== GET /checkout-config/:eventoId ====================
router.get('/checkout-config/:eventoId', limiteConsulta, async (req: Request, res: Response) => {
  try {
    const config = await obterCheckoutConfig(String(req.params.eventoId));
    return res.status(200).json(config);
  } catch (error) {
    return responderErro(res, error, 'Erro ao carregar a configuração de checkout');
  }
});

// ==================== GET /evento/:eventoId ====================
router.get('/evento/:eventoId', authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const eventoId = String(req.params.eventoId);

    const evento = await prisma.eventos.findUnique({ where: { id: eventoId } });

    if (!evento) {
      throw new AppError(404, 'EVENTO_NAO_ENCONTRADO');
    }

    if (req.user!.userType !== 'backoffice' && evento.instituicaoId !== req.user!.instituicaoId) {
      throw new AppError(403, 'ACESSO_NEGADO');
    }

    const resultado = await listarPagamentosDoEvento(eventoId, evento.instituicaoId!);
    return res.status(200).json(resultado);
  } catch (error) {
    return responderErro(res, error, 'Erro ao listar pagamentos do evento');
  }
});

// ==================== POST / ====================
router.post('/', limitePagamento, async (req: Request, res: Response) => {
  try {
    const { recaptchaToken, ...dados } = req.body as DadosCriacaoPagamento & {
      recaptchaToken?: string;
    };

    if (!recaptchaToken || !(await verifyRecaptcha(recaptchaToken))) {
      throw new AppError(403, 'RECAPTCHA_INVALIDO');
    }

    if (!dados.eventoId || !dados.participanteId || !dados.paymentMethodId || !dados.payer?.email) {
      throw new AppError(400, 'PARAMETROS_OBRIGATORIOS');
    }

    const resultado = await criarPagamento(dados);
    return res.status(201).json(resultado);
  } catch (error) {
    return responderErro(res, error, 'Erro ao criar pagamento');
  }
});

// ==================== GET /:id ====================
// Pública, mas só devolve status — nada do participante.
router.get('/:id', limiteConsulta, async (req: Request, res: Response) => {
  try {
    const status = await obterStatusPagamento(String(req.params.id));
    return res.status(200).json(status);
  } catch (error) {
    return responderErro(res, error, 'Erro ao consultar pagamento');
  }
});

export default router;
