/**
 * Pedidos (Orders) e cobranças (Charges) do PagBank, com divisão de
 * pagamento (split). É o substituto direto do `Preference` do Mercado Pago —
 * mas ao contrário do MP, o PagBank NÃO aceita split no checkout hospedado
 * (`/checkouts`): split só existe em `/orders`. Por isso a tela de pagamento
 * do participante é NOSSA (PIX/boleto/cartão), não um redirect para o
 * PagBank — ver docs/pagbank-implementacao.md.
 *
 * PCI: esta plataforma não é certificada PCI-DSS. Cartão SEMPRE chega aqui já
 * cifrado pelo `PagSeguro.encryptCard()` do frontend — o número em claro
 * nunca entra no nosso backend, nunca é logado, nunca é persistido.
 * developer.pagbank.com.br/reference/validar-armanezar-cartao-pagbank.
 */

import { baseUrlOrders, requestPb } from './client.js';

export interface ReceiverSplit {
  accountId: string;
  /** Centavos. */
  valor: number;
}

export interface SplitPedido {
  method: 'FIXED';
  receivers: ReceiverSplit[];
}

function montarSplit(split: SplitPedido) {
  return {
    method: split.method,
    receivers: split.receivers.map((r) => ({
      account: { id: r.accountId },
      amount: { value: r.valor },
    })),
  };
}

export interface ClientePedido {
  name: string;
  email?: string;
  taxId?: string;
  telefone?: string;
}

interface BasePedido {
  referenceId: string;
  itemNome: string;
  itemDescricao?: string;
  /** Centavos. */
  valor: number;
  cliente: ClientePedido;
  split: SplitPedido;
  notificationUrl: string;
}

function montarBase(p: BasePedido) {
  return {
    reference_id: p.referenceId,
    customer: {
      name: p.cliente.name || 'Participante',
      email: p.cliente.email || undefined,
      tax_id: p.cliente.taxId || undefined,
      phones: p.cliente.telefone
        ? [{ country: '55', area: p.cliente.telefone.slice(0, 2), number: p.cliente.telefone.slice(2), type: 'MOBILE' }]
        : undefined,
    },
    items: [
      {
        reference_id: p.referenceId,
        name: p.itemNome,
        quantity: 1,
        unit_amount: p.valor,
      },
    ],
    notification_urls: [p.notificationUrl],
  };
}

export interface PedidoPagBank {
  id: string;
  reference_id?: string;
  charges: ChargePagBank[];
  links: Array<{ rel: string; href: string; type?: string }>;
}

export interface ChargePagBank {
  id: string;
  reference_id?: string;
  status: string;
  amount: { value: number; currency: string };
  payment_response?: { code?: string; message?: string; reference?: string };
  payment_method: {
    type: string;
    installments?: number;
    card?: {
      brand?: string;
      first_digits?: string;
      last_digits?: string;
      barcode?: string;
      formatted_barcode?: string;
    };
  };
  qr_code?: { id: string; text: string };
  links?: Array<{ rel: string; href: string; media?: string }>;
}

/** Cartão já cifrado pelo `PagSeguro.encryptCard()` — nunca o PAN em claro. */
export interface CartaoCifradoOrders {
  encrypted: string;
  securityCode: string;
  parcelas: number;
}

export async function criarPedidoComCartao(
  accessToken: string,
  pedido: BasePedido & { cartao: CartaoCifradoOrders },
): Promise<PedidoPagBank> {
  const body = {
    ...montarBase(pedido),
    charges: [
      {
        reference_id: pedido.referenceId,
        description: pedido.itemDescricao || pedido.itemNome,
        amount: { value: pedido.valor, currency: 'BRL' },
        payment_method: {
          type: 'CREDIT_CARD',
          installments: pedido.cartao.parcelas,
          capture: true,
          card: {
            encrypted: pedido.cartao.encrypted,
            security_code: pedido.cartao.securityCode,
          },
        },
        splits: montarSplit(pedido.split),
      },
    ],
  };

  return requestPb<PedidoPagBank>('POST /orders (cartão)', {
    method: 'POST',
    baseUrl: baseUrlOrders(),
    path: '/orders',
    accessToken,
    idempotencyKey: pedido.referenceId,
    body,
  });
}

export async function criarPedidoComPix(
  accessToken: string,
  pedido: BasePedido & { expiraEm: Date },
): Promise<PedidoPagBank> {
  const body = {
    ...montarBase(pedido),
    charges: [
      {
        reference_id: pedido.referenceId,
        description: pedido.itemDescricao || pedido.itemNome,
        amount: { value: pedido.valor, currency: 'BRL' },
        payment_method: {
          type: 'PIX',
          pix: { expiration_date: pedido.expiraEm.toISOString() },
        },
        splits: montarSplit(pedido.split),
      },
    ],
  };

  return requestPb<PedidoPagBank>('POST /orders (pix)', {
    method: 'POST',
    baseUrl: baseUrlOrders(),
    path: '/orders',
    accessToken,
    idempotencyKey: pedido.referenceId,
    body,
  });
}

export interface BoletoHolder {
  name: string;
  taxId: string;
  email?: string;
  address: {
    street: string;
    number: string;
    postalCode: string;
    locality: string;
    city: string;
    regionCode: string;
  };
}

