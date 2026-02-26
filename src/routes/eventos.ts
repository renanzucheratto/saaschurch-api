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
        error: 'Usuário já cadastrado'
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
  } catch (error: any) {
    console.error('Erro ao criar evento:', error);
    console.error('Error code:', error?.code);
    console.error('Error message:', error?.message);
    
    // Tratar erro de constraint unique
    if (error?.code === 'P2002') {
      return res.status(409).json({
        error: 'Usuário já cadastrado'
      });
    }
    
    res.status(500).json({ 
      error: 'Erro interno do servidor',
      details: process.env['NODE_ENV'] === 'development' ? error?.message : undefined
    });
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

// DELETE /eventos/limpar-duplicados - Remover emails duplicados (temporário)
router.delete('/limpar-duplicados', async (req, res) => {
  try {
    // Encontrar emails duplicados
    const duplicados = await prisma.$queryRaw<Array<{ email: string; count: number }>>`
      SELECT email, COUNT(*) as count
      FROM eventos_provisorio
      GROUP BY email
      HAVING COUNT(*) > 1
    `;
    
    let totalRemovidos = 0;
    
    // Para cada email duplicado, manter apenas o mais antigo
    for (const dup of duplicados) {
      const registros = await prisma.eventosProvisorio.findMany({
        where: { email: dup.email },
        orderBy: { created_at: 'asc' }
      });
      
      // Remover todos exceto o primeiro (mais antigo)
      const paraRemover = registros.slice(1);
      for (const registro of paraRemover) {
        await prisma.eventosProvisorio.delete({
          where: { id: registro.id }
        });
        totalRemovidos++;
      }
    }
    
    res.json({ 
      message: `Removidos ${totalRemovidos} registros duplicados`,
      duplicadosEncontrados: duplicados.length,
      instructions: "Agora emails duplicados não podem mais ser criados devido à constraint unique no banco."
    });
  } catch (error) {
    console.error('Erro ao limpar duplicados:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// GET /eventos/limpar-duplicados - Remover emails duplicados (versão GET para facilitar acesso)
router.get('/limpar-duplicados', async (req, res) => {
  try {
    // Encontrar emails duplicados
    const duplicados = await prisma.$queryRaw<Array<{ email: string; count: number }>>`
      SELECT email, COUNT(*) as count
      FROM eventos_provisorio
      GROUP BY email
      HAVING COUNT(*) > 1
    `;
    
    let totalRemovidos = 0;
    
    // Para cada email duplicado, manter apenas o mais antigo
    for (const dup of duplicados) {
      const registros = await prisma.eventosProvisorio.findMany({
        where: { email: dup.email },
        orderBy: { created_at: 'asc' }
      });
      
      // Remover todos exceto o primeiro (mais antigo)
      const paraRemover = registros.slice(1);
      for (const registro of paraRemover) {
        await prisma.eventosProvisorio.delete({
          where: { id: registro.id }
        });
        totalRemovidos++;
      }
    }
    
    res.json({ 
      success: true,
      message: `Removidos ${totalRemovidos} registros duplicados`,
      duplicadosEncontrados: duplicados.length,
      instructions: "Agora emails duplicados não podem mais ser criados devido à constraint unique no banco."
    });
  } catch (error) {
    console.error('Erro ao limpar duplicados:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

export default router;
