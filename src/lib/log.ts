/** Log estruturado: uma linha JSON por evento, para ser consultável nos logs da Vercel. */
export function logJson(nivel: 'info' | 'warn' | 'error', campos: Record<string, unknown>): void {
  const linha = JSON.stringify({ nivel, ts: new Date().toISOString(), ...campos });

  if (nivel === 'error') {
    console.error(linha);
  } else if (nivel === 'warn') {
    console.warn(linha);
  } else {
    console.log(linha);
  }
}

export function mensagemDeErro(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
