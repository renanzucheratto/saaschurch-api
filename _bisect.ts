import 'dotenv/config';
import crypto from 'crypto';
import { prisma } from './src/lib/prisma/client.js';
import {
  chamarMp,
  clienteMetodoPagamento,
  clientePagamento,
} from './src/lib/mercadopago/client.js';
import { getAccessTokenInstituicao } from './src/lib/mercadopago/token.js';

/**
 * Script de diagnóstico do split: cria pagamentos de teste com cartões
 * sandbox e imprime o que a conta da instituição realmente aceitou.
 *
 * Roda com: pnpm tsx _bisect.ts
 */

const INSTITUICAO_ID = '5144d578-48a6-452b-92c9-1b15d7101a36';

const conta = await prisma.mercadoPagoAccount.findUnique({
  where: { instituicaoId: INSTITUICAO_ID },
  select: { publicKey: true },
});

const publicKey = conta!.publicKey!;
const token = await getAccessTokenInstituicao(INSTITUICAO_ID);

// Quais métodos de cartão a conta aceita
const metodos = await chamarMp('GET /v1/payment_methods', () =>
  clienteMetodoPagamento(token).get(),
);

console.log(
  'METODOS_CARTAO',
  metodos
    .filter((m: any) => m.payment_type_id === 'credit_card')
    .map((m: any) => `${m.id} (${m.status})`)
    .join(', '),
);

const CARTOES = [
  { label: 'master', numero: '5031433215406351', cvv: '123', pm: 'master' },
  { label: 'visa', numero: '4235647728025682', cvv: '123', pm: 'visa' },
  { label: 'amex', numero: '375365153556885', cvv: '1234', pm: 'amex' },
];

for (const c of CARTOES) {
  // As duas chamadas abaixo autenticam por public_key na query, não por Bearer,
  // e por isso ficam fora do SDK (o MercadoPagoConfig só monta Authorization).
  const bin = c.numero.slice(0, 6);
  const respBin = await fetch(
    `https://api.mercadopago.com/v1/payment_methods/search?public_key=${publicKey}&bins=${bin}`,
  );
  const corpoBin: any = await respBin.json();
  const pmResolvido = corpoBin?.results?.[0]?.id;
  console.log(`\n[${c.label}] bin ${bin} -> payment_method_id: ${pmResolvido ?? 'NAO ENCONTRADO'}`);

  const respToken = await fetch(
    `https://api.mercadopago.com/v1/card_tokens?public_key=${publicKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        card_number: c.numero,
        security_code: c.cvv,
        expiration_month: 11,
        expiration_year: 2030,
        cardholder: {
          name: 'APRO',
          identification: { type: 'CPF', number: '12345678909' },
        },
      }),
    },
  );

  const corpoToken: any = await respToken.json();

  if (!respToken.ok) {
    console.log(`[${c.label}] ERRO card_token`, JSON.stringify(corpoToken));
    continue;
  }

  const externalReference = crypto.randomUUID();

  try {
    const pagamento: any = await chamarMp('POST /v1/payments', () =>
      clientePagamento(token, { idempotencyKey: crypto.randomUUID() }).create({
        body: {
          transaction_amount: 5.5,
          token: corpoToken.id,
          description: 'Teste split via API',
          installments: 1,
          payment_method_id: pmResolvido ?? c.pm,
          application_fee: 0.19,
          external_reference: externalReference,
          payer: {
            email: 'test_user_bisect@testuser.com',
            identification: { type: 'CPF', number: '12345678909' },
          },
        },
      }),
    );

    console.log(`[${c.label}] PAGAMENTO`, {
      id: pagamento.id,
      status: pagamento.status,
      status_detail: pagamento.status_detail,
      application_fee: pagamento.application_fee,
      net_received: pagamento.transaction_details?.net_received_amount,
    });
  } catch (e: any) {
    console.log(`[${c.label}] ERRO pagamento: ${e?.message}`);
  }
}

await prisma.$disconnect();
process.exit(0);
