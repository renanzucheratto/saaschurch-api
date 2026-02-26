import { Router } from 'express';
import { prisma } from '../lib/prisma/client.js';

const router = Router();

// POST /eventos - Adicionar evento
router.post('/', async (req, res) => {
  try {
    const { nome, email, telefone, aceite_termo } = req.body;

    // Validação básica
    if (!nome || !email || !telefone || aceite_termo === undefined) {
      return res.status(400).json({
        error: 'Campos obrigatórios: nome, email, telefone, aceite_termo'
      });
    }

    // Verificar se email já existe
    const eventoExistente = await prisma.eventosProvisorio.findFirst({
      where: { email }
    });

    if (eventoExistente) {
      return res.status(409).json({
        error: 'Email já cadastrado. Este usuário já foi registrado.'
      });
    }

    const evento = await prisma.eventosProvisorio.create({
      data: {
        nome,
        email,
        telefone,
        aceite_termo
      }
    });

    res.status(201).json(evento);
  } catch (error) {
    console.error('Erro ao criar evento:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// GET /eventos - Listar todos os eventos
router.get('/', async (req, res) => {
  try {
    const eventos = await prisma.eventosProvisorio.findMany({
      orderBy: { created_at: 'desc' }
    });
    res.json(eventos);
  } catch (error) {
    console.error('Erro ao listar eventos:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

export default router;
