-- Migration: Adicionar campo updatedByEmail para auditoria
-- Data: 2026-03-29
-- Descrição: Adiciona o campo updatedByEmail em todas as tabelas relevantes para rastrear quem fez a última modificação

-- Adicionar updatedByEmail na tabela instituicoes
ALTER TABLE instituicoes ADD COLUMN "updatedByEmail" TEXT;

-- Adicionar updatedByEmail na tabela users
ALTER TABLE users ADD COLUMN "updatedByEmail" TEXT;

-- Adicionar updatedByEmail na tabela areas
ALTER TABLE areas ADD COLUMN "updatedByEmail" TEXT;

-- Adicionar updatedByEmail na tabela eventos
ALTER TABLE eventos ADD COLUMN "updatedByEmail" TEXT;

-- Adicionar updatedByEmail na tabela participantes
ALTER TABLE participantes ADD COLUMN "updatedByEmail" TEXT;

-- Adicionar updatedByEmail na tabela produtos_evento
ALTER TABLE produtos_evento ADD COLUMN "updatedByEmail" TEXT;

-- Adicionar updatedByEmail na tabela participante_produtos
ALTER TABLE participante_produtos ADD COLUMN "updatedByEmail" TEXT;

-- Adicionar updatedByEmail na tabela parcelas
ALTER TABLE parcelas ADD COLUMN "updatedByEmail" TEXT;
