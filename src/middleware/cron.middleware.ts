import 'dotenv/config';
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Rotas de job são autenticadas por `CRON_SECRET`, nunca por sessão de usuário.
 * A Vercel injeta `Authorization: Bearer $CRON_SECRET` nas chamadas de cron.
 */
export function requireCronSecret(req: Request, res: Response, next: NextFunction) {
  const segredo = process.env.CRON_SECRET;

  if (!segredo) {
    console.error('CRON_SECRET não configurado — rota de job recusada');
    return res.status(401).json({ error: 'NAO_AUTORIZADO' });
  }

  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ') || !comparacaoSegura(header.slice(7), segredo)) {
    return res.status(401).json({ error: 'NAO_AUTORIZADO' });
  }

  return next();
}

function comparacaoSegura(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');

  if (bufferA.length !== bufferB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufferA, bufferB);
}
