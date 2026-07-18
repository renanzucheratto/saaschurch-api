import { createHash } from 'node:crypto';
import { ExtratoBradesco, LancamentoMensal } from '../bradesco/mock-extrato.js';

export interface TransacaoParseada {
  dataMovimento: Date;
  valor: string; // decimal como string, ex.: "1233.00"
  tipo: 'CREDITO' | 'DEBITO';
  codigoBanco: string;
  descricaoBanco: string;
  descricaoAbrev: string | null;
  historico: string | null;
  documento: string | null;
  saldoApos: string | null;
  hashDedup: string;
}

// "1.233,00" -> "1233.00"
export function parseValorBR(valor: string): string {
  return valor.replace(/\./g, '').replace(',', '.');
}

// "05/11/2024" -> Date (UTC)
export function parseDataBR(data: string): Date {
  const [dia, mes, ano] = data.split('/').map(Number);
  return new Date(Date.UTC(ano, mes - 1, dia));
}

// Duas transações idênticas (mesmo dia, documento, código, sinal e valor)
// colidem no hash — aceitável para o dedup de reimportação de extrato.
function gerarHashDedup(contaBancariaId: string, l: LancamentoMensal): string {
  const base = [
    contaBancariaId,
    l.dataLancamento,
    l.numeroDocumento,
    l.codigoLancamento,
    l.sinalLancamento,
    l.valorLancamento,
  ].join('|');
  return createHash('sha256').update(base).digest('hex');
}

export function parseExtratoPorPeriodo(
  extrato: ExtratoBradesco,
  contaBancariaId: string,
): TransacaoParseada[] {
  const lancamentos = extrato.extratoPorPeriodo?.lstLancamentoMensal ?? [];

  return lancamentos
    .filter((l) => l.tipoLancamento !== '01' && l.codigoLancamento !== '00000') // Saldo Anterior
    .map((l) => ({
      dataMovimento: parseDataBR(l.dataLancamento),
      valor: parseValorBR(l.valorLancamento),
      tipo: (l.sinalLancamento === '-' ? 'DEBITO' : 'CREDITO') as 'CREDITO' | 'DEBITO',
      codigoBanco: l.codigoLancamento,
      descricaoBanco: l.descritivoLancamentoCompleto,
      descricaoAbrev: l.descritivoLancamentoAbreviado || null,
      historico: l.segundaLinhalLancamento?.trim() || null,
      documento: l.numeroDocumento || null,
      saldoApos: l.valorSaldoAposLancamento
        ? `${l.sinalSaldo === '-' ? '-' : ''}${parseValorBR(l.valorSaldoAposLancamento)}`
        : null,
      hashDedup: gerarHashDedup(contaBancariaId, l),
    }));
}
