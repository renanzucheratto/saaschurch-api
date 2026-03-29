import { Router, Response } from 'express';
import { prisma } from '../lib/prisma/client.js';
import { supabaseAdmin } from '../lib/supabase/auth.js';
import { authenticateUser, requireBackoffice, AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();

router.post('/', authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const { email, nome, telefone, rg, cpf, userType, instituicaoId } = req.body;

    // Se não for backoffice, instituicaoId deve ser do próprio usuário logado
    const finalInstituicaoId = req.user!.userType === 'backoffice' ? (instituicaoId || req.user!.instituicaoId) : req.user!.instituicaoId;

    if (!email || !nome) {
      return res.status(400).json({ error: 'Email e nome são obrigatórios' });
    }

    // Verificar se usuário já existe no banco
    const existingUser = await prisma.users.findUnique({
      where: { email },
    });

    if (existingUser) {
      return res.status(400).json({ error: 'Este email já está cadastrado' });
    }

    // Gerar convite via Supabase
    // O inviteUserByEmail já envia o email se o SMTP estiver configurado no Supabase
    const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      redirectTo: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/set-password`,
      data: {
        nome,
        telefone,
        rg,
        cpf,
        userType: userType || 'membro',
        instituicaoId: finalInstituicaoId
      }
    });

    if (error) {
      console.error('Erro ao convidar usuário no Supabase:', error);
      return res.status(400).json({ error: error.message });
    }

    // Criar no banco de dados prisma
    const user = await prisma.users.create({
      data: {
        id: data.user.id,
        email,
        nome,
        telefone,
        rg,
        cpf,
        userType: userType || 'membro',
        instituicaoId: finalInstituicaoId
      }
    });

    return res.status(201).json({
      message: 'Usuário convidado com sucesso. Ele receberá um email para definir a senha.',
      user
    });
  } catch (error) {
    console.error('Erro ao criar usuário:', error);
    return res.status(500).json({ error: 'Erro ao criar usuário' });
  }
});

router.get('/', authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const { instituicaoId, userType } = req.query;

    const where: any = {};

    // Se não for backoffice, só pode ver a sua própria instituição
    if (req.user!.userType !== 'backoffice') {
      where.instituicaoId = req.user!.instituicaoId;
    } else if (instituicaoId) {
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
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

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
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
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
      data: {
        ...updateData,
        updatedByEmail: req.user?.email || null,
      },
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
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

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
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
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
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
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
      data: { 
        instituicaoId,
        updatedByEmail: req.user?.email || null,
      },
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
