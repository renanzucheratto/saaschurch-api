import { Router, type Response } from 'express';
import { AppError, responderErro } from '../lib/errors.js';
import { authenticateUser, requireBackoffice, type AuthRequest } from '../middleware/auth.middleware.js';
import {
  cancelarAssinatura,
  criarAssinatura,
  obterAssinaturaDaInstituicao,
  type Periodicidade,
} from '../services/billing.service.js';

const router = Router();

// ==================== POST /assinaturas ====================
router.post('/assinaturas', authenticateUser, requireBackoffice, async (req: AuthRequest, res: Response) => {
  try {
    const { instituicaoId, planoCodigo, periodicidade } = req.body as {
      instituicaoId?: string;
      planoCodigo?: string;
      periodicidade?: Periodicidade;
    };

    if (!instituicaoId || !planoCodigo) {
      throw new AppError(400, 'PARAMETROS_OBRIGATORIOS');
    }

    const { assinatura, initPoint } = await criarAssinatura({
      instituicaoId,
      planoCodigo,
      periodicidade,
    });

    return res.status(201).json({ assinaturaId: assinatura.id, initPoint });
  } catch (error) {
    return responderErro(res, error, 'Erro ao criar assinatura');
  }
});

// ==================== GET /assinaturas ====================
// Plano gratuito devolve `status: null` com 200. Não é erro — é o estado do piloto.
router.get('/assinaturas', authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const assinatura = await obterAssinaturaDaInstituicao(req.user!.instituicaoId);
    return res.status(200).json(assinatura);
  } catch (error) {
    return responderErro(res, error, 'Erro ao consultar assinatura');
  }
});

// ==================== PATCH /assinaturas/:id/cancelar ====================
router.patch(
  '/assinaturas/:id/cancelar',
  authenticateUser,
  requireBackoffice,
  async (req: AuthRequest, res: Response) => {
    try {
      const { motivo } = req.body as { motivo?: string };

      const assinatura = await cancelarAssinatura(
        String(req.params.id),
        motivo || 'Cancelamento solicitado pelo backoffice',
      );

      return res.status(200).json({ status: assinatura.status });
    } catch (error) {
      return responderErro(res, error, 'Erro ao cancelar assinatura');
    }
  },
);

export default router;
