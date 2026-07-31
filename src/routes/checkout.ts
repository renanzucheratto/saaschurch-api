import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../lib/prisma/client.js';
import { verifyRecaptcha } from '../middleware/recaptcha.js';
import {
  chamarMp,
  clientePreference,
  type PreferenceRequestMp,
} from '../lib/mercadopago/client.js';
import {
  getAccessTokenInstituicao,
  ContaMercadoPagoIndisponivel,
} from '../lib/mercadopago/token.js';
import { resolveRegraSplit, calcularSplit } from '../helpers/split.helper.js';

const router = Router();

/** Validade da preference. Curta para não segurar vaga indefinidamente. */
const VALIDADE_PREFERENCE_MS = 60 * 60 * 1000; // 1h

function primeiroNomeESobrenome(nome?: string | null): { nome: string; sobrenome: string } {
  const limpo = (nome || '').trim();
  if (!limpo) return { nome: '', sobrenome: '' };
  const partes = limpo.split(/\s+/);
  return {
    nome: partes[0] || '',
    sobrenome: partes.slice(1).join(' '),
  };
}

/**
 * POST /checkout/preferences - rota PÚBLICA
 *
 * O participante não é usuário do sistema, mesma premissa da inscrição pública
 * em eventos.ts. Por isso: reCAPTCHA obrigatório e valor sempre lido do banco.
 *
 * Só LÊ ParticipanteProdutos/ProdutosEvento. Não escreve em Parcela nem em
 * nenhuma tabela do fluxo financeiro existente.
 */
