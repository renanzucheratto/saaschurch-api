import { Router, Response } from 'express';
import { prisma } from '../lib/prisma/client.js';
import { authenticateUser, AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();
const db = prisma as any;

router.use(authenticateUser);

function formatArea(area: any) {
  const lideres = area.users
    .filter((ua: any) => ua.roleNaArea === 'lider')
    .map((ua: any) => ({ id: ua.user.id, nome: ua.user.nome, email: ua.user.email }));
  const membros = area.users
    .filter((ua: any) => ua.roleNaArea === 'membro')
    .map((ua: any) => ({ id: ua.user.id, nome: ua.user.nome, email: ua.user.email }));
  return {
    id: area.id,
    nome: area.nome,
    createdAt: area.createdAt,
    updatedAt: area.updatedAt,
    lideres,
    membros,
    totalIntegrantes: area.users.length,
  };
}

async function isLiderDaArea(userId: string, areaId: string): Promise<boolean> {
  const ua = await db.userArea.findFirst({ where: { userId, areaId, roleNaArea: 'lider' } });
  return !!ua;
}

// Se o usuário não é mais líder de nenhuma área, rebaixa para membro
async function syncUserTypeParaMembro(userId: string, excluirAreaId?: string) {
  const outrasAreasComoLider = await db.userArea.findFirst({
    where: {
      userId,
      roleNaArea: 'lider',
      ...(excluirAreaId && { areaId: { not: excluirAreaId } }),
    },
  });

  if (!outrasAreasComoLider) {
    await db.users.update({
      where: { id: userId },
      data: { userType: 'membro' },
    });
  }
}

// ==================== GET /areas ====================
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const areas = await db.area.findMany({
      where: { instituicaoId: req.user!.instituicaoId },
      include: {
        users: {
          include: { user: { select: { id: true, nome: true, email: true } } },
        },
      },
      orderBy: { nome: 'asc' },
    });
    return res.status(200).json(areas.map(formatArea));
  } catch (error) {
    console.error('Erro ao listar áreas:', error);
    return res.status(500).json({ error: 'Erro ao listar áreas' });
  }
});

// ==================== POST /areas ====================
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    if (!['lider', 'backoffice'].includes(req.user!.userType)) {
      return res.status(403).json({ error: 'Apenas líderes e backoffice podem criar áreas.' });
    }

    const { nome } = req.body;
    if (!nome?.trim()) {
      return res.status(400).json({ error: 'O nome da área é obrigatório.' });
    }

    const existing = await db.area.findFirst({
      where: { nome: nome.trim(), instituicaoId: req.user!.instituicaoId },
    });
    if (existing) {
      return res.status(400).json({ error: 'Já existe uma área com este nome.' });
    }

    const area = await db.area.create({
      data: {
        nome: nome.trim(),
        instituicaoId: req.user!.instituicaoId,
        updatedByEmail: req.user!.email,
        // Criador vira lider automaticamente (exceto backoffice)
        ...(req.user!.userType === 'lider' && {
          users: {
            create: { userId: req.user!.id, roleNaArea: 'lider' },
          },
        }),
      },
      include: {
        users: {
          include: { user: { select: { id: true, nome: true, email: true } } },
        },
      },
    });

    return res.status(201).json(formatArea(area));
  } catch (error) {
    console.error('Erro ao criar área:', error);
    return res.status(500).json({ error: 'Erro ao criar área' });
  }
});

// ==================== GET /areas/:id ====================
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const area = await db.area.findUnique({
      where: { id: req.params.id },
      include: {
        users: {
          include: { user: { select: { id: true, nome: true, email: true } } },
        },
      },
    });

    if (!area || area.instituicaoId !== req.user!.instituicaoId) {
      return res.status(404).json({ error: 'Área não encontrada' });
    }

    return res.status(200).json(formatArea(area));
  } catch (error) {
    console.error('Erro ao buscar área:', error);
    return res.status(500).json({ error: 'Erro ao buscar área' });
  }
});

