/**
 * Cliente da API de Assinaturas do PagBank (api.assinaturas.pagseguro.com) —
 * produto SEPARADO do Orders/Connect: conta ÚNICA da plataforma (não há OAuth
 * por instituição aqui), usado só para cobrar a MENSALIDADE da instituição
 * com a própria plataforma. O split e o pagamento de inscrições de evento
 * ficam em `client.ts`/Orders.
 *
 * Autenticação: Bearer PAGBANK_ACCESS_TOKEN (o mesmo token de conta da
 * plataforma usado em `oauth.ts` para o Connect). Restrito a conta PJ —
 * developer.pagbank.com.br/docs/pagamento-recorrente.
 */

import { baseUrlAssinaturas, requestPb } from './client.js';
import { logPb } from './log.js';

function envObrigatoria(nome: string): string {
  const valor = process.env[nome];
  if (!valor) {
    throw new Error(`${nome} não configurada`);
  }
  return valor;
}

function tokenPlataforma(): string {
  return envObrigatoria('PAGBANK_ACCESS_TOKEN');
}

export interface PublicKeyResposta {
  public_key: string;
  created_at?: number;
}

/**
 * Chave pública usada pelo FRONTEND para cifrar o cartão (PagSeguro.encryptCard).
 *
 * PUT aqui é intencional: neste host o POST devolve 405, e no host de Orders
 * o mesmo caminho é POST (ver `orders.ts`). Verificado contra a sandbox em
 * 2026-08-29.
 */
export async function obterChavePublicaRecorrencia(): Promise<PublicKeyResposta> {
  return requestPb<PublicKeyResposta>('PUT /public-keys (assinaturas)', {
    method: 'PUT',
    baseUrl: baseUrlAssinaturas(),
    path: '/public-keys',
    accessToken: tokenPlataforma(),
  });
}

export interface CriarPlanoBody {
  reference_id: string;
  name: string;
  description?: string;
  amount: { value: number; currency: 'BRL' };
  interval: { unit: 'MONTH'; length: number };
  payment_method?: Array<'CREDIT_CARD' | 'BOLETO'>;
}

export interface PlanoPagBank {
  id: string;
  reference_id?: string;
  name: string;
  status?: string;
  amount: { value: number; currency: string };
}

export async function criarPlano(
  body: CriarPlanoBody,
  idempotencyKey: string,
): Promise<PlanoPagBank> {
  const resposta = await requestPb<PlanoPagBank>('POST /plans', {
    method: 'POST',
    baseUrl: baseUrlAssinaturas(),
    path: '/plans',
    accessToken: tokenPlataforma(),
    idempotencyKey,
    body,
  });

  logPb('assinatura.plano', { planoId: resposta.id, nome: resposta.name });

  return resposta;
}

export interface CartaoCifrado {
  /** Saída de `PagSeguro.encryptCard(...)` no frontend — nunca o PAN em claro. */
  encrypted: string;
  securityCode: string;
}

export interface CriarAssinaturaBody {
  reference_id: string;
  plan: { id: string };
  customer: {
    reference_id: string;
    name: string;
    email: string;
    tax_id: string;
    phones?: Array<{ country: string; area: string; number: string }>;
    billing_info: Array<{ type: 'CREDIT_CARD'; card: { encrypted: string } }>;
  };
  payment_method: Array<{
    type: 'CREDIT_CARD';
    card: { security_code: string };
  }>;
}

export interface AssinaturaPagBank {
  id: string;
  reference_id?: string;
  status: string;
  plan: { id: string; name?: string };
  customer: { id: string; name?: string; email?: string };
  payment_method: Array<{
    type: string;
    card?: { brand?: string; last_digits?: string };
  }>;
  next_invoice_at?: string;
}

export async function criarAssinatura(
  cartao: CartaoCifrado,
  dados: {
    referenceId: string;
    planoId: string;
    instituicaoNome: string;
    email: string;
    taxId: string;
  },
  idempotencyKey: string,
): Promise<AssinaturaPagBank> {
  const body: CriarAssinaturaBody = {
    reference_id: dados.referenceId,
    plan: { id: dados.planoId },
    customer: {
      reference_id: dados.referenceId,
      name: dados.instituicaoNome,
      email: dados.email,
      tax_id: dados.taxId.replace(/\D/g, ''),
      billing_info: [{ type: 'CREDIT_CARD', card: { encrypted: cartao.encrypted } }],
    },
    payment_method: [{ type: 'CREDIT_CARD', card: { security_code: cartao.securityCode } }],
  };

  const resposta = await requestPb<AssinaturaPagBank>('POST /subscriptions', {
    method: 'POST',
    baseUrl: baseUrlAssinaturas(),
    path: '/subscriptions',
    accessToken: tokenPlataforma(),
    idempotencyKey,
    body,
  });

  logPb('assinatura.criar', {
    assinaturaId: resposta.id,
    status: resposta.status,
    planoId: resposta.plan?.id,
  });

  return resposta;
}

export async function consultarAssinatura(id: string): Promise<AssinaturaPagBank> {
  return requestPb<AssinaturaPagBank>('GET /subscriptions/{id}', {
    method: 'GET',
    baseUrl: baseUrlAssinaturas(),
    path: `/subscriptions/${id}`,
    accessToken: tokenPlataforma(),
  });
}

export async function cancelarAssinatura(id: string): Promise<void> {
  await requestPb('PUT /subscriptions/{id}/cancel', {
    method: 'PUT',
    baseUrl: baseUrlAssinaturas(),
    path: `/subscriptions/${id}/cancel`,
    accessToken: tokenPlataforma(),
  });
}
