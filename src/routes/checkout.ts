import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../lib/prisma/client.js';
import { verifyRecaptcha } from '../middleware/recaptcha.js';
import { PagBankError } from '../lib/pagbank/client.js';
import {
  criarPedidoComCartao,
  criarPedidoComPix,
  obterChavePublicaOrders,
  type SplitPedido,
} from '../lib/pagbank/orders.js';
import {
  getAccessTokenInstituicao,
  ContaPagBankIndisponivel,
} from '../lib/pagbank/token.js';
import { impressaoToken, logPb, logPbErro, mascarar } from '../lib/pagbank/log.js';
import { resolveRegraSplit, calcularSplit } from '../helpers/split.helper.js';
import { registrarBaixaPagamento } from '../helpers/baixa-pagamento.helper.js';
import { sincronizarPagamento } from '../helpers/sincronizar-pagamento.helper.js';
import {
  resolverDadosParticipante,
  cpfValido,
  emailValido,
} from '../helpers/dados-participante.helper.js';
import type { PagBankPagamentoStatus } from '@prisma/client';

const router = Router();

/** Validade do PIX e do pedido pendente antes de permitir gerar outro. */
const VALIDADE_PEDIDO_MS = 60 * 60 * 1000; // 1h

type MetodoPagamento = 'PIX' | 'CREDIT_CARD';

/** Mapeia o status inicial do charge devolvido pelo PagBank para o nosso enum. */
const MAPA_STATUS: Record<string, PagBankPagamentoStatus> = {
  WAITING: 'WAITING',
  IN_ANALYSIS: 'IN_ANALYSIS',
  AUTHORIZED: 'AUTHORIZED',
  PAID: 'PAID',
  DECLINED: 'DECLINED',
  CANCELED: 'CANCELED',
  REFUNDED: 'REFUNDED',
};

function envObrigatoria(nome: string): string {
  const valor = process.env[nome];
  if (!valor) throw new Error(`${nome} não configurada`);
  return valor;
}

/**
 * GET /checkout/chave-publica - rota PÚBLICA.
 *
 * Chave pública da INSTITUIÇÃO dona do produto, para o formulário de cartão
 * cifrar os dados com `PagSeguro.encryptCard()` antes de chamar POST /pedidos.
 */
router.get('/chave-publica', async (req: Request, res: Response) => {
  try {
    const produtoId = String(req.query.produtoId || '');

    if (!produtoId) {
      return res.status(400).json({ error: 'produtoId é obrigatório' });
    }

    const produto = await prisma.produtosEvento.findUnique({
      where: { id: produtoId },
      include: { evento: true },
    });

    const instituicaoId = produto?.instituicaoId || produto?.evento?.instituicaoId;

    if (!instituicaoId) {
      return res.status(404).json({ error: 'Produto não encontrado' });
    }

    const accessToken = await getAccessTokenInstituicao(instituicaoId);
    const chave = await obterChavePublicaOrders(accessToken);

    return res.status(200).json({ publicKey: chave.public_key });
  } catch (error) {
    if (error instanceof ContaPagBankIndisponivel) {
      return res.status(409).json({ error: error.message, motivo: error.motivo });
    }
    console.error('Erro ao obter chave pública do checkout:', error);
    return res.status(502).json({ error: 'Não foi possível obter a chave pública do PagBank' });
  }
});

/**
 * Mínimo por parcela aceito pelo PagBank. Abaixo disso o pedido é recusado com
 * "THE INSTALLMENT AMOUNT IS LESS THAN THE MINIMUM AMOUNT ALLOWED" — verificado
 * contra a sandbox: R$ 10,00 passa em 2x (R$ 5,00) e falha em 4x (R$ 2,50).
 */
const MINIMO_POR_PARCELA = 5;
const MAX_PARCELAS = 12;

export function maxParcelas(valor: number): number {
  return Math.max(1, Math.min(MAX_PARCELAS, Math.floor(valor / MINIMO_POR_PARCELA)));
}

/**
 * GET /checkout/resumo - rota PÚBLICA.
 *
 * O que está sendo cobrado e em quantas vezes cabe. Sem isto a tela pediria
 * cartão sem nunca dizer o valor, e ofereceria parcelamentos que o PagBank
 * recusa por valor mínimo de parcela.
 */
