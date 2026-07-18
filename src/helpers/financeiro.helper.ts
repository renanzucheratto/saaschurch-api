import { prisma } from '../lib/prisma/client.js';

const db = prisma as any;

export interface VinculosClassificacao {
  categoriaId?: string | null;
  fornecedorId?: string | null;
  projetoId?: string | null;
  areaId?: string | null;
}

// Garante que todo id referenciado pertence à instituição do usuário.
// Retorna mensagem de erro ou null quando tudo é válido.
export async function validarVinculos(
  instituicaoId: string,
  vinculos: VinculosClassificacao,
): Promise<string | null> {
  const checagens: Array<[string | null | undefined, string, string]> = [
    [vinculos.categoriaId, 'categoriaFinanceira', 'Categoria'],
    [vinculos.fornecedorId, 'fornecedor', 'Fornecedor'],
    [vinculos.projetoId, 'projeto', 'Projeto'],
    [vinculos.areaId, 'area', 'Área'],
  ];

  for (const [id, model, label] of checagens) {
    if (!id) continue;
    const registro = await db[model].findFirst({ where: { id, instituicaoId } });
    if (!registro) {
      return `${label} não encontrada(o) nesta instituição.`;
    }
  }

  return null;
}
