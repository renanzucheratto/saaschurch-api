import { Router, Response } from 'express';
import { prisma } from '../lib/prisma/client.js';
import {
  authenticateUser,
  requireBackoffice,
  AuthRequest,
} from '../middleware/auth.middleware.js';
import { resolveRegraSplit, validarOverridesSplit } from '../helpers/split.helper.js';

const router = Router();

function paramString(valor: unknown): string {
  return Array.isArray(valor) ? String(valor[0]) : String(valor);
}

// GET /planos - lista todos os planos (backoffice)
router.get('/', authenticateUser, requireBackoffice, async (_req: AuthRequest, res: Response) => {
  try {
    const planos = await prisma.plano.findMany({
      orderBy: [{ ordem: 'asc' }, { nome: 'asc' }],
      include: { _count: { select: { instituicoes: true } } },
    });

    return res.status(200).json(planos);
  } catch (error) {
    console.error('Erro ao listar planos:', error);
    return res.status(500).json({ error: 'Erro ao listar planos' });
  }
});

// GET /planos/meu - plano e regra de split efetiva da instituição do usuário
router.get('/meu', authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const instituicao = await prisma.instituicao.findUnique({
      where: { id: req.user!.instituicaoId },
      include: { plano: true },
    });

    if (!instituicao) {
      return res.status(404).json({ error: 'Instituição não encontrada' });
    }

    const regra = resolveRegraSplit(instituicao, instituicao.plano);

    return res.status(200).json({
      plano: instituicao.plano,
      planoAtribuidoEm: instituicao.planoAtribuidoEm,
      split: regra,
    });
  } catch (error) {
    console.error('Erro ao buscar plano da instituição:', error);
    return res.status(500).json({ error: 'Erro ao buscar plano' });
  }
});

/**
 * Um plano só pode ser escolhido pela própria instituição se for gratuito.
 * Plano pago envolve cobrança recorrente (preapproval), que não existe nesta
 * entrega — deixar auto-atribuível daria acesso pago sem nenhuma cobrança.
 */
function planoEhAutoSelecionavel(plano: { ativo: boolean; valorMensal: unknown }): boolean {
  return plano.ativo && Number(plano.valorMensal) === 0;
}

// GET /planos/disponiveis - catálogo para a tela de seleção
router.get('/disponiveis', authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const [planos, instituicao] = await Promise.all([
      prisma.plano.findMany({
        where: { ativo: true },
        orderBy: [{ ordem: 'asc' }, { valorMensal: 'asc' }],
      }),
      prisma.instituicao.findUnique({
        where: { id: req.user!.instituicaoId },
        select: { planoId: true },
      }),
    ]);

    return res.status(200).json({
      planoAtualId: instituicao?.planoId ?? null,
      planos: planos.map((plano) => ({
        id: plano.id,
        codigo: plano.codigo,
        nome: plano.nome,
        descricao: plano.descricao,
        valorMensal: plano.valorMensal,
        feeEventoPercentual: plano.feeEventoPercentual,
        feeEventoMinimo: plano.feeEventoMinimo,
        feeEventoMaximo: plano.feeEventoMaximo,
        limiteEventosAtivos: plano.limiteEventosAtivos,
        limiteUsuarios: plano.limiteUsuarios,
        features: plano.features,
        atual: plano.id === instituicao?.planoId,
        selecionavel: planoEhAutoSelecionavel(plano),
        // Motivo de não ser selecionável, para a tela explicar em vez de só
        // desabilitar o botão sem dizer por quê.
        motivoIndisponivel: planoEhAutoSelecionavel(plano)
          ? null
          : 'Plano pago ainda não disponível para contratação automática. Fale com o suporte.',
      })),
    });
  } catch (error) {
    console.error('Erro ao listar planos disponíveis:', error);
    return res.status(500).json({ error: 'Erro ao listar planos' });
  }
});

