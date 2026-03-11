import { Router } from 'express';
import { prisma } from '../lib/prisma/client.js';
import { verifyRecaptcha } from '../middleware/recaptcha.js';

const router = Router();

// Helper para formatar data assumindo que o banco armazena em horário de Brasília
function formatDateToBrasilia(date: Date): string {
  // O banco armazena as datas como UTC, mas são na verdade horários de Brasília
  // Então pegamos a data UTC e adicionamos o offset de Brasília (-03:00)
  const isoString = date.toISOString();
  return isoString.replace('Z', '-03:00');
}

// POST /eventos - Criar evento
router.post('/', async (req, res) => {
  try {
    const { nome, data_inicio, data_fim, descricao, selecao_unica_produto, produtos } = req.body;

    if (!nome || !data_inicio || !data_fim) {
      return res.status(400).json({
        error: 'Campos obrigatórios: nome, data_inicio, data_fim'
      });
    }

    const evento = await prisma.eventos.create({
      data: {
        nome,
        data_inicio: new Date(data_inicio),
        data_fim: new Date(data_fim),
        descricao: descricao || null,
        selecao_unica_produto: selecao_unica_produto !== undefined ? selecao_unica_produto : true,
        userId: null,
        produtos: produtos ? {
          create: produtos.map((produto: any) => ({
            nome: produto.nome,
            descricao: produto.descricao || null,
            valor: produto.valor
          }))
        } : undefined
      },
      include: {
        produtos: true
      }
    });

    const eventoFormatado = {
      ...evento,
      data_inicio: formatDateToBrasilia(evento.data_inicio),
      data_fim: formatDateToBrasilia(evento.data_fim),
      createdAt: formatDateToBrasilia(evento.createdAt),
      updatedAt: formatDateToBrasilia(evento.updatedAt),
      produtos: evento.produtos.map(produto => ({
        ...produto,
        valor: parseFloat(produto.valor.toString())
      }))
    };

    res.status(201).json(eventoFormatado);
  } catch (error: any) {
    console.error('Erro ao criar evento:', error);
    res.status(500).json({ 
      error: 'Erro interno do servidor',
      details: error?.message,
      code: error?.code,
    });
  }
});

