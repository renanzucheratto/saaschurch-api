import { Router } from 'express';
import { prisma } from '../lib/prisma/client.js';

const router = Router();

// POST /eventos - Adicionar evento
router.post('/', async (req, res) => {
  try {
    const { nome, email, telefone, aceite_termo } = req.body;

    console.log('[POST /eventos] Iniciando criação de evento para email:', email);

    // Validação básica
    if (!nome || !email || !telefone || aceite_termo === undefined) {
      console.log('[POST /eventos] Validação falhou - campos obrigatórios ausentes');
      return res.status(400).json({
        error: 'Campos obrigatórios: nome, email, telefone, aceite_termo'
      });
    }

    console.log('[POST /eventos] Verificando se email já existe:', email);
    const exists = await prisma.eventosProvisorio.findUnique({
      where: { email }
    });

    console.log('[POST /eventos] Resultado da verificação:', exists ? 'Email já existe' : 'Email disponível');

    if (exists) {
      console.log('[POST /eventos] Email duplicado detectado:', email);
      return res.status(409).json({
        error: 'Usuário já cadastrado'
      });
    }

    console.log('[POST /eventos] Criando novo evento para:', email);
    const evento = await prisma.eventosProvisorio.create({
      data: {
        nome,
        email,
        telefone,
        aceite_termo
      }
    });

    console.log('[POST /eventos] Evento criado com sucesso:', evento.id);
    res.status(201).json(evento);
  } catch (error: any) {
    console.error('[POST /eventos] Erro ao criar evento:', error);
    console.error('[POST /eventos] Stack trace:', error?.stack);
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
