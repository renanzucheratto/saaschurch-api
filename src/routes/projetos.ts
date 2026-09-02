import { Router, Response } from 'express';
import multer from 'multer';
import { prisma } from '../lib/prisma/client.js';
import {
  authenticateUser,
  AuthRequest,
  UserType,
} from '../middleware/auth.middleware.js';
import { uploadAnexo, removerAnexo } from '../lib/supabase/storage.js';

const router = Router();
const db = prisma as any;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// Todas as rotas exigem autenticação
router.use(authenticateUser);

// ==================== Helpers ====================

const STATUS_VALIDOS = [
  'em_analise',
  'aprovado',
  'recusado',
  'em_reembolso',
  'liquidado',
  'finalizado',
] as const;

// Para cada status alvo: status atual exigido + tipos diretos + áreas com permissão
const TRANSICOES: Record<
  string,
  { de: string[]; papeis: UserType[]; areasPermitidas: string[]; donoPermitido: boolean }
> = {
  aprovado: { de: ['em_analise'], papeis: ['backoffice'], areasPermitidas: [], donoPermitido: false },
  recusado: { de: ['em_analise'], papeis: ['backoffice'], areasPermitidas: [], donoPermitido: false },
  em_reembolso: { de: ['aprovado'], papeis: ['backoffice'], areasPermitidas: [], donoPermitido: true },
  liquidado: { de: ['em_reembolso'], papeis: ['backoffice'], areasPermitidas: [], donoPermitido: false },
  finalizado: { de: ['liquidado'], papeis: ['backoffice'], areasPermitidas: [], donoPermitido: true },
};

async function temPermissaoTransicao(
  userId: string,
  userType: UserType,
  instituicaoId: string,
  transicao: (typeof TRANSICOES)[string],
): Promise<boolean> {
  if (transicao.papeis.includes(userType)) return true;
  if (transicao.areasPermitidas.length > 0 && userType === 'lider') {
    const userArea = await db.userArea.findFirst({
      where: {
        userId,
        roleNaArea: 'lider',
        area: { nome: { in: transicao.areasPermitidas }, instituicaoId },
      },
    });
    if (userArea) return true;
  }
  return false;
}

function formatDateToBrasilia(date: Date | null | undefined): string | null {
  if (!date) return null;
  return new Date(date).toISOString().replace('Z', '-03:00');
}

function calcularValorTotal(itens: any[]): number {
  if (!Array.isArray(itens)) return 0;
  return itens.reduce(
    (acc, item) => acc + Number(item.quantidade ?? 0) * parseFloat((item.valor_unit ?? 0).toString()),
    0,
  );
}

function serializarProjeto(projeto: any) {
  const itens = Array.isArray(projeto?.itens)
    ? projeto.itens.map((item: any) => ({
        ...item,
        valor_unit: parseFloat((item.valor_unit ?? 0).toString()),
      }))
    : [];

  return {
    ...projeto,
    data_inicio: formatDateToBrasilia(projeto?.data_inicio),
    data_fim: formatDateToBrasilia(projeto?.data_fim),
    createdAt: formatDateToBrasilia(projeto?.createdAt),
    updatedAt: formatDateToBrasilia(projeto?.updatedAt),
    lider: projeto?.lider
      ? { id: projeto.lider.id, nome: projeto.lider.nome, email: projeto.lider.email }
      : null,
    status: projeto?.status ?? null,
    areas: Array.isArray(projeto?.areas) ? projeto.areas.map((pa: any) => pa.area) : [],
    itens,
    anexos: Array.isArray(projeto?.anexos)
      ? projeto.anexos.map((a: any) => ({ ...a, createdAt: formatDateToBrasilia(a.createdAt) }))
      : [],
    valor_total: calcularValorTotal(itens),
  };
}

function podeCriar(userType: UserType): boolean {
  return ['lider', 'backoffice'].includes(userType);
}

const INCLUDE_AREAS = {
  include: { area: { select: { id: true, nome: true, cor: true } } },
} as const;

// Áreas em que o usuário é líder — sempre entram no projeto e não podem ser removidas.
async function areasQueLidera(userId: string, instituicaoId: string): Promise<string[]> {
  const vinculos = await db.userArea.findMany({
    where: { userId, roleNaArea: 'lider', area: { instituicaoId } },
    select: { areaId: true },
  });
  return vinculos.map((v: any) => v.areaId);
}

/**
 * Monta a lista final de áreas do projeto. O backoffice escolhe livremente; o líder
 * escolhe outras áreas, mas as que ele lidera são sempre incluídas.
 */
