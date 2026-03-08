import { Router, Response } from 'express';
import { prisma } from '../lib/prisma/client.js';
import { supabaseAdmin } from '../lib/supabase/auth.js';
import { authenticateUser, requireBackoffice, AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();

router.get('/', authenticateUser, requireBackoffice, async (req: AuthRequest, res: Response) => {
  try {
    const { instituicaoId, userType } = req.query;

    const where: any = {};

    if (instituicaoId) {
      where.instituicaoId = instituicaoId as string;
    }

    if (userType) {
      where.userType = userType as string;
    }

    const users = await prisma.users.findMany({
      where,
      include: {
        instituicao: {
          select: {
            id: true,
            nome: true,
          },
        },
      },
      orderBy: {
        nome: 'asc',
      },
    });

    return res.status(200).json(users);
  } catch (error) {
    console.error('Erro ao listar usuários:', error);
    return res.status(500).json({ error: 'Erro ao listar usuários' });
  }
});

router.get('/:id', authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (req.user!.userType !== 'backoffice' && req.user!.id !== id) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    const user = await prisma.users.findUnique({
      where: { id },
      include: {
        instituicao: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    if (req.user!.userType !== 'backoffice' && req.user!.instituicaoId !== user.instituicaoId) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    return res.status(200).json(user);
  } catch (error) {
    console.error('Erro ao buscar usuário:', error);
    return res.status(500).json({ error: 'Erro ao buscar usuário' });
  }
});

router.put('/:id', authenticateUser, requireBackoffice, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { nome, telefone, email, userType } = req.body;

    const user = await prisma.users.findUnique({
      where: { id },
    });

    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const updateData: any = {};
    const authUpdateData: any = {};

    if (nome) {
      updateData.nome = nome;
      authUpdateData.data = { ...authUpdateData.data, nome };
    }

    if (telefone !== undefined) {
      updateData.telefone = telefone;
      authUpdateData.data = { ...authUpdateData.data, telefone };
    }

    if (email) {
      updateData.email = email;
      authUpdateData.email = email;
    }

    if (userType && ['membro', 'backoffice'].includes(userType)) {
      updateData.userType = userType;
      authUpdateData.data = { ...authUpdateData.data, userType };
    }

    if (Object.keys(authUpdateData).length > 0) {
      const { error } = await supabaseAdmin.auth.admin.updateUserById(
        id,
        authUpdateData
      );

      if (error) {
        return res.status(400).json({ error: error.message });
      }
    }

    const updatedUser = await prisma.users.update({
      where: { id },
      data: updateData,
      include: {
        instituicao: true,
      },
    });

    return res.status(200).json({
      message: 'Usuário atualizado com sucesso',
      user: updatedUser,
    });
  } catch (error) {
    console.error('Erro ao atualizar usuário:', error);
    return res.status(500).json({ error: 'Erro ao atualizar usuário' });
  }
});

router.delete('/:id', authenticateUser, requireBackoffice, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const user = await prisma.users.findUnique({
      where: { id },
    });

    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    await supabaseAdmin.auth.admin.deleteUser(id);

    return res.status(200).json({ message: 'Usuário excluído com sucesso' });
  } catch (error) {
    console.error('Erro ao excluir usuário:', error);
    return res.status(500).json({ error: 'Erro ao excluir usuário' });
  }
});

router.post('/:id/reset-password', authenticateUser, requireBackoffice, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Senha deve ter no mínimo 6 caracteres' });
    }

    const user = await prisma.users.findUnique({
      where: { id },
    });

    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const { error } = await supabaseAdmin.auth.admin.updateUserById(id, {
      password,
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(200).json({ message: 'Senha redefinida com sucesso' });
  } catch (error) {
    console.error('Erro ao redefinir senha:', error);
    return res.status(500).json({ error: 'Erro ao redefinir senha' });
  }
});

router.post('/:id/change-institution', authenticateUser, requireBackoffice, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { instituicaoId } = req.body;

    if (!instituicaoId) {
      return res.status(400).json({ error: 'ID da instituição é obrigatório' });
    }

    const user = await prisma.users.findUnique({
      where: { id },
    });

    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const instituicao = await prisma.instituicao.findUnique({
      where: { id: instituicaoId },
    });

    if (!instituicao) {
      return res.status(404).json({ error: 'Instituição não encontrada' });
    }

    const { error } = await supabaseAdmin.auth.admin.updateUserById(id, {
      user_metadata: {
        instituicaoId,
      },
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    const updatedUser = await prisma.users.update({
      where: { id },
      data: { instituicaoId },
      include: {
        instituicao: true,
      },
    });

    return res.status(200).json({
      message: 'Instituição alterada com sucesso',
      user: updatedUser,
    });
  } catch (error) {
    console.error('Erro ao alterar instituição:', error);
    return res.status(500).json({ error: 'Erro ao alterar instituição' });
  }
});

export default router;
