import { Router } from 'express';
import { prisma } from '../lib/prisma/client.js';
import { verifyRecaptcha } from '../middleware/recaptcha.js';
import { calcularStatusPagamento } from '../helpers/calcular-status-pagamento.js';

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
    const { nome, data_inicio, data_fim, descricao, selecao_unica_produto, imagem_url, produtos, instituicaoId } = req.body;

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
        imagem_url: imagem_url || null,
        userId: null,
        instituicaoId: instituicaoId || null,
        produtos: produtos ? {
          create: produtos.map((produto: any) => ({
            nome: produto.nome,
            descricao: produto.descricao || null,
            valor: produto.valor,
            exigePagamento: produto.exigePagamento !== undefined ? produto.exigePagamento : false,
            oculto: produto.oculto !== undefined ? produto.oculto : false,
            instituicaoId: instituicaoId || null
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
            valor: true,
            exigePagamento: true,
            oculto: true
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
      imagem_url: evento.imagem_url,
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
            valor: true,
            exigePagamento: true,
            oculto: true
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

// PUT /eventos/:id - Editar evento
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, data_inicio, data_fim, descricao, selecao_unica_produto, imagem_url, produtos } = req.body;

    const evento = await prisma.eventos.findUnique({
      where: { id }
    });

    if (!evento) {
      return res.status(404).json({
        error: 'Evento não encontrado'
      });
    }

    const eventoAtualizado = await prisma.$transaction(async (prismaTransaction) => {
      // 1. Atualizar o evento em si
      await prismaTransaction.eventos.update({
        where: { id },
        data: {
          nome: nome !== undefined ? nome : evento.nome,
          data_inicio: data_inicio !== undefined ? new Date(data_inicio) : evento.data_inicio,
          data_fim: data_fim !== undefined ? new Date(data_fim) : evento.data_fim,
          descricao: descricao !== undefined ? (descricao || null) : evento.descricao,
          selecao_unica_produto: selecao_unica_produto !== undefined ? selecao_unica_produto : evento.selecao_unica_produto,
          imagem_url: imagem_url !== undefined ? (imagem_url || null) : evento.imagem_url,
        }
      });

      // 2. Processar produtos se o array for fornecido
      if (produtos && Array.isArray(produtos)) {
        const produtosExistentes = await prismaTransaction.produtosEvento.findMany({
          where: { eventoId: id }
        });

        const produtosInputIds = produtos.map((p: any) => p.id).filter(Boolean);

        // 2.a Validar e Excluir produtos que não estão mais no payload
        const produtosParaExcluir = produtosExistentes.filter(pe => !produtosInputIds.includes(pe.id));

        for (const p of produtosParaExcluir) {
          const participantes = await prismaTransaction.participanteProdutos.findMany({
            where: {
              produtoId: p.id,
              participante: { isDeleted: false }
            }
          });

          if (participantes.length > 0) {
            throw new Error(`Não é possível excluir o produto "${p.nome}" pois já há participantes inscritos`);
          }

          await prismaTransaction.produtosEvento.delete({ where: { id: p.id } });
        }

        // 2.b Atualizar existentes e criar novos
        for (const p of produtos) {
          if (p.id) {
            const produtoExistente = produtosExistentes.find((produtoExistente) => produtoExistente.id === p.id);
            const exigePagamentoAtualizado = p.exigePagamento !== undefined ? p.exigePagamento : false;

            await prismaTransaction.produtosEvento.update({
              where: { id: p.id },
              data: {
                nome: p.nome,
                descricao: p.descricao || null,
                valor: p.valor,
                exigePagamento: exigePagamentoAtualizado,
                oculto: p.oculto !== undefined ? p.oculto : produtoExistente?.oculto || false
              }
            });
          } else {
            await prismaTransaction.produtosEvento.create({
              data: {
                eventoId: id,
                nome: p.nome,
                descricao: p.descricao || null,
                valor: p.valor,
                exigePagamento: p.exigePagamento !== undefined ? p.exigePagamento : false,
                oculto: p.oculto !== undefined ? p.oculto : false,
                instituicaoId: evento.instituicaoId || null
              }
            });
          }
        }
      }

      // Retornar o evento atualizado com os produtos atualizados
      return await prismaTransaction.eventos.findUnique({
        where: { id },
        include: { produtos: true }
      });
    });

    if (!eventoAtualizado) {
      throw new Error('Falha ao atualizar evento');
    }

    const eventoFormatado = {
      ...eventoAtualizado,
      data_inicio: formatDateToBrasilia(eventoAtualizado.data_inicio),
      data_fim: formatDateToBrasilia(eventoAtualizado.data_fim),
      createdAt: formatDateToBrasilia(eventoAtualizado.createdAt),
      updatedAt: formatDateToBrasilia(eventoAtualizado.updatedAt),
      produtos: eventoAtualizado.produtos.map(produto => ({
        ...produto,
        valor: parseFloat(produto.valor.toString())
      }))
    };

    res.json(eventoFormatado);
  } catch (error: any) {
    console.error('Erro ao editar evento:', error);
    const isValidationError = error?.message?.includes('Não é possível excluir o produto');
    res.status(isValidationError ? 400 : 500).json({
      error: isValidationError ? error.message : 'Erro interno do servidor',
      details: error?.message,
      code: error?.code,
    });
  }
});

