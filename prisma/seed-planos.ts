import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DIRECT_URL/DATABASE_URL não configurada');
}

const pool = new Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });

/**
 * Código do plano gratuito com acesso total.
 * Reaproveita a linha PILOTO_FREE que já existe no banco em vez de criar um
 * segundo plano de valor zero concorrendo com ela.
 */
const CODIGO_PLANO_PADRAO = process.env.PLANO_PADRAO_CODIGO || 'PILOTO_FREE';

async function main() {
  console.log('🌱 Seed de planos\n');

  const existente = await prisma.plano.findUnique({
    where: { codigo: CODIGO_PLANO_PADRAO },
  });

  // O percentual só é definido na criação. Num plano que já existe ele não é
  // sobrescrito: é um valor comercial possivelmente negociado, e o seed é
  // idempotente por design — rodar de novo não pode mudar quanto se cobra.
  const percentualInicial = Number(process.env.SPLIT_PERCENTUAL_PADRAO ?? 5);

  const plano = await prisma.plano.upsert({
    where: { codigo: CODIGO_PLANO_PADRAO },
    update: {
      nome: 'Gratuito',
      descricao: 'Acesso total. Sem mensalidade — a plataforma é remunerada pelo split das inscrições.',
      cobrancaSaaS: false,
      valorMensal: 0,
      ativo: true,
      features: { acessoTotal: true },
    },
    create: {
      codigo: CODIGO_PLANO_PADRAO,
      nome: 'Gratuito',
      descricao: 'Acesso total. Sem mensalidade — a plataforma é remunerada pelo split das inscrições.',
      cobrancaSaaS: false,
      valorMensal: 0,
      feeEventoPercentual: percentualInicial,
      feeEventoMinimo: 0,
      feeEventoMaximo: null,
      ativo: true,
      ordem: 0,
      features: { acessoTotal: true },
    },
  });

  console.log(
    existente
      ? `  ♻️  Plano ${plano.codigo} atualizado (split mantido em ${plano.feeEventoPercentual}%)`
      : `  ✅ Plano ${plano.codigo} criado com split de ${plano.feeEventoPercentual}%`,
  );

  // Backfill: instituições sem plano passam a apontar para o gratuito.
  const semPlano = await prisma.instituicao.updateMany({
    where: { planoId: null },
    data: { planoId: plano.id, planoAtribuidoEm: new Date() },
  });

  console.log(`  ✅ ${semPlano.count} instituição(ões) vinculada(s) ao plano padrão`);
  console.log('\n✅ Seed de planos concluído');
}

main()
  .catch((e) => {
    console.error('❌ Erro no seed de planos:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
