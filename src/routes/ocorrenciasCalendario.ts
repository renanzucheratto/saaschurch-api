import { Router, Response } from 'express';
import { prisma } from '../lib/prisma/client.js';
import { authenticateUser, AuthRequest, requireLiderOrBackoffice } from '../middleware/auth.middleware.js';

const router = Router();
const db = prisma as any;
const REGEX_HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

router.use(authenticateUser);

const INCLUDE_OCORRENCIA = {
  areas: { include: { area: { select: { id: true, nome: true, cor: true } } } },
  excecoes: true,
};

function formatOcorrencia(ocorrencia: any) {
  return {
    id: ocorrencia.id,
    titulo: ocorrencia.titulo,
    nota: ocorrencia.nota,
    dataInicio: ocorrencia.dataInicio,
    dataFim: ocorrencia.dataFim,
    horaInicioDefault: ocorrencia.horaInicioDefault,
    horaFimDefault: ocorrencia.horaFimDefault,
    areas: ocorrencia.areas.map((oa: any) => oa.area),
    excecoes: ocorrencia.excecoes.map((e: any) => ({
      id: e.id,
      data: e.data,
      horaInicio: e.horaInicio,
      horaFim: e.horaFim,
    })),
    createdAt: ocorrencia.createdAt,
    updatedAt: ocorrencia.updatedAt,
  };
}

function validarPayload(body: any): string | null {
  const { titulo, dataInicio, dataFim, horaInicioDefault, horaFimDefault, excecoes } = body;

  if (!titulo?.trim()) return 'O título é obrigatório.';
  if (!dataInicio || !dataFim) return 'As datas de início e fim são obrigatórias.';

  const inicio = new Date(dataInicio);
  const fim = new Date(dataFim);
  if (Number.isNaN(inicio.getTime()) || Number.isNaN(fim.getTime())) return 'Datas inválidas.';
  if (fim < inicio) return 'A data final deve ser igual ou posterior à data inicial.';

  if (!horaInicioDefault || !REGEX_HORA.test(horaInicioDefault)) return 'Horário de início padrão inválido.';
  if (!horaFimDefault || !REGEX_HORA.test(horaFimDefault)) return 'Horário de fim padrão inválido.';

  if (excecoes) {
    if (!Array.isArray(excecoes)) return 'Exceções devem ser uma lista.';
    const inicioDia = new Date(inicio.toDateString());
    const fimDia = new Date(fim.toDateString());
    for (const excecao of excecoes) {
      if (!excecao.data) return 'Toda exceção precisa de uma data.';
      const dataExcecao = new Date(new Date(excecao.data).toDateString());
      if (dataExcecao < inicioDia || dataExcecao > fimDia) {
        return 'Toda exceção deve ter uma data dentro do intervalo da ocorrência.';
      }
      if (!excecao.horaInicio || !REGEX_HORA.test(excecao.horaInicio)) return 'Horário de início da exceção inválido.';
      if (!excecao.horaFim || !REGEX_HORA.test(excecao.horaFim)) return 'Horário de fim da exceção inválido.';
    }
  }

  return null;
}

// ==================== GET /ocorrencias-calendario ====================
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query;
    const where: any = { instituicaoId: req.user!.instituicaoId };
    if (from || to) {
      where.AND = [
        ...(to ? [{ dataInicio: { lte: new Date(to as string) } }] : []),
        ...(from ? [{ dataFim: { gte: new Date(from as string) } }] : []),
      ];
    }

    const ocorrencias = await db.ocorrenciaCalendario.findMany({
      where,
      include: INCLUDE_OCORRENCIA,
      orderBy: { dataInicio: 'asc' },
    });

    return res.status(200).json(ocorrencias.map(formatOcorrencia));
  } catch (error) {
    console.error('Erro ao listar ocorrências do calendário:', error);
    return res.status(500).json({ error: 'Erro ao listar ocorrências do calendário' });
  }
});

// ==================== GET /ocorrencias-calendario/:id ====================
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const ocorrencia = await db.ocorrenciaCalendario.findUnique({
      where: { id: req.params.id },
      include: INCLUDE_OCORRENCIA,
    });

    if (!ocorrencia || ocorrencia.instituicaoId !== req.user!.instituicaoId) {
      return res.status(404).json({ error: 'Ocorrência não encontrada' });
    }

    return res.status(200).json(formatOcorrencia(ocorrencia));
  } catch (error) {
    console.error('Erro ao buscar ocorrência do calendário:', error);
    return res.status(500).json({ error: 'Erro ao buscar ocorrência do calendário' });
  }
});