export async function criarPedidoComBoleto(
  accessToken: string,
  pedido: BasePedido & { vencimento: Date; holder: BoletoHolder },
): Promise<PedidoPagBank> {
  const body = {
    ...montarBase(pedido),
    charges: [
      {
        reference_id: pedido.referenceId,
        description: pedido.itemDescricao || pedido.itemNome,
        amount: { value: pedido.valor, currency: 'BRL' },
        payment_method: {
          type: 'BOLETO',
          boleto: {
            due_date: pedido.vencimento.toISOString().slice(0, 10),
            holder: {
              name: pedido.holder.name,
              tax_id: pedido.holder.taxId.replace(/\D/g, ''),
              email: pedido.holder.email,
              address: {
                street: pedido.holder.address.street,
                number: pedido.holder.address.number,
                postal_code: pedido.holder.address.postalCode.replace(/\D/g, ''),
                locality: pedido.holder.address.locality,
                city: pedido.holder.address.city,
                region_code: pedido.holder.address.regionCode,
                country: 'Brasil',
              },
            },
            instruction_lines: {
              line_1: 'Pagamento até a data de vencimento',
            },
          },
        },
        splits: montarSplit(pedido.split),
      },
    ],
  };

  return requestPb<PedidoPagBank>('POST /orders (boleto)', {
    method: 'POST',
    baseUrl: baseUrlOrders(),
    path: '/orders',
    accessToken,
    idempotencyKey: pedido.referenceId,
    body,
  });
}

export async function consultarPedido(accessToken: string, orderId: string): Promise<PedidoPagBank> {
  return requestPb<PedidoPagBank>('GET /orders/{id}', {
    method: 'GET',
    baseUrl: baseUrlOrders(),
    path: `/orders/${orderId}`,
    accessToken,
  });
}

export async function consultarCharge(accessToken: string, chargeId: string): Promise<ChargePagBank> {
  return requestPb<ChargePagBank>('GET /charges/{id}', {
    method: 'GET',
    baseUrl: baseUrlOrders(),
    path: `/charges/${chargeId}`,
    accessToken,
  });
}

/**
 * Chave pública para o frontend cifrar o cartão com `PagSeguro.encryptCard()`
 * antes de mandar pro checkout.
 *
 * ATENÇÃO ao verbo: aqui é POST, e no host de Assinaturas o MESMO caminho
 * `/public-keys` é PUT (ver `assinaturas.ts`). Não é descuido — verificado
 * contra a sandbox em 2026-08-29: neste host PUT devolve 403 e POST devolve
 * 200; no host de Assinaturas é o inverso (POST devolve 405).
 */
export async function obterChavePublicaOrders(accessToken: string): Promise<{ public_key: string }> {
  return requestPb('POST /public-keys (orders)', {
    method: 'POST',
    baseUrl: baseUrlOrders(),
    path: '/public-keys',
    accessToken,
    body: { type: 'card' },
  });
}

/**
 * Consulta cadastral da conta conectada. Exige as DUAS credenciais em papéis
 * distintos, e não aceita nenhuma outra combinação:
 *
 *   Authorization: Bearer <token da PLATAFORMA>
 *   x-client-token: <access_token OAuth da INSTITUIÇÃO>
 *
 * Verificado contra a sandbox em 2026-08-29: mandar o token da instituição no
 * Bearer devolve 403 ("explicit deny"), mesmo com o escopo `accounts.read`
 * concedido; omitir o `x-client-token` também devolve 403.
 */
export async function consultarConta(
  accessTokenInstituicao: string,
  accountId: string,
): Promise<{ id: string; type?: string; status?: string; email?: string }> {
  const tokenPlataforma = process.env.PAGBANK_ACCESS_TOKEN;

  if (!tokenPlataforma) {
    throw new Error('PAGBANK_ACCESS_TOKEN não configurada');
  }

  return requestPb('GET /accounts/{id}', {
    method: 'GET',
    baseUrl: baseUrlOrders(),
    path: `/accounts/${accountId}`,
    accessToken: tokenPlataforma,
    headers: { 'x-client-token': accessTokenInstituicao },
  });
}

export interface PlanoParcelamentoPb {
  installments: number;
  installment_value: number;
  interest_free: boolean;
  amount: {
    value: number;
    fees?: {
      seller?: { total?: number };
      buyer?: { interest?: { total?: number } };
    };
  };
}

/**
 * Simulador de taxas do PagBank — responde ANTES da transação existir, então
 * serve para mostrar o líquido estimado na hora de precificar um produto.
 *
 * Só existe em GET com query string; o mesmo caminho em POST devolve 403.
 *
 * A taxa vem do contrato da conta: em sandbox `fees.seller.total` volta 0,
 * porque não há contrato de verdade. Quem consome precisa distinguir "taxa
 * zero" de "taxa desconhecida" — ver `taxaPagBankDisponivel` no chamador.
 */
export async function simularTaxas(
  accessToken: string,
  params: { valorCentavos: number; maxParcelas?: number },
): Promise<Record<string, Record<string, { installment_plans: PlanoParcelamentoPb[] }>>> {
  const qs = new URLSearchParams({
    value: String(params.valorCentavos),
    payment_methods: 'CREDIT_CARD',
    max_installments: String(params.maxParcelas ?? 1),
    show_seller_fees: 'true',
  });

  const resposta = await requestPb<{ payment_methods: Record<string, any> }>(
    'GET /charges/fees/calculate',
    {
      method: 'GET',
      baseUrl: baseUrlOrders(),
      path: `/charges/fees/calculate?${qs.toString()}`,
      accessToken,
    },
  );

  return resposta.payment_methods ?? {};
}