router.get('/resumo', async (req: Request, res: Response) => {
  try {
    const participanteId = String(req.query.participanteId || '');
    const produtoId = String(req.query.produtoId || '');

    if (!participanteId || !produtoId) {
      return res.status(400).json({ error: 'participanteId e produtoId são obrigatórios' });
    }

    const pp = await prisma.participanteProdutos.findUnique({
      where: { participanteId_produtoId: { participanteId, produtoId } },
      include: { produto: { select: { nome: true, valor: true, exigePagamento: true } } },
    });

    if (!pp) {
      return res.status(404).json({ error: 'Inscrição não encontrada' });
    }

    const valor = Number(pp.produto.valor);

    return res.status(200).json({
      produtoNome: pp.produto.nome,
      valor,
      exigePagamento: pp.produto.exigePagamento,
      maxParcelas: maxParcelas(valor),
    });
  } catch (error) {
    console.error('Erro ao obter resumo do checkout:', error);
    return res.status(500).json({ error: 'Erro ao obter resumo' });
  }
});

/**
 * POST /checkout/pedidos - rota PÚBLICA
 *
 * O participante não é usuário do sistema, mesma premissa da inscrição
 * pública em eventos.ts. Por isso: reCAPTCHA obrigatório e valor sempre lido
 * do banco.
 *
 * Diferente do antigo fluxo Mercado Pago (preference + redirect), o PagBank
 * não aceita split no checkout hospedado — só em /orders. Por isso esta rota
 * cria o pedido diretamente (PIX/cartão) e devolve os dados para a
 * NOSSA tela de pagamento (/inscricao/pagamento) exibir, em vez de devolver
 * um link de redirect.
 */
