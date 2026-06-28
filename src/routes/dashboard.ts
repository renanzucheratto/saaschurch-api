import { Router, Response } from 'express';
import { prisma } from '../lib/prisma/client.js';
import { authenticateUser, AuthRequest } from '../middleware/auth.middleware.js';
import { calcularStatusEvento } from '../helpers/calcular-status-evento.js';

const router = Router();
const db = prisma as any;

const MESES_PT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

function mesLabel(date: Date): string {
  return `${MESES_PT[date.getMonth()]}/${String(date.getFullYear()).slice(2)}`;
}

function buildUltimos12Meses(): { mes: string; ano: number; mesIdx: number }[] {
  const result = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    result.push({ mes: mesLabel(d), ano: d.getFullYear(), mesIdx: d.getMonth() });
  }
  return result;
}

router.get('/stats', authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const instituicaoId = req.user!.instituicaoId;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const startOf12MonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);

    const [
      totalMembrosAtivos,
      eventosMes,
      participantesMes,
      todosMembros,
      todosEventos,
      topEventos,
      areas,
      projetos,
      proximosEventos,
      ultimosMembros,
    ] = await Promise.all([
      db.users.count({
        where: { instituicaoId, active: true },
      }),

      db.eventos.count({
        where: {
          OR: [
            { instituicaoId, data_inicio: { gte: startOfMonth, lt: endOfMonth }, status: { nome: 'aberto' } },
            { instituicaoId: null, user: { instituicaoId }, data_inicio: { gte: startOfMonth, lt: endOfMonth }, status: { nome: 'aberto' } },
          ],
        },
      }),

      db.participantes.count({
        where: {
          evento: { instituicaoId },
          createdAt: { gte: startOfMonth },
          isDeleted: false,
        },
      }),

      db.users.findMany({
        where: {
          instituicaoId,
          createdAt: { gte: startOf12MonthsAgo },
        },
        select: { createdAt: true },
      }),

      db.eventos.findMany({
        where: {
          OR: [
            { instituicaoId, createdAt: { gte: startOf12MonthsAgo } },
            { instituicaoId: null, user: { instituicaoId }, createdAt: { gte: startOf12MonthsAgo } },
          ],
        },
        select: { createdAt: true },
      }),

      db.eventos.findMany({
        where: {
          OR: [
            { instituicaoId },
            { instituicaoId: null, user: { instituicaoId } },
          ],
        },
        select: {
          nome: true,
          data_fim: true,
          data_maxima_inscricao: true,
          limite_inscricoes: true,
          status: { select: { id: true, nome: true, justificativa: true } },
          _count: { select: { participantes: { where: { isDeleted: false } } } },
        },
        orderBy: { data_inicio: 'desc' },
      }),

      db.area.findMany({
        where: { instituicaoId },
        select: {
          nome: true,
          _count: { select: { users: true } },
        },
      }),

      db.projeto.findMany({
        where: { instituicaoId },
        select: { status: { select: { nome: true } } },
      }),

      db.eventos.findMany({
        where: {
          OR: [
            { instituicaoId, data_inicio: { gte: now } },
            { instituicaoId: null, user: { instituicaoId }, data_inicio: { gte: now } },
          ],
        },
        select: {
          id: true,
          nome: true,
          data_inicio: true,
          _count: { select: { participantes: { where: { isDeleted: false } } } },
        },
        orderBy: { data_inicio: 'asc' },
        take: 4,
      }),

      db.users.findMany({
        where: { instituicaoId },
        select: { id: true, nome: true, email: true, createdAt: true, userType: true },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
    ]);

    const meses = buildUltimos12Meses();

    const crescimentoMembros = meses.map(({ mes, ano, mesIdx }) => ({
      mes,
      total: todosMembros.filter((u) => {
        const d = u.createdAt;
        return d.getFullYear() === ano && d.getMonth() === mesIdx;
      }).length,
    }));

    const eventosPorMes = meses.map(({ mes, ano, mesIdx }) => ({
      mes,
      total: todosEventos.filter((e) => {
        const d = e.createdAt;
        return d.getFullYear() === ano && d.getMonth() === mesIdx;
      }).length,
    }));

    const participacaoPorEvento = topEventos.map((e) => ({
      eventoNome: e.nome,
      total: e._count.participantes,
      status: calcularStatusEvento({
        status: e.status,
        data_fim: e.data_fim,
        data_maxima_inscricao: e.data_maxima_inscricao,
        limite_inscricoes: e.limite_inscricoes,
        quantidadeParticipantes: e._count.participantes,
      }),
    }));

    const membrosPorArea = areas
      .map((a) => ({ areaNome: a.nome, total: a._count.users }))
      .filter((a) => a.total > 0);

    const statusMap: Record<string, number> = {};
    for (const p of projetos) {
      const key = p.status?.nome ?? 'Sem status';
      statusMap[key] = (statusMap[key] ?? 0) + 1;
    }
    const projetosPorStatus = Object.entries(statusMap).map(([status, total]) => ({ status, total }));

    return res.json({
      cards: {
        totalMembrosAtivos,
        eventosMes,
        eventosMesDescricao: 'Eventos com status: Aberto',
        participantesMes,
      },
      crescimentoMembros,
      eventosPorMes,
      participacaoPorEvento,
      membrosPorArea,
      projetosPorStatus,
      proximosEventos,
      ultimosMembros,
    });
  } catch (error) {
    console.error('Erro ao obter stats do dashboard:', error);
    return res.status(500).json({ error: 'Erro ao obter dados do dashboard' });
  }
});

export default router;
