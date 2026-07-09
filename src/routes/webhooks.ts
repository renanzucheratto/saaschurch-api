import 'dotenv/config';
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { validarAssinatura } from '../lib/mercadopago/signature.js';
import { processarWebhook } from '../services/webhook.service.js';

const router = Router();

const limiteWebhook = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

function primeiroValor(valor: unknown): string | undefined {
  if (typeof valor === 'string') return valor;
  if (Array.isArray(valor) && typeof valor[0] === 'string') return valor[0];
  return undefined;
}

// ==================== POST /mercadopago ====================
// Sem `authenticateUser`: quem chama é o Mercado Pago. A confiança vem do HMAC.
router.post('/mercadopago', limiteWebhook, async (req: Request, res: Response) => {
  // `data.id` sai do query param, não do body. Ler do body é a pegadinha nº 1 da
  // validação de assinatura do MP — o manifesto não bateria.
  const dataId = primeiroValor(req.query['data.id']) ?? primeiroValor(req.query.id);
  const tipo = primeiroValor(req.query.type) ?? primeiroValor(req.query.topic);

  const validacao = validarAssinatura({
    dataId,
    xSignature: req.headers['x-signature'] as string | undefined,
    xRequestId: req.headers['x-request-id'] as string | undefined,
    segredo: process.env.MERCADO_PAGO_WEBHOOK_SECRET ?? '',
  });

  // Assinatura inválida não gera WebhookLog: um atacante não consegue poluir a tabela.
  if (!validacao.valido) {
    console.warn(JSON.stringify({ evento: 'webhook_assinatura_invalida', motivo: validacao.motivo }));
    return res.status(401).json({ error: 'ASSINATURA_INVALIDA' });
  }

  if (!dataId || !tipo) {
    return res.status(401).json({ error: 'ASSINATURA_INVALIDA' });
  }

  try {
    const resultado = await processarWebhook({
      mpEventId: dataId,
      tipo,
      action: (req.body as { action?: string } | undefined)?.action ?? null,
      payload: req.body,
    });

    return res.status(200).json({ resultado });
  } catch (error) {
    // 500 força o retry do MP (backoff por até 8h). Responder 200 aqui perderia o evento.
    console.error('Erro ao processar webhook do Mercado Pago:', error);
    return res.status(500).json({ error: 'ERRO_PROCESSAMENTO' });
  }
});

export default router;
