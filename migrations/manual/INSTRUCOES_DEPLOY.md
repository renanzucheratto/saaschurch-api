# Instruções de Deploy - Status Calculado Dinamicamente

## Ordem de execução (IMPORTANTE!)

### 1. Dropar coluna status do banco
Execute no Supabase SQL Editor:
```sql
ALTER TABLE participante_produtos DROP COLUMN IF EXISTS status;
```

### 2. Criar migration do Prisma
```bash
cd saaschurch-api
npx prisma migrate dev --name remove_status_column
```

Isso vai:
- Detectar que a coluna `status` foi removida do schema
- Criar uma migration
- Aplicar no banco (se ainda não foi aplicada)
- Gerar o Prisma Client atualizado

### 3. Verificar se funcionou
```bash
# Verificar schema gerado
cat node_modules/.prisma/client/index.d.ts | grep -A 10 "ParticipanteProdutos"
```

Não deve ter campo `status` no tipo.

### 4. Reiniciar servidor
```bash
npm run dev
```

## Troubleshooting

### Erro: "column participante_produtos.status does not exist"
- Significa que o Prisma Client ainda está usando schema antigo
- Solução: rode `npx prisma generate` novamente

### Erro: Migration já aplicada
- Se já dropou a coluna manualmente, use:
```bash
npx prisma db pull  # Sincroniza schema.prisma com banco
npx prisma generate # Gera client atualizado
```