// PUT /planos/meu - a instituição troca o próprio plano (só gratuitos)
router.put('/meu', authenticateUser, requireBackoffice, async (req: AuthRequest, res: Response) => {
  try {
    const { planoId } = req.body;

    if (!planoId) {
      return res.status(400).json({ error: 'planoId é obrigatório' });
    }

    const plano = await prisma.plano.findUnique({ where: { id: planoId } });

    if (!plano) {
      return res.status(404).json({ error: 'Plano não encontrado' });
    }

    if (!plano.ativo) {
      return res.status(400).json({ error: 'Este plano não está disponível' });
    }

    if (!planoEhAutoSelecionavel(plano)) {
      return res.status(403).json({
        error:
          'Plano pago não pode ser contratado por aqui. Fale com o suporte para ativar a cobrança.',
      });
    }

    const atualizada = await prisma.instituicao.update({
      where: { id: req.user!.instituicaoId },
      data: {
        planoId: plano.id,
        planoAtribuidoEm: new Date(),
        planoAtribuidoPor: req.user!.email,
      },
      include: { plano: true },
    });

    return res.status(200).json({
      message: `Plano ${plano.nome} ativado`,
      plano: atualizada.plano,
      planoAtribuidoEm: atualizada.planoAtribuidoEm,
      split: resolveRegraSplit(atualizada, atualizada.plano),
    });
  } catch (error) {
    console.error('Erro ao atualizar plano da instituição:', error);
    return res.status(500).json({ error: 'Erro ao atualizar plano' });
  }
});

// POST /planos - cria plano (backoffice)
router.post('/', authenticateUser, requireBackoffice, async (req: AuthRequest, res: Response) => {
  try {
    const {
      codigo,
      nome,
      descricao,
      cobrancaSaaS,
      valorMensal,
      valorAnual,
      feeEventoPercentual,
      feeEventoMinimo,
      feeEventoMaximo,
      limiteEventosAtivos,
      limiteUsuarios,
      features,
      ativo,
      ordem,
    } = req.body;

    if (!codigo || !nome) {
      return res.status(400).json({ error: 'Campos obrigatórios: codigo, nome' });
    }

    const existente = await prisma.plano.findUnique({ where: { codigo } });

    if (existente) {
      return res.status(400).json({ error: 'Já existe um plano com este código' });
    }

    const erros = validarOverridesSplit({
      splitPercentual: feeEventoPercentual,
      splitMinimo: feeEventoMinimo,
      splitMaximo: feeEventoMaximo,
    });

    if (erros.length > 0) {
      return res.status(400).json({ error: erros.join('; ') });
    }

    const plano = await prisma.plano.create({
      data: {
        codigo,
        nome,
        descricao: descricao ?? null,
        cobrancaSaaS: cobrancaSaaS ?? true,
        valorMensal: valorMensal ?? 0,
        valorAnual: valorAnual ?? null,
        feeEventoPercentual: feeEventoPercentual ?? 0,
        feeEventoMinimo: feeEventoMinimo ?? 0,
        feeEventoMaximo: feeEventoMaximo ?? null,
        limiteEventosAtivos: limiteEventosAtivos ?? null,
        limiteUsuarios: limiteUsuarios ?? null,
        features: features ?? {},
        ativo: ativo ?? true,
        ordem: ordem ?? 0,
      },
    });

    return res.status(201).json({ message: 'Plano criado com sucesso', plano });
  } catch (error) {
    console.error('Erro ao criar plano:', error);
    return res.status(500).json({ error: 'Erro ao criar plano' });
  }
});

