import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth.middleware.js';
import {
  hasPermission,
  hasRole,
  hasAnyRole,
  belongsToArea,
  hasAreaRole,
  canCreateInArea,
  canEditInArea,
} from '../helpers/permissions.helper.js';

// ==================== MIDDLEWARES DE PERMISSÕES GLOBAIS ====================

/**
 * Middleware para exigir uma permissão específica
 */
export function requirePermission(recurso: string, acao: string) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Usuário não autenticado' });
    }

    const hasAccess = await hasPermission(req.user.id, recurso, acao);

    if (!hasAccess) {
      return res.status(403).json({
        error: `Sem permissão para ${acao} em ${recurso}`,
      });
    }

    next();
  };
}

/**
 * Middleware para exigir um role específico
 */
export function requireRole(roleName: string) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Usuário não autenticado' });
    }

    const hasAccess = await hasRole(req.user.id, roleName);

    if (!hasAccess) {
      return res.status(403).json({
        error: `Acesso negado. Apenas usuários com role '${roleName}' podem acessar este recurso.`,
      });
    }

    next();
  };
}

/**
 * Middleware para exigir pelo menos um dos roles fornecidos
 */
export function requireAnyRole(roleNames: string[]) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Usuário não autenticado' });
    }

    const hasAccess = await hasAnyRole(req.user.id, roleNames);

    if (!hasAccess) {
      return res.status(403).json({
        error: `Acesso negado. Requer um dos seguintes roles: ${roleNames.join(', ')}`,
      });
    }

    next();
  };
}

// ==================== MIDDLEWARES DE ÁREA ====================

/**
 * Middleware para verificar se o usuário pertence à área (do params.areaId)
 */
export function requireBelongsToArea() {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Usuário não autenticado' });
    }

    const areaId = Array.isArray(req.params.areaId) ? req.params.areaId[0] : req.params.areaId;

    if (!areaId) {
      return res.status(400).json({ error: 'ID da área não fornecido' });
    }

    const belongs = await belongsToArea(req.user.id, areaId);

    if (!belongs) {
      return res.status(403).json({
        error: 'Você não pertence a esta área',
      });
    }

    next();
  };
}

/**
 * Middleware para exigir um role específico na área
 */
export function requireAreaRole(roleNaArea: string) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Usuário não autenticado' });
    }

    const areaId = Array.isArray(req.params.areaId) ? req.params.areaId[0] : req.params.areaId;

    if (!areaId) {
      return res.status(400).json({ error: 'ID da área não fornecido' });
    }

    const hasAccess = await hasAreaRole(req.user.id, areaId, roleNaArea);

    if (!hasAccess) {
      return res.status(403).json({
        error: `Apenas ${roleNaArea}s podem realizar esta ação nesta área`,
      });
    }

    next();
  };
}

/**
 * Middleware para verificar se pode criar na área (líder ou coordenador)
 */
export function requireCanCreateInArea() {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Usuário não autenticado' });
    }

    const areaId = Array.isArray(req.params.areaId) ? req.params.areaId[0] : req.params.areaId;

    if (!areaId) {
      return res.status(400).json({ error: 'ID da área não fornecido' });
    }

    const canCreate = await canCreateInArea(req.user.id, areaId);

    if (!canCreate) {
      return res.status(403).json({
        error: 'Apenas líderes e coordenadores podem criar nesta área',
      });
    }

    next();
  };
}

/**
 * Middleware para verificar se pode editar na área (líder ou coordenador)
 */
export function requireCanEditInArea() {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Usuário não autenticado' });
    }

    const areaId = Array.isArray(req.params.areaId) ? req.params.areaId[0] : req.params.areaId;

    if (!areaId) {
      return res.status(400).json({ error: 'ID da área não fornecido' });
    }

    const canEdit = await canEditInArea(req.user.id, areaId);

    if (!canEdit) {
      return res.status(403).json({
        error: 'Apenas líderes e coordenadores podem editar nesta área',
      });
    }

    next();
  };
}
