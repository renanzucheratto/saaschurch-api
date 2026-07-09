export interface PlanoFeatures {
  pagamentosOnline: boolean;
  relatorios: boolean;
  projetos: boolean;
  areas: boolean;
  camposCustomizados: boolean;
  exportacao: boolean;
}

export type FeatureKey = keyof PlanoFeatures;

export type LimiteKey = 'eventosAtivos' | 'usuarios';

export interface UsoPlano {
  eventosAtivos: number;
  usuarios: number;
}

export interface PlanoSerializado {
  id: string;
  codigo: string;
  nome: string;
  descricao: string | null;
  cobrancaSaaS: boolean;
  valorMensal: string;
  valorAnual: string | null;
  feeEventoPercentual: string;
  feeEventoMinimo: string;
  feeEventoMaximo: string | null;
  features: PlanoFeatures;
  limites: {
    eventosAtivos: number | null;
    usuarios: number | null;
  };
  ativo: boolean;
  ordem: number;
}

// Código do plano usado quando `instituicao.planoId` é null (RN-04).
export const PLANO_PADRAO_CODIGO = process.env.PLANO_PADRAO_CODIGO || 'PILOTO_FREE';
