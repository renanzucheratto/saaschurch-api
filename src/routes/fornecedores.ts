import { Router, Response } from 'express';
import { prisma } from '../lib/prisma/client.js';
import { authenticateUser, requireUserType, AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();
const db = prisma as any;

router.use(authenticateUser);
router.use(requireUserType('backoffice', 'tesouraria', 'lider', 'pastor'));

// ==================== GET /financeiro/fornecedores ====================
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const fornecedores = await db.fornecedor.findMany({
      where: { instituicaoId: req.user!.instituicaoId },
      orderBy: { nome: 'asc' },
    });
    return res.status(200).json(fornecedores);
  } catch (error) {
    console.error('Erro ao listar fornecedores:', error);
    return res.status(500).json({ error: 'Erro ao listar fornecedores' });
  }
});

// ==================== GET /financeiro/fornecedores/:id ====================
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const fornecedor = await db.fornecedor.findFirst({
      where: { id: req.params.id, instituicaoId: req.user!.instituicaoId },
    });
    if (!fornecedor) {
      return res.status(404).json({ error: 'Fornecedor não encontrado' });
    }
    return res.status(200).json(fornecedor);
  } catch (error) {
    console.error('Erro ao buscar fornecedor:', error);
    return res.status(500).json({ error: 'Erro ao buscar fornecedor' });
  }
});

// ==================== POST /financeiro/fornecedores ====================
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { nome, cnpjCpf, telefone, email, observacao } = req.body;
    if (!nome?.trim()) {
      return res.status(400).json({ error: 'O nome do fornecedor é obrigatório.' });
    }

    const existing = await db.fornecedor.findFirst({
      where: { nome: nome.trim(), instituicaoId: req.user!.instituicaoId },
    });
    if (existing) {
      return res.status(400).json({ error: 'Já existe um fornecedor com este nome.' });
    }

    const fornecedor = await db.fornecedor.create({
      data: {
        nome: nome.trim(),
        cnpjCpf: cnpjCpf || null,
        telefone: telefone || null,
        email: email || null,
        observacao: observacao || null,
        instituicaoId: req.user!.instituicaoId,
        updatedByEmail: req.user!.email,
      },
    });

    return res.status(201).json(fornecedor);
  } catch (error) {
    console.error('Erro ao criar fornecedor:', error);
    return res.status(500).json({ error: 'Erro ao criar fornecedor' });
  }
});

// ==================== PUT /financeiro/fornecedores/:id ====================
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const fornecedor = await db.fornecedor.findFirst({
      where: { id: req.params.id, instituicaoId: req.user!.instituicaoId },
    });
    if (!fornecedor) {
      return res.status(404).json({ error: 'Fornecedor não encontrado' });
    }

    const { nome, cnpjCpf, telefone, email, observacao } = req.body;
    if (nome !== undefined && !nome?.trim()) {
      return res.status(400).json({ error: 'O nome do fornecedor é obrigatório.' });
    }

    if (nome?.trim() && nome.trim() !== fornecedor.nome) {
      const existing = await db.fornecedor.findFirst({
        where: {
          nome: nome.trim(),
          instituicaoId: req.user!.instituicaoId,
          id: { not: fornecedor.id },
        },
      });
      if (existing) {
        return res.status(400).json({ error: 'Já existe um fornecedor com este nome.' });
      }
    }

    const atualizado = await db.fornecedor.update({
      where: { id: fornecedor.id },
      data: {
        ...(nome !== undefined && { nome: nome.trim() }),
        ...(cnpjCpf !== undefined && { cnpjCpf: cnpjCpf || null }),
        ...(telefone !== undefined && { telefone: telefone || null }),
        ...(email !== undefined && { email: email || null }),
        ...(observacao !== undefined && { observacao: observacao || null }),
        updatedByEmail: req.user!.email,
      },
    });

    return res.status(200).json(atualizado);
  } catch (error) {
    console.error('Erro ao atualizar fornecedor:', error);
    return res.status(500).json({ error: 'Erro ao atualizar fornecedor' });
  }
});

// ==================== DELETE /financeiro/fornecedores/:id ====================
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const fornecedor = await db.fornecedor.findFirst({
      where: { id: req.params.id, instituicaoId: req.user!.instituicaoId },
    });
    if (!fornecedor) {
      return res.status(404).json({ error: 'Fornecedor não encontrado' });
    }

    // relationMode = "prisma": desvincula manualmente antes de excluir
    await db.transacaoBancaria.updateMany({
      where: { fornecedorId: fornecedor.id },
      data: { fornecedorId: null },
    });
    await db.regraConciliacao.updateMany({
      where: { fornecedorId: fornecedor.id },
      data: { fornecedorId: null },
    });
    await db.fornecedor.delete({ where: { id: fornecedor.id } });

    return res.status(200).json({ message: 'Fornecedor excluído com sucesso' });
  } catch (error) {
    console.error('Erro ao excluir fornecedor:', error);
    return res.status(500).json({ error: 'Erro ao excluir fornecedor' });
  }
});

export default router;
