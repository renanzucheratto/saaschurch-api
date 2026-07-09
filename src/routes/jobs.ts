import { Router, type Request, type Response, type RequestHandler } from 'express';
import { requireCronSecret } from '../middleware/cron.middleware.js';
import { logJson, mensagemDeErro } from '../lib/log.js';
import { refreshTokens } from '../jobs/refresh-tokens.js';
import { reconciliarPagamentos } from '../jobs/reconciliar-pagamentos.js';
import { verificarAssinaturas } from '../jobs/verificar-assinaturas.js';

const router = Router();

/**
 * Vercel Cron dispara `GET` com `Authorization: Bearer $CRON_SECRET`; agendadores
 * externos costumam usar `POST`. Aceitar os dois evita um cron que nunca roda.
 */
function registrarJob(caminho: string, executar: () => Promise<unknown>) {
  const handler: RequestHandler = async (_req: Request, res: Response) => {
    const inicio = Date.now();

    try {
      const resultado = await executar();

      logJson('info', { job: caminho, concluido: true, duracaoMs: Date.now() - inicio });
      return res.status(200).json(resultado);
    } catch (error) {
      logJson('error', {
        job: caminho,
        erro: mensagemDeErro(error),
        duracaoMs: Date.now() - inicio,
      });
      return res.status(500).json({ error: 'ERRO_JOB' });
    }
  };

  router.get(`/${caminho}`, requireCronSecret, handler);
  router.post(`/${caminho}`, requireCronSecret, handler);
}

registrarJob('refresh-tokens', refreshTokens);
registrarJob('reconciliar-pagamentos', reconciliarPagamentos);
registrarJob('verificar-assinaturas', verificarAssinaturas);

export default router;