// ==================== POST /ocorrencias-calendario ====================
router.post('/', requireLiderOrBackoffice, async (req: AuthRequest, res: Response) => {
  try {
    const erro = validarPayload(req.body);
    if (erro) return res.status(400).json({ error: erro });

    const { titulo, nota, dataInicio, dataFim, horaInicioDefault, horaFimDefault, areaIds, excecoes } = req.body;

    const ocorrencia = await db.$transaction(async (tx: any) => {
      const criada = await tx.ocorrenciaCalendario.create({
        data: {
          titulo: titulo.trim(),
          nota: nota?.trim() || null,
          dataInicio: new Date(dataInicio),
          dataFim: new Date(dataFim),
          horaInicioDefault,
          horaFimDefault,
          instituicaoId: req.user!.instituicaoId,
          userId: req.user!.id,
          updatedByEmail: req.user!.email,
        },
      });

      if (Array.isArray(areaIds) && areaIds.length > 0) {
        await tx.ocorrenciaArea.createMany({
          data: areaIds.map((areaId: string) => ({ ocorrenciaId: criada.id, areaId })),
        });
      }

      if (Array.isArray(excecoes) && excecoes.length > 0) {
        await tx.ocorrenciaHorarioExcecao.createMany({
          data: excecoes.map((e: any) => ({
            ocorrenciaId: criada.id,
            data: new Date(new Date(e.data).toDateString()),
            horaInicio: e.horaInicio,
            horaFim: e.horaFim,
          })),
        });
      }

      return tx.ocorrenciaCalendario.findUnique({
        where: { id: criada.id },
        include: INCLUDE_OCORRENCIA,
      });
    });

    return res.status(201).json(formatOcorrencia(ocorrencia));
  } catch (error) {
    console.error('Erro ao criar ocorrência do calendário:', error);
    return res.status(500).json({ error: 'Erro ao criar ocorrência do calendário' });
  }
});

// ==================== PUT /ocorrencias-calendario/:id ====================
router.put('/:id', requireLiderOrBackoffice, async (req: AuthRequest, res: Response) => {
  try {
    const existente = await db.ocorrenciaCalendario.findUnique({ where: { id: req.params.id } });
    if (!existente || existente.instituicaoId !== req.user!.instituicaoId) {
      return res.status(404).json({ error: 'Ocorrência não encontrada' });
    }

    const erro = validarPayload(req.body);
    if (erro) return res.status(400).json({ error: erro });

    const { titulo, nota, dataInicio, dataFim, horaInicioDefault, horaFimDefault, areaIds, excecoes } = req.body;

    const ocorrencia = await db.$transaction(async (tx: any) => {
      await tx.ocorrenciaCalendario.update({
        where: { id: req.params.id },
        data: {
          titulo: titulo.trim(),
          nota: nota?.trim() || null,
          dataInicio: new Date(dataInicio),
          dataFim: new Date(dataFim),
          horaInicioDefault,
          horaFimDefault,
          updatedByEmail: req.user!.email,
        },
      });

      await tx.ocorrenciaArea.deleteMany({ where: { ocorrenciaId: req.params.id } });
      if (Array.isArray(areaIds) && areaIds.length > 0) {
        await tx.ocorrenciaArea.createMany({
          data: areaIds.map((areaId: string) => ({ ocorrenciaId: req.params.id as string, areaId })),
        });
      }

      await tx.ocorrenciaHorarioExcecao.deleteMany({ where: { ocorrenciaId: req.params.id } });
      if (Array.isArray(excecoes) && excecoes.length > 0) {
        await tx.ocorrenciaHorarioExcecao.createMany({
          data: excecoes.map((e: any) => ({
            ocorrenciaId: req.params.id as string,
            data: new Date(new Date(e.data).toDateString()),
            horaInicio: e.horaInicio,
            horaFim: e.horaFim,
          })),
        });
      }

      return tx.ocorrenciaCalendario.findUnique({
        where: { id: req.params.id },
        include: INCLUDE_OCORRENCIA,
      });
    });

    return res.status(200).json(formatOcorrencia(ocorrencia));
  } catch (error) {
    console.error('Erro ao atualizar ocorrência do calendário:', error);
    return res.status(500).json({ error: 'Erro ao atualizar ocorrência do calendário' });
  }
});

// ==================== DELETE /ocorrencias-calendario/:id ====================
router.delete('/:id', requireLiderOrBackoffice, async (req: AuthRequest, res: Response) => {
  try {
    const existente = await db.ocorrenciaCalendario.findUnique({ where: { id: req.params.id } });
    if (!existente || existente.instituicaoId !== req.user!.instituicaoId) {
      return res.status(404).json({ error: 'Ocorrência não encontrada' });
    }

    await db.ocorrenciaCalendario.delete({ where: { id: req.params.id } });

    return res.status(200).json({ message: 'Ocorrência removida com sucesso' });
  } catch (error) {
    console.error('Erro ao remover ocorrência do calendário:', error);
    return res.status(500).json({ error: 'Erro ao remover ocorrência do calendário' });
  }
});

export default router;
