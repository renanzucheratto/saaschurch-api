-- Migração: Remover coluna status (agora calculado dinamicamente)
-- Executar após deploy do backend

ALTER TABLE participante_produtos DROP COLUMN IF EXISTS status;
