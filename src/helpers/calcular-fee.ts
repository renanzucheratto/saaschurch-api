import { Prisma } from '@prisma/client';

const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;

const UM_CENTAVO = new Decimal('0.01');

/**
 * Configuração de fee de um plano. Estrutural de propósito: `calcularFee` é
 * exercitável sem uma linha do banco.
 */
export interface ConfigFee {
  feeEventoPercentual: Decimal | string;
  feeEventoMinimo: Decimal | string;
  feeEventoMaximo: Decimal | string | null;
}

/**
 * fee = bruto × pct / 100, aplicando piso, teto e ROUND_HALF_UP em 2 casas.
 * Invariante: 0 <= fee < bruto.
 *
 * Tudo em `Decimal`: `0.1 + 0.2 !== 0.3` custa centavos por transação e torna a
 * reconciliação de fim de mês impossível.
 */
export function calcularFee(plano: ConfigFee, bruto: Decimal | string): Decimal {
  const valorBruto = new Decimal(bruto);

  if (valorBruto.lte(0)) {
    return new Decimal(0);
  }

  const percentual = new Decimal(plano.feeEventoPercentual);
  const minimo = new Decimal(plano.feeEventoMinimo);
  const maximo = plano.feeEventoMaximo === null ? null : new Decimal(plano.feeEventoMaximo);

  let fee = valorBruto.mul(percentual).div(100);

  if (fee.lt(minimo)) {
    fee = minimo;
  }

  if (maximo !== null && fee.gt(maximo)) {
    fee = maximo;
  }

  fee = fee.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  // A plataforma nunca retém a transação inteira: o piso do plano pode ultrapassar
  // um bruto pequeno, e o MP rejeita `application_fee >= transaction_amount`.
  if (fee.gte(valorBruto)) {
    fee = valorBruto.minus(UM_CENTAVO);
  }

  return fee.lt(0) ? new Decimal(0) : fee;
}