async function resolverAreasDoProjeto(
  userId: string,
  userType: UserType,
  instituicaoId: string,
  areaIds: unknown,
): Promise<{ ids?: string[]; erro?: string }> {
  const informadas = Array.isArray(areaIds) ? areaIds.filter((id) => typeof id === 'string') : [];

  const obrigatorias =
    userType === 'backoffice' ? [] : await areasQueLidera(userId, instituicaoId);

  const ids = Array.from(new Set([...obrigatorias, ...informadas]));

  if (ids.length === 0) {
    return { erro: 'Selecione ao menos uma área para o projeto.' };
  }

  const validas = await db.area.count({ where: { id: { in: ids }, instituicaoId } });
  if (validas !== ids.length) {
    return { erro: 'Uma ou mais áreas selecionadas não pertencem à instituição.' };
  }

  return { ids };
}

// ==================== GET /projetos ====================
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const projetos = await db.projeto.findMany({
      where: { instituicaoId: req.user!.instituicaoId },
      include: {
        status: true,
        lider: { select: { id: true, nome: true, email: true } },
        areas: INCLUDE_AREAS,
        itens: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.status(200).json(projetos.map(serializarProjeto));
  } catch (error) {
    console.error('Erro ao listar projetos:', error);
    return res.status(500).json({ error: 'Erro ao listar projetos' });
  }
});

// ==================== POST /projetos ====================
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    if (!podeCriar(req.user!.userType)) {
      return res.status(403).json({ error: 'Apenas líderes podem criar projetos.' });
    }

    const { nome, descricao, ideias, data_inicio, data_fim, eventoId, itens, areaIds } = req.body;

    if (!nome) {
      return res.status(400).json({ error: 'O nome do projeto é obrigatório.' });
    }

    if (!Array.isArray(itens) || itens.length === 0) {
      return res.status(400).json({ error: 'O projeto deve conter ao menos um item.' });
    }

    const areas = await resolverAreasDoProjeto(
      req.user!.id,
      req.user!.userType,
      req.user!.instituicaoId,
      areaIds,
    );
    if (areas.erro) {
      return res.status(400).json({ error: areas.erro });
    }

    const projeto = await db.projeto.create({
      data: {
        nome,
        descricao: descricao || null,
        ideias: ideias || null,
        data_inicio: data_inicio ? new Date(data_inicio) : null,
        data_fim: data_fim ? new Date(data_fim) : null,
        eventoId: eventoId || null,
        instituicao: { connect: { id: req.user!.instituicaoId } },
        lider: { connect: { id: req.user!.id } },
        updatedByEmail: req.user!.email,
        status: {
          create: { nome: 'em_analise', justificativa: null },
        },
        itens: {
          create: itens.map((item: any) => ({
            nome: item.nome,
            descricao: item.descricao || null,
            quantidade: Number(item.quantidade) || 1,
            valor_unit: item.valor_unit ?? 0,
          })),
        },
        areas: {
          create: areas.ids!.map((areaId) => ({ areaId })),
        },
      },
      include: {
        status: true,
        lider: { select: { id: true, nome: true, email: true } },
        areas: INCLUDE_AREAS,
        itens: true,
        anexos: true,
      },
    });

    return res.status(201).json(serializarProjeto(projeto));
  } catch (error) {
    console.error('Erro ao criar projeto:', error);
    return res.status(500).json({ error: 'Erro ao criar projeto' });
  }
});

// ==================== GET /projetos/:id ====================
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const projeto = await db.projeto.findUnique({
      where: { id: req.params.id },
      include: {
        status: true,
        lider: { select: { id: true, nome: true, email: true } },
        areas: INCLUDE_AREAS,
        itens: { orderBy: { createdAt: 'asc' } },
        anexos: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!projeto || projeto.instituicaoId !== req.user!.instituicaoId) {
      return res.status(404).json({ error: 'Projeto não encontrado' });
    }

    return res.status(200).json(serializarProjeto(projeto));
  } catch (error) {
    console.error('Erro ao buscar projeto:', error);
    return res.status(500).json({ error: 'Erro ao buscar projeto' });
  }
});