// POST /eventos/:eventoId/participantes - Criar participante
router.post('/:eventoId/participantes', async (req, res) => {
  try {
    const { eventoId } = req.params;
    const { nome, email, telefone, rg, cpf, termo_assinado, produtos_selecionados, recaptchaToken } = req.body;

    if (!nome || !email || !telefone || !rg || !cpf || termo_assinado === undefined) {
      return res.status(400).json({
        error: 'Campos obrigatórios: nome, email, telefone, rg, cpf, termo_assinado'
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

    let produtosValidos: any[] = [];
    if (evento.produtos && evento.produtos.length > 0) {
      if (evento.selecao_unica_produto && (!produtos_selecionados || produtos_selecionados.length === 0 || !produtos_selecionados[0].produtoId)) {
        return res.status(400).json({
          error: 'Este evento possui produtos, selecione ao menos um.'
        });
      }

      // Validar se todos os produtos selecionados existem no evento
      const produtosIds = produtos_selecionados.map((p: any) => p.produtoId).filter(Boolean);
      produtosValidos = await prisma.produtosEvento.findMany({
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
        instituicaoId: evento.instituicaoId || null,
        nome,
        email: email.toLowerCase().trim(),
        telefone,
        rg,
        cpf: cpf.replace(/\D/g, ''),
        termo_assinado,
        produtos: (!produtos_selecionados || produtos_selecionados.length === 0 || !produtos_selecionados[0].produtoId) ? undefined : {
          create: produtos_selecionados.map((produto: any) => {
            const prodValido = produtosValidos.find((p: any) => p.id === produto.produtoId);
            return {
              produtoId: produto.produtoId,
              valor_pago: produto.valor_pago || prodValido?.valor || 0,
              instituicaoId: evento.instituicaoId || null
            };
          })
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
                valor: true,
                exigePagamento: true,
                oculto: true
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
        id: pp.id,
        produtoId: pp.produtoId,
        nome: pp.produto?.nome || "Produto removido",
        valor_pago: parseFloat(pp.valor_pago.toString()),
        produto: pp.produto ? {
          ...pp.produto,
          valor: parseFloat(pp.produto.valor.toString())
        } : null
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
                valor: true,
                exigePagamento: true,
                oculto: true
              }
            },
            parcelas: {
              orderBy: { createdAt: 'asc' }
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
        produtoId: pp.produtoId,
        nome: pp.produto?.nome || "Produto removido",
        valor: pp.produto ? parseFloat(pp.produto.valor.toString()) : parseFloat(pp.valor_pago.toString()),
        status: pp.produto ? calcularStatusPagamento(pp.produto, pp.parcelas || []) : 'NAO_APLICA',
        quantidade_parcelas: pp.quantidade_parcelas,
        exigePagamento: pp.produto?.exigePagamento,
        parcelas: pp.parcelas
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
        valor: valor,
        exigePagamento: req.body.exigePagamento !== undefined ? req.body.exigePagamento : false,
        oculto: req.body.oculto !== undefined ? req.body.oculto : false,
        instituicaoId: evento.instituicaoId || null
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
        valor: produto.valor,
        exigePagamento: produto.exigePagamento !== undefined ? produto.exigePagamento : false,
        oculto: produto.oculto !== undefined ? produto.oculto : false,
        instituicaoId: evento.instituicaoId || null
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
        valor: valor !== undefined ? valor : produto.valor,
        exigePagamento: req.body.exigePagamento !== undefined ? req.body.exigePagamento : produto.exigePagamento,
        oculto: req.body.oculto !== undefined ? req.body.oculto : produto.oculto
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

    const produtos = await prisma.produtosEvento.findMany({
      where: { eventoId },
      select: {
        id: true,
        nome: true,
      }
    });

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

    const resultado = produtos.map(produto => {
      const stat = estatisticas.find(s => s.produtoId === produto.id);
      return {
        produtoId: produto.id,
        produtoNome: produto.nome,
        quantidadeParticipantes: stat ? stat._count.participanteId : 0
      };
    });

    resultado.sort((a, b) => b.quantidadeParticipantes - a.quantidadeParticipantes);

    res.json(resultado);
  } catch (error) {
    console.error('Erro ao obter estatísticas:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// GET /eventos/:eventoId/estatisticas/dayuse-retiro - Obter estatísticas divididas entre Day Use e Retiro
router.get('/:eventoId/estatisticas/dayuse-retiro', async (req, res) => {
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

    let totalDayUse = 0;
    let totalRetiro = 0;

    estatisticas.forEach(stat => {
      const produto = produtos.find(p => p.id === stat.produtoId);
      if (produto) {
        const nome = produto.nome.toLowerCase();
        const count = stat._count.participanteId;

        if (nome.includes('pacote') || (nome.includes('day use') && nome.includes('retiro'))) {
          totalDayUse += count;
          totalRetiro += count;
        } else if (nome.includes('day use') || nome.includes('dayuse')) {
          totalDayUse += count;
        } else if (nome.includes('retiro')) {
          totalRetiro += count;
        }
      }
    });

    res.json([
      { id: 'day_use', label: 'Day use', value: totalDayUse },
      { id: 'retiro', label: 'Retiro', value: totalRetiro }
    ]);
  } catch (error) {
    console.error('Erro ao obter estatísticas para gráfico de pizza:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// PUT /eventos/:eventoId/participantes/:participanteId - Editar participante
router.put('/:eventoId/participantes/:participanteId', async (req, res) => {
  try {
    const { eventoId, participanteId } = req.params;
    const { nome, email, telefone, rg, cpf, termo_assinado, isDeleted, produtoId } = req.body;

    const participante = await prisma.participantes.findFirst({
      where: {
        id: participanteId,
        eventoId: eventoId,
      },
      include: {
        produtos: true
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

    const participanteAtualizado = await prisma.$transaction(async (tx) => {
      // 1. Atualizar dados básicos
      const p = await tx.participantes.update({
        where: { id: participanteId },
        data: {
          nome: nome || participante.nome,
          email: email ? email.toLowerCase().trim() : participante.email,
          telefone: telefone || participante.telefone,
          rg: rg || participante.rg,
          cpf: cpf ? cpf.replace(/\D/g, '') : participante.cpf,
          termo_assinado: termo_assinado !== undefined ? termo_assinado : participante.termo_assinado,
          isDeleted: isDeleted !== undefined ? isDeleted : participante.isDeleted
        }
      });

      // 2. Atualizar produto se fornecido e se realmente mudou
      if (produtoId) {
        const produtoAtual = participante.produtos?.[0]?.produtoId;
        
        // Só troca o produto se realmente mudou, para preservar parcelas existentes
        if (produtoAtual !== produtoId) {
          // Buscar informações do produto para garantir que existe e obter o valor
          const produtoInfo = await tx.produtosEvento.findFirst({
            where: { id: produtoId, eventoId }
          });

          if (!produtoInfo) {
            throw new Error('Produto não encontrado para este evento');
          }

          // Remover produtos anteriores e cadastrar o novo
          await tx.participanteProdutos.deleteMany({
            where: { participanteId }
          });

          await tx.participanteProdutos.create({
            data: {
              participanteId,
              produtoId,
              valor_pago: produtoInfo.valor,
              instituicaoId: produtoInfo.instituicaoId || null
            }
          });
        }
      }

      // Retornar o participante completo e formatado
      return await tx.participantes.findUnique({
        where: { id: participanteId },
        include: {
          produtos: {
            include: {
              produto: {
                select: {
                  id: true,
                  nome: true,
                  descricao: true,
                  valor: true,
                  exigePagamento: true
                }
              },
              parcelas: {
                orderBy: { createdAt: 'asc' }
              }
            }
          }
        }
      });
    });

    if (!participanteAtualizado) {
      throw new Error('Erro ao atualizar participante');
    }

    const participanteFormatado = {
      ...participanteAtualizado,
      createdAt: formatDateToBrasilia(participanteAtualizado.createdAt),
      updatedAt: formatDateToBrasilia(participanteAtualizado.updatedAt),
      produtos: participanteAtualizado.produtos.map(pp => ({
        id: pp.id,
        produtoId: pp.produtoId,
        nome: pp.produto?.nome || "Produto removido",
        valor: pp.produto ? parseFloat(pp.produto.valor.toString()) : parseFloat(pp.valor_pago.toString()),
        status: pp.produto ? calcularStatusPagamento(pp.produto, pp.parcelas || []) : 'NAO_APLICA',
        quantidade_parcelas: pp.quantidade_parcelas,
        exigePagamento: pp.produto?.exigePagamento,
        parcelas: pp.parcelas
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

// PUT /eventos/:eventoId/participantes/:participanteId/produtos/:produtoId/quantidade-parcelas
router.put('/:eventoId/participantes/:participanteId/produtos/:produtoId/quantidade-parcelas', async (req, res) => {
  try {
    const { participanteId, produtoId } = req.params;
    const { quantidade_parcelas } = req.body;

    const pp = await prisma.participanteProdutos.findUnique({
      where: {
        participanteId_produtoId: {
          participanteId,
          produtoId
        }
      }
    });

    if (!pp) return res.status(404).json({ error: 'Inscrição de produto não encontrada' });

    await prisma.participanteProdutos.update({
      where: {
        participanteId_produtoId: {
          participanteId,
          produtoId
        }
      },
      data: {
        quantidade_parcelas
      }
    });

    res.json({ success: true });
  } catch (error: any) {
    console.error('Erro ao atualizar quantidade parcelas:', error);
    res.status(500).json({ error: 'Erro interno', details: error.message });
  }
});

// POST /eventos/:eventoId/participantes/:participanteId/produtos/:produtoId/parcelas
router.post('/:eventoId/participantes/:participanteId/produtos/:produtoId/parcelas', async (req, res) => {
  try {
    const { participanteId, produtoId } = req.params;
    const { valor_pago, metodo_pagamento, numero_vezes, descricao, data_pagamento } = req.body;

    const pp = await prisma.participanteProdutos.findUnique({
      where: { participanteId_produtoId: { participanteId, produtoId } },
      include: { parcelas: true, produto: true }
    });

    if (!pp) return res.status(404).json({ error: 'Inscrição não encontrada' });

    const novaParcela = await prisma.parcela.create({
      data: {
        participanteProdutoId: pp.id,
        valor_pago,
        metodo_pagamento,
        numero_vezes,
        descricao,
        data_pagamento: data_pagamento ? new Date(data_pagamento) : new Date(),
        instituicaoId: pp.instituicaoId || null
      }
    });

    res.status(201).json(novaParcela);
  } catch (error: any) {
    console.error('Erro ao criar parcela:', error);
    res.status(500).json({ error: 'Erro interno', details: error.message });
  }
});

// PUT /eventos/:eventoId/participantes/:participanteId/produtos/:produtoId/parcelas/:parcelaId
router.put('/:eventoId/participantes/:participanteId/produtos/:produtoId/parcelas/:parcelaId', async (req, res) => {
  try {
    const { participanteId, produtoId, parcelaId } = req.params;
    const { valor_pago, metodo_pagamento, numero_vezes, descricao, data_pagamento } = req.body;

    const parcela = await prisma.parcela.findUnique({ where: { id: parcelaId } });
    if (!parcela) return res.status(404).json({ error: 'Parcela não encontrada' });

    const parcelaEditada = await prisma.parcela.update({
      where: { id: parcelaId },
      data: {
        valor_pago: valor_pago !== undefined ? valor_pago : parcela.valor_pago,
        metodo_pagamento: metodo_pagamento !== undefined ? metodo_pagamento : parcela.metodo_pagamento,
        numero_vezes: numero_vezes !== undefined ? numero_vezes : parcela.numero_vezes,
        descricao: descricao !== undefined ? descricao : parcela.descricao,
        data_pagamento: data_pagamento ? new Date(data_pagamento) : parcela.data_pagamento
      }
    });

    res.json(parcelaEditada);
  } catch (error: any) {
    console.error('Erro ao editar parcela:', error);
    res.status(500).json({ error: 'Erro interno', details: error.message });
  }
});

// DELETE /eventos/:eventoId/participantes/:participanteId/produtos/:produtoId/parcelas/:parcelaId
router.delete('/:eventoId/participantes/:participanteId/produtos/:produtoId/parcelas/:parcelaId', async (req, res) => {
  try {
    const { participanteId, produtoId, parcelaId } = req.params;
    
    await prisma.parcela.delete({ where: { id: parcelaId } });

    res.status(204).send();
  } catch (error: any) {
    console.error('Erro ao editar parcela:', error);
    res.status(500).json({ error: 'Erro interno', details: error.message });
  }
});

export default router;
