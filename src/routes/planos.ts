import { Router, type Response } from 'express';
import { prisma } from '../lib/prisma/client.js';
import { AppError, responderErro } from '../lib/errors.js';
import { authenticateUser, requireBackoffice, type AuthRequest } from '../middleware/auth.middleware.js';
import { contarUso, resolverPlano, serializarPlano } from '../services/plano.service.js';
import {
  cancelarAssinaturasAtivas,
  criarAssinatura,
  obterAssinaturaDaInstituicao,
} from '../services/billing.service.js';

const router = Router();

// ==================== GET / ====================
router.get('/', authenticateUser, async (_req: AuthRequest, res: Response) => {
  try {
    const planos = await prisma.plano.findMany({
      where: { ativo: true },
      orderBy: { ordem: 'asc' },
    });

    return res.status(200).json({ planos: planos.map(serializarPlano) });
  } catch (error) {
    return responderErro(res, error, 'Erro ao listar planos');
  }
});

// ==================== GET /meu ====================
router.get('/meu', authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const { instituicaoId } = req.user!;

    const [plano, uso, assinatura, instituicao] = await Promise.all([
      resolverPlano(instituicaoId),
      contarUso(instituicaoId),
      obterAssinaturaDaInstituicao(instituicaoId),
      prisma.instituicao.findUnique({
        where: { id: instituicaoId },
        select: { parceiroPiloto: true, planoAtribuidoEm: true },
      }),
    ]);

    return res.status(200).json({
      plano: serializarPlano(plano),
      uso,
      // Plano gratuito não tem assinatura, e isso não é erro — é o estado normal.
      assinatura: assinatura.status === null ? null : assinatura,
      parceiroPiloto: instituicao?.parceiroPiloto ?? false,
      planoAtribuidoEm: instituicao?.planoAtribuidoEm ?? null,
    });
  } catch (error) {
    return responderErro(res, error, 'Erro ao consultar o plano da instituição');
  }
});

// ==================== PATCH /instituicao/:instituicaoId ====================
// RN-05: troca de plano é ação de backoffice. Não há self-service de upgrade.
router.patch(
  '/instituicao/:instituicaoId',
  authenticateUser,
  requireBackoffice,
  async (req: AuthRequest, res: Response) => {
    try {
      const instituicaoId = String(req.params.instituicaoId);
      const { planoCodigo, motivo } = req.body as { planoCodigo?: string; motivo?: string };

      if (!planoCodigo) {
        throw new AppError(400, 'PLANO_CODIGO_OBRIGATORIO');
      }

      const [instituicao, plano] = await Promise.all([
        prisma.instituicao.findUnique({ where: { id: instituicaoId } }),
        prisma.plano.findUnique({ where: { codigo: planoCodigo } }),
      ]);

      if (!instituicao) {
        throw new AppError(404, 'INSTITUICAO_NAO_ENCONTRADA');
      }

      if (!plano) {
        throw new AppError(404, 'PLANO_NAO_ENCONTRADO');
      }

      if (!plano.ativo) {
        throw new AppError(409, 'PLANO_INATIVO');
      }

      const auditoria = {
        planoAtribuidoEm: new Date(),
        planoAtribuidoPor: req.user!.email,
      };

      // RN-07: o plano pago só vigora quando o webhook confirmar `authorized`.
      // Até lá a instituição permanece no plano anterior.
      if (plano.cobrancaSaaS) {
        const { initPoint } = await criarAssinatura({
          instituicaoId,
          planoCodigo,
          periodicidade: 'mensal',
        });

        await prisma.instituicao.update({ where: { id: instituicaoId }, data: auditoria });

        return res.status(200).json({
          plano: serializarPlano(plano),
          assinaturaNecessaria: true,
          initPoint,
        });
      }

      // RN-08: descer para plano gratuito cancela a assinatura viva no MP.
      await cancelarAssinaturasAtivas(
        instituicaoId,
        motivo || `Migração para o plano ${plano.codigo}`,
      );

      await prisma.instituicao.update({
        where: { id: instituicaoId },
        data: { planoId: plano.id, ...auditoria },
      });

      return res.status(200).json({
        plano: serializarPlano(plano),
        assinaturaNecessaria: false,
      });
    } catch (error) {
      return responderErro(res, error, 'Erro ao atribuir plano à instituição');
    }
  },
);

export default router;