// PUT /planos/:id - atualiza plano (backoffice)
router.put('/:id', authenticateUser, requireBackoffice, async (req: AuthRequest, res: Response) => {
  try {
    const id = paramString(req.params.id);

    const plano = await prisma.plano.findUnique({ where: { id } });

    if (!plano) {
      return res.status(404).json({ error: 'Plano não encontrado' });
    }

    const {
      nome,
      descricao,
      cobrancaSaaS,
      valorMensal,
      valorAnual,
      feeEventoPercentual,
      feeEventoMinimo,
      feeEventoMaximo,
      limiteEventosAtivos,
      limiteUsuarios,
      features,
      ativo,
      ordem,
    } = req.body;

    const erros = validarOverridesSplit({
      splitPercentual: feeEventoPercentual,
      splitMinimo: feeEventoMinimo,
      splitMaximo: feeEventoMaximo,
    });

    if (erros.length > 0) {
      return res.status(400).json({ error: erros.join('; ') });
    }

    const atualizado = await prisma.plano.update({
      where: { id },
      data: {
        nome: nome ?? plano.nome,
        descricao: descricao !== undefined ? descricao : plano.descricao,
        cobrancaSaaS: cobrancaSaaS !== undefined ? cobrancaSaaS : plano.cobrancaSaaS,
        valorMensal: valorMensal !== undefined ? valorMensal : plano.valorMensal,
        valorAnual: valorAnual !== undefined ? valorAnual : plano.valorAnual,
        feeEventoPercentual:
          feeEventoPercentual !== undefined ? feeEventoPercentual : plano.feeEventoPercentual,
        feeEventoMinimo:
          feeEventoMinimo !== undefined ? feeEventoMinimo : plano.feeEventoMinimo,
        feeEventoMaximo:
          feeEventoMaximo !== undefined ? feeEventoMaximo : plano.feeEventoMaximo,
        limiteEventosAtivos:
          limiteEventosAtivos !== undefined ? limiteEventosAtivos : plano.limiteEventosAtivos,
        limiteUsuarios: limiteUsuarios !== undefined ? limiteUsuarios : plano.limiteUsuarios,
        features: features !== undefined ? features : (plano.features as any),
        ativo: ativo !== undefined ? ativo : plano.ativo,
        ordem: ordem !== undefined ? ordem : plano.ordem,
      },
    });

    return res.status(200).json({ message: 'Plano atualizado', plano: atualizado });
  } catch (error) {
    console.error('Erro ao atualizar plano:', error);
    return res.status(500).json({ error: 'Erro ao atualizar plano' });
  }
});

// PUT /planos/instituicoes/:id/plano - atribui plano a uma instituição
router.put(
  '/instituicoes/:id/plano',
  authenticateUser,
  requireBackoffice,
  async (req: AuthRequest, res: Response) => {
    try {
      const id = paramString(req.params.id);
      const { planoId } = req.body;

      if (!planoId) {
        return res.status(400).json({ error: 'planoId é obrigatório' });
      }

      const [instituicao, plano] = await Promise.all([
        prisma.instituicao.findUnique({ where: { id } }),
        prisma.plano.findUnique({ where: { id: planoId } }),
      ]);

      if (!instituicao) {
        return res.status(404).json({ error: 'Instituição não encontrada' });
      }

      if (!plano) {
        return res.status(404).json({ error: 'Plano não encontrado' });
      }

      const atualizada = await prisma.instituicao.update({
        where: { id },
        data: {
          planoId,
          planoAtribuidoEm: new Date(),
          planoAtribuidoPor: req.user!.email,
        },
        include: { plano: true },
      });

      return res.status(200).json({
        message: 'Plano atribuído com sucesso',
        instituicao: atualizada,
        split: resolveRegraSplit(atualizada, atualizada.plano),
      });
    } catch (error) {
      console.error('Erro ao atribuir plano:', error);
      return res.status(500).json({ error: 'Erro ao atribuir plano' });
    }
  },
);

