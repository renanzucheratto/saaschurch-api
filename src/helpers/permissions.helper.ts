import { prisma } from '../lib/prisma/client.js';

// ==================== PERMISSÕES GLOBAIS ====================

/**
 * Verifica se o usuário tem uma permissão específica
 */
export async function hasPermission(
  userId: string,
  recurso: string,
  acao: string
): Promise<boolean> {
  const userWithPermissions = await prisma.users.findUnique({
    where: { id: userId },
    include: {
      userRoles: {
        include: {
          role: {
            include: {
              permissions: {
                include: {
                  permission: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!userWithPermissions) {
    return false;
  }

  // Verificar se algum role do usuário tem a permissão
  return userWithPermissions.userRoles.some((ur) =>
    ur.role.permissions.some(
      (rp) => rp.permission.recurso === recurso && rp.permission.acao === acao
    )
  );
}

/**
 * Verifica se o usuário tem um role específico
 */
export async function hasRole(userId: string, roleName: string): Promise<boolean> {
  const userRole = await prisma.userRole.findFirst({
    where: {
      userId,
      role: {
        nome: roleName,
      },
    },
  });

  return !!userRole;
}

/**
 * Verifica se o usuário tem pelo menos um dos roles fornecidos
 */
export async function hasAnyRole(userId: string, roleNames: string[]): Promise<boolean> {
  const userRole = await prisma.userRole.findFirst({
    where: {
      userId,
      role: {
        nome: {
          in: roleNames,
        },
      },
    },
  });

  return !!userRole;
}

/**
 * Retorna todas as permissões do usuário
 */
export async function getUserPermissions(userId: string) {
  const userWithPermissions = await prisma.users.findUnique({
    where: { id: userId },
    include: {
      userRoles: {
        include: {
          role: {
            include: {
              permissions: {
                include: {
                  permission: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!userWithPermissions) {
    return [];
  }

  // Coletar todas as permissões únicas
  const permissionsMap = new Map();
  
  userWithPermissions.userRoles.forEach((ur) => {
    ur.role.permissions.forEach((rp) => {
      const key = `${rp.permission.recurso}:${rp.permission.acao}`;
      if (!permissionsMap.has(key)) {
        permissionsMap.set(key, {
          id: rp.permission.id,
          recurso: rp.permission.recurso,
          acao: rp.permission.acao,
          descricao: rp.permission.descricao,
        });
      }
    });
  });

  return Array.from(permissionsMap.values());
}

/**
 * Retorna todos os roles do usuário
 */
export async function getUserRoles(userId: string) {
  const userRoles = await prisma.userRole.findMany({
    where: { userId },
    include: {
      role: true,
    },
  });

  return userRoles.map((ur) => ({
    id: ur.role.id,
    nome: ur.role.nome,
    descricao: ur.role.descricao,
    nivel: ur.role.nivel,
  }));
}

// ==================== PERMISSÕES DE ÁREA ====================

/**
 * Verifica se o usuário pertence a uma área
 */
export async function belongsToArea(userId: string, areaId: string): Promise<boolean> {
  const userArea = await prisma.userArea.findUnique({
    where: {
      userId_areaId: {
        userId,
        areaId,
      },
    },
  });

  return !!userArea;
}

/**
 * Verifica se o usuário é líder de uma área
 */
export async function isAreaLeader(userId: string, areaId: string): Promise<boolean> {
  const userArea = await prisma.userArea.findUnique({
    where: {
      userId_areaId: {
        userId,
        areaId,
      },
    },
  });

  return userArea?.roleNaArea === 'lider';
}

/**
 * Verifica se o usuário tem um role específico em uma área
 */
export async function hasAreaRole(
  userId: string,
  areaId: string,
  roleNaArea: string
): Promise<boolean> {
  const userArea = await prisma.userArea.findUnique({
    where: {
      userId_areaId: {
        userId,
        areaId,
      },
    },
  });

  return userArea?.roleNaArea === roleNaArea;
}

/**
 * Verifica se o usuário pode criar na área (líder ou coordenador)
 */
export async function canCreateInArea(userId: string, areaId: string): Promise<boolean> {
  const userArea = await prisma.userArea.findUnique({
    where: {
      userId_areaId: {
        userId,
        areaId,
      },
    },
  });

  return userArea?.roleNaArea === 'lider' || userArea?.roleNaArea === 'coordenador';
}

/**
 * Verifica se o usuário pode editar na área (líder ou coordenador)
 */
export async function canEditInArea(userId: string, areaId: string): Promise<boolean> {
  return canCreateInArea(userId, areaId); // Mesma lógica
}

/**
 * Retorna todas as áreas do usuário
 */
export async function getUserAreas(userId: string) {
  const userAreas = await prisma.userArea.findMany({
    where: { userId },
    include: {
      area: true,
    },
  });

  return userAreas.map((ua) => ({
    areaId: ua.area.id,
    areaNome: ua.area.nome,
    roleNaArea: ua.roleNaArea,
  }));
}

/**
 * Verifica se o usuário pode acessar uma área
 * Admin pode acessar todas as áreas; outros precisam pertencer à área
 */
export async function canAccessArea(userId: string, areaId: string): Promise<boolean> {
  const isAdmin = await hasAnyRole(userId, ['admin']);
  if (isAdmin) return true;
  return belongsToArea(userId, areaId);
}