// ==================== PUT /projetos/:id ====================
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const projeto = await db.projeto.findUnique({
      where: { id: req.params.id },
      include: { status: true },
    });

    if (!projeto || projeto.instituicaoId !== req.user!.instituicaoId) {
      return res.status(404).json({ error: 'Projeto não encontrado' });
    }

    const ehDono = projeto.liderUserId === req.user!.id;
    const ehBackoffice = req.user!.userType === 'backoffice';
    if (!ehDono && !ehBackoffice) {
      return res.status(403).json({ error: 'Você não tem permissão para editar este projeto.' });
    }

    if (projeto.status?.nome !== 'em_analise') {
      return res.status(400).json({
        error: 'O projeto só pode ser editado enquanto estiver "Em análise".',
      });
    }

    const { nome, descricao, ideias, data_inicio, data_fim, eventoId, itens, areaIds } = req.body;

    if (Array.isArray(itens) && itens.length === 0) {
      return res.status(400).json({ error: 'O projeto deve conter ao menos um item.' });
    }

    let areasDoProjeto: string[] | undefined;
    if (areaIds !== undefined) {
      const areas = await resolverAreasDoProjeto(
        req.user!.id,
        req.user!.userType,
        req.user!.instituicaoId,
        areaIds,
      );
      if (areas.erro) {
        return res.status(400).json({ error: areas.erro });
      }
      areasDoProjeto = areas.ids;
    }

    const updated = await db.projeto.update({
      where: { id: req.params.id },
      data: {
        ...(nome !== undefined && { nome }),
        ...(descricao !== undefined && { descricao: descricao || null }),
        ...(ideias !== undefined && { ideias: ideias || null }),
        ...(data_inicio !== undefined && { data_inicio: data_inicio ? new Date(data_inicio) : null }),
        ...(data_fim !== undefined && { data_fim: data_fim ? new Date(data_fim) : null }),
        ...(eventoId !== undefined && { eventoId: eventoId || null }),
        updatedByEmail: req.user!.email,
        // Recria os vínculos de área quando enviados
        ...(areasDoProjeto && {
          areas: {
            deleteMany: {},
            create: areasDoProjeto.map((areaId) => ({ areaId })),
          },
        }),
        // Recria os itens quando enviados
        ...(Array.isArray(itens) && {
          itens: {
            deleteMany: {},
            create: itens.map((item: any) => ({
              nome: item.nome,
              descricao: item.descricao || null,
              quantidade: Number(item.quantidade) || 1,
              valor_unit: item.valor_unit ?? 0,
            })),
          },
        }),
      },
      include: {
        status: true,
        lider: { select: { id: true, nome: true, email: true } },
        areas: INCLUDE_AREAS,
        itens: { orderBy: { createdAt: 'asc' } },
        anexos: { orderBy: { createdAt: 'asc' } },
      },
    });

    return res.status(200).json(serializarProjeto(updated));
  } catch (error) {
    console.error('Erro ao editar projeto:', error);
    return res.status(500).json({ error: 'Erro ao editar projeto' });
  }
});

// ==================== PUT /projetos/:id/status ====================
router.put('/:id/status', async (req: AuthRequest, res: Response) => {
  try {
    const { nome, justificativa } = req.body;

    if (!STATUS_VALIDOS.includes(nome)) {
      return res.status(400).json({ error: 'Status inválido.' });
    }

    const transicao = TRANSICOES[nome];
    if (!transicao) {
      return res.status(400).json({ error: 'Não é possível alterar para este status.' });
    }

    const projeto = await db.projeto.findUnique({
      where: { id: req.params.id },
      include: { status: true },
    });

    if (!projeto || projeto.instituicaoId !== req.user!.instituicaoId) {
      return res.status(404).json({ error: 'Projeto não encontrado' });
    }

    const statusAtual = projeto.status?.nome;
    if (!transicao.de.includes(statusAtual)) {
      return res.status(400).json({
        error: `Transição inválida. O projeto precisa estar em "${transicao.de.join(' ou ')}" para ir para "${nome}".`,
      });
    }

    const ehDono = projeto.liderUserId === req.user!.id;
    const temPermissao = await temPermissaoTransicao(
      req.user!.id,
      req.user!.userType,
      req.user!.instituicaoId,
      transicao,
    );
    const permitido = temPermissao || (transicao.donoPermitido && ehDono);

    if (!permitido) {
      return res.status(403).json({ error: 'Você não tem permissão para esta ação.' });
    }

    if (!projeto.statusId) {
      return res.status(500).json({ error: 'Projeto sem status associado.' });
    }

    await db.statusProjeto.update({
      where: { id: projeto.statusId },
      data: {
        nome,
        justificativa: justificativa || null,
        aprovadoPorId: nome === 'aprovado' || nome === 'recusado' ? req.user!.id : undefined,
      },
    });

    const atualizado = await db.projeto.findUnique({
      where: { id: req.params.id },
      include: {
        status: true,
        lider: { select: { id: true, nome: true, email: true } },
        areas: INCLUDE_AREAS,
        itens: { orderBy: { createdAt: 'asc' } },
        anexos: { orderBy: { createdAt: 'asc' } },
      },
    });

    return res.status(200).json(serializarProjeto(atualizado));
  } catch (error) {
    console.error('Erro ao alterar status do projeto:', error);
    return res.status(500).json({ error: 'Erro ao alterar status do projeto' });
  }
});

