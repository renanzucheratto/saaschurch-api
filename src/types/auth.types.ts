export interface SignUpData {
  email: string;
  password: string;
  nome: string;
  telefone?: string;
  rg?: string;
  cpf?: string;
  userType: 'membro' | 'backoffice';
  instituicaoId: string;
}

export interface SignInData {
  email: string;
  password: string;
}

export interface AuthUser {
  id: string;
  email: string;
  nome: string;
  telefone?: string;
  rg?: string;
  cpf?: string;
  userType: 'membro' | 'backoffice';
  instituicaoId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthResponse {
  user: AuthUser;
  session: {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    expires_at: number;
  };
}

export interface UpdateUserData {
  nome?: string;
  telefone?: string;
  rg?: string;
  cpf?: string;
  email?: string;
}
