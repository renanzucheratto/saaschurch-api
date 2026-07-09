import type { Response } from 'express';

/**
 * Erro de domínio com código estável. O frontend trata pelo `code`,
 * nunca pela mensagem — mudar um código quebra a UI.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detalhes: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'AppError';
  }
}

export function responderErro(res: Response, error: unknown, mensagemFallback: string): Response {
  if (error instanceof AppError) {
    return res.status(error.status).json({ error: error.code, ...error.detalhes });
  }

  console.error(mensagemFallback, error);
  return res.status(500).json({ error: mensagemFallback });
}