// ==================== POST /projetos/:id/anexos ====================
router.post('/:id/anexos', upload.single('arquivo'), async (req: AuthRequest, res: Response) => {
  try {
    const { tipo } = req.body;

    if (!['nota_fiscal', 'comprovante_pagamento'].includes(tipo)) {
      return res.status(400).json({ error: 'Tipo de anexo inválido.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }

    const projeto = await db.projeto.findUnique({ where: { id: req.params.id } });

    if (!projeto || projeto.instituicaoId !== req.user!.instituicaoId) {
      return res.status(404).json({ error: 'Projeto não encontrado' });
    }

    const ehDono = projeto.liderUserId === req.user!.id;
    const ehBackoffice = req.user!.userType === 'backoffice';
    let ehTesouraria = false;
    if (!ehBackoffice) {
      const userAreaTesouraria = await db.userArea.findFirst({
        where: { userId: req.user!.id, area: { nome: 'tesouraria', instituicaoId: req.user!.instituicaoId } },
      });
      ehTesouraria = !!userAreaTesouraria;
    }

    // Notas fiscais: líder dono ou backoffice. Comprovantes: membro da tesouraria ou backoffice.
    const permitido =
      tipo === 'nota_fiscal'
        ? ehDono || ehBackoffice
        : ehTesouraria || ehBackoffice;

    if (!permitido) {
      return res.status(403).json({ error: 'Você não tem permissão para anexar este tipo de arquivo.' });
    }

    const { url } = await uploadAnexo(req.user!.instituicaoId, projeto.id, {
      originalname: req.file.originalname,
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
    });

    const anexo = await db.anexoProjeto.create({
      data: {
        projetoId: projeto.id,
        tipo,
        nome: req.file.originalname,
        url,
        tamanho: req.file.size,
      },
    });

    return res.status(201).json({ ...anexo, createdAt: formatDateToBrasilia(anexo.createdAt) });
  } catch (error) {
    console.error('Erro ao anexar arquivo:', error);
    return res.status(500).json({ error: 'Erro ao anexar arquivo' });
  }
});

// ==================== DELETE /projetos/:id/anexos/:anexoId ====================
router.delete('/:id/anexos/:anexoId', async (req: AuthRequest, res: Response) => {
  try {
    const projeto = await db.projeto.findUnique({ where: { id: req.params.id } });

    if (!projeto || projeto.instituicaoId !== req.user!.instituicaoId) {
      return res.status(404).json({ error: 'Projeto não encontrado' });
    }

    const anexo = await db.anexoProjeto.findUnique({ where: { id: req.params.anexoId } });

    if (!anexo || anexo.projetoId !== projeto.id) {
      return res.status(404).json({ error: 'Anexo não encontrado' });
    }

    const ehDono = projeto.liderUserId === req.user!.id;
    const ehBackoffice = req.user!.userType === 'backoffice';
    let ehTesourariaDelete = false;
    if (!ehBackoffice) {
      const userAreaTesourariaDelete = await db.userArea.findFirst({
        where: { userId: req.user!.id, area: { nome: 'tesouraria', instituicaoId: req.user!.instituicaoId } },
      });
      ehTesourariaDelete = !!userAreaTesourariaDelete;
    }
    const permitido =
      anexo.tipo === 'nota_fiscal'
        ? ehDono || ehBackoffice
        : ehTesourariaDelete || ehBackoffice;

    if (!permitido) {
      return res.status(403).json({ error: 'Você não tem permissão para remover este anexo.' });
    }

    await removerAnexo(anexo.url);
    await db.anexoProjeto.delete({ where: { id: anexo.id } });

    return res.status(200).json({ message: 'Anexo removido com sucesso' });
  } catch (error) {
    console.error('Erro ao remover anexo:', error);
    return res.status(500).json({ error: 'Erro ao remover anexo' });
  }
});

export default router;
