export const CAMPOS_REGRA = ['historico', 'descricao', 'codigo', 'valor'] as const;
export const OPERADORES_REGRA = [
  'contains',
  'equals',
  'starts_with',
  'greater_than',
  'less_than',
] as const;

export interface RegraLike {
  id: string;
  campo: string;
  operador: string;
  valor: string;
  tipoTransacao: string | null;
  categoriaId: string | null;
  fornecedorId: string | null;
  projetoId: string | null;
  areaId: string | null;
}

export interface TransacaoLike {
  tipo: string;
  historico: string | null;
  descricaoBanco: string;
  descricaoAbrev: string | null;
  codigoBanco: string;
  valor: unknown; // Prisma Decimal | string | number
}

export interface ClassificacaoRegra {
  regraAplicadaId: string;
  categoriaId: string | null;
  fornecedorId: string | null;
  projetoId: string | null;
  areaId: string | null;
}

function valorCampo(transacao: TransacaoLike, campo: string): string | number | null {
  switch (campo) {
    case 'historico':
      return transacao.historico;
    case 'descricao':
      return transacao.descricaoBanco || transacao.descricaoAbrev;
    case 'codigo':
      return transacao.codigoBanco;
    case 'valor':
      return Number(transacao.valor);
    default:
      return null;
  }
}

export function regraCasa(regra: RegraLike, transacao: TransacaoLike): boolean {
  if (regra.tipoTransacao && regra.tipoTransacao !== transacao.tipo) {
    return false;
  }

  const campo = valorCampo(transacao, regra.campo);
  if (campo === null || campo === undefined) return false;

  if (typeof campo === 'number') {
    const alvo = Number(parseFloat(regra.valor.replace(',', '.')));
    if (Number.isNaN(alvo)) return false;
    switch (regra.operador) {
      case 'equals':
        return campo === alvo;
      case 'greater_than':
        return campo > alvo;
      case 'less_than':
        return campo < alvo;
      default:
        return false;
    }
  }

  const texto = campo.toLowerCase();
  const alvo = regra.valor.toLowerCase();
  switch (regra.operador) {
    case 'contains':
      return texto.includes(alvo);
    case 'equals':
      return texto === alvo;
    case 'starts_with':
      return texto.startsWith(alvo);
    default:
      return false;
  }
}

// Regras já devem vir ordenadas por prioridade asc — primeira que casar vence.
export function aplicarRegras(
  transacao: TransacaoLike,
  regras: RegraLike[],
): ClassificacaoRegra | null {
  for (const regra of regras) {
    if (regraCasa(regra, transacao)) {
      return {
        regraAplicadaId: regra.id,
        categoriaId: regra.categoriaId,
        fornecedorId: regra.fornecedorId,
        projetoId: regra.projetoId,
        areaId: regra.areaId,
      };
    }
  }
  return null;
}