router.post('/preferences', async (req: Request, res: Response) => {
  try {
    const { participanteId, produtoId, recaptchaToken } = req.body;

    if (!participanteId || !produtoId) {
      return res.status(400).json({ error: 'participanteId e produtoId são obrigatórios' });
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
        participante: { include: { evento: true } },
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
    const jaAprovado = await prisma.mpPagamento.findFirst({
      where: { participanteProdutoId: participanteProduto.id, status: 'APPROVED' },
    });

    if (jaAprovado) {
      return res.status(409).json({
        error: 'Esta inscrição já foi paga',
        pagamentoId: jaAprovado.id,
      });
    }

    // Preference pendente ainda válida: devolve a mesma em vez de criar outra.
    const pendente = await prisma.mpPagamento.findFirst({
      where: {
        participanteProdutoId: participanteProduto.id,
        status: { in: ['PENDING', 'IN_PROCESS'] },
        initPoint: { not: null },
        expiraEm: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (pendente) {
      return res.status(200).json({
        init_point: pendente.initPoint,
        mpPagamentoId: pendente.id,
        reaproveitada: true,
      });
    }

    const instituicao = await prisma.instituicao.findUnique({
      where: { id: instituicaoId },
      include: { plano: true },
    });

    if (!instituicao) {
      return res.status(404).json({ error: 'Instituição não encontrada' });
    }

    let accessToken: string;

    try {
      accessToken = await getAccessTokenInstituicao(instituicaoId);
    } catch (error) {
      if (error instanceof ContaMercadoPagoIndisponivel) {
        return res.status(409).json({ error: error.message, motivo: error.motivo });
      }
      throw error;
    }

    // O valor vem SEMPRE do banco. Aceitar valor do corpo deixaria o comprador
    // escolher quanto pagar.
    const valor = Number(produto.valor);

    if (!Number.isFinite(valor) || valor <= 0) {
      return res.status(400).json({ error: 'Produto com valor inválido' });
    }

    const regra = resolveRegraSplit(instituicao, instituicao.plano);
    const splitValor = calcularSplit(valor, regra);

    const externalReference = crypto.randomUUID();
    const expiraEm = new Date(Date.now() + VALIDADE_PREFERENCE_MS);

    const pagamento = await prisma.mpPagamento.create({
      data: {
        instituicaoId,
        participanteId,
        participanteProdutoId: participanteProduto.id,
        eventoId: participante.eventoId,
        externalReference,
        valor,
        splitValor,
        splitPercentualAplicado: regra.percentual,
        expiraEm,
        status: 'PENDING',
      },
    });

    const { nome: primeiroNome, sobrenome } = primeiroNomeESobrenome(participante.nome);
    const cpfLimpo = (participante.cpf || '').replace(/\D/g, '');

    const frontendUrl = process.env.FRONTEND_URL || '';
    const apiUrl = process.env.API_URL || '';

    // Tipado pelo SDK: campo inválido quebra na compilação, não no 400 do MP.
    const preferencePayload: PreferenceRequestMp = {
      items: [
        {
          id: produto.id,
          title: produto.nome,
          description: produto.descricao || participante.evento?.nome || produto.nome,
          category_id: 'services',
          quantity: 1,
          currency_id: 'BRL',
          unit_price: valor,
        },
      ],
      payer: {
        name: primeiroNome,
        surname: sobrenome,
        email: participante.email || undefined,
        phone: participante.telefone
          ? { number: participante.telefone.replace(/\D/g, '') }
          : undefined,
        identification: cpfLimpo ? { type: 'CPF', number: cpfLimpo } : undefined,
      },
      external_reference: externalReference,
      // O ref na query é o que permite ao webhook descobrir a instituição: a
      // notificação do MP só carrega data.id (o payment), e sem saber a
      // instituição não há token para consultar esse payment.
      notification_url: `${apiUrl}/webhooks/mercadopago?ref=${externalReference}`,
      back_urls: {
        success: `${frontendUrl}/inscricao/pagamento?status=sucesso`,
        pending: `${frontendUrl}/inscricao/pagamento?status=pendente`,
        failure: `${frontendUrl}/inscricao/pagamento?status=falha`,
      },
      // auto_return exige back_url.success público e https; em localhost o MP
      // rejeita a preference inteira com "back_url.success must be defined".
      ...(frontendUrl.startsWith('https://') ? { auto_return: 'approved' } : {}),
      // Aparece na fatura do cartão do participante. Reduz contestação por
      // "não reconheço a compra".
      statement_descriptor: (instituicao.nome || 'INSCRICAO').slice(0, 22),
      binary_mode: true,
      expires: true,
      expiration_date_to: expiraEm.toISOString(),
    };

    // marketplace_fee zero é omitido: mandar 0 explícito é ruído para o MP.
    if (splitValor > 0) {
      preferencePayload.marketplace_fee = splitValor;
    }

    let preference;

    try {
      // externalReference como chave de idempotência: reenvio da mesma tentativa
      // não gera uma segunda preference no Mercado Pago.
      preference = await chamarMp('POST /checkout/preferences', () =>
        clientePreference(accessToken, { idempotencyKey: externalReference }).create({
          body: preferencePayload,
        }),
      );
    } catch (error) {
      // A preference falhou: o registro local não pode ficar como pendente
      // válido, senão bloqueia a próxima tentativa pelo caminho de reuso.
      await prisma.mpPagamento.update({
        where: { id: pagamento.id },
        data: { status: 'CANCELLED', statusDetail: 'falha_ao_criar_preference' },
      });
      throw error;
    }

    if (!preference.init_point) {
      await prisma.mpPagamento.update({
        where: { id: pagamento.id },
        data: { status: 'CANCELLED', statusDetail: 'preference_sem_init_point' },
      });
      return res.status(502).json({ error: 'Mercado Pago não devolveu link de pagamento' });
    }

    const atualizado = await prisma.mpPagamento.update({
      where: { id: pagamento.id },
      data: {
        mpPreferenceId: preference.id ?? null,
        initPoint: preference.init_point,
      },
    });

    return res.status(201).json({
      init_point: atualizado.initPoint,
      mpPagamentoId: atualizado.id,
      valor,
      splitValor,
    });
  } catch (error: any) {
    console.error('Erro ao criar preference de checkout:', error?.message ?? error);
    return res.status(500).json({ error: 'Erro ao criar cobrança' });
  }
});

export default router;
