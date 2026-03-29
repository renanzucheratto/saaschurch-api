# Migração Manual - Status NAO_APLICA

## Como executar

### Opção 1: Via Prisma Studio
1. Abra o Prisma Studio: `npx prisma studio`
2. Execute as queries SQL manualmente na aba SQL

### Opção 2: Via psql (PostgreSQL CLI)
```bash
# Substitua pela sua connection string
psql "postgresql://user:password@host:port/database" -f migrations/manual/20250329_update_status_pago_to_nao_aplica.sql
```

### Opção 3: Via Supabase Dashboard
1. Acesse o Supabase Dashboard
2. Vá em SQL Editor
3. Cole o conteúdo do arquivo `20250329_update_status_pago_to_nao_aplica.sql`
4. Execute

### Opção 4: Via código (temporário)
Execute o script abaixo uma única vez e depois remova:

```typescript
// Adicione temporariamente em src/server.ts ou crie um script separado
import { prisma } from './lib/prisma';

async function migrateStatus() {
  // 1. PAGO -> NAO_APLICA
  await prisma.$executeRaw`
    UPDATE participante_produtos
    SET status = 'NAO_APLICA'
    WHERE status = 'PAGO'
  `;

  // 2. Produtos sem exigePagamento -> NAO_APLICA
  await prisma.$executeRaw`
    UPDATE participante_produtos pp
    SET status = 'NAO_APLICA'
    FROM produtos_evento pe
    WHERE pp."produtoId" = pe.id
      AND pe."exigePagamento" = false
      AND pp.status != 'NAO_APLICA'
  `;

  console.log('✅ Migração concluída');
}

migrateStatus().then(() => process.exit(0));
```

## Verificação

Após executar, verifique:
```sql
SELECT status, COUNT(*) 
FROM participante_produtos 
GROUP BY status;
```

Deve retornar apenas: `NAO_APLICA`, `PENDENTE`, `PARCIALMENTE_PAGO`, `QUITADO`
