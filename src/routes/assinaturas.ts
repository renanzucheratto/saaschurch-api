import { Router, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../lib/prisma/client.js';
import {
  authenticateUser,
  requireBackoffice,
  AuthRequest,
} from '../middleware/auth.middleware.js';
import {
  obterChavePublicaRecorrencia,
  criarPlano,
  criarAssinatura,
  cancelarAssinatura,
} from '../lib/pagbank/assinaturas.js';
import { PagBankError } from '../lib/pagbank/client.js';
import { logPb, logPbErro } from '../lib/pagbank/log.js';

const router = Router();

/**
 * Mensalidade da INSTITUIÇÃO com a PLATAFORMA — API de Assinaturas do
 * PagBank, conta única da plataforma (sem OAuth por instituição, diferente
 * do split de eventos em routes/checkout.ts e routes/pagbank.ts).
 */

// GET /assinaturas/chave-publica - backoffice, para o formulário de cartão
// cifrar os dados com `PagSeguro.encryptCard()` antes de mandar pro backend.
router.get('/chave-publica', authenticateUser, requireBackoffice, async (_req: AuthRequest, res: Response) => {
  try {
    const chave = await obterChavePublicaRecorrencia();
    return res.status(200).json({ publicKey: chave.public_key });
  } catch (error) {
    console.error('Erro ao obter chave pública de assinaturas:', error);
    return res.status(502).json({ error: 'Não foi possível obter a chave pública do PagBank' });
  }
});

/** Garante que o Plano tem um PLAN_xxxx criado na API de Assinaturas do PagBank. */
async function garantirPlanoPagBank(plano: {
  id: string;
  codigo: string;
  nome: string;
  valorMensal: unknown;
  pagbankPlanoId: string | null;
}): Promise<string> {
  if (plano.pagbankPlanoId) return plano.pagbankPlanoId;

  const valorCentavos = Math.round(Number(plano.valorMensal) * 100);

  const criado = await criarPlano(
    {
      reference_id: plano.codigo,
      name: plano.nome.slice(0, 65),
      amount: { value: valorCentavos, currency: 'BRL' },
      interval: { unit: 'MONTH', length: 1 },
      payment_method: ['CREDIT_CARD'],
    },
    `plano-${plano.id}`,
  );

  await prisma.plano.update({
    where: { id: plano.id },
    data: { pagbankPlanoId: criado.id },
  });

  logPb('assinatura.plano', { planoId: criado.id, codigoInterno: plano.codigo });

  return criado.id;
}

// GET /assinaturas/status - situação da mensalidade da instituição do usuário logado
router.get('/status', authenticateUser, requireBackoffice, async (req: AuthRequest, res: Response) => {
  try {
    const assinatura = await prisma.assinatura.findFirst({
      where: { instituicaoId: req.user!.instituicaoId },
      orderBy: { createdAt: 'desc' },
      include: { plano: true },
    });

    if (!assinatura) {
      return res.status(200).json({ assinada: false });
    }

    return res.status(200).json({
      assinada: assinatura.status === 'ACTIVE',
      status: assinatura.status,
      plano: { codigo: assinatura.plano.codigo, nome: assinatura.plano.nome },
      valor: Number(assinatura.valor),
      cardBrand: assinatura.cardBrand,
      cardUltimosDigitos: assinatura.cardUltimosDigitos,
      proximaCobranca: assinatura.proximaCobranca,
      canceladaEm: assinatura.canceladaEm,
    });
  } catch (error) {
    console.error('Erro ao consultar status da assinatura:', error);
    return res.status(500).json({ error: 'Erro ao consultar assinatura' });
  }
});

// POST /assinaturas - assina (ou troca de cartão, cancelando a anterior e
// criando outra — a API de Assinaturas não expõe troca de cartão in-place
// de forma documentada) o plano já atribuído à instituição.
router.post('/', authenticateUser, requireBackoffice, async (req: AuthRequest, res: Response) => {
  try {
    const { cartaoCifrado, securityCode } = req.body as {
      cartaoCifrado?: string;
      securityCode?: string;
    };

    if (!cartaoCifrado || !securityCode) {
      return res.status(400).json({ error: 'Dados do cartão ausentes' });
    }

    const instituicao = await prisma.instituicao.findUnique({
      where: { id: req.user!.instituicaoId },
      include: { plano: true },
    });

    if (!instituicao?.plano) {
      return res.status(400).json({ error: 'Instituição sem plano atribuído' });
    }

    if (!instituicao.email) {
      return res.status(400).json({ error: 'Instituição sem e-mail cadastrado' });
    }

    // cnpj é opcional no schema, mas a API de Assinaturas exige tax_id do
    // assinante. Sem esta checagem mandaríamos string vazia e o PagBank
    // recusaria com erro genérico de validação, longe da causa real.
    const cnpjLimpo = (instituicao.cnpj || '').replace(/\D/g, '');

    if (cnpjLimpo.length !== 14) {
      return res.status(400).json({
        error: 'Instituição precisa ter CNPJ cadastrado para assinar a mensalidade',
      });
    }

    const planoPagBankId = await garantirPlanoPagBank(instituicao.plano);

    const anterior = await prisma.assinatura.findFirst({
      where: { instituicaoId: instituicao.id, status: { in: ['PENDING', 'ACTIVE', 'SUSPENDED'] } },
    });

    if (anterior) {
      try {
        await cancelarAssinatura(anterior.pagbankAssinaturaId);
      } catch (error) {
        logPbErro('assinatura.erro', {
          instituicaoId: instituicao.id,
          etapa: 'cancelar_anterior',
          mensagem: String((error as Error)?.message ?? error),
        });
      }

      await prisma.assinatura.update({
        where: { id: anterior.id },
        data: { status: 'CANCELLED', canceladaEm: new Date(), motivoCancelamento: 'Substituída por novo cartão' },
      });
    }

    const referenceId = crypto.randomUUID();

    const criada = await criarAssinatura(
      { encrypted: cartaoCifrado, securityCode },
      {
        referenceId,
        planoId: planoPagBankId,
        instituicaoNome: instituicao.nome,
        email: instituicao.email,
        taxId: cnpjLimpo,
      },
      referenceId,
    );

    const cartaoResp = criada.payment_method?.[0]?.card;

    const assinatura = await prisma.assinatura.create({
      data: {
        instituicaoId: instituicao.id,
        planoId: instituicao.plano.id,
        pagbankAssinaturaId: criada.id,
        pagbankAssinanteId: criada.customer?.id ?? null,
        cardBrand: cartaoResp?.brand ?? null,
        cardUltimosDigitos: cartaoResp?.last_digits ?? null,
        valor: instituicao.plano.valorMensal,
        status: criada.status === 'ACTIVE' ? 'ACTIVE' : 'PENDING',
        proximaCobranca: criada.next_invoice_at ? new Date(criada.next_invoice_at) : null,
      },
    });

    return res.status(201).json({
      assinaturaId: assinatura.id,
      status: assinatura.status,
      cardBrand: assinatura.cardBrand,
      cardUltimosDigitos: assinatura.cardUltimosDigitos,
    });
  } catch (error) {
    const detalhe = error instanceof PagBankError ? error.message : undefined;
    console.error('Erro ao criar assinatura PagBank:', error);
    return res.status(502).json({ error: detalhe || 'Não foi possível processar o cartão' });
  }
});

// DELETE /assinaturas - cancela a mensalidade corrente
router.delete('/', authenticateUser, requireBackoffice, async (req: AuthRequest, res: Response) => {
  try {
    const assinatura = await prisma.assinatura.findFirst({
      where: { instituicaoId: req.user!.instituicaoId, status: { in: ['PENDING', 'ACTIVE', 'SUSPENDED'] } },
    });

    if (!assinatura) {
      return res.status(404).json({ error: 'Nenhuma assinatura ativa' });
    }

    await cancelarAssinatura(assinatura.pagbankAssinaturaId);

    await prisma.assinatura.update({
      where: { id: assinatura.id },
      data: {
        status: 'CANCELLED',
        canceladaEm: new Date(),
        motivoCancelamento: `Cancelada por ${req.user!.email}`,
      },
    });

    return res.status(200).json({ message: 'Assinatura cancelada' });
  } catch (error) {
    console.error('Erro ao cancelar assinatura PagBank:', error);
    return res.status(500).json({ error: 'Erro ao cancelar assinatura' });
  }
});

export default router;
