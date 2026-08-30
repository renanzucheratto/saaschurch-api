/**
 * Resolve nome/e-mail/CPF/telefone de um participante.
 *
 * Existem dois caminhos de inscrição e eles gravam em lugares diferentes:
 *
 *  - evento SEM campos customizados: grava nas colunas de `participantes`
 *  - evento COM campos customizados: grava em `respostas_customizadas` e
 *    deixa as colunas nulas
 *
 * A API de Pedidos do PagBank exige `customer.email` e `customer.tax_id`, então
 * ler só as colunas faz toda inscrição do segundo caminho ser recusada com
 * `40001`. Este helper procura nos dois lugares, nessa ordem.
 */

export interface RespostaParaDados {
  valor: string | null;
  campo: { tipo: string };
}

export interface ParticipanteParaDados {
  nome?: string | null;
  email?: string | null;
  cpf?: string | null;
  telefone?: string | null;
}

export interface DadosParticipante {
  nome: string | null;
  email: string | null;
  cpf: string | null;
  telefone: string | null;
  /** Campos que a API de pagamento exige e não foram encontrados. */
  faltando: Array<'email' | 'cpf'>;
}

/**
 * Valida CPF pelos dígitos verificadores. O PagBank recusa CPF inválido com
 * `40001` genérico em `customer.tax_id`, então é melhor barrar aqui e dizer
 * "CPF inválido" do que deixar a pessoa achar que o cartão foi recusado.
 */
export function cpfValido(bruto: string): boolean {
  const cpf = bruto.replace(/\D/g, '');

  if (cpf.length !== 11) return false;
  // Sequências repetidas (000..., 111...) passam no cálculo mas não existem.
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const digito = (ateIndice: number): number => {
    let soma = 0;
    let peso = ateIndice + 1;

    for (let i = 0; i < ateIndice; i++) {
      soma += Number(cpf[i]) * peso--;
    }

    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };

  return digito(9) === Number(cpf[9]) && digito(10) === Number(cpf[10]);
}

/** Checagem de e-mail deliberadamente frouxa: só o que o PagBank recusaria. */
export function emailValido(valor: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(valor.trim());
}

function primeiroPorTipo(respostas: RespostaParaDados[], tipo: string): string | null {
  const achado = respostas.find(
    (r) => r.campo.tipo === tipo && typeof r.valor === 'string' && r.valor.trim() !== '',
  );
  return achado?.valor?.trim() ?? null;
}

function limparOuNulo(valor: string | null | undefined): string | null {
  const limpo = (valor ?? '').trim();
  return limpo === '' ? null : limpo;
}

export function resolverDadosParticipante(
  participante: ParticipanteParaDados,
  respostas: RespostaParaDados[] = [],
): DadosParticipante {
  const nome = limparOuNulo(participante.nome) ?? primeiroPorTipo(respostas, 'nome');

  const email = limparOuNulo(participante.email) ?? primeiroPorTipo(respostas, 'email');

  const cpfBruto = limparOuNulo(participante.cpf) ?? primeiroPorTipo(respostas, 'cpf');
  const cpf = cpfBruto ? cpfBruto.replace(/\D/g, '') || null : null;

  const telBruto = limparOuNulo(participante.telefone) ?? primeiroPorTipo(respostas, 'telefone');
  const telefone = telBruto ? telBruto.replace(/\D/g, '') || null : null;

  const faltando: Array<'email' | 'cpf'> = [];
  if (!email || !emailValido(email)) faltando.push('email');
  if (!cpf || !cpfValido(cpf)) faltando.push('cpf');

  return { nome, email, cpf, telefone, faltando };
}
