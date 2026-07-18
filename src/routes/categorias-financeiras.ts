import { Router, Response } from 'express';
import { prisma } from '../lib/prisma/client.js';
import { authenticateUser, requireUserType, AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();
const db = prisma as any;

const TIPOS_CATEGORIA = ['RECEITA', 'DESPESA'];

router.use(authenticateUser);
router.use(requireUserType('backoffice', 'tesouraria', 'lider', 'pastor'));

// ==================== GET /financeiro/categorias ====================
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { tipo } = req.query;
    const categorias = await db.categoriaFinanceira.findMany({
      where: {
        instituicaoId: req.user!.instituicaoId,
        ...(tipo && { tipo: String(tipo).toUpperCase() }),
      },
      orderBy: [{ tipo: 'asc' }, { nome: 'asc' }],
    });
    return res.status(200).json(categorias);
  } catch (error) {
    console.error('Erro ao listar categorias:', error);
    return res.status(500).json({ error: 'Erro ao listar categorias' });
  }
});

// ==================== GET /financeiro/categorias/:id ====================
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const categoria = await db.categoriaFinanceira.findFirst({
      where: { id: req.params.id, instituicaoId: req.user!.instituicaoId },
    });
    if (!categoria) {
      return res.status(404).json({ error: 'Categoria não encontrada' });
    }
    return res.status(200).json(categoria);
  } catch (error) {
    console.error('Erro ao buscar categoria:', error);
    return res.status(500).json({ error: 'Erro ao buscar categoria' });
  }
});

// ==================== POST /financeiro/categorias ====================
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { nome, tipo } = req.body;
    if (!nome?.trim()) {
      return res.status(400).json({ error: 'O nome da categoria é obrigatório.' });
    }
    const tipoUpper = String(tipo || '').toUpperCase();
    if (!TIPOS_CATEGORIA.includes(tipoUpper)) {
      return res.status(400).json({ error: 'Tipo inválido. Use RECEITA ou DESPESA.' });
    }

    const existing = await db.categoriaFinanceira.findFirst({
      where: { nome: nome.trim(), tipo: tipoUpper, instituicaoId: req.user!.instituicaoId },
    });
    if (existing) {
      return res.status(400).json({ error: 'Já existe uma categoria com este nome e tipo.' });
    }

    const categoria = await db.categoriaFinanceira.create({
      data: {
        nome: nome.trim(),
        tipo: tipoUpper,
        instituicaoId: req.user!.instituicaoId,
        updatedByEmail: req.user!.email,
      },
    });

    return res.status(201).json(categoria);
  } catch (error) {
    console.error('Erro ao criar categoria:', error);
    return res.status(500).json({ error: 'Erro ao criar categoria' });
  }
});

// ==================== PUT /financeiro/categorias/:id ====================
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const categoria = await db.categoriaFinanceira.findFirst({
      where: { id: req.params.id, instituicaoId: req.user!.instituicaoId },
    });
    if (!categoria) {
      return res.status(404).json({ error: 'Categoria não encontrada' });
    }

    const { nome, tipo } = req.body;
    if (nome !== undefined && !nome?.trim()) {
      return res.status(400).json({ error: 'O nome da categoria é obrigatório.' });
    }
    const tipoUpper = tipo !== undefined ? String(tipo).toUpperCase() : categoria.tipo;
    if (!TIPOS_CATEGORIA.includes(tipoUpper)) {
      return res.status(400).json({ error: 'Tipo inválido. Use RECEITA ou DESPESA.' });
    }

    const nomeFinal = nome?.trim() || categoria.nome;
    const existing = await db.categoriaFinanceira.findFirst({
      where: {
        nome: nomeFinal,
        tipo: tipoUpper,
        instituicaoId: req.user!.instituicaoId,
        id: { not: categoria.id },
      },
    });
    if (existing) {
      return res.status(400).json({ error: 'Já existe uma categoria com este nome e tipo.' });
    }

    const atualizada = await db.categoriaFinanceira.update({
      where: { id: categoria.id },
      data: {
        nome: nomeFinal,
        tipo: tipoUpper,
        updatedByEmail: req.user!.email,
      },
    });

    return res.status(200).json(atualizada);
  } catch (error) {
    console.error('Erro ao atualizar categoria:', error);
    return res.status(500).json({ error: 'Erro ao atualizar categoria' });
  }
});

// ==================== DELETE /financeiro/categorias/:id ====================
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const categoria = await db.categoriaFinanceira.findFirst({
      where: { id: req.params.id, instituicaoId: req.user!.instituicaoId },
    });
    if (!categoria) {
      return res.status(404).json({ error: 'Categoria não encontrada' });
    }

    // relationMode = "prisma": desvincula manualmente antes de excluir
    await db.transacaoBancaria.updateMany({
      where: { categoriaId: categoria.id },
      data: { categoriaId: null },
    });
    await db.regraConciliacao.updateMany({
      where: { categoriaId: categoria.id },
      data: { categoriaId: null },
    });
    await db.categoriaFinanceira.delete({ where: { id: categoria.id } });

    return res.status(200).json({ message: 'Categoria excluída com sucesso' });
  } catch (error) {
    console.error('Erro ao excluir categoria:', error);
    return res.status(500).json({ error: 'Erro ao excluir categoria' });
  }
});

export default router;
