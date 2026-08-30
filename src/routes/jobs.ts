import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma/client.js';
import { decryptToken, encryptToken } from '../lib/pagbank/crypto.js';
import { refreshAccessToken } from '../lib/pagbank/oauth.js';

const router = Router();

/** Renova contas cujo access_token vence nas próximas 48h. */
const JANELA_RENOVACAO_MS = 48 * 60 * 60 * 1000;

function autorizado(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;

  return header.substring(7) === secret;
}

/**
 * POST /jobs/refresh-pagbank-tokens
 *
 * Sem este job, uma instituição que fica sem transacionar por um tempo teria
 * o primeiro checkout do período falhando com token vencido.
 */
router.post('/refresh-pagbank-tokens', async (req: Request, res: Response) => {
  if (!autorizado(req)) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  const limite = new Date(Date.now() + JANELA_RENOVACAO_MS);

  try {
    const contas = await prisma.pagBankAccount.findMany({
      where: { status: 'ACTIVE', expiresAt: { lt: limite } },
    });

    let renovadas = 0;
    let falhas = 0;

    for (const conta of contas) {
      try {
        const tokens = await refreshAccessToken(decryptToken(conta.refreshTokenEnc));

        await prisma.pagBankAccount.update({
          where: { id: conta.id },
          data: {
            accessTokenEnc: encryptToken(tokens.accessToken),
            refreshTokenEnc: encryptToken(tokens.refreshToken),
            expiresAt: tokens.expiresAt,
            ultimoRefreshEm: new Date(),
            ultimoErro: null,
          },
        });

        renovadas++;
      } catch (error: any) {
        falhas++;

        await prisma.pagBankAccount.update({
          where: { id: conta.id },
          data: {
            status: 'EXPIRED',
            ultimoErro: String(error?.message ?? error).slice(0, 500),
          },
        });

        console.error(
          `Falha ao renovar token da instituição ${conta.instituicaoId}:`,
          error?.message ?? error,
        );
      }
    }

    // Aproveita para limpar states OAuth vencidos.
    const nonces = await prisma.oAuthNonce.deleteMany({
      where: { expiraEm: { lt: new Date() } },
    });

    return res.status(200).json({
      avaliadas: contas.length,
      renovadas,
      falhas,
      noncesRemovidos: nonces.count,
    });
  } catch (error) {
    console.error('Erro no job de refresh de tokens:', error);
    return res.status(500).json({ error: 'Erro ao renovar tokens' });
  }
});

export default router;
