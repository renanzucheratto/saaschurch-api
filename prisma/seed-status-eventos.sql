-- Script para adicionar status padrão aos eventos existentes
-- Execute este script no Supabase SQL Editor

-- Criar um status "aberto" para cada evento que ainda não tem status
-- e atualizar o evento para referenciar esse status
DO $$
DECLARE
  evento_record RECORD;
  novo_status_id UUID;
BEGIN
  -- Iterar sobre cada evento sem status
  FOR evento_record IN 
    SELECT id, nome 
    FROM eventos 
    WHERE "statusId" IS NULL
  LOOP
    -- Criar um novo status "aberto" para este evento
    INSERT INTO status_eventos (id, nome, justificativa)
    VALUES (gen_random_uuid(), 'aberto', NULL)
    RETURNING id INTO novo_status_id;
    
    -- Atualizar o evento com o novo statusId
    UPDATE eventos 
    SET "statusId" = novo_status_id
    WHERE id = evento_record.id;
    
    RAISE NOTICE 'Status criado para evento: % (ID: %)', evento_record.nome, evento_record.id;
  END LOOP;
END $$;

-- Verificar o resultado
SELECT 
  e.id,
  e.nome,
  e."statusId",
  s.nome as status_nome,
  s.justificativa,
  e."createdAt"
FROM eventos e
LEFT JOIN status_eventos s ON e."statusId" = s.id
ORDER BY e."createdAt" DESC;