// GET /eventos - Listar eventos com quantidade de participantes e produtos
router.get('/', async (req, res) => {
  try {
    const eventos = await prisma.eventos.findMany({
      orderBy: { data_inicio: 'desc' },
      include: {
        _count: {
          select: { 
            participantes: {
              where: {
                isDeleted: false
              }
            } 
          }
        },
        produtos: {
          select: {
            id: true,
            nome: true,
            descricao: true,
            valor: true
          }
        }
      }
    });

    const eventosComParticipantes = eventos.map(evento => ({
      id: evento.id,
      nome: evento.nome,
      data_inicio: formatDateToBrasilia(evento.data_inicio),
      data_fim: formatDateToBrasilia(evento.data_fim),
      descricao: evento.descricao,
      selecao_unica_produto: evento.selecao_unica_produto,
      userId: evento.userId,
      createdAt: formatDateToBrasilia(evento.createdAt),
      updatedAt: formatDateToBrasilia(evento.updatedAt),
      quantidadeParticipantes: evento._count.participantes,
      produtos: evento.produtos.map(produto => ({
        ...produto,
        valor: parseFloat(produto.valor.toString())
      }))
    }));

    res.json(eventosComParticipantes);
  } catch (error) {
    console.error('Erro ao listar eventos:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// GET /eventos/:id - Buscar evento por ID com participantes e produtos
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const evento = await prisma.eventos.findUnique({
      where: { id },
      include: {
        produtos: {
          select: {
            id: true,
            nome: true,
            descricao: true,
            valor: true
          }
        }
      }
    });

    if (!evento) {
      return res.status(404).json({
        error: 'Evento não encontrado'
      });
    }

    const eventoFormatado = {
      ...evento,
      data_inicio: formatDateToBrasilia(evento.data_inicio),
      data_fim: formatDateToBrasilia(evento.data_fim),
      createdAt: formatDateToBrasilia(evento.createdAt),
      updatedAt: formatDateToBrasilia(evento.updatedAt),
      produtos: evento.produtos.map(produto => ({
        ...produto,
        valor: parseFloat(produto.valor.toString())
      }))
    };

    res.json(eventoFormatado);
  } catch (error) {
    console.error('Erro ao buscar evento:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// POST /eventos/:eventoId/participantes - Criar participante
router.post('/:eventoId/participantes', async (req, res) => {
  try {
    const { eventoId } = req.params;
    const { nome, email, telefone, rg, cpf, termo_assinado, produtos_selecionados, recaptchaToken } = req.body;

    if (!nome || !email || !telefone || !rg || !cpf || termo_assinado === undefined || !produtos_selecionados || produtos_selecionados.length === 0) {
      return res.status(400).json({
        error: 'Campos obrigatórios: nome, email, telefone, rg, cpf, termo_assinado, produtos_selecionados'
      });
    }

    // Validar reCAPTCHA
    if (!recaptchaToken) {
      return res.status(400).json({
        error: 'Token reCAPTCHA é obrigatório'
      });
    }

    const isRecaptchaValid = await verifyRecaptcha(recaptchaToken);
    
    if (!isRecaptchaValid) {
      return res.status(400).json({
        error: 'Falha na verificação reCAPTCHA. Por favor, tente novamente.'
      });
    }

    const evento = await prisma.eventos.findUnique({
      where: { id: eventoId },
      include: { produtos: true }
    });

    if (!evento) {
      return res.status(404).json({
        error: 'Evento não encontrado'
      });
    }

    // Validar se todos os produtos selecionados existem no evento
    const produtosIds = produtos_selecionados.map((p: any) => p.produtoId);
    const produtosValidos = await prisma.produtosEvento.findMany({
      where: {
        id: { in: produtosIds },
        eventoId: eventoId
      }
    });

    if (produtosValidos.length !== produtos_selecionados.length) {
      return res.status(400).json({
        error: 'Um ou mais produtos selecionados não pertencem a este evento'
      });
    }

    // Validar seleção única de produto se necessário
    if (evento.selecao_unica_produto && produtos_selecionados.length > 1) {
      return res.status(400).json({
        error: 'Este evento permite apenas a seleção de um produto'
      });
    }

    // Verificar se já existe um participante ativo com este CPF no evento
    const participanteExistente = await prisma.participantes.findFirst({
      where: {
        eventoId,
        cpf: cpf.replace(/\D/g, ''),
        isDeleted: false
      }
    });

    if (participanteExistente) {
      return res.status(400).json({
        error: 'Já existe um participante com este CPF cadastrado neste evento'
      });
    }

    const participante = await prisma.participantes.create({
      data: {
        eventoId,
        nome,
        email: email.toLowerCase().trim(),
        telefone,
        rg,
        cpf: cpf.replace(/\D/g, ''),
        termo_assinado,
        produtos: {
          create: produtos_selecionados.map((produto: any) => ({
            produtoId: produto.produtoId,
            valor_pago: produto.valor_pago || produtosValidos.find(p => p.id === produto.produtoId)?.valor || 0
          }))
        }
      },
      include: {
        produtos: {
          include: {
            produto: {
              select: {
                id: true,
                nome: true,
                descricao: true,
                valor: true
              }
            }
          }
        }
      }
    });

    const participanteFormatado = {
      ...participante,
      createdAt: formatDateToBrasilia(participante.createdAt),
      updatedAt: formatDateToBrasilia(participante.updatedAt),
      produtos: participante.produtos.map(pp => ({
        ...pp,
        valor_pago: parseFloat(pp.valor_pago.toString()),
        produto: {
          ...pp.produto,
          valor: parseFloat(pp.produto.valor.toString())
        }
      }))
    };

    res.status(201).json(participanteFormatado);
  } catch (error: any) {
    console.error('Erro ao criar participante:', error);
    res.status(500).json({ 
      error: 'Erro interno do servidor',
      details: error?.message,
      code: error?.code,
    });
  }
});

// GET /eventos/:eventoId/participantes - Listar participantes do evento com produtos
router.get('/:eventoId/participantes', async (req, res) => {
  try {
    const { eventoId } = req.params;
    const { isDeleted } = req.query;

    const evento = await prisma.eventos.findUnique({
      where: { id: eventoId }
    });

    if (!evento) {
      return res.status(404).json({
        error: 'Evento não encontrado'
      });
    }

    const participantes = await prisma.participantes.findMany({
      where: { 
        eventoId,
        isDeleted: isDeleted === 'true'
      },
      orderBy: { createdAt: 'desc' },
      include: {
        produtos: {
          include: {
            produto: {
              select: {
                id: true,
                nome: true,
                descricao: true,
                valor: true
              }
            }
          }
        }
      }
    });

    const participantesFormatados = participantes.map(participante => ({
      ...participante,
      createdAt: formatDateToBrasilia(participante.createdAt),
      updatedAt: formatDateToBrasilia(participante.updatedAt),
      produtos: participante.produtos.map(pp => ({
        id: pp.id,
        nome: pp.produto.nome,
        valor: parseFloat(pp.produto.valor.toString()),
      }))
    }));

    res.json(participantesFormatados);
  } catch (error) {
    console.error('Erro ao listar participantes:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// POST /eventos/:eventoId/produtos - Criar produto para um evento
router.post('/:eventoId/produtos', async (req, res) => {
  try {
    const { eventoId } = req.params;
    const { nome, descricao, valor } = req.body;

    if (!nome || valor === undefined) {
      return res.status(400).json({
        error: 'Campos obrigatórios: nome, valor'
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

    const produto = await prisma.produtosEvento.create({
      data: {
        eventoId,
        nome,
        descricao: descricao || null,
        valor: valor
      }
    });

    const produtoFormatado = {
      ...produto,
      valor: parseFloat(produto.valor.toString()),
      createdAt: formatDateToBrasilia(produto.createdAt),
      updatedAt: formatDateToBrasilia(produto.updatedAt)
    };

    res.status(201).json(produtoFormatado);
  } catch (error: any) {
    console.error('Erro ao criar produto:', error);
    res.status(500).json({ 
      error: 'Erro interno do servidor',
      details: error?.message,
      code: error?.code,
    });
  }
});

// POST /eventos/:eventoId/produtos/batch - Criar múltiplos produtos para um evento
router.post('/:eventoId/produtos/batch', async (req, res) => {
  try {
    const { eventoId } = req.params;
    const { produtos } = req.body;

    if (!produtos || !Array.isArray(produtos) || produtos.length === 0) {
      return res.status(400).json({
        error: 'Campo obrigatório: produtos (array não vazio)'
      });
    }

    // Validar se todos os produtos têm os campos obrigatórios
    for (const produto of produtos) {
      if (!produto.nome || produto.valor === undefined) {
        return res.status(400).json({
          error: 'Todos os produtos devem ter: nome, valor'
        });
      }
    }

    const evento = await prisma.eventos.findUnique({
      where: { id: eventoId }
    });

    if (!evento) {
      return res.status(404).json({
        error: 'Evento não encontrado'
      });
    }

    const produtosCriados = await prisma.produtosEvento.createMany({
      data: produtos.map(produto => ({
        eventoId,
        nome: produto.nome,
        descricao: produto.descricao || null,
        valor: produto.valor
      }))
    });

    // Buscar os produtos criados para retornar dados completos
    const produtosCompleto = await prisma.produtosEvento.findMany({
      where: {
        eventoId,
        nome: {
          in: produtos.map(p => p.nome)
        }
      },
      orderBy: { createdAt: 'desc' },
      take: produtos.length
    });

    const produtosFormatados = produtosCompleto.map(produto => ({
      ...produto,
      valor: parseFloat(produto.valor.toString()),
      createdAt: formatDateToBrasilia(produto.createdAt),
      updatedAt: formatDateToBrasilia(produto.updatedAt)
    }));

    res.status(201).json({
      message: `${produtosCriados.count} produtos criados com sucesso`,
      produtos: produtosFormatados
    });
  } catch (error: any) {
    console.error('Erro ao criar produtos em lote:', error);
    res.status(500).json({ 
      error: 'Erro interno do servidor',
      details: error?.message,
      code: error?.code,
    });
  }
});

// GET /eventos/:eventoId/produtos - Listar produtos de um evento
router.get('/:eventoId/produtos', async (req, res) => {
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

    const produtos = await prisma.produtosEvento.findMany({
      where: { eventoId },
      orderBy: { createdAt: 'desc' }
    });

    const produtosFormatados = produtos.map(produto => ({
      ...produto,
      valor: parseFloat(produto.valor.toString()),
      createdAt: formatDateToBrasilia(produto.createdAt),
      updatedAt: formatDateToBrasilia(produto.updatedAt)
    }));

    res.json(produtosFormatados);
  } catch (error) {
    console.error('Erro ao listar produtos:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// PUT /eventos/:eventoId/produtos/:produtoId - Atualizar produto
router.put('/:eventoId/produtos/:produtoId', async (req, res) => {
  try {
    const { eventoId, produtoId } = req.params;
    const { nome, descricao, valor } = req.body;

    const produto = await prisma.produtosEvento.findFirst({
      where: { 
        id: produtoId,
        eventoId: eventoId
      }
    });

    if (!produto) {
      return res.status(404).json({
        error: 'Produto não encontrado neste evento'
      });
    }

    const produtoAtualizado = await prisma.produtosEvento.update({
      where: { id: produtoId },
      data: {
        nome: nome !== undefined ? nome : produto.nome,
        descricao: descricao !== undefined ? descricao : produto.descricao,
        valor: valor !== undefined ? valor : produto.valor
      }
    });

    const produtoFormatado = {
      ...produtoAtualizado,
      valor: parseFloat(produtoAtualizado.valor.toString()),
      createdAt: formatDateToBrasilia(produtoAtualizado.createdAt),
      updatedAt: formatDateToBrasilia(produtoAtualizado.updatedAt)
    };

    res.json(produtoFormatado);
  } catch (error: any) {
    console.error('Erro ao atualizar produto:', error);
    res.status(500).json({ 
      error: 'Erro interno do servidor',
      details: error?.message,
      code: error?.code,
    });
  }
});

// DELETE /eventos/:eventoId/produtos/:produtoId - Excluir produto
router.delete('/:eventoId/produtos/:produtoId', async (req, res) => {
  try {
    const { eventoId, produtoId } = req.params;

    const produto = await prisma.produtosEvento.findFirst({
      where: { 
        id: produtoId,
        eventoId: eventoId
      }
    });

    if (!produto) {
      return res.status(404).json({
        error: 'Produto não encontrado neste evento'
      });
    }

    // Verificar se há participantes ativos usando este produto
    const participantesComProduto = await prisma.participanteProdutos.findMany({
      where: { 
        produtoId,
        participante: {
          isDeleted: false
        }
       }
    });

    if (participantesComProduto.length > 0) {
      return res.status(400).json({
        error: 'Não é possível excluir este produto pois já há participantes inscritos'
      });
    }

    await prisma.produtosEvento.delete({
      where: { id: produtoId }
    });

    res.status(204).send();
  } catch (error: any) {
    console.error('Erro ao excluir produto:', error);
    res.status(500).json({ 
      error: 'Erro interno do servidor',
      details: error?.message,
      code: error?.code,
    });
  }
});

// GET /eventos/:eventoId/estatisticas/participantes-por-produto - Obter estatísticas de participantes por produto
router.get('/:eventoId/estatisticas/participantes-por-produto', async (req, res) => {
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

    const estatisticas = await prisma.participanteProdutos.groupBy({
      by: ['produtoId'],
      where: {
        produto: {
          eventoId: eventoId
        },
        participante: {
          isDeleted: false
        }
      },
      _count: {
        participanteId: true
      }
    });

    const produtosIds = estatisticas.map(e => e.produtoId);
    const produtos = await prisma.produtosEvento.findMany({
      where: {
        id: { in: produtosIds }
      },
      select: {
        id: true,
        nome: true
      }
    });

    const resultado = estatisticas.map(stat => {
      const produto = produtos.find(p => p.id === stat.produtoId);
      return {
        produtoId: stat.produtoId,
        produtoNome: produto?.nome || 'Produto não encontrado',
        quantidadeParticipantes: stat._count.participanteId
      };
    });

    resultado.sort((a, b) => b.quantidadeParticipantes - a.quantidadeParticipantes);

    res.json(resultado);
  } catch (error) {
    console.error('Erro ao obter estatísticas:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// PUT /eventos/:eventoId/participantes/:participanteId - Editar participante
router.put('/:eventoId/participantes/:participanteId', async (req, res) => {
  try {
    const { eventoId, participanteId } = req.params;
    const { nome, email, telefone, rg, cpf, termo_assinado, isDeleted } = req.body;

    const participante = await prisma.participantes.findFirst({
      where: { 
        id: participanteId,
        eventoId: eventoId,
      }
    });

    if (!participante) {
      return res.status(404).json({
        error: 'Participante não encontrado neste evento'
      });
    }

    // Se estiver atualizando o CPF, verificar se já existe outro participante com o mesmo CPF
    if (cpf && cpf.replace(/\D/g, '') !== participante.cpf) {
      const cpfExistente = await prisma.participantes.findFirst({
        where: {
          eventoId,
          cpf: cpf.replace(/\D/g, ''),
          isDeleted: false
        }
      });
      if (cpfExistente) {
        return res.status(400).json({
          error: 'Já existe um participante ativo com este CPF neste evento'
        });
      }
    }

    const participanteAtualizado = await prisma.participantes.update({
      where: { id: participanteId },
      data: {
        nome: nome || participante.nome,
        email: email ? email.toLowerCase().trim() : participante.email,
        telefone: telefone || participante.telefone,
        rg: rg || participante.rg,
        cpf: cpf ? cpf.replace(/\D/g, '') : participante.cpf,
        termo_assinado: termo_assinado !== undefined ? termo_assinado : participante.termo_assinado,
        isDeleted: isDeleted !== undefined ? isDeleted : participante.isDeleted
      },
      include: {
        produtos: {
          include: {
            produto: {
              select: {
                id: true,
                nome: true,
                descricao: true,
                valor: true
              }
            }
          }
        }
      }
    });

    const participanteFormatado = {
      ...participanteAtualizado,
      createdAt: formatDateToBrasilia(participanteAtualizado.createdAt),
      updatedAt: formatDateToBrasilia(participanteAtualizado.updatedAt),
      produtos: participanteAtualizado.produtos.map(pp => ({
        id: pp.id,
        nome: pp.produto.nome,
        valor: parseFloat(pp.produto.valor.toString()),
      }))
    };

    res.json(participanteFormatado);
  } catch (error: any) {
    console.error('Erro ao atualizar participante:', error);
    res.status(500).json({ 
      error: 'Erro interno do servidor',
      details: error?.message,
      code: error?.code,
    });
  }
});

// DELETE /eventos/:eventoId/participantes/:participanteId - Exclusão lógica do participante
router.delete('/:eventoId/participantes/:participanteId', async (req, res) => {
  try {
    const { eventoId, participanteId } = req.params;

    const participante = await prisma.participantes.findFirst({
      where: { 
        id: participanteId,
        eventoId: eventoId,
        isDeleted: false
      }
    });

    if (!participante) {
      return res.status(404).json({
        error: 'Participante não encontrado neste evento'
      });
    }

    // Exclusão lógica: apenas atualizar a flag isDeleted
    await prisma.participantes.update({
      where: { id: participanteId },
      data: { isDeleted: true }
    });

    res.status(204).send();
  } catch (error: any) {
    console.error('Erro ao excluir participante (lógico):', error);
    res.status(500).json({ 
      error: 'Erro interno do servidor',
      details: error?.message,
      code: error?.code,
    });
  }
});

export default router;
