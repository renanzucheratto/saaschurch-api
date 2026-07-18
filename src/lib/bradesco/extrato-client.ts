import { mockExtratoBradesco, ExtratoBradesco } from './mock-extrato.js';

export interface ConsultaExtratoParams {
  agencia: string;
  conta: string;
  dataInicio: string; // ddMMyyyy
  dataFim: string; // ddMMyyyy
}

// Quando BRADESCO_EXTRATO_URL estiver configurada, consulta a API real
// (ou o mock via HTTP). Sem a env, retorna o mock in-process — evita
// self-HTTP no serverless da Vercel. A troca pela API real do Bradesco
// (OAuth/mTLS) fica isolada neste arquivo.
export async function obterExtrato(params: ConsultaExtratoParams): Promise<ExtratoBradesco> {
  const baseUrl = process.env.BRADESCO_EXTRATO_URL;

  if (!baseUrl) {
    return mockExtratoBradesco;
  }

  const query = new URLSearchParams({
    agencia: params.agencia,
    conta: params.conta,
    dataInicio: params.dataInicio,
    dataFim: params.dataFim,
    tipo: 'cc',
    tipoOperacao: '1',
  });

  const response = await fetch(`${baseUrl}?${query.toString()}`);

  if (!response.ok) {
    throw new Error(`Erro ao consultar extrato Bradesco: HTTP ${response.status}`);
  }

  return (await response.json()) as ExtratoBradesco;
}
