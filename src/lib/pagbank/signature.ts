import crypto from 'crypto';

/**
 * Validação da autenticidade dos webhooks do PagBank.
 *
 * Header recebido: x-authenticity-token: <hex sha256>
 * Hash:             SHA256(`${token}-${corpoBruto}`)
 *
 * Onde `token` é o token de acesso da CONTA que recebeu a notificação — no
 * nosso caso, o access_token OAuth da instituição dona do pedido (mesmo token
 * usado para criar o pedido). Fonte:
 * developer.pagbank.com.br/reference/confirmar-autenticidade-da-notificacao
 *
 * Diferente do Mercado Pago, o manifest do PagBank USA o corpo da requisição
 * — por isso o corpo precisa chegar aqui BYTE A BYTE como o PagBank enviou,
 * antes de qualquer parse/reserialização (um espaço a mais já muda o hash).
 * `server.ts` captura esse buffer bruto no `verify` do `express.json()`.
 *
 * ATENÇÃO: a documentação de autenticidade fala em "token obtido via
 * iBanking" (o modelo de conta única, anterior ao Connect). Para o modelo de
 * marketplace (Connect, várias instituições) o candidato mais razoável é o
 * access_token OAuth da instituição — mas isso não está testado contra um
 * webhook real, por falta de credencial no momento da implementação. Se a
 * assinatura vier sempre inválida assim que houver conta conectada de
 * verdade, comparar aqui contra PAGBANK_ACCESS_TOKEN (token da plataforma) em
 * vez do token da instituição.
 */

export interface ResultadoValidacaoPb {
  valido: boolean;
  motivo?: string;
  /** Qual candidato fechou o hash — responde a ambiguidade da documentação. */
  tokenUsado?: string;
  candidatosTestados?: string[];
}

function confere(token: string, rawBody: string, recebido: string): boolean {
  const esperado = crypto.createHash('sha256').update(`${token}-${rawBody}`).digest('hex');

  const a = Buffer.from(recebido.trim(), 'utf8');
  const b = Buffer.from(esperado, 'utf8');

  // timingSafeEqual exige buffers do mesmo tamanho — tamanhos diferentes já
  // são assinatura inválida, sem precisar (nem poder) comparar byte a byte.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function validateWebhookSignature(params: {
  xAuthenticityToken?: string;
  accountToken: string;
  rawBody: string;
}): ResultadoValidacaoPb {
  if (!params.xAuthenticityToken) {
    return { valido: false, motivo: 'header x-authenticity-token ausente' };
  }

  if (!params.accountToken) {
    return { valido: false, motivo: 'token da conta indisponível para validar' };
  }

  // A doc não diz QUAL token entra no hash no modelo Connect (multi-conta).
  // Em vez de assumir, testa os candidatos e registra qual fechou — assim o
  // log responde a pergunta na primeira notificação real.
  const candidatos: Array<[string, string]> = [
    ['token_da_instituicao', params.accountToken],
    ...(process.env.PAGBANK_ACCESS_TOKEN
      ? ([['token_da_plataforma', process.env.PAGBANK_ACCESS_TOKEN]] as Array<[string, string]>)
      : []),
  ];

  for (const [nome, token] of candidatos) {
    if (confere(token, params.rawBody, params.xAuthenticityToken)) {
      return { valido: true, tokenUsado: nome };
    }
  }

  return {
    valido: false,
    motivo: 'assinatura não confere',
    candidatosTestados: candidatos.map(([nome]) => nome),
  };
}
