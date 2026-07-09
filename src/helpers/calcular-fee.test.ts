import { describe, expect, it } from 'vitest';
import { calcularFee, type ConfigFee } from './calcular-fee.js';

function plano(overrides: Partial<ConfigFee> = {}): ConfigFee {
  return {
    feeEventoPercentual: '0',
    feeEventoMinimo: '0',
    feeEventoMaximo: null,
    ...overrides,
  };
}

describe('calcularFee', () => {
  it('aplica o percentual simples', () => {
    const fee = calcularFee(plano({ feeEventoPercentual: '3.50' }), '200.00');

    expect(fee.toFixed(2)).toBe('7.00');
  });

  it('aplica o piso', () => {
    const fee = calcularFee(
      plano({ feeEventoPercentual: '1', feeEventoMinimo: '2.00' }),
      '50.00',
    );

    expect(fee.toFixed(2)).toBe('2.00');
  });

  it('aplica o teto', () => {
    const fee = calcularFee(
      plano({ feeEventoPercentual: '1', feeEventoMaximo: '10.00' }),
      '5000.00',
    );

    expect(fee.toFixed(2)).toBe('10.00');
  });

  it('trata teto null como sem teto', () => {
    const fee = calcularFee(plano({ feeEventoPercentual: '10', feeEventoMaximo: null }), '10000.00');

    expect(fee.toFixed(2)).toBe('1000.00');
  });

  it('arredonda com ROUND_HALF_UP em 2 casas', () => {
    // 100.10 × 7% = 7.007 → 7.01
    const fee = calcularFee(plano({ feeEventoPercentual: '7' }), '100.10');

    expect(fee.toFixed(2)).toBe('7.01');
  });

  it('arredonda 7.005 para 7.01, não para 7.00', () => {
    // 143 × 4.9% = 7.007; 100.0714... evita depender de binário. Usamos o piso:
    const fee = calcularFee(plano({ feeEventoMinimo: '7.005' }), '1000.00');

    expect(fee.toFixed(2)).toBe('7.01');
  });

  it('nunca deixa o fee alcançar o bruto', () => {
    const fee = calcularFee(plano({ feeEventoMinimo: '100.00' }), '10.00');

    expect(fee.lt('10.00')).toBe(true);
    expect(fee.toFixed(2)).toBe('9.99');
  });

  it('mantém fee >= 0 para bruto de um centavo', () => {
    const fee = calcularFee(plano({ feeEventoMinimo: '5.00' }), '0.01');

    expect(fee.toFixed(2)).toBe('0.00');
  });

  it('devolve zero para bruto zero', () => {
    expect(calcularFee(plano({ feeEventoPercentual: '10' }), '0').toFixed(2)).toBe('0.00');
  });

  it('devolve zero quando o plano não cobra fee', () => {
    expect(calcularFee(plano(), '999.99').toFixed(2)).toBe('0.00');
  });

  it('não perde precisão em valores que quebram em ponto flutuante', () => {
    // 0.1 + 0.2 !== 0.3 em `number`; aqui a soma dos produtos já chega em Decimal.
    const fee = calcularFee(plano({ feeEventoPercentual: '100' }), '0.30');

    expect(fee.toFixed(2)).toBe('0.29');
  });
});
