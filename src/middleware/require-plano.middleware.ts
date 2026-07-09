import type { NextFunction, RequestHandler, Response } from 'express';
import { AssinaturaStatus } from '@prisma/client';
import { prisma } from '../lib/prisma/client.js';
import type { AuthRequest } from './auth.middleware.js';
import type { FeatureKey, LimiteKey } from '../types/plano.types.js';
import { contarUso, limiteDoPlano, resolverPlano, temFeature } from '../services/plano.service.js';

/**
 * Gates de plano (SPEC-BE-007).
 *
 * Os três perguntam ao **plano**, nunca ao seu código nem à flag de parceiro piloto.
 * Um plano novo só precisa de uma linha no seed; nenhum `if` aqui muda.
 *
 * Os códigos de erro são contrato com o frontend (SPEC-FE-006) — mudá-los quebra a UI.
 */

function naoAutenticado(res: Response) {
  return res.status(401).json({ error: 'Usuário não autenticado' });
}

export function requireFeature(feature: FeatureKey): RequestHandler {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return naoAutenticado(res);

    try {
      const plano = await resolverPlano(req.user.instituicaoId);

      if (!temFeature(plano, feature)) {
        return res.status(403).json({ error: 'FEATURE_INDISPONIVEL', feature });
      }

      return next();
    } catch (error) {
      console.error('Erro ao avaliar feature do plano:', error);
      return res.status(500).json({ error: 'Erro ao avaliar o plano da instituição' });
    }
  };
}

export function requireLimite(limite: LimiteKey): RequestHandler {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return naoAutenticado(res);

    try {
      const plano = await resolverPlano(req.user.instituicaoId);
      const max = limiteDoPlano(plano, limite);

      if (max === null) {
        return next();
      }

      const uso = await contarUso(req.user.instituicaoId);
      const atual = uso[limite];

      if (atual >= max) {
        return res.status(403).json({ error: 'LIMITE_ATINGIDO', limite, max, atual });
      }

      return next();
    } catch (error) {
      console.error('Erro ao avaliar limite do plano:', error);
      return res.status(500).json({ error: 'Erro ao avaliar o plano da instituição' });
    }
  };
}

/** No-op em plano gratuito (RN-01): sem cobrança, não há assinatura para estar inativa. */
export function requireAssinaturaAtiva(): RequestHandler {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return naoAutenticado(res);

    try {
      const plano = await resolverPlano(req.user.instituicaoId);

      if (!plano.cobrancaSaaS) {
        return next();
      }

      const assinatura = await prisma.assinatura.findFirst({
        where: { instituicaoId: req.user.instituicaoId },
        orderBy: { createdAt: 'desc' },
      });

      if (assinatura?.status !== AssinaturaStatus.AUTHORIZED) {
        return res.status(402).json({
          error: 'ASSINATURA_INATIVA',
          status: assinatura?.status ?? null,
        });
      }

      return next();
    } catch (error) {
      console.error('Erro ao avaliar assinatura:', error);
      return res.status(500).json({ error: 'Erro ao avaliar a assinatura da instituição' });
    }
  };
}
