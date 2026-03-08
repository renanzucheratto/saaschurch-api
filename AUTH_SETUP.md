# Configuração de Autenticação - SaasChurch

Este documento descreve como configurar e usar o sistema de autenticação do SaasChurch.

## Estrutura do Sistema

O sistema de autenticação é composto por:

1. **Instituições** - Igrejas que usam o sistema
2. **Usuários** - Membros e backoffice vinculados a instituições
3. **Autenticação Supabase** - Gerenciamento de auth.users
4. **Sincronização** - Triggers que mantêm auth.users e public.users sincronizados

## Configuração do Banco de Dados

### 1. Atualizar o Schema do Prisma

O schema já foi atualizado em `prisma/schema.prisma` com as tabelas:
- `Instituicao` - Dados das igrejas
- `Users` - Dados dos usuários (sincronizado com auth.users)
- `Eventos` - Agora vinculado a instituição e usuário

### 2. Gerar o Prisma Client

```bash
cd saaschurch-api
pnpm prisma:generate
```

### 3. Criar as Tabelas no Banco

```bash
pnpm prisma:db:push
```

### 4. Aplicar os Triggers do Supabase

Execute o SQL em `supabase-auth-trigger.sql` no SQL Editor do Supabase:

1. Acesse o Supabase Dashboard
2. Vá em SQL Editor
3. Cole o conteúdo do arquivo `supabase-auth-trigger.sql`
4. Execute o script

Isso criará:
- Trigger para criar usuário em public.users quando criado em auth.users
- Trigger para atualizar usuário em public.users quando atualizado em auth.users
- Trigger para deletar usuário em public.users quando deletado em auth.users

## Estrutura de Dados

### Instituição

```typescript
{
  id: string;
  nome: string;
  cnpj?: string;
  endereco?: string;
  telefone?: string;
  email?: string;
  createdAt: Date;
  updatedAt: Date;
}
```

### Usuário

```typescript
{
  id: string; // Mesmo ID do auth.users
  email: string;
  nome: string;
  telefone?: string;
  userType: 'membro' | 'backoffice';
  instituicaoId: string;
  createdAt: Date;
  updatedAt: Date;
}
```

## Endpoints da API

### Autenticação (`/auth`)

#### POST `/auth/signup`
Cria um novo usuário.

**Body:**
```json
{
  "email": "usuario@exemplo.com",
  "password": "senha123",
  "nome": "Nome do Usuário",
  "telefone": "11999999999",
  "userType": "membro",
  "instituicaoId": "uuid-da-instituicao"
}
```

#### POST `/auth/signin`
Faz login.

**Body:**
```json
{
  "email": "usuario@exemplo.com",
  "password": "senha123"
}
```

**Response:**
```json
{
  "user": { ... },
  "session": {
    "access_token": "...",
    "refresh_token": "...",
    "expires_in": 3600,
    "expires_at": 1234567890
  }
}
```

#### POST `/auth/signout`
Faz logout (requer autenticação).

**Headers:**
```
Authorization: Bearer {access_token}
```

#### GET `/auth/me`
Retorna dados do usuário autenticado.

**Headers:**
```
Authorization: Bearer {access_token}
```

#### PUT `/auth/me`
Atualiza dados do usuário autenticado.

**Headers:**
```
Authorization: Bearer {access_token}
```

**Body:**
```json
{
  "nome": "Novo Nome",
  "telefone": "11888888888",
  "email": "novoemail@exemplo.com"
}
```

#### POST `/auth/refresh`
Renova o token de acesso.

**Body:**
```json
{
  "refresh_token": "..."
}
```

### Instituições (`/instituicoes`)

#### POST `/instituicoes`
Cria uma nova instituição (público).

**Body:**
```json
{
  "nome": "Igreja Exemplo",
  "cnpj": "12345678901234",
  "endereco": "Rua Exemplo, 123",
  "telefone": "1133334444",
  "email": "contato@igreja.com"
}
```

#### GET `/instituicoes`
Lista todas as instituições (requer backoffice).

#### GET `/instituicoes/:id`
Busca uma instituição (requer autenticação).

#### PUT `/instituicoes/:id`
Atualiza uma instituição (requer backoffice).

#### DELETE `/instituicoes/:id`
Deleta uma instituição (requer backoffice).

#### GET `/instituicoes/:id/users`
Lista usuários da instituição.

#### GET `/instituicoes/:id/eventos`
Lista eventos da instituição.

### Usuários (`/users`)

#### GET `/users`
Lista usuários (requer backoffice).

**Query params:**
- `instituicaoId` - Filtrar por instituição
- `userType` - Filtrar por tipo (membro/backoffice)

#### GET `/users/:id`
Busca um usuário.

#### PUT `/users/:id`
Atualiza um usuário (requer backoffice).

#### DELETE `/users/:id`
Deleta um usuário (requer backoffice).

#### POST `/users/:id/reset-password`
Redefine senha de um usuário (requer backoffice).

**Body:**
```json
{
  "password": "novasenha123"
}
```

#### POST `/users/:id/change-institution`
Altera a instituição de um usuário (requer backoffice).

**Body:**
```json
{
  "instituicaoId": "uuid-da-nova-instituicao"
}
```

## Middleware de Autenticação

### `authenticateUser`
Valida o token JWT e adiciona `req.user` com os dados do usuário.

### `requireBackoffice`
Requer que o usuário seja do tipo backoffice.

### `requireSameInstitution`
Requer que o usuário pertença à mesma instituição do recurso acessado.

## Fluxo de Criação de Usuário

1. Cliente chama `POST /auth/signup` com dados do usuário
2. API valida os dados e verifica se a instituição existe
3. API cria usuário em `auth.users` usando Supabase Admin
4. Trigger automático cria registro em `public.users` com mesmo ID
5. API retorna dados do usuário criado

## Tipos de Usuário

- **membro**: Usuário padrão da igreja, pode gerenciar eventos da sua instituição
- **backoffice**: Administrador do sistema, pode gerenciar todas as instituições e usuários

## Segurança

- Tokens JWT gerenciados pelo Supabase
- Senhas criptografadas pelo Supabase Auth
- Middleware valida tokens em todas as rotas protegidas
- RLS (Row Level Security) pode ser configurado no Supabase para segurança adicional
- Usuários só podem acessar dados da sua instituição (exceto backoffice)

## Próximos Passos

1. Execute `pnpm prisma:generate` para gerar os tipos do Prisma
2. Execute `pnpm prisma:db:push` para criar as tabelas
3. Execute o SQL do arquivo `supabase-auth-trigger.sql` no Supabase
4. Crie uma instituição inicial usando `POST /instituicoes`
5. Crie o primeiro usuário backoffice usando `POST /auth/signup`
