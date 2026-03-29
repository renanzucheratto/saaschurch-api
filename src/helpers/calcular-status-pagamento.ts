/**
 * Calcula o status de pagamento de um produto do participante
 * baseado no exigePagamento do produto e nas parcelas pagas
 */

interface Parcela {
  valor_pago: number | string | { toNumber?: () => number };
}

interface Produto {
  exigePagamento: boolean;
  valor: number | string | { toNumber?: () => number; toString?: () => string };
}

export function calcularStatusPagamento(
  produto: Produto,
  parcelas: Parcela[]
): 'NAO_APLICA' | 'PENDENTE' | 'PARCIALMENTE_PAGO' | 'QUITADO' {
  // Se o produto não exige pagamento, status é sempre NAO_APLICA
  if (!produto.exigePagamento) {
    return 'NAO_APLICA';
  }

  // Se exige pagamento, calcular baseado nas parcelas
  const totalPago = parcelas.reduce((acc, p) => {
    let valor: number;
    if (typeof p.valor_pago === 'string') {
      valor = parseFloat(p.valor_pago);
    } else if (typeof p.valor_pago === 'number') {
      valor = p.valor_pago;
    } else {
      valor = Number(p.valor_pago);
    }
    return acc + valor;
  }, 0);

  let valorProduto: number;
  if (typeof produto.valor === 'string') {
    valorProduto = parseFloat(produto.valor);
  } else if (typeof produto.valor === 'number') {
    valorProduto = produto.valor;
  } else {
    valorProduto = Number(produto.valor);
  }

  if (totalPago >= valorProduto) {
    return 'QUITADO';
  } else if (totalPago > 0) {
    return 'PARCIALMENTE_PAGO';
  } else {
    return 'PENDENTE';
  }
}
