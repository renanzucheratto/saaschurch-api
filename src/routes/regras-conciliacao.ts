import { Router, Response } from 'express';
import { prisma } from '../lib/prisma/client.js';
import { authenticateUser, requireUserType, AuthRequest } from '../middleware/auth.middleware.js';
import { aplicarRegras, CAMPOS_REGRA, OPERADORES_REGRA } from '../lib/conciliacao/regras.js';
import { validarVinculos } from '../helpers/financeiro.helper.js';

const router = Router();
const db = prisma as any;

router.use(authenticateUser);
router.use(requireUserType('backoffice', 'tesouraria', 'lider', 'pastor'));

function validarRegra(body: any): string | null {
  const { campo, operador, valor, tipoTransacao, categoriaId, fornecedorId, projetoId, areaId } = body;

  if (!CAMPOS_REGRA.includes(campo)) {
    return `Campo inválido. Use: ${CAMPOS_REGRA.join(', ')}.`;
  }
  if (!OPERADORES_REGRA.includes(operador)) {
    return `Operador inválido. Use: ${OPERADORES_REGRA.join(', ')}.`;
  }
  if (campo === 'valor' && !['equals', 'greater_than', 'less_than'].includes(operador)) {
    return 'Para o campo valor use equals, greater_than ou less_than.';
  }
  if (campo !== 'valor' && ['greater_than', 'less_than'].includes(operador)) {
    return 'Operadores numéricos só são válidos para o campo valor.';
  }
  if (!valor?.toString().trim()) {
    return 'O valor da regra é obrigatório.';
  }
  if (tipoTransacao && !['CREDITO', 'DEBITO'].includes(String(tipoTransacao).toUpperCase())) {
    return 'tipoTransacao inválido. Use CREDITO ou DEBITO.';
  }
  if (!categoriaId && !fornecedorId && !projetoId && !areaId) {
    return 'A regra precisa definir ao menos uma classificação (categoria, fornecedor, projeto ou área).';
  }
  return null;
}

// Reaplica uma lista de regras nas transações pendentes da instituição.
// Retorna quantas transações foram classificadas.
export async function aplicarRegrasEmPendentes(
  instituicaoId: string,
  regras: any[],
  updatedByEmail: string,
  contaBancariaId?: string,
): Promise<number> {
  const pendentes = await db.transacaoBancaria.findMany({
    where: {
      instituicaoId,
      conciliada: false,
      ...(contaBancariaId && { contaBancariaId }),
    },
  });

  let classificadas = 0;
  for (const transacao of pendentes) {
    const classificacao = aplicarRegras(transacao, regras);
    if (classificacao) {
      await db.transacaoBancaria.update({
        where: { id: transacao.id },
        data: { ...classificacao, conciliada: true, updatedByEmail },
      });
      classificadas++;
    }
  }
  return classificadas;
}

// ==================== GET /financeiro/regras ====================
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const regras = await db.regraConciliacao.findMany({
      where: { instituicaoId: req.user!.instituicaoId },
      include: {
        categoria: { select: { id: true, nome: true, tipo: true } },
        fornecedor: { select: { id: true, nome: true } },
        projeto: { select: { id: true, nome: true } },
        area: { select: { id: true, nome: true } },
      },
      orderBy: { prioridade: 'asc' },
    });
    return res.status(200).json(regras);
  } catch (error) {
    console.error('Erro ao listar regras:', error);
    return res.status(500).json({ error: 'Erro ao listar regras' });
  }
});

// ==================== GET /financeiro/regras/:id ====================
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const regra = await db.regraConciliacao.findFirst({
      where: { id: req.params.id, instituicaoId: req.user!.instituicaoId },
      include: {
        categoria: { select: { id: true, nome: true, tipo: true } },
        fornecedor: { select: { id: true, nome: true } },
        projeto: { select: { id: true, nome: true } },
        area: { select: { id: true, nome: true } },
      },
    });
    if (!regra) {
      return res.status(404).json({ error: 'Regra não encontrada' });
    }
    return res.status(200).json(regra);
  } catch (error) {
    console.error('Erro ao buscar regra:', error);
    return res.status(500).json({ error: 'Erro ao buscar regra' });
  }
});

