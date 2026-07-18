import { Router, Request, Response } from 'express';
import { mockExtratoBradesco } from '../lib/bradesco/mock-extrato.js';

// Simula a API de extrato do Bradesco (sandbox). Sem autenticação de propósito:
// representa um serviço externo e será substituído pela API real via env.
const router = Router();

// ==================== GET /mock/bradesco/extrato ====================
// Ex.: /mock/bradesco/extrato?agencia=3750&conta=75557&dataInicio=06112024&dataFim=20112024&tipo=cc&tipoOperacao=1
router.get('/extrato', (req: Request, res: Response) => {
  const obrigatorios = ['agencia', 'conta', 'dataInicio', 'dataFim', 'tipo', 'tipoOperacao'];
  const faltando = obrigatorios.filter((p) => !req.query[p]);

  if (faltando.length > 0) {
    return res.status(400).json({
      error: `Parâmetros obrigatórios ausentes: ${faltando.join(', ')}`,
    });
  }

  return res.status(200).json(mockExtratoBradesco);
});

export default router;
