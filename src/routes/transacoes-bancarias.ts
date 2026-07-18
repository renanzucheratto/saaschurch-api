import { Router, Response } from 'express';
import { prisma } from '../lib/prisma/client.js';
import { authenticateUser, requireUserType, AuthRequest } from '../middleware/auth.middleware.js';
import { CAMPOS_REGRA, OPERADORES_REGRA } from '../lib/conciliacao/regras.js';
import { validarVinculos } from '../helpers/financeiro.helper.js';
import { aplicarRegrasEmPendentes } from './regras-conciliacao.js';

const router = Router();
const db = prisma as any;

router.use(authenticateUser);
router.use(requireUserType('backoffice', 'tesouraria', 'lider', 'pastor'));

const INCLUDE_CLASSIFICACAO = {
  categoria: { select: { id: true, nome: true, tipo: true } },
  fornecedor: { select: { id: true, nome: true } },
  projeto: { select: { id: true, nome: true } },
  area: { select: { id: true, nome: true } },
  contaBancaria: { select: { id: true, banco: true, agencia: true, conta: true, descricao: true } },
};

// ==================== GET /financeiro/transacoes ====================
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const {
      contaId,
      dataInicio,
      dataFim,
      status,
      tipo,
      categoriaId,
      fornecedorId,
      projetoId,
      areaId,
      page = '1',
      limit = '50',
    } = req.query;

    const where: any = {
      instituicaoId: req.user!.instituicaoId,
      ...(contaId && { contaBancariaId: String(contaId) }),
      ...(tipo && { tipo: String(tipo).toUpperCase() }),
      ...(categoriaId && { categoriaId: String(categoriaId) }),
      ...(fornecedorId && { fornecedorId: String(fornecedorId) }),
      ...(projetoId && { projetoId: String(projetoId) }),
      ...(areaId && { areaId: String(areaId) }),
    };

    if (status === 'pendente') where.conciliada = false;
    if (status === 'conciliada') where.conciliada = true;

    if (dataInicio || dataFim) {
      where.dataMovimento = {
        ...(dataInicio && { gte: new Date(String(dataInicio)) }),
        ...(dataFim && { lte: new Date(String(dataFim)) }),
      };
    }

    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(String(limit), 10) || 50));

    const [total, transacoes] = await Promise.all([
      db.transacaoBancaria.count({ where }),
      db.transacaoBancaria.findMany({
        where,
        include: INCLUDE_CLASSIFICACAO,
        orderBy: { dataMovimento: 'desc' },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
    ]);

    return res.status(200).json({
      transacoes,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (error) {
    console.error('Erro ao listar transações:', error);
    return res.status(500).json({ error: 'Erro ao listar transações' });
  }
});

// ==================== GET /financeiro/transacoes/:id ====================
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const transacao = await db.transacaoBancaria.findFirst({
      where: { id: req.params.id, instituicaoId: req.user!.instituicaoId },
      include: INCLUDE_CLASSIFICACAO,
    });
    if (!transacao) {
      return res.status(404).json({ error: 'Transação não encontrada' });
    }
    return res.status(200).json(transacao);
  } catch (error) {
    console.error('Erro ao buscar transação:', error);
    return res.status(500).json({ error: 'Erro ao buscar transação' });
  }
});