// GET /planos/instituicoes/:id/split - regra efetiva, com origem por campo
router.get(
  '/instituicoes/:id/split',
  authenticateUser,
  async (req: AuthRequest, res: Response) => {
    try {
      const id = paramString(req.params.id);

      if (req.user!.userType !== 'backoffice' && req.user!.instituicaoId !== id) {
        return res.status(403).json({ error: 'Acesso negado' });
      }

      const instituicao = await prisma.instituicao.findUnique({
        where: { id },
        include: { plano: true },
      });

      if (!instituicao) {
        return res.status(404).json({ error: 'Instituição não encontrada' });
      }

      return res.status(200).json({
        instituicaoId: instituicao.id,
        plano: instituicao.plano
          ? {
              id: instituicao.plano.id,
              codigo: instituicao.plano.codigo,
              nome: instituicao.plano.nome,
              feeEventoPercentual: instituicao.plano.feeEventoPercentual,
              feeEventoMinimo: instituicao.plano.feeEventoMinimo,
              feeEventoMaximo: instituicao.plano.feeEventoMaximo,
            }
          : null,
        overrides: {
          splitPercentual: instituicao.splitPercentual,
          splitMinimo: instituicao.splitMinimo,
          splitMaximo: instituicao.splitMaximo,
          splitObservacao: instituicao.splitObservacao,
        },
        efetivo: resolveRegraSplit(instituicao, instituicao.plano),
      });
    } catch (error) {
      console.error('Erro ao buscar split da instituição:', error);
      return res.status(500).json({ error: 'Erro ao buscar configuração de split' });
    }
  },
);

// PUT /planos/instituicoes/:id/split - grava overrides (null volta a herdar)
router.put(
  '/instituicoes/:id/split',
  authenticateUser,
  requireBackoffice,
  async (req: AuthRequest, res: Response) => {
    try {
      const id = paramString(req.params.id);
      const {
        splitTipo,
        splitValorFixo,
        splitPercentual,
        splitMinimo,
        splitMaximo,
        splitObservacao,
      } = req.body;

      const instituicao = await prisma.instituicao.findUnique({
        where: { id },
        include: { plano: true },
      });

      if (!instituicao) {
        return res.status(404).json({ error: 'Instituição não encontrada' });
      }

      // Valida a combinação final (override novo + o que permanece), não só o
      // que veio no corpo: mandar só splitMaximo poderia deixar maximo < minimo.
      const combinado = {
        splitTipo: splitTipo !== undefined ? splitTipo : instituicao.splitTipo,
        splitValorFixo:
          splitValorFixo !== undefined ? splitValorFixo : instituicao.splitValorFixo,
        splitPercentual:
          splitPercentual !== undefined ? splitPercentual : instituicao.splitPercentual,
        splitMinimo: splitMinimo !== undefined ? splitMinimo : instituicao.splitMinimo,
        splitMaximo: splitMaximo !== undefined ? splitMaximo : instituicao.splitMaximo,
      };

      const erros = validarOverridesSplit({
        splitTipo: combinado.splitTipo,
        splitValorFixo:
          combinado.splitValorFixo === null ? null : Number(combinado.splitValorFixo),
        splitPercentual:
          combinado.splitPercentual === null ? null : Number(combinado.splitPercentual),
        splitMinimo: combinado.splitMinimo === null ? null : Number(combinado.splitMinimo),
        splitMaximo: combinado.splitMaximo === null ? null : Number(combinado.splitMaximo),
      });

      if (erros.length > 0) {
        return res.status(400).json({ error: erros.join('; ') });
      }

      const atualizada = await prisma.instituicao.update({
        where: { id },
        data: {
          splitTipo: combinado.splitTipo,
          splitValorFixo: combinado.splitValorFixo,
          splitPercentual: combinado.splitPercentual,
          splitMinimo: combinado.splitMinimo,
          splitMaximo: combinado.splitMaximo,
          splitObservacao:
            splitObservacao !== undefined ? splitObservacao : instituicao.splitObservacao,
          updatedByEmail: req.user!.email,
        },
        include: { plano: true },
      });

      return res.status(200).json({
        message: 'Configuração de split atualizada',
        overrides: {
          splitPercentual: atualizada.splitPercentual,
          splitMinimo: atualizada.splitMinimo,
          splitMaximo: atualizada.splitMaximo,
          splitObservacao: atualizada.splitObservacao,
        },
        efetivo: resolveRegraSplit(atualizada, atualizada.plano),
      });
    } catch (error) {
      console.error('Erro ao atualizar split:', error);
      return res.status(500).json({ error: 'Erro ao atualizar configuração de split' });
    }
  },
);

export default router;