router.post('/pedidos', async (req: Request, res: Response) => {
  try {
    const { participanteId, produtoId, recaptchaToken, metodoPagamento, cartao, contato } = req.body as {
      participanteId?: string;
      produtoId?: string;
      recaptchaToken?: string;
      metodoPagamento?: MetodoPagamento;
      cartao?: { encrypted?: string; securityCode?: string; parcelas?: number };
      contato?: { email?: string; cpf?: string };
    };

    if (!participanteId || !produtoId) {
      return res.status(400).json({ error: 'participanteId e produtoId são obrigatórios' });
    }

    if (!metodoPagamento || !['PIX', 'CREDIT_CARD'].includes(metodoPagamento)) {
      return res.status(400).json({ error: 'metodoPagamento inválido (PIX ou CREDIT_CARD)' });
    }

    if (metodoPagamento === 'CREDIT_CARD' && (!cartao?.encrypted || !cartao?.securityCode)) {
      return res.status(400).json({ error: 'Dados do cartão ausentes' });
    }

    if (!recaptchaToken) {
      return res.status(400).json({ error: 'Token reCAPTCHA é obrigatório' });
    }

    if (!(await verifyRecaptcha(recaptchaToken))) {
      return res.status(400).json({ error: 'Falha na verificação reCAPTCHA' });
    }

    const participanteProduto = await prisma.participanteProdutos.findUnique({
      where: { participanteId_produtoId: { participanteId, produtoId } },
      include: {
        produto: true,
        participante: {
          include: {
            evento: true,
            // Em evento com campos customizados o e-mail e o CPF vivem aqui,
            // não nas colunas do participante.
            respostasCustomizadas: { include: { campo: { select: { tipo: true } } } },
          },
        },
      },
    });

    if (!participanteProduto) {
      return res.status(404).json({ error: 'Inscrição não encontrada' });
    }

    const { produto, participante } = participanteProduto;

    if (!produto.exigePagamento) {
      return res.status(400).json({ error: 'Este produto não exige pagamento' });
    }

    const instituicaoId =
      participanteProduto.instituicaoId ||
      participante.instituicaoId ||
      participante.evento?.instituicaoId;

    if (!instituicaoId) {
      return res.status(400).json({ error: 'Inscrição sem instituição vinculada' });
    }

    // Idempotência: pago não se cobra de novo.
    const jaAprovado = await prisma.pagBankPagamento.findFirst({
      where: { participanteProdutoId: participanteProduto.id, status: 'PAID' },
    });

    if (jaAprovado) {
      return res.status(409).json({
        error: 'Esta inscrição já foi paga',
        pagamentoId: jaAprovado.id,
      });
    }

    // Pedido pendente do MESMO método ainda válido: devolve o mesmo em vez de
    // criar outro (evita QR duplicado a cada F5 da tela de pagamento).
    const pendente = await prisma.pagBankPagamento.findFirst({
      where: {
        participanteProdutoId: participanteProduto.id,
        status: { in: ['WAITING', 'IN_ANALYSIS', 'AUTHORIZED'] },
        metodoPagamento,
        expiraEm: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (pendente) {
      logPb('pedido.ok', { instituicaoId, reaproveitado: true, pagamentoId: pendente.id });
      return res.status(200).json(serializarPagamento(pendente));
    }

    const instituicao = await prisma.instituicao.findUnique({
      where: { id: instituicaoId },
      include: { plano: true },
    });

    if (!instituicao) {
      return res.status(404).json({ error: 'Instituição não encontrada' });
    }

    const contaPb = await prisma.pagBankAccount.findUnique({
      where: { instituicaoId },
      select: { pagbankAccountId: true, status: true, scope: true },
    });

    logPb('pedido.inicio', {
      instituicaoId,
      instituicao: instituicao.nome,
      participanteId,
      produtoId,
      participanteProdutoId: participanteProduto.id,
      metodoPagamento,
      pagbankAccountIdGravado: contaPb?.pagbankAccountId ?? null,
      contaStatus: contaPb?.status ?? null,
    });

    let accessToken: string;

    try {
      accessToken = await getAccessTokenInstituicao(instituicaoId);
    } catch (error) {
      if (error instanceof ContaPagBankIndisponivel) {
        logPbErro('pedido.erro', { instituicaoId, etapa: 'obter_token', motivo: error.motivo });
        return res.status(409).json({ error: error.message, motivo: error.motivo });
      }
      throw error;
    }

    // O valor vem SEMPRE do banco. Aceitar valor do corpo deixaria o
    // comprador escolher quanto pagar.
    const valorReais = Number(produto.valor);

    if (!Number.isFinite(valorReais) || valorReais <= 0) {
      return res.status(400).json({ error: 'Produto com valor inválido' });
    }

    const regra = resolveRegraSplit(instituicao, instituicao.plano);
    const splitValorReais = calcularSplit(valorReais, regra);

    logPb('pedido.split', {
      instituicaoId,
      valorProduto: valorReais,
      regra,
      splitValor: splitValorReais,
      liquidoInstituicao: Math.round((valorReais - splitValorReais) * 100) / 100,
    });

    if (splitValorReais >= valorReais) {
      logPbErro('pedido.alerta', {
        instituicaoId,
        alerta: 'split_maior_ou_igual_ao_valor',
        valorProduto: valorReais,
        splitValor: splitValorReais,
      });
    }

    // PagBank trabalha em CENTAVOS inteiros; o resto do sistema (produto,
    // split.helper) trabalha em reais fracionários — a conversão é só aqui,
    // na borda de saída para a API.
    const valorCentavos = Math.round(valorReais * 100);
    const splitValorCentavos = Math.round(splitValorReais * 100);
    const valorLiquidoCentavos = valorCentavos - splitValorCentavos;

    const split: SplitPedido = {
      method: 'FIXED',
      receivers: [
        { accountId: envObrigatoria('PAGBANK_PLATAFORMA_ACCOUNT_ID'), valor: splitValorCentavos },
        { accountId: contaPb!.pagbankAccountId, valor: valorLiquidoCentavos },
      ].filter((r) => r.valor > 0),
    };

    // O PagBank exige customer.email e customer.tax_id em todo pedido. Procura
    // nas colunas e, se vazias, nas respostas customizadas.
    let dados = resolverDadosParticipante(participante, participante.respostasCustomizadas);

    // Nem todo evento coleta e-mail/CPF (um evento pode ter só um campo de
    // nome). Quando falta, a tela de pagamento pede na hora e manda aqui.
    if (dados.faltando.length > 0 && (contato?.email || contato?.cpf)) {
      const emailNovo = (contato.email ?? '').trim();
      const cpfNovo = (contato.cpf ?? '').replace(/\D/g, '');

      const erros: string[] = [];
      if (dados.faltando.includes('email') && !emailValido(emailNovo)) erros.push('E-mail inválido.');
      if (dados.faltando.includes('cpf') && !cpfValido(cpfNovo)) erros.push('CPF inválido.');

      if (erros.length > 0) {
        return res.status(422).json({ error: erros.join(' '), faltando: dados.faltando });
      }

      // Só PREENCHE o que está vazio, nunca sobrescreve. A rota é pública:
      // sem esta trava, quem descobrisse o UUID de uma inscrição poderia
      // trocar o e-mail e o CPF de outra pessoa.
      await prisma.participantes.update({
        where: { id: participanteId },
        data: {
          ...(dados.faltando.includes('email') ? { email: emailNovo } : {}),
          ...(dados.faltando.includes('cpf') ? { cpf: cpfNovo } : {}),
        },
      });

      dados = resolverDadosParticipante(
        {
          nome: dados.nome,
          email: dados.faltando.includes('email') ? emailNovo : dados.email,
          cpf: dados.faltando.includes('cpf') ? cpfNovo : dados.cpf,
          telefone: dados.telefone,
        },
        [],
      );
    }

    if (dados.faltando.length > 0) {
      logPbErro('pedido.erro', {
        instituicaoId,
        participanteId,
        etapa: 'dados_do_participante',
        faltando: dados.faltando,
      });

      const rotulos = { email: 'e-mail', cpf: 'CPF' } as const;

      return res.status(422).json({
        error: `Para pagar online precisamos de ${dados.faltando.map((f) => rotulos[f]).join(' e ')}.`,
        faltando: dados.faltando,
      });
    }

    const externalReference = crypto.randomUUID();
    const expiraEm = new Date(Date.now() + VALIDADE_PEDIDO_MS);
    const apiUrl = process.env.API_URL || '';

    const basePedido = {
      referenceId: externalReference,
      itemNome: produto.nome,
      itemDescricao: produto.descricao || participante.evento?.nome || produto.nome,
      valor: valorCentavos,
      cliente: {
        name: dados.nome || 'Participante',
        email: dados.email!,
        taxId: dados.cpf!,
        telefone: dados.telefone ?? undefined,
      },
      split,
      notificationUrl: `${apiUrl}/webhooks/pagbank?ref=${externalReference}`,
    };

    logPb('pedido.payload', {
      instituicaoId,
      externalReference,
      metodoPagamento,
      token: impressaoToken(accessToken),
      valorItem: valorReais,
      splitValor: splitValorReais > 0 ? splitValorReais : null,
      notificationUrl: basePedido.notificationUrl,
      apiHttps: apiUrl.startsWith('https://'),
      payer: {
        email: mascarar(dados.email),
        temCpf: Boolean(dados.cpf),
        cpfDigitos: dados.cpf?.length ?? 0,
      },
    });

    // Registro local ANTES da chamada: se o PagBank cair no meio, sobra um
    // registro CANCELED em vez de nenhum rastro da tentativa.
    const pagamento = await prisma.pagBankPagamento.create({
      data: {
        instituicaoId,
        participanteId,
        participanteProdutoId: participanteProduto.id,
        eventoId: participante.eventoId,
        externalReference,
        valor: valorReais,
        splitValor: splitValorReais,
        splitPercentualAplicado: regra.percentual,
        metodoPagamento,
        expiraEm,
        status: 'WAITING',
      },
    });

    try {
      if (metodoPagamento === 'CREDIT_CARD') {
        const parcelas = Math.min(Math.max(Number(cartao?.parcelas) || 1, 1), 12);

        // Formato do blob, nunca o conteúdo: um `encrypted` que não é base64
        // ou que veio truncado é a causa mais comum de recusa no cartão, e
        // sem isto o erro do PagBank não diz de onde veio.
        const blob = cartao!.encrypted!;
        logPb('pedido.payload', {
          etapa: 'cartao_cifrado',
          tamanho: blob.length,
          base64Valido: /^[A-Za-z0-9+/]+=*$/.test(blob),
          prefixo: blob.slice(0, 12),
        });

        const pedido = await criarPedidoComCartao(accessToken, {
          ...basePedido,
          cartao: {
            encrypted: cartao!.encrypted!,
            securityCode: cartao!.securityCode!,
            parcelas,
          },
        });

        const charge = pedido.charges?.[0];
        const status = MAPA_STATUS[charge?.status ?? ''] ?? 'IN_ANALYSIS';

        const atualizado = await prisma.pagBankPagamento.update({
          where: { id: pagamento.id },
          data: {
            pagbankOrderId: pedido.id,
            pagbankChargeId: charge?.id ?? null,
            status,
            statusDetail: charge?.payment_response?.message ?? null,
            parcelasCartao: parcelas,
            aprovadoEm: status === 'PAID' ? new Date() : null,
          },
        });

        registrarResultado(instituicaoId, pagamento.id, pedido.id, contaPb, split);

        // Cartão aprova na hora: não dá para esperar o webhook para dar baixa,
        // senão a inscrição fica pendente na tela mesmo já paga.
        if (status === 'PAID') {
          await registrarBaixaPagamento(atualizado.id);
        }

        return res.status(201).json(serializarPagamento(atualizado));
      }

      const pedido = await criarPedidoComPix(accessToken, { ...basePedido, expiraEm });
      const charge = pedido.charges?.[0];

      const atualizado = await prisma.pagBankPagamento.update({
        where: { id: pagamento.id },
        data: {
          pagbankOrderId: pedido.id,
          pagbankChargeId: charge?.id ?? null,
          status: MAPA_STATUS[charge?.status ?? ''] ?? 'WAITING',
          qrCodeTexto: charge?.qr_code?.text ?? null,
          qrCodeImagemUrl:
            charge?.links?.find((l) => l.rel === 'QRCODE.BASE64')?.href ?? null,
        },
      });

      registrarResultado(instituicaoId, pagamento.id, pedido.id, contaPb, split);
      return res.status(201).json(serializarPagamento(atualizado));
    } catch (error: any) {
      logPbErro('pedido.erro', {
        instituicaoId,
        pagamentoId: pagamento.id,
        externalReference,
        etapa: 'criar_pedido',
        mensagem: String(error?.message ?? error),
        corpo: error instanceof PagBankError ? error.corpo : null,
      });

      await prisma.pagBankPagamento.update({
        where: { id: pagamento.id },
        data: { status: 'CANCELED', statusDetail: 'falha_ao_criar_pedido' },
      });

      throw error;
    }
  } catch (error: any) {
    console.error('Erro ao criar pedido de checkout:', error?.message ?? error);

    // Erro 4xx do PagBank é falha do dado enviado (cartão recusado, cifra
    // inválida, split incoerente) — devolver "erro ao criar cobrança" genérico
    // deixa o participante sem saber o que corrigir e nós sem diagnóstico.
    // 5xx e falha de rede continuam genéricos: aí o problema não é do usuário.
    if (error instanceof PagBankError && error.status && error.status >= 400 && error.status < 500) {
      const detalhes = Array.isArray((error.corpo as any)?.error_messages)
        ? ((error.corpo as any).error_messages as Array<Record<string, unknown>>).map((m) => ({
            codigo: m.error ?? m.code ?? null,
            campo: m.parameter_name ?? null,
          }))
        : [];

      return res.status(422).json({
        error: 'O PagBank recusou a cobrança.',
        detalhes,
      });
    }

    return res.status(500).json({ error: 'Erro ao criar cobrança' });
  }
});

function registrarResultado(
  instituicaoId: string,
  pagamentoId: string,
  pagbankOrderId: string,
  contaPb: { pagbankAccountId: string } | null,
  split: SplitPedido,
) {
  logPb('pedido.ok', {
    instituicaoId,
    pagamentoId,
    pagbankOrderId,
    receiverPlataforma: split.receivers.find((r) => r.accountId !== contaPb?.pagbankAccountId)
      ?.accountId,
    receiverInstituicao: contaPb?.pagbankAccountId ?? null,
  });
}

function serializarPagamento(p: {
  id: string;
  status: string;
  metodoPagamento: string | null;
  valor: unknown;
  qrCodeTexto: string | null;
  qrCodeImagemUrl: string | null;
  boletoUrl: string | null;
  expiraEm: Date | null;
}) {
  return {
    pagamentoId: p.id,
    status: p.status,
    metodoPagamento: p.metodoPagamento,
    valor: Number(p.valor),
    qrCodeTexto: p.qrCodeTexto,
    qrCodeImagemUrl: p.qrCodeImagemUrl,
    boletoUrl: p.boletoUrl,
    expiraEm: p.expiraEm,
  };
}

/**
 * GET /checkout/pedidos/:id - rota PÚBLICA de polling.
 *
 * Não há redirect do PagBank de volta para o front (diferente do Mercado
 * Pago): a tela de pagamento consulta este endpoint para saber quando o PIX
 * foi pago ou o cartão foi aprovado. O id é um UUID não sequencial — não
 * exige dono autenticado, mesma premissa pública do POST.
 */
router.get('/pedidos/:id', async (req: Request, res: Response) => {
  try {
    const pagamento = await prisma.pagBankPagamento.findUnique({
      where: { id: String(req.params.id) },
    });

    if (!pagamento) {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }

    // Confere a fonte antes de responder: o Pix pode ter sido pago sem que o
    // webhook chegasse. Sem isto a tela ficaria em "aguardando" para sempre.
    const atual = await sincronizarPagamento(pagamento);

    return res.status(200).json(serializarPagamento(atual));
  } catch (error) {
    console.error('Erro ao consultar pedido de checkout:', error);
    return res.status(500).json({ error: 'Erro ao consultar pedido' });
  }
});

export default router;