// ==================== PATCH /financeiro/transacoes/:id/classificar ====================
// Classificação manual. Se "criarRegra" vier no body, cria uma regra automática
// herdando esta classificação para futuras transações semelhantes.
router.patch('/:id/classificar', async (req: AuthRequest, res: Response) => {
  try {
    const transacao = await db.transacaoBancaria.findFirst({
      where: { id: req.params.id, instituicaoId: req.user!.instituicaoId },
    });
    if (!transacao) {
      return res.status(404).json({ error: 'Transação não encontrada' });
    }

    const { categoriaId, fornecedorId, projetoId, areaId, criarRegra } = req.body;

    if (!categoriaId && !fornecedorId && !projetoId && !areaId) {
      return res.status(400).json({
        error: 'Informe ao menos uma classificação (categoria, fornecedor, projeto ou área).',
      });
    }

    const erroVinculo = await validarVinculos(req.user!.instituicaoId, {
      categoriaId,
      fornecedorId,
      projetoId,
      areaId,
    });
    if (erroVinculo) {
      return res.status(400).json({ error: erroVinculo });
    }

    const atualizada = await db.transacaoBancaria.update({
      where: { id: transacao.id },
      data: {
        categoriaId: categoriaId ?? transacao.categoriaId,
        fornecedorId: fornecedorId ?? transacao.fornecedorId,
        projetoId: projetoId ?? transacao.projetoId,
        areaId: areaId ?? transacao.areaId,
        conciliada: true,
        regraAplicadaId: null, // classificação manual sobrepõe a automática
        updatedByEmail: req.user!.email,
      },
      include: INCLUDE_CLASSIFICACAO,
    });

    let regraCriada = null;
    if (criarRegra) {
      const { campo, operador, valor, nome, prioridade } = criarRegra;

      if (!CAMPOS_REGRA.includes(campo) || !OPERADORES_REGRA.includes(operador) || !valor?.toString().trim()) {
        return res.status(400).json({
          error: 'criarRegra inválida: informe campo, operador e valor válidos.',
        });
      }

      regraCriada = await db.regraConciliacao.create({
        data: {
          nome: nome?.trim() || null,
          campo,
          operador,
          valor: String(valor).trim(),
          tipoTransacao: transacao.tipo,
          categoriaId: atualizada.categoriaId,
          fornecedorId: atualizada.fornecedorId,
          projetoId: atualizada.projetoId,
          areaId: atualizada.areaId,
          prioridade: prioridade ?? 0,
          instituicaoId: req.user!.instituicaoId,
          updatedByEmail: req.user!.email,
        },
      });

      // Já aproveita e classifica as pendentes que casam com a nova regra
      await aplicarRegrasEmPendentes(req.user!.instituicaoId, [regraCriada], req.user!.email);
    }

    return res.status(200).json({ transacao: atualizada, regraCriada });
  } catch (error) {
    console.error('Erro ao classificar transação:', error);
    return res.status(500).json({ error: 'Erro ao classificar transação' });
  }
});

// ==================== PATCH /financeiro/transacoes/:id/desclassificar ====================
router.patch('/:id/desclassificar', async (req: AuthRequest, res: Response) => {
  try {
    const transacao = await db.transacaoBancaria.findFirst({
      where: { id: req.params.id, instituicaoId: req.user!.instituicaoId },
    });
    if (!transacao) {
      return res.status(404).json({ error: 'Transação não encontrada' });
    }

    const atualizada = await db.transacaoBancaria.update({
      where: { id: transacao.id },
      data: {
        categoriaId: null,
        fornecedorId: null,
        projetoId: null,
        areaId: null,
        conciliada: false,
        regraAplicadaId: null,
        updatedByEmail: req.user!.email,
      },
      include: INCLUDE_CLASSIFICACAO,
    });

    return res.status(200).json(atualizada);
  } catch (error) {
    console.error('Erro ao desclassificar transação:', error);
    return res.status(500).json({ error: 'Erro ao desclassificar transação' });
  }
});

// ==================== POST /financeiro/transacoes/reprocessar ====================
// Reaplica todas as regras ativas nas transações pendentes
router.post('/reprocessar', async (req: AuthRequest, res: Response) => {
  try {
    const regras = await db.regraConciliacao.findMany({
      where: { instituicaoId: req.user!.instituicaoId, ativo: true },
      orderBy: { prioridade: 'asc' },
    });

    if (regras.length === 0) {
      return res.status(200).json({ classificadas: 0, mensagem: 'Nenhuma regra ativa cadastrada.' });
    }

    const classificadas = await aplicarRegrasEmPendentes(
      req.user!.instituicaoId,
      regras,
      req.user!.email,
      req.body?.contaId,
    );

    return res.status(200).json({ classificadas });
  } catch (error) {
    console.error('Erro ao reprocessar transações:', error);
    return res.status(500).json({ error: 'Erro ao reprocessar transações' });
  }
});

export default router;
