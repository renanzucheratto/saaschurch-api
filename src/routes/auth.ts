import { Router, Request, Response } from 'express';
import { supabaseAdmin, supabaseAuth } from '../lib/supabase/auth.js';
import { prisma } from '../lib/prisma/client.js';
import { SignUpData, SignInData, UpdateUserData } from '../types/auth.types.js';
import { authenticateUser, AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();

router.post('/signup', async (req: Request, res: Response) => {
  try {
    const { email, password, nome, telefone, rg, cpf, userType, instituicaoId }: SignUpData = req.body;

    if (!email || !password || !nome || !instituicaoId) {
      return res.status(400).json({ 
        error: 'Email, senha, nome e instituição são obrigatórios' 
      });
    }

    if (userType && !['membro', 'backoffice'].includes(userType)) {
      return res.status(400).json({ 
        error: 'Tipo de usuário inválido. Use "membro" ou "backoffice"' 
      });
    }

    const instituicao = await prisma.instituicao.findUnique({
      where: { id: instituicaoId },
    });

    if (!instituicao) {
      console.error('Instituição não encontrada para o ID:', instituicaoId);
      return res.status(404).json({ error: 'Instituição não encontrada' });
    }

    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        nome,
        telefone,
        rg,
        cpf,
        userType: userType || 'membro',
        instituicaoId,
      },
    });

    if (error) {
      console.error('Erro ao criar usuário no Supabase:', error);
      return res.status(400).json({ error: error.message });
    }

    // Create user in database manually
    try {
      await prisma.users.create({
        data: {
          id: data.user.id,
          email,
          nome,
          telefone,
          rg,
          cpf,
          userType: userType || 'membro',
          instituicaoId,
        },
      });
    } catch (dbError) {
      console.error('Erro ao criar usuário no banco de dados:', dbError);
      // If user creation in database fails, delete from Supabase Auth
      await supabaseAdmin.auth.admin.deleteUser(data.user.id);
      return res.status(500).json({ error: 'Erro ao criar usuário no banco de dados' });
    }

    // Return the created user data
    return res.status(201).json({
      message: 'Usuário criado com sucesso',
      user: {
        id: data.user.id,
        email,
        nome,
        telefone,
        rg,
        cpf,
        userType: userType || 'membro',
        instituicaoId,
        instituicao: {
          id: instituicao.id,
          nome: instituicao.nome,
        },
      },
    });
  } catch (error) {
    console.error('Erro ao criar usuário:', error);
    return res.status(500).json({ error: 'Erro ao criar usuário' });
  }
});

router.post('/signin', async (req: Request, res: Response) => {
  try {
    const { email, password }: SignInData = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    }

    const { data, error } = await supabaseAuth.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    const user = await prisma.users.findUnique({
      where: { id: data.user.id },
      include: {
        instituicao: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    return res.status(200).json({
      user: {
        id: user.id,
        email: user.email,
        nome: user.nome,
        telefone: user.telefone,
        rg: user.rg,
        cpf: user.cpf,
        userType: user.userType,
        instituicaoId: user.instituicaoId,
        instituicao: {
          id: user.instituicao.id,
          nome: user.instituicao.nome,
        },
      },
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_in: data.session.expires_in,
        expires_at: data.session.expires_at,
      },
    });
  } catch (error) {
    console.error('Erro ao fazer login:', error);
    return res.status(500).json({ error: 'Erro ao fazer login' });
  }
});

router.post('/signout', authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.substring(7);

    if (token) {
      await supabaseAuth.auth.signOut();
    }

    return res.status(200).json({ message: 'Logout realizado com sucesso' });
  } catch (error) {
    console.error('Erro ao fazer logout:', error);
    return res.status(500).json({ error: 'Erro ao fazer logout' });
  }
});

router.get('/me', authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.users.findUnique({
      where: { id: req.user!.id },
      include: {
        instituicao: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    return res.status(200).json({
      id: user.id,
      email: user.email,
      nome: user.nome,
      telefone: user.telefone,
      rg: user.rg,
      cpf: user.cpf,
      userType: user.userType,
      instituicaoId: user.instituicaoId,
      instituicao: {
        id: user.instituicao.id,
        nome: user.instituicao.nome,
      },
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    });
  } catch (error) {
    console.error('Erro ao buscar usuário:', error);
    return res.status(500).json({ error: 'Erro ao buscar usuário' });
  }
});

router.put('/me', authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const { nome, telefone, rg, cpf, email }: UpdateUserData = req.body;
    const userId = req.user!.id;

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

    if (rg !== undefined) {
      updateData.rg = rg;
      authUpdateData.data = { ...authUpdateData.data, rg };
    }

    if (cpf !== undefined) {
      updateData.cpf = cpf;
      authUpdateData.data = { ...authUpdateData.data, cpf };
    }

    if (email) {
      updateData.email = email;
      authUpdateData.email = email;
    }

    if (Object.keys(authUpdateData).length > 0) {
      const { error } = await supabaseAdmin.auth.admin.updateUserById(
        userId,
        authUpdateData
      );

      if (error) {
        return res.status(400).json({ error: error.message });
      }
    }

    const user = await prisma.users.update({
      where: { id: userId },
      data: updateData,
      include: {
        instituicao: true,
      },
    });

    return res.status(200).json({
      message: 'Usuário atualizado com sucesso',
      user: {
        id: user.id,
        email: user.email,
        nome: user.nome,
        telefone: user.telefone,
        rg: user.rg,
        cpf: user.cpf,
        userType: user.userType,
        instituicaoId: user.instituicaoId,
        instituicao: {
          id: user.instituicao.id,
          nome: user.instituicao.nome,
        },
      },
    });
  } catch (error) {
    console.error('Erro ao atualizar usuário:', error);
    return res.status(500).json({ error: 'Erro ao atualizar usuário' });
  }
});

router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { refresh_token } = req.body;

    if (!refresh_token) {
      return res.status(400).json({ error: 'Refresh token é obrigatório' });
    }

    const { data, error } = await supabaseAuth.auth.refreshSession({
      refresh_token,
    });

    if (error) {
      return res.status(401).json({ error: 'Refresh token inválido' });
    }

    return res.status(200).json({
      session: {
        access_token: data.session!.access_token,
        refresh_token: data.session!.refresh_token,
        expires_in: data.session!.expires_in,
        expires_at: data.session!.expires_at,
      },
    });
  } catch (error) {
    console.error('Erro ao renovar token:', error);
    return res.status(500).json({ error: 'Erro ao renovar token' });
  }
});

export default router;
