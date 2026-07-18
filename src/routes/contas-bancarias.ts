import { Router, Response } from 'express';
import { prisma } from '../lib/prisma/client.js';
import { authenticateUser, requireUserType, AuthRequest } from '../middleware/auth.middleware.js';
import { obterExtrato } from '../lib/bradesco/extrato-client.js';
import { parseExtratoPorPeriodo } from '../lib/conciliacao/parser.js';
import { aplicarRegras } from '../lib/conciliacao/regras.js';

const router = Router();
const db = prisma as any;

router.use(authenticateUser);
router.use(requireUserType('backoffice', 'tesouraria', 'lider', 'pastor'));

// Aceita "ddMMyyyy" ou "yyyy-MM-dd" e normaliza para "ddMMyyyy" (formato do Bradesco)
function normalizarDataBradesco(data: string): string | null {
  if (/^\d{8}$/.test(data)) return data;
  const iso = data.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}${iso[2]}${iso[1]}`;
  return null;
}

// "ddMMyyyy" -> Date (UTC)
function dataBradescoParaDate(ddMMyyyy: string): Date {
  const dia = Number(ddMMyyyy.slice(0, 2));
  const mes = Number(ddMMyyyy.slice(2, 4));
  const ano = Number(ddMMyyyy.slice(4, 8));
  return new Date(Date.UTC(ano, mes - 1, dia));
}

async function buscarConta(req: AuthRequest) {
  return db.contaBancaria.findFirst({
    where: { id: req.params.id, instituicaoId: req.user!.instituicaoId },
  });
}

// ==================== GET /financeiro/contas ====================
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const contas = await db.contaBancaria.findMany({
      where: { instituicaoId: req.user!.instituicaoId },
      orderBy: { createdAt: 'asc' },
    });
    return res.status(200).json(contas);
  } catch (error) {
    console.error('Erro ao listar contas bancárias:', error);
    return res.status(500).json({ error: 'Erro ao listar contas bancárias' });
  }
});

// ==================== GET /financeiro/contas/:id ====================
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const conta = await buscarConta(req);
    if (!conta) {
      return res.status(404).json({ error: 'Conta bancária não encontrada' });
    }
    return res.status(200).json(conta);
  } catch (error) {
    console.error('Erro ao buscar conta bancária:', error);
    return res.status(500).json({ error: 'Erro ao buscar conta bancária' });
  }
});

// ==================== POST /financeiro/contas ====================
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { banco, agencia, conta, digito, descricao, saldoInicial, dataSaldoInicial } = req.body;
    if (!banco?.trim() || !agencia?.trim() || !conta?.trim()) {
      return res.status(400).json({ error: 'Banco, agência e conta são obrigatórios.' });
    }

    const existing = await db.contaBancaria.findFirst({
      where: {
        banco: banco.trim(),
        agencia: agencia.trim(),
        conta: conta.trim(),
        instituicaoId: req.user!.instituicaoId,
      },
    });
    if (existing) {
      return res.status(400).json({ error: 'Esta conta bancária já está cadastrada.' });
    }

    const nova = await db.contaBancaria.create({
      data: {
        banco: banco.trim(),
        agencia: agencia.trim(),
        conta: conta.trim(),
        digito: digito || null,
        descricao: descricao || null,
        saldoInicial: saldoInicial ?? 0,
        dataSaldoInicial: dataSaldoInicial ? new Date(dataSaldoInicial) : null,
        instituicaoId: req.user!.instituicaoId,
        updatedByEmail: req.user!.email,
      },
    });

    return res.status(201).json(nova);
  } catch (error) {
    console.error('Erro ao criar conta bancária:', error);
    return res.status(500).json({ error: 'Erro ao criar conta bancária' });
  }
});

// ==================== PUT /financeiro/contas/:id ====================
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const conta = await buscarConta(req);
    if (!conta) {
      return res.status(404).json({ error: 'Conta bancária não encontrada' });
    }

    const { banco, agencia, conta: numeroConta, digito, descricao, saldoInicial, dataSaldoInicial, ativo } = req.body;

    const atualizada = await db.contaBancaria.update({
      where: { id: conta.id },
      data: {
        ...(banco !== undefined && { banco: banco.trim() }),
        ...(agencia !== undefined && { agencia: agencia.trim() }),
        ...(numeroConta !== undefined && { conta: numeroConta.trim() }),
        ...(digito !== undefined && { digito: digito || null }),
        ...(descricao !== undefined && { descricao: descricao || null }),
        ...(saldoInicial !== undefined && { saldoInicial }),
        ...(dataSaldoInicial !== undefined && {
          dataSaldoInicial: dataSaldoInicial ? new Date(dataSaldoInicial) : null,
        }),
        ...(ativo !== undefined && { ativo: !!ativo }),
        updatedByEmail: req.user!.email,
      },
    });

    return res.status(200).json(atualizada);
  } catch (error) {
    console.error('Erro ao atualizar conta bancária:', error);
    return res.status(500).json({ error: 'Erro ao atualizar conta bancária' });
  }
});

// ==================== DELETE /financeiro/contas/:id ====================
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const conta = await buscarConta(req);
    if (!conta) {
      return res.status(404).json({ error: 'Conta bancária não encontrada' });
    }

    const totalTransacoes = await db.transacaoBancaria.count({
      where: { contaBancariaId: conta.id },
    });
    if (totalTransacoes > 0) {
      return res.status(400).json({
        error: 'Esta conta possui transações importadas. Desative-a em vez de excluir.',
      });
    }

    await db.contaBancaria.delete({ where: { id: conta.id } });
    return res.status(200).json({ message: 'Conta bancária excluída com sucesso' });
  } catch (error) {
    console.error('Erro ao excluir conta bancária:', error);
    return res.status(500).json({ error: 'Erro ao excluir conta bancária' });
  }
});

// ==================== GET /financeiro/contas/:id/saldo ====================
router.get('/:id/saldo', async (req: AuthRequest, res: Response) => {
  try {
    const conta = await buscarConta(req);
    if (!conta) {
      return res.status(404).json({ error: 'Conta bancária não encontrada' });
    }

    const somas = await db.transacaoBancaria.groupBy({
      by: ['tipo'],
      where: { contaBancariaId: conta.id },
      _sum: { valor: true },
    });

    const totalCreditos = Number(somas.find((s: any) => s.tipo === 'CREDITO')?._sum?.valor ?? 0);
    const totalDebitos = Number(somas.find((s: any) => s.tipo === 'DEBITO')?._sum?.valor ?? 0);
    const saldoInicial = Number(conta.saldoInicial);

    return res.status(200).json({
      saldoInicial,
      dataSaldoInicial: conta.dataSaldoInicial,
      totalCreditos,
      totalDebitos,
      saldoAtual: saldoInicial + totalCreditos - totalDebitos,
    });
  } catch (error) {
    console.error('Erro ao calcular saldo:', error);
    return res.status(500).json({ error: 'Erro ao calcular saldo' });
  }
});

// ==================== POST /financeiro/contas/:id/importar ====================
router.post('/:id/importar', async (req: AuthRequest, res: Response) => {
  try {
    const conta = await buscarConta(req);
    if (!conta) {
      return res.status(404).json({ error: 'Conta bancária não encontrada' });
    }

    const { dataInicio, dataFim } = req.body;
    if (!dataInicio || !dataFim) {
      return res.status(400).json({ error: 'dataInicio e dataFim são obrigatórios.' });
    }
    const inicioNormalizado = normalizarDataBradesco(String(dataInicio));
    const fimNormalizado = normalizarDataBradesco(String(dataFim));
    if (!inicioNormalizado || !fimNormalizado) {
      return res.status(400).json({ error: 'Datas inválidas. Use ddMMyyyy ou yyyy-MM-dd.' });
    }

    const extrato = await obterExtrato({
      agencia: conta.agencia,
      conta: conta.conta,
      dataInicio: inicioNormalizado,
      dataFim: fimNormalizado,
    });

    let candidatas = parseExtratoPorPeriodo(extrato, conta.id);
    const totalNoExtrato = candidatas.length;

    // Garante o período solicitado mesmo se a origem (mock/API) devolver além dele
    const inicio = dataBradescoParaDate(inicioNormalizado);
    const fim = dataBradescoParaDate(fimNormalizado);
    candidatas = candidatas.filter((t) => t.dataMovimento >= inicio && t.dataMovimento <= fim);

    // Ponto de partida da conciliação: ignora lançamentos anteriores ao saldo inicial
    let ignoradasPorSaldoInicial = 0;
    if (conta.dataSaldoInicial) {
      const antes = candidatas.length;
      candidatas = candidatas.filter((t) => t.dataMovimento >= conta.dataSaldoInicial);
      ignoradasPorSaldoInicial = antes - candidatas.length;
    }

    const hashesExistentes = await db.transacaoBancaria.findMany({
      where: { hashDedup: { in: candidatas.map((t) => t.hashDedup) } },
      select: { hashDedup: true },
    });
    const setExistentes = new Set(hashesExistentes.map((h: any) => h.hashDedup));
    const novas = candidatas.filter((t) => !setExistentes.has(t.hashDedup));

    if (novas.length > 0) {
      await db.transacaoBancaria.createMany({
        data: novas.map((t) => ({
          ...t,
          contaBancariaId: conta.id,
          instituicaoId: req.user!.instituicaoId,
          updatedByEmail: req.user!.email,
        })),
        skipDuplicates: true,
      });
    }

    // Classificação automática das recém-importadas
    const regras = await db.regraConciliacao.findMany({
      where: { instituicaoId: req.user!.instituicaoId, ativo: true },
      orderBy: { prioridade: 'asc' },
    });

    let classificadas = 0;
    if (regras.length > 0 && novas.length > 0) {
      const inseridas = await db.transacaoBancaria.findMany({
        where: { hashDedup: { in: novas.map((t) => t.hashDedup) } },
      });

      for (const transacao of inseridas) {
        const classificacao = aplicarRegras(transacao, regras);
        if (classificacao) {
          await db.transacaoBancaria.update({
            where: { id: transacao.id },
            data: {
              ...classificacao,
              conciliada: true,
              updatedByEmail: req.user!.email,
            },
          });
          classificadas++;
        }
      }
    }

    return res.status(200).json({
      importadas: novas.length,
      duplicadasIgnoradas: candidatas.length - novas.length,
      classificadas,
      pendentes: novas.length - classificadas,
      foraDoPeriodo: totalNoExtrato - candidatas.length - ignoradasPorSaldoInicial,
      ignoradasPorSaldoInicial,
    });
  } catch (error) {
    console.error('Erro ao importar extrato:', error);
    return res.status(500).json({ error: 'Erro ao importar extrato' });
  }
});

export default router;
