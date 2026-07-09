import { Request, Response, NextFunction } from 'express';
import { supabaseAuth } from '../lib/supabase/auth.js';
import { prisma } from '../lib/prisma/client.js';

export type UserType = 'membro' | 'backoffice' | 'lider' | 'pastor' | 'tesouraria';

export const USER_TYPES: UserType[] = ['membro', 'backoffice', 'lider', 'pastor', 'tesouraria'];

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    nome: string;
    telefone?: string;
    rg?: string;
    cpf?: string;
    userType: UserType;
    instituicaoId: string;
  };
}

export async function authenticateUser(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token de autenticação não fornecido' });
    }

    const token = authHeader.substring(7);

    const { data: { user }, error } = await supabaseAuth.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Token inválido ou expirado' });
    }

    const dbUser = await prisma.users.findUnique({
      where: { id: user.id },
      include: {
        instituicao: true,
      },
    });

    if (!dbUser) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    req.user = {
      id: dbUser.id,
      email: dbUser.email,
      nome: dbUser.nome,
      telefone: dbUser.telefone || undefined,
      rg: dbUser.rg || undefined,
      cpf: dbUser.cpf || undefined,
      userType: dbUser.userType as UserType,
      instituicaoId: dbUser.instituicaoId,
    };

    next();
  } catch (error) {
    console.error('Erro na autenticação:', error);
    return res.status(500).json({ error: 'Erro ao autenticar usuário' });
  }
}

export function requireBackoffice(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  if (!req.user) {
    return res.status(401).json({ error: 'Usuário não autenticado' });
  }

  if (req.user.userType !== 'backoffice') {
    return res.status(403).json({ error: 'Acesso negado. Apenas usuários backoffice podem acessar este recurso.' });
  }

  next();
}

export function requireSameInstitution(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  if (!req.user) {
    return res.status(401).json({ error: 'Usuário não autenticado' });
  }

  const instituicaoId = req.params.instituicaoId || req.body.instituicaoId;

  if (instituicaoId && req.user.instituicaoId !== instituicaoId) {
    return res.status(403).json({ error: 'Acesso negado. Você não pertence a esta instituição.' });
  }

  next();
}

// Cria um middleware que exige que o usuário tenha um dos papéis informados
export function requireUserType(...tipos: UserType[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Usuário não autenticado' });
    }

    if (!tipos.includes(req.user.userType)) {
      return res.status(403).json({ error: 'Acesso negado. Você não tem permissão para esta ação.' });
    }

    next();
  };
}

export const requireLiderOrBackoffice = requireUserType('lider', 'backoffice');