// ==================== PUT /areas/:id ====================
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const area = await db.area.findUnique({ where: { id: req.params.id } });
    if (!area || area.instituicaoId !== req.user!.instituicaoId) {
      return res.status(404).json({ error: 'Área não encontrada' });
    }

    const podeEditar =
      req.user!.userType === 'backoffice' ||
      (req.user!.userType === 'lider' && (await isLiderDaArea(req.user!.id, req.params.id)));

    if (!podeEditar) {
      return res.status(403).json({ error: 'Você não tem permissão para editar esta área.' });
    }

    const { nome } = req.body;
    if (!nome?.trim()) {
      return res.status(400).json({ error: 'O nome da área é obrigatório.' });
    }

    const updated = await db.area.update({
      where: { id: req.params.id },
      data: { nome: nome.trim(), updatedByEmail: req.user!.email },
      include: {
        users: {
          include: { user: { select: { id: true, nome: true, email: true } } },
        },
      },
    });

    return res.status(200).json(formatArea(updated));
  } catch (error) {
    console.error('Erro ao atualizar área:', error);
    return res.status(500).json({ error: 'Erro ao atualizar área' });
  }
});

// ==================== DELETE /areas/:id ====================
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const area = await db.area.findUnique({
      where: { id: req.params.id },
      include: {
        users: { where: { roleNaArea: 'lider' }, select: { userId: true } },
      },
    });
    if (!area || area.instituicaoId !== req.user!.instituicaoId) {
      return res.status(404).json({ error: 'Área não encontrada' });
    }

    const podeRemover =
      req.user!.userType === 'backoffice' ||
      (req.user!.userType === 'lider' && (await isLiderDaArea(req.user!.id, req.params.id)));

    if (!podeRemover) {
      return res.status(403).json({ error: 'Você não tem permissão para remover esta área.' });
    }

    const liderIds = area.users.map((u: any) => u.userId);

    await db.area.delete({ where: { id: req.params.id } });

    // Rebaixa para membro os líderes que não lideram mais nenhuma outra área
    await Promise.all(liderIds.map((uid: string) => syncUserTypeParaMembro(uid)));

    return res.status(200).json({ message: 'Área removida com sucesso' });
  } catch (error) {
    console.error('Erro ao remover área:', error);
    return res.status(500).json({ error: 'Erro ao remover área' });
  }
});

// ==================== POST /areas/:id/membros ====================
router.post('/:id/membros', async (req: AuthRequest, res: Response) => {
  try {
    const area = await db.area.findUnique({ where: { id: req.params.id } });
    if (!area || area.instituicaoId !== req.user!.instituicaoId) {
      return res.status(404).json({ error: 'Área não encontrada' });
    }

    const { userId, roleNaArea } = req.body;
    if (!userId || !roleNaArea || !['lider', 'membro'].includes(roleNaArea)) {
      return res.status(400).json({ error: 'userId e roleNaArea (lider | membro) são obrigatórios.' });
    }

    const isBackoffice = req.user!.userType === 'backoffice';
    const isLider = req.user!.userType === 'lider' && (await isLiderDaArea(req.user!.id, req.params.id));

    // Apenas backoffice pode adicionar líderes
    if (roleNaArea === 'lider' && !isBackoffice) {
      return res.status(403).json({ error: 'Apenas backoffice pode adicionar líderes a uma área.' });
    }

    // Backoffice ou lider da área podem adicionar membros
    if (!isBackoffice && !isLider) {
      return res.status(403).json({ error: 'Você não tem permissão para gerenciar esta área.' });
    }

    const targetUser = await db.users.findFirst({
      where: { id: userId, instituicaoId: req.user!.instituicaoId },
    });
    if (!targetUser) {
      return res.status(404).json({ error: 'Usuário não encontrado nesta instituição.' });
    }

    const userArea = await db.userArea.upsert({
      where: { userId_areaId: { userId, areaId: req.params.id } },
      update: { roleNaArea },
      create: { userId, areaId: req.params.id, roleNaArea },
      include: { user: { select: { id: true, nome: true, email: true } } },
    });

    // Se adicionado como lider, promove o userType global para lider
    await db.users.update({
      where: { id: userId },
      data: { userType: roleNaArea },
    });

    return res.status(201).json({
      userId: userArea.user.id,
      nome: userArea.user.nome,
      email: userArea.user.email,
      roleNaArea: userArea.roleNaArea,
    });
  } catch (error) {
    console.error('Erro ao adicionar membro à área:', error);
    return res.status(500).json({ error: 'Erro ao adicionar membro à área' });
  }
});

