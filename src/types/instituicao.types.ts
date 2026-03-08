export interface CreateInstituicaoData {
  nome: string;
  cnpj?: string;
  endereco?: string;
  telefone?: string;
  email?: string;
}

export interface UpdateInstituicaoData {
  nome?: string;
  cnpj?: string;
  endereco?: string;
  telefone?: string;
  email?: string;
}

export interface Instituicao {
  id: string;
  nome: string;
  cnpj?: string;
  endereco?: string;
  telefone?: string;
  email?: string;
  createdAt: Date;
  updatedAt: Date;
}
