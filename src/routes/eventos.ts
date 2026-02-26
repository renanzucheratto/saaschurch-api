import { Router } from 'express';
import { prisma } from '../lib/prisma/client.js';

const router = Router();

// POST /eventos - Criar evento
router.post('/', async (req, res) => {
  try {
    const { nome, data, descricao } = req.body;

    if (!nome || !data) {
      return res.status(400).json({
        error: 'Campos obrigatórios: nome, data'
      });
    }

    const evento = await prisma.eventos.create({
      data: {
        nome,
        data: new Date(data),
        descricao: descricao || null,
        userId: null
      }
    });

    res.status(201).json(evento);
  } catch (error: any) {
    console.error('Erro ao criar evento:', error);
    res.status(500).json({ 
      error: 'Erro interno do servidor',
      details: error?.message,
      code: error?.code,
    });
  }
});

// GET /eventos - Listar eventos com quantidade de participantes
router.get('/', async (req, res) => {
  try {
    const eventos = await prisma.eventos.findMany({
      orderBy: { data: 'desc' },
      include: {
        _count: {
          select: { participantes: true }
        }
      }
    });

    const eventosComParticipantes = eventos.map(evento => ({
      id: evento.id,
      nome: evento.nome,
      data: evento.data,
      descricao: evento.descricao,
      userId: evento.userId,
      createdAt: evento.createdAt,
      updatedAt: evento.updatedAt,
      quantidadeParticipantes: evento._count.participantes
    }));

    res.json(eventosComParticipantes);
  } catch (error) {
    console.error('Erro ao listar eventos:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// POST /eventos/:eventoId/participantes - Criar participante
router.post('/:eventoId/participantes', async (req, res) => {
  try {
    const { eventoId } = req.params;
    const { nome, email, telefone, termo_assinado } = req.body;

    if (!nome || !email || !telefone || termo_assinado === undefined) {
      return res.status(400).json({
        error: 'Campos obrigatórios: nome, email, telefone, termo_assinado'
      });
    }

    const evento = await prisma.eventos.findUnique({
      where: { id: eventoId }
    });

    if (!evento) {
      return res.status(404).json({
        error: 'Evento não encontrado'
      });
    }

    const participante = await prisma.participantes.create({
      data: {
        eventoId,
        nome,
        email,
        telefone,
        termo_assinado
      }
    });

    res.status(201).json(participante);
  } catch (error: any) {
    console.error('Erro ao criar participante:', error);
    res.status(500).json({ 
      error: 'Erro interno do servidor',
      details: error?.message,
      code: error?.code,
    });
  }
});

// GET /eventos/:eventoId/participantes - Listar participantes do evento
router.get('/:eventoId/participantes', async (req, res) => {
  try {
    const { eventoId } = req.params;

    const evento = await prisma.eventos.findUnique({
      where: { id: eventoId }
    });

    if (!evento) {
      return res.status(404).json({
        error: 'Evento não encontrado'
      });
    }

    const participantes = await prisma.participantes.findMany({
      where: { eventoId },
      orderBy: { createdAt: 'desc' }
    });

    res.json(participantes);
  } catch (error) {
    console.error('Erro ao listar participantes:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

export default router;
