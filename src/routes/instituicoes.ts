import { Router, Response } from 'express';
import { prisma } from '../lib/prisma/client.js';
import { CreateInstituicaoData, UpdateInstituicaoData } from '../types/instituicao.types.js';
import { authenticateUser, requireBackoffice, AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { nome, cnpj, endereco, telefone, email }: CreateInstituicaoData = req.body;

    if (!nome) {
      return res.status(400).json({ error: 'Nome da instituição é obrigatório' });
    }

    if (cnpj) {
      const existingInstituicao = await prisma.instituicao.findUnique({
        where: { cnpj },
      });

      if (existingInstituicao) {
        return res.status(400).json({ error: 'CNPJ já cadastrado' });
      }
    }

    const instituicao = await prisma.instituicao.create({
      data: {
        nome,
        cnpj,
        endereco,
        telefone,
        email,
      },
    });

    return res.status(201).json({
      message: 'Instituição criada com sucesso',
      instituicao,
    });
  } catch (error) {
    console.error('Erro ao criar instituição:', error);
    return res.status(500).json({ error: 'Erro ao criar instituição' });
  }
});

router.get('/', authenticateUser, requireBackoffice, async (req: AuthRequest, res: Response) => {
  try {
    const instituicoes = await prisma.instituicao.findMany({
      include: {
        _count: {
          select: {
            users: true,
            eventos: true,
          },
        },
      },
      orderBy: {
        nome: 'asc',
      },
    });

    return res.status(200).json(instituicoes);
  } catch (error) {
    console.error('Erro ao listar instituições:', error);
    return res.status(500).json({ error: 'Erro ao listar instituições' });
  }
});

router.get('/:id', authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (req.user!.userType !== 'backoffice' && req.user!.instituicaoId !== id) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    const instituicao = await prisma.instituicao.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            users: true,
            eventos: true,
          },
        },
      },
    });

    if (!instituicao) {
      return res.status(404).json({ error: 'Instituição não encontrada' });
    }

    return res.status(200).json(instituicao);
  } catch (error) {
    console.error('Erro ao buscar instituição:', error);
    return res.status(500).json({ error: 'Erro ao buscar instituição' });
  }
});

router.put('/:id', authenticateUser, requireBackoffice, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { nome, cnpj, endereco, telefone, email }: UpdateInstituicaoData = req.body;

    const instituicao = await prisma.instituicao.findUnique({
      where: { id },
    });

    if (!instituicao) {
      return res.status(404).json({ error: 'Instituição não encontrada' });
    }

    if (cnpj && cnpj !== instituicao.cnpj) {
      const existingInstituicao = await prisma.instituicao.findUnique({
        where: { cnpj },
      });

      if (existingInstituicao) {
        return res.status(400).json({ error: 'CNPJ já cadastrado' });
      }
    }

    const updatedInstituicao = await prisma.instituicao.update({
      where: { id },
      data: {
        ...(nome && { nome }),
        ...(cnpj !== undefined && { cnpj }),
        ...(endereco !== undefined && { endereco }),
        ...(telefone !== undefined && { telefone }),
        ...(email !== undefined && { email }),
      },
    });

    return res.status(200).json({
      message: 'Instituição atualizada com sucesso',
      instituicao: updatedInstituicao,
    });
  } catch (error) {
    console.error('Erro ao atualizar instituição:', error);
    return res.status(500).json({ error: 'Erro ao atualizar instituição' });
  }
});

router.delete('/:id', authenticateUser, requireBackoffice, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const instituicao = await prisma.instituicao.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            users: true,
            eventos: true,
          },
        },
      },
    });

    if (!instituicao) {
      return res.status(404).json({ error: 'Instituição não encontrada' });
    }

    if (instituicao._count.users > 0 || instituicao._count.eventos > 0) {
      return res.status(400).json({ 
        error: 'Não é possível excluir uma instituição com usuários ou eventos vinculados' 
      });
    }

    await prisma.instituicao.delete({
      where: { id },
    });

    return res.status(200).json({ message: 'Instituição excluída com sucesso' });
  } catch (error) {
    console.error('Erro ao excluir instituição:', error);
    return res.status(500).json({ error: 'Erro ao excluir instituição' });
  }
});

router.get('/:id/users', authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (req.user!.userType !== 'backoffice' && req.user!.instituicaoId !== id) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    const users = await prisma.users.findMany({
      where: { instituicaoId: id },
      select: {
        id: true,
        email: true,
        nome: true,
        telefone: true,
        userType: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: {
        nome: 'asc',
      },
    });

    return res.status(200).json(users);
  } catch (error) {
    console.error('Erro ao listar usuários da instituição:', error);
    return res.status(500).json({ error: 'Erro ao listar usuários' });
  }
});

router.get('/:id/eventos', authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (req.user!.userType !== 'backoffice' && req.user!.instituicaoId !== id) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    const eventos = await prisma.eventos.findMany({
      where: { instituicaoId: id },
      include: {
        user: {
          select: {
            id: true,
            nome: true,
            email: true,
          },
        },
        _count: {
          select: {
            participantes: true,
            produtos: true,
          },
        },
      },
      orderBy: {
        data_inicio: 'desc',
      },
    });

    return res.status(200).json(eventos);
  } catch (error) {
    console.error('Erro ao listar eventos da instituição:', error);
    return res.status(500).json({ error: 'Erro ao listar eventos' });
  }
});

export default router;
