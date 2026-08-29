/**
 * Regra de split da plataforma.
 *
 * O plano define o padrão; a instituição pode sobrescrever campo a campo.
 * null no override = herda o plano (não significa "zero").
 *
 * A taxa pode ser PERCENTUAL (percentual do valor, com piso e teto opcionais)
 * ou FIXA (um valor em reais, independente do preço) — o contrato com cada
 * instituição pode ser de um jeito ou de outro, e alternar com o tempo.
 *
 * Decimal do Prisma não é number: todo valor passa por Number() explícito,
 * mesmo padrão já usado em calcular-status-pagamento.ts.
 */

export type TipoSplit = 'PERCENTUAL' | 'FIXO';

type Numerico = number | string | { toString(): string } | null | undefined;

type Origem = 'plano' | 'instituicao';

export interface RegraSplit {
  tipo: TipoSplit;
  /** Usado quando tipo = PERCENTUAL. */
  percentual: number;
  /** Usado quando tipo = FIXO. */
  valorFixo: number;
  /** Piso e teto só se aplicam ao percentual. */
  minimo: number;
  maximo: number | null;
  /** De onde veio cada campo — usado pela UI para mostrar o que é herdado. */
  origem: {
    tipo: Origem;
    percentual: Origem;
    valorFixo: Origem;
    minimo: Origem;
    maximo: Origem;
  };
}

interface InstituicaoSplit {
  splitTipo?: TipoSplit | null;
  splitValorFixo?: Numerico;
  splitPercentual?: Numerico;
  splitMinimo?: Numerico;
  splitMaximo?: Numerico;
}

interface PlanoSplit {
  feeEventoTipo?: TipoSplit | null;
  feeEventoValorFixo?: Numerico;
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
  const instTipo = instituicao?.splitTipo ?? null;
  const instValorFixo = paraNumero(instituicao?.splitValorFixo);
  const instPercentual = paraNumero(instituicao?.splitPercentual);
  const instMinimo = paraNumero(instituicao?.splitMinimo);
  const instMaximo = paraNumero(instituicao?.splitMaximo);

  const planoTipo = plano?.feeEventoTipo ?? 'PERCENTUAL';
  const planoValorFixo = paraNumero(plano?.feeEventoValorFixo) ?? 0;
  const planoPercentual = paraNumero(plano?.feeEventoPercentual) ?? 0;
  const planoMinimo = paraNumero(plano?.feeEventoMinimo) ?? 0;
  const planoMaximo = paraNumero(plano?.feeEventoMaximo);

  return {
    tipo: instTipo ?? planoTipo,
    percentual: instPercentual ?? planoPercentual,
    valorFixo: instValorFixo ?? planoValorFixo,
    minimo: instMinimo ?? planoMinimo,
    maximo: instMaximo ?? planoMaximo,
    origem: {
      tipo: instTipo !== null ? 'instituicao' : 'plano',
      percentual: instPercentual !== null ? 'instituicao' : 'plano',
      valorFixo: instValorFixo !== null ? 'instituicao' : 'plano',
      minimo: instMinimo !== null ? 'instituicao' : 'plano',
      maximo: instMaximo !== null ? 'instituicao' : 'plano',
    },
  };
}

/**
 * Converte a regra no valor absoluto que vai para o receiver da plataforma no
 * split do PagBank. O PagBank espera VALOR ABSOLUTO em centavos por receiver;
 * a conversão para centavos é feita na camada de checkout, aqui ainda é reais.
 */
export function calcularSplit(
  valor: number,
  regra: Pick<RegraSplit, 'tipo' | 'percentual' | 'valorFixo' | 'minimo' | 'maximo'>,
): number {
  if (!Number.isFinite(valor) || valor <= 0) return 0;

  let fee: number;

  if (regra.tipo === 'FIXO') {
    // Piso e teto não se aplicam: o valor fixo já É o valor combinado.
    fee = regra.valorFixo;
  } else {
    fee = valor * (regra.percentual / 100);
    fee = Math.max(fee, regra.minimo);

    if (regra.maximo !== null) {
      fee = Math.min(fee, regra.maximo);
    }
  }

  // A comissão nunca pode engolir o valor inteiro: uma taxa fixa alta sobre um
  // ticket baixo deixaria a instituição recebendo zero ou negativo.
  fee = Math.min(fee, valor);

  if (fee < 0 || !Number.isFinite(fee)) fee = 0;

  return Math.round(fee * 100) / 100;
}

/**
 * Validação dos overrides antes de gravar.
 * Retorna a lista de erros; vazia = válido.
 */
export function validarOverridesSplit(dados: {
  splitTipo?: unknown;
  splitValorFixo?: unknown;
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

  if (
    dados.splitTipo !== undefined &&
    dados.splitTipo !== null &&
    dados.splitTipo !== 'PERCENTUAL' &&
    dados.splitTipo !== 'FIXO'
  ) {
    erros.push('splitTipo deve ser PERCENTUAL, FIXO ou null');
  }

  const percentual = numeroOuNull(dados.splitPercentual, 'splitPercentual');
  const valorFixo = numeroOuNull(dados.splitValorFixo, 'splitValorFixo');
  const minimo = numeroOuNull(dados.splitMinimo, 'splitMinimo');
  const maximo = numeroOuNull(dados.splitMaximo, 'splitMaximo');

  if (typeof percentual === 'number' && (percentual < 0 || percentual > 100)) {
    erros.push('splitPercentual deve estar entre 0 e 100');
  }

  if (typeof valorFixo === 'number' && valorFixo < 0) {
    erros.push('splitValorFixo não pode ser negativo');
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

  // Taxa fixa sem valor cobraria zero silenciosamente em toda inscrição.
  if (dados.splitTipo === 'FIXO' && (valorFixo === null || valorFixo === undefined || valorFixo === 0)) {
    erros.push('splitValorFixo é obrigatório e maior que zero quando splitTipo é FIXO');
  }

  return erros;
}
