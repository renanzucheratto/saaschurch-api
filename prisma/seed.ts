import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is not set');
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool as any);

const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('🌱 Iniciando seed do sistema RBAC...');

  // ==================== CRIAR ROLES ====================
  console.log('📝 Criando roles...');
  
  const roles = [
    { nome: 'admin', descricao: 'Administrador com acesso total ao sistema', nivel: 100 },
    { nome: 'pastor', descricao: 'Pastor com acesso quase total na instituição', nivel: 90 },
    { nome: 'lider', descricao: 'Líder genérico (pode ser líder de múltiplas áreas)', nivel: 70 },
    { nome: 'tesoureiro', descricao: 'Responsável financeiro', nivel: 60 },
    { nome: 'obreiro', descricao: 'Obreiro da igreja', nivel: 50 },
    { nome: 'voluntario', descricao: 'Voluntário genérico', nivel: 40 },
    { nome: 'membro', descricao: 'Membro comum', nivel: 10 },
  ];

  const createdRoles: any = {};
  for (const roleData of roles) {
    const role = await prisma.role.upsert({
      where: { nome: roleData.nome },
      update: roleData,
      create: roleData,
    });
    createdRoles[roleData.nome] = role;
    console.log(`  ✅ Role criado: ${role.nome}`);
  }

  // ==================== CRIAR PERMISSÕES ====================
  console.log('\n📝 Criando permissões...');

  const permissions = [
    // Eventos
    { recurso: 'eventos', acao: 'criar', descricao: 'Criar eventos' },
    { recurso: 'eventos', acao: 'editar', descricao: 'Editar eventos' },
    { recurso: 'eventos', acao: 'excluir', descricao: 'Excluir eventos' },
    { recurso: 'eventos', acao: 'visualizar', descricao: 'Visualizar eventos' },
    
    // Financeiro
    { recurso: 'financeiro', acao: 'criar', descricao: 'Criar registros financeiros' },
    { recurso: 'financeiro', acao: 'editar', descricao: 'Editar registros financeiros' },
    { recurso: 'financeiro', acao: 'excluir', descricao: 'Excluir registros financeiros' },
    { recurso: 'financeiro', acao: 'visualizar', descricao: 'Visualizar registros financeiros' },
    
    // Usuários
    { recurso: 'usuarios', acao: 'criar', descricao: 'Criar usuários' },
    { recurso: 'usuarios', acao: 'editar', descricao: 'Editar usuários' },
    { recurso: 'usuarios', acao: 'excluir', descricao: 'Excluir usuários' },
    { recurso: 'usuarios', acao: 'visualizar', descricao: 'Visualizar usuários' },
    
    // Áreas
    { recurso: 'areas', acao: 'criar', descricao: 'Criar áreas' },
    { recurso: 'areas', acao: 'editar', descricao: 'Editar áreas' },
    { recurso: 'areas', acao: 'excluir', descricao: 'Excluir áreas' },
    { recurso: 'areas', acao: 'visualizar', descricao: 'Visualizar áreas' },
    
    // Relatórios
    { recurso: 'relatorios', acao: 'visualizar', descricao: 'Visualizar relatórios' },
    { recurso: 'relatorios', acao: 'exportar', descricao: 'Exportar relatórios' },
    
    // Configurações
    { recurso: 'configuracoes', acao: 'editar', descricao: 'Editar configurações do sistema' },
  ];

  const createdPermissions: any = {};
  for (const permData of permissions) {
    const permission = await prisma.permission.upsert({
      where: { 
        recurso_acao: { 
          recurso: permData.recurso, 
          acao: permData.acao 
        } 
      },
      update: permData,
      create: permData,
    });
    const key = `${permData.recurso}:${permData.acao}`;
    createdPermissions[key] = permission;
    console.log(`  ✅ Permissão criada: ${key}`);
  }

  // ==================== ASSOCIAR PERMISSÕES AOS ROLES ====================
  console.log('\n📝 Associando permissões aos roles...');

  // Admin - Todas as permissões
  const adminPermissions = Object.values(createdPermissions);
  for (const permission of adminPermissions) {
    await prisma.rolePermission.upsert({
      where: {
        roleId_permissionId: {
          roleId: createdRoles.admin.id,
          permissionId: (permission as any).id,
        },
      },
      update: {},
      create: {
        roleId: createdRoles.admin.id,
        permissionId: (permission as any).id,
      },
    });
  }
  console.log(`  ✅ Admin: ${adminPermissions.length} permissões`);

  // Pastor - Quase todas (exceto configurações críticas)
  const pastorPermissions = Object.entries(createdPermissions)
    .filter(([key]) => !key.startsWith('configuracoes:'))
    .map(([, perm]) => perm);
  for (const permission of pastorPermissions) {
    await prisma.rolePermission.upsert({
      where: {
        roleId_permissionId: {
          roleId: createdRoles.pastor.id,
          permissionId: (permission as any).id,
        },
      },
      update: {},
      create: {
        roleId: createdRoles.pastor.id,
        permissionId: (permission as any).id,
      },
    });
  }
  console.log(`  ✅ Pastor: ${pastorPermissions.length} permissões`);

  // Líder
  const liderPermissionKeys = [
    'eventos:criar', 'eventos:editar', 'eventos:excluir', 'eventos:visualizar',
    'areas:visualizar',
    'usuarios:visualizar',
  ];
  for (const key of liderPermissionKeys) {
    const permission = createdPermissions[key];
    if (permission) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: createdRoles.lider.id,
            permissionId: permission.id,
          },
        },
        update: {},
        create: {
          roleId: createdRoles.lider.id,
          permissionId: permission.id,
        },
      });
    }
  }
  console.log(`  ✅ Líder: ${liderPermissionKeys.length} permissões`);

  // Tesoureiro
  const tesoureiroPermissionKeys = [
    'financeiro:criar', 'financeiro:editar', 'financeiro:excluir', 'financeiro:visualizar',
    'relatorios:visualizar', 'relatorios:exportar',
    'eventos:visualizar',
  ];
  for (const key of tesoureiroPermissionKeys) {
    const permission = createdPermissions[key];
    if (permission) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: createdRoles.tesoureiro.id,
            permissionId: permission.id,
          },
        },
        update: {},
        create: {
          roleId: createdRoles.tesoureiro.id,
          permissionId: permission.id,
        },
      });
    }
  }
  console.log(`  ✅ Tesoureiro: ${tesoureiroPermissionKeys.length} permissões`);

  // Obreiro
  const obreiroPermissionKeys = [
    'eventos:visualizar',
    'usuarios:visualizar',
  ];
  for (const key of obreiroPermissionKeys) {
    const permission = createdPermissions[key];
    if (permission) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: createdRoles.obreiro.id,
            permissionId: permission.id,
          },
        },
        update: {},
        create: {
          roleId: createdRoles.obreiro.id,
          permissionId: permission.id,
        },
      });
    }
  }
  console.log(`  ✅ Obreiro: ${obreiroPermissionKeys.length} permissões`);

  // Voluntário
  const voluntarioPermissionKeys = [
    'eventos:visualizar',
  ];
  for (const key of voluntarioPermissionKeys) {
    const permission = createdPermissions[key];
    if (permission) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: createdRoles.voluntario.id,
            permissionId: permission.id,
          },
        },
        update: {},
        create: {
          roleId: createdRoles.voluntario.id,
          permissionId: permission.id,
        },
      });
    }
  }
  console.log(`  ✅ Voluntário: ${voluntarioPermissionKeys.length} permissões`);

  // Membro
  const membroPermissionKeys = [
    'eventos:visualizar',
  ];
  for (const key of membroPermissionKeys) {
    const permission = createdPermissions[key];
    if (permission) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: createdRoles.membro.id,
            permissionId: permission.id,
          },
        },
        update: {},
        create: {
          roleId: createdRoles.membro.id,
          permissionId: permission.id,
        },
      });
    }
  }
  console.log(`  ✅ Membro: ${membroPermissionKeys.length} permissões`);

  console.log('\n✅ Seed concluído com sucesso!');
}

main()
  .catch((e) => {
    console.error('❌ Erro ao executar seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