// ==================== PUT /areas/:id/membros/:userId ====================
router.put('/:id/membros/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const area = await db.area.findUnique({ where: { id: req.params.id } });
    if (!area || area.instituicaoId !== req.user!.instituicaoId) {
      return res.status(404).json({ error: 'Área não encontrada' });
    }

    // Apenas backoffice pode alterar papéis
    if (req.user!.userType !== 'backoffice') {
      return res.status(403).json({ error: 'Apenas backoffice pode alterar papéis na área.' });
    }

    const { roleNaArea } = req.body;
    if (!roleNaArea || !['lider', 'membro'].includes(roleNaArea)) {
      return res.status(400).json({ error: 'roleNaArea deve ser lider ou membro.' });
    }

    const userArea = await db.userArea.findFirst({
      where: { userId: req.params.userId, areaId: req.params.id },
    });
    if (!userArea) {
      return res.status(404).json({ error: 'Usuário não é integrante desta área.' });
    }

    const anteriorRole = userArea.roleNaArea;

    const updated = await db.userArea.update({
      where: { id: userArea.id },
      data: { roleNaArea },
      include: { user: { select: { id: true, nome: true, email: true } } },
    });

    if (roleNaArea === 'lider') {
      // Promove para lider globalmente
      await db.users.update({
        where: { id: req.params.userId },
        data: { userType: 'lider' },
      });
    } else if (anteriorRole === 'lider' && roleNaArea === 'membro') {
      // Era lider e virou membro: verifica se ainda lidera outra área
      await syncUserTypeParaMembro(req.params.userId, req.params.id);
    }

    return res.status(200).json({
      userId: updated.user.id,
      nome: updated.user.nome,
      email: updated.user.email,
      roleNaArea: updated.roleNaArea,
    });
  } catch (error) {
    console.error('Erro ao atualizar papel do membro:', error);
    return res.status(500).json({ error: 'Erro ao atualizar papel do membro' });
  }
});

// ==================== DELETE /areas/:id/membros/:userId ====================
router.delete('/:id/membros/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const area = await db.area.findUnique({ where: { id: req.params.id } });
    if (!area || area.instituicaoId !== req.user!.instituicaoId) {
      return res.status(404).json({ error: 'Área não encontrada' });
    }

    const userArea = await db.userArea.findFirst({
      where: { userId: req.params.userId, areaId: req.params.id },
    });
    if (!userArea) {
      return res.status(404).json({ error: 'Usuário não é integrante desta área.' });
    }

    const isBackoffice = req.user!.userType === 'backoffice';
    const isLider = req.user!.userType === 'lider' && (await isLiderDaArea(req.user!.id, req.params.id));

    // Apenas backoffice pode remover líderes
    if (userArea.roleNaArea === 'lider' && !isBackoffice) {
      return res.status(403).json({ error: 'Apenas backoffice pode remover líderes de uma área.' });
    }

    // Backoffice ou lider da área podem remover membros
    if (!isBackoffice && !isLider) {
      return res.status(403).json({ error: 'Você não tem permissão para gerenciar esta área.' });
    }

    const eraLider = userArea.roleNaArea === 'lider';

    await db.userArea.delete({ where: { id: userArea.id } });

    // Se era lider, verifica se ainda lidera outra área para manter ou rebaixar o cargo
    if (eraLider) {
      await syncUserTypeParaMembro(req.params.userId);
    }

    return res.status(200).json({ message: 'Integrante removido da área com sucesso' });
  } catch (error) {
    console.error('Erro ao remover membro da área:', error);
    return res.status(500).json({ error: 'Erro ao remover membro da área' });
  }
});

export default router;