// ==================== POST /financeiro/regras ====================
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const erro = validarRegra(req.body);
    if (erro) {
      return res.status(400).json({ error: erro });
    }

    const { nome, campo, operador, valor, tipoTransacao, categoriaId, fornecedorId, projetoId, areaId, prioridade } = req.body;

    const erroVinculo = await validarVinculos(req.user!.instituicaoId, {
      categoriaId,
      fornecedorId,
      projetoId,
      areaId,
    });
    if (erroVinculo) {
      return res.status(400).json({ error: erroVinculo });
    }

    const regra = await db.regraConciliacao.create({
      data: {
        nome: nome?.trim() || null,
        campo,
        operador,
        valor: String(valor).trim(),
        tipoTransacao: tipoTransacao ? String(tipoTransacao).toUpperCase() : null,
        categoriaId: categoriaId || null,
        fornecedorId: fornecedorId || null,
        projetoId: projetoId || null,
        areaId: areaId || null,
        prioridade: prioridade ?? 0,
        instituicaoId: req.user!.instituicaoId,
        updatedByEmail: req.user!.email,
      },
    });

    return res.status(201).json(regra);
  } catch (error) {
    console.error('Erro ao criar regra:', error);
    return res.status(500).json({ error: 'Erro ao criar regra' });
  }
});

// ==================== PUT /financeiro/regras/:id ====================
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const regra = await db.regraConciliacao.findFirst({
      where: { id: req.params.id, instituicaoId: req.user!.instituicaoId },
    });
    if (!regra) {
      return res.status(404).json({ error: 'Regra não encontrada' });
    }

    const merged = { ...regra, ...req.body };
    const erro = validarRegra(merged);
    if (erro) {
      return res.status(400).json({ error: erro });
    }

    const erroVinculo = await validarVinculos(req.user!.instituicaoId, {
      categoriaId: merged.categoriaId,
      fornecedorId: merged.fornecedorId,
      projetoId: merged.projetoId,
      areaId: merged.areaId,
    });
    if (erroVinculo) {
      return res.status(400).json({ error: erroVinculo });
    }

    const atualizada = await db.regraConciliacao.update({
      where: { id: regra.id },
      data: {
        nome: merged.nome?.trim() || null,
        campo: merged.campo,
        operador: merged.operador,
        valor: String(merged.valor).trim(),
        tipoTransacao: merged.tipoTransacao ? String(merged.tipoTransacao).toUpperCase() : null,
        categoriaId: merged.categoriaId || null,
        fornecedorId: merged.fornecedorId || null,
        projetoId: merged.projetoId || null,
        areaId: merged.areaId || null,
        prioridade: merged.prioridade ?? 0,
        ...(req.body.ativo !== undefined && { ativo: !!req.body.ativo }),
        updatedByEmail: req.user!.email,
      },
    });

    return res.status(200).json(atualizada);
  } catch (error) {
    console.error('Erro ao atualizar regra:', error);
    return res.status(500).json({ error: 'Erro ao atualizar regra' });
  }
});

// ==================== DELETE /financeiro/regras/:id ====================
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const regra = await db.regraConciliacao.findFirst({
      where: { id: req.params.id, instituicaoId: req.user!.instituicaoId },
    });
    if (!regra) {
      return res.status(404).json({ error: 'Regra não encontrada' });
    }

    await db.regraConciliacao.delete({ where: { id: regra.id } });
    return res.status(200).json({ message: 'Regra excluída com sucesso' });
  } catch (error) {
    console.error('Erro ao excluir regra:', error);
    return res.status(500).json({ error: 'Erro ao excluir regra' });
  }
});

// ==================== POST /financeiro/regras/:id/aplicar ====================
// Roda esta regra nas transações pendentes da instituição
router.post('/:id/aplicar', async (req: AuthRequest, res: Response) => {
  try {
    const regra = await db.regraConciliacao.findFirst({
      where: { id: req.params.id, instituicaoId: req.user!.instituicaoId },
    });
    if (!regra) {
      return res.status(404).json({ error: 'Regra não encontrada' });
    }
    if (!regra.ativo) {
      return res.status(400).json({ error: 'A regra está inativa.' });
    }

    const classificadas = await aplicarRegrasEmPendentes(
      req.user!.instituicaoId,
      [regra],
      req.user!.email,
      req.body?.contaId,
    );

    return res.status(200).json({ classificadas });
  } catch (error) {
    console.error('Erro ao aplicar regra:', error);
    return res.status(500).json({ error: 'Erro ao aplicar regra' });
  }
});

export default router;
