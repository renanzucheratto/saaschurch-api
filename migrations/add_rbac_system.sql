-- Migration: Add RBAC System
-- Description: Adiciona sistema de roles e permissões, remove userType e modifica UserArea

-- ==================== CRIAR NOVAS TABELAS ====================

-- Tabela de Roles
CREATE TABLE IF NOT EXISTS "roles" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "descricao" TEXT,
    "nivel" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "roles_nome_key" ON "roles"("nome");

-- Tabela de Permissions
CREATE TABLE IF NOT EXISTS "permissions" (
    "id" TEXT NOT NULL,
    "recurso" TEXT NOT NULL,
    "acao" TEXT NOT NULL,
    "descricao" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "permissions_recurso_acao_key" ON "permissions"("recurso", "acao");

-- Tabela de RolePermission (Many-to-Many)
CREATE TABLE IF NOT EXISTS "role_permissions" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "role_permissions_roleId_permissionId_key" ON "role_permissions"("roleId", "permissionId");
CREATE INDEX IF NOT EXISTS "role_permissions_roleId_idx" ON "role_permissions"("roleId");
CREATE INDEX IF NOT EXISTS "role_permissions_permissionId_idx" ON "role_permissions"("permissionId");

-- Tabela de UserRole (Many-to-Many)
CREATE TABLE IF NOT EXISTS "user_roles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_roles_userId_roleId_key" ON "user_roles"("userId", "roleId");
CREATE INDEX IF NOT EXISTS "user_roles_userId_idx" ON "user_roles"("userId");
CREATE INDEX IF NOT EXISTS "user_roles_roleId_idx" ON "user_roles"("roleId");

-- ==================== MODIFICAR TABELA user_areas ====================

-- Renomear coluna cargo para roleNaArea
ALTER TABLE "user_areas" 
RENAME COLUMN "cargo" TO "roleNaArea";

-- ==================== ADICIONAR FOREIGN KEYS ====================

-- RolePermission foreign keys
ALTER TABLE "role_permissions" 
ADD CONSTRAINT "role_permissions_roleId_fkey" 
FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "role_permissions" 
ADD CONSTRAINT "role_permissions_permissionId_fkey" 
FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- UserRole foreign keys
ALTER TABLE "user_roles" 
ADD CONSTRAINT "user_roles_userId_fkey" 
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_roles" 
ADD CONSTRAINT "user_roles_roleId_fkey" 
FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ==================== NOTA ====================
-- A coluna userType será removida APÓS a migração dos dados via seed
-- Não remover agora para permitir a migração dos usuários existentes
