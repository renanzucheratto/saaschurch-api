/**
 * Regra de split da plataforma.
 *
 * O plano define o padrão; a instituição pode sobrescrever campo a campo.
 * null no override = herda o plano (não significa "zero").
 *
 * Decimal do Prisma não é number: todo valor passa por Number() explícito,
 * mesmo padrão já usado em calcular-status-pagamento.ts.
 */

type Numerico = number | string | { toString(): string } | null | undefined;

export interface RegraSplit {
  percentual: number;
  minimo: number;
  maximo: number | null;
  /** De onde veio cada campo — usado pela UI para mostrar o que é herdado. */
  origem: {
    percentual: 'plano' | 'instituicao';
    minimo: 'plano' | 'instituicao';
    maximo: 'plano' | 'instituicao';
  };
}

interface InstituicaoSplit {
  splitPercentual?: Numerico;
  splitMinimo?: Numerico;
  splitMaximo?: Numerico;
}

interface PlanoSplit {
  feeEventoPercentual?: Numerico;
  feeEventoMinimo?: Numerico;
  feeEventoMaximo?: Numerico;
}

function paraNumero(valor: Numerico): number | null {
  if (valor === null || valor === undefined) return null;
  const n = typeof valor === 'number' ? valor : Number(valor.toString());
  return Number.isFinite(n) ? n : null;
}

export function resolveRegraSplit(
  instituicao: InstituicaoSplit | null | undefined,
  plano: PlanoSplit | null | undefined,
): RegraSplit {
  const instPercentual = paraNumero(instituicao?.splitPercentual);
  const instMinimo = paraNumero(instituicao?.splitMinimo);
  const instMaximo = paraNumero(instituicao?.splitMaximo);

  const planoPercentual = paraNumero(plano?.feeEventoPercentual) ?? 0;
  const planoMinimo = paraNumero(plano?.feeEventoMinimo) ?? 0;
  const planoMaximo = paraNumero(plano?.feeEventoMaximo);

  return {
    percentual: instPercentual ?? planoPercentual,
    minimo: instMinimo ?? planoMinimo,
    maximo: instMaximo ?? planoMaximo,
    origem: {
      percentual: instPercentual !== null ? 'instituicao' : 'plano',
      minimo: instMinimo !== null ? 'instituicao' : 'plano',
      maximo: instMaximo !== null ? 'instituicao' : 'plano',
    },
  };
}

/**
 * Converte a regra em reais para o campo marketplace_fee da preference.
 * O Mercado Pago espera VALOR ABSOLUTO em BRL, não percentual.
 */
export function calcularSplit(
  valor: number,
  regra: Pick<RegraSplit, 'percentual' | 'minimo' | 'maximo'>,
): number {
  if (!Number.isFinite(valor) || valor <= 0) return 0;

  let fee = valor * (regra.percentual / 100);

  fee = Math.max(fee, regra.minimo);

  if (regra.maximo !== null) {
    fee = Math.min(fee, regra.maximo);
  }

  // A comissão nunca pode engolir o valor inteiro: um piso alto sobre um
  // ticket baixo deixaria a instituição recebendo zero ou negativo.
  fee = Math.min(fee, valor);

  if (fee < 0) fee = 0;

  return Math.round(fee * 100) / 100;
}

/**
 * Validação dos overrides antes de gravar.
 * Retorna a lista de erros; vazia = válido.
 */
export function validarOverridesSplit(dados: {
  splitPercentual?: unknown;
  splitMinimo?: unknown;
  splitMaximo?: unknown;
}): string[] {
  const erros: string[] = [];

  const numeroOuNull = (v: unknown, campo: string): number | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) {
      erros.push(`${campo} deve ser numérico ou null`);
      return undefined;
    }
    return n;
  };

  const percentual = numeroOuNull(dados.splitPercentual, 'splitPercentual');
  const minimo = numeroOuNull(dados.splitMinimo, 'splitMinimo');
  const maximo = numeroOuNull(dados.splitMaximo, 'splitMaximo');

  if (typeof percentual === 'number' && (percentual < 0 || percentual > 100)) {
    erros.push('splitPercentual deve estar entre 0 e 100');
  }

  if (typeof minimo === 'number' && minimo < 0) {
    erros.push('splitMinimo não pode ser negativo');
  }

  if (typeof maximo === 'number' && maximo < 0) {
    erros.push('splitMaximo não pode ser negativo');
  }

  if (typeof minimo === 'number' && typeof maximo === 'number' && maximo < minimo) {
    erros.push('splitMaximo não pode ser menor que splitMinimo');
  }

  return erros;
}
