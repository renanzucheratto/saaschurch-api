-- Verificar participantes com CPF duplicado no mesmo evento
SELECT eventoId, cpf, COUNT(*) as count
FROM participantes
GROUP BY eventoId, cpf
HAVING COUNT(*) > 1;

-- Se houver duplicatas, você pode decidir qual manter
-- Exemplo: manter o mais recente e deletar os antigos
-- DELETE FROM participantes
-- WHERE id IN (
--   SELECT id FROM (
--     SELECT id, ROW_NUMBER() OVER (PARTITION BY eventoId, cpf ORDER BY createdAt DESC) as rn
--     FROM participantes
--   ) t
--   WHERE rn > 1
-- );
